import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { SyncEngine, type SyncConfig } from '@maayo/client';

export const SyncContext = createContext<SyncEngine | null>(null);

export interface SyncProviderProps {
  config: SyncConfig;
  children: ReactNode;
}

export function SyncProvider({ config, children }: SyncProviderProps) {
  const [current, setCurrent] = useState(() => ({
    config,
    engine: new SyncEngine(config),
  }));

  useEffect(() => {
    if (current.config === config) return undefined;

    let cancelled = false;
    current.engine.stop();
    void current.engine.waitForIdle().then(() => {
      if (!cancelled) {
        setCurrent({ config, engine: new SyncEngine(config) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [config, current]);

  useEffect(() => {
    current.engine.start();
    return () => current.engine.stop();
  }, [current.engine]);

  return <SyncContext.Provider value={current.engine}>{children}</SyncContext.Provider>;
}

export function useSyncEngine(): SyncEngine {
  const engine = useContext(SyncContext);
  if (!engine) throw new Error('useSyncEngine must be used within <SyncProvider>');
  return engine;
}
