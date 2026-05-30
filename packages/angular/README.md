# @maayo/angular

[![npm version](https://img.shields.io/npm/v/@maayo/angular?style=flat-square)](https://www.npmjs.com/package/@maayo/angular)
[![npm downloads](https://img.shields.io/npm/dm/@maayo/angular?style=flat-square)](https://www.npmjs.com/package/@maayo/angular)
[![CI](https://github.com/elroykanye/maayo/actions/workflows/ci.yml/badge.svg)](https://github.com/elroykanye/maayo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/elroykanye/maayo/blob/main/LICENSE)

Angular adapter for [Maayo](https://github.com/elroykanye/maayo) — offline-first sync with signals and Angular DI.

Requires Angular 17+ and RxJS 7+.

## Install

```bash
npm install @maayo/angular @maayo/client dexie
```

## Quick start

### 1. Register in `app.config.ts`

```ts
import { ApplicationConfig } from '@angular/core';
import { provideSync } from '@maayo/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideSync({
      baseUrl: 'https://api.example.com',
      dbName: 'myapp',
      channels: ['org:abc/school:xyz'],
      tables: {
        students: 'id, name, classId',
        classes:  'id, name',
      },
      authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
    }),
  ],
};
```

### 2. Use in components

```ts
import { Component } from '@angular/core';
import { syncCollection, injectSyncStatus } from '@maayo/angular';

interface Student { id: string; name: string }

@Component({
  standalone: true,
  template: `
    <p>Sync: {{ status() }}</p>
    @for (s of students(); track s.id) {
      <div>{{ s.name }}</div>
    }
  `,
})
export class StudentListComponent {
  students = syncCollection<Student>('students');
  status   = injectSyncStatus();
}
```

## API

| Export | Description |
|--------|-------------|
| `provideSync(config)` | Application provider — registers and starts the engine |
| `syncCollection<T>(tableName)` | Signal with live IndexedDB rows, updates on every change |
| `injectSyncStatus()` | Signal of current sync status |
| `SYNC_ENGINE` | DI token for the raw `SyncEngine` instance |
| `channelFor(scope)` | Build a channel string from a scope record |
| `channelsFromGrants(grants, toScope)` | Map role grants to deduplicated channel strings |

## Channel helpers

```ts
import { channelFor, channelsFromGrants } from '@maayo/angular';

channelFor({ org: 'abc', school: 'xyz' }); // → 'org:abc/school:xyz'
```

## Server

Any backend implementing `POST /sync/mutations` and `GET /sync/changes`. Official adapters:
- **Spring Boot** — [GitHub Packages](https://github.com/elroykanye/maayo/packages) (`dev.maayo:maayo-spring`)

Any language works — see the [protocol spec](https://github.com/elroykanye/maayo/blob/main/docs/protocol.md).

## Related

- [`@maayo/client`](https://www.npmjs.com/package/@maayo/client) — core engine (framework-agnostic)
- [`@maayo/react`](https://www.npmjs.com/package/@maayo/react) — React / Next.js hooks
