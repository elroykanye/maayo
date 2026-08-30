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
});
