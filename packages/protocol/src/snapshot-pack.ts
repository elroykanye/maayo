import type { Cursor } from './changes';
import type { CheckpointMaterializedRow, CheckpointMergeMetadata } from './checkpoint';

export const SNAPSHOT_PACK_PROTOCOL_VERSION = 1 as const;

export interface SnapshotPackIdentity {
  tenantId: string;
  channel: string;
  projectionKey: string;
  projectionRevision: string;
  schemaVersion: string;
  throughCursor: Cursor;
}

export interface SnapshotPackChunk {
  digest: string;
  rows: CheckpointMaterializedRow[];
  mergeMetadata: CheckpointMergeMetadata[];
}

export interface SnapshotPackChunkReference {
  digest: string;
  byteLength: number;
  rowCount: number;
  metadataCount: number;
}

export interface SnapshotPackManifest {
  protocolVersion: typeof SNAPSHOT_PACK_PROTOCOL_VERSION;
  identity: SnapshotPackIdentity;
  cacheKey: string;
  generation: string;
  createdAt: string;
  expiresAt: string;
  chunks: SnapshotPackChunkReference[];
  integrity: { algorithm: 'sha-256'; manifestDigest: string };
  deliveryToken?: string;
}

export interface SnapshotPackPayload {
  rows: CheckpointMaterializedRow[];
  mergeMetadata: CheckpointMergeMetadata[];
}

export interface BuiltSnapshotPack {
  manifest: SnapshotPackManifest;
  chunks: SnapshotPackChunk[];
}

export interface SnapshotPackProviderContext<TRequest = unknown> {
  request: TRequest;
  tenantId: string;
  channel: string;
  projectionKey: string;
  ifNoneMatch?: string;
  /** Opaque short-lived token returned with the manifest and replayed for chunk delivery. */
  deliveryToken?: string;
}

export interface SnapshotPackProvider<TRequest = unknown> {
  getSnapshotPackManifest(context: SnapshotPackProviderContext<TRequest>): Promise<SnapshotPackManifest | null>;
  getSnapshotPackChunk(
    context: SnapshotPackProviderContext<TRequest>,
    digest: string,
  ): Promise<SnapshotPackChunk | null>;
}

export interface SnapshotPackSourceResult extends SnapshotPackPayload {
  schemaVersion: string;
  projectionRevision: string;
  throughCursor: Cursor;
}

export interface SnapshotPackSource<TContext> {
  readSnapshot(context: TContext): Promise<SnapshotPackSourceResult>;
}

export interface SnapshotPackStore {
  getManifest(cacheKey: string): Promise<SnapshotPackManifest | undefined>;
  getChunk(digest: string): Promise<SnapshotPackChunk | undefined>;
  put(pack: BuiltSnapshotPack): Promise<void>;
}

export class MemorySnapshotPackStore implements SnapshotPackStore {
  private readonly manifests = new Map<string, SnapshotPackManifest>();
  private readonly chunks = new Map<string, SnapshotPackChunk>();

  async getManifest(cacheKey: string): Promise<SnapshotPackManifest | undefined> {
    return this.manifests.get(cacheKey);
  }

  async getChunk(digest: string): Promise<SnapshotPackChunk | undefined> {
    return this.chunks.get(digest);
  }

  async put(pack: BuiltSnapshotPack): Promise<void> {
    this.manifests.set(pack.manifest.cacheKey, pack.manifest);
    for (const chunk of pack.chunks) this.chunks.set(chunk.digest, chunk);
  }
}

export class SnapshotPackService<TContext> {
  constructor(
    private readonly source: SnapshotPackSource<TContext>,
    private readonly store: SnapshotPackStore,
    private readonly options: BuildSnapshotPackOptions = {},
  ) {}

  async getOrCreate(
    context: TContext,
    identity: Omit<SnapshotPackIdentity, 'schemaVersion' | 'projectionRevision' | 'throughCursor'>,
  ): Promise<SnapshotPackManifest> {
    const snapshot = await this.source.readSnapshot(context);
    const completeIdentity: SnapshotPackIdentity = {
      ...identity,
      schemaVersion: snapshot.schemaVersion,
      projectionRevision: snapshot.projectionRevision,
      throughCursor: snapshot.throughCursor,
    };
    const cacheKey = snapshotPackCacheKey(completeIdentity);
    const cached = await this.store.getManifest(cacheKey);
    if (cached && Date.parse(cached.expiresAt) > Date.now()) return cached;
    const pack = await buildSnapshotPack(completeIdentity, snapshot, this.options);
    await this.store.put(pack);
    return pack.manifest;
  }

  getChunk(digest: string): Promise<SnapshotPackChunk | undefined> {
    return this.store.getChunk(digest);
  }
}

export interface BuildSnapshotPackOptions {
  maxRowsPerChunk?: number;
  createdAt?: string;
  expiresAt?: string;
  ttlMs?: number;
  sign?: (manifestDigest: string, identity: SnapshotPackIdentity, expiresAt: string) => string | Promise<string>;
}

export async function buildSnapshotPack(
  identity: SnapshotPackIdentity,
  payload: SnapshotPackPayload,
  options: BuildSnapshotPackOptions = {},
): Promise<BuiltSnapshotPack> {
  assertIdentity(identity);
  const maxRows = normalizeChunkSize(options.maxRowsPerChunk);
  const chunks: SnapshotPackChunk[] = [];
  const metadataByKey = new Map(payload.mergeMetadata.map((item) => [entityKey(item), item]));
  for (let offset = 0; offset < payload.rows.length; offset += maxRows) {
    const rows = payload.rows.slice(offset, offset + maxRows);
    const mergeMetadata = rows.flatMap((row) => {
      const item = metadataByKey.get(entityKey(row));
      if (!item) return [];
      metadataByKey.delete(entityKey(row));
      return [item];
    });
    chunks.push(await createChunk(rows, mergeMetadata));
  }
  const remainingMetadata = [...metadataByKey.values()];
  for (let offset = 0; offset < remainingMetadata.length; offset += maxRows) {
    chunks.push(await createChunk([], remainingMetadata.slice(offset, offset + maxRows)));
  }
  if (chunks.length === 0) chunks.push(await createChunk([], []));

  const createdAt = options.createdAt ?? new Date().toISOString();
  const expiresAt = options.expiresAt
    ?? new Date(Date.parse(createdAt) + (options.ttlMs ?? 5 * 60_000)).toISOString();
  if (!(Date.parse(expiresAt) > Date.parse(createdAt))) throw new Error('Snapshot pack expiry must follow creation');
  const refs = await Promise.all(chunks.map(async (chunk) => ({
    digest: chunk.digest,
    byteLength: encodedChunk(chunk).byteLength,
    rowCount: chunk.rows.length,
    metadataCount: chunk.mergeMetadata.length,
  })));
  const core = {
    protocolVersion: SNAPSHOT_PACK_PROTOCOL_VERSION,
    identity,
    cacheKey: snapshotPackCacheKey(identity),
    createdAt,
    expiresAt,
    chunks: refs,
  } as const;
  const manifestDigest = await sha256Hex(canonicalJson(core));
  const deliveryToken = options.sign
    ? await options.sign(manifestDigest, identity, expiresAt)
    : undefined;
  return {
    manifest: {
      ...core,
      generation: manifestDigest,
      integrity: { algorithm: 'sha-256', manifestDigest },
      ...(deliveryToken ? { deliveryToken } : {}),
    },
    chunks,
  };
}

export async function verifySnapshotPack(
  manifest: SnapshotPackManifest,
  chunks: readonly SnapshotPackChunk[],
  now = new Date(),
): Promise<void> {
  if (!isSnapshotPackManifest(manifest)) throw new Error('Invalid snapshot pack manifest');
  if (Date.parse(manifest.expiresAt) <= now.getTime()) throw new Error('Snapshot pack delivery expired');
  const core = {
    protocolVersion: manifest.protocolVersion,
    identity: manifest.identity,
    cacheKey: manifest.cacheKey,
    createdAt: manifest.createdAt,
    expiresAt: manifest.expiresAt,
    chunks: manifest.chunks,
  };
  const manifestDigest = await sha256Hex(canonicalJson(core));
  if (!constantTimeEqual(manifestDigest, manifest.integrity.manifestDigest)
    || manifest.generation !== manifestDigest) throw new Error('Snapshot pack manifest digest mismatch');
  if (chunks.length !== manifest.chunks.length) throw new Error('Snapshot pack is incomplete');
  const rowKeys = new Set<string>();
  const metadataKeys = new Set<string>();
  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index];
    const reference = manifest.chunks[index];
    const encoded = encodedChunk(chunk);
    const digest = await sha256HexBytes(encoded);
    if (chunk.digest !== reference.digest || !constantTimeEqual(digest, reference.digest)) {
      throw new Error(`Snapshot chunk digest mismatch at index ${index}`);
    }
    if (encoded.byteLength !== reference.byteLength
      || chunk.rows.length !== reference.rowCount
      || chunk.mergeMetadata.length !== reference.metadataCount) {
      throw new Error(`Snapshot chunk metadata mismatch at index ${index}`);
    }
    assertUniqueChunkEntities(chunk.rows, rowKeys, 'row');
    assertUniqueChunkEntities(chunk.mergeMetadata, metadataKeys, 'merge metadata');
  }
}

function assertUniqueChunkEntities(
  values: readonly { entityType: string; entityId: string }[],
  seen: Set<string>,
  kind: string,
): void {
  for (const value of values) {
    const key = entityKey(value);
    if (seen.has(key)) {
      throw new Error(`Duplicate snapshot ${kind}: ${value.entityType}/${value.entityId}`);
    }
    seen.add(key);
  }
}

export function snapshotPackCacheKey(identity: SnapshotPackIdentity): string {
  assertIdentity(identity);
  const cursor = identity.throughCursor;
  return [
    identity.tenantId,
    identity.channel,
    identity.projectionKey,
    identity.projectionRevision,
    identity.schemaVersion,
    cursor.lastReceivedAt ?? '',
    cursor.lastMutationId ?? '',
  ].map((part) => encodeURIComponent(part)).join('|');
}

export function isSnapshotPackManifest(value: unknown): value is SnapshotPackManifest {
  if (!isRecord(value) || value.protocolVersion !== SNAPSHOT_PACK_PROTOCOL_VERSION) return false;
  if (!isIdentity(value.identity) || value.cacheKey !== snapshotPackCacheKey(value.identity)) return false;
  if (!isNonEmpty(value.generation) || !isIso(value.createdAt) || !isIso(value.expiresAt)) return false;
  if (!Array.isArray(value.chunks) || !value.chunks.every(isChunkReference)) return false;
  return isRecord(value.integrity)
    && value.integrity.algorithm === 'sha-256'
    && value.integrity.manifestDigest === value.generation
    && /^[a-f0-9]{64}$/.test(value.generation);
}

async function createChunk(
  rows: CheckpointMaterializedRow[],
  mergeMetadata: CheckpointMergeMetadata[],
): Promise<SnapshotPackChunk> {
  const digest = await sha256Hex(canonicalJson({ rows, mergeMetadata }));
  return { digest, rows, mergeMetadata };
}

function encodedChunk(chunk: SnapshotPackChunk): Uint8Array {
  return new TextEncoder().encode(canonicalJson({ rows: chunk.rows, mergeMetadata: chunk.mergeMetadata }));
}

async function sha256Hex(value: string): Promise<string> {
  return sha256HexBytes(new TextEncoder().encode(value));
}

async function sha256HexBytes(value: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
}

function assertIdentity(identity: SnapshotPackIdentity): void {
  if (!isIdentity(identity)) throw new Error('Invalid snapshot pack identity');
}

function isIdentity(value: unknown): value is SnapshotPackIdentity {
  if (!isRecord(value)) return false;
  const cursor = value.throughCursor;
  return ['tenantId', 'channel', 'projectionKey', 'projectionRevision', 'schemaVersion']
    .every((key) => isNonEmpty(value[key]))
    && isRecord(cursor)
    && ((cursor.lastMutationId === null && cursor.lastReceivedAt === null)
      || (isNonEmpty(cursor.lastMutationId) && isIso(cursor.lastReceivedAt)));
}

function isChunkReference(value: unknown): value is SnapshotPackChunkReference {
  return isRecord(value) && typeof value.digest === 'string' && /^[a-f0-9]{64}$/.test(value.digest)
    && Number.isSafeInteger(value.byteLength) && Number(value.byteLength) >= 0
    && Number.isSafeInteger(value.rowCount) && Number(value.rowCount) >= 0
    && Number.isSafeInteger(value.metadataCount) && Number(value.metadataCount) >= 0;
}

function normalizeChunkSize(value: number | undefined): number {
  if (value === undefined) return 1_000;
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('maxRowsPerChunk must be a positive integer');
  return value;
}

function entityKey(value: { entityType: string; entityId: string }): string {
  return `${value.entityType}\u0000${value.entityId}`;
}

function constantTimeEqual(first: string, second: string): boolean {
  if (first.length !== second.length) return false;
  let mismatch = 0;
  for (let index = 0; index < first.length; index += 1) mismatch |= first.charCodeAt(index) ^ second.charCodeAt(index);
  return mismatch === 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isIso(value: unknown): value is string {
  return isNonEmpty(value) && !Number.isNaN(Date.parse(value));
}
