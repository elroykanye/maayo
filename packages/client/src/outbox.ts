import type { MutationOp, RejectedMutation } from '@maayo/protocol';
import type { MaayoDatabase, OutboxRow } from './database';
import { ulid, deviceId } from './ids';

export interface EnqueueOptions {
  channel: string;
  entityType: string;
  entityId: string;
  op: MutationOp;
  payload: unknown;
  authorIdentityId: string;
  parentIds?: string[];
}

export async function enqueue(db: MaayoDatabase, opts: EnqueueOptions): Promise<OutboxRow> {
  const row: OutboxRow = {
    id: ulid(),
    channel: opts.channel,
    entityType: opts.entityType,
    entityId: opts.entityId,
    op: opts.op,
    payload: JSON.stringify(opts.payload),
    authorIdentityId: opts.authorIdentityId,
    deviceId: deviceId(),
    clientTs: new Date().toISOString(),
    parentIds: opts.parentIds ?? [],
  };
  await db._outbox.add(row);
  return row;
}

/**
 * Returns pending (unsynced) outbox rows, oldest first. Excludes QUARANTINED
 * rows (server-rejected past their retry budget — see {@link rejected}) and
 * rows still inside their rejection backoff window.
 */
export async function pending(db: MaayoDatabase): Promise<OutboxRow[]> {
  const now = new Date().toISOString();
  return db._outbox
    .filter((row) => !row.syncedAt && !row.rejectedAt && (!row.nextAttemptAt || row.nextAttemptAt <= now))
    .sortBy('clientTs');
}

export async function markSynced(db: MaayoDatabase, ids: string[], receivedAt: string): Promise<void> {
  await db._outbox.where('id').anyOf(ids).modify({ syncedAt: receivedAt });
  const rows = await db._outbox.where('id').anyOf(ids).toArray();
  await db._history.bulkPut(
    rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      op: r.op,
      payload: r.payload,
      authorIdentityId: r.authorIdentityId,
      deviceId: r.deviceId,
      clientTs: r.clientTs,
      receivedAt,
      source: 'local' as const,
    })),
  );
}

/** Deletes outbox rows that have been synced. Safe to call periodically for cleanup. */
export async function purgeSynced(db: MaayoDatabase): Promise<number> {
  return db._outbox.filter((row) => !!row.syncedAt).delete();
}

// --- server-rejection lifecycle ----------------------------------------------
// A 207 push response can reject individual mutations. Before this existed, the
// engine read only `accepted`, so every rejected row was re-POSTed on each sync
// cycle FOREVER — a silent poison retry the consumer couldn't even observe.
// Rejections now back off exponentially and quarantine after a budget; the
// mutation is never silently lost — it stays inspectable and revivable.

/** Exponential backoff for re-pushing a rejected mutation: 30s, 60s, 120s … capped at 30min. */
export function rejectionBackoff(attempts: number, base = 30_000, cap = 1_800_000): number {
  return Math.min(base * 2 ** Math.max(0, attempts - 1), cap);
}

export interface RejectionOptions {
  /** Rejections before the row is quarantined out of the push loop. Default 5. */
  maxAttempts?: number;
  /**
   * Machine-readable codes that quarantine IMMEDIATELY (no retry can ever
   * succeed — e.g. a uniqueness conflict). Matched against `RejectedMutation.code`.
   */
  permanentCodes?: readonly string[];
}

export interface RecordedRejection {
  row: OutboxRow;
  /** True when the row was quarantined (out of the push loop) by this rejection. */
  quarantined: boolean;
}

/**
 * Folds one server rejection into its outbox row: bumps `attempts`, schedules
 * the retry backoff, and QUARANTINES the row (sets `rejectedAt`, clears it from
 * {@link pending}) once the budget is exhausted or the code is permanent.
 * Returns null if the row no longer exists.
 */
export async function recordRejection(
  db: MaayoDatabase,
  rejection: RejectedMutation,
  opts: RejectionOptions = {},
): Promise<RecordedRejection | null> {
  const { maxAttempts = 5, permanentCodes = [] } = opts;
  const row = await db._outbox.get(rejection.id);
  if (!row) return null;

  const attempts = (row.attempts ?? 0) + 1;
  const permanent = rejection.code !== undefined && permanentCodes.includes(rejection.code);
  const quarantined = permanent || attempts >= maxAttempts;
  const changes: Partial<OutboxRow> = {
    attempts,
    rejectReason: rejection.reason,
    rejectCode: rejection.code,
  };
  if (quarantined) {
    changes.rejectedAt = new Date().toISOString();
    changes.nextAttemptAt = undefined;
  } else {
    changes.nextAttemptAt = new Date(Date.now() + rejectionBackoff(attempts)).toISOString();
  }
  await db._outbox.update(rejection.id, changes);
  return { row: { ...row, ...changes }, quarantined };
}

/** Quarantined (permanently rejected) outbox rows, oldest first. */
export async function rejected(db: MaayoDatabase): Promise<OutboxRow[]> {
  return db._outbox.filter((row) => !!row.rejectedAt).sortBy('clientTs');
}

/**
 * Puts a quarantined row back into the push loop, resetting its rejection
 * bookkeeping. The original `clientTs`/`parentIds` are untouched — a retry must
 * keep its causal position, not jump the queue as a fresh newer write.
 */
export async function retryRejected(db: MaayoDatabase, id: string): Promise<void> {
  await db._outbox.update(id, {
    attempts: undefined,
    nextAttemptAt: undefined,
    rejectedAt: undefined,
    rejectReason: undefined,
    rejectCode: undefined,
  });
}

/** Drops a quarantined mutation for good (the local optimistic write stays). */
export async function discardRejected(db: MaayoDatabase, id: string): Promise<void> {
  await db._outbox.delete(id);
}
