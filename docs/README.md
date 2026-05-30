# Maayo Docs

> *Maayo* (Fulfulde: "river") — offline-first data sync that flows naturally from local storage to any backend.

Maayo is a **protocol-first, backend-agnostic** offline sync library. You implement two HTTP endpoints on your server; Maayo handles everything else: local storage, outbox queuing, conflict resolution, and framework bindings.

## Packages

| Package | Description |
|---------|-------------|
| [`@maayo/protocol`](./packages/protocol.md) | TypeScript types for the sync protocol — zero deps |
| [`@maayo/client`](./packages/client.md) | Core client: Dexie outbox, push/pull engine, ULID |
| [`@maayo/angular`](./packages/angular.md) | Angular adapter: `provideSync()`, `syncCollection()`, signals |
| [`@maayo/spring`](./packages/spring.md) | Spring Boot autoconfiguration for the server side |

## Guides

- [Getting Started](./getting-started.md) — up and running in 5 minutes
- [Core Concepts](./concepts.md) — outbox, channels, LWW, cursors
- [Protocol Specification](./protocol.md) — the two endpoints you need to implement

## How it works

```
Client (browser)                       Server
─────────────────                      ────────────────────────
local write → _outbox
                    ─── POST /sync/mutations ──→  persist + ack
                    ←── GET  /sync/changes   ───  deltas since cursor
apply to local DB ←
update cursor ←
```

The client runs a push–pull loop every 10 seconds (configurable). Push drains the outbox; pull fetches server deltas. Both are independent — a failed push never blocks a pull.
