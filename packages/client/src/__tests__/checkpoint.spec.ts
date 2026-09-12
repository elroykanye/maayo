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
