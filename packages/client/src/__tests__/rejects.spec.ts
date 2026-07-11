import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { openDatabase } from '../database';
import type { MaayoDatabase } from '../database';
import { enqueue, pending, recordRejection, rejected, retryRejected, discardRejected, rejectionBackoff } from '../outbox';
import { SyncEngine } from '../engine';

let db: MaayoDatabase;

beforeEach(() => {
  db = openDatabase(`test-rejects-${Math.random()}`, { student: 'id, name' });
});

async function enqueueOne(entityId = 'stu-1') {
  return enqueue(db, {
    channel: 'org:1',
    entityType: 'student',
    entityId,
    op: 'CREATE',
    payload: { name: 'Ada' },
    authorIdentityId: 'user-1',
  });
}

describe('rejection lifecycle (outbox)', () => {
  it('a rejected row backs off: pending() excludes it until nextAttemptAt', async () => {
    const row = await enqueueOne();
    expect((await pending(db)).map((r) => r.id)).toEqual([row.id]);

    const recorded = await recordRejection(db, { id: row.id, reason: 'nope' });
    expect(recorded?.quarantined).toBe(false);
    expect(recorded?.row.attempts).toBe(1);

    // Backed off — not pending right now, but NOT quarantined either.
    expect(await pending(db)).toEqual([]);
    expect(await rejected(db)).toEqual([]);

    const stored = await db._outbox.get(row.id);
    expect(stored?.nextAttemptAt).toBeDefined();
    expect(stored?.rejectReason).toBe('nope');
  });

  it('quarantines after maxAttempts and pending() never returns it again', async () => {
    const row = await enqueueOne();
    for (let i = 1; i <= 3; i++) {
      await recordRejection(db, { id: row.id, reason: `attempt ${i}` }, { maxAttempts: 3 });
    }
    const q = await rejected(db);
    expect(q.map((r) => r.id)).toEqual([row.id]);
    expect(q[0].attempts).toBe(3);
    expect(q[0].rejectedAt).toBeDefined();
    expect(await pending(db)).toEqual([]);
  });

  it('a permanent code quarantines immediately, skipping the retry budget', async () => {
    const row = await enqueueOne();
    const recorded = await recordRejection(
      db,
      { id: row.id, reason: 'slug already taken', code: 'SLUG_TAKEN' },
      { maxAttempts: 5, permanentCodes: ['SLUG_TAKEN'] },
    );
    expect(recorded?.quarantined).toBe(true);
    expect((await rejected(db))[0]?.rejectCode).toBe('SLUG_TAKEN');
  });

  it('retryRejected restores the row to pending with its ORIGINAL clientTs and parentIds', async () => {
    const row = await enqueue(db, {
      channel: 'org:1',
      entityType: 'student',
      entityId: 'stu-2',
      op: 'UPDATE',
      payload: { name: 'Bob' },
      authorIdentityId: 'user-1',
      parentIds: ['parent-mut'],
    });
    await recordRejection(db, { id: row.id, reason: 'nope' }, { maxAttempts: 1 });
    expect(await pending(db)).toEqual([]);

    await retryRejected(db, row.id);
    const revived = await pending(db);
    expect(revived.map((r) => r.id)).toEqual([row.id]);
    // Causal position preserved — a retry must not jump the queue as a fresh write.
    expect(revived[0].clientTs).toBe(row.clientTs);
    expect(revived[0].parentIds).toEqual(['parent-mut']);
    expect(revived[0].rejectedAt).toBeFalsy();
  });

  it('discardRejected drops the mutation for good', async () => {
    const row = await enqueueOne('stu-3');
    await recordRejection(db, { id: row.id, reason: 'nope' }, { maxAttempts: 1 });
    await discardRejected(db, row.id);
    expect(await rejected(db)).toEqual([]);
    expect(await db._outbox.get(row.id)).toBeUndefined();
  });

  it('backoff grows exponentially and caps', () => {
    expect(rejectionBackoff(1)).toBe(30_000);
    expect(rejectionBackoff(2)).toBe(60_000);
    expect(rejectionBackoff(3)).toBe(120_000);
    expect(rejectionBackoff(20)).toBe(1_800_000); // capped at 30min
  });
});

describe('SyncEngine push rejection handling', () => {
  function mockPushResponse(accepted: { id: string; receivedAt: string }[], rejectedItems: { id: string; reason: string; code?: string }[]) {
    (globalThis as Record<string, unknown>).fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/sync/mutations')) {
        return { ok: true, json: async () => ({ accepted, rejected: rejectedItems }) } as Response;
      }
      return {
        ok: true,
        json: async () => ({ channel: 'org:1', mutations: [], hasMore: false, cursor: {} }),
      } as Response;
    });
  }

  it('records each rejection instead of re-pushing forever, and fires onReject', async () => {
    const dbName = `test-engine-rejects-${Math.random()}`;
    const engineDb = openDatabase(dbName, { student: 'id, name' });
    const ok = await enqueue(engineDb, {
      channel: 'org:1', entityType: 'student', entityId: 's-ok', op: 'CREATE',
      payload: { name: 'Fine' }, authorIdentityId: 'u1',
    });
    const bad = await enqueue(engineDb, {
      channel: 'org:1', entityType: 'student', entityId: 's-bad', op: 'CREATE',
      payload: { name: 'Nope' }, authorIdentityId: 'u1',
    });
    mockPushResponse(
      [{ id: ok.id, receivedAt: new Date().toISOString() }],
      [{ id: bad.id, reason: 'duplicate slug', code: 'SLUG_TAKEN' }],
    );

    const seen: Array<{ id: string; quarantined: boolean }> = [];
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName,
      channels: [],
      permanentRejectCodes: ['SLUG_TAKEN'],
      onReject: (rejection, _row, quarantined) => seen.push({ id: rejection.id, quarantined }),
    });
    await engine.sync();

    expect(seen).toEqual([{ id: bad.id, quarantined: true }]);
    // The rejected row left the push loop but is preserved in quarantine; the
    // accepted one was marked synced and purged by the end of the cycle.
    expect(await pending(engineDb)).toEqual([]);
    expect((await rejected(engineDb)).map((r) => r.id)).toEqual([bad.id]);
    expect(await engineDb._outbox.get(ok.id)).toBeUndefined();
    expect(await engineDb._history.get(ok.id)).toBeDefined(); // acked → recorded locally
  });

  it('a transient rejection is retried on a later cycle (after backoff), not instantly', async () => {
    const dbName = `test-engine-backoff-${Math.random()}`;
    const engineDb = openDatabase(dbName, { student: 'id, name' });
    const bad = await enqueue(engineDb, {
      channel: 'org:1', entityType: 'student', entityId: 's-slow', op: 'CREATE',
      payload: { name: 'Later' }, authorIdentityId: 'u1',
    });
    mockPushResponse([], [{ id: bad.id, reason: 'temporarily unavailable' }]);

    const engine = new SyncEngine({ baseUrl: 'http://test', dbName, channels: [] });
    await engine.sync();

    // Not quarantined, but backed off — the next immediate cycle must NOT re-push it.
    expect(await rejected(engineDb)).toEqual([]);
    expect(await pending(engineDb)).toEqual([]);
    const fetchMock = (globalThis as Record<string, unknown>).fetch as ReturnType<typeof vi.fn>;
    const callsAfterFirst = fetchMock.mock.calls.length;
    await engine.sync();
    // No pending rows → second cycle skips the push POST entirely.
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });
});
