import { performance } from 'node:perf_hooks';
import '../packages/client/node_modules/fake-indexeddb/auto/index.js';
import { computeCheckpointChecksum, SyncEngine } from '../packages/client/dist/index.js';

const positiveInt = (name, fallback) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  return Math.floor(value);
};

const ROWS = positiveInt('MAAYO_CHECKPOINT_ROWS', 3_000);
const SAMPLES = positiveInt('MAAYO_CHECKPOINT_SAMPLES', 7);
const BUDGET_MS = positiveInt('MAAYO_CHECKPOINT_BUDGET_MS', 10_000);
const NETWORK_DELAY_MS = positiveInt('MAAYO_CHECKPOINT_NETWORK_DELAY_MS', 1);

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true } });

function row(index) {
  const id = `student-${String(index).padStart(5, '0')}`;
  return {
    entityType: 'Student',
    entityId: id,
    payload: {
      id,
      name: `Student ${index}`,
      updatedAt: `2026-09-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
      enrollmentStatus: index % 3 === 0 ? 'WAITLIST' : 'ACTIVE',
      score: index,
    },
  };
}

async function envelope() {
  const unsigned = {
    protocolVersion: 1,
    schemaVersion: 'benchmark-v1',
    channel: 'org:benchmark',
    projectionKey: 'benchmark:authorized:v1',
    projectionRevision: 'benchmark-revision-v1',
    throughCursor: {
      lastMutationId: 'benchmark-through',
      lastReceivedAt: '2026-09-01T00:00:00.000Z',
    },
    rows: Array.from({ length: ROWS }, (_, index) => row(index)),
    mergeMetadata: Array.from({ length: ROWS }, (_, index) => ({
      entityType: 'Student',
      entityId: `student-${String(index).padStart(5, '0')}`,
      value: {
        policy: 'LWW',
        clientTs: `2026-09-01T00:${String(index % 60).padStart(2, '0')}:00.000Z`,
        deviceId: 'benchmark-device',
        mutationId: `mutation-${String(index).padStart(5, '0')}`,
      },
    })),
  };
  return {
    ...unsigned,
    integrity: {
      algorithm: 'sha-256',
      checksum: await computeCheckpointChecksum(unsigned),
      scope: 'rows-and-merge-metadata',
    },
  };
}

const delay = () => new Promise((resolve) => setTimeout(resolve, NETWORK_DELAY_MS));
const response = (body) => new Response(JSON.stringify(body), {
  status: 200,
  headers: { 'Content-Type': 'application/json' },
});

async function sample(index, checkpoint) {
  const dbName = `maayo-checkpoint-benchmark-${process.pid}-${index}`;
  const telemetry = [];
  globalThis.fetch = async (input) => {
    await delay();
    const url = new URL(String(input));
    if (url.pathname === '/sync/checkpoint') return response(checkpoint);
    if (url.pathname === '/sync/changes') {
      return response({
        channel: 'org:benchmark',
        mutations: [],
        cursor: checkpoint.throughCursor,
        hasMore: false,
      });
    }
    throw new Error(`unexpected benchmark URL: ${url}`);
  };

  const engine = new SyncEngine({
    baseUrl: 'http://benchmark.local',
    dbName,
    channels: ['org:benchmark'],
    tables: { Student: 'id, updatedAt' },
    authHeaders: () => ({ Authorization: 'Bearer benchmark' }),
    checkpoint: {
      projectionKey: 'benchmark:authorized:v1',
      expectedProjectionRevision: 'benchmark-revision-v1',
      supportedSchemaVersion: 'benchmark-v1',
      replaceEntityTypes: ['Student'],
      remoteHistoryLimit: 0,
      hardBudgetMs: BUDGET_MS,
    },
    onTelemetry: (event) => telemetry.push(event),
  });
  const started = performance.now();
  await engine.sync();
  const elapsedMs = performance.now() - started;
  if (engine.status !== 'idle') throw new Error(`expected idle, got ${engine.status}`);
  const count = await engine.db.table('Student').count();
  if (count !== ROWS) throw new Error(`expected ${ROWS} rows, got ${count}`);
  for (const phase of ['auth', 'checkpoint-transfer', 'checkpoint-decode', 'checkpoint-transaction', 'pull', 'idle']) {
    if (!telemetry.some((event) => event.phase === phase)) throw new Error(`missing telemetry phase ${phase}`);
  }
  const transfer = telemetry.find((event) => event.phase === 'checkpoint-transfer');
  if (!transfer?.bytes) throw new Error('checkpoint transfer did not report bytes');

  engine.stop();
  await engine.waitForIdle();
  engine.db.close();
  indexedDB.deleteDatabase(dbName);
  return elapsedMs;
}

const checkpoint = await envelope();
const samples = [];
for (let index = 0; index < SAMPLES; index += 1) samples.push(await sample(index, checkpoint));

samples.sort((a, b) => a - b);
const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
const payload = {
  rows: ROWS,
  samplesMs: samples.map((value) => Number(value.toFixed(2))),
  p95Ms: Number(p95.toFixed(2)),
  budgetMs: BUDGET_MS,
  networkDelayMs: NETWORK_DELAY_MS,
  measuredPath: 'auth + checkpoint transfer/decode/install + delta tail + terminal idle',
};
console.log(JSON.stringify(payload, null, 2));
if (p95 > BUDGET_MS) {
  throw new Error(`checkpoint clone p95 ${p95.toFixed(2)}ms exceeded ${BUDGET_MS}ms budget`);
}
