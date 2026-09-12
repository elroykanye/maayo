import express from 'express';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CHECKPOINT_PROTOCOL_VERSION,
  CHECKPOINT_REQUIRED,
  type CheckpointEnvelope,
  type Mutation,
} from '@maayo/protocol';
import type { CheckpointProvider, MaayoStore, SavedMutation } from './interfaces';
import { maayoRouter } from './router';

const servers: Array<{ close: (callback: (error?: Error) => void) => void }> = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('maayoRouter checkpoint capability', () => {
  it('keeps replay-only servers working without exposing a checkpoint', async () => {
    const baseUrl = await startServer({ store: makeStore() });
    const response = await fetch(`${baseUrl}/sync/checkpoint?channel=org%3Aabc`);
    expect(response.status).toBe(404);
  });

  it('authorizes before resolving projection context or accessing the provider', async () => {
    const checkpointProvider = provider();
    const checkpointProjectionKey = vi.fn(() => 'member:42');
    const baseUrl = await startServer({
      store: makeStore(),
      authorizer: { canPush: () => true, canPull: () => false },
      checkpointProvider,
      checkpointProjectionKey,
    });

    const response = await fetch(`${baseUrl}/sync/checkpoint?channel=org%3Aabc`);

    expect(response.status).toBe(403);
    expect(checkpointProjectionKey).not.toHaveBeenCalled();
    expect(checkpointProvider.getCheckpoint).not.toHaveBeenCalled();
  });

  it.each([
    ['gzip', gunzipSync],
    ['br', brotliDecompressSync],
  ] as const)('serves %s with a projection-scoped weak ETag', async (encoding, decompress) => {
    const checkpointProvider = provider();
    const baseUrl = await startServer({
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
    expect(raw.headers.vary).toContain('Accept-Encoding');
    expect(JSON.parse(decompress(raw.body).toString('utf8'))).toEqual(checkpoint());
    expect(checkpointProvider.getCheckpoint).toHaveBeenCalledWith(expect.objectContaining({
      channel: 'org:abc',
      projectionKey: 'member:42',
    }));
  });

  it('returns 304 for a matching checkpoint ETag', async () => {
    const baseUrl = await startServer({
      store: makeStore(),
      checkpointProvider: provider(),
      checkpointProjectionKey: () => 'member:42',
    });
    const initial = await fetch(`${baseUrl}/sync/checkpoint?channel=org%3Aabc`);
    const etag = initial.headers.get('etag');
    expect(etag).toBeTruthy();
    const response = await fetch(`${baseUrl}/sync/checkpoint?channel=org%3Aabc`, {
      headers: { 'If-None-Match': etag! },
    });
    expect(response.status).toBe(304);
    expect(await response.text()).toBe('');
  });

  it('rejects a provider envelope from another authorization projection', async () => {
    const foreign = { ...checkpoint(), projectionKey: 'member:other' };
    const baseUrl = await startServer({
      store: makeStore(),
      checkpointProvider: provider(foreign),
      checkpointProjectionKey: () => 'member:42',
    });
    const response = await fetch(`${baseUrl}/sync/checkpoint?channel=org%3Aabc`);
    expect(response.status).toBe(500);
  });

  it('returns CHECKPOINT_REQUIRED before reading changes for a stale retained cursor', async () => {
    const store = makeStore({
      isCursorRetained: vi.fn().mockResolvedValue(false),
      findChangesByCursor: vi.fn().mockResolvedValue([]),
    });
    const baseUrl = await startServer({ store });
    const response = await fetch(
      `${baseUrl}/sync/changes?channel=org%3Aabc&since=2026-09-01T00%3A00%3A00.000Z&lastMutationId=old`,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ code: CHECKPOINT_REQUIRED, channel: 'org:abc' });
    expect(store.findChangesByCursor).not.toHaveBeenCalled();
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

async function startServer(options: Parameters<typeof maayoRouter>[0]): Promise<string> {
  const app = express();
  app.use('/sync', maayoRouter(options));
  const server = app.listen(0, '127.0.0.1');
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Express test server has no TCP address');
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
