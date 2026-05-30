# @maayo/client

Framework-agnostic offline-first sync engine for the Maayo protocol.

Writes go into a local IndexedDB outbox and are pushed to your server when connectivity is available. Server-side changes are pulled and merged locally using last-write-wins (LWW) conflict resolution.

Works in any browser environment: React, Angular, Vue, Svelte, vanilla JS, Next.js, Nuxt, and more.

## Install

```bash
npm install @maayo/client dexie
```

## Quick start

```ts
import { SyncEngine } from '@maayo/client';

const engine = new SyncEngine({
  baseUrl: 'https://api.example.com',
  dbName: 'myapp',
  channels: ['org:abc/school:xyz'],
  tables: {
    students: 'id, name, classId',
    classes: 'id, name',
  },
  authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
  intervalMs: 10_000,
});

engine.start();

// Queue a write (goes to IndexedDB outbox, synced on next cycle)
await engine.db.table('_outbox').add({
  id: ulid(),
  channel: 'org:abc/school:xyz',
  entityType: 'Student',
  entityId: 'stu-001',
  op: 'CREATE',
  payload: JSON.stringify({ id: 'stu-001', name: 'Ada Lovelace' }),
  authorIdentityId: userId,
  deviceId: deviceId,
  clientTs: new Date().toISOString(),
  parentIds: [],
  syncedAt: null,
});
```

## API

### `SyncEngine`

| Member | Description |
|--------|-------------|
| `new SyncEngine(config)` | Create engine (opens IndexedDB) |
| `engine.start()` | Begin periodic sync loop |
| `engine.stop()` | Stop sync loop |
| `engine.sync()` | Run one push+pull cycle manually |
| `engine.status` | `'idle' \| 'syncing' \| 'error' \| 'offline'` |
| `engine.onStatusChange(fn)` | Subscribe to status changes, returns unsubscribe fn |
| `engine.db` | The underlying Dexie database instance |

### `channelFor(scope)` / `channelsFromGrants(grants, toScope)`

Helpers for building hierarchical channel strings:

```ts
import { channelFor, channelsFromGrants } from '@maayo/client';

channelFor({ org: 'abc', school: 'xyz' }); // → 'org:abc/school:xyz'
```

## Framework adapters

| Framework | Package |
|-----------|---------|
| React / Next.js | [@maayo/react](https://www.npmjs.com/package/@maayo/react) |
| Angular | [@maayo/angular](https://www.npmjs.com/package/@maayo/angular) |
| Vue / Nuxt | Use `@maayo/client` directly (Vue adapter coming soon) |

## Server

Any backend can implement the two sync endpoints. Official adapter: [@maayo/spring](https://github.com/elroykanye/maayo/packages/spring) for Spring Boot. Any language works — see the [protocol spec](https://github.com/elroykanye/maayo/blob/main/docs/protocol.md).
