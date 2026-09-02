# @maayo/client

[![npm version](https://img.shields.io/npm/v/@maayo/client?style=flat-square)](https://www.npmjs.com/package/@maayo/client)
[![npm downloads](https://img.shields.io/npm/dm/@maayo/client?style=flat-square)](https://www.npmjs.com/package/@maayo/client)
[![CI](https://github.com/elroykanye/maayo/actions/workflows/ci.yml/badge.svg)](https://github.com/elroykanye/maayo/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg?style=flat-square)](https://github.com/elroykanye/maayo/blob/main/LICENSE)

Framework-agnostic offline-first sync engine for the [Maayo](https://github.com/elroykanye/maayo) protocol.

Writes go into a local IndexedDB outbox immediately — your UI updates instantly, even offline. When connectivity returns, the engine pushes queued mutations to your server and pulls back any server-side changes. Conflict resolution uses last-write-wins (LWW) on `updatedAt`.

Works in React, Angular, Vue, Svelte, Next.js, Nuxt, or vanilla JS.

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
    classes:  'id, name',
  },
  authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
  intervalMs: 10_000,  // sync every 10s, default
  requestTimeoutMs: 30_000,
  pushBatchSize: 100,
});

engine.start();
```

## API

### `SyncEngine`

| Member | Description |
|--------|-------------|
| `new SyncEngine(config)` | Opens IndexedDB, does not start syncing yet |
| `engine.start()` | Begin periodic sync loop |
| `engine.stop()` | Stop the loop and abort the active cycle (safe to call multiple times) |
| `engine.waitForIdle()` | Wait for an active or aborted cycle to finish cleanup |
| `engine.sync()` | Run one push + pull cycle manually |
| `engine.status` | `'idle' \| 'syncing' \| 'error' \| 'offline'` |
| `engine.onStatusChange(fn)` | Subscribe to status changes, returns unsubscribe fn |
| `engine.db` | Underlying Dexie instance — use for direct table access |

### `SyncConfig`

| Option | Type | Description |
|--------|------|-------------|
| `baseUrl` | `string` | Backend base URL, no trailing slash |
| `dbName` | `string` | IndexedDB database name |
| `channels` | `string[]` | Channels this client pulls from |
| `tables` | `UserTableSchema` | Extra Dexie table definitions for your entities |
| `authHeaders` | `() => Record<string, string>` | Called before each request |
| `intervalMs` | `number` | Sync interval in ms, default `10_000` |
| `requestTimeoutMs` | `number` | Headers-and-body deadline in ms, default `30_000`; timed-out rows remain queued |
| `pushBatchSize` | `number` | Maximum ordered outbox rows per request, default `100` |

`openDatabase()` caches live handles by name. Closing a handle evicts it so the next open returns a
working replacement; incompatible table or migration options for an already-live name are rejected.

### Channel helpers

```ts
import { channelFor, channelsFromGrants } from '@maayo/client';

channelFor({ org: 'abc', school: 'xyz' });
// → 'org:abc/school:xyz'

channelsFromGrants(userGrants, g => ({ org: g.orgId, school: g.schoolId }));
// → ['org:abc/school:s1', 'org:abc/school:s2']
```

## Framework adapters

| Framework | Package |
|-----------|---------|
| React 18+ / Next.js | [![npm](https://img.shields.io/npm/v/@maayo/react?style=flat-square)](https://www.npmjs.com/package/@maayo/react) [`@maayo/react`](https://www.npmjs.com/package/@maayo/react) |
| Angular 17+ | [![npm](https://img.shields.io/npm/v/@maayo/angular?style=flat-square)](https://www.npmjs.com/package/@maayo/angular) [`@maayo/angular`](https://www.npmjs.com/package/@maayo/angular) |
| Vue / Nuxt / Svelte | Use `@maayo/client` directly |

## Server

Implement `POST /sync/mutations` and `GET /sync/changes` in any language. See the [protocol spec](https://github.com/elroykanye/maayo/blob/main/docs/protocol.md). Official Spring Boot adapter: [GitHub Packages](https://github.com/elroykanye/maayo/packages).
