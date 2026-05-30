# @maayo/react

React adapter for Maayo — offline-first sync with hooks.

Works with React 18+, Next.js (App Router and Pages), and any React-based framework. Uses `SyncProvider` to boot the engine and `useCollection` / `useSyncStatus` hooks to bind live IndexedDB data to components.

## Install

```bash
npm install @maayo/react @maayo/client dexie
```

## Quick start

### 1. Wrap your app (or layout) with `SyncProvider`

```tsx
// app/layout.tsx (Next.js App Router) or index.tsx
'use client'; // Next.js only

import { SyncProvider } from '@maayo/react';

export default function RootLayout({ children }) {
  return (
    <SyncProvider
      config={{
        baseUrl: 'https://api.example.com',
        dbName: 'myapp',
        channels: ['org:abc/school:xyz'],
        tables: { students: 'id, name', classes: 'id, name' },
        authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
      }}
    >
      {children}
    </SyncProvider>
  );
}
```

### 2. Use data in any component

```tsx
'use client'; // Next.js only

import { useCollection, useSyncStatus } from '@maayo/react';

interface Student { id: string; name: string }

export function StudentList() {
  const students = useCollection<Student>('students');
  const status = useSyncStatus();

  return (
    <div>
      <p>Sync: {status}</p>
      {students.map(s => <div key={s.id}>{s.name}</div>)}
    </div>
  );
}
```

## API

| Hook / Component | Description |
|-----------------|-------------|
| `<SyncProvider config={...}>` | Boots the sync engine, provides it via context |
| `useCollection<T>(tableName)` | Live array of all rows in a table, re-renders on change |
| `useSyncStatus()` | Current sync status: `'idle' \| 'syncing' \| 'error' \| 'offline'` |
| `useSyncEngine()` | Access the raw `SyncEngine` instance |

## Next.js notes

All hooks use browser APIs (IndexedDB, `navigator.onLine`). Mark any component that uses them with `'use client'`. The `SyncProvider` itself also needs `'use client'`.

## Server setup

Any backend implementing `POST /sync/mutations` and `GET /sync/changes`. Official adapters: [Spring Boot](https://github.com/elroykanye/maayo/packages/spring). See the [protocol spec](https://github.com/elroykanye/maayo/blob/main/docs/protocol.md) to implement in any language.
