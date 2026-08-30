import { describe, it, expect, vi, afterEach } from 'vitest';
import 'fake-indexeddb/auto';
import { TabCoordinator } from '../leader';
import { SyncEngine } from '../engine';

// Sequential lock mock: each request waits for the previous callback to finish.
function makeLocksMock() {
  const chains = new Map<string, Promise<void>>();
  return {
    request: vi.fn((
      name: string,
      optionsOrCallback: { signal?: AbortSignal } | (() => Promise<void>),
      maybeCallback?: () => Promise<void>,
    ): Promise<void> => {
      const options = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
      const cb = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback!;
      const prior = chains.get(name) ?? Promise.resolve();
      const thisRun = prior.then(() => {
        if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
        return cb();
      });
      chains.set(name, thisRun.catch(() => {}));
      return thisRun;
    }),
  };
}

function setLocks(impl: unknown) {
  Object.defineProperty(navigator, 'locks', { value: impl, configurable: true, writable: true });
}

afterEach(() => setLocks(undefined));

describe('TabCoordinator — no Web Locks (fallback)', () => {
  it('becomes leader immediately', async () => {
    setLocks(undefined);
    const coord = new TabCoordinator('fallback-db');
    await coord.waitForLeadership();
    expect(coord.isLeader).toBe(true);
    coord.release();
  });
});

describe('TabCoordinator — with Web Locks', () => {
  it('becomes leader when lock is acquired', async () => {
    setLocks(makeLocksMock());
    const coord = new TabCoordinator('db-1');
    await coord.waitForLeadership();
    expect(coord.isLeader).toBe(true);
    coord.release();
  });

  it('second coordinator waits until first releases', async () => {
    setLocks(makeLocksMock());

    const c1 = new TabCoordinator('db-seq');
    const c2 = new TabCoordinator('db-seq');

    await c1.waitForLeadership();
    expect(c1.isLeader).toBe(true);

    let c2Led = false;
    const c2Done = c2.waitForLeadership().then(() => { c2Led = true; });

    // Flush microtasks — c2 should still be waiting behind c1
    await Promise.resolve();
    await Promise.resolve();
    expect(c2Led).toBe(false);

    // Release c1 — c2 should now acquire the lock
    c1.release();
    await c2Done;

    expect(c2Led).toBe(true);
    expect(c2.isLeader).toBe(true);
    c2.release();
  });

  it('isLeader is false after release', async () => {
    setLocks(makeLocksMock());
    const coord = new TabCoordinator('db-rel');
    await coord.waitForLeadership();
    coord.release();
    await Promise.resolve();
    expect(coord.isLeader).toBe(false);
  });

  it('a stopped follower never starts after the current leader releases', async () => {
    setLocks(makeLocksMock());
    const dbName = `db-stopped-follower-${Math.random()}`;
    const currentLeader = new TabCoordinator(dbName);
    await currentLeader.waitForLeadership();
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName,
      channels: [],
    });
    const sync = vi.spyOn(engine, 'sync').mockResolvedValue();

    engine.start();
    await Promise.resolve();
    engine.stop();
    currentLeader.release();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sync).not.toHaveBeenCalled();
    engine.stop();
    engine.db.close();
  });

  it('release cancels a coordinator still queued for the lock', async () => {
    setLocks(makeLocksMock());
    const currentLeader = new TabCoordinator('db-cancel-queued');
    const queued = new TabCoordinator('db-cancel-queued');
    await currentLeader.waitForLeadership();
    const queuedWait = queued.waitForLeadership();

    queued.release();
    currentLeader.release();
    await queuedWait;

    expect(queued.isLeader).toBe(false);
  });
});

describe('TabCoordinator — BroadcastChannel status', () => {
  it('follower receives status broadcast from leader', async () => {
    if (typeof BroadcastChannel === 'undefined') return; // skip in environments without BC

    setLocks(makeLocksMock());

    const leader = new TabCoordinator('bc-db');
    const follower = new TabCoordinator('bc-db');

    const received: string[] = [];
    follower.onStatus((s) => received.push(s));

    await leader.waitForLeadership();
    leader.broadcastStatus('syncing');
    leader.broadcastStatus('idle');

    // BroadcastChannel dispatches asynchronously
    await new Promise((res) => setTimeout(res, 10));

    expect(received).toEqual(['syncing', 'idle']);

    leader.release();
    follower.release();
  });

  it('onStatus returns unsubscribe that stops further events', async () => {
    if (typeof BroadcastChannel === 'undefined') return;

    setLocks(makeLocksMock());

    const leader = new TabCoordinator('bc-unsub');
    const follower = new TabCoordinator('bc-unsub');

    const received: string[] = [];
    const unsub = follower.onStatus((s) => received.push(s));

    await leader.waitForLeadership();
    leader.broadcastStatus('syncing');
    await new Promise((res) => setTimeout(res, 10));
    unsub();
    leader.broadcastStatus('idle');
    await new Promise((res) => setTimeout(res, 10));

    expect(received).toEqual(['syncing']); // 'idle' not received after unsub

    leader.release();
    follower.release();
  });
});
