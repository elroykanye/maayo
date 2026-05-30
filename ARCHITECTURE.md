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
pull:  GET /sync/changes?channel=...&since=<cursor> → apply to local tables → update cursor
```
Push and pull are independent loops. A failed push blocks nothing; a failed
pull retries on the next cycle.

### 4. Last-Write-Wins (LWW)
Conflict resolution is LWW by `updatedAt`. Remote mutations with an older
`updatedAt` than the local row are discarded. This covers the overwhelming
majority of school/management data access patterns.

### 5. Cursors
Each channel tracks a `lastReceivedAt` cursor in `_cursors`. Pull resumes
from the cursor, so incremental syncs are cheap. First pull is a full catch-up.

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
Query:    channel, since? (ISO-8601), limit? (default 500)
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
│   ├── react/             @maayo/react   (later milestone)
│   │   └── src/
│   │       ├── use-sync.ts       — useSync(config)
│   │       ├── use-collection.ts — useCollection<T>(table) → T[]
│   │       └── index.ts
│   │
│   ├── spring/            @maayo/spring
│   │   └── src/main/
│   │       ├── MutationController.kt  — POST /sync/mutations
│   │       ├── ChangesController.kt   — GET /sync/changes
│   │       ├── MaayoAutoConfiguration.kt
│   │       └── MaayoProperties.kt
│   │
│   ├── nest/              @maayo/nest    (later milestone)
│   │   └── src/
│   │       ├── mutations.controller.ts
│   │       ├── changes.controller.ts
│   │       └── maayo.module.ts
│   │
│   └── express/           @maayo/express  (later milestone)
│       └── src/
│           ├── mutations.ts
│           ├── changes.ts
│           └── router.ts
│
├── apps/
│   └── docs/              maayo.dev — documentation site
│
├── ARCHITECTURE.md        (this file)
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
    provideHttpClient(),
    provideStore(),          // your Dexie store
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
implementation("dev.maayo:maayo-spring:1.0.0")
```
```yaml
# application.yml
maayo:
  enabled: true
  channel-authorizer: grantBased   # or custom bean
```
Two controllers wired automatically. Done.

---

## Monorepo Stack

| Concern | Choice | Why |
|---------|--------|-----|
| Monorepo | pnpm workspaces + Nx | Same stack as Transkript-fe |
| Client language | TypeScript | Universal |
| Client storage | Dexie 4 | IndexedDB, excellent TypeScript support |
| Spring adapter | Kotlin + Spring Boot 3 | Matches Transkript-be |
| NestJS adapter | TypeScript | Matches NestJS ecosystem |
| Docs | Astro or VitePress | Fast static site |
| CI | GitHub Actions | Standard |
| Registry | npm (`@maayo/`) | Public scoped packages |

---

## Milestones

### M1 — Protocol + Core Client
- [ ] `@maayo/protocol` — types only, zero deps
- [ ] `@maayo/client` — Dexie schema, outbox, push/pull engine, ULID, deviceId
- [ ] Unit tests for push/pull/LWW logic
- [ ] README with protocol spec

### M2 — Angular Adapter
- [ ] `@maayo/angular` — `provideSync()`, `syncCollection()` signal primitive
- [ ] Demo Angular app (todo-style, works offline)
- [ ] Integration test: offline → queue → online → sync

### M3 — Spring Adapter
- [ ] `@maayo/spring` — autoconfigured MutationController + ChangesController
- [ ] `ChannelAuthorizer` interface for RBAC-based channel gating
- [ ] Demo Spring Boot app
- [ ] Integration test: client ↔ server full cycle

### M4 — Polish + OSS Launch
- [ ] `maayo.dev` docs site
- [ ] NestJS + Express adapters
- [ ] React adapter
- [ ] npm publish all packages
- [ ] GitHub org: `maayojs`

---

## Key Design Decisions

**Why not WebSockets?**
HTTP polling is simpler, works through all proxies and firewalls, and is
sufficient for the 10-second sync interval this pattern targets. WebSocket
push can be added as an optional optimisation later without changing the protocol.

**Why LWW and not CRDTs?**
The target domain (school management data) has low write concurrency and
well-defined ownership per record. LWW by `updatedAt` handles 99% of cases.
CRDT support can be layered in M5+ via a `conflictResolver` option.

**Why two endpoints and not one?**
Push and pull have different semantics, auth patterns, and failure modes.
Keeping them separate makes each trivially implementable and independently
testable on any backend.

**Why Dexie and not a different storage layer?**
Dexie has the best TypeScript support, the cleanest API, and handles
IndexedDB's quirks reliably. The storage layer is pluggable in the design —
`@maayo/client` accepts a `Store` interface, Dexie is the default adapter.
