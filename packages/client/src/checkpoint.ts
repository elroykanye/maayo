import type {
  CheckpointEnvelope as ProtocolCheckpointEnvelope,
  CheckpointMaterializedRow,
  CheckpointMergeMetadata,
  Cursor,
  Mutation,
} from '@maayo/protocol';
import type { Table } from 'dexie';
import type { HistoryRow, MaayoDatabase } from './database';

export const CHECKPOINT_PROTOCOL_VERSION = 1 as const;

export type CheckpointRow = CheckpointMaterializedRow;
export type CheckpointEnvelope = ProtocolCheckpointEnvelope & {
  /** Optional recent audit tail. Authoritative older history remains remote. */
  remoteHistory?: Mutation[];
};

export interface CheckpointInstallOptions {
  expectedChannel: string;
  expectedProjectionKey: string;
  expectedProjectionRevision?: string;
  supportedProtocolVersion?: typeof CHECKPOINT_PROTOCOL_VERSION;
  supportedSchemaVersion: string;
  /** Entity tables whose prior checkpoint materialization is replaced. */
  replaceEntityTypes: readonly string[];
  /** Consumer-declared policy metadata table. Omit when policies need no metadata. */
  metaTable?: string;
  /** Maximum remote audit entries retained locally. Default 500. */
  remoteHistoryLimit?: number;
}

/** Stable checksum input shared by checkpoint producers and clients. */
export async function computeCheckpointChecksum(value: Omit<CheckpointEnvelope, 'integrity'> | CheckpointEnvelope): Promise<string> {
  const unsigned = 'integrity' in value
    ? Object.fromEntries(Object.entries(value).filter(([key]) => key !== 'integrity'))
    : value;
  const bytes = new TextEncoder().encode(canonicalJson(unsigned));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Validate and atomically replace a channel checkpoint. The transaction never
 * includes `_outbox`, so pending, retrying, and quarantined local mutations are
 * preserved byte-for-byte.
 */
export async function installCheckpoint(
  db: MaayoDatabase,
  envelope: CheckpointEnvelope,
  options: CheckpointInstallOptions,
): Promise<void> {
  await validateCheckpoint(envelope, options);

  const tables = new Map<string, Table<Record<string, unknown>, string>>();
  for (const entityType of new Set([...options.replaceEntityTypes, ...envelope.rows.map((row) => row.entityType)])) {
    try {
      tables.set(entityType, db.table(entityType));
    } catch {
      if (envelope.rows.some((row) => row.entityType === entityType)) {
        throw new Error(`Checkpoint references unknown entity type: ${entityType}`);
      }
    }
  }
  const metaTable = options.metaTable
    ? db.table<Record<string, unknown>, string>(options.metaTable)
    : undefined;
  const transactionTables: Table[] = [db._cursors, db._history, ...tables.values()];
  if (metaTable) transactionTables.push(metaTable);

  await db.transaction('rw', transactionTables, async () => {
    for (const [entityType, table] of tables) {
      if (!options.replaceEntityTypes.includes(entityType)) continue;
      const existingKeys = await table.toCollection().primaryKeys() as string[];
      if (existingKeys.length > 0) await table.bulkDelete(existingKeys);
    }

    for (const [entityType, table] of tables) {
      const rows = envelope.rows
        .filter((row) => row.entityType === entityType)
        .map((row) => normalizeRow(row));
      if (rows.length > 0) await table.bulkPut(rows);
    }

    if (metaTable) {
      const existingMetaKeys = await metaTable.toCollection().primaryKeys() as string[];
      if (existingMetaKeys.length > 0) await metaTable.bulkDelete(existingMetaKeys);
      const metadata = normalizeMetadata(envelope);
      if (metadata.length > 0) await metaTable.bulkPut(metadata);
    }

    await replaceRemoteHistory(db, envelope, options.remoteHistoryLimit);
    await db._cursors.put({ channel: envelope.channel, ...envelope.throughCursor });
  });
}

async function validateCheckpoint(
  envelope: CheckpointEnvelope,
  options: CheckpointInstallOptions,
): Promise<void> {
  if (!isValidCheckpointEnvelope(envelope)) throw new Error('Invalid checkpoint envelope');
  if (envelope.channel !== options.expectedChannel) throw new Error('Checkpoint channel mismatch');
  if (envelope.projectionKey !== options.expectedProjectionKey) throw new Error('Checkpoint projection key mismatch');
  if (options.expectedProjectionRevision !== undefined
    && envelope.projectionRevision !== options.expectedProjectionRevision) {
    throw new Error('Checkpoint projection revision mismatch');
  }
  if (envelope.protocolVersion !== (options.supportedProtocolVersion ?? CHECKPOINT_PROTOCOL_VERSION)) {
    throw new Error('Unsupported checkpoint protocol version');
  }
  if (envelope.schemaVersion !== options.supportedSchemaVersion) throw new Error('Unsupported checkpoint schema version');
  if (envelope.integrity.algorithm !== 'sha-256') throw new Error('Unsupported checkpoint checksum algorithm');
  const actual = await computeCheckpointChecksum(envelope);
  if (!constantTimeEqual(actual, envelope.integrity.checksum.toLowerCase())) {
    throw new Error('Checkpoint checksum mismatch');
  }
}

function normalizeRow(row: CheckpointRow): Record<string, unknown> {
  return { ...row.payload, id: row.entityId };
}

function normalizeMetadata(envelope: CheckpointEnvelope): Record<string, unknown>[] {
  const result: Record<string, unknown>[] = [];
  for (const item of envelope.mergeMetadata) {
    result.push(normalizeMergeMetadata(item));
  }
  return result;
}

function normalizeMergeMetadata(item: CheckpointMergeMetadata): Record<string, unknown> {
  return {
    key: `${item.entityType}:${item.entityId}`,
    ...item.value,
  };
}

async function replaceRemoteHistory(
  db: MaayoDatabase,
  envelope: CheckpointEnvelope,
  requestedLimit: number | undefined,
): Promise<void> {
  const all = await db._history.toArray();
  const remoteIds = all.filter((row) => row.source === 'remote').map((row) => row.id);
  if (remoteIds.length > 0) await db._history.bulkDelete(remoteIds);
  const limit = requestedLimit === Infinity
    ? Infinity
    : Math.max(0, Math.floor(requestedLimit ?? 500));
  const mutations = limit === Infinity
    ? (envelope.remoteHistory ?? [])
    : (envelope.remoteHistory ?? []).slice(-limit);
  const receivedAt = new Date().toISOString();
  const rows: HistoryRow[] = mutations.map((mutation) => ({ ...mutation, receivedAt, source: 'remote' }));
  if (rows.length > 0) await db._history.bulkPut(rows);
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function constantTimeEqual(first: string, second: string): boolean {
  if (first.length !== second.length) return false;
  let mismatch = 0;
  for (let index = 0; index < first.length; index += 1) {
    mismatch |= first.charCodeAt(index) ^ second.charCodeAt(index);
  }
  return mismatch === 0;
}

function isValidCheckpointEnvelope(value: unknown): value is CheckpointEnvelope {
  if (!isRecord(value)) return false;
  if (value.protocolVersion !== CHECKPOINT_PROTOCOL_VERSION) return false;
  if (!isNonEmptyString(value.schemaVersion)
    || !isNonEmptyString(value.channel)
    || !isNonEmptyString(value.projectionKey)
    || !isNonEmptyString(value.projectionRevision)) return false;
  if (!isCursor(value.throughCursor)) return false;
  if (!Array.isArray(value.rows) || !value.rows.every(isCheckpointRow)) return false;
  if (!Array.isArray(value.mergeMetadata) || !value.mergeMetadata.every(isCheckpointMetadata)) return false;
  if (!isRecord(value.integrity)
    || value.integrity['algorithm'] !== 'sha-256'
    || value.integrity['scope'] !== 'rows-and-merge-metadata'
    || !isNonEmptyString(value.integrity['checksum'])) return false;
  return true;
}

function isCheckpointRow(value: unknown): value is CheckpointMaterializedRow {
  return isRecord(value)
    && isNonEmptyString(value['entityType'])
    && isNonEmptyString(value['entityId'])
    && isJsonObject(value['payload']);
}

function isCheckpointMetadata(value: unknown): value is CheckpointMergeMetadata {
  return isRecord(value)
    && isNonEmptyString(value['entityType'])
    && isNonEmptyString(value['entityId'])
    && isJsonObject(value['value']);
}

function isCursor(value: unknown): value is Cursor {
  if (!isRecord(value)) return false;
  const id = value['lastMutationId'];
  const receivedAt = value['lastReceivedAt'];
  if (id === null && receivedAt === null) return true;
  return isNonEmptyString(id)
    && isNonEmptyString(receivedAt)
    && !Number.isNaN(Date.parse(receivedAt));
}

function isJsonObject(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && Object.getPrototypeOf(value) === Object.prototype;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}
