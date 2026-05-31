import { describe, it, expect, vi } from 'vitest';
import type { Mutation } from '@maayo/protocol';
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
