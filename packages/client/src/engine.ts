import type { BatchMutationsResponse } from '@maayo/protocol';
import type { MaayoDatabase, UserTableSchema, MigrationDef, HistoryRow } from './database';
import { openDatabase } from './database';
import { pending, markSynced, purgeSynced } from './outbox';
import { pull } from './pull';
import { TabCoordinator } from './leader';

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
}

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

export class SyncEngine {
  readonly db: MaayoDatabase;
  private _status: SyncStatus = 'idle';
  private _intervalId: ReturnType<typeof setInterval> | null = null;
  private _statusListeners = new Set<(s: SyncStatus) => void>();
  private _coordinator: TabCoordinator;
  private _started = false;

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
    void this.sync();
    this._intervalId = setInterval(() => void this.sync(), this.config.intervalMs ?? 10_000);
  }

  stop(): void {
    if (this._intervalId !== null) {
      clearInterval(this._intervalId);
      this._intervalId = null;
    }
    this._coordinator.release();
    this._started = false;
  }

  /** Returns all recorded mutations for a record, oldest first. */
  async history(entityType: string, entityId: string): Promise<HistoryRow[]> {
    return this.db._history
      .where('[entityType+entityId]')
      .equals([entityType, entityId])
      .sortBy('clientTs');
  }

  async sync(): Promise<void> {
    if (!navigator.onLine) { this._setStatus('offline'); return; }
    this._setStatus('syncing');
    try {
      await this._push();
      await this._pullAll();
      await purgeSynced(this.db);
      this._setStatus('idle');
    } catch (err) {
      console.error('[maayo] sync error', err);
      this._setStatus('error');
    }
  }

  private async _push(): Promise<void> {
    const rows = await pending(this.db);
    if (rows.length === 0) return;

    const headers = await this._headers();
    const resp = await fetch(`${this.config.baseUrl}/sync/mutations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify({ mutations: rows }),
    });

    if (!resp.ok) throw new Error(`Push failed: ${resp.status} ${resp.statusText}`);

    const data: BatchMutationsResponse = await resp.json();
    if (data.accepted.length > 0) {
      const firstReceivedAt = data.accepted[0].receivedAt;
      await markSynced(this.db, data.accepted.map((a) => a.id), firstReceivedAt);
    }
  }

  private async _pullAll(): Promise<void> {
    const headers = await this._headers();
    for (const channel of this.config.channels) {
      let hasMore = true;
      while (hasMore) {
        const result = await pull(this.db, { baseUrl: this.config.baseUrl, channel, headers });
        hasMore = result.hasMore;
      }
    }
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
