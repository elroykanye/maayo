import Dexie, { type Table } from 'dexie';
import type { Mutation, MutationOp } from '@maayo/protocol';

export interface OutboxRow extends Mutation {
  /** Dexie primary key — same as mutation id (ULID) */
  id: string;
  /** ISO-8601, set when the server accepts the mutation */
  syncedAt?: string;
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

// Bump this whenever a new internal table is added.
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
