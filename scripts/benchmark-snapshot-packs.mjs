import { performance } from 'node:perf_hooks';
import { brotliCompressSync, constants, gzipSync, zstdCompressSync } from 'node:zlib';
import '../packages/client/node_modules/fake-indexeddb/auto/index.js';
import { buildSnapshotPack } from '../packages/protocol/dist/index.js';
import {
  installSnapshotPack,
  MemorySnapshotChunkCache,
  openDatabase,
} from '../packages/client/dist/index.js';

const sizes = (process.env.MAAYO_SNAPSHOT_SIZES ?? '2500,25000,250000,1000000')
  .split(',').map(Number).filter((value) => Number.isSafeInteger(value) && value > 0);
const sampleCount = Number(process.env.MAAYO_SNAPSHOT_SAMPLES ?? 5);
const networkDelayMs = Number(process.env.MAAYO_SNAPSHOT_NETWORK_DELAY_MS ?? 1);
const chunkRows = Number(process.env.MAAYO_SNAPSHOT_CHUNK_ROWS ?? 2_500);
if (sizes.length === 0 || !Number.isSafeInteger(sampleCount) || sampleCount < 1
  || !Number.isSafeInteger(chunkRows) || chunkRows < 1) {
  throw new Error('Invalid snapshot benchmark configuration');
}

const percentile = (values, ratio) => values[Math.max(0, Math.ceil(values.length * ratio) - 1)];
const delay = () => new Promise((resolve) => setTimeout(resolve, networkDelayMs));
const row = (index) => ({
  entityType: 'Student', entityId: `student-${index}`,
  payload: { id: `student-${index}`, name: `Student ${index}`, score: index },
});

const reports = [];
for (const rows of sizes) {
  const pack = await buildSnapshotPack({
    tenantId: 'benchmark-tenant', channel: 'org:benchmark', projectionKey: 'benchmark:user',
    projectionRevision: 'grants:1', schemaVersion: 'benchmark-v1',
    throughCursor: { lastMutationId: 'benchmark-through', lastReceivedAt: '2026-09-24T00:00:00.000Z' },
  }, {
    rows: Array.from({ length: rows }, (_, index) => row(index)), mergeMetadata: [],
  // The five-sample 1M-row tier can take longer than one hour under
  // fake-indexeddb. Keep delivery expiry outside the measured workload; expiry
  // behavior is covered by focused protocol tests.
  }, { maxRowsPerChunk: chunkRows, ttlMs: 24 * 60 * 60_000 });
  const payloadBytes = Buffer.byteLength(JSON.stringify(pack));
  const wireObjects = [pack.manifest, ...pack.chunks].map((value) => Buffer.from(JSON.stringify(value)));
  const compression = compressionReport(wireObjects, payloadBytes);
  const samples = [];
  const phaseSamples = new Map();
  let correctness = true;
  let integrity = true;
  let outboxPreserved = true;
  const cache = new MemorySnapshotChunkCache();
  for (let sample = 0; sample < sampleCount; sample += 1) {
    const dbName = `maayo-pack-benchmark-${process.pid}-${rows}-${sample}`;
    const db = openDatabase(dbName, { Student: 'id' });
    await db._outbox.put({
      id: `pending-${sample}`, channel: 'org:benchmark', entityType: 'Student', entityId: 'local',
      op: 'CREATE', payload: '{}', authorIdentityId: 'benchmark', deviceId: 'benchmark',
      clientTs: new Date().toISOString(), parentIds: [], status: 'pending',
    });
    const started = performance.now();
    try {
      await installSnapshotPack(db, pack.manifest, async (_reference, index) => {
        await delay();
        return pack.chunks[index];
      }, {
        expectedChannel: 'org:benchmark', expectedProjectionKey: 'benchmark:user',
        expectedProjectionRevision: 'grants:1', supportedSchemaVersion: 'benchmark-v1',
        replaceEntityTypes: ['Student'], concurrency: 4, cache,
        onPhase: ({ phase, durationMs }) => {
          const values = phaseSamples.get(phase) ?? [];
          values.push(durationMs);
          phaseSamples.set(phase, values);
        },
      });
    } catch (error) {
      integrity = false;
      throw error;
    }
    samples.push(performance.now() - started);
    correctness &&= await db.table('Student').count() === rows;
    outboxPreserved &&= await db._outbox.count() === 1;
    db.close();
    indexedDB.deleteDatabase(dbName);
  }
  samples.sort((a, b) => a - b);
  const phasesMs = Object.fromEntries([...phaseSamples].map(([phase, values]) => {
    values.sort((a, b) => a - b);
    return [phase, {
      samples: values.map((value) => Number(value.toFixed(2))),
      p50: Number(percentile(values, 0.50).toFixed(2)),
      p95: Number(percentile(values, 0.95).toFixed(2)),
    }];
  }));
  const report = {
    rows,
    samplesMs: samples.map((value) => Number(value.toFixed(2))),
    p50Ms: Number(percentile(samples, 0.50).toFixed(2)),
    p95Ms: Number(percentile(samples, 0.95).toFixed(2)),
    p99Ms: Number(percentile(samples, 0.99).toFixed(2)),
    payloadBytes,
    compression,
    chunks: pack.chunks.length,
    chunkRows,
    device: `${process.platform}/${process.arch}`,
    browser: `Node ${process.version} + fake-indexeddb`,
    storage: 'IndexedDB-compatible Dexie transaction',
    network: { simulatedDelayPerChunkMs: networkDelayMs, concurrency: 4 },
    phasesMs,
    correctness,
    isolation: 'tenant/projection-bound manifest validated by focused adapter tests',
    integrity,
    outboxPreserved,
  };
  reports.push(report);
  console.error(`[snapshot-benchmark] completed ${rows} rows: ${JSON.stringify(report)}`);
}

function compressionReport(wireObjects, originalBytes) {
  const total = (compress) => wireObjects.reduce((sum, value) => sum + compress(value).byteLength, 0);
  const result = {
    gzip: total((value) => gzipSync(value, { level: 6 })),
    brotli: total((value) => brotliCompressSync(value, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 5 },
    })),
    zstd: total((value) => zstdCompressSync(value, {
      params: { [constants.ZSTD_c_compressionLevel]: 3 },
    })),
  };
  return Object.fromEntries(Object.entries(result).map(([encoding, bytes]) => [encoding, {
    bytes,
    ratio: Number((bytes / originalBytes).toFixed(4)),
    reductionPercent: Number(((1 - bytes / originalBytes) * 100).toFixed(2)),
  }]));
}
console.log(JSON.stringify({ generatedAt: new Date().toISOString(), reports }, null, 2));
if (reports.some((report) => !report.correctness || !report.integrity || !report.outboxPreserved)) {
  throw new Error('Snapshot benchmark correctness gate failed');
}
