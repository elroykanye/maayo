import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { afterEach, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import type { BatchMutationsResponse, Mutation } from '@maayo/protocol';
import type { MaayoStore, SavedMutation } from './interfaces';
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
});

async function startApplication(store: MaayoStore): Promise<string> {
  const application = await NestFactory.create(MaayoModule.forRoot({ store }), { logger: false });
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
      throw new Error('unique constraint');
    }
    const rows = mutations.map((mutation) => ({ mutation, receivedAt: new Date() }));
    rows.forEach((row) => this.persisted.set(row.mutation.id, row));
    return rows;
  }

  async findChanges(): Promise<SavedMutation[]> {
    return [];
  }
}
