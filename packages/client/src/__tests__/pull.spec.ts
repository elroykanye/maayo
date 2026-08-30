import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openDatabase } from '../database';
import type { MaayoDatabase } from '../database';

let db: MaayoDatabase;

function makeMutation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'mut-1',
    channel: 'org:1',
    entityType: 'student',
    entityId: 'stu-abc',
    op: 'CREATE' as const,
    payload: JSON.stringify({ name: 'Ada' }), // no id field
    authorIdentityId: 'user-1',
    deviceId: 'dev-1',
    clientTs: '2026-01-01T00:00:00.000Z',
    parentIds: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = openDatabase(`test-pull-${Math.random()}`, { student: 'id, name' });
});

describe('applyMutations via pull()', () => {
  async function callPull(mutations: ReturnType<typeof makeMutation>[]) {
    const { pull } = await import('../pull');
    (globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        channel: 'org:1',
        mutations,
        hasMore: false,
        cursor: { lastReceivedAt: new Date().toISOString() },
      }),
    } as Response);
    return pull(db, { baseUrl: 'http://test', channel: 'org:1' });
  }

  it('stores row under entityId when payload has no id field', async () => {
    await callPull([makeMutation()]);
    const row = await db.table('student').get('stu-abc');
    expect(row).toBeDefined();
    expect(row.id).toBe('stu-abc');
    expect(row.name).toBe('Ada');
  });

  it('entityId overwrites any id present in payload', async () => {
    const m = makeMutation({ payload: JSON.stringify({ id: 'wrong-id', name: 'Bob' }) });
    await callPull([m]);
    const row = await db.table('student').get('stu-abc');
    expect(row.id).toBe('stu-abc');
  });

  it('skips a row when local updatedAt is newer (LWW)', async () => {
    await db.table('student').put({ id: 'stu-abc', name: 'Existing', updatedAt: '2026-06-01T00:00:00.000Z' });
    const m = makeMutation({
      op: 'UPDATE',
      payload: JSON.stringify({ name: 'Stale', updatedAt: '2026-01-01T00:00:00.000Z' }),
    });
    const { result } = await callPull([m]);
    expect(result.skipped).toBe(1);
    const row = await db.table('student').get('stu-abc');
    expect(row.name).toBe('Existing');
  });

  it('applies DELETE using entityId', async () => {
    await db.table('student').put({ id: 'stu-abc', name: 'Doomed' });
    await callPull([makeMutation({ op: 'DELETE' })]);
    expect(await db.table('student').get('stu-abc')).toBeUndefined();
  });

  it('skips (does not throw) a mutation for an entityType not in the local schema', async () => {
    // Dexie's db.table() throws InvalidTableError for an unregistered name — this must be
    // caught and counted as skipped, not left to abort the whole pull.
    const m = makeMutation({ entityType: 'UnknownType' });
    const { result } = await callPull([m]);
    expect(result.skipped).toBe(1);
    expect(result.applied).toBe(0);
  });

  it('continues a tied-timestamp page with the last mutation id', async () => {
    const lastReceivedAt = '2026-08-30T12:00:00.000Z';
    await db._cursors.put({
      channel: 'org:1',
      lastMutationId: 'mut-0001',
      lastReceivedAt,
    });
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        channel: 'org:1',
        mutations: [],
        hasMore: false,
        cursor: { lastMutationId: 'mut-0001', lastReceivedAt },
      }),
    } as Response);
    (globalThis as Record<string, unknown>).fetch = fetchMock;
    const { pull } = await import('../pull');

    await pull(db, { baseUrl: 'http://test', channel: 'org:1' });

    const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestUrl.searchParams.get('since')).toBe(lastReceivedAt);
    expect(requestUrl.searchParams.get('lastMutationId')).toBe('mut-0001');
  });
});
