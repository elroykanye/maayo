import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openDatabase } from '../database';
import type { MaayoDatabase } from '../database';
import { pull, type PullOptions } from '../pull';

let db: MaayoDatabase;

function makeMutation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mut-1',
    channel: 'org:1',
    entityType: 'student',
    entityId: 'stu-abc',
    op: 'CREATE' as const,
    payload: JSON.stringify({ name: 'Ada' }),
    authorIdentityId: 'user-1',
    deviceId: 'dev-1',
    clientTs: '2026-01-01T00:00:00.000Z',
    parentIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase(`test-apply-${Math.random()}`, { student: 'id, name' });
});

async function callPull(mutations: ReturnType<typeof makeMutation>[], opts: Partial<PullOptions> = {}) {
  (globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({
      channel: 'org:1',
      mutations,
      hasMore: false,
      cursor: { lastReceivedAt: new Date().toISOString() },
    }),
  } as Response);
  return pull(db, { baseUrl: 'http://test', channel: 'org:1', ...opts });
}

describe('deterministic LWW tie-break', () => {
  const ts = '2026-03-01T00:00:00.000Z';

  function writeFrom(deviceId: string, id: string, name: string) {
    return makeMutation({
      id,
      deviceId,
      op: 'UPDATE' as const,
      clientTs: ts,
      payload: JSON.stringify({ name, updatedAt: ts }),
    });
  }

  it('equal timestamps converge to the SAME winner in both arrival orders', async () => {
    const fromA = writeFrom('dev-A', 'mut-a', 'FromA');
    const fromB = writeFrom('dev-B', 'mut-b', 'FromB');

    // Replica 1 receives A then B…
    await callPull([fromA, fromB]);
    const row1 = await db.table('student').get('stu-abc');

    // …replica 2 receives B then A.
    const db2 = openDatabase(`test-apply-${Math.random()}`, { student: 'id, name' });
    const saved = db;
    db = db2;
    await callPull([fromB, fromA]);
    const row2 = await db2.table('student').get('stu-abc');
    db = saved;

    // The OLD `existingTs >= incomingTs` rule made this first-arrival-wins:
    // row1 'FromB', row2 'FromA' — two replicas, two states. The (deviceId, id)
    // tie-break lands both on dev-B's write.
    expect(row1.name).toBe('FromB');
    expect(row2.name).toBe('FromB');
  });

  it('a strictly newer timestamp still wins outright (no history lookup needed)', async () => {
    await callPull([
      makeMutation({ id: 'm-old', payload: JSON.stringify({ name: 'Old', updatedAt: '2026-01-01T00:00:00.000Z' }) }),
      makeMutation({ id: 'm-new', op: 'UPDATE', clientTs: '2026-02-01T00:00:00.000Z', payload: JSON.stringify({ name: 'New', updatedAt: '2026-02-01T00:00:00.000Z' }) }),
    ]);
    expect((await db.table('student').get('stu-abc')).name).toBe('New');
  });

  it('a row without history identity loses the tie to a real mutation', async () => {
    // Local row written outside the mutation flow (legacy/bootstrap) — same ts.
    await db.table('student').put({ id: 'stu-abc', name: 'Legacy', updatedAt: ts });
    await callPull([writeFrom('dev-A', 'mut-real', 'Real')]);
    expect((await db.table('student').get('stu-abc')).name).toBe('Real');
  });
});

describe('softDelete mode', () => {
  it('DELETE writes a gated tombstone instead of hard-deleting', async () => {
    await callPull([makeMutation({ payload: JSON.stringify({ name: 'Doomed', updatedAt: '2026-01-01T00:00:00.000Z' }) })]);
    await callPull(
      [makeMutation({ id: 'mut-del', op: 'DELETE' as const, clientTs: '2026-02-01T00:00:00.000Z', payload: '{}' })],
      { softDelete: true },
    );
    const row = await db.table('student').get('stu-abc');
    expect(row).toBeDefined();
    expect(row.deletedAt).toBe('2026-02-01T00:00:00.000Z');
    expect(row.name).toBeUndefined(); // deterministic tombstone: { id, deletedAt } only
  });

  it('a STALE delete loses to a newer local row (hard delete applied it unconditionally)', async () => {
    await callPull([makeMutation({ payload: JSON.stringify({ name: 'Survivor', updatedAt: '2026-03-01T00:00:00.000Z' }) })]);
    const { result } = await callPull(
      [makeMutation({ id: 'mut-staledel', op: 'DELETE' as const, clientTs: '2026-01-01T00:00:00.000Z', payload: '{}' })],
      { softDelete: true },
    );
    expect(result.skipped).toBe(1);
    expect((await db.table('student').get('stu-abc')).name).toBe('Survivor');
  });

  it('a newer upsert resurrects a tombstoned row', async () => {
    await callPull(
      [makeMutation({ id: 'mut-del2', op: 'DELETE' as const, clientTs: '2026-01-15T00:00:00.000Z', payload: '{}' })],
      { softDelete: true },
    );
    await callPull(
      [makeMutation({ id: 'mut-revive', op: 'UPDATE' as const, clientTs: '2026-02-01T00:00:00.000Z', payload: JSON.stringify({ name: 'Back', updatedAt: '2026-02-01T00:00:00.000Z' }) })],
      { softDelete: true },
    );
    const row = await db.table('student').get('stu-abc');
    expect(row.name).toBe('Back');
    expect(row.deletedAt).toBeUndefined();
  });
});

describe('applyMutation hook', () => {
  it('owns the merge and can delegate to the default apply', async () => {
    const seen: string[] = [];
    await callPull(
      [
        makeMutation({ id: 'm-1', entityId: 'stu-1', payload: JSON.stringify({ name: 'Normal' }) }),
        makeMutation({ id: 'm-2', entityId: 'stu-2', payload: JSON.stringify({ name: 'Custom' }) }),
      ],
      {
        applyMutation: async (database, mutation, defaultApply) => {
          seen.push(mutation.id);
          if (mutation.entityId === 'stu-2') {
            // Consumer-owned merge: write something the default never would.
            await database.table('student').put({ id: mutation.entityId, name: 'HOOKED' });
            return 'applied';
          }
          return defaultApply();
        },
      },
    );
    expect(seen).toEqual(['m-1', 'm-2']);
    expect((await db.table('student').get('stu-1')).name).toBe('Normal');
    expect((await db.table('student').get('stu-2')).name).toBe('HOOKED');
  });

  it('history records hook-applied mutations, and skipped ones stay out', async () => {
    await callPull(
      [
        makeMutation({ id: 'm-app', entityId: 'stu-a' }),
        makeMutation({ id: 'm-skip', entityId: 'stu-b' }),
      ],
      { applyMutation: async (_db, m, defaultApply) => (m.entityId === 'stu-b' ? 'skipped' : defaultApply()) },
    );
    expect(await db._history.get('m-app')).toBeDefined();
    expect(await db._history.get('m-skip')).toBeUndefined();
  });
});
