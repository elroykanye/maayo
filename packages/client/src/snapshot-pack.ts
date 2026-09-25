import {
  verifySnapshotPack,
  type SnapshotPackChunk,
  type SnapshotPackChunkReference,
  type SnapshotPackManifest,
} from '@maayo/protocol';
import type { MaayoDatabase } from './database';
import {
  CHECKPOINT_PROTOCOL_VERSION,
  installVerifiedCheckpointChunks,
  type CheckpointInstallOptions,
} from './checkpoint';

export interface SnapshotChunkCache {
  get(digest: string): Promise<SnapshotPackChunk | undefined>;
  put(chunk: SnapshotPackChunk): Promise<void>;
}

export class MemorySnapshotChunkCache implements SnapshotChunkCache {
  private readonly chunks = new Map<string, SnapshotPackChunk>();
  async get(digest: string): Promise<SnapshotPackChunk | undefined> { return this.chunks.get(digest); }
  async put(chunk: SnapshotPackChunk): Promise<void> { this.chunks.set(chunk.digest, chunk); }
}

export interface SnapshotPackInstallOptions extends CheckpointInstallOptions {
  concurrency?: number;
  cache?: SnapshotChunkCache;
  now?: Date;
  /** Post-commit timing observer. Observer failures never affect activation. */
  onPhase?: (event: SnapshotPackInstallPhaseEvent) => void;
}

export type SnapshotPackInstallPhase =
  | 'acquire' | 'verify' | 'plan' | 'delete' | 'write' | 'metadata' | 'history' | 'cursor' | 'commit';
export interface SnapshotPackInstallPhaseEvent {
  phase: SnapshotPackInstallPhase;
  durationMs: number;
  chunks: number;
  rows: number;
}

export type SnapshotChunkFetcher = (
  reference: SnapshotPackChunkReference,
  index: number,
  signal?: AbortSignal,
) => Promise<SnapshotPackChunk>;

export interface SnapshotPackHttpOptions extends SnapshotPackInstallOptions {
  baseUrl: string;
  tenantId: string;
  headers?: Record<string, string> | (() => Record<string, string> | Promise<Record<string, string>>);
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}

/** Download a projection-bound manifest and its missing chunks, then atomically activate it. */
export async function installSnapshotPackFromHttp(
  db: MaayoDatabase,
  options: SnapshotPackHttpOptions,
): Promise<SnapshotPackManifest> {
  const fetcher = options.fetch ?? globalThis.fetch;
  const headers = typeof options.headers === 'function' ? await options.headers() : (options.headers ?? {});
  const manifestUrl = new URL(`${options.baseUrl.replace(/\/$/, '')}/sync/snapshot-packs/manifest`);
  manifestUrl.searchParams.set('channel', options.expectedChannel);
  const manifestResponse = await fetcher(manifestUrl, { headers, signal: options.signal });
  if (!manifestResponse.ok) throw new Error(`Snapshot manifest request failed: ${manifestResponse.status}`);
  const manifest = await manifestResponse.json() as SnapshotPackManifest;
  if (manifest.identity.tenantId !== options.tenantId) throw new Error('Snapshot pack tenant mismatch');
  await installSnapshotPack(db, manifest, async (reference, _index, signal) => {
    const chunkUrl = new URL(`${options.baseUrl.replace(/\/$/, '')}/sync/snapshot-packs/chunks/${reference.digest}`);
    chunkUrl.searchParams.set('channel', options.expectedChannel);
    if (!manifest.deliveryToken) throw new Error('Snapshot pack manifest has no delivery token');
    chunkUrl.searchParams.set('token', manifest.deliveryToken);
    const response = await fetcher(chunkUrl, { headers, signal });
    if (!response.ok) throw new Error(`Snapshot chunk request failed: ${response.status}`);
    return response.json() as Promise<SnapshotPackChunk>;
  }, options, options.signal);
  return manifest;
}

export async function installSnapshotPack(
  db: MaayoDatabase,
  manifest: SnapshotPackManifest,
  fetchChunk: SnapshotChunkFetcher,
  options: SnapshotPackInstallOptions,
  signal?: AbortSignal,
): Promise<void> {
  assertExpectedIdentity(manifest, options);
  const events: SnapshotPackInstallPhaseEvent[] = [];
  let started = nowMs();
  const chunks = await acquireChunks(
    manifest.chunks,
    fetchChunk,
    options.cache,
    normalizeConcurrency(options.concurrency),
    signal,
  );
  events.push(phaseEvent('acquire', nowMs() - started, chunks));
  signal?.throwIfAborted();
  started = nowMs();
  await verifySnapshotPack(manifest, chunks, options.now);
  events.push(phaseEvent('verify', nowMs() - started, chunks));
  signal?.throwIfAborted();
  const activationMetrics = await installVerifiedCheckpointChunks(db, {
    protocolVersion: CHECKPOINT_PROTOCOL_VERSION,
    schemaVersion: manifest.identity.schemaVersion,
    channel: manifest.identity.channel,
    projectionKey: manifest.identity.projectionKey,
    projectionRevision: manifest.identity.projectionRevision,
    throughCursor: manifest.identity.throughCursor,
  }, chunks, options);
  for (const metric of activationMetrics) {
    events.push(phaseEvent(metric.phase, metric.durationMs, chunks));
  }
  if (options.onPhase) {
    for (const event of events) {
      try { options.onPhase(event); } catch { /* telemetry cannot change committed state */ }
    }
  }
}

function phaseEvent(
  phase: SnapshotPackInstallPhase,
  durationMs: number,
  chunks: readonly SnapshotPackChunk[],
): SnapshotPackInstallPhaseEvent {
  return {
    phase,
    durationMs,
    chunks: chunks.length,
    rows: chunks.reduce((total, chunk) => total + chunk.rows.length, 0),
  };
}

function nowMs(): number {
  return globalThis.performance?.now() ?? Date.now();
}

async function acquireChunks(
  references: readonly SnapshotPackChunkReference[],
  fetchChunk: SnapshotChunkFetcher,
  cache: SnapshotChunkCache | undefined,
  concurrency: number,
  signal?: AbortSignal,
): Promise<SnapshotPackChunk[]> {
  const result = new Array<SnapshotPackChunk>(references.length);
  let nextIndex = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= references.length) return;
      signal?.throwIfAborted();
      const reference = references[index];
      const cached = await cache?.get(reference.digest);
      const chunk = cached ?? await fetchChunk(reference, index, signal);
      result[index] = chunk;
      if (!cached) await cache?.put(chunk);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, references.length) }, worker));
  return result;
}

function assertExpectedIdentity(manifest: SnapshotPackManifest, options: SnapshotPackInstallOptions): void {
  if (manifest.identity.channel !== options.expectedChannel) throw new Error('Snapshot pack channel mismatch');
  if (manifest.identity.projectionKey !== options.expectedProjectionKey) {
    throw new Error('Snapshot pack projection key mismatch');
  }
  if (options.expectedProjectionRevision !== undefined
    && manifest.identity.projectionRevision !== options.expectedProjectionRevision) {
    throw new Error('Snapshot pack projection revision mismatch');
  }
  if (manifest.identity.schemaVersion !== options.supportedSchemaVersion) {
    throw new Error('Unsupported snapshot pack schema version');
  }
}

function normalizeConcurrency(value: number | undefined): number {
  if (value === undefined) return 4;
  if (!Number.isSafeInteger(value) || value < 1 || value > 32) {
    throw new Error('Snapshot pack concurrency must be an integer from 1 to 32');
  }
  return value;
}
