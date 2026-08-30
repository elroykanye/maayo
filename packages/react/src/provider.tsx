import { createContext, useContext, useEffect, useMemo, type ReactNode } from 'react';
import { SyncEngine, type SyncConfig } from '@maayo/client';

export const SyncContext = createContext<SyncEngine | null>(null);

export interface SyncProviderProps {
  config: SyncConfig;
  children: ReactNode;
}

export function SyncProvider({ config, children }: SyncProviderProps) {
  const engine = useMemo(() => new SyncEngine(config), [config]);

  useEffect(() => {
    engine.start();
    return () => engine.stop();
  }, [engine]);

  return <SyncContext.Provider value={engine}>{children}</SyncContext.Provider>;
}

export function useSyncEngine(): SyncEngine {
  const engine = useContext(SyncContext);
  if (!engine) throw new Error('useSyncEngine must be used within <SyncProvider>');
  return engine;
}
