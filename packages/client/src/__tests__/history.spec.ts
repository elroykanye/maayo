import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { openDatabase } from '../database';
import { enqueue, markSynced, purgeSynced } from '../outbox';
import type { MaayoDatabase } from '../database';

let db: MaayoDatabase;

beforeEach(() => {
  db = openDatabase(`test-history-${Math.random()}`, { student: 'id, name' });
});

describe('local mutation history', () => {
  it('appears in _history after markSynced', async () => {
    const row = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'stu-1',
      op: 'CREATE', payload: { id: 'stu-1', name: 'Ada' }, authorIdentityId: 'u1',
    });

    await markSynced(db, [row.id], new Date().toISOString());

    const entries = await db._history.where('[entityType+entityId]').equals(['Student', 'stu-1']).toArray();
    expect(entries).toHaveLength(1);
    expect(entries[0].id).toBe(row.id);
    expect(entries[0].source).toBe('local');
    expect(entries[0].op).toBe('CREATE');
  });

  it('persists in _history after purgeSynced removes outbox row', async () => {
    const row = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'stu-2',
      op: 'UPDATE', payload: { id: 'stu-2', name: 'Grace' }, authorIdentityId: 'u1',
    });

    await markSynced(db, [row.id], new Date().toISOString());
    await purgeSynced(db);

    expect(await db._outbox.count()).toBe(0);
    const entries = await db._history.where('[entityType+entityId]').equals(['Student', 'stu-2']).toArray();
    expect(entries).toHaveLength(1);
  });

  it('returns multiple mutations for same record in order', async () => {
    const a = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'stu-3',
      op: 'CREATE', payload: { id: 'stu-3', name: 'Alan' }, authorIdentityId: 'u1',
    });
    const b = await enqueue(db, {
      channel: 'org:1', entityType: 'Student', entityId: 'stu-3',
      op: 'UPDATE', payload: { id: 'stu-3', name: 'Alan T.' }, authorIdentityId: 'u1',
    });

    const receivedAt = new Date().toISOString();
    await markSynced(db, [a.id, b.id], receivedAt);

    const entries = await db._history
      .where('[entityType+entityId]').equals(['Student', 'stu-3'])
      .sortBy('clientTs');
    expect(entries).toHaveLength(2);
    expect(entries[0].op).toBe('CREATE');
    expect(entries[1].op).toBe('UPDATE');
  });
});

describe('schema migrations', () => {
  it('opens successfully with a version-only migration', async () => {
    const migratedDb = openDatabase(
      `test-migrations-${Math.random()}`,
      { student: 'id, name' },
      [{ version: 1 }],
    );
    await expect(migratedDb.open()).resolves.toBeDefined();
    migratedDb.close();
  });

  it('opens successfully with stores + up migration', async () => {
    const migratedDb = openDatabase(
      `test-migrations-stores-${Math.random()}`,
      { student: 'id, name' },
      [{ version: 1, stores: { student: 'id, name, grade' }, up: () => {} }],
    );
    await expect(migratedDb.open()).resolves.toBeDefined();
    migratedDb.close();
  });

  it('opens successfully with multiple migrations', async () => {
    const migratedDb = openDatabase(
      `test-migrations-multi-${Math.random()}`,
      { student: 'id, name' },
      [{ version: 1 }, { version: 2, stores: { classes: 'id, name' } }],
    );
    await expect(migratedDb.open()).resolves.toBeDefined();
    migratedDb.close();
  });
});
