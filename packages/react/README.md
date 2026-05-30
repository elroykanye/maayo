# @maayo/react

[![npm version](https://img.shields.io/npm/v/@maayo/react?style=flat-square)](https://www.npmjs.com/package/@maayo/react)
[![npm downloads](https://img.shields.io/npm/dm/@maayo/react?style=flat-square)](https://www.npmjs.com/package/@maayo/react)
[![CI](https://github.com/elroykanye/maayo/actions/workflows/ci.yml/badge.svg)](https://github.com/elroykanye/maayo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/elroykanye/maayo/blob/main/LICENSE)

React adapter for [Maayo](https://github.com/elroykanye/maayo) — offline-first sync with `SyncProvider` and hooks.

Works with React 18+, **Next.js** (App Router and Pages Router), and any React-based framework.

## Install

```bash
npm install @maayo/react @maayo/client dexie
```

## Quick start

### 1. Wrap your app with `SyncProvider`

```tsx
// Next.js App Router — app/layout.tsx
'use client';

import { SyncProvider } from '@maayo/react';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <SyncProvider
      config={{
        baseUrl: process.env.NEXT_PUBLIC_API_URL!,
        dbName: 'myapp',
        channels: ['org:abc/school:xyz'],
        tables: {
          students: 'id, name, classId',
          classes:  'id, name',
        },
        authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
      }}
    >
      {children}
    </SyncProvider>
  );
}
```

### 2. Read live data in components

```tsx
'use client';

import { useCollection, useSyncStatus } from '@maayo/react';

interface Student { id: string; name: string; classId: string }

export function StudentList() {
  const students = useCollection<Student>('students');
  const status = useSyncStatus();

  return (
    <>
      <p>Status: {status}</p>
      {students.map(s => <div key={s.id}>{s.name}</div>)}
    </>
  );
}
```

## API

| Export | Description |
|--------|-------------|
| `<SyncProvider config={...}>` | Boots the engine, makes it available via context |
| `useCollection<T>(tableName)` | Live array from IndexedDB — re-renders on every change |
| `useSyncStatus()` | `'idle' \| 'syncing' \| 'error' \| 'offline'` |
| `useSyncEngine()` | Raw `SyncEngine` instance for advanced use |

## Next.js notes

All hooks use browser APIs (IndexedDB, `navigator.onLine`). In the App Router, add `'use client'` to every component that calls a Maayo hook, including the layout that renders `<SyncProvider>`.

## Server

Any backend can be the server. Official adapters:
- **Spring Boot** — [GitHub Packages](https://github.com/elroykanye/maayo/packages) (`dev.maayo:maayo-spring`)

Any language works — see the [protocol spec](https://github.com/elroykanye/maayo/blob/main/docs/protocol.md).

## Related

- [`@maayo/client`](https://www.npmjs.com/package/@maayo/client) — core engine (framework-agnostic)
- [`@maayo/angular`](https://www.npmjs.com/package/@maayo/angular) — Angular signals adapter
