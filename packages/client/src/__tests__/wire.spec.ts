import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import type { BatchMutationsResponse } from '@maayo/protocol';
import { SyncEngine } from '../engine';
import { enqueue } from '../outbox';

const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  })));
});

describe('SyncEngine HTTP boundary', () => {
  it('times out a stalled response body over TCP and retries the preserved row', async () => {
    const pushedIds: string[][] = [];
    const baseUrl = await startStalledBodyServer(pushedIds);
    const engine = new SyncEngine({
      baseUrl,
      dbName: `test-http-stalled-body-${crypto.randomUUID()}`,
      channels: [],
      requestTimeoutMs: 75,
    });
    const queued = await enqueue(engine.db, {
      channel: 'org:wire',
      entityType: 'Student',
      entityId: 'student-stalled-body',
      op: 'CREATE',
      payload: { order: 1 },
      authorIdentityId: 'user-1',
    });

    const startedAt = Date.now();
    await engine.sync();

    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(engine.status).toBe('error');
    expect(await engine.db._outbox.count()).toBe(1);

    await engine.sync();

    expect(engine.status).toBe('idle');
    expect(pushedIds).toEqual([[queued.id], [queued.id]]);
    expect(await engine.db._outbox.count()).toBe(0);
  });

  it('preserves both rows after a foreign acknowledgement and drains them on a clean retry', async () => {
    let firstId = '';
    let unsentId = '';
    const pushedIds: string[][] = [];
    const baseUrl = await startServer((ids) => {
      pushedIds.push(ids);
      if (pushedIds.length === 1) {
        return {
          accepted: [firstId, unsentId].map((id) => ({
            id,
            receivedAt: '2026-09-01T12:00:00.000Z',
          })),
          rejected: [],
        };
      }
      return {
        accepted: ids.map((id) => ({ id, receivedAt: '2026-09-01T12:01:00.000Z' })),
        rejected: [],
      };
    });
    const engine = new SyncEngine({
      baseUrl,
      dbName: `test-http-retry-${crypto.randomUUID()}`,
      channels: [],
      pushBatchSize: 1,
    });
    const first = await enqueue(engine.db, {
      channel: 'org:wire',
      entityType: 'Student',
      entityId: 'student-first',
      op: 'CREATE',
      payload: { order: 1 },
      authorIdentityId: 'user-1',
    });
    const unsent = await enqueue(engine.db, {
      channel: 'org:wire',
      entityType: 'Student',
      entityId: 'student-unsent',
      op: 'CREATE',
      payload: { order: 2 },
      authorIdentityId: 'user-1',
    });
    firstId = first.id;
    unsentId = unsent.id;
    await engine.db._outbox.update(first.id, { clientTs: '2026-09-01T00:00:00.000Z' });
    await engine.db._outbox.update(unsent.id, { clientTs: '2026-09-01T00:00:01.000Z' });

    await engine.sync();

    expect(engine.status).toBe('error');
    expect(pushedIds).toEqual([[first.id]]);
    expect(await engine.db._outbox.count()).toBe(2);
    expect(await engine.db._history.count()).toBe(0);

    await engine.sync();

    expect(engine.status).toBe('idle');
    expect(pushedIds).toEqual([[first.id], [first.id], [unsent.id]]);
    expect(await engine.db._outbox.count()).toBe(0);
    expect((await engine.db._history.toArray()).map(({ id }) => id).sort())
      .toEqual([first.id, unsent.id].sort());
  });
});

async function startStalledBodyServer(pushedIds: string[][]): Promise<string> {
  let requestCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/sync/mutations') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      mutations: Array<{ id: string }>;
    };
    const ids = body.mutations.map(({ id }) => id);
    pushedIds.push(ids);
    requestCount += 1;
    response.writeHead(200, { 'Content-Type': 'application/json' });
    if (requestCount === 1) {
      response.write('{"accepted":');
      return;
    }
    response.end(JSON.stringify({
      accepted: ids.map((id) => ({ id, receivedAt: '2026-09-02T12:00:00.000Z' })),
      rejected: [],
    } satisfies BatchMutationsResponse));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Client test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function startServer(
  responseFor: (ids: string[]) => BatchMutationsResponse,
): Promise<string> {
  const server = createServer(async (request, response) => {
    if (request.method !== 'POST' || request.url !== '/sync/mutations') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Uint8Array[] = [];
    for await (const chunk of request) {
      chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      mutations: Array<{ id: string }>;
    };
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(responseFor(body.mutations.map(({ id }) => id))));
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.listen(0, '127.0.0.1', resolve);
    server.once('error', reject);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Client test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}
