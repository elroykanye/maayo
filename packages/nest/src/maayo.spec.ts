import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DuplicateMutationError, type Mutation } from '@maayo/protocol';
import { MutationsController } from './mutations.controller';
import { ChangesController } from './changes.controller';
import type { MaayoStore, SavedMutation } from './interfaces';
import type { MaayoModuleOptions } from './maayo.options';

const mutation = (id: string, channel = 'org:abc'): Mutation => ({
  id,
  channel,
  entityType: 'Student',
  entityId: 'uuid-1',
  op: 'CREATE',
  payload: '{}',
  authorIdentityId: 'user-1',
  deviceId: 'device-1',
  clientTs: new Date().toISOString(),
  parentIds: [],
});

const saved = (m: Mutation): SavedMutation => ({ mutation: m, receivedAt: new Date() });

function makeStore(overrides: Partial<MaayoStore> = {}): MaayoStore {
  return {
    existsById: vi.fn().mockResolvedValue(false),
    saveAll: vi.fn().mockImplementation((ms: Mutation[]) => Promise.resolve(ms.map(saved))),
    findChanges: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function makeOptions(store: MaayoStore, extra: Partial<MaayoModuleOptions> = {}): MaayoModuleOptions {
  return { store, ...extra };
}

describe('MutationsController', () => {
  it('accepts and saves a valid mutation', async () => {
    const store = makeStore();
    const ctrl = new MutationsController(makeOptions(store));
    const m = mutation('01ABCDEFGHJKMNPQRSTVWXYZ01');

    const result = await ctrl.push({ mutations: [m] }, null);

    expect(result.accepted).toHaveLength(1);
    expect(result.accepted[0].id).toBe(m.id);
    expect(result.rejected).toHaveLength(0);
    expect(store.saveAll).toHaveBeenCalledWith([m]);
  });

  it('rejects a mutation with blank id', async () => {
    const ctrl = new MutationsController(makeOptions(makeStore()));
    const result = await ctrl.push({ mutations: [mutation('')] }, null);

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].reason).toBe('id is required');
    expect(result.accepted).toHaveLength(0);
  });

  it('rejects the reserved system author before persistence', async () => {
    const store = makeStore();
    const ctrl = new MutationsController(makeOptions(store));
    const m = { ...mutation('01ABCDEFGHJKMNPQRSTVWXYZ02'), authorIdentityId: 'system' };

    const result = await ctrl.push({ mutations: [m] }, null);

    expect(result.accepted).toHaveLength(0);
    expect(result.rejected).toEqual([
      expect.objectContaining({ id: m.id, code: 'reserved_author' }),
    ]);
    expect(store.saveAll).not.toHaveBeenCalled();
  });

  it('acks an already-known mutation without saving again', async () => {
    const store = makeStore({ existsById: vi.fn().mockResolvedValue(true) });
    const ctrl = new MutationsController(makeOptions(store));
    const m = mutation('01ABCDEFGHJKMNPQRSTVWXYZ01');

    const result = await ctrl.push({ mutations: [m] }, null);

    expect(result.accepted).toHaveLength(1);
    expect(store.saveAll).not.toHaveBeenCalled();
  });

  it('rejects when authorizer denies push', async () => {
    const store = makeStore();
    const ctrl = new MutationsController(
      makeOptions(store, {
        authorizer: { canPush: () => false, canPull: () => true },
      }),
    );
    const m = mutation('01ABCDEFGHJKMNPQRSTVWXYZ01');

    const result = await ctrl.push({ mutations: [m] }, null);

    expect(result.rejected[0].reason).toContain('unauthorized');
    expect(store.saveAll).not.toHaveBeenCalled();
  });

  it('saves a duplicate id only once within one request', async () => {
    const store = makeStore();
    const ctrl = new MutationsController(makeOptions(store));
    const m = mutation('01ABCDEFGHJKMNPQRSTVWXYZ10');

    const result = await ctrl.push({ mutations: [m, m] }, null);

    expect(store.saveAll).toHaveBeenCalledWith([m]);
    expect(result.accepted).toHaveLength(1);
  });

  it('recovers a concurrent duplicate and still saves unrelated rows', async () => {
    const raced = mutation('01ABCDEFGHJKMNPQRSTVWXYZ11');
    const unrelated = mutation('01ABCDEFGHJKMNPQRSTVWXYZ12');
    const persisted = new Set<string>();
    const store = makeStore({
      existsById: vi.fn(async (id: string) => persisted.has(id)),
      saveAll: vi.fn()
        .mockImplementationOnce(async () => {
          persisted.add(raced.id);
          throw new DuplicateMutationError();
        })
        .mockImplementation(async (ms: Mutation[]) => {
          ms.forEach((m) => persisted.add(m.id));
          return ms.map(saved);
        }),
    });
    const ctrl = new MutationsController(makeOptions(store));

    const result = await ctrl.push({ mutations: [raced, unrelated] }, null);

    expect(store.saveAll).toHaveBeenNthCalledWith(2, [unrelated]);
    expect(result.accepted).toHaveLength(2);
  });

  it('does not hide an unrelated persistence failure', async () => {
    const failure = new Error('database offline');
    const store = makeStore({ saveAll: vi.fn().mockRejectedValue(failure) });
    const ctrl = new MutationsController(makeOptions(store));

    await expect(ctrl.push({
      mutations: [mutation('01ABCDEFGHJKMNPQRSTVWXYZ13')],
    }, null)).rejects.toBe(failure);
  });

  it('does not hide an unrelated failure when a coincidental id appears concurrently', async () => {
    const raced = mutation('01ABCDEFGHJKMNPQRSTVWXYZ14');
    const unrelated = mutation('01ABCDEFGHJKMNPQRSTVWXYZ15');
    const failure = new Error('database offline');
    const persisted = new Set<string>();
    const saveAll = vi.fn(async (mutations: Mutation[]) => {
      if (saveAll.mock.calls.length === 1) {
        persisted.add(raced.id);
        throw failure;
      }
      mutations.forEach((mutation) => persisted.add(mutation.id));
      return mutations.map(saved);
    });
    const store = makeStore({
      existsById: vi.fn(async (id: string) => persisted.has(id)),
      saveAll,
    });
    const ctrl = new MutationsController(makeOptions(store));

    await expect(ctrl.push({ mutations: [raced, unrelated] }, null)).rejects.toBe(failure);
    expect(saveAll).toHaveBeenCalledTimes(1);
    expect(persisted.has(unrelated.id)).toBe(false);
  });
});

describe('ChangesController', () => {
  let store: MaayoStore;
  let ctrl: ChangesController;

  beforeEach(() => {
    store = makeStore();
    ctrl = new ChangesController(makeOptions(store));
  });

  it('returns empty page when store has no changes', async () => {
    const result = await ctrl.pull('org:abc');

    expect(result.channel).toBe('org:abc');
    expect(result.mutations).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.cursor).toEqual({ lastMutationId: null, lastReceivedAt: null });
  });

  it('passes since and limit+1 to store for pagination probe', async () => {
    await ctrl.pull('org:abc', '2026-01-01T00:00:00Z', '10');

    expect(store.findChanges).toHaveBeenCalledWith(
      'org:abc',
      new Date('2026-01-01T00:00:00Z'),
      11,
    );
  });

  it('sets hasMore and slices when store returns limit+1 rows', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => saved(mutation(`id-${i}`)));
    store = makeStore({ findChanges: vi.fn().mockResolvedValue(rows) });
    ctrl = new ChangesController(makeOptions(store, { defaultLimit: 5 }));

    const result = await ctrl.pull('org:abc', undefined, '5');

    expect(result.hasMore).toBe(true);
    expect(result.mutations).toHaveLength(5);
  });

  it('builds cursor from last row', async () => {
    const m = mutation('01ABCDEFGHJKMNPQRSTVWXYZ01');
    const ts = new Date('2026-05-01T12:00:00Z');
    store = makeStore({ findChanges: vi.fn().mockResolvedValue([{ mutation: m, receivedAt: ts }]) });
    ctrl = new ChangesController(makeOptions(store));

    const result = await ctrl.pull('org:abc');

    expect(result.cursor.lastMutationId).toBe(m.id);
    expect(result.cursor.lastReceivedAt).toBe(ts.toISOString());
  });

  it('throws ForbiddenException when authorizer denies pull', async () => {
    ctrl = new ChangesController(
      makeOptions(store, {
        authorizer: { canPush: () => true, canPull: () => false },
      }),
    );

    await expect(ctrl.pull('org:abc')).rejects.toThrow('unauthorized');
  });
});
