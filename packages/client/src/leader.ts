const LOCK_PREFIX = 'maayo-leader-';
const CHANNEL_PREFIX = 'maayo-sync-';

/**
 * Coordinates sync leadership across browser tabs.
 *
 * Uses the Web Locks API so only one tab runs the sync loop at a time.
 * Uses BroadcastChannel so follower tabs still receive live status updates.
 * Falls back transparently (immediate leader) when either API is unavailable.
 */
export class TabCoordinator {
  private bc: BroadcastChannel | null;
  private releaseLeadership: (() => void) | null = null;
  isLeader = false;

  constructor(private readonly dbName: string) {
    this.bc = openChannel(CHANNEL_PREFIX + dbName);
  }

  /**
   * Register a listener that fires when the leader tab broadcasts a status change.
   * Call before `waitForLeadership()` so follower tabs receive updates while waiting.
   * Returns an unsubscribe function.
   */
  onStatus(fn: (status: string) => void): () => void {
    const bc = this.bc;
    if (!bc) return () => {};
    const handler = (e: MessageEvent<{ type: string; status: string }>) => {
      if (e.data?.type === 'status') fn(e.data.status);
    };
    bc.addEventListener('message', handler);
    return () => bc.removeEventListener('message', handler);
  }

  /**
   * Resolves when this tab has acquired sync leadership.
   * If Web Locks are unavailable, resolves immediately (permits concurrent sync).
   */
  async waitForLeadership(): Promise<void> {
    if (!supportsLocks()) {
      this.isLeader = true;
      return;
    }

    await new Promise<void>((resolveAcquired) => {
      void navigator.locks.request(LOCK_PREFIX + this.dbName, async () => {
        this.isLeader = true;
        resolveAcquired();
        // Hold the lock open until release() is called
        await new Promise<void>((holdUntilRelease) => {
          this.releaseLeadership = holdUntilRelease;
        });
        this.isLeader = false;
      });
    });
  }

  /** Broadcast a status string to all other open tabs. No-op for follower tabs. */
  broadcastStatus(status: string): void {
    this.bc?.postMessage({ type: 'status', status });
  }

  /** Release leadership and close the broadcast channel. */
  release(): void {
    this.releaseLeadership?.();
    this.releaseLeadership = null;
    this.bc?.close();
    this.bc = null;
  }
}

function supportsLocks(): boolean {
  return typeof navigator !== 'undefined' && (navigator as { locks?: unknown }).locks != null;
}

function openChannel(name: string): BroadcastChannel | null {
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    return new BroadcastChannel(name);
  } catch {
    return null;
  }
}
