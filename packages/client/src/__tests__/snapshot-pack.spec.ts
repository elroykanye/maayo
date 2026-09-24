import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { buildSnapshotPack } from '@maayo/protocol';
import { enqueue, installSnapshotPack, MemorySnapshotChunkCache, openDatabase } from '../index';

const clock = new Date('2026-09-24T00:30:00.000Z');

async function pack() {
  return buildSnapshotPack({
    tenantId: 'tenant-a', channel: 'org:1', projectionKey: 'teacher:42',
    projectionRevision: 'grants:7', schemaVersion: '3',
    throughCursor: { lastMutationId: 'm-9', lastReceivedAt: '2026-09-24T00:00:00.000Z' },
  }, {
    rows: Array.from({ length: 5 }, (_, index) => ({
      entityType: 'Student', entityId: `s-${index}`, payload: { id: `s-${index}`, value: index },
    })),
    mergeMetadata: [],
  }, {
    maxRowsPerChunk: 2,
    createdAt: '2026-09-24T00:00:00.000Z',
    expiresAt: '2026-09-24T01:00:00.000Z',
  });
}

describe('snapshot-pack activation', () => {
  it('fetches concurrently, caches chunks, and atomically activates without touching outbox', async () => {
    const db = openDatabase(`snapshot-pack-${Math.random()}`, { Student: 'id' });
    await db.table('Student').put({ id: 'old' });
    const pending = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'local', op: 'CREATE',
      payload: { id: 'local' }, authorIdentityId: 'u-1',
    });
    const built = await pack();
    let inFlight = 0;
    let peak = 0;
    const fetchChunk = vi.fn(async (_reference, index: number) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await Promise.resolve();
      inFlight -= 1;
      return built.chunks[index];
    });
    const cache = new MemorySnapshotChunkCache();

    await installSnapshotPack(db, built.manifest, fetchChunk, {
      expectedChannel: 'org:1', expectedProjectionKey: 'teacher:42',
      expectedProjectionRevision: 'grants:7', supportedSchemaVersion: '3',
      replaceEntityTypes: ['Student'], concurrency: 3, cache, now: clock,
    });

    expect(peak).toBeGreaterThan(1);
    expect(await db.table('Student').count()).toBe(5);
    expect(await db._outbox.get(pending.id)).toBeDefined();
    expect(await db._cursors.get('org:1')).toMatchObject({ lastMutationId: 'm-9' });
  });

  it('keeps the previous generation when integrity verification fails', async () => {
    const db = openDatabase(`snapshot-pack-failure-${Math.random()}`, { Student: 'id' });
    await db.table('Student').put({ id: 'old', value: 'safe' });
    const built = await pack();
    built.chunks[0].rows[0].payload.value = 999;

    await expect(installSnapshotPack(db, built.manifest, async (_reference, index) => built.chunks[index], {
      expectedChannel: 'org:1', expectedProjectionKey: 'teacher:42',
      expectedProjectionRevision: 'grants:7', supportedSchemaVersion: '3',
      replaceEntityTypes: ['Student'], now: clock,
    })).rejects.toThrow(/digest/i);
    expect(await db.table('Student').toArray()).toEqual([{ id: 'old', value: 'safe' }]);
    expect(await db._cursors.get('org:1')).toBeUndefined();
  });
});
