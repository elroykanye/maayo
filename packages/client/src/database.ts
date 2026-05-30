import Dexie, { type Table } from 'dexie';
import type { Mutation } from '@maayo/protocol';

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

export type UserTableSchema = Record<string, string>;

export class MaayoDatabase extends Dexie {
  _outbox!: Table<OutboxRow, string>;
  _cursors!: Table<CursorRow, string>;

  constructor(name: string, userTables: UserTableSchema = {}) {
    super(name);
    this.version(1).stores({
      _outbox: 'id, channel, entityType, entityId, clientTs',
      _cursors: 'channel',
      ...userTables,
    });
  }
}

let _db: MaayoDatabase | null = null;

export function openDatabase(name: string, userTables?: UserTableSchema): MaayoDatabase {
  if (!_db) {
    _db = new MaayoDatabase(name, userTables);
  }
  return _db;
}
