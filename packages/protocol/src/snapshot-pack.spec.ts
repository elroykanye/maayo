import { describe, expect, it } from 'vitest';
import {
  buildSnapshotPack,
  isSnapshotPackManifest,
  snapshotPackCacheKey,
  verifySnapshotPack,
  type SnapshotPackIdentity,
} from './index';

const identity: SnapshotPackIdentity = {
  tenantId: 'tenant-a',
  channel: 'org:1',
  projectionKey: 'teacher:42',
  projectionRevision: 'grants:7',
  schemaVersion: '3',
  throughCursor: { lastMutationId: 'm-9', lastReceivedAt: '2026-09-24T00:00:00.000Z' },
};

describe('snapshot packs', () => {
  it('builds immutable content-addressed chunks and verifies the complete manifest', async () => {
    const pack = await buildSnapshotPack(identity, {
      rows: Array.from({ length: 5 }, (_, index) => ({
        entityType: 'Student', entityId: `s-${index}`, payload: { id: `s-${index}` },
      })),
      mergeMetadata: [],
    }, {
      maxRowsPerChunk: 2,
      createdAt: '2026-09-24T00:00:00.000Z',
      expiresAt: '2026-09-24T01:00:00.000Z',
    });

    expect(pack.chunks).toHaveLength(3);
    expect(new Set(pack.chunks.map((chunk) => chunk.digest)).size).toBe(3);
    expect(isSnapshotPackManifest(pack.manifest)).toBe(true);
    await expect(verifySnapshotPack(pack.manifest, pack.chunks, new Date('2026-09-24T00:30:00.000Z')))
      .resolves.toBeUndefined();
  });

  it('binds cache identity to tenant and authorized projection', () => {
    expect(snapshotPackCacheKey(identity)).not.toBe(snapshotPackCacheKey({
      ...identity, tenantId: 'tenant-b',
    }));
    expect(snapshotPackCacheKey(identity)).not.toBe(snapshotPackCacheKey({
      ...identity, projectionKey: 'admin:42',
    }));
  });

  it('rejects a modified chunk before activation', async () => {
    const pack = await buildSnapshotPack(identity, {
      rows: [{ entityType: 'Student', entityId: 's-1', payload: { id: 's-1' } }],
      mergeMetadata: [],
    }, { createdAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-09-24T01:00:00.000Z' });
    pack.chunks[0].rows[0].payload.id = 'tampered';
    await expect(verifySnapshotPack(pack.manifest, pack.chunks, new Date('2026-09-24T00:30:00.000Z')))
      .rejects.toThrow(/digest/i);
  });

  it('rejects duplicate entity ownership across independently valid chunks', async () => {
    const pack = await buildSnapshotPack(identity, {
      rows: [
        { entityType: 'Student', entityId: 's-1', payload: { id: 's-1', version: 1 } },
        { entityType: 'Student', entityId: 's-1', payload: { id: 's-1', version: 2 } },
      ],
      mergeMetadata: [],
    }, {
      maxRowsPerChunk: 1,
      createdAt: '2026-09-24T00:00:00.000Z',
      expiresAt: '2026-09-24T01:00:00.000Z',
    });

    await expect(verifySnapshotPack(pack.manifest, pack.chunks, new Date('2026-09-24T00:30:00.000Z')))
      .rejects.toThrow(/duplicate.*Student.*s-1/i);
  });
});
