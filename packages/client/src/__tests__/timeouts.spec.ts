import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncEngine } from '../engine';
import { enqueue } from '../outbox';

function hangingFetch() {
  return vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener('abort', () => {
      reject(new DOMException('Request timed out', 'AbortError'));
    }, { once: true });
  }));
}

function stalledBodyFetch(eventualBody: unknown) {
  return vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => ({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: () => new Promise<unknown>((resolve, reject) => {
      const eventualResponse = setTimeout(() => resolve(eventualBody), 1_500);
      init?.signal?.addEventListener('abort', () => {
        clearTimeout(eventualResponse);
        reject(init.signal?.reason ?? new DOMException('Request aborted', 'AbortError'));
      }, { once: true });
    }),
  }) as Response);
}

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 1_000): Promise<boolean> {
  return Promise.race([
    promise.then(() => true),
    new Promise<false>((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

afterEach(() => vi.restoreAllMocks());

describe('SyncEngine request deadlines', () => {
  it('aborts a stalled push and allows a later sync cycle to retry', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-push-timeout-${Math.random()}`,
      channels: [],
      requestTimeoutMs: 5,
    });
    const row = await enqueue(engine.db, {
      channel: 'org:1',
      entityType: 'Student',
      entityId: 'student-1',
      op: 'CREATE',
      payload: {},
      authorIdentityId: 'user-1',
    });
    (globalThis as Record<string, unknown>).fetch = hangingFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('error');

    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accepted: [{ id: row.id, receivedAt: '2026-08-30T12:00:00.000Z' }],
        rejected: [],
      }),
    }) as Response);
    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('idle');
  });

  it('aborts a stalled pull and allows a later sync cycle to retry', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-pull-timeout-${Math.random()}`,
      channels: ['org:1'],
      requestTimeoutMs: 5,
    });
    (globalThis as Record<string, unknown>).fetch = hangingFetch();
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('error');

    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        channel: 'org:1',
        mutations: [],
        hasMore: false,
        cursor: { lastMutationId: null, lastReceivedAt: null },
      }),
    }) as Response);
    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('idle');
  });

  it('keeps the push deadline active while the response body is stalled', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-push-body-timeout-${crypto.randomUUID()}`,
      channels: [],
      requestTimeoutMs: 5,
    });
    const row = await enqueue(engine.db, {
      channel: 'org:1',
      entityType: 'Student',
      entityId: 'student-body-push',
      op: 'CREATE',
      payload: {},
      authorIdentityId: 'user-1',
    });
    (globalThis as Record<string, unknown>).fetch = stalledBodyFetch({
      accepted: [{ id: row.id, receivedAt: '2026-09-02T00:00:00.000Z' }],
      rejected: [],
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('error');
    expect(await settlesWithin(engine.waitForIdle())).toBe(true);

    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accepted: [{ id: row.id, receivedAt: '2026-09-02T00:00:00.000Z' }],
        rejected: [],
      }),
    }) as Response);
    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('idle');
  });

  it('keeps the pull deadline active while the response body is stalled', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-pull-body-timeout-${crypto.randomUUID()}`,
      channels: ['org:1'],
      requestTimeoutMs: 5,
    });
    (globalThis as Record<string, unknown>).fetch = stalledBodyFetch({
      channel: 'org:1',
      mutations: [],
      hasMore: false,
      cursor: { lastMutationId: null, lastReceivedAt: null },
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('error');
    expect(await settlesWithin(engine.waitForIdle())).toBe(true);

    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        channel: 'org:1',
        mutations: [],
        hasMore: false,
        cursor: { lastMutationId: null, lastReceivedAt: null },
      }),
    }) as Response);
    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('idle');
  });

  it('stop aborts a stalled response body and allows a later manual retry', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-stop-body-${crypto.randomUUID()}`,
      channels: [],
      requestTimeoutMs: 60_000,
    });
    const row = await enqueue(engine.db, {
      channel: 'org:1',
      entityType: 'Student',
      entityId: 'student-stop',
      op: 'CREATE',
      payload: {},
      authorIdentityId: 'user-1',
    });
    const fetch = stalledBodyFetch({
      accepted: [{ id: row.id, receivedAt: '2026-09-02T00:00:00.000Z' }],
      rejected: [],
    });
    (globalThis as Record<string, unknown>).fetch = fetch;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    const sync = engine.sync();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    engine.stop();
    expect(await settlesWithin(sync)).toBe(true);
    expect(await settlesWithin(engine.waitForIdle())).toBe(true);

    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accepted: [{ id: row.id, receivedAt: '2026-09-02T00:00:00.000Z' }],
        rejected: [],
      }),
    }) as Response);
    expect(await settlesWithin(engine.sync())).toBe(true);
    expect(engine.status).toBe('idle');
  });
});
