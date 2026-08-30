import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { render } from '@testing-library/react';
import { SyncEngine, type SyncConfig } from '@maayo/client';
import { SyncProvider, useSyncEngine } from '../provider';

afterEach(() => vi.restoreAllMocks());

describe('SyncProvider configuration lifecycle', () => {
  it('replaces the engine on config identity changes and stops each owned engine', () => {
    const start = vi.spyOn(SyncEngine.prototype, 'start').mockImplementation(() => {});
    const stop = vi.spyOn(SyncEngine.prototype, 'stop').mockImplementation(() => {});
    const observed: SyncEngine[] = [];
    const firstConfig: SyncConfig = {
      baseUrl: 'http://first',
      dbName: `react-provider-first-${Math.random()}`,
      channels: ['org:1'],
    };
    const secondConfig: SyncConfig = {
      baseUrl: 'http://second',
      dbName: `react-provider-second-${Math.random()}`,
      channels: ['org:2'],
    };
    function Probe() {
      observed.push(useSyncEngine());
      return null;
    }

    const view = render(
      <SyncProvider config={firstConfig}><Probe /></SyncProvider>,
    );
    const firstEngine = observed.at(-1)!;
    view.rerender(
      <SyncProvider config={secondConfig}><Probe /></SyncProvider>,
    );
    const secondEngine = observed.at(-1)!;

    expect(secondEngine).not.toBe(firstEngine);
    expect(start.mock.contexts).toContain(firstEngine);
    expect(start.mock.contexts).toContain(secondEngine);
    expect(stop.mock.contexts).toContain(firstEngine);

    view.unmount();
    expect(stop.mock.contexts).toContain(secondEngine);
  });
});
