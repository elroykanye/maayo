# Maayo

> *Maayo* (Fulfulde: "river") — offline-first data sync between a local device store and any backend.

Maayo is for applications that need to work without a network connection. Local writes are stored immediately in IndexedDB and synced to the server whenever connectivity is available. The server side is two HTTP endpoints — implement them on any backend with any database.

**This is not a general-purpose data layer.** Maayo is specifically for the offline-first pull-sync pattern:

- Client writes go to a local outbox first, then push to the server
- Client reads come from local IndexedDB, kept fresh by pulling server deltas
- The server stores mutations; it never pushes to clients

## Packages

| Package | Description |
|---------|-------------|
| [`@maayo/protocol`](./packages/protocol.md) | TypeScript types — zero deps |
| [`@maayo/client`](./packages/client.md) | Core client: outbox, push/pull engine, ULID |
| [`@maayo/angular`](./packages/angular.md) | Angular adapter: signals, DI wiring |
| [`@maayo/react`](./packages/react.md) | React adapter: SyncProvider, hooks |
| [`@maayo/spring`](./packages/spring.md) | Spring Boot server adapter |

## Guides

- [Getting Started](./getting-started.md)
- [Core Concepts](./concepts.md)
- [Protocol Specification](./protocol.md)
- [Architecture & Roadmap](./architecture.md)

## Flow

```
Browser                                  Server (any DB)
───────────────────────────────────      ─────────────────────
write → _outbox (IndexedDB)
              ──── POST /sync/mutations ──→  store mutation
              ←─── GET  /sync/changes   ────  deltas since cursor
apply to local tables ←
update cursor ←
```

Push and pull are independent loops. A device can be offline for days, queue hundreds of writes, and sync cleanly when it reconnects.
