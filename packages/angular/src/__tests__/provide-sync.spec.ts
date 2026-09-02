import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  APP_INITIALIZER,
  createEnvironmentInjector,
  type EnvironmentInjector,
  Injector,
} from '@angular/core';
import { SyncEngine } from '@maayo/client';
import { provideSync } from '../provide-sync';
import { SYNC_ENGINE } from '../tokens';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('provideSync injector lifecycle', () => {
  it('releases the real engine interval, acquired lock, and broadcast channel on destroy', async () => {
    const channels = installBroadcastChannelDouble();
    let lockFinished: Promise<void> | undefined;
    const locks = {
      request: vi.fn((
        _name: string,
        _options: { signal: AbortSignal },
        callback: () => Promise<void>,
      ) => {
        lockFinished = callback();
        return lockFinished;
      }),
    };
    vi.stubGlobal('navigator', { locks });
    const sync = vi.spyOn(SyncEngine.prototype, 'sync').mockResolvedValue();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const { injector, engine } = createProvider();

    initialize(injector);
    await waitFor(() => setIntervalSpy.mock.calls.length === 1);
    const intervalHandle = setIntervalSpy.mock.results[0].value;
    expect(sync).toHaveBeenCalledTimes(1);
    expect(locks.request).toHaveBeenCalledTimes(1);
    expect(channels).toHaveLength(1);
    expect(channels[0].closed).toBe(false);

    injector.destroy();
    await lockFinished;

    expect(clearIntervalSpy).toHaveBeenCalledWith(intervalHandle);
    expect(channels[0].closed).toBe(true);
    expect((engine as unknown as { _started: boolean })._started).toBe(false);
  });

  it('aborts queued leadership and closes the broadcast channel without starting later', async () => {
    const channels = installBroadcastChannelDouble();
    let queuedSignal: AbortSignal | undefined;
    const locks = {
      request: vi.fn((
        _name: string,
        options: { signal: AbortSignal },
        _callback: () => Promise<void>,
      ) => {
        queuedSignal = options.signal;
        return new Promise<void>((resolve) => {
          options.signal.addEventListener('abort', () => resolve(), { once: true });
        });
      }),
    };
    vi.stubGlobal('navigator', { locks });
    const sync = vi.spyOn(SyncEngine.prototype, 'sync').mockResolvedValue();
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const { injector } = createProvider();

    initialize(injector);
    await waitFor(() => queuedSignal !== undefined);
    injector.destroy();
    await Promise.resolve();

    expect(queuedSignal?.aborted).toBe(true);
    expect(channels[0].closed).toBe(true);
    expect(sync).not.toHaveBeenCalled();
    expect(setIntervalSpy).not.toHaveBeenCalled();
  });
});

function createProvider(): { injector: EnvironmentInjector; engine: SyncEngine } {
  const parent = Injector.create({ providers: [] }) as EnvironmentInjector;
  const injector = createEnvironmentInjector([
    provideSync({
      baseUrl: 'http://test',
      dbName: `angular-destroy-${crypto.randomUUID()}`,
      channels: [],
      intervalMs: 60_000,
    }),
  ], parent);
  return { injector, engine: injector.get(SYNC_ENGINE) };
}

function initialize(injector: EnvironmentInjector): void {
  injector.get(APP_INITIALIZER).forEach((initializer) => initializer());
}

async function waitFor(predicate: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('Timed out waiting for lifecycle state');
}

function installBroadcastChannelDouble(): TestBroadcastChannel[] {
  const channels: TestBroadcastChannel[] = [];
  class BroadcastChannelDouble extends TestBroadcastChannel {
    constructor(name: string) {
      super(name);
      channels.push(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', BroadcastChannelDouble);
  return channels;
}

class TestBroadcastChannel {
  closed = false;
  constructor(readonly name: string) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  close(): void {
    this.closed = true;
  }
}
