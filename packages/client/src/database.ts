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
  private _wasClosed = false;

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

  override close(closeOptions?: { disableAutoOpen: boolean }): void {
    this._wasClosed = true;
    super.close(closeOptions);
  }

  get wasClosed(): boolean {
    return this._wasClosed;
  }
}

interface RegistryEntry {
  db: MaayoDatabase;
  userTables: UserTableSchema;
  migrations: MigrationDef[];
}

const _registry = new Map<string, RegistryEntry>();

export function openDatabase(
  name: string,
  userTables?: UserTableSchema,
  migrations?: MigrationDef[],
): MaayoDatabase {
  const existing = _registry.get(name);
  if (!existing) {
    const config = captureConfiguration(userTables, migrations);
    const db = new MaayoDatabase(name, config.userTables, config.migrations);
    _registry.set(name, { db, ...config });
    return db;
  }

  const suppliedConfiguration = userTables !== undefined || migrations !== undefined;
  const config = captureConfiguration(
    userTables ?? existing.userTables,
    migrations ?? existing.migrations,
  );
  if (!existing.db.wasClosed) {
    if (suppliedConfiguration && !sameConfiguration(existing, config)) {
      throw new Error(`Database "${name}" is already registered with a different configuration`);
    }
    return existing.db;
  }

  const db = new MaayoDatabase(name, config.userTables, config.migrations);
  _registry.set(name, { db, ...config });
  return db;
}

function captureConfiguration(
  userTables: UserTableSchema = {},
  migrations: MigrationDef[] = [],
): Omit<RegistryEntry, 'db'> {
  return {
    userTables: { ...userTables },
    migrations: migrations.map((migration) => ({
      ...migration,
      stores: migration.stores ? { ...migration.stores } : undefined,
    })),
  };
}

function sameConfiguration(
  existing: Omit<RegistryEntry, 'db'>,
  requested: Omit<RegistryEntry, 'db'>,
): boolean {
  if (!sameStores(existing.userTables, requested.userTables)) return false;
  if (existing.migrations.length !== requested.migrations.length) return false;
  return existing.migrations.every((migration, index) => {
    const other = requested.migrations[index];
    return migration.version === other.version
      && migration.up === other.up
      && sameStores(migration.stores ?? {}, other.stores ?? {});
  });
}

function sameStores(
  first: Record<string, string | null>,
  second: Record<string, string | null>,
): boolean {
  const firstEntries = Object.entries(first).sort(([a], [b]) => a.localeCompare(b));
  const secondEntries = Object.entries(second).sort(([a], [b]) => a.localeCompare(b));
  return firstEntries.length === secondEntries.length
    && firstEntries.every(([key, value], index) => {
      const other = secondEntries[index];
      return key === other[0] && value === other[1];
    });
}
