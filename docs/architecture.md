# Maayo — Architecture

> *Maayo* (Fulfulde: "river") — offline-first data sync that flows naturally
> from local storage to any backend, through channels defined by your auth.

---

## Problem

Every offline-first sync library locks you to a specific backend:
- ElectricSQL / PowerSync → requires Postgres + their CDC pipeline
- Replicache / Zero → requires their server runtime
- Dexie Cloud → requires their hosted service

There is no library that says: **implement these two endpoints on any backend
and get offline-first sync for free.**

---

## Solution

Maayo is a **protocol-first, backend-agnostic** offline sync library.

The protocol is minimal — two HTTP endpoints:
```
POST /sync/mutations    — push queued local writes
GET  /sync/changes      — pull server deltas for a channel
```

Any backend that implements these two endpoints becomes a Maayo server.
The client handles everything else: local storage (IndexedDB via Dexie),
outbox queuing, conflict resolution (LWW), and framework signal bindings.

---

## Core Concepts

### 1. Outbox
Every local write is appended to a `_outbox` table before being applied.
The outbox is drained on connectivity, flushed periodically, and idempotent
(each mutation carries a ULID so retries are safe).

### 2. Channels
A channel is a string that identifies a stream of data (e.g. `org:abc/school:xyz`).
The client derives its channels from the user's auth grants — if your RBAC
says "user can see school X", that becomes the channel they pull from.
Channels are hierarchical: pulling `org:abc` also includes `org:abc/*` data.

### 3. Push / Pull cycle
```
push:  _outbox rows → POST /sync/mutations → server acks → delete from outbox
pull:  GET /sync/changes?channel=...&since=<time>&lastMutationId=<id> → apply → update cursor
```
Push and pull are independent loops. A failed push blocks nothing; a failed
pull retries on the next cycle.

### 4. Last-Write-Wins (LWW)
Conflict resolution is LWW by `updatedAt`. Remote mutations with an older
`updatedAt` than the local row are discarded. This covers the overwhelming
majority of school/management data access patterns.

### 5. Cursors
Each channel tracks a compound `(lastReceivedAt, lastMutationId)` cursor in `_cursors`. Pull
resumes strictly after the pair, so equal timestamps cannot disappear between pages. First pull
omits both values and is a full catch-up.

---

## Protocol Spec

### Mutation (client → server)
```typescript
interface Mutation {
  id: string;            // ULID — idempotent, 26 chars
  channel: string;       // target channel (e.g. "org:abc/school:xyz")
  entityType: string;    // PascalCase table name (e.g. "Student")
  entityId: string;      // UUID of the record
  op: 'CREATE' | 'UPDATE' | 'DELETE' | 'PATCH';
  payload: string;       // JSON-serialized entity
  authorIdentityId: string;
  deviceId: string;      // stable per-browser UUID
  clientTs: string;      // ISO-8601 client timestamp
  parentIds: string[];   // causal dependencies (future: ordering)
}
```

### POST /sync/mutations
```
Request:  { mutations: Mutation[] }
Response: {
  accepted: { id: string; receivedAt: string }[];
  rejected: { id: string; reason: string }[];
}
```

### GET /sync/changes
```
Query:    channel, since? + lastMutationId? (paired continuation), limit? (default 500)
Response: {
  channel: string;
  mutations: Mutation[];
  cursor: { lastMutationId: string | null; lastReceivedAt: string | null };
}
```

---

## Package Structure

```
maayo/
├── packages/
│   ├── protocol/          @maayo/protocol
│   │   └── src/
│   │       ├── mutation.ts       — Mutation, BatchRequest, BatchResponse types
│   │       ├── changes.ts        — ChangesResponse, Cursor types
│   │       ├── errors.ts         — typed duplicate-persistence conflict
│   │       └── index.ts
│   │
│   ├── client/            @maayo/client
│   │   └── src/
│   │       ├── database.ts       — Dexie schema (_outbox, _cursors + user tables)
│   │       ├── ids.ts            — ulid(), deviceId()
│   │       ├── outbox.ts         — enqueue(), drain()
│   │       ├── pull.ts           — pull loop per channel
│   │       ├── engine.ts         — SyncEngine (push + pull orchestration)
│   │       └── index.ts
│   │
│   ├── angular/           @maayo/angular
│   │   └── src/
│   │       ├── provide-sync.ts   — provideSync(config)
│   │       ├── sync-collection.ts — syncCollection<T>(table) → Signal<T[]>
│   │       ├── use-channel.ts    — channel derivation hook
│   │       └── index.ts
│   │
│   ├── react/             @maayo/react
│   │   └── src/
│   │       ├── SyncProvider.tsx  — context + engine boot
│   │       ├── use-collection.ts — useCollection<T>(table) → T[]
│   │       ├── use-sync-status.ts
│   │       └── index.ts
│   │
│   ├── spring/            dev.maayo:maayo-spring
│   │   └── src/main/
│   │       ├── MutationController.kt  — POST /sync/mutations
│   │       ├── ChangesController.kt   — GET /sync/changes
│   │       ├── MaayoAutoConfiguration.kt
│   │       └── MaayoProperties.kt
│   │
│   ├── nest/              @maayo/nest
│   └── express/           @maayo/express
│
├── docs/
│   ├── architecture.md    (this file)
│   ├── protocol.md
│   ├── concepts.md
│   ├── getting-started.md
│   └── packages/
│
├── pnpm-workspace.yaml
└── package.json
```

---

## Target Developer Experience

### Client setup (Angular)
```typescript
// app.config.ts
export const appConfig: ApplicationConfig = {
  providers: [
    provideSync({
      baseUrl: 'https://api.example.com',
      channels: (auth) => channelsFromGrants(auth.grants),
    }),
  ],
};
```

```typescript
// any component
readonly students = syncCollection<Student>('student');
// → Signal<Student[]>, offline-capable, auto-synced
```

### Server setup (Spring Boot)
```kotlin
// build.gradle.kts
implementation("dev.maayo:maayo-spring:0.3.1")
```
Two controllers wired automatically. Done.

---

## Monorepo Stack

| Concern | Choice | Why |
|---------|--------|-----|
| Monorepo | pnpm workspaces + Nx | Standard |
| Client language | TypeScript | Universal |
| Client storage | Dexie 4 | IndexedDB, excellent TypeScript support |
| Spring adapter | Kotlin + Spring Boot 3 | JVM ecosystem |
| Docs | Markdown in `docs/` | Zero build, lives in the repo |
| CI | GitHub Actions | Standard |
| Registry | npm (`@maayo/`) + GitHub Packages (Spring) | Public scoped packages |

---

## Key Design Decisions

**Why not WebSockets?**
HTTP polling is simpler, works through all proxies and firewalls, and is
sufficient for the 10-second sync interval this pattern targets. WebSocket
push can be added as an optional optimisation later without changing the protocol.

**Why LWW and not CRDTs?**
The target domain (school management data) has low write concurrency and
well-defined ownership per record. LWW by `updatedAt` handles 99% of cases.
CRDT support is planned for v0.5 via a `conflictResolver` option.

**Why two endpoints and not one?**
Push and pull have different semantics, auth patterns, and failure modes.
Keeping them separate makes each trivially implementable and independently
testable on any backend.

**Why Dexie and not a different storage layer?**
Dexie has the best TypeScript support, the cleanest API, and handles
IndexedDB's quirks reliably. The storage layer is pluggable in the design —
`@maayo/client` accepts a `Store` interface, Dexie is the default adapter.

---

## Milestones

### M1 — Protocol + Core Client ✅
- [x] `@maayo/protocol` — types only, zero deps
- [x] `@maayo/client` — Dexie schema, outbox, push/pull engine, ULID, deviceId
- [x] Unit tests for push/pull/LWW logic
- [x] README with protocol spec

### M2 — Angular Adapter ✅
- [x] `@maayo/angular` — `provideSync()`, `syncCollection()` signal primitive
- [x] Integration test: offline → queue → online → sync

### M3 — Spring Adapter ✅
- [x] `@maayo/spring` — autoconfigured MutationController + ChangesController
- [x] `ChannelAuthorizer` interface for RBAC-based channel gating
- [x] Integration test: client ↔ server full cycle

### M4 — React + OSS Launch ✅
- [x] `@maayo/react` — `SyncProvider`, `useCollection`, `useSyncStatus` hooks
- [x] npm publish: `@maayo/protocol`, `@maayo/client`, `@maayo/angular`, `@maayo/react`
- [x] GitHub Packages publish: `dev.maayo:maayo-spring`
- [x] Docs: protocol spec, concepts, getting-started, per-package READMEs
- [x] MIT License

---

## Roadmap

### v0.2 — Quick Wins
- [ ] **Time-travel / audit log** — expose `engine.history(table, id)` returning every state a record has been in; mutation log is already persisted, this is an API surface question
- [ ] **Multi-tab deduplication** — `SharedWorker` / `BroadcastChannel` so only one tab runs the sync loop; others subscribe to updates via postMessage
- [ ] **Schema migrations** — declarative `migrations: [{ version: 2, up: (db) => ... }]` in `SyncConfig`; Maayo runs them on IndexedDB before starting sync when the app version bumps
- [ ] **NestJS + Express adapters** — `@maayo/nest`, `@maayo/express` — implement the two server endpoints for the Node.js ecosystem

### v0.3 — Background Sync
- [ ] **Service Worker integration** — intercept fetch and queue mutations; mutations survive tab close
- [ ] **Background Sync API** — use `navigator.serviceWorker` + `SyncManager` so queued mutations fire even when the browser is not open
- [ ] Depends on multi-tab dedup from v0.2 (Service Worker is effectively a third tab)

### v0.4 — End-to-End Encryption
- [ ] **Zero-knowledge client-side encryption** via Web Crypto API (`AES-GCM`)
- [ ] Opt-in per-table or globally: `encryption: { key: CryptoKey }` in `SyncConfig`
- [ ] Server stores and syncs ciphertext only — never sees plaintext
- [ ] Key management helpers: passphrase-derived (PBKDF2), injected, or server-assisted key exchange
- [ ] Spring adapter: treat encrypted payload as opaque blob, no schema change needed
- [ ] Enables HIPAA / FERPA / GDPR-sensitive deployments

### v0.5 — CRDT Conflict Resolution
- [ ] **Per-field merge strategies** to replace or augment LWW
- [ ] Built-in CRDT types:
  - `lww` (current default) — last write wins by `updatedAt`
  - `counter` — G-counter, merges by taking max
  - `set` — OR-Set, union on concurrent adds
  - `text` — RGA CRDT, concurrent text edits merge without data loss (Google Docs-style)
- [ ] `conflictResolver` option in `SyncConfig` per table
- [ ] Vector clock infrastructure in `Mutation.parentIds` (field already reserved)
- [ ] Fully backward-compatible — LWW remains default

### v1.0 — P2P Local Sync
- [ ] **WebRTC data channels** — devices on the same LAN sync directly without hitting the server
- [ ] Signaling via one new optional endpoint: `POST /sync/signal` (or out-of-band)
- [ ] Spring adapter ships signaling handler out of the box
- [ ] Discovery: mDNS on native, manual peer code in browser
- [ ] Merge uses the same push/pull + LWW or CRDT logic — P2P is just another transport
- [ ] Key use case: schools / clinics with unreliable internet — a teacher's tablet becomes the local hub; student tablets sync to it directly
- [ ] Fully optional — existing deployments need zero changes to adopt

---

## Version History

| Version | Date | Notes |
|---------|------|-------|
| 0.1.2 | 2026-05-31 | M4 complete — all packages published to npm + GitHub Packages, full docs, MIT license |
| 0.1.1 | 2026-05-31 | CI fixes (Spring 6.2 handler detection, pnpm allowBuilds, vitest path aliases) |
| 0.1.0 | 2026-05 | Initial release — protocol, client, angular, react, spring |
