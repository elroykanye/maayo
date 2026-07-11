import { describe, it, expect, beforeEach, vi } from 'vitest';
import 'fake-indexeddb/auto';
import type { Mutation, SyncPolicy } from '@maayo/protocol';
import { openDatabase } from '../database';
import type { MaayoDatabase } from '../database';
import { pull } from '../pull';
import { policyApply } from '../policies';
import { assertConverges, checkConvergence, foldPolicies } from '../testing';

const POLICIES: Record<string, SyncPolicy> = {
  Course: 'LWW',
  Identity: 'FIELD_LWW',
  Payment: 'APPEND_ONLY',
  Enrollment: 'OR_SET',
  Grade: 'MANUAL',
};
const policyFor = (t: string): SyncPolicy => POLICIES[t] ?? 'LWW';
const fold = (ms: Mutation[]) => foldPolicies(ms, policyFor);

let seq = 0;
function mut(partial: Partial<Mutation> & { entityType: string; entityId: string; op: Mutation['op'] }): Mutation {
  seq += 1;
  return {
    id: partial.id ?? `m${String(seq).padStart(4, '0')}`,
    channel: 'org:1',
    entityType: partial.entityType,
    entityId: partial.entityId,
    op: partial.op,
    payload: partial.payload ?? '{}',
    authorIdentityId: partial.authorIdentityId ?? 'user-1',
    deviceId: partial.deviceId ?? 'devA',
    clientTs: partial.clientTs ?? `2026-07-09T00:00:${String(seq % 60).padStart(2, '0')}.000Z`,
    parentIds: partial.parentIds ?? [],
  };
}

describe('policy fold convergence (order-independence per policy)', () => {
  it('LWW: equal timestamps tie-break deterministically on (deviceId, id)', () => {
    const ts = '2026-07-09T10:00:00.000Z';
    const state = assertConverges(
      [
        mut({ entityType: 'Course', entityId: 'c1', op: 'UPDATE', clientTs: ts, deviceId: 'A', id: 'x1', payload: '{"title":"fromA"}' }),
        mut({ entityType: 'Course', entityId: 'c1', op: 'UPDATE', clientTs: ts, deviceId: 'B', id: 'x2', payload: '{"title":"fromB"}' }),
      ],
      fold,
    );
    expect(state['Course#c1'].row?.['title']).toBe('fromB');
  });

  it('LWW: a stale DELETE loses; a winning DELETE leaves a deterministic tombstone', () => {
    const state = assertConverges(
      [
        mut({ entityType: 'Course', entityId: 'c2', op: 'CREATE', clientTs: '2026-07-09T10:00:00.000Z', payload: '{"title":"A"}' }),
        mut({ entityType: 'Course', entityId: 'c2', op: 'DELETE', clientTs: '2026-07-09T10:00:05.000Z' }),
        mut({ entityType: 'Course', entityId: 'c2', op: 'UPDATE', clientTs: '2026-07-09T10:00:09.000Z', payload: '{"title":"survivor"}' }),
      ],
      fold,
    );
    expect(state['Course#c2'].row?.['title']).toBe('survivor');
    expect(state['Course#c2'].row?.['deletedAt']).toBeNull();
  });

  it('FIELD_LWW: concurrent edits to DIFFERENT fields both survive', () => {
    const state = assertConverges(
      [
        mut({ entityType: 'Identity', entityId: 'i1', op: 'CREATE', clientTs: '2026-07-09T10:00:00.000Z', payload: '{"name":"Ada","email":"old@x.io"}' }),
        mut({ entityType: 'Identity', entityId: 'i1', op: 'PATCH', deviceId: 'A', clientTs: '2026-07-09T10:00:05.000Z', payload: '{"name":"Ada Lovelace"}' }),
        mut({ entityType: 'Identity', entityId: 'i1', op: 'PATCH', deviceId: 'B', clientTs: '2026-07-09T10:00:07.000Z', payload: '{"email":"ada@x.io"}' }),
      ],
      fold,
    );
    expect(state['Identity#i1'].row?.['name']).toBe('Ada Lovelace');
    expect(state['Identity#i1'].row?.['email']).toBe('ada@x.io');
  });

  it('APPEND_ONLY: the ledger is immutable; colliding CREATEs pick the earliest', () => {
    const state = assertConverges(
      [
        mut({ entityType: 'Payment', entityId: 'p1', op: 'CREATE', id: 'later', clientTs: '2026-07-09T10:00:05.000Z', payload: '{"amount":2}' }),
        mut({ entityType: 'Payment', entityId: 'p1', op: 'CREATE', id: 'early', clientTs: '2026-07-09T10:00:01.000Z', payload: '{"amount":1}' }),
        mut({ entityType: 'Payment', entityId: 'p1', op: 'UPDATE', clientTs: '2026-07-09T10:00:09.000Z', payload: '{"amount":999}' }),
        mut({ entityType: 'Payment', entityId: 'p1', op: 'DELETE', clientTs: '2026-07-09T10:00:10.000Z' }),
      ],
      fold,
    );
    expect(state['Payment#p1'].row?.['amount']).toBe(1);
  });

  it('OR_SET: an unobserved concurrent re-add survives the remove (add-wins)', () => {
    const state = assertConverges(
      [
        mut({ entityType: 'Enrollment', entityId: 'e1', op: 'CREATE', id: 'add1', clientTs: '2026-07-09T10:00:00.000Z', payload: '{"status":"ACTIVE"}' }),
        mut({ entityType: 'Enrollment', entityId: 'e1', op: 'DELETE', id: 'rm1', clientTs: '2026-07-09T10:00:05.000Z', parentIds: ['add1'] }),
        mut({ entityType: 'Enrollment', entityId: 'e1', op: 'CREATE', id: 'add2', deviceId: 'B', clientTs: '2026-07-09T10:00:03.000Z', payload: '{"status":"ACTIVE"}' }),
      ],
      fold,
    );
    expect(state['Enrollment#e1'].row?.['deletedAt']).toBeNull();
  });

  it('OR_SET: a remove that observed every add tombstones the element', () => {
    const state = assertConverges(
      [
        mut({ entityType: 'Enrollment', entityId: 'e2', op: 'CREATE', id: 'a1', clientTs: '2026-07-09T10:00:00.000Z', payload: '{"status":"ACTIVE"}' }),
        mut({ entityType: 'Enrollment', entityId: 'e2', op: 'DELETE', id: 'r1', clientTs: '2026-07-09T10:00:05.000Z', parentIds: ['a1'] }),
      ],
      fold,
    );
    expect(state['Enrollment#e2'].row?.['deletedAt']).toBe('2026-07-09T10:00:05.000Z');
  });

  it('MANUAL: concurrent differing writes flag a conflict on every replica; an observing write clears it', () => {
    const base = mut({ entityType: 'Grade', entityId: 'g1', op: 'CREATE', id: 'g0', clientTs: '2026-07-09T10:00:00.000Z', payload: '{"value":10}' });
    const w1 = mut({ entityType: 'Grade', entityId: 'g1', op: 'UPDATE', id: 'w1', deviceId: 'A', clientTs: '2026-07-09T10:00:05.000Z', parentIds: ['g0'], payload: '{"value":14}' });
    const w2 = mut({ entityType: 'Grade', entityId: 'g1', op: 'UPDATE', id: 'w2', deviceId: 'B', clientTs: '2026-07-09T10:00:07.000Z', parentIds: ['g0'], payload: '{"value":16}' });

    const conflicted = assertConverges([base, w1, w2], fold);
    expect(conflicted['Grade#g1'].row?.['value']).toBe(16);
    expect(conflicted['Grade#g1'].row?.['hasConflict']).toBe(true);
    expect(JSON.parse(String(conflicted['Grade#g1'].row?.['conflictPayload']))).toEqual({ value: 14 });

    const fix = mut({ entityType: 'Grade', entityId: 'g1', op: 'UPDATE', id: 'w3', deviceId: 'A', clientTs: '2026-07-09T10:00:11.000Z', parentIds: ['w1', 'w2'], payload: '{"value":15}' });
    const resolved = assertConverges([base, w1, w2, fix], fold);
    expect(resolved['Grade#g1'].row?.['hasConflict']).toBe(false);
    expect(resolved['Grade#g1'].row?.['value']).toBe(15);
  });

  it('the harness detects a non-convergent merge (sanity check)', () => {
    // First-arrival-wins is the classic divergent merge.
    const firstArrivalWins = (ms: Mutation[]) => {
      const rows = new Map<string, Record<string, unknown>>();
      for (const m of ms) {
        const k = `${m.entityType}#${m.entityId}`;
        if (!rows.has(k)) rows.set(k, JSON.parse(m.payload));
      }
      return Object.fromEntries(
        [...rows.entries()].map(([k, row]) => [k, { entityType: k.split('#')[0], entityId: k.split('#')[1], row }]),
      );
    };
    const report = checkConvergence(
      [
        mut({ entityType: 'Course', entityId: 'c9', op: 'UPDATE', payload: '{"v":1}' }),
        mut({ entityType: 'Course', entityId: 'c9', op: 'UPDATE', payload: '{"v":2}' }),
      ],
      firstArrivalWins,
    );
    expect(report.converged).toBe(false);
  });
});

describe('policyApply hook against Dexie (via pull)', () => {
  let db: MaayoDatabase;

  beforeEach(() => {
    db = openDatabase(`test-policies-${Math.random()}`, {
      Payment: 'id',
      Enrollment: 'id',
      _syncmeta: 'key',
    });
  });

  async function callPull(mutations: Mutation[]) {
    (globalThis as Record<string, unknown>).fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        channel: 'org:1',
        mutations,
        hasMore: false,
        cursor: { lastReceivedAt: new Date().toISOString() },
      }),
    } as Response);
    return pull(db, { baseUrl: 'http://test', channel: 'org:1', applyMutation: policyApply({ policyFor }) });
  }

  it('APPEND_ONLY rows are immutable under pull', async () => {
    await callPull([
      mut({ entityType: 'Payment', entityId: 'p1', op: 'CREATE', clientTs: '2026-07-09T10:00:00.000Z', payload: '{"amount":100}' }),
      mut({ entityType: 'Payment', entityId: 'p1', op: 'UPDATE', clientTs: '2026-07-09T10:00:05.000Z', payload: '{"amount":999}' }),
      mut({ entityType: 'Payment', entityId: 'p1', op: 'DELETE', clientTs: '2026-07-09T10:00:09.000Z' }),
    ]);
    const row = await db.table('Payment').get('p1');
    expect(row.amount).toBe(100);
    expect(row.deletedAt).toBeUndefined();
  });

  it('OR_SET re-add survives a remove that arrives after it (bookkeeping in _syncmeta)', async () => {
    await callPull([
      mut({ entityType: 'Enrollment', entityId: 'e1', op: 'CREATE', id: 'add1', clientTs: '2026-07-09T10:00:00.000Z', payload: '{"status":"ACTIVE"}' }),
      mut({ entityType: 'Enrollment', entityId: 'e1', op: 'DELETE', id: 'rm1', clientTs: '2026-07-09T10:00:05.000Z', parentIds: ['add1'] }),
      mut({ entityType: 'Enrollment', entityId: 'e1', op: 'CREATE', id: 'add2', deviceId: 'devB', clientTs: '2026-07-09T10:00:03.000Z', payload: '{"status":"ACTIVE"}' }),
    ]);
    const row = await db.table('Enrollment').get('e1');
    expect(row.deletedAt).toBeNull();
    expect(await db.table('_syncmeta').get('Enrollment:e1')).toBeDefined();
  });

  it('a system-authored PATCH is applied verbatim, outside policy gating', async () => {
    await callPull([
      mut({ entityType: 'Enrollment', entityId: 'e2', op: 'CREATE', id: 'a1', clientTs: '2026-07-09T10:00:05.000Z', payload: '{"status":"ACTIVE"}' }),
      mut({
        entityType: 'Enrollment', entityId: 'e2', op: 'PATCH', id: 'sys1',
        authorIdentityId: 'system', deviceId: 'server',
        clientTs: '2026-07-09T10:00:01.000Z', // OLDER than the row — gating would drop it
        payload: '{"status":"SUSPENDED","hasConflict":true}',
      }),
    ]);
    const row = await db.table('Enrollment').get('e2');
    expect(row.status).toBe('SUSPENDED');
    expect(row.hasConflict).toBe(true);
  });
});
