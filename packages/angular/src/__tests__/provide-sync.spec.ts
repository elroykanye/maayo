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

afterEach(() => vi.restoreAllMocks());

describe('provideSync injector lifecycle', () => {
  it('stops its engine exactly once when the environment injector is destroyed', () => {
    const start = vi.spyOn(SyncEngine.prototype, 'start').mockImplementation(() => {});
    const stop = vi.spyOn(SyncEngine.prototype, 'stop').mockImplementation(() => {});
    const parent = Injector.create({ providers: [] }) as EnvironmentInjector;
    const injector = createEnvironmentInjector([
      provideSync({
        baseUrl: 'http://test',
        dbName: `angular-destroy-${Math.random()}`,
        channels: [],
      }),
    ], parent);
    const engine = injector.get(SYNC_ENGINE);

    injector.get(APP_INITIALIZER).forEach((initialize) => initialize());
    expect(start.mock.contexts).toEqual([engine]);

    injector.destroy();

    expect(stop.mock.contexts).toEqual([engine]);
  });
});
