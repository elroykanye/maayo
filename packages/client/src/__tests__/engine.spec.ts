import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncEngine } from '../engine';
import { computeCheckpointChecksum, type CheckpointEnvelope } from '../checkpoint';
import { enqueue } from '../outbox';

function mockFetch(gate: Promise<void>) {
  (globalThis as Record<string, unknown>).fetch = vi.fn(async () => {
    await gate;
    return {
      ok: true,
      json: async () => ({ channel: 'org:1', mutations: [], hasMore: false, cursor: {} }),
    } as Response;
  });
}

describe('SyncEngine.waitForIdle', () => {
  it('resolves immediately when no sync is in flight', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-idle-none-${Math.random()}`,
      channels: [],
    });
    await expect(engine.waitForIdle()).resolves.toBeUndefined();
  });

  it('waits for an in-flight sync() before resolving', async () => {
    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((res) => { releaseFetch = res; });
    mockFetch(gate);

    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-idle-inflight-${Math.random()}`,
      channels: ['org:1'],
    });

    const syncPromise = engine.sync();
    let idleResolved = false;
    const idlePromise = engine.waitForIdle().then(() => {
      idleResolved = true;
    });

    // Let microtasks settle — the pull's fetch is gated open, so sync must still be running.
    await Promise.resolve();
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    releaseFetch();
    await syncPromise;
    await idlePromise;
    expect(idleResolved).toBe(true);
  });
});

describe('SyncEngine checkpoint sync', () => {
  it('installs a fresh checkpoint before tailing concurrent changes', async () => {
    const calls: string[] = [];
    const checkpoint = await checkpointEnvelope({
      throughCursor: { lastMutationId: 'm-checkpoint', lastReceivedAt: '2026-09-01T00:00:00.000Z' },
      rows: [
        { entityType: 'Student', entityId: 's-1', payload: { id: 's-1', name: 'Ada' } },
      ],
    });
    (globalThis as Record<string, unknown>).fetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      calls.push(`${url.pathname}${url.search}`);
      if (url.pathname === '/sync/checkpoint') {
        return jsonResponse(checkpoint);
      }
      expect(url.searchParams.get('since')).toBe('2026-09-01T00:00:00.000Z');
      expect(url.searchParams.get('lastMutationId')).toBe('m-checkpoint');
      return jsonResponse({
        channel: 'org:1',
        mutations: [{
          id: 'm-tail',
          channel: 'org:1',
          entityType: 'Student',
          entityId: 's-2',
          op: 'CREATE',
          payload: JSON.stringify({ name: 'Grace' }),
          authorIdentityId: 'u-1',
          deviceId: 'd-1',
          clientTs: '2026-09-01T00:00:01.000Z',
          parentIds: ['m-checkpoint'],
        }],
        hasMore: false,
        cursor: { lastMutationId: 'm-tail', lastReceivedAt: '2026-09-01T00:00:01.000Z' },
      });
    });

    const telemetry: Array<Record<string, unknown>> = [];
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-checkpoint-engine-fresh-${Math.random()}`,
      channels: ['org:1'],
      tables: { Student: 'id, name' },
      checkpoint: {
        projectionKey: 'role:teacher:v3',
        expectedProjectionRevision: 'grants:v1',
        supportedSchemaVersion: '1',
        replaceEntityTypes: ['Student'],
      },
      onTelemetry: (event) => telemetry.push(event as unknown as Record<string, unknown>),
    });

    await engine.sync();

    expect(calls[0]).toBe('/sync/checkpoint?channel=org%3A1');
    expect(await engine.db.table('Student').toArray()).toEqual([
      { id: 's-1', name: 'Ada' },
      { id: 's-2', name: 'Grace' },
    ]);
    expect(await engine.db._cursors.get('org:1')).toMatchObject({ lastMutationId: 'm-tail' });
    expect(telemetry.map((event) => `${event.phase}:${event.status}`)).toContain('checkpoint:end');
    expect(telemetry.map((event) => `${event.phase}:${event.status}`)).toContain('checkpoint-transaction:end');
    expect(telemetry).toContainEqual(expect.objectContaining({
      phase: 'checkpoint-transfer', status: 'end', bytes: expect.any(Number),
    }));
    expect(telemetry).toContainEqual(expect.objectContaining({
      phase: 'checkpoint-decode', status: 'end', entities: 1,
    }));
    expect(telemetry).toContainEqual(expect.objectContaining({ phase: 'pull', status: 'end', pages: 1 }));
  });

  it('pushes pending rows before replacing a stale retained cursor with a checkpoint', async () => {
    const order: string[] = [];
    const checkpoint = await checkpointEnvelope({
      throughCursor: { lastMutationId: 'm-checkpoint', lastReceivedAt: '2026-09-01T00:00:00.000Z' },
      rows: [{ entityType: 'Student', entityId: 'remote', payload: { id: 'remote', name: 'Remote' } }],
    });
    (globalThis as Record<string, unknown>).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/sync/mutations') {
        order.push('push');
        const body = JSON.parse(String(init?.body)) as { mutations: Array<{ id: string }> };
        return jsonResponse({
          accepted: body.mutations.map(({ id }) => ({ id, receivedAt: '2026-09-01T00:00:00.000Z' })),
          rejected: [],
        });
      }
      if (url.pathname === '/sync/checkpoint') {
        order.push('checkpoint');
        return jsonResponse(checkpoint);
      }
      order.push('pull');
      if (order.filter((item) => item === 'pull').length === 1) {
        return jsonResponse({ code: 'CHECKPOINT_REQUIRED', channel: 'org:1' }, 409);
      }
      return jsonResponse({
        channel: 'org:1',
        mutations: [],
        hasMore: false,
        cursor: { lastMutationId: 'm-checkpoint', lastReceivedAt: '2026-09-01T00:00:00.000Z' },
      });
    });

    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-checkpoint-engine-stale-${Math.random()}`,
      channels: ['org:1'],
      tables: { Student: 'id, name' },
      checkpoint: {
        projectionKey: 'role:teacher:v3',
        expectedProjectionRevision: 'grants:v1',
        supportedSchemaVersion: '1',
        replaceEntityTypes: ['Student'],
      },
    });
    await enqueue(engine.db, {
      channel: 'org:1',
      entityType: 'Student',
      entityId: 'local',
      op: 'CREATE',
      payload: { id: 'local', name: 'Local' },
      authorIdentityId: 'u-1',
    });
    await engine.db._cursors.put({
      channel: 'org:1',
      lastMutationId: 'old',
      lastReceivedAt: '2026-08-01T00:00:00.000Z',
    });

    await engine.sync();

    expect(order.slice(0, 3)).toEqual(['push', 'pull', 'checkpoint']);
    expect(await engine.db._outbox.count()).toBe(0);
    expect(await engine.db.table('Student').toArray()).toEqual([{ id: 'remote', name: 'Remote' }]);
  });

  it('forces one unconditional checkpoint response when stale recovery has an ETag', async () => {
    const checkpoint = await checkpointEnvelope({
      throughCursor: { lastMutationId: 'm-checkpoint', lastReceivedAt: '2026-09-01T00:00:00.000Z' },
      rows: [{ entityType: 'Student', entityId: 'remote', payload: { id: 'remote', name: 'Remote' } }],
    });
    let pulls = 0;
    let checkpoints = 0;
    (globalThis as Record<string, unknown>).fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === '/sync/checkpoint') {
        checkpoints += 1;
        const headers = new Headers(init?.headers);
        if (headers.has('If-None-Match')) return new Response(null, { status: 304 });
        return jsonResponse(checkpoint);
      }
      pulls += 1;
      if (pulls > 3) throw new Error('recovery loop');
      if (url.searchParams.get('lastMutationId') !== 'm-checkpoint') {
        return jsonResponse({ code: 'CHECKPOINT_REQUIRED', channel: 'org:1' }, 409);
      }
      return jsonResponse({
        channel: 'org:1', mutations: [], hasMore: false,
        cursor: { lastMutationId: 'm-checkpoint', lastReceivedAt: '2026-09-01T00:00:00.000Z' },
      });
    });
    const engine = new SyncEngine({
      baseUrl: 'http://test', dbName: `test-checkpoint-engine-etag-${Math.random()}`, channels: ['org:1'],
      tables: { Student: 'id' },
      checkpoint: {
        projectionKey: 'role:teacher:v3', etag: 'W/"known"', expectedProjectionRevision: 'grants:v1',
        supportedSchemaVersion: '1', replaceEntityTypes: ['Student'],
      },
    });
    await engine.db._cursors.put({
      channel: 'org:1', lastMutationId: 'stale', lastReceivedAt: '2026-08-01T00:00:00.000Z',
    });

    await engine.sync();

    expect(engine.status).toBe('idle');
    expect({ pulls, checkpoints }).toEqual({ pulls: 2, checkpoints: 1 });
  });

  it('enforces the configured hard budget and reports it with terminal telemetry', async () => {
    const events: Array<Record<string, unknown>> = [];
    (globalThis as Record<string, unknown>).fetch = vi.fn((_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason), { once: true });
      }));
    const engine = new SyncEngine({
      baseUrl: 'http://test', dbName: `test-checkpoint-engine-budget-${Math.random()}`, channels: ['org:1'],
      tables: { Student: 'id' }, requestTimeoutMs: 1_000,
      checkpoint: {
        projectionKey: 'role:teacher:v3', expectedProjectionRevision: 'grants:v1',
        supportedSchemaVersion: '1', replaceEntityTypes: ['Student'], hardBudgetMs: 25,
      },
      onTelemetry: (event) => events.push(event as unknown as Record<string, unknown>),
    });
    const started = performance.now();

    await engine.sync();

    expect(performance.now() - started).toBeLessThan(500);
    expect(engine.status).toBe('error');
    expect(events.at(-1)).toMatchObject({ phase: 'idle', status: 'end', terminalState: 'error', budgetMs: 25 });
  });
});

async function checkpointEnvelope(
  overrides: Partial<Omit<CheckpointEnvelope, 'integrity'>>,
): Promise<CheckpointEnvelope> {
  const unsigned = {
    protocolVersion: 1 as const,
    schemaVersion: '1',
    channel: 'org:1',
    projectionKey: 'role:teacher:v3',
    projectionRevision: 'grants:v1',
    throughCursor: { lastMutationId: null, lastReceivedAt: null },
    rows: [],
    mergeMetadata: [],
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

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
