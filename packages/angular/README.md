# @maayo/angular

Angular adapter for Maayo — offline-first sync with signals and DI.

## Install

```bash
npm install @maayo/angular @maayo/client dexie
```

Requires Angular 17+ and RxJS 7+.

## Quick start

### 1. Register the provider in `app.config.ts`

```ts
import { provideSync } from '@maayo/angular';

export const appConfig: ApplicationConfig = {
  providers: [
    provideSync({
      baseUrl: 'https://api.example.com',
      dbName: 'myapp',
      channels: ['org:abc/school:xyz'],
      tables: { students: 'id, name', classes: 'id, name' },
      authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
    }),
  ],
};
```

### 2. Use live data in a component

```ts
import { Component } from '@angular/core';
import { syncCollection, injectSyncStatus } from '@maayo/angular';

interface Student { id: string; name: string }

@Component({
  template: `
    <p>Sync: {{ status() }}</p>
    @for (s of students(); track s.id) {
      <div>{{ s.name }}</div>
    }
  `,
})
export class StudentListComponent {
  students = syncCollection<Student>('students');
  status = injectSyncStatus();
}
```

## API

| Export | Description |
|--------|-------------|
| `provideSync(config)` | Application provider — boots the sync engine |
| `syncCollection<T>(tableName)` | Signal of all rows in a table, updates live |
| `injectSyncStatus()` | Signal of current sync status |
| `SYNC_ENGINE` | DI token for the raw `SyncEngine` instance |
| `channelFor(scope)` | Build a channel string from a scope object |
| `channelsFromGrants(grants, toScope)` | Map role grants to channel strings |

## Server setup

Any backend implementing `POST /sync/mutations` and `GET /sync/changes`. Official adapters: [Spring Boot](https://github.com/elroykanye/maayo/packages/spring). See the [protocol spec](https://github.com/elroykanye/maayo/blob/main/docs/protocol.md) to implement in any language (Node.js, Python, Go, Rails, etc.).
