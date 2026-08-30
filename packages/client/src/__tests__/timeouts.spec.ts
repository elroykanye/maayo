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

async function settlesWithin(promise: Promise<unknown>, timeoutMs = 100): Promise<boolean> {
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
});
