import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import {
  CHECKPOINT_PROTOCOL_VERSION,
  CHECKPOINT_REQUIRED,
  buildSnapshotPack,
  type CheckpointEnvelope,
} from '@maayo/protocol';
import type { CheckpointProvider, MaayoStore, SnapshotPackProvider } from './interfaces';
import { MaayoModule } from './maayo.module';
import type { MaayoModuleOptions } from './maayo.options';

const applications: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

describe('MaayoModule checkpoint capability', () => {
  it('keeps replay-only modules working without exposing a checkpoint', async () => {
    const baseUrl = await startApplication({ store: makeStore() });
    expect((await fetch(`${baseUrl}/sync/checkpoint?channel=org%3Aabc`)).status).toBe(404);
  });

  it('authorizes before resolving projection context or accessing the provider', async () => {
    const checkpointProvider = provider();
    const checkpointProjectionKey = vi.fn(() => 'member:42');
    const baseUrl = await startApplication({
      store: makeStore(),
      authorizer: { canPush: () => true, canPull: () => false },
      checkpointProvider,
      checkpointProjectionKey,
    });
    expect((await fetch(`${baseUrl}/sync/checkpoint?channel=org%3Aabc`)).status).toBe(403);
    expect(checkpointProjectionKey).not.toHaveBeenCalled();
    expect(checkpointProvider.getCheckpoint).not.toHaveBeenCalled();
  });

  it.each([
    ['gzip', gunzipSync],
    ['br', brotliDecompressSync],
  ] as const)('serves %s with a projection-scoped weak ETag', async (encoding, decompress) => {
    const checkpointProvider = provider();
    const baseUrl = await startApplication({
      store: makeStore(),
      checkpointProvider,
      checkpointProjectionKey: () => 'member:42',
    });
    const raw = await rawGet(`${baseUrl}/sync/checkpoint?channel=org%3Aabc`, {
      'accept-encoding': encoding,
    });
    expect(raw.status).toBe(200);
    expect(raw.headers['content-encoding']).toBe(encoding);
    expect(raw.headers.etag).toMatch(/^W\/"checkpoint-[A-Za-z0-9_-]{43}"$/);
    expect(JSON.parse(decompress(raw.body).toString('utf8'))).toEqual(checkpoint());
    expect(checkpointProvider.getCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'org:abc', projectionKey: 'member:42',
    }));
  });

  it('returns CHECKPOINT_REQUIRED without reading changes for a stale cursor', async () => {
    const store = makeStore({
      isCursorRetained: vi.fn().mockResolvedValue(false),
      findChangesByCursor: vi.fn().mockResolvedValue([]),
    });
    const baseUrl = await startApplication({ store });
    const response = await fetch(
      `${baseUrl}/sync/changes?channel=org%3Aabc&since=2026-09-01T00%3A00%3A00.000Z&lastMutationId=old`,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: CHECKPOINT_REQUIRED, channel: 'org:abc' });
    expect(store.findChangesByCursor).not.toHaveBeenCalled();
  });

  it('serves tenant-bound snapshot chunks only with the manifest delivery token', async () => {
    const built = await buildSnapshotPack({
      tenantId: 'tenant-a', channel: 'org:abc', projectionKey: 'member:42',
      projectionRevision: 'grants:7', schemaVersion: '1',
      throughCursor: { lastMutationId: 'm1', lastReceivedAt: '2026-09-24T00:00:00.000Z' },
    }, { rows: [], mergeMetadata: [] }, {
      sign: () => 'short-lived-token',
      createdAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-09-25T00:00:00.000Z',
    });
    const snapshotPackProvider: SnapshotPackProvider = {
      getSnapshotPackManifest: vi.fn().mockResolvedValue(built.manifest),
      getSnapshotPackChunk: vi.fn(async (context, digest) =>
        context.tenantId === 'tenant-a' && context.deliveryToken === 'short-lived-token'
          ? built.chunks.find((chunk) => chunk.digest === digest) ?? null
          : null),
    };
    const baseUrl = await startApplication({
      store: makeStore(), snapshotPackProvider,
      snapshotPackTenant: () => 'tenant-a', snapshotPackProjectionKey: () => 'member:42',
    });
    expect((await fetch(`${baseUrl}/sync/snapshot-packs/manifest?channel=org%3Aabc`)).status).toBe(200);
    const digest = built.manifest.chunks[0].digest;
    expect((await fetch(`${baseUrl}/sync/snapshot-packs/chunks/${digest}?channel=org%3Aabc`)).status).toBe(401);
    const chunk = await fetch(
      `${baseUrl}/sync/snapshot-packs/chunks/${digest}?channel=org%3Aabc&token=short-lived-token`,
    );
    expect(chunk.status).toBe(200);
    expect((await chunk.json()).digest).toBe(digest);
  });

  it.each([
    ['gzip', gunzipSync],
    ['br', brotliDecompressSync],
  ] as const)('serves immutable snapshot chunks with negotiated %s compression', async (encoding, decompress) => {
    const built = await buildSnapshotPack({
      tenantId: 'tenant-a', channel: 'org:abc', projectionKey: 'member:42',
      projectionRevision: 'grants:7', schemaVersion: '1',
      throughCursor: { lastMutationId: 'm1', lastReceivedAt: '2026-09-24T00:00:00.000Z' },
    }, {
      rows: Array.from({ length: 100 }, (_, index) => ({
        entityType: 'Student', entityId: `s-${index}`, payload: { id: `s-${index}`, status: 'active' },
      })),
      mergeMetadata: [],
    }, {
      sign: () => 'short-lived-token',
      createdAt: '2026-09-24T00:00:00.000Z', expiresAt: '2026-09-25T00:00:00.000Z',
    });
    const snapshotPackProvider: SnapshotPackProvider = {
      getSnapshotPackManifest: vi.fn().mockResolvedValue(built.manifest),
      getSnapshotPackChunk: vi.fn().mockResolvedValue(built.chunks[0]),
    };
    const baseUrl = await startApplication({
      store: makeStore(), snapshotPackProvider,
      snapshotPackTenant: () => 'tenant-a', snapshotPackProjectionKey: () => 'member:42',
    });
    const digest = built.manifest.chunks[0].digest;
    const raw = await rawGet(
      `${baseUrl}/sync/snapshot-packs/chunks/${digest}?channel=org%3Aabc&token=short-lived-token`,
      { 'accept-encoding': encoding },
    );

    expect(raw.status).toBe(200);
    expect(raw.headers['content-encoding']).toBe(encoding);
    expect(raw.headers.vary).toContain('Accept-Encoding');
    expect(JSON.parse(decompress(raw.body).toString('utf8'))).toEqual(built.chunks[0]);
  });
});

function checkpoint(): CheckpointEnvelope {
  return {
    protocolVersion: CHECKPOINT_PROTOCOL_VERSION,
    schemaVersion: '1',
    channel: 'org:abc',
    projectionKey: 'member:42',
    projectionRevision: 'grants:7',
    throughCursor: {
      lastMutationId: '01ABCDEFGHJKMNPQRSTVWXYZ01',
      lastReceivedAt: '2026-09-12T12:00:00.000Z',
    },
    rows: [{ entityType: 'Student', entityId: 's1', payload: { id: 's1', name: 'Ada' } }],
    mergeMetadata: [{ entityType: 'Student', entityId: 's1', value: { head: 'm1' } }],
    integrity: {
      algorithm: 'sha-256',
      checksum: '47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU',
      scope: 'rows-and-merge-metadata',
    },
  };
}

function provider(value: CheckpointEnvelope = checkpoint()): CheckpointProvider {
  return { getCheckpoint: vi.fn().mockResolvedValue(value) };
}

function makeStore(overrides: Partial<MaayoStore> = {}): MaayoStore {
  return {
    existsById: vi.fn().mockResolvedValue(false),
    saveAll: vi.fn().mockResolvedValue([]),
    findChanges: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

async function startApplication(options: MaayoModuleOptions): Promise<string> {
  const application = await NestFactory.create(MaayoModule.forRoot(options), { logger: false });
  applications.push(application);
  await application.listen(0, '127.0.0.1');
  const address = application.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('Nest test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

function rawGet(url: string, headers: Record<string, string>): Promise<{
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}> {
  return new Promise((resolve, reject) => {
    void import('node:http').then(({ get }) => {
      const request = get(url, { headers }, (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
        response.on('end', () => resolve({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks),
        }));
      });
      request.on('error', reject);
    }, reject);
  });
}
