import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openDatabase } from '../database';
import { SyncEngine } from '../engine';

function mutation(id: string, entityId: string) {
  return {
    id,
    channel: 'org:1',
    entityType: 'student',
    entityId,
    op: 'CREATE' as const,
    payload: JSON.stringify({ name: entityId }),
    authorIdentityId: 'u1',
    deviceId: 'dev-1',
    clientTs: '2026-01-01T00:00:00.000Z',
    parentIds: [],
  };
}

describe('SyncEngine.onAuthError', () => {
  it('fires on a 401 pull and still surfaces the error status', async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({}),
    }) as Response);

    const seen: Array<{ status: number; phase: string }> = [];
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-auth-${Math.random()}`,
      channels: ['org:1'],
      onAuthError: (status, phase) => seen.push({ status, phase }),
    });
    await engine.sync();

    expect(seen).toEqual([{ status: 401, phase: 'pull' }]);
    expect(engine.status).toBe('error');
  });

  it('does NOT fire for non-auth failures', async () => {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: async () => ({}),
    }) as Response);

    const onAuthError = vi.fn();
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-auth-500-${Math.random()}`,
      channels: ['org:1'],
      onAuthError,
    });
    await engine.sync();

    expect(onAuthError).not.toHaveBeenCalled();
    expect(engine.status).toBe('error');
  });
});

describe('SyncEngine.resetCursors', () => {
  it('clears cursors so the next pull replays from the beginning', async () => {
    const dbName = `test-reset-${Math.random()}`;
    const db = openDatabase(dbName, { student: 'id, name' });
    await db._cursors.bulkPut([
      { channel: 'org:1', lastMutationId: 'm1', lastReceivedAt: '2026-01-01T00:00:00.000Z' },
      { channel: 'org:2', lastMutationId: 'm2', lastReceivedAt: '2026-01-01T00:00:00.000Z' },
    ]);
    const engine = new SyncEngine({ baseUrl: 'http://test', dbName, channels: ['org:1', 'org:2'] });

    await engine.resetCursors(['org:1']);
    expect(await db._cursors.get('org:1')).toBeUndefined();
    expect(await db._cursors.get('org:2')).toBeDefined();

    await engine.resetCursors();
    expect(await db._cursors.count()).toBe(0);

    // The next pull sends no `since` — a full replay.
    (globalThis as Record<string, unknown>).fetch = vi.fn(async (url: string) => {
      expect(String(url)).not.toContain('since=');
      return {
        ok: true,
        json: async () => ({ channel: 'org:1', mutations: [], hasMore: false, cursor: {} }),
      } as Response;
    });
    await engine.sync();
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
  });
});

describe('SyncEngine.onApplied', () => {
  it('fires once per pulled mutation with its outcome', async () => {
    const dbName = `test-applied-${Math.random()}`;
    openDatabase(dbName, { student: 'id, name' });
    (globalThis as Record<string, unknown>).fetch = vi.fn(async () => ({
      ok: true,
      json: async () => ({
        channel: 'org:1',
        mutations: [mutation('m-1', 's1'), { ...mutation('m-2', 's2'), entityType: 'UnknownType' }],
        hasMore: false,
        cursor: { lastReceivedAt: new Date().toISOString() },
      }),
    }) as Response);

    const seen: Array<[string, string]> = [];
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName,
      channels: ['org:1'],
      onApplied: (m, outcome) => seen.push([m.id, outcome]),
    });
    await engine.sync();

    expect(seen).toEqual([
      ['m-1', 'applied'],
      ['m-2', 'skipped'], // unknown table — skipped, observably
    ]);
  });
});
