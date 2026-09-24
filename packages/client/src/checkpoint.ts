import type {
  CheckpointEnvelope as ProtocolCheckpointEnvelope,
  CheckpointMaterializedRow,
  CheckpointMergeMetadata,
  Cursor,
  Mutation,
} from '@maayo/protocol';
import type { Table } from 'dexie';
import type { CursorRow, HistoryRow, LwwWinnerRow, MaayoDatabase } from './database';

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

export interface VerifiedCheckpointHeader {
  protocolVersion: typeof CHECKPOINT_PROTOCOL_VERSION;
  schemaVersion: string;
  channel: string;
  projectionKey: string;
  projectionRevision: string;
  throughCursor: Cursor;
}

export interface VerifiedCheckpointChunk {
  rows: readonly CheckpointRow[];
  mergeMetadata: readonly CheckpointMergeMetadata[];
}

export type VerifiedCheckpointInstallPhase = 'plan' | 'delete' | 'write' | 'metadata' | 'history' | 'cursor' | 'commit';
export interface VerifiedCheckpointInstallMetric {
  phase: VerifiedCheckpointInstallPhase;
  durationMs: number;
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

  await installCheckpointChunksCore(db, envelope, [{
    rows: envelope.rows,
    mergeMetadata: envelope.mergeMetadata,
  }], options, envelope.remoteHistory);
}

/**
 * Activate chunks whose manifest and content digests were already verified by
 * the snapshot-pack protocol. This avoids rebuilding and hashing a second
 * monolithic checkpoint while retaining one IndexedDB transaction for the
 * complete generation swap.
 */
export async function installVerifiedCheckpointChunks(
  db: MaayoDatabase,
  header: VerifiedCheckpointHeader,
  chunks: readonly VerifiedCheckpointChunk[],
  options: CheckpointInstallOptions,
): Promise<VerifiedCheckpointInstallMetric[]> {
  validateCheckpointHeader(header, options);
  return installCheckpointChunksCore(db, header, chunks, options);
}

async function installCheckpointChunksCore(
  db: MaayoDatabase,
  header: VerifiedCheckpointHeader,
  chunks: readonly VerifiedCheckpointChunk[],
  options: CheckpointInstallOptions,
  remoteHistory?: readonly Mutation[],
): Promise<VerifiedCheckpointInstallMetric[]> {
  const metrics: VerifiedCheckpointInstallMetric[] = [];
  let phaseStarted = nowMs();

  const replaceEntityTypes = new Set(options.replaceEntityTypes);
  const incomingOwnedRows: string[] = [];
  const incomingEntityTypes = new Set<string>();
  for (const chunk of chunks) {
    for (const row of chunk.rows) {
      if (!replaceEntityTypes.has(row.entityType)) {
        throw new Error(`Checkpoint entity type is not configured for replacement: ${row.entityType}`);
      }
      incomingEntityTypes.add(row.entityType);
      incomingOwnedRows.push(checkpointEntityKey(row.entityType, row.entityId));
    }
  }

  const tables = new Map<string, Table<Record<string, unknown>, string>>();
  for (const entityType of new Set([...options.replaceEntityTypes, ...incomingEntityTypes])) {
    try {
      tables.set(entityType, db.table(entityType));
    } catch {
      if (incomingEntityTypes.has(entityType)) {
        throw new Error(`Checkpoint references unknown entity type: ${entityType}`);
      }
    }
  }
  const metaTable = options.metaTable
    ? db.table<Record<string, unknown>, string>(options.metaTable)
    : undefined;
  const transactionTables: Table[] = [db._cursors, db._history, ...tables.values()];
  if (metaTable) transactionTables.push(metaTable);
  metrics.push({ phase: 'plan', durationMs: nowMs() - phaseStarted });

  const commitStarted = nowMs();
  await db.transaction('rw', transactionTables, async () => {
    const currentCursor = await db._cursors.get(header.channel);
    const otherCursors = (await db._cursors.toArray()).filter((cursor) => cursor.channel !== header.channel);
    await assertTrackedChannelIsolation(
      currentCursor, otherCursors, replaceEntityTypes, tables, chunks,
    );
    const clearWholeTables = !currentCursor?.checkpointRows && !otherCursors.some(hasMaterializedState);
    const previousOwnedRows = currentCursor?.checkpointRows ?? [];

    phaseStarted = nowMs();
    if (clearWholeTables) {
      for (const [entityType, table] of tables) {
        if (!replaceEntityTypes.has(entityType)) continue;
        await table.clear();
      }
    } else {
      await deleteOwnedRows(
        tables,
        previousOwnedRows,
        replaceEntityTypes,
        new Set(otherCursors.flatMap((cursor) => cursor.checkpointRows ?? [])),
      );
    }
    metrics.push({ phase: 'delete', durationMs: nowMs() - phaseStarted });

    phaseStarted = nowMs();
    for (const chunk of chunks) {
      const rowsByType = new Map<string, Record<string, unknown>[]>();
      for (const row of chunk.rows) {
        const rows = rowsByType.get(row.entityType) ?? [];
        rows.push(normalizeRow(row));
        rowsByType.set(row.entityType, rows);
      }
      for (const [entityType, rows] of rowsByType) {
        const table = tables.get(entityType);
        if (table && rows.length > 0) await table.bulkPut(rows);
      }
    }
    metrics.push({ phase: 'write', durationMs: nowMs() - phaseStarted });

    phaseStarted = nowMs();
    if (metaTable) {
      const otherOwnedRows = new Set(otherCursors.flatMap((cursor) => cursor.checkpointRows ?? []));
      const existingMetaKeys = clearWholeTables
        ? await metaTable.toCollection().primaryKeys() as string[]
        : previousOwnedRows
            .filter((key) => !otherOwnedRows.has(key))
            .map(parseCheckpointEntityKey)
            .filter(([entityType]) => replaceEntityTypes.has(entityType))
            .map(([entityType, entityId]) => `${entityType}:${entityId}`);
      if (existingMetaKeys.length > 0) await metaTable.bulkDelete(existingMetaKeys);
      for (const chunk of chunks) {
        const metadata = chunk.mergeMetadata.map(normalizeMergeMetadata);
        if (metadata.length > 0) await metaTable.bulkPut(metadata);
      }
    }
    metrics.push({ phase: 'metadata', durationMs: nowMs() - phaseStarted });

    phaseStarted = nowMs();
    await replaceRemoteHistory(db, header.channel, remoteHistory, options.remoteHistoryLimit);
    metrics.push({ phase: 'history', durationMs: nowMs() - phaseStarted });
    phaseStarted = nowMs();
    const lwwWinners = metaTable
      ? undefined
      : nextLwwWinners(currentCursor, previousOwnedRows, replaceEntityTypes, chunks);
    const retainedOwnedRows = previousOwnedRows.filter((key) => {
      const [entityType] = parseCheckpointEntityKey(key);
      return !replaceEntityTypes.has(entityType);
    });
    await db._cursors.put({
      channel: header.channel,
      ...header.throughCursor,
      checkpointRows: [...retainedOwnedRows, ...incomingOwnedRows],
      checkpointProjectionKey: header.projectionKey,
      checkpointProjectionRevision: header.projectionRevision,
      lwwWinners,
    });
    metrics.push({ phase: 'cursor', durationMs: nowMs() - phaseStarted });
  });
  metrics.push({ phase: 'commit', durationMs: nowMs() - commitStarted });
  return metrics;
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

/** Remove one checkpoint-backed working set without touching shared rows or local outbox state. */
export async function evictCheckpointChannel(
  db: MaayoDatabase,
  channel: string,
  replaceEntityTypes: readonly string[],
  metaTableName?: string,
): Promise<void> {
  const cursor = await db._cursors.get(channel);
  if (!cursor) return;
  if (cursor.checkpointRows === undefined) {
    throw new Error(`Cannot safely evict untracked channel ${channel}`);
  }
  const tables = new Map<string, Table<Record<string, unknown>, string>>();
  for (const entityType of replaceEntityTypes) tables.set(entityType, db.table(entityType));
  const metaTable = metaTableName
    ? db.table<Record<string, unknown>, string>(metaTableName)
    : undefined;
  const transactionTables: Table[] = [db._cursors, db._history, ...tables.values()];
  if (metaTable) transactionTables.push(metaTable);
  await db.transaction('rw', transactionTables, async () => {
    const otherCursors = (await db._cursors.toArray()).filter((item) => item.channel !== channel);
    const protectedRows = new Set(otherCursors.flatMap((item) => item.checkpointRows ?? []));
    await deleteOwnedRows(tables, cursor.checkpointRows ?? [], new Set(replaceEntityTypes), protectedRows);
    if (metaTable) {
      const metaKeys = (cursor.checkpointRows ?? [])
        .filter((key) => !protectedRows.has(key))
        .map(parseCheckpointEntityKey)
        .filter(([entityType]) => replaceEntityTypes.includes(entityType))
        .map(([entityType, entityId]) => `${entityType}:${entityId}`);
      if (metaKeys.length > 0) await metaTable.bulkDelete(metaKeys);
    }
    const remoteHistoryIds = (await db._history.toArray())
      .filter((row) => row.source === 'remote' && row.channel === channel)
      .map((row) => row.id);
    if (remoteHistoryIds.length > 0) await db._history.bulkDelete(remoteHistoryIds);
    await db._cursors.delete(channel);
  });
}

async function validateCheckpoint(
  envelope: CheckpointEnvelope,
  options: CheckpointInstallOptions,
): Promise<void> {
  if (!isValidCheckpointEnvelope(envelope)) throw new Error('Invalid checkpoint envelope');
  validateCheckpointHeader(envelope, options);
  if (envelope.integrity.algorithm !== 'sha-256') throw new Error('Unsupported checkpoint checksum algorithm');
  const actual = await computeCheckpointChecksum(envelope);
  if (!constantTimeEqual(actual, envelope.integrity.checksum.toLowerCase())) {
    throw new Error('Checkpoint checksum mismatch');
  }
}

function validateCheckpointHeader(
  header: VerifiedCheckpointHeader,
  options: CheckpointInstallOptions,
): void {
  if (header.channel !== options.expectedChannel) throw new Error('Checkpoint channel mismatch');
  if (header.projectionKey !== options.expectedProjectionKey) throw new Error('Checkpoint projection key mismatch');
  if (options.expectedProjectionRevision !== undefined
    && header.projectionRevision !== options.expectedProjectionRevision) {
    throw new Error('Checkpoint projection revision mismatch');
  }
  if (header.protocolVersion !== (options.supportedProtocolVersion ?? CHECKPOINT_PROTOCOL_VERSION)) {
    throw new Error('Unsupported checkpoint protocol version');
  }
  if (header.schemaVersion !== options.supportedSchemaVersion) throw new Error('Unsupported checkpoint schema version');
  if (!isCursor(header.throughCursor)) throw new Error('Invalid checkpoint cursor');
}

function normalizeRow(row: CheckpointRow): Record<string, unknown> {
  return { ...row.payload, id: row.entityId };
}

function normalizeMergeMetadata(item: CheckpointMergeMetadata): Record<string, unknown> {
  return {
    key: `${item.entityType}:${item.entityId}`,
    ...item.value,
  };
}

function checkpointEntityKey(entityType: string, entityId: string): string {
  return JSON.stringify([entityType, entityId]);
}

function parseCheckpointEntityKey(key: string): [string, string] {
  const value = JSON.parse(key) as unknown;
  if (!Array.isArray(value) || value.length !== 2
    || typeof value[0] !== 'string' || typeof value[1] !== 'string') {
    throw new Error('Invalid stored checkpoint ownership key');
  }
  return [value[0], value[1]];
}

function hasMaterializedState(cursor: CursorRow): boolean {
  return Boolean(cursor.checkpointRows?.length || cursor.lastMutationId || cursor.lastReceivedAt);
}

async function assertTrackedChannelIsolation(
  currentCursor: CursorRow | undefined,
  otherCursors: CursorRow[],
  replaceEntityTypes: Set<string>,
  tables: Map<string, Table<Record<string, unknown>, string>>,
  chunks: readonly VerifiedCheckpointChunk[],
): Promise<void> {
  const untracked = otherCursors.find((cursor) =>
    hasMaterializedState(cursor) && cursor.checkpointRows === undefined);
  if (untracked) {
    throw new Error(
      `Cannot safely install checkpoint beside untracked channel ${untracked.channel}; use a separate database or re-clone channels`,
    );
  }
  if (currentCursor && hasMaterializedState(currentCursor)
    && currentCursor.checkpointRows === undefined && otherCursors.some(hasMaterializedState)) {
    throw new Error('Cannot safely replace an untracked channel in a shared checkpoint database');
  }

  const otherOwners = new Map<string, string>();
  for (const cursor of otherCursors) {
    for (const key of cursor.checkpointRows ?? []) {
      const [entityType] = parseCheckpointEntityKey(key);
      if (replaceEntityTypes.has(entityType)) otherOwners.set(key, cursor.channel);
    }
  }
  for (const chunk of chunks) {
    for (const incoming of chunk.rows) {
      const key = checkpointEntityKey(incoming.entityType, incoming.entityId);
      const owner = otherOwners.get(key);
      if (owner) {
        const existing = await tables.get(incoming.entityType)?.get(incoming.entityId);
        if (canonicalJson(existing) !== canonicalJson(normalizeRow(incoming))) {
          throw new Error(`Checkpoint row ${incoming.entityType}/${incoming.entityId} conflicts with channel ${owner}`);
        }
      }
    }
  }
}

async function deleteOwnedRows(
  tables: Map<string, Table<Record<string, unknown>, string>>,
  ownedRows: string[],
  replaceEntityTypes: Set<string>,
  protectedRows: Set<string>,
): Promise<void> {
  const idsByType = new Map<string, string[]>();
  for (const key of ownedRows) {
    if (protectedRows.has(key)) continue;
    const [entityType, entityId] = parseCheckpointEntityKey(key);
    if (!replaceEntityTypes.has(entityType)) continue;
    const ids = idsByType.get(entityType) ?? [];
    ids.push(entityId);
    idsByType.set(entityType, ids);
  }
  for (const [entityType, ids] of idsByType) {
    const table = tables.get(entityType);
    if (table && ids.length > 0) await table.bulkDelete(ids);
  }
}

function nextLwwWinners(
  currentCursor: CursorRow | undefined,
  previousOwnedRows: string[],
  replaceEntityTypes: Set<string>,
  chunks: readonly VerifiedCheckpointChunk[],
): Record<string, LwwWinnerRow> {
  const winners = { ...(currentCursor?.lwwWinners ?? {}) };
  for (const key of previousOwnedRows) {
    const [entityType, entityId] = parseCheckpointEntityKey(key);
    if (replaceEntityTypes.has(entityType)) delete winners[`${entityType}\u0000${entityId}`];
  }
  for (const chunk of chunks) {
    for (const metadata of chunk.mergeMetadata) {
      const value = metadata.value;
      if (value['policy'] !== 'LWW'
        || typeof value['clientTs'] !== 'string'
        || typeof value['deviceId'] !== 'string'
        || typeof value['mutationId'] !== 'string') continue;
      winners[`${metadata.entityType}\u0000${metadata.entityId}`] = {
        clientTs: value['clientTs'],
        deviceId: value['deviceId'],
        mutationId: value['mutationId'],
      };
    }
  }
  return winners;
}

async function replaceRemoteHistory(
  db: MaayoDatabase,
  channel: string,
  remoteHistory: readonly Mutation[] | undefined,
  requestedLimit: number | undefined,
): Promise<void> {
  const all = await db._history.toArray();
  const remoteIds = all
    .filter((row) => row.source === 'remote' && row.channel === channel)
    .map((row) => row.id);
  if (remoteIds.length > 0) await db._history.bulkDelete(remoteIds);
  const limit = requestedLimit === Infinity
    ? Infinity
    : Math.max(0, Math.floor(requestedLimit ?? 500));
  const mutations = limit === Infinity
    ? (remoteHistory ?? [])
    : (remoteHistory ?? []).slice(-limit);
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
  return hasUniqueEntityKeys(value.rows) && hasUniqueEntityKeys(value.mergeMetadata);
}

function hasUniqueEntityKeys(rows: Array<{ entityType: string; entityId: string }>): boolean {
  const keys = new Set<string>();
  for (const row of rows) {
    const key = checkpointEntityKey(row.entityType, row.entityId);
    if (keys.has(key)) return false;
    keys.add(key);
  }
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
