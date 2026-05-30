# @maayo/angular

Angular adapter for Maayo. Provides Angular DI integration, signal-based reactive collections, and channel helpers.

## Install

```bash
pnpm add @maayo/angular @maayo/client dexie
```

**Peer dependencies**: `@angular/core >=17`, `rxjs >=7`

---

## `provideSync(config)`

Call in `app.config.ts` (or any environment injector) to wire up the `SyncEngine` and start the push–pull loop via `APP_INITIALIZER`.

```typescript
import { provideSync, channelsFromGrants } from '@maayo/angular';

provideSync({
  baseUrl: 'https://api.example.com',
  dbName: 'myapp',
  tables: { student: 'id, schoolId, name' },
  authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),

  // Static list:
  channels: ['org:abc/school:xyz'],

  // Or factory — receives the Angular injector:
  channels: (injector) => {
    const auth = injector.get(AuthStore);
    return channelsFromGrants(auth.grants(), (g) => ({ org: g.orgId, school: g.schoolId }));
  },
})
```

`SyncProviderConfig` extends `SyncConfig` from `@maayo/client`, replacing `channels: string[]` with `string[] | ((injector: Injector) => string[])`.

---

## `syncCollection<T>(tableName)`

Returns a `Signal<T[]>` backed by a `liveQuery` on the named IndexedDB table. Updates automatically when the local table changes (on push, pull, or direct writes).

Must be called in an injection context (component field initialiser, constructor, or `runInInjectionContext`).

```typescript
@Component({ /* ... */ })
export class ClassListComponent {
  readonly classes = syncCollection<SchoolClass>('class');
  // → Signal<SchoolClass[]>
}
```

```html
@for (c of classes(); track c.id) {
  <div>{{ c.name }}</div>
}
```

---

## `injectSyncStatus()`

Returns a readonly `Signal<SyncStatus>` reflecting the current engine state. Automatically unsubscribes on component destroy.

```typescript
type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

readonly status = injectSyncStatus();
```

```html
@if (status() === 'offline') {
  <span>You are offline — changes will sync when reconnected.</span>
}
```

---

## `channelFor(scope)`

Builds a channel string from a flat scope object.

```typescript
channelFor({ org: 'abc123', school: 'xyz456' })
// → 'org:abc123/school:xyz456'
```

---

## `channelsFromGrants<G>(grants, toScope)`

Derives a deduplicated channel list from an array of grant objects.

```typescript
channelsFromGrants(
  [{ orgId: 'abc', schoolId: 'xyz' }, { orgId: 'abc', schoolId: 'pqr' }],
  (g) => ({ org: g.orgId, school: g.schoolId }),
)
// → ['org:abc/school:xyz', 'org:abc/school:pqr']
```

---

## `SYNC_ENGINE`

The `InjectionToken<SyncEngine>` used by all Angular primitives. Inject it to access the engine or database directly:

```typescript
import { inject } from '@angular/core';
import { SYNC_ENGINE } from '@maayo/angular';
import { enqueue } from '@maayo/client';

const engine = inject(SYNC_ENGINE);

// Write to outbox
await enqueue(engine.db, { channel: '...', entityType: 'Student', /* ... */ });

// Force an immediate sync cycle
await engine.sync();
```
