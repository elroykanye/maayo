import { performance } from 'node:perf_hooks';
import '../packages/client/node_modules/fake-indexeddb/auto/index.js';
import {
  computeCheckpointChecksum,
  installCheckpoint,
  openDatabase,
} from '../packages/client/dist/index.js';

const ROWS = 3_000;
const SAMPLES = 7;
const BUDGET_MS = 10_000;

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
      value: { winnerMutationId: `mutation-${String(index).padStart(5, '0')}` },
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

async function sample(index, checkpoint) {
  const dbName = `maayo-checkpoint-benchmark-${process.pid}-${index}`;
  const db = openDatabase(dbName, {
    Student: 'id, updatedAt',
    _syncmeta: 'key',
  });
  const started = performance.now();
  await installCheckpoint(db, checkpoint, {
    expectedChannel: 'org:benchmark',
    expectedProjectionKey: 'benchmark:authorized:v1',
    expectedProjectionRevision: 'benchmark-revision-v1',
    supportedSchemaVersion: 'benchmark-v1',
    replaceEntityTypes: ['Student'],
    metaTable: '_syncmeta',
    remoteHistoryLimit: 0,
  });
  const elapsedMs = performance.now() - started;
  const count = await db.table('Student').count();
  if (count !== ROWS) throw new Error(`expected ${ROWS} rows, got ${count}`);
  db.close();
  await indexedDB.deleteDatabase(dbName);
  return elapsedMs;
}

const checkpoint = await envelope();
const samples = [];
for (let index = 0; index < SAMPLES; index += 1) {
  samples.push(await sample(index, checkpoint));
}

samples.sort((a, b) => a - b);
const p95 = samples[Math.ceil(samples.length * 0.95) - 1];
const payload = {
  rows: ROWS,
  samplesMs: samples.map((value) => Number(value.toFixed(2))),
  p95Ms: Number(p95.toFixed(2)),
  budgetMs: BUDGET_MS,
};
console.log(JSON.stringify(payload, null, 2));
if (p95 > BUDGET_MS) {
  throw new Error(`checkpoint clone p95 ${p95.toFixed(2)}ms exceeded ${BUDGET_MS}ms budget`);
}
