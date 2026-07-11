# @maayo/client

Core client library: IndexedDB schema (Dexie), outbox queue, push/pull engine, ULID generation.

## Install

```bash
pnpm add @maayo/client dexie
```

## SyncEngine

The top-level orchestrator. Manages the push–pull loop.

```typescript
import { SyncEngine } from '@maayo/client';

const engine = new SyncEngine({
  baseUrl: 'https://api.example.com',
  dbName: 'myapp',
  channels: ['org:abc/school:xyz'],
  tables: {
    student: 'id, schoolId, name',   // Dexie index spec
  },
  authHeaders: () => ({ Authorization: `Bearer ${getToken()}` }),
  intervalMs: 10_000,                // default
});

engine.start();   // begins push–pull loop
engine.stop();    // clears the interval
await engine.sync();   // run one cycle immediately
await engine.resetCursors();          // full re-pull of every channel ("re-clone")
await engine.resetCursors(['org:1']); // ...or just some channels
```

### `SyncConfig`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | required | Backend base URL, no trailing slash |
| `dbName` | `string` | required | IndexedDB database name |
| `channels` | `string[]` | required | Channels to pull from |
| `tables` | `UserTableSchema` | `{}` | Extra Dexie table schemas for user data |
| `authHeaders` | `() => Record<string,string> \| Promise<...>` | none | Called before each request |
| `intervalMs` | `number` | `10_000` | Push+pull interval in milliseconds |
| `onReject` | `(rejection, mutation, quarantined) => void` | none | Fires per server-rejected mutation (207 `rejected`) |
| `maxRejectAttempts` | `number` | `5` | Rejections before a mutation is quarantined out of the push loop |
| `permanentRejectCodes` | `readonly string[]` | `[]` | Rejection `code`s that quarantine immediately |
| `softDelete` | `boolean` | `false` | Apply pulled DELETEs as gated `{ id, deletedAt }` tombstones instead of hard deletes |
| `applyMutation` | `ApplyMutationHook` | none | Own the merge — called per pulled mutation instead of the built-in LWW apply |
| `onApplied` | `(mutation, outcome) => void` | none | Observer fired once per pulled mutation with its merge outcome |
| `onAuthError` | `(status, phase) => void` | none | Fires on a 401/403 push or pull (the engine's fetch bypasses app HTTP interceptors) |

### `SyncStatus`

```typescript
type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

engine.status                          // current value
engine.onStatusChange((s) => { ... }) // subscribe; returns unsubscribe fn
```

### `engine.db`

Direct access to the `MaayoDatabase` (Dexie instance). Use this to query tables, run `liveQuery`, or call `enqueue`.

---

## Outbox

```typescript
import {
  enqueue, pending, markSynced, purgeSynced,
  rejected, retryRejected, discardRejected,
} from '@maayo/client';
```

### Rejection lifecycle

A push can be a partial success: the 207 body's `rejected` entries are folded
into their outbox rows — exponential re-push backoff (30s doubling to a 30min
cap), then **quarantine** after `maxRejectAttempts` (or immediately for a
`permanentRejectCodes` match). Quarantined rows leave `pending()` but are never
silently dropped:

```typescript
await rejected(db);            // inspect quarantined mutations (reason + code)
await retryRejected(db, id);   // back into the push loop, original clientTs/parentIds intact
await discardRejected(db, id); // drop for good
```

### `enqueue(db, opts): Promise<OutboxRow>`

Adds a mutation to the outbox. Called by your write path before any server interaction.

```typescript
await enqueue(engine.db, {
  channel: 'org:abc/school:xyz',
  entityType: 'Student',
  entityId: '550e8400-...',
  op: 'CREATE',
  payload: { id: '550e...', name: 'Ada', updatedAt: new Date().toISOString() },
  authorIdentityId: 'user-1',
  parentIds: [],   // optional
});
```

### `pending(db): Promise<OutboxRow[]>`

Returns unsynced outbox rows, oldest first. Used internally by the push loop.

### `markSynced(db, ids, receivedAt): Promise<void>`

Stamps accepted mutation IDs with `syncedAt`. Used internally after a successful push.

### `purgeSynced(db): Promise<number>`

Deletes all rows where `syncedAt` is set. Called at the end of each sync cycle.

---

## Pull

```typescript
import { pull } from '@maayo/client';

const { cursor, result, hasMore } = await pull(db, {
  baseUrl: 'https://api.example.com',
  channel: 'org:abc/school:xyz',
  headers: { Authorization: 'Bearer ...' },
  limit: 500,
});
// result.applied — number of rows written to local tables
// result.skipped — number of rows skipped by LWW
```

`pull` reads the cursor from `_cursors`, fetches from `GET /sync/changes`, applies LWW to each entity table, and updates the cursor.

The built-in merge is last-writer-wins on the effective timestamp (payload
`updatedAt`, else `clientTs`) with a **deterministic tie-break**: equal
timestamps compare the mutation identity `(deviceId, id)` against the current
winner's (recovered from `_history`), so every replica picks the same winner
regardless of arrival order. With `softDelete: true`, DELETEs write a gated
`{ id, deletedAt }` tombstone a newer upsert can resurrect, instead of an
unconditional hard delete.

To own the merge entirely (per-entity conflict policies, CRDTs, server-driven
schemas), supply `applyMutation` — it receives each pulled mutation plus the
default apply as an escape hatch, while maayo keeps owning pagination, cursors
and `_history`.

---

## Database

```typescript
import { openDatabase } from '@maayo/client';

const db = openDatabase('myapp', {
  student: 'id, schoolId, name',
  class: 'id, schoolId',
});
```

`openDatabase` returns (and caches) a `MaayoDatabase` keyed by name. Calling it twice with the same name returns the same instance.

### Built-in tables

| Table | Key | Indexes | Description |
|-------|-----|---------|-------------|
| `_outbox` | `id` | `channel, entityType, entityId, clientTs` | Pending mutations |
| `_cursors` | `channel` | — | Pull cursors per channel |

---

## IDs

```typescript
import { ulid, deviceId } from '@maayo/client';

ulid()       // → '01ARZ3NDEKTSV4RRFFQ69G5FAV'  — monotonic ULID
deviceId()   // → 'f47ac10b-...'                  — stable per-browser UUID
```

`ulid()` is monotonic: same-millisecond calls increment the random component. Thread-safe within a single browser tab.

`deviceId()` persists in `localStorage` under key `maayo:deviceId`. Falls back to `crypto.randomUUID()` if storage is unavailable.

---

## Policy-aware merge (`policyApply`)

Opt-in replacement for the built-in LWW apply, driven by the server's declared
conflict policy per entity type (`GET /sync/schema`):

```typescript
import { policyApply } from '@maayo/client';

const engine = new SyncEngine({
  // ...
  tables: { ...yourTables, _syncmeta: 'key' }, // REQUIRED bookkeeping table
  softDelete: true,                            // recommended with policies
  applyMutation: policyApply({ policyFor: (t) => policies[t] ?? 'LWW' }),
});
```

| Policy | Merge |
|--------|-------|
| `LWW` | Whole-row put; winner = max `(clientTs, deviceId, id)`; DELETE is a gated soft tombstone |
| `FIELD_LWW` | Per-field max tuple — concurrent edits to different fields both survive; pair with changed-fields `PATCH` payloads |
| `APPEND_ONLY` | Immutable ledger — earliest CREATE wins; UPDATE/PATCH/DELETE ignored |
| `OR_SET` | Add-wins observed-remove — CREATEs are add-tags, DELETEs remove only the tags in their `parentIds` |
| `MANUAL` | LWW value + `hasConflict`/`conflictPayload` on concurrent differing writes; server `"system"` PATCHes applied verbatim |

Reads must filter `deletedAt` (policies always soft-delete). Bookkeeping lives
in the consumer-declared `_syncmeta` table (`'key'` schema), never on entity
rows.

---

## Convergence testing (`foldPolicies`, `assertConverges`)

The operational definition of "replicas converge": the same mutations in ANY
order produce identical state. The harness proves it for your policy map — or
your own `applyMutation` hook — without touching IndexedDB:

```typescript
import { assertConverges, foldPolicies } from '@maayo/client';

const state = assertConverges(mutations, (ms) => foldPolicies(ms, policyFor));
expect(state['Student#s1'].row?.name).toBe('Ada');
```

`assertConverges` folds every permutation (seeded shuffles for large sets) and
throws a diff-rich error naming the orders that disagreed; `checkConvergence`
returns the report instead of throwing.
