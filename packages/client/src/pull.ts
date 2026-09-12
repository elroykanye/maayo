import type { ChangesResponse, Mutation } from '@maayo/protocol';
import type { MaayoDatabase } from './database';
import { fetchWithTimeout } from './transport';
import { applyMutationPage } from './bulk';

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

export class CheckpointRequiredError extends Error {
  constructor(
    readonly channel: string,
    readonly status = 409,
  ) {
    super(`Checkpoint required for channel ${channel}`);
    this.name = 'CheckpointRequiredError';
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
  /** Abort the pull after this many milliseconds. Default 30_000. */
  requestTimeoutMs?: number;
  /** Internal lifecycle cancellation signal for the owning sync cycle. */
  signal?: AbortSignal;
  /** Apply DELETEs as gated soft tombstones — see SyncConfig.softDelete. */
  softDelete?: boolean;
  /** Consumer-owned merge — see {@link ApplyMutationHook}. */
  applyMutation?: ApplyMutationHook;
  /** Observer fired once per pulled mutation with its merge outcome. */
  onApplied?: (mutation: Mutation, outcome: ApplyOutcome) => void;
  /** Maximum remote audit rows retained on-device. Default 500. */
  remoteHistoryLimit?: number;
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
): Promise<{ cursor: ChangesResponse['cursor']; result: ApplyResult; hasMore: boolean; entities: number }> {
  const cursor = await db._cursors.get(opts.channel);
  const params = new URLSearchParams({ channel: opts.channel });
  if (cursor?.lastReceivedAt) params.set('since', cursor.lastReceivedAt);
  if (cursor?.lastMutationId) params.set('lastMutationId', cursor.lastMutationId);
  if (opts.limit) params.set('limit', String(opts.limit));

  const data = await fetchWithTimeout(`${opts.baseUrl}/sync/changes?${params}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
    signal: opts.signal,
  }, async (resp) => {
    if (resp.status === 409) {
      const body = await resp.clone().json().catch(() => undefined) as unknown;
      if (isCheckpointRequiredBody(body)) throw new CheckpointRequiredError(body.channel);
    }
    if (!resp.ok) throw new SyncHttpError('pull', resp.status, resp.statusText);
    return resp.json() as Promise<ChangesResponse>;
  }, opts.requestTimeoutMs);
  const result = await applyMutationPage(db, {
    channel: opts.channel,
    mutations: data.mutations,
    cursor: data.cursor,
  }, opts);

  return {
    cursor: data.cursor,
    result,
    hasMore: data.hasMore,
    entities: new Set(data.mutations.map((mutation) => `${mutation.entityType}\u0000${mutation.entityId}`)).size,
  };
}

function isCheckpointRequiredBody(value: unknown): value is { code: 'CHECKPOINT_REQUIRED'; channel: string } {
  return typeof value === 'object'
    && value !== null
    && !Array.isArray(value)
    && (value as Record<string, unknown>)['code'] === 'CHECKPOINT_REQUIRED'
    && typeof (value as Record<string, unknown>)['channel'] === 'string'
    && ((value as Record<string, unknown>)['channel'] as string).trim().length > 0;
}
