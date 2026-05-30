# Maayo

> *Maayo* (Fulfulde: "river") — offline-first sync between a local device store and any backend.

[![CI](https://github.com/elroykanye/maayo/actions/workflows/ci.yml/badge.svg)](https://github.com/elroykanye/maayo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Maayo is for applications that need to work without a network connection. Local writes go into an IndexedDB outbox immediately and sync to your server whenever connectivity returns. The server side is two HTTP endpoints — implement them on any backend, any database, any language.

## Packages

| Package | Version | Downloads | Description |
|---------|---------|-----------|-------------|
| [`@maayo/protocol`](https://www.npmjs.com/package/@maayo/protocol) | [![npm](https://img.shields.io/npm/v/@maayo/protocol?style=flat-square)](https://www.npmjs.com/package/@maayo/protocol) | [![downloads](https://img.shields.io/npm/dm/@maayo/protocol?style=flat-square)](https://www.npmjs.com/package/@maayo/protocol) | TypeScript types — zero runtime deps |
| [`@maayo/client`](https://www.npmjs.com/package/@maayo/client) | [![npm](https://img.shields.io/npm/v/@maayo/client?style=flat-square)](https://www.npmjs.com/package/@maayo/client) | [![downloads](https://img.shields.io/npm/dm/@maayo/client?style=flat-square)](https://www.npmjs.com/package/@maayo/client) | Core engine: outbox, push/pull, LWW |
| [`@maayo/react`](https://www.npmjs.com/package/@maayo/react) | [![npm](https://img.shields.io/npm/v/@maayo/react?style=flat-square)](https://www.npmjs.com/package/@maayo/react) | [![downloads](https://img.shields.io/npm/dm/@maayo/react?style=flat-square)](https://www.npmjs.com/package/@maayo/react) | React / Next.js hooks |
| [`@maayo/angular`](https://www.npmjs.com/package/@maayo/angular) | [![npm](https://img.shields.io/npm/v/@maayo/angular?style=flat-square)](https://www.npmjs.com/package/@maayo/angular) | [![downloads](https://img.shields.io/npm/dm/@maayo/angular?style=flat-square)](https://www.npmjs.com/package/@maayo/angular) | Angular signals + DI |
| `@maayo/spring` | [![GitHub Packages](https://img.shields.io/badge/GitHub%20Packages-0.1.1-blue?style=flat-square)](https://github.com/elroykanye/maayo/packages) | — | Spring Boot autoconfiguration |

## How it works

```
Browser                                    Server (any DB)
─────────────────────────────────────      ─────────────────────────
write → _outbox (IndexedDB)
               ──── POST /sync/mutations ──→  store mutation + timestamp
               ←─── GET  /sync/changes   ───  deltas since cursor
apply to local tables ←
update cursor ←
```

Writes are local-first — they appear in the UI instantly even offline. Push and pull run independently. A device can be offline for days, queue hundreds of writes, and sync cleanly when it reconnects.

## Quick start

### React / Next.js

```bash
npm install @maayo/react @maayo/client dexie
```

```tsx
// layout.tsx — add 'use client' for Next.js App Router
import { SyncProvider, useCollection } from '@maayo/react';

function App() {
  return (
    <SyncProvider config={{ baseUrl: 'https://api.example.com', dbName: 'myapp', channels: ['org:abc'] }}>
      <StudentList />
    </SyncProvider>
  );
}

function StudentList() {
  const students = useCollection('students');
  return students.map(s => <div key={s.id}>{s.name}</div>);
}
```

### Angular

```bash
npm install @maayo/angular @maayo/client dexie
```

```ts
// app.config.ts
import { provideSync } from '@maayo/angular';

export const appConfig = {
  providers: [provideSync({ baseUrl: 'https://api.example.com', dbName: 'myapp', channels: ['org:abc'] })]
};
```

```ts
// component
students = syncCollection('students');
status = injectSyncStatus();
```

### Spring Boot server

```kotlin
// build.gradle.kts
repositories {
    maven { url = uri("https://maven.pkg.github.com/elroykanye/maayo") }
}
dependencies {
    implementation("dev.maayo:maayo-spring:0.1.1")
}
```

Any backend language works — see the [protocol spec](docs/protocol.md).

## Framework support

| Frontend | Support |
|----------|---------|
| React 18+ | `@maayo/react` |
| Next.js (App Router / Pages) | `@maayo/react` + `'use client'` |
| Angular 17+ | `@maayo/angular` |
| Vue / Nuxt | `@maayo/client` directly (Vue adapter planned) |
| Svelte / vanilla JS | `@maayo/client` directly |

| Backend | Support |
|---------|---------|
| Spring Boot | `@maayo/spring` (GitHub Packages) |
| Node.js / Express / Fastify | Implement 2 endpoints — [protocol spec](docs/protocol.md) |
| Python / FastAPI / Django | Implement 2 endpoints — [protocol spec](docs/protocol.md) |
| Go, Rails, Laravel, any | Implement 2 endpoints — [protocol spec](docs/protocol.md) |

## Docs

- [Getting Started](docs/getting-started.md)
- [Core Concepts](docs/concepts.md)
- [Protocol Specification](docs/protocol.md)

## License

MIT
