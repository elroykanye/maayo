import { beforeEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Mutation } from '@maayo/protocol';
import { openDatabase, type MaayoDatabase } from '../database';
import {
  applyMutationPage,
  computeCheckpointChecksum,
  installCheckpoint,
  type CheckpointEnvelope,
} from '../index';
import { enqueue } from '../outbox';
import { policyApply } from '../policies';

let db: MaayoDatabase;

function mutation(partial: Partial<Mutation> = {}): Mutation {
  return {
    id: partial.id ?? 'm-1',
    channel: partial.channel ?? 'org:1',
    entityType: partial.entityType ?? 'Student',
    entityId: partial.entityId ?? 's-1',
    op: partial.op ?? 'CREATE',
    payload: partial.payload ?? JSON.stringify({ name: 'Ada', updatedAt: '2026-09-01T00:00:00.000Z' }),
    authorIdentityId: partial.authorIdentityId ?? 'u-1',
    deviceId: partial.deviceId ?? 'd-1',
    clientTs: partial.clientTs ?? '2026-09-01T00:00:00.000Z',
    parentIds: partial.parentIds ?? [],
  };
}

async function checkpoint(
  overrides: Record<string, unknown> = {},
): Promise<CheckpointEnvelope> {
  const unsigned = {
    channel: 'org:1',
    projectionKey: 'role:teacher:v3',
    projectionRevision: 'grants:v1',
    protocolVersion: 1 as const,
    schemaVersion: '1',
    throughCursor: {
      lastMutationId: 'm-checkpoint',
      lastReceivedAt: '2026-09-01T00:00:00.000Z',
    },
    rows: [
      { entityType: 'Student', entityId: 's-1', payload: { id: 's-1', name: 'Checkpoint Ada' } },
    ],
    mergeMetadata: [
      { entityType: 'Student', entityId: 's-1', value: { lastWrite: 'm-checkpoint' } },
    ],
    remoteHistory: [],
    ...overrides,
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

beforeEach(() => {
  db = openDatabase(`test-checkpoint-${Math.random()}`, {
    Student: 'id, name',
    Enrollment: 'id',
    _syncmeta: 'key',
  });
});

describe('public bulk mutation-page apply', () => {
  it('folds a page by entity and commits rows, metadata, bounded history, and cursor together', async () => {
    const table = db.table('Enrollment');
    const bulkPut = vi.spyOn(table, 'bulkPut');
    const put = vi.spyOn(table, 'put');
    const page = [
      mutation({ id: 'add-1', entityType: 'Enrollment', entityId: 'e-1', op: 'CREATE', payload: '{"status":"ACTIVE"}' }),
      mutation({ id: 'remove-1', entityType: 'Enrollment', entityId: 'e-1', op: 'DELETE', clientTs: '2026-09-01T00:00:01.000Z', parentIds: ['add-1'] }),
      mutation({ id: 'add-2', entityType: 'Enrollment', entityId: 'e-1', op: 'CREATE', clientTs: '2026-09-01T00:00:02.000Z', payload: '{"status":"ACTIVE"}' }),
    ];

    const result = await applyMutationPage(db, {
      channel: 'org:1',
      mutations: page,
      cursor: { lastMutationId: 'add-2', lastReceivedAt: '2026-09-01T00:00:02.000Z' },
    }, {
      applyMutation: policyApply({ policyFor: () => 'OR_SET' }),
      remoteHistoryLimit: 2,
    });

    expect(result).toEqual({ applied: 3, skipped: 0 });
    expect((await table.get('e-1')).deletedAt).toBeNull();
    expect(await db.table('_syncmeta').get('Enrollment:e-1')).toBeDefined();
    expect((await db._history.toArray())
      .filter((row) => row.source === 'remote')
      .sort((a, b) => a.clientTs.localeCompare(b.clientTs))
      .map((row) => row.id)).toEqual(['remove-1', 'add-2']);
    expect(await db._cursors.get('org:1')).toMatchObject({ lastMutationId: 'add-2' });
    expect(bulkPut).toHaveBeenCalledTimes(1);
    expect(put).not.toHaveBeenCalled();
  });

  it('rolls back row and cursor when the atomic page transaction fails', async () => {
    await db.table('Student').put({ id: 's-1', name: 'Before' });
    vi.spyOn(db._history, 'bulkPut').mockRejectedValueOnce(new Error('disk full'));

    await expect(applyMutationPage(db, {
      channel: 'org:1',
      mutations: [mutation()],
      cursor: { lastMutationId: 'm-1', lastReceivedAt: '2026-09-01T00:00:00.000Z' },
    })).rejects.toThrow('disk full');

    expect(await db.table('Student').get('s-1')).toEqual({ id: 's-1', name: 'Before' });
    expect(await db._cursors.get('org:1')).toBeUndefined();
  });

  it('keeps the deterministic equal-time LWW winner after bounded history eviction', async () => {
    const cursor = (id: string) => ({ lastMutationId: id, lastReceivedAt: '2026-09-01T00:00:00.000Z' });
    await applyMutationPage(db, {
      channel: 'org:1',
      mutations: [mutation({ id: 'winner-z', entityId: 'target', deviceId: 'z-device' })],
      cursor: cursor('winner-z'),
    }, { remoteHistoryLimit: 1 });
    await applyMutationPage(db, {
      channel: 'org:1',
      mutations: [mutation({ id: 'other', entityId: 'other', deviceId: 'x-device', clientTs: '2026-09-01T00:00:01.000Z' })],
      cursor: cursor('other'),
    }, { remoteHistoryLimit: 1 });
    await applyMutationPage(db, {
      channel: 'org:1',
      mutations: [mutation({
        id: 'loser-a', entityId: 'target', deviceId: 'a-device',
        payload: JSON.stringify({ name: 'Loser', updatedAt: '2026-09-01T00:00:00.000Z' }),
      })],
      cursor: cursor('loser-a'),
    }, { remoteHistoryLimit: 1 });

    expect(await db.table('Student').get('target')).toMatchObject({ name: 'Ada' });
  });

  it('does not let a stale hard delete remove a newer LWW row', async () => {
    await db.table('Student').put({ id: 's-1', name: 'Newer', updatedAt: '2026-09-02T00:00:00.000Z' });
    const result = await applyMutationPage(db, {
      channel: 'org:1',
      mutations: [mutation({ id: 'stale-delete', op: 'DELETE', clientTs: '2026-09-01T00:00:00.000Z' })],
      cursor: { lastMutationId: 'stale-delete', lastReceivedAt: '2026-09-03T00:00:00.000Z' },
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(await db.table('Student').get('s-1')).toMatchObject({ name: 'Newer' });
  });

  it('keeps the same gated LWW semantics when a custom hook delegates to defaultApply', async () => {
    await db.table('Student').put({ id: 's-1', name: 'Newer', updatedAt: '2026-09-02T00:00:00.000Z' });
    const result = await applyMutationPage(db, {
      channel: 'org:1',
      mutations: [mutation({ id: 'stale-delete', op: 'DELETE', clientTs: '2026-09-01T00:00:00.000Z' })],
      cursor: { lastMutationId: 'stale-delete', lastReceivedAt: '2026-09-03T00:00:00.000Z' },
    }, {
      applyMutation: (_database, _mutation, defaultApply) => defaultApply(),
    });

    expect(result).toEqual({ applied: 0, skipped: 1 });
    expect(await db.table('Student').get('s-1')).toMatchObject({ name: 'Newer' });
  });
});

describe('checkpoint install', () => {
  it('atomically replaces materialized state while preserving pending and quarantined outbox rows', async () => {
    await db.table('Student').put({ id: 'stale', name: 'Stale' });
    const pending = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'local-1', op: 'CREATE',
      payload: { id: 'local-1', name: 'Local' }, authorIdentityId: 'u-1',
    });
    await db._outbox.update(pending.id, { rejectedAt: '2026-09-01T00:00:00.000Z', rejectCode: 'FORBIDDEN' });

    await installCheckpoint(db, await checkpoint(), {
      expectedChannel: 'org:1',
      expectedProjectionKey: 'role:teacher:v3',
      supportedProtocolVersion: 1 as const,
      supportedSchemaVersion: '1',
      replaceEntityTypes: ['Student'],
      metaTable: '_syncmeta',
      remoteHistoryLimit: 10,
    });

    expect(await db.table('Student').toArray()).toEqual([{ id: 's-1', name: 'Checkpoint Ada' }]);
    expect(await db._outbox.get(pending.id)).toMatchObject({ id: pending.id, rejectCode: 'FORBIDDEN' });
    expect(await db._cursors.get('org:1')).toMatchObject({ lastMutationId: 'm-checkpoint' });
  });

  it('preserves rows owned by another checkpoint channel', async () => {
    for (const [channel, id] of [['org:1', 'one'], ['org:2', 'two']] as const) {
      const envelope = await checkpoint({
        channel,
        projectionKey: `projection:${channel}`,
        rows: [{ entityType: 'Student', entityId: id, payload: { id, channel } }],
        mergeMetadata: [],
        remoteHistory: [mutation({ id: `history-${id}`, channel, entityId: id })],
      });
      await installCheckpoint(db, envelope, {
        expectedChannel: channel,
        expectedProjectionKey: `projection:${channel}`,
        supportedSchemaVersion: '1',
        replaceEntityTypes: ['Student'],
      });
    }

    expect((await db.table('Student').toArray()).map((row) => row.id).sort()).toEqual(['one', 'two']);
    expect((await db._history.toArray()).filter((row) => row.source === 'remote').map((row) => row.id).sort())
      .toEqual(['history-one', 'history-two']);

    const replacement = await checkpoint({
      channel: 'org:1', projectionKey: 'projection:org:1',
      rows: [{ entityType: 'Student', entityId: 'one-new', payload: { id: 'one-new', channel: 'org:1' } }],
      mergeMetadata: [],
    });
    await installCheckpoint(db, replacement, {
      expectedChannel: 'org:1', expectedProjectionKey: 'projection:org:1',
      supportedSchemaVersion: '1', replaceEntityTypes: ['Student'],
    });
    expect((await db.table('Student').toArray()).map((row) => row.id).sort()).toEqual(['one-new', 'two']);

    const collision = await checkpoint({
      channel: 'org:1', projectionKey: 'projection:org:1',
      rows: [{ entityType: 'Student', entityId: 'two', payload: { id: 'two', channel: 'org:1' } }],
      mergeMetadata: [],
    });
    await expect(installCheckpoint(db, collision, {
      expectedChannel: 'org:1', expectedProjectionKey: 'projection:org:1',
      supportedSchemaVersion: '1', replaceEntityTypes: ['Student'],
    })).rejects.toThrow(/owned by channel org:2/);
    expect(await db.table('Student').get('two')).toMatchObject({ channel: 'org:2' });
  });

  it('restores the previous replica and cursor after a checkpoint write fails and the database reopens', async () => {
    const dbName = db.name;
    await db.table('Student').put({ id: 'before', name: 'Before' });
    await db._cursors.put({
      channel: 'org:1', lastMutationId: 'before-cursor', lastReceivedAt: '2026-08-01T00:00:00.000Z',
    });
    const cursorWrite = vi.spyOn(db._cursors, 'put').mockRejectedValueOnce(new Error('disk full'));

    await expect(installCheckpoint(db, await checkpoint(), {
      expectedChannel: 'org:1', expectedProjectionKey: 'role:teacher:v3',
      supportedSchemaVersion: '1', replaceEntityTypes: ['Student'], metaTable: '_syncmeta',
    })).rejects.toThrow('disk full');
    cursorWrite.mockRestore();
    db.close({ disableAutoOpen: true });
    db = openDatabase(dbName, { Student: 'id, name', Enrollment: 'id', _syncmeta: 'key' });

    expect(await db.table('Student').toArray()).toEqual([{ id: 'before', name: 'Before' }]);
    expect(await db._cursors.get('org:1')).toMatchObject({ lastMutationId: 'before-cursor' });
  });

  it('installs checkpoint LWW winner metadata independently of retained audit history', async () => {
    const envelope = await checkpoint({
      rows: [{
        entityType: 'Student', entityId: 's-1',
        payload: { id: 's-1', name: 'Winner', updatedAt: '2026-09-01T00:00:00.000Z' },
      }],
      mergeMetadata: [{
        entityType: 'Student', entityId: 's-1',
        value: { policy: 'LWW', clientTs: '2026-09-01T00:00:00.000Z', deviceId: 'z-device', mutationId: 'winner-z' },
      }],
    });
    await installCheckpoint(db, envelope, {
      expectedChannel: 'org:1', expectedProjectionKey: 'role:teacher:v3',
      supportedSchemaVersion: '1', replaceEntityTypes: ['Student'], remoteHistoryLimit: 0,
    });
    await applyMutationPage(db, {
      channel: 'org:1',
      mutations: [mutation({
        id: 'loser-a', entityId: 's-1', deviceId: 'a-device',
        payload: JSON.stringify({ name: 'Loser', updatedAt: '2026-09-01T00:00:00.000Z' }),
      })],
      cursor: { lastMutationId: 'loser-a', lastReceivedAt: '2026-09-01T00:00:01.000Z' },
    }, { remoteHistoryLimit: 0 });

    expect(await db.table('Student').get('s-1')).toMatchObject({ name: 'Winner' });
  });

  it.each([
    ['channel', { channel: 'org:other' }],
    ['projection', { projectionKey: 'role:admin:v1' }],
    ['protocol version', { protocolVersion: 2 }],
    ['schema version', { schemaVersion: '2' }],
  ])('rejects a checkpoint with the wrong %s before writing', async (_label, overrides) => {
    await db.table('Student').put({ id: 'before', name: 'Before' });
    await expect(installCheckpoint(db, await checkpoint(overrides), {
      expectedChannel: 'org:1', expectedProjectionKey: 'role:teacher:v3',
      supportedProtocolVersion: 1 as const, supportedSchemaVersion: '1',
      replaceEntityTypes: ['Student'], metaTable: '_syncmeta',
    })).rejects.toThrow();
    expect(await db.table('Student').toArray()).toEqual([{ id: 'before', name: 'Before' }]);
  });

  it('rejects a corrupt checksum before writing', async () => {
    const envelope = await checkpoint();
    envelope.rows[0].payload.name = 'tampered';
    await expect(installCheckpoint(db, envelope, {
      expectedChannel: 'org:1', expectedProjectionKey: 'role:teacher:v3',
      supportedProtocolVersion: 1 as const, supportedSchemaVersion: '1',
      replaceEntityTypes: ['Student'], metaTable: '_syncmeta',
    })).rejects.toThrow(/checksum/i);
    expect(await db.table('Student').count()).toBe(0);
  });
});
