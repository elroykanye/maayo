import { describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncEngine } from '../engine';
import { enqueue } from '../outbox';

describe('SyncEngine bounded outbox draining', () => {
  it('drains a backlog in 2, 2, 1 batches without resending rows', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-batching-${Math.random()}`,
      channels: [],
      pushBatchSize: 2,
    });
    for (let index = 0; index < 5; index++) {
      await enqueue(engine.db, {
        channel: 'org:1',
        entityType: 'Student',
        entityId: `student-${index}`,
        op: 'CREATE',
        payload: { index },
        authorIdentityId: 'user-1',
      });
    }
    const pushedIds: string[][] = [];
    (globalThis as Record<string, unknown>).fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { mutations: Array<{ id: string }> };
      const ids = body.mutations.map((mutation) => mutation.id);
      pushedIds.push(ids);
      return {
        ok: true,
        json: async () => ({
          accepted: ids.map((id) => ({ id, receivedAt: '2026-08-30T12:00:00.000Z' })),
          rejected: [],
        }),
      } as Response;
    });

    await engine.sync();

    expect(pushedIds.map((ids) => ids.length)).toEqual([2, 2, 1]);
    expect(new Set(pushedIds.flat()).size).toBe(5);
    expect(await engine.db._outbox.count()).toBe(0);
  });

  it.each(['accepted', 'rejected'] as const)(
    'rejects an entire response before state changes when an unsent row is %s',
    async (foreignDisposition) => {
      const onReject = vi.fn();
      const engine = new SyncEngine({
        baseUrl: 'http://test',
        dbName: `test-foreign-${foreignDisposition}-${crypto.randomUUID()}`,
        channels: [],
        pushBatchSize: 1,
        permanentRejectCodes: ['PERMANENT'],
        onReject,
      });
      const first = await enqueue(engine.db, {
        channel: 'org:1',
        entityType: 'Student',
        entityId: 'student-first',
        op: 'CREATE',
        payload: { order: 1 },
        authorIdentityId: 'user-1',
      });
      const unsent = await enqueue(engine.db, {
        channel: 'org:1',
        entityType: 'Student',
        entityId: 'student-unsent',
        op: 'CREATE',
        payload: { order: 2 },
        authorIdentityId: 'user-1',
      });
      await engine.db._outbox.update(first.id, { clientTs: '2026-09-01T00:00:00.000Z' });
      await engine.db._outbox.update(unsent.id, { clientTs: '2026-09-01T00:00:01.000Z' });

      const pushedIds: string[][] = [];
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { mutations: Array<{ id: string }> };
        pushedIds.push(body.mutations.map(({ id }) => id));
        return {
          ok: true,
          json: async () => ({
            accepted: foreignDisposition === 'accepted'
              ? [first, unsent].map(({ id }) => ({ id, receivedAt: '2026-09-01T12:00:00.000Z' }))
              : [{ id: first.id, receivedAt: '2026-09-01T12:00:00.000Z' }],
            rejected: foreignDisposition === 'rejected'
              ? [{ id: unsent.id, reason: 'foreign rejection', code: 'PERMANENT' }]
              : [],
          }),
        } as Response;
      });
      (globalThis as Record<string, unknown>).fetch = fetchMock;
      vi.spyOn(console, 'error').mockImplementation(() => {});

      await engine.sync();

      expect(engine.status).toBe('error');
      expect(pushedIds).toEqual([[first.id]]);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await engine.db._outbox.count()).toBe(2);
      expect((await engine.db._outbox.get(first.id))?.syncedAt).toBeUndefined();
      const untouchedUnsent = await engine.db._outbox.get(unsent.id);
      expect(untouchedUnsent?.syncedAt).toBeUndefined();
      expect(untouchedUnsent?.attempts).toBeUndefined();
      expect(untouchedUnsent?.rejectedAt).toBeUndefined();
      expect(await engine.db._history.count()).toBe(0);
      expect(onReject).not.toHaveBeenCalled();
    },
  );

  it('rejects an entire response before state changes when one row is accepted and rejected', async () => {
    const onReject = vi.fn();
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-contradictory-${crypto.randomUUID()}`,
      channels: [],
      permanentRejectCodes: ['PERMANENT'],
      onReject,
    });
    const row = await enqueue(engine.db, {
      channel: 'org:1',
      entityType: 'Student',
      entityId: 'student-contradictory',
      op: 'CREATE',
      payload: {},
      authorIdentityId: 'user-1',
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        accepted: [{ id: row.id, receivedAt: '2026-09-01T12:00:00.000Z' }],
        rejected: [{ id: row.id, reason: 'contradiction', code: 'PERMANENT' }],
      }),
    }) as Response);
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await engine.sync();

    expect(engine.status).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const untouched = await engine.db._outbox.get(row.id);
    expect(untouched?.syncedAt).toBeUndefined();
    expect(untouched?.attempts).toBeUndefined();
    expect(untouched?.rejectedAt).toBeUndefined();
    expect(await engine.db._history.count()).toBe(0);
    expect(onReject).not.toHaveBeenCalled();
  });

  it('stops with an error instead of looping when a push resolves no requested row', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-no-progress-${Math.random()}`,
      channels: [],
      pushBatchSize: 2,
    });
    await enqueue(engine.db, {
      channel: 'org:1',
      entityType: 'Student',
      entityId: 'student-stuck',
      op: 'CREATE',
      payload: {},
      authorIdentityId: 'user-1',
    });
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ accepted: [], rejected: [] }),
    }) as Response);
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    vi.spyOn(console, 'error').mockImplementation(() => {});

    await engine.sync();

    expect(engine.status).toBe('error');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await engine.db._outbox.count()).toBe(1);
  });

  it.each([0.5, 0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'falls back to a usable batch for invalid row count %s',
    async (pushBatchSize) => {
      const engine = new SyncEngine({
        baseUrl: 'http://test',
        dbName: `test-invalid-batch-${crypto.randomUUID()}`,
        channels: [],
        pushBatchSize,
      });
      await enqueue(engine.db, {
        channel: 'org:1',
        entityType: 'Student',
        entityId: 'student-batch-boundary',
        op: 'CREATE',
        payload: {},
        authorIdentityId: 'user-1',
      });
      const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body)) as { mutations: Array<{ id: string }> };
        return {
          ok: true,
          json: async () => ({
            accepted: body.mutations.map(({ id }) => ({
              id,
              receivedAt: '2026-08-30T12:00:00.000Z',
            })),
            rejected: [],
          }),
        } as Response;
      });
      (globalThis as Record<string, unknown>).fetch = fetchMock;

      await engine.sync();

      expect(engine.status).toBe('idle');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(await engine.db._outbox.count()).toBe(0);
    },
  );
});
