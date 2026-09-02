import { describe, expect, it } from 'vitest';
import 'fake-indexeddb/auto';
import { openDatabase } from '../database';

describe('openDatabase registry lifecycle', () => {
  it('returns a fresh operational handle after the registered database closes', async () => {
    const name = `test-reopen-${Math.random()}`;
    const first = openDatabase(name, { student: 'id, name' });
    await first.table('student').put({ id: 'student-1', name: 'Ada' });
    first.close({ disableAutoOpen: true });

    const reopened = openDatabase(name, { student: 'id, name' });

    expect(reopened).not.toBe(first);
    await expect(reopened.table('student').get('student-1')).resolves.toEqual({
      id: 'student-1',
      name: 'Ada',
    });
  });

  it('rejects incompatible configuration while a registered handle is live', async () => {
    const name = `test-live-config-${Math.random()}`;
    const live = openDatabase(name, { student: 'id, name' });
    await live.open();

    expect(() => openDatabase(name, { teacher: 'id, name' })).toThrow(/configuration/i);
    live.close();
  });

  it('applies current migrations when recreating a closed handle', async () => {
    const name = `test-reopen-migration-${Math.random()}`;
    const first = openDatabase(name, { student: 'id, name' });
    await first.open();
    first.close({ disableAutoOpen: true });

    const reopened = openDatabase(
      name,
      { student: 'id, name' },
      [{ version: 1, stores: { student: 'id, name, grade' } }],
    );
    await reopened.open();

    expect(reopened.table('student').schema.indexes.map((index) => index.name)).toContain('grade');
    reopened.close();
  });
});
