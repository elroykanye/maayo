# @maayo/react

React adapter for Maayo. Provides a context provider, data hooks, and channel utilities.

## Install

```bash
npm install @maayo/react @maayo/client dexie
# or
pnpm add @maayo/react @maayo/client dexie
```

**Peer dependencies**: `react >=18`, `dexie >=4`

---

## `SyncProvider`

Wrap your app (or a subtree) with `SyncProvider`. It creates and starts the `SyncEngine` on mount and stops it on unmount.

```tsx
import { SyncProvider, channelsFromGrants } from '@maayo/react';

function App() {
  return (
    <SyncProvider
      config={{
        baseUrl: 'https://api.example.com',
        dbName: 'myapp',
        tables: { student: 'id, schoolId, name' },
        authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
        channels: channelsFromGrants(user.grants, (g) => ({
          org: g.orgId,
          school: g.schoolId,
        })),
      }}
    >
      <Router />
    </SyncProvider>
  );
}
```

---

## `useCollection<T>(tableName)`

Returns a `T[]` that updates automatically as the local IndexedDB table changes. The array is empty on first render and populates after the first liveQuery emission.

```tsx
function StudentList() {
  const students = useCollection<Student>('student');

  return (
    <ul>
      {students.map((s) => (
        <li key={s.id}>{s.name}</li>
      ))}
    </ul>
  );
}
```

---

## `useSyncStatus()`

Returns the current `SyncStatus` of the engine. Re-renders the component whenever the status changes.

```typescript
type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';
```

```tsx
function SyncIndicator() {
  const status = useSyncStatus();
  if (status === 'offline') return <span>Offline — changes will sync when reconnected</span>;
  if (status === 'syncing') return <span>Syncing…</span>;
  if (status === 'error') return <span>Sync error — will retry</span>;
  return null;
}
```

---

## `useSyncEngine()`

Returns the raw `SyncEngine` instance. Use this for direct database access or to trigger a manual sync cycle.

```typescript
const engine = useSyncEngine();

// Enqueue a local write
await enqueue(engine.db, {
  channel: 'org:abc/school:xyz',
  entityType: 'Student',
  entityId: crypto.randomUUID(),
  op: 'CREATE',
  payload: { id: '...', name: 'Ada', updatedAt: new Date().toISOString() },
  authorIdentityId: currentUserId,
});

// Force an immediate sync
await engine.sync();
```

---

## `channelFor` / `channelsFromGrants`

Re-exported from `@maayo/client`. See [`@maayo/client` docs](./client.md) for details.

```typescript
channelFor({ org: 'abc', school: 'xyz' })
// → 'org:abc/school:xyz'

channelsFromGrants(grants, (g) => ({ org: g.orgId, school: g.schoolId }))
// → ['org:abc/school:xyz', ...]
```

---

## `SyncContext`

The underlying React context. Exported for testing — inject a mock engine directly:

```tsx
import { SyncContext } from '@maayo/react';

function wrapper({ children }) {
  return <SyncContext.Provider value={mockEngine}>{children}</SyncContext.Provider>;
}

renderHook(() => useSyncStatus(), { wrapper });
```
