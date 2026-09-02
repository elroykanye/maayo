import type { BatchMutationsResponse, Mutation, RejectedMutation } from '@maayo/protocol';
import type { MaayoDatabase, UserTableSchema, MigrationDef, HistoryRow, OutboxRow } from './database';
import { openDatabase } from './database';
import { pending, markSynced, purgeSynced, recordRejection } from './outbox';
import { pull, SyncHttpError, type ApplyMutationHook, type ApplyOutcome } from './pull';
import { TabCoordinator } from './leader';
import { fetchWithTimeout } from './transport';

export interface SyncConfig {
  /** Your backend base URL, no trailing slash */
  baseUrl: string;
  /** Database name for IndexedDB */
  dbName: string;
  /** Channels this client pulls from */
  channels: string[];
  /** Extra IndexedDB table schemas for user data */
  tables?: UserTableSchema;
  /** Data and schema migrations to run when the local DB version bumps */
  migrations?: MigrationDef[];
  /** Bearer token or other auth header factory — called before each request */
  authHeaders?: () => Record<string, string> | Promise<Record<string, string>>;
  /** Push + pull interval in ms, default 10_000 */
  intervalMs?: number;
  /** Abort an individual push or pull after this many milliseconds. Default 30_000. */
  requestTimeoutMs?: number;
  /** Maximum mutations per push request. The engine drains successive batches. Default 100. */
  pushBatchSize?: number;
  /**
   * Called once per server-rejected mutation each time a push reports it (207
   * `rejected` entries). `quarantined` is true when this rejection took the row
   * out of the push loop (retry budget exhausted, or a permanent code) — the
   * moment to surface it to the user. Rejected rows back off exponentially and
   * are inspectable via `rejected()` / revivable via `retryRejected()`.
   */
  onReject?: (rejection: RejectedMutation, mutation: OutboxRow, quarantined: boolean) => void;
  /** Rejections per mutation before it is quarantined. Default 5. */
  maxRejectAttempts?: number;
  /** Rejection codes that quarantine immediately (retrying can never succeed). */
  permanentRejectCodes?: readonly string[];
  /**
   * Apply pulled DELETEs as SOFT tombstones: instead of hard-deleting the row,
   * it is replaced with `{ id, deletedAt: <winning clientTs> }`, gated by the
   * same last-writer-wins comparison as upserts (a stale delete loses to a
   * newer edit; a newer upsert resurrects). Reads must filter `deletedAt`.
   * Default false (legacy hard delete).
   */
  softDelete?: boolean;
  /**
   * Own the merge: called for each pulled mutation INSTEAD of the built-in
   * last-writer-wins apply. Receives the default apply as an escape hatch so a
   * hook can delegate the cases it doesn't care about. See {@link ApplyMutationHook}.
   */
  applyMutation?: ApplyMutationHook;
  /** Observer fired once per pulled mutation with its merge outcome. */
  onApplied?: (mutation: Mutation, outcome: ApplyOutcome) => void;
  /**
   * Fires when a push or pull fails with 401/403. The engine's fetch bypasses
   * any HTTP-client interceptors the app has, so without this hook an expired
   * or revoked token just flips status to 'error' and retries forever —
   * consumers use it to refresh the token or log the session out.
   */
  onAuthError?: (status: number, phase: 'push' | 'pull') => void;
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

export class SyncEngine {
  readonly db: MaayoDatabase;
  private _status: SyncStatus = 'idle';
  private _intervalId: ReturnType<typeof setInterval> | null = null;
  private _statusListeners = new Set<(s: SyncStatus) => void>();
  private _coordinator: TabCoordinator;
  private _started = false;
  private _syncInFlight: Promise<void> | null = null;
  private _syncAbortController: AbortController | null = null;

  constructor(private readonly config: SyncConfig) {
    this.db = openDatabase(config.dbName, config.tables, config.migrations);
    this._coordinator = new TabCoordinator(config.dbName);
  }

  get status(): SyncStatus {
    return this._status;
  }

  onStatusChange(fn: (s: SyncStatus) => void): () => void {
    this._statusListeners.add(fn);
    return () => this._statusListeners.delete(fn);
  }

  start(): void {
    if (this._started) return;
    this._started = true;
    // Follower tabs receive status from the leader via BroadcastChannel
    this._coordinator.onStatus((s) => {
      if (!this._coordinator.isLeader) this._setStatus(s as SyncStatus);
    });
    void this._startAsync();
  }

  private async _startAsync(): Promise<void> {
    await this._coordinator.waitForLeadership();
    if (!this._started || !this._coordinator.isLeader) return;
    void this.sync();
    this._intervalId = setInterval(() => void this.sync(), this.config.intervalMs ?? 10_000);
  }

  stop(): void {
    this._started = false;
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._syncAbortController?.abort(new DOMException('Sync stopped', 'AbortError'));
    this._coordinator.release();
  }

  /**
   * Resolves once no sync() call is in flight — immediately if none is. `stop()` aborts the
   * active HTTP exchange, including response-body parsing, but does not synchronously join the
   * promise. A consumer that will close or delete `db` after stopping must await this method so
   * the aborted cycle has fully unwound before the database changes underneath it.
   */
  async waitForIdle(): Promise<void> {
    if (!this._syncInFlight) return;
    try {
      await this._syncInFlight;
    } catch {
      // sync() already logs its own errors; this is just a "wait until settled" join.
    }
  }

  /** Returns all recorded mutations for a record, oldest first. */
  async history(entityType: string, entityId: string): Promise<HistoryRow[]> {
    return this.db._history
      .where('[entityType+entityId]')
      .equals([entityType, entityId])
      .sortBy('clientTs');
  }

  /**
   * Clears pull cursors so the next sync replays each channel's history from
   * the beginning — a local "re-clone" from the mutation log. Use it to heal a
   * device whose materialised rows may have diverged (e.g. after changing
   * merge semantics). Safe whenever the merge is idempotent and
   * order-independent — the built-in LWW and the policy module both are.
   * Local unsynced outbox rows are untouched.
   */
  async resetCursors(channels?: string[]): Promise<void> {
    if (!channels) {
      await this.db._cursors.clear();
      return;
    }
    await this.db._cursors.bulkDelete(channels);
  }

  /**
   * Runs one push+pull cycle. Concurrent callers (the interval timer, a manual trigger, and a
   * consumer's own reactive re-trigger can all land in the same tick) share the SAME in-flight
   * run rather than each starting an independent one — otherwise two overlapping cycles issue
   * their pull requests concurrently against the same local DB for no benefit, doubling
   * in-flight requests right when a fresh session's first sync is already slowest.
   */
  async sync(): Promise<void> {
    if (this._syncInFlight) return this._syncInFlight;
    const controller = new AbortController();
    this._syncAbortController = controller;
    this._syncInFlight = this._runSync(controller.signal).finally(() => {
      this._syncInFlight = null;
      if (this._syncAbortController === controller) this._syncAbortController = null;
    });
    return this._syncInFlight;
  }

  private async _runSync(signal: AbortSignal): Promise<void> {
    if (!navigator.onLine) { this._setStatus('offline'); return; }
    this._setStatus('syncing');
    try {
      await this._push(signal);
      await this._pullAll(signal);
      await purgeSynced(this.db);
      this._setStatus('idle');
    } catch (err) {
      console.error('[maayo] sync error', err);
      if (err instanceof SyncHttpError && (err.status === 401 || err.status === 403) && this.config.onAuthError) {
        try {
          this.config.onAuthError(err.status, err.phase);
        } catch (hookErr) {
          console.error('[maayo] onAuthError callback failed', hookErr);
        }
      }
      this._setStatus('error');
    }
  }

  private async _push(signal: AbortSignal): Promise<void> {
    const requestedBatchSize = this.config.pushBatchSize ?? 100;
    const normalizedBatchSize = Math.floor(requestedBatchSize);
    const batchSize = Number.isFinite(requestedBatchSize) && normalizedBatchSize >= 1
      ? normalizedBatchSize
      : 100;
    while (true) {
      const rows = await pending(this.db, batchSize);
      if (rows.length === 0) return;

      const headers = await this._headers();
      const data = await fetchWithTimeout(`${this.config.baseUrl}/sync/mutations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ mutations: rows }),
        signal,
      }, async (resp) => {
        if (!resp.ok) throw new SyncHttpError('push', resp.status, resp.statusText);
        return resp.json() as Promise<BatchMutationsResponse>;
      }, this.config.requestTimeoutMs);
      const requestedIds = new Set(rows.map((row) => row.id));
      const acceptedIds = data.accepted.map((accepted) => accepted.id);
      const rejectedItems = data.rejected ?? [];
      const foreignIds = [...acceptedIds, ...rejectedItems.map((rejection) => rejection.id)]
        .filter((id) => !requestedIds.has(id));
      if (foreignIds.length > 0) {
        throw new Error(`Push response referenced mutation outside current request: ${[...new Set(foreignIds)].join(', ')}`);
      }
      const acceptedIdSet = new Set(acceptedIds);
      const contradictoryIds = rejectedItems
        .map((rejection) => rejection.id)
        .filter((id) => acceptedIdSet.has(id));
      if (contradictoryIds.length > 0) {
        throw new Error(`Push response both accepted and rejected mutation: ${[...new Set(contradictoryIds)].join(', ')}`);
      }

      const handledIds = new Set<string>();
      if (data.accepted.length > 0) {
        const firstReceivedAt = data.accepted[0].receivedAt;
        acceptedIds.forEach((id) => handledIds.add(id));
        await markSynced(this.db, acceptedIds, firstReceivedAt);
      }
      // A 207 body can reject individual mutations. Ignoring them (the old
      // behaviour) re-POSTed every rejected row on every cycle forever, invisibly.
      // Each rejection now backs off exponentially and quarantines once its retry
      // budget is spent (or immediately for permanent codes) — see outbox.ts.
      for (const rejection of rejectedItems) {
        handledIds.add(rejection.id);
        const recorded = await recordRejection(this.db, rejection, {
          maxAttempts: this.config.maxRejectAttempts,
          permanentCodes: this.config.permanentRejectCodes,
        });
        if (recorded && this.config.onReject) {
          try {
            this.config.onReject(rejection, recorded.row, recorded.quarantined);
          } catch (err) {
            console.error('[maayo] onReject callback failed', err);
          }
        }
      }
      if (!rows.some((row) => handledIds.has(row.id))) {
        throw new Error('Push response did not accept or reject any requested mutation');
      }
    }
  }

  /**
   * Pulls every channel concurrently — each channel's own pages must stay sequential (each
   * page's `since` depends on the previous one's cursor), but different channels are
   * independent, so running them one at a time serialized their full paginated histories for
   * no reason. A caller with N channels (e.g. an admin with grants across many schools) was
   * paying for N channels' worth of network round-trips back to back instead of overlapped.
   */
  private async _pullAll(signal: AbortSignal): Promise<void> {
    const headers = await this._headers();
    await Promise.all(
      this.config.channels.map(async (channel) => {
        let hasMore = true;
        while (hasMore) {
          const result = await pull(this.db, {
            baseUrl: this.config.baseUrl,
            channel,
            headers,
            requestTimeoutMs: this.config.requestTimeoutMs,
            signal,
            softDelete: this.config.softDelete,
            applyMutation: this.config.applyMutation,
            onApplied: this.config.onApplied,
          });
          hasMore = result.hasMore;
        }
      }),
    );
  }

  private async _headers(): Promise<Record<string, string>> {
    if (!this.config.authHeaders) return {};
    return this.config.authHeaders();
  }

  private _setStatus(s: SyncStatus): void {
    this._status = s;
    this._statusListeners.forEach((fn) => fn(s));
    if (this._coordinator.isLeader) this._coordinator.broadcastStatus(s);
  }
}
