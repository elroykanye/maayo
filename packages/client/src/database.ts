import Dexie, { type Table } from 'dexie';
import type { Mutation, MutationOp } from '@maayo/protocol';

export interface OutboxRow extends Mutation {
  /** Dexie primary key — same as mutation id (ULID) */
  id: string;
  /** ISO-8601, set when the server accepts the mutation */
  syncedAt?: string;
  // --- server-rejection lifecycle (see outbox.ts) ------------------------------
  // These are plain optional fields on the existing table — NEVER a new internal
  // table. MAAYO_DB_VERSION is effectively frozen: user migration versions are
  // keyed off it (MAAYO_DB_VERSION + mig.version), so bumping it would shift
  // every consumer's already-applied Dexie versions and re-run their latest
  // data migration on upgrade. Dexie tables are schemaless beyond their indexes,
  // so additive fields are always safe.
  /** Number of times the server has REJECTED this mutation (207 `rejected`). */
  attempts?: number;
  /** ISO-8601 — the push loop skips this row until this time (retry backoff). */
  nextAttemptAt?: string;
  /** ISO-8601 — set when the row is QUARANTINED: it exhausted its retry budget
   * (or was rejected with a permanent code) and is no longer pushed. Inspect
   * with `rejected()`, revive with `retryRejected()`, drop with `discardRejected()`. */
  rejectedAt?: string;
  /** Server-supplied human-readable rejection reason (last one seen). */
  rejectReason?: string;
  /** Server-supplied machine-readable rejection code (last one seen). */
  rejectCode?: string;
}

export interface CursorRow {
  channel: string;
  lastMutationId: string | null;
  lastReceivedAt: string | null;
}

export interface HistoryRow {
  /** ULID — same as the original mutation id */
  id: string;
  entityType: string;
  entityId: string;
  op: MutationOp;
  payload: string;
  authorIdentityId: string;
  deviceId: string;
  /** ISO-8601 client-side timestamp of the original write */
  clientTs: string;
  /** ISO-8601, when this entry was recorded locally */
  receivedAt: string;
  /** 'local' = originated on this device; 'remote' = pulled from server */
  source: 'local' | 'remote';
}

export interface MigrationDef {
  /** 1-indexed version relative to Maayo's internal schema. v1 = first user migration. */
  version: number;
  /** Optional table schema changes for this version (same syntax as Dexie stores). */
  stores?: Record<string, string | null>;
  /** Optional data migration — receives the Dexie instance inside the upgrade transaction. */
  up?: (db: Dexie) => Promise<void> | void;
}

export type UserTableSchema = Record<string, string>;

// FROZEN — do not bump. User migration versions are declared relative to this
// (MAAYO_DB_VERSION + mig.version), so raising it shifts every consumer's
// already-applied Dexie version numbers: an installed DB would treat its own
// latest data migration as "new" and re-run it. Internal additions must be
// schemaless fields on existing tables (see OutboxRow's rejection fields), or
// a redesign of the versioning contract.
const MAAYO_DB_VERSION = 2;

export class MaayoDatabase extends Dexie {
  _outbox!: Table<OutboxRow, string>;
  _cursors!: Table<CursorRow, string>;
  _history!: Table<HistoryRow, string>;

  constructor(name: string, userTables: UserTableSchema = {}, migrations: MigrationDef[] = []) {
    super(name);

    this.version(1).stores({
      _outbox: 'id, channel, entityType, entityId, clientTs',
      _cursors: 'channel',
      ...userTables,
    });

    // v2: adds the append-only mutation history table
    this.version(2).stores({
      _history: 'id, [entityType+entityId], clientTs',
    });

    for (const mig of migrations) {
      const dbVersion = MAAYO_DB_VERSION + mig.version;
      const ver = this.version(dbVersion).stores(mig.stores ?? {});
      if (mig.up) ver.upgrade(() => mig.up!(this));
    }
  }
}

const _registry = new Map<string, MaayoDatabase>();

export function openDatabase(
  name: string,
  userTables?: UserTableSchema,
  migrations?: MigrationDef[],
): MaayoDatabase {
  if (!_registry.has(name)) {
    _registry.set(name, new MaayoDatabase(name, userTables, migrations));
  }
  return _registry.get(name)!;
}
