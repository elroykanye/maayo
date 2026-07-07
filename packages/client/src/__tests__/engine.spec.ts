import { describe, it, expect, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { SyncEngine } from '../engine';

function mockFetch(gate: Promise<void>) {
  (globalThis as Record<string, unknown>).fetch = vi.fn(async () => {
    await gate;
    return {
      ok: true,
      json: async () => ({ channel: 'org:1', mutations: [], hasMore: false, cursor: {} }),
    } as Response;
  });
}

describe('SyncEngine.waitForIdle', () => {
  it('resolves immediately when no sync is in flight', async () => {
    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-idle-none-${Math.random()}`,
      channels: [],
    });
    await expect(engine.waitForIdle()).resolves.toBeUndefined();
  });

  it('waits for an in-flight sync() before resolving', async () => {
    let releaseFetch: () => void = () => {};
    const gate = new Promise<void>((res) => { releaseFetch = res; });
    mockFetch(gate);

    const engine = new SyncEngine({
      baseUrl: 'http://test',
      dbName: `test-idle-inflight-${Math.random()}`,
      channels: ['org:1'],
    });

    const syncPromise = engine.sync();
    let idleResolved = false;
    const idlePromise = engine.waitForIdle().then(() => {
      idleResolved = true;
    });

    // Let microtasks settle — the pull's fetch is gated open, so sync must still be running.
    await Promise.resolve();
    await Promise.resolve();
    expect(idleResolved).toBe(false);

    releaseFetch();
    await syncPromise;
    await idlePromise;
    expect(idleResolved).toBe(true);
  });
});
