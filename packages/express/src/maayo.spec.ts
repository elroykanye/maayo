import { describe, it, expect, vi } from 'vitest';
import { DuplicateMutationError, type Mutation } from '@maayo/protocol';
import type { MaayoStore, SavedMutation } from './interfaces';
import { maayoRouter } from './router';

const mutation = (id: string): Mutation => ({
  id, channel: 'org:abc', entityType: 'Student', entityId: 'u1',
  op: 'CREATE', payload: '{}', authorIdentityId: 'user-1',
  deviceId: 'dev-1', clientTs: new Date().toISOString(), parentIds: [],
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

type FakeRes = { _data: { status?: number; body?: unknown }; json: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn> };
type RouteLayer = { route: { stack: [{ handle: Function }] } };

function mockReq(body: unknown = {}, query: Record<string, string> = {}) {
  return { body, query } as unknown;
}

function mockRes(): FakeRes {
  const data: { status?: number; body?: unknown } = {};
  return {
    _data: data,
    json: vi.fn((b) => { data.body = b; }),
    status: vi.fn().mockReturnThis(),
  };
}

describe('maayoRouter — POST /mutations', () => {
  it('saves and accepts valid mutations', async () => {
    const store = makeStore();
    const router = maayoRouter({ store });
    const m = mutation('01ULID0000000000000000001');

    // Call the handler directly
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;
    const req = mockReq({ mutations: [m] });
    const res = mockRes();
    await handler(req, res);

    expect(res._data.body).toMatchObject({
      accepted: [{ id: m.id }],
      rejected: [],
    });
  });

  it('rejects mutation with blank id', async () => {
    const router = maayoRouter({ store: makeStore() });
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;
    const req = mockReq({ mutations: [mutation('')] });
    const res = mockRes();
    await handler(req, res);

    expect(res._data.body).toMatchObject({ rejected: [{ reason: 'id is required' }] });
  });

  it('rejects the reserved system author before persistence', async () => {
    const store = makeStore();
    const router = maayoRouter({ store });
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;
    const m = { ...mutation('01ULID0000000000000000002'), authorIdentityId: 'system' };
    const res = mockRes();

    await handler(mockReq({ mutations: [m] }), res);

    expect(res._data.body).toMatchObject({
      accepted: [],
      rejected: [{ id: m.id, code: 'reserved_author' }],
    });
    expect(store.saveAll).not.toHaveBeenCalled();
  });

  it('acks already-known id without re-saving', async () => {
    const store = makeStore({ existsById: vi.fn().mockResolvedValue(true) });
    const router = maayoRouter({ store });
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;
    const req = mockReq({ mutations: [mutation('01ULID0000000000000000001')] });
    const res = mockRes();
    await handler(req, res);

    expect(store.saveAll).not.toHaveBeenCalled();
    expect((res._data.body as Record<string, unknown[]>).accepted).toHaveLength(1);
  });

  it('saves a duplicate id only once within one request', async () => {
    const store = makeStore();
    const router = maayoRouter({ store });
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;
    const m = mutation('01ULID0000000000000000010');
    const res = mockRes();

    await handler(mockReq({ mutations: [m, m] }), res);

    expect(store.saveAll).toHaveBeenCalledWith([m]);
    expect((res._data.body as Record<string, unknown[]>).accepted).toHaveLength(1);
  });

  it('recovers a concurrent duplicate and still saves unrelated rows', async () => {
    const raced = mutation('01ULID0000000000000000011');
    const unrelated = mutation('01ULID0000000000000000012');
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
    const router = maayoRouter({ store });
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;
    const res = mockRes();

    await handler(mockReq({ mutations: [raced, unrelated] }), res);

    expect(store.saveAll).toHaveBeenNthCalledWith(2, [unrelated]);
    expect((res._data.body as Record<string, unknown[]>).accepted).toHaveLength(2);
  });

  it('recovers repeated duplicate races and still saves unrelated rows', async () => {
    const first = mutation('01ULID0000000000000000021');
    const second = mutation('01ULID0000000000000000022');
    const unrelated = mutation('01ULID0000000000000000023');
    const persisted = new Set<string>();
    const saveAll = vi.fn(async (mutations: Mutation[]) => {
      if (saveAll.mock.calls.length === 1) {
        persisted.add(first.id);
        throw new DuplicateMutationError();
      }
      if (saveAll.mock.calls.length === 2) {
        persisted.add(second.id);
        throw new DuplicateMutationError();
      }
      mutations.forEach((item) => persisted.add(item.id));
      return mutations.map(saved);
    });
    const store = makeStore({
      existsById: vi.fn(async (id: string) => persisted.has(id)),
      saveAll,
    });
    const router = maayoRouter({ store });
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;
    const res = mockRes();

    await handler(mockReq({ mutations: [first, second, unrelated] }), res);

    expect(saveAll).toHaveBeenNthCalledWith(2, [second, unrelated]);
    expect(saveAll).toHaveBeenNthCalledWith(3, [unrelated]);
    expect((res._data.body as Record<string, unknown[]>).accepted).toHaveLength(3);
  });

  it('does not hide an unrelated persistence failure', async () => {
    const failure = new Error('database offline');
    const store = makeStore({ saveAll: vi.fn().mockRejectedValue(failure) });
    const router = maayoRouter({ store });
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;

    await expect(handler(
      mockReq({ mutations: [mutation('01ULID0000000000000000013')] }),
      mockRes(),
    )).rejects.toBe(failure);
  });

  it('does not hide an unrelated failure when a coincidental id appears concurrently', async () => {
    const raced = mutation('01ULID0000000000000000014');
    const unrelated = mutation('01ULID0000000000000000015');
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
    const router = maayoRouter({ store });
    const handler = (router.stack[0] as unknown as RouteLayer).route.stack[0].handle;

    await expect(handler(
      mockReq({ mutations: [raced, unrelated] }),
      mockRes(),
    )).rejects.toBe(failure);
    expect(saveAll).toHaveBeenCalledTimes(1);
    expect(persisted.has(unrelated.id)).toBe(false);
  });
});

describe('maayoRouter — GET /changes', () => {
  it('returns empty response when store has no rows', async () => {
    const router = maayoRouter({ store: makeStore() });
    const handler = (router.stack[1] as unknown as RouteLayer).route.stack[0].handle;
    const req = mockReq({}, { channel: 'org:abc' });
    const res = mockRes();
    await handler(req, res);

    expect(res._data.body).toMatchObject({
      channel: 'org:abc', mutations: [], hasMore: false,
    });
  });

  it('passes limit+1 to store for pagination probe', async () => {
    const store = makeStore();
    const router = maayoRouter({ store });
    const handler = (router.stack[1] as unknown as RouteLayer).route.stack[0].handle;
    await handler(mockReq({}, { channel: 'org:abc', limit: '10' }), mockRes());
    expect(store.findChanges).toHaveBeenCalledWith('org:abc', null, 11);
  });

  it('sets hasMore when store returns limit+1 rows', async () => {
    const rows = Array.from({ length: 6 }, (_, i) => saved(mutation(`id-${i}`)));
    const store = makeStore({ findChanges: vi.fn().mockResolvedValue(rows) });
    const router = maayoRouter({ store, defaultLimit: 5 });
    const handler = (router.stack[1] as unknown as RouteLayer).route.stack[0].handle;
    const res = mockRes();
    await handler(mockReq({}, { channel: 'org:abc', limit: '5' }), res);
    expect(res._data.body).toMatchObject({ hasMore: true, mutations: expect.arrayContaining([]) });
    expect((res._data.body as Record<string, unknown[]>).mutations).toHaveLength(5);
  });
});
