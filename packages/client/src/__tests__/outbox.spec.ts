import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDatabase } from '../database';
import { enqueue, pending, markSynced, purgeSynced } from '../outbox';
import type { MaayoDatabase } from '../database';

let db: MaayoDatabase;

beforeEach(() => {
  db = openDatabase(`test-outbox-${Math.random()}`, {
    student: 'id, name',
  });
});

describe('enqueue', () => {
  it('adds a row to _outbox with a ULID id', async () => {
    const row = await enqueue(db, {
      channel: 'org:1/school:2',
      entityType: 'Student',
      entityId: 'stu-1',
      op: 'CREATE',
      payload: { id: 'stu-1', name: 'Ada' },
      authorIdentityId: 'user-1',
    });
    expect(row.id).toHaveLength(26);
    expect(row.op).toBe('CREATE');
    const all = await db._outbox.toArray();
    expect(all).toHaveLength(1);
  });
});

describe('pending', () => {
  it('returns only unsynced rows', async () => {
    const a = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'a', op: 'CREATE',
      payload: {}, authorIdentityId: 'u',
    });
    const b = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'b', op: 'UPDATE',
      payload: {}, authorIdentityId: 'u',
    });
    await markSynced(db, [a.id], new Date().toISOString());
    const rows = await pending(db);
    expect(rows.map((r) => r.id)).toEqual([b.id]);
  });
});

describe('purgeSynced', () => {
  it('deletes rows that have syncedAt set', async () => {
    const row = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'x', op: 'DELETE',
      payload: {}, authorIdentityId: 'u',
    });
    await markSynced(db, [row.id], new Date().toISOString());
    const deleted = await purgeSynced(db);
    expect(deleted).toBe(1);
    expect(await db._outbox.count()).toBe(0);
  });
});
