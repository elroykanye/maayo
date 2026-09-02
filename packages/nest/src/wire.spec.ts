import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import { DuplicateMutationError, type BatchMutationsResponse, type ChangesResponse, type Mutation } from '@maayo/protocol';
import type { ChannelAuthorizer, MaayoStore, SavedMutation } from './interfaces';
import { MaayoModule } from './maayo.module';

const applications: INestApplication[] = [];

afterEach(async () => {
  await Promise.all(applications.splice(0).map((application) => application.close()));
});

describe('MaayoModule HTTP boundary', () => {
  it('rejects the reserved system author before persistence over HTTP', async () => {
    const store = new ConcurrentUniqueStore();
    const baseUrl = await startApplication(store);
    const mutation = makeMutation('01ABCDEFGHJKMNPQRSTVWXYZ90', 'system');

    const response = await postMutations(baseUrl, [mutation]);

    expect(response.status).toBe(201);
    expect(response.body).toMatchObject({
      accepted: [],
      rejected: [{ id: mutation.id, code: 'reserved_author' }],
    });
    expect(store.saveCalls).toBe(0);
    expect(store.persisted.size).toBe(0);
  });

  it('acknowledges simultaneous duplicate HTTP requests and preserves unrelated rows', async () => {
    const store = new ConcurrentUniqueStore(true);
    const baseUrl = await startApplication(store);
    const raced = makeMutation('01ABCDEFGHJKMNPQRSTVWXYZ91');
    const unrelated = makeMutation('01ABCDEFGHJKMNPQRSTVWXYZ92');

    const [first, second] = await Promise.all([
      postMutations(baseUrl, [raced]),
      postMutations(baseUrl, [raced, unrelated]),
    ]);

    expect([first.status, second.status]).toEqual([201, 201]);
    expect(first.body.accepted.map(({ id }) => id)).toContain(raced.id);
    expect(second.body.accepted.map(({ id }) => id).sort()).toEqual([raced.id, unrelated.id].sort());
    expect([...store.persisted.keys()].sort()).toEqual([raced.id, unrelated.id].sort());
  });

  it('uses one coherent first-entry outcome for conflicting duplicate IDs', async () => {
    const store = new ConcurrentUniqueStore();
    const authorizer: ChannelAuthorizer = {
      canPush: (_request, channel) => channel !== 'forbidden',
      canPull: () => true,
    };
    const baseUrl = await startApplication(store, authorizer);
    const deniedId = '01ABCDEFGHJKMNPQRSTVWXYZ93';
    const reservedId = '01ABCDEFGHJKMNPQRSTVWXYZ94';

    const response = await postMutations(baseUrl, [
      { ...makeMutation(deniedId), channel: 'forbidden' },
      { ...makeMutation(deniedId), channel: 'allowed' },
      { ...makeMutation(reservedId), channel: 'allowed', authorIdentityId: 'system' },
      { ...makeMutation(reservedId), channel: 'allowed' },
    ]);

    expect(response.status).toBe(201);
    expect(response.body.accepted).toEqual([]);
    expect(response.body.rejected.map(({ id }) => id)).toEqual([deniedId, reservedId]);
    expect(store.saveCalls).toBe(0);
    expect(store.persisted.size).toBe(0);
  });

  it('rejects a timestamp-only continuation over HTTP', async () => {
    const baseUrl = await startApplication(new ConcurrentUniqueStore());
    const response = await fetch(
      `${baseUrl}/sync/changes?channel=org%3Awire&since=2026-09-02T00%3A00%3A00.000Z`,
    );

    expect(response.status).toBe(400);
  });

  it('rejects an invalid continuation timestamp over HTTP', async () => {
    const baseUrl = await startApplication(new TiedCursorStore());
    const response = await fetch(
      `${baseUrl}/sync/changes?channel=org%3Awire&since=not-a-date&lastMutationId=01ABCDEFGHJKMNPQRSTVWXYZA1`,
    );

    expect(response.status).toBe(400);
  });

  it('fails explicitly when a legacy store receives a compound continuation', async () => {
    const baseUrl = await startApplication(new ConcurrentUniqueStore());
    const response = await fetch(
      `${baseUrl}/sync/changes?channel=org%3Awire&since=2026-09-02T00%3A00%3A00.000Z&lastMutationId=01ABCDEFGHJKMNPQRSTVWXYZA1`,
    );

    expect(response.status).toBe(501);
  });

  it('pages tied timestamps exactly once through the compound store seam', async () => {
    const store = new TiedCursorStore();
    const baseUrl = await startApplication(store);
    const received: string[] = [];
    let since: string | null = null;
    let lastMutationId: string | null = null;
    let hasMore = true;

    while (hasMore && received.length <= store.ids.length) {
      const params = new URLSearchParams({ channel: 'org:cursor', limit: '1' });
      if (since) params.set('since', since);
      if (lastMutationId) params.set('lastMutationId', lastMutationId);
      const response = await fetch(`${baseUrl}/sync/changes?${params}`);
      expect(response.status).toBe(200);
      const body = await response.json() as ChangesResponse;
      received.push(...body.mutations.map(({ id }) => id));
      since = body.cursor.lastReceivedAt;
      lastMutationId = body.cursor.lastMutationId;
      hasMore = body.hasMore;
    }

    expect(received).toEqual(store.ids);
    expect(new Set(received).size).toBe(store.ids.length);
  });
});

async function startApplication(store: MaayoStore, authorizer?: ChannelAuthorizer): Promise<string> {
  const application = await NestFactory.create(MaayoModule.forRoot({ store, authorizer }), { logger: false });
  applications.push(application);
  await application.listen(0, '127.0.0.1');
  const address = application.getHttpServer().address();
  if (!address || typeof address === 'string') throw new Error('Nest test server has no TCP address');
  return `http://127.0.0.1:${address.port}`;
}

async function postMutations(baseUrl: string, mutations: Mutation[]) {
  const response = await fetch(`${baseUrl}/sync/mutations`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mutations }),
  });
  return {
    status: response.status,
    body: await response.json() as BatchMutationsResponse,
  };
}

function makeMutation(id: string, authorIdentityId = 'user-1'): Mutation {
  return {
    id,
    channel: 'org:wire',
    entityType: 'Student',
    entityId: `student-${id}`,
    op: 'CREATE',
    payload: '{}',
    authorIdentityId,
    deviceId: 'device-1',
    clientTs: '2026-08-30T12:00:00Z',
    parentIds: [],
  };
}

class ConcurrentUniqueStore implements MaayoStore {
  readonly persisted = new Map<string, SavedMutation>();
  saveCalls = 0;
  private arrivals = 0;
  private releaseGate!: () => void;
  private readonly gate = new Promise<void>((resolve) => { this.releaseGate = resolve; });

  constructor(private readonly synchronizeFirstTwoSaves = false) {}

  async existsById(id: string): Promise<boolean> {
    return this.persisted.has(id);
  }

  async saveAll(mutations: Mutation[]): Promise<SavedMutation[]> {
    this.saveCalls++;
    if (this.synchronizeFirstTwoSaves && this.arrivals < 2) {
      this.arrivals++;
      if (this.arrivals === 2) this.releaseGate();
      await this.gate;
    }
    if (mutations.some(({ id }) => this.persisted.has(id))) {
      throw new DuplicateMutationError();
    }
    const rows = mutations.map((mutation) => ({ mutation, receivedAt: new Date() }));
    rows.forEach((row) => this.persisted.set(row.mutation.id, row));
    return rows;
  }

  async findChanges(): Promise<SavedMutation[]> {
    return [];
  }
}

class TiedCursorStore implements MaayoStore {
  readonly ids = [
    '01ABCDEFGHJKMNPQRSTVWXYZA1',
    '01ABCDEFGHJKMNPQRSTVWXYZA2',
    '01ABCDEFGHJKMNPQRSTVWXYZA3',
  ];
  private readonly receivedAt = new Date('2026-09-02T00:00:00.000Z');
  private readonly rows = this.ids.map((id) => ({ mutation: makeMutation(id), receivedAt: this.receivedAt }));

  async existsById(): Promise<boolean> { return false; }
  async saveAll(): Promise<SavedMutation[]> { return []; }
  async findChanges(_channel: string, since: Date | null, limit: number): Promise<SavedMutation[]> {
    return this.rows.filter((row) => !since || row.receivedAt > since).slice(0, limit);
  }
  async findChangesByCursor(
    _channel: string,
    since: Date,
    lastMutationId: string,
    limit: number,
  ): Promise<SavedMutation[]> {
    return this.rows.filter((row) => (
      row.receivedAt > since
      || (row.receivedAt.getTime() === since.getTime() && row.mutation.id > lastMutationId)
    )).slice(0, limit);
  }
}
