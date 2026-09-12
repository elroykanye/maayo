import type { Cursor, Mutation } from '@maayo/protocol';
import type { Table } from 'dexie';
import type { HistoryRow, LwwWinnerRow, MaayoDatabase } from './database';
import type { ApplyMutationHook, ApplyOutcome, ApplyResult } from './pull';
import {
  applyPolicyMutation,
  POLICY_APPLY_OPTIONS,
  type PolicyApplyHook,
  type PolicyMeta,
} from './policies';

export interface MutationPage {
  channel: string;
  mutations: Mutation[];
  cursor: Cursor;
}

export interface ApplyMutationPageOptions {
  softDelete?: boolean;
  applyMutation?: ApplyMutationHook;
  onApplied?: (mutation: Mutation, outcome: ApplyOutcome) => void;
  /** Maximum remote mutation rows retained on-device. Default 500. Local
   * history is never evicted. Set `Infinity` for legacy unbounded retention. */
  remoteHistoryLimit?: number;
}

interface EntityState {
  table: Table<Record<string, unknown>, string>;
  row: Record<string, unknown> | undefined;
  changed: boolean;
  deleted: boolean;
  winner?: Pick<Mutation, 'clientTs' | 'deviceId' | 'id'>;
  meta?: PolicyMeta;
  metaTouched: boolean;
}

const entityKey = (entityType: string, entityId: string): string => `${entityType}\u0000${entityId}`;
const policyMetaKey = (entityType: string, entityId: string): string => `${entityType}:${entityId}`;

/**
 * Apply one remote mutation page through a public, atomic seam. Built-in LWW
 * and hooks created by `policyApply()` prefetch once per table, fold each
 * entity in memory, and persist final rows/meta/history/cursor in bulk.
 * Arbitrary custom hooks remain supported and execute inside the same page
 * transaction because their semantics cannot safely be inferred or batched.
 */
export async function applyMutationPage(
  db: MaayoDatabase,
  page: MutationPage,
  options: ApplyMutationPageOptions = {},
): Promise<ApplyResult> {
  const known = new Map<string, Table<Record<string, unknown>, string>>();
  for (const mutation of page.mutations) {
    if (known.has(mutation.entityType)) continue;
    try {
      known.set(mutation.entityType, db.table(mutation.entityType));
    } catch {
      // Unknown entity types are counted as skipped during the fold.
    }
  }

  const policyOptions = getPolicyOptions(options.applyMutation);
  const transactionTables: Table[] = [db._history, db._cursors, ...known.values()];
  let metaTable: Table<PolicyMeta, string> | undefined;
  if (policyOptions) {
    metaTable = db.table<PolicyMeta, string>(policyOptions.metaTable ?? '_syncmeta');
    transactionTables.push(metaTable);
  }

  const observations: Array<[Mutation, ApplyOutcome]> = [];
  let result: ApplyResult = { applied: 0, skipped: 0 };
  await db.transaction('rw', transactionTables, async () => {
    if (options.applyMutation && !policyOptions) {
      result = await applyCustomPage(db, page, options, observations);
      return;
    }
    result = await applyFoldedPage(db, page, options, known, policyOptions, metaTable, observations);
  });

  for (const [mutation, outcome] of observations) options.onApplied?.(mutation, outcome);
  return result;
}

function getPolicyOptions(hook: ApplyMutationHook | undefined) {
  return (hook as PolicyApplyHook | undefined)?.[POLICY_APPLY_OPTIONS];
}

async function applyFoldedPage(
  db: MaayoDatabase,
  page: MutationPage,
  options: ApplyMutationPageOptions,
  tables: Map<string, Table<Record<string, unknown>, string>>,
  policyOptions: ReturnType<typeof getPolicyOptions>,
  metaTable: Table<PolicyMeta, string> | undefined,
  observations: Array<[Mutation, ApplyOutcome]>,
): Promise<ApplyResult> {
  const existingCursor = await db._cursors.get(page.channel);
  const lwwWinners: Record<string, LwwWinnerRow> = { ...(existingCursor?.lwwWinners ?? {}) };
  const states = new Map<string, EntityState>();
  for (const [entityType, table] of tables) {
    const ids = [...new Set(page.mutations
      .filter((mutation) => mutation.entityType === entityType)
      .map((mutation) => mutation.entityId))];
    const rows = await table.bulkGet(ids);
    ids.forEach((id, index) => {
      const key = entityKey(entityType, id);
      const storedWinner = lwwWinners[key];
      states.set(key, {
        table,
        row: rows[index] as Record<string, unknown> | undefined,
        changed: false,
        deleted: false,
        metaTouched: false,
        winner: storedWinner ? fromStoredWinner(storedWinner) : undefined,
      });
    });
  }

  if (metaTable) {
    const entries = [...states.keys()].map((key) => {
      const [entityType, entityId] = key.split('\u0000');
      return policyMetaKey(entityType, entityId);
    });
    const metas = await metaTable.bulkGet(entries);
    [...states.values()].forEach((state, index) => { state.meta = metas[index]; });
  } else {
    // A single compound-index read supplies tie-break identities for every row
    // touched by the page; no per-mutation history lookup remains.
    const pairs = [...states.keys()].map((key) => key.split('\u0000'));
    if (pairs.length > 0) {
      const history = await db._history.where('[entityType+entityId]').anyOf(pairs).toArray();
      for (const row of history) {
        if (row.channel && row.channel !== page.channel) continue;
        const state = states.get(entityKey(row.entityType, row.entityId));
        if (state && (!state.winner || compareMutation(row, state.winner) > 0)) {
          state.winner = row;
        }
      }
    }
  }

  const historyRows: HistoryRow[] = [];
  const receivedAt = new Date().toISOString();
  let applied = 0;
  let skipped = 0;

  for (const mutation of page.mutations) {
    const state = states.get(entityKey(mutation.entityType, mutation.entityId));
    let outcome: ApplyOutcome = 'skipped';
    if (state) {
      outcome = policyOptions
        ? foldPolicy(state, mutation, policyOptions.policyFor(mutation.entityType), policyOptions.systemAuthorId ?? 'system')
        : foldLww(state, mutation, options.softDelete === true);
    }
    observations.push([mutation, outcome]);
    if (outcome === 'skipped') {
      skipped += 1;
      continue;
    }
    applied += 1;
    historyRows.push(toHistoryRow(mutation, receivedAt, page.channel));
  }

  for (const [, table] of tables) {
    const owned = [...states.values()].filter((state) => state.table === table && state.changed);
    const puts = owned.filter((state) => !state.deleted && state.row).map((state) => state.row!);
    const deletes = page.mutations
      .filter((mutation) => {
        const state = states.get(entityKey(mutation.entityType, mutation.entityId));
        return state?.table === table && state.changed && state.deleted;
      })
      .map((mutation) => mutation.entityId)
      .filter((id, index, ids) => ids.indexOf(id) === index);
    if (puts.length > 0) await table.bulkPut(puts);
    if (deletes.length > 0) await table.bulkDelete(deletes);
  }
  if (metaTable) {
    const metas = [...states.values()]
      .filter((state) => state.metaTouched && state.meta)
      .map((state) => state.meta!);
    if (metas.length > 0) await metaTable.bulkPut(metas);
  }
  if (!policyOptions) {
    for (const [key, state] of states) {
      if (state.winner) lwwWinners[key] = toStoredWinner(state.winner);
    }
  }
  await persistRemoteHistory(db, page.channel, historyRows, options.remoteHistoryLimit);
  await db._cursors.put({
    ...existingCursor,
    channel: page.channel,
    ...page.cursor,
    lwwWinners: policyOptions ? existingCursor?.lwwWinners : lwwWinners,
  });
  return { applied, skipped };
}

function foldPolicy(
  state: EntityState,
  mutation: Mutation,
  policy: Parameters<typeof applyPolicyMutation>[4],
  systemAuthor: string,
): ApplyOutcome {
  let payload: Record<string, unknown>;
  try {
    payload = mutation.payload ? JSON.parse(mutation.payload) as Record<string, unknown> : {};
  } catch {
    return 'skipped';
  }
  if (mutation.op === 'PATCH' && mutation.authorIdentityId === systemAuthor) {
    state.row = { ...(state.row ?? {}), ...payload, id: mutation.entityId };
    state.changed = true;
    state.deleted = false;
    return 'applied';
  }
  const decision = applyPolicyMutation(state.row, state.meta, mutation, payload, policy);
  state.meta = decision.meta;
  state.metaTouched = true;
  if (decision.action === 'put' && decision.row) {
    state.row = decision.row;
    state.changed = true;
    state.deleted = false;
    return 'applied';
  }
  return 'skipped';
}

function foldLww(state: EntityState, mutation: Mutation, softDelete: boolean): ApplyOutcome {
  if (mutation.op === 'DELETE' && !softDelete) {
    if (state.row && losesToExisting(state.row, mutation.clientTs, mutation, state.winner)) {
      return 'skipped';
    }
    if (!state.row && state.winner && compareMutation(mutation, state.winner) <= 0) {
      return 'skipped';
    }
    state.row = undefined;
    state.changed = true;
    state.deleted = true;
    state.winner = mutation;
    return 'applied';
  }

  let payload: Record<string, unknown> = {};
  if (mutation.op !== 'DELETE') payload = JSON.parse(mutation.payload) as Record<string, unknown>;
  if (state.row) {
    const incomingTs = mutation.op === 'DELETE'
      ? mutation.clientTs
      : String(payload['updatedAt'] ?? mutation.clientTs);
    if (losesToExisting(state.row, incomingTs, mutation, state.winner)) return 'skipped';
  } else if (state.winner && compareMutation(mutation, state.winner) <= 0) {
    return 'skipped';
  }

  state.row = mutation.op === 'DELETE'
    ? { id: mutation.entityId, deletedAt: mutation.clientTs }
    : { ...payload, id: mutation.entityId };
  state.changed = true;
  state.deleted = false;
  state.winner = mutation;
  return 'applied';
}

function losesToExisting(
  row: Record<string, unknown>,
  incomingTs: string,
  mutation: Pick<Mutation, 'clientTs' | 'deviceId' | 'id'>,
  winner: Pick<Mutation, 'clientTs' | 'deviceId' | 'id'> | undefined,
): boolean {
  const existingTs = String(row['updatedAt'] ?? row['deletedAt'] ?? '');
  if (incomingTs < existingTs) return true;
  return incomingTs === existingTs && Boolean(winner && compareMutation(mutation, winner) <= 0);
}

async function applyCustomPage(
  db: MaayoDatabase,
  page: MutationPage,
  options: ApplyMutationPageOptions,
  observations: Array<[Mutation, ApplyOutcome]>,
): Promise<ApplyResult> {
  const existingCursor = await db._cursors.get(page.channel);
  const lwwWinners: Record<string, LwwWinnerRow> = { ...(existingCursor?.lwwWinners ?? {}) };
  let applied = 0;
  let skipped = 0;
  const historyRows: HistoryRow[] = [];
  const receivedAt = new Date().toISOString();
  for (const mutation of page.mutations) {
    const key = entityKey(mutation.entityType, mutation.entityId);
    let winner = await resolveLwwWinner(db, page.channel, mutation, lwwWinners[key]);
    const outcome = await options.applyMutation!(db, mutation, async () => {
      const delegated = await applyDefaultOne(db, mutation, options.softDelete === true, winner);
      if (delegated === 'applied') winner = mutation;
      return delegated;
    });
    observations.push([mutation, outcome]);
    if (outcome === 'skipped') skipped += 1;
    else {
      applied += 1;
      historyRows.push(toHistoryRow(mutation, receivedAt, page.channel));
    }
    if (winner) lwwWinners[key] = toStoredWinner(winner);
  }
  await persistRemoteHistory(db, page.channel, historyRows, options.remoteHistoryLimit);
  await db._cursors.put({ ...existingCursor, channel: page.channel, ...page.cursor, lwwWinners });
  return { applied, skipped };
}

async function applyDefaultOne(
  db: MaayoDatabase,
  mutation: Mutation,
  softDelete: boolean,
  winner: Pick<Mutation, 'clientTs' | 'deviceId' | 'id'> | undefined,
): Promise<ApplyOutcome> {
  let table: Table<Record<string, unknown>, string>;
  try { table = db.table(mutation.entityType); } catch { return 'skipped'; }
  const existing = await table.get(mutation.entityId);
  if (mutation.op === 'DELETE' && !softDelete) {
    if (existing && losesToExisting(existing, mutation.clientTs, mutation, winner)) return 'skipped';
    if (!existing && winner && compareMutation(mutation, winner) <= 0) return 'skipped';
    await table.delete(mutation.entityId);
    return 'applied';
  }
  const payload = mutation.op === 'DELETE' ? {} : JSON.parse(mutation.payload) as Record<string, unknown>;
  if (existing) {
    const incomingTs = mutation.op === 'DELETE' ? mutation.clientTs : String(payload['updatedAt'] ?? mutation.clientTs);
    if (losesToExisting(existing, incomingTs, mutation, winner)) return 'skipped';
  } else if (winner && compareMutation(mutation, winner) <= 0) {
    return 'skipped';
  }
  await table.put(mutation.op === 'DELETE'
    ? { id: mutation.entityId, deletedAt: mutation.clientTs }
    : { ...payload, id: mutation.entityId });
  return 'applied';
}

async function resolveLwwWinner(
  db: MaayoDatabase,
  channel: string,
  mutation: Mutation,
  stored: LwwWinnerRow | undefined,
): Promise<Pick<Mutation, 'clientTs' | 'deviceId' | 'id'> | undefined> {
  let winner = stored ? fromStoredWinner(stored) : undefined;
  const history = await db._history
    .where('[entityType+entityId]')
    .equals([mutation.entityType, mutation.entityId])
    .toArray();
  for (const row of history) {
    if (row.channel && row.channel !== channel) continue;
    if (!winner || compareMutation(row, winner) > 0) winner = row;
  }
  return winner;
}

function toHistoryRow(mutation: Mutation, receivedAt: string, channel: string): HistoryRow {
  return { ...mutation, channel, receivedAt, source: 'remote' };
}

async function persistRemoteHistory(
  db: MaayoDatabase,
  channel: string,
  incoming: HistoryRow[],
  requestedLimit: number | undefined,
): Promise<void> {
  const limit = normalizeHistoryLimit(requestedLimit);
  if (limit === Infinity) {
    if (incoming.length > 0) await db._history.bulkPut(incoming);
    return;
  }
  const incomingIds = new Set(incoming.map((row) => row.id));
  const existing = (await db._history.toArray()).filter((row) =>
    row.source === 'remote'
    && row.channel === channel
    && !incomingIds.has(row.id));
  const combined = [...existing, ...incoming];
  const kept = limit === 0 ? [] : combined.slice(-limit);
  const keptIds = new Set(kept.map((row) => row.id));
  const deleteIds = combined.filter((row) => !keptIds.has(row.id)).map((row) => row.id);
  const incomingKept = incoming.filter((row) => keptIds.has(row.id));
  if (deleteIds.length > 0) await db._history.bulkDelete(deleteIds);
  if (incomingKept.length > 0) await db._history.bulkPut(incomingKept);
}

function fromStoredWinner(winner: LwwWinnerRow): Pick<Mutation, 'clientTs' | 'deviceId' | 'id'> {
  return { clientTs: winner.clientTs, deviceId: winner.deviceId, id: winner.mutationId };
}

function toStoredWinner(winner: Pick<Mutation, 'clientTs' | 'deviceId' | 'id'>): LwwWinnerRow {
  return { clientTs: winner.clientTs, deviceId: winner.deviceId, mutationId: winner.id };
}

function normalizeHistoryLimit(value: number | undefined): number {
  if (value === Infinity) return Infinity;
  if (value === undefined) return 500;
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.floor(value);
}

function compareMutation(
  a: Pick<Mutation, 'clientTs' | 'deviceId' | 'id'>,
  b: Pick<Mutation, 'clientTs' | 'deviceId' | 'id'>,
): number {
  if (a.clientTs !== b.clientTs) return a.clientTs < b.clientTs ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
