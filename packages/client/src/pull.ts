import type { ChangesResponse, Mutation } from '@maayo/protocol';
import type { MaayoDatabase } from './database';

/**
 * HTTP failure from a push or pull — carries the phase and status so consumers
 * (and the engine's `onAuthError`) can react to auth failures specifically
 * instead of parsing error messages.
 */
export class SyncHttpError extends Error {
  constructor(
    readonly phase: 'push' | 'pull',
    readonly status: number,
    statusText: string,
  ) {
    super(`${phase === 'push' ? 'Push' : 'Pull'} failed: ${status} ${statusText}`);
    this.name = 'SyncHttpError';
  }
}

export type ApplyOutcome = 'applied' | 'skipped';

/**
 * Consumer-owned merge: called for each pulled mutation INSTEAD of the built-in
 * last-writer-wins apply. `defaultApply` runs the built-in merge for this one
 * mutation, so a hook can special-case some entity types (or policies) and
 * delegate the rest. The pull loop still owns pagination, cursor advancement
 * and `_history` recording — the hook owns only the table write.
 *
 * A thrown error aborts the current pull page (the cursor does NOT advance, so
 * the page replays next cycle) — merge hooks should be written idempotently.
 */
export type ApplyMutationHook = (
  db: MaayoDatabase,
  mutation: Mutation,
  defaultApply: () => Promise<ApplyOutcome>,
) => Promise<ApplyOutcome>;

export interface PullOptions {
  baseUrl: string;
  channel: string;
  headers?: Record<string, string>;
  limit?: number;
  /** Apply DELETEs as gated soft tombstones — see SyncConfig.softDelete. */
  softDelete?: boolean;
  /** Consumer-owned merge — see {@link ApplyMutationHook}. */
  applyMutation?: ApplyMutationHook;
  /** Observer fired once per pulled mutation with its merge outcome. */
  onApplied?: (mutation: Mutation, outcome: ApplyOutcome) => void;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
}

/**
 * Pulls one page of changes for a channel and applies them to the local database.
 * Returns the updated cursor and a count of applied/skipped mutations.
 */
export async function pull(
  db: MaayoDatabase,
  opts: PullOptions,
): Promise<{ cursor: ChangesResponse['cursor']; result: ApplyResult; hasMore: boolean }> {
  const cursor = await db._cursors.get(opts.channel);
  const params = new URLSearchParams({ channel: opts.channel });
  if (cursor?.lastReceivedAt) params.set('since', cursor.lastReceivedAt);
  if (opts.limit) params.set('limit', String(opts.limit));

  const resp = await fetch(`${opts.baseUrl}/sync/changes?${params}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });

  if (!resp.ok) throw new SyncHttpError('pull', resp.status, resp.statusText);

  const data: ChangesResponse = await resp.json();
  const result = await applyMutations(db, data.mutations, opts);

  if (data.cursor.lastReceivedAt) {
    await db._cursors.put({ channel: opts.channel, ...data.cursor });
  }

  return { cursor: data.cursor, result, hasMore: data.hasMore };
}

async function applyMutations(
  db: MaayoDatabase,
  mutations: Mutation[],
  opts: PullOptions,
): Promise<ApplyResult> {
  let applied = 0;
  let skipped = 0;
  const receivedAt = new Date().toISOString();

  for (const mutation of mutations) {
    const defaultApply = (): Promise<ApplyOutcome> => applyOne(db, mutation, opts.softDelete === true);
    const outcome = opts.applyMutation
      ? await opts.applyMutation(db, mutation, defaultApply)
      : await defaultApply();
    opts.onApplied?.(mutation, outcome);

    if (outcome !== 'applied') {
      skipped++;
      continue;
    }

    await db._history.put({
      id: mutation.id,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      op: mutation.op,
      payload: mutation.payload,
      authorIdentityId: mutation.authorIdentityId,
      deviceId: mutation.deviceId,
      clientTs: mutation.clientTs,
      receivedAt,
      source: 'remote',
    });
    applied++;
  }

  return { applied, skipped };
}

/** The built-in merge for ONE mutation: last-writer-wins with a deterministic
 *  tie-break, plus optional soft-tombstone deletes. */
async function applyOne(db: MaayoDatabase, mutation: Mutation, softDelete: boolean): Promise<ApplyOutcome> {
  // Dexie's `.table()` throws InvalidTableError synchronously for a name not in the local
  // schema — it never returns a falsy value — so an entity type this consumer hasn't
  // registered yet (e.g. a newly-added synced type the app's table list lags behind) must
  // be caught here, not checked with `if (!table)`. Left uncaught, this aborts the whole
  // pull (and the sync cycle that called it) instead of just skipping one mutation.
  let table;
  try {
    table = db.table(mutation.entityType);
  } catch {
    return 'skipped';
  }

  if (mutation.op === 'DELETE') {
    if (!softDelete) {
      // Legacy behaviour: unconditional hard delete. Prefer softDelete — a hard
      // delete cannot be resurrected by a newer concurrent upsert, and it
      // applies even when the delete is STALER than the local row.
      await table.delete(mutation.entityId);
      return 'applied';
    }
    const existing = (await table.get(mutation.entityId)) as Record<string, unknown> | undefined;
    if (existing && !(await incomingWins(db, mutation, mutation.clientTs, existing))) {
      return 'skipped';
    }
    // Deterministic tombstone: only { id, deletedAt } survives — carrying the
    // fields the row happened to have at delete time would make the final row
    // depend on arrival order.
    await table.put({ id: mutation.entityId, deletedAt: mutation.clientTs });
    return 'applied';
  }

  const incoming = JSON.parse(mutation.payload) as Record<string, unknown>;
  const existing = (await table.get(mutation.entityId)) as Record<string, unknown> | undefined;

  if (existing) {
    const incomingTs = String(incoming['updatedAt'] ?? mutation.clientTs);
    if (!(await incomingWins(db, mutation, incomingTs, existing))) return 'skipped';
  }

  await table.put({ ...incoming, id: mutation.entityId });
  return 'applied';
}

/**
 * Last-writer-wins comparison with a deterministic tie-break.
 *
 * Primary order is the effective timestamp (payload `updatedAt`, else the
 * mutation's `clientTs`). The old rule was `existingTs >= incomingTs → skip`,
 * which resolved EQUAL timestamps as first-arrival-wins: two replicas that
 * received the same two writes in different orders converged to different
 * rows. On a tie we now break on the mutation identity `(deviceId, id)` of the
 * incoming mutation vs the CURRENT winner's — recovered from the entity's
 * `_history` (every applied pull/acked push records one) — so every replica
 * picks the same winner regardless of arrival order.
 */
async function incomingWins(
  db: MaayoDatabase,
  mutation: Mutation,
  incomingTs: string,
  existing: Record<string, unknown>,
): Promise<boolean> {
  const existingTs = String(existing['updatedAt'] ?? existing['deletedAt'] ?? '');
  if (incomingTs > existingTs) return true;
  if (incomingTs < existingTs) return false;

  // Tie: compare mutation identity with the stored winner's. The winner is the
  // max-(clientTs, deviceId, id) history row for this entity at this timestamp;
  // a row that predates history (or was written locally without a mutation)
  // has no identity and loses to any real one — deterministically.
  const rows = await db._history
    .where('[entityType+entityId]')
    .equals([mutation.entityType, mutation.entityId])
    .toArray();
  let winner: { clientTs: string; deviceId: string; id: string } | null = null;
  for (const row of rows) {
    if (row.id === mutation.id) continue;
    if (!winner || cmpIdentity(row, winner) > 0) winner = row;
  }
  if (!winner) return true;
  return cmpIdentity(mutation, winner) > 0;
}

function cmpIdentity(
  a: { clientTs: string; deviceId: string; id: string },
  b: { clientTs: string; deviceId: string; id: string },
): number {
  if (a.clientTs !== b.clientTs) return a.clientTs < b.clientTs ? -1 : 1;
  if (a.deviceId !== b.deviceId) return a.deviceId < b.deviceId ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
}
