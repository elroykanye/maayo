# Working sets and snapshot packs

Maayo now owns the large-replica bootstrap path. Applications provide authorization, a tenant resolver, and a consistent domain snapshot; Maayo owns chunking, content addresses, cache identity, integrity, delivery, and atomic activation.

## Client working sets

`SyncEngine` keeps legacy `channels` behavior and adds dynamic working sets:

```ts
const engine = new SyncEngine({ baseUrl, dbName, channels: [], tables, checkpoint });
engine.subscribe({
  id: 'visible-school', tenantId, channel: 'org:1/school:7',
  projectionKey, projectionRevision, schemaVersion: '3',
});
engine.prefetch(nextSchool);
engine.activate(nextSchool.id);
engine.pause('visible-school');
engine.unsubscribe('visible-school');       // retain local materialization
await engine.evict('visible-school');       // remove only exclusively owned rows
```

Overlapping working sets may share identical rows. Eviction uses persisted ownership references, so a row remains until its final working set releases it. Conflicting representations of the same entity are rejected rather than leaking one projection into another.

## Snapshot packs

Use `SnapshotPackService` with a `SnapshotPackSource` and `SnapshotPackStore`, or implement the narrow `SnapshotPackProvider` interface. `MemorySnapshotPackStore` is intended for one-process deployments; production stores can place immutable chunks in an object store/CDN while keeping manifests in a short-lived cache.

The cache key includes tenant, channel, projection key/revision, schema version, and compound log cursor. Chunks are canonical JSON addressed by SHA-256. A manifest expires and may carry an opaque signed delivery token. Adapters authorize before resolving tenant/projection identity, and the provider validates the token again for every chunk.

Clients call `installSnapshotPackFromHttp()` for the standard HTTP path or `installSnapshotPack()` for a custom transport. Missing chunks are fetched concurrently through a pluggable resumable cache, every digest is verified, and only then is the complete generation installed in the existing IndexedDB transaction. `_outbox` is never part of that transaction; failure leaves the prior replica and cursor intact.

## Server setup

- Express: configure `snapshotPackProvider`, `snapshotPackTenant`, and `snapshotPackProjectionKey` on `maayoRouter()`.
- Nest: provide the same three options to `MaayoModule`.
- Spring: provide `CheckpointProvider` and `SnapshotTenantResolver`, then set a secret of at least 32 characters in `maayo.snapshot-signing-key`. Optional settings are `maayo.snapshot-chunk-rows` and `maayo.snapshot-ttl`.

Endpoints are `GET /sync/snapshot-packs/manifest?channel=...` and `GET /sync/snapshot-packs/chunks/{digest}?channel=...&token=...`.

## Migration

1. Upgrade protocol to `0.3.3`, client to `0.3.5`, Express/Nest to `0.3.3`, or Spring to `0.3.3`.
2. Keep existing `/sync/checkpoint` configuration during rollout; replay-only and checkpoint clients remain supported.
3. Add the snapshot source/store and tenant/projection resolvers server-side.
4. Move screens from static `channels` to dynamic working-set calls one route or viewport at a time.
5. Enable pack bootstrap with `installSnapshotPackFromHttp`; remove application-owned checkpoint wrappers after all supported clients understand packs.

`metaTable` users no longer duplicate LWW winners in cursor records. Installations without `metaTable` retain the legacy cursor winner representation.

## Failure and security rules

- Never share manifests across tenant or projection cache keys.
- Delivery tokens must be short-lived and validated with tenant, channel, projection, generation, and expiry.
- Treat chunk JSON as untrusted until the complete manifest verifies.
- Preserve the previous generation on missing, expired, corrupt, aborted, or unauthorized transfers.
- Keep outbound mutations in `_outbox`; generation activation and eviction do not include that table.

Run `pnpm benchmark:snapshot-packs`. Set `MAAYO_SNAPSHOT_SIZES=2500,25000,250000,1000000` and `MAAYO_SNAPSHOT_SAMPLES=5` for the release evidence matrix. The report includes every sample, p50/p95/p99, payload size, runtime/storage/network descriptors, and correctness/integrity/outbox checks.
