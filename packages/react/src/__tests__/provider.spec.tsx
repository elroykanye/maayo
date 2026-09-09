import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { render, waitFor } from '@testing-library/react';
import { SyncEngine, type SyncConfig } from '@maayo/client';
import { SyncProvider, useSyncEngine } from '../provider';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('SyncProvider configuration lifecycle', () => {
  it('finishes real old-engine cleanup before exposing and starting its replacement', async () => {
    const events: string[] = [];
    const channels = installBroadcastChannelDouble(events);
    const locks = {
      request: vi.fn((
        _name: string,
        _options: { signal: AbortSignal },
        callback: () => Promise<void>,
      ) => callback()),
    };
    vi.stubGlobal('navigator', { onLine: true, locks });

    let firstRequestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).startsWith('http://first')) {
        firstRequestSignal = init?.signal ?? undefined;
        return {
          ok: true,
          json: () => new Promise<never>((_resolve, reject) => {
            firstRequestSignal?.addEventListener('abort', () => {
              events.push('first-request-aborted');
              reject(firstRequestSignal?.reason ?? new DOMException('Aborted', 'AbortError'));
            }, { once: true });
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        json: async () => ({
          channel: 'org:2',
          mutations: [],
          hasMore: false,
          cursor: { lastMutationId: null, lastReceivedAt: null },
        }),
      } as unknown as Response;
    });
    vi.stubGlobal('fetch', fetch);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const observed: SyncEngine[] = [];
    const ids = new Map<SyncEngine, number>();
    const firstConfig: SyncConfig = {
      baseUrl: 'http://first',
      dbName: `react-provider-first-${crypto.randomUUID()}`,
      channels: ['org:1'],
      intervalMs: 60_000,
      requestTimeoutMs: 60_000,
    };
    const secondConfig: SyncConfig = {
      baseUrl: 'http://second',
      dbName: `react-provider-second-${crypto.randomUUID()}`,
      channels: [],
      intervalMs: 60_000,
    };
    function Probe() {
      const engine = useSyncEngine();
      observed.push(engine);
      if (!ids.has(engine)) ids.set(engine, ids.size + 1);
      events.push(`render-${ids.get(engine)}`);
      return null;
    }

    const view = render(
      <SyncProvider config={firstConfig}><Probe /></SyncProvider>,
    );
    const firstEngine = observed.at(-1)!;
    const waitForIdleSpy = vi.spyOn(firstEngine, 'waitForIdle');
    await waitFor(() => expect(firstRequestSignal).toBeDefined());
    await waitFor(() => expect(
      setIntervalSpy.mock.calls.some((call) => call[1] === 60_000),
    ).toBe(true));
    const firstIntervalIndex = setIntervalSpy.mock.calls.findIndex((call) => call[1] === 60_000);
    const firstInterval = setIntervalSpy.mock.results[firstIntervalIndex].value;

    view.rerender(
      <SyncProvider config={secondConfig}><Probe /></SyncProvider>,
    );

    expect(observed.at(-1)).toBe(firstEngine);
    await waitFor(() => expect(observed.at(-1)).not.toBe(firstEngine));
    const secondEngine = observed.at(-1)!;

    expect(waitForIdleSpy).toHaveBeenCalledOnce();
    expect((firstEngine as unknown as { _syncInFlight: Promise<void> | null })._syncInFlight)
      .toBeNull();
    expect(firstRequestSignal?.aborted).toBe(true);
    expect(clearIntervalSpy).toHaveBeenCalledWith(firstInterval);
    expect(channels[0]?.closed).toBe(true);
    expect(events.indexOf('first-request-aborted')).toBeLessThan(events.indexOf('render-2'));
    expect((firstEngine as unknown as { _started: boolean })._started).toBe(false);
    expect((secondEngine as unknown as { _started: boolean })._started).toBe(true);

    view.unmount();
    expect(channels[1]?.closed).toBe(true);
  });
});

function installBroadcastChannelDouble(events: string[]): TestBroadcastChannel[] {
  const channels: TestBroadcastChannel[] = [];
  class BroadcastChannelDouble extends TestBroadcastChannel {
    constructor(name: string) {
      super(name, events);
      channels.push(this);
    }
  }
  vi.stubGlobal('BroadcastChannel', BroadcastChannelDouble);
  return channels;
}

class TestBroadcastChannel {
  closed = false;
  constructor(readonly name: string, private readonly events: string[]) {}
  addEventListener(): void {}
  removeEventListener(): void {}
  postMessage(): void {}
  close(): void {
    this.closed = true;
    this.events.push(`channel-closed:${this.name}`);
  }
}
