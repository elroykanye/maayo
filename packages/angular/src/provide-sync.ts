import {
  type EnvironmentProviders,
  DestroyRef,
  Injector,
  APP_INITIALIZER,
  makeEnvironmentProviders,
} from '@angular/core';
import { SyncEngine, type SyncConfig } from '@maayo/client';
import { SYNC_ENGINE } from './tokens';

export interface SyncProviderConfig
  extends Omit<SyncConfig, 'channels'> {
  /**
   * Static channel list, or a factory that receives the Angular injector so
   * you can derive channels from your auth store or any other DI token.
   *
   * @example
   * channels: (injector) => {
   *   const auth = injector.get(AuthStore);
   *   return auth.grants().map(g => `org:${g.orgId}/school:${g.schoolId}`);
   * }
   */
  channels: string[] | ((injector: Injector) => string[]);
}

export function provideSync(config: SyncProviderConfig): EnvironmentProviders {
  return makeEnvironmentProviders([
    {
      provide: SYNC_ENGINE,
      useFactory: (injector: Injector, destroyRef: DestroyRef) => {
        const channels =
          typeof config.channels === 'function'
            ? config.channels(injector)
            : config.channels;
        const engine = new SyncEngine({ ...config, channels });
        destroyRef.onDestroy(() => engine.stop());
        return engine;
      },
      deps: [Injector, DestroyRef],
    },
    {
      provide: APP_INITIALIZER,
      useFactory: (engine: SyncEngine) => () => engine.start(),
      deps: [SYNC_ENGINE],
      multi: true,
    },
  ]);
}
