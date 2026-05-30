# Core Concepts

## Outbox

Every local write is appended to a `_outbox` table in IndexedDB _before_ any server interaction. This guarantees writes survive page reloads and network drops.

```
user action → enqueue(db, opts)   ← adds row to _outbox
                                     ↓
                               SyncEngine.sync()
                                     ↓
                        POST /sync/mutations (batched)
                                     ↓
                        server acks → markSynced() → purgeSynced()
```

Each outbox row is a full `Mutation` with a [ULID](#ulid) id. If the same mutation is pushed twice, the server recognises the ULID and acknowledges without re-saving — retries are safe.

## Channels

A channel is a string that identifies a stream of data. Channels are hierarchical using `/` as a separator:

```
org:abc                         — all data for organisation abc
org:abc/school:xyz              — data scoped to school xyz within org abc
org:abc/school:xyz/class:y1a    — further narrowed to class Y1A
```

**Hierarchy rule**: pulling from a parent channel returns mutations from all sub-channels. Pulling `org:abc` includes everything under `org:abc/*`.

Channels are typically derived from the user's auth grants:

```typescript
// grants: [{ orgId: 'abc', schoolId: 'xyz' }]
channelsFromGrants(grants, (g) => ({ org: g.orgId, school: g.schoolId }))
// → ['org:abc/school:xyz']
```

## Last-Write-Wins (LWW)

Conflict resolution is LWW by `updatedAt`. When pulling remote mutations:

1. Parse the incoming payload.
2. Compare `payload.updatedAt` with the local row's `updatedAt`.
3. If local is newer or equal → skip (local wins).
4. If remote is newer → `table.put(incoming)` (remote wins).

This covers the overwhelming majority of school/management data — records have clear ownership and low write concurrency.

## Cursors

Each channel has a cursor stored in `_cursors`:

```typescript
interface CursorRow {
  channel: string;
  lastMutationId: string | null;
  lastReceivedAt: string | null;
}
```

The `lastReceivedAt` timestamp is sent as `?since=` on each pull request. The server returns only mutations received after that point. First-time pulls (no cursor) do a full catch-up.

## Pagination (`hasMore`)

The server fetches `limit + 1` rows. If `rows.size > limit`, it sets `hasMore: true` and drops the extra row. The client re-pulls immediately while `hasMore` is true, walking pages in a tight loop within a single sync cycle.

## ULID

Mutation IDs are [ULIDs](https://github.com/ulid/spec): 26-character Crockford base-32 strings.

```
01ARZ3NDEKTSV4RRFFQ69G5FAV
└──────────┘└──────────────┘
  10 chars      16 chars
  timestamp     randomness
  (48-bit ms)   (80-bit)
```

Properties:
- **Lexicographically sortable** — later mutations sort after earlier ones.
- **Monotonic** — same-millisecond calls increment the random component so the sequence is strictly ascending.
- **URL-safe** — no special characters.
- **Idempotency key** — the server deduplicates by ULID, making retries safe.

## Push / Pull independence

Push and pull are separate loops inside `SyncEngine`. A network failure during push does not delay the next pull; unsynced outbox rows are retried on the next `sync()` call. This means clients always read the latest server state even when their writes are temporarily queued.
