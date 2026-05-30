import { createContext, useContext, useEffect, useRef, type ReactNode } from 'react';
import { SyncEngine, type SyncConfig } from '@maayo/client';

export const SyncContext = createContext<SyncEngine | null>(null);

export interface SyncProviderProps {
  config: SyncConfig;
  children: ReactNode;
}

export function SyncProvider({ config, children }: SyncProviderProps) {
  const engineRef = useRef<SyncEngine | null>(null);
  if (!engineRef.current) {
    engineRef.current = new SyncEngine(config);
  }

  useEffect(() => {
    const engine = engineRef.current!;
    engine.start();
    return () => engine.stop();
  }, []);

  return <SyncContext.Provider value={engineRef.current}>{children}</SyncContext.Provider>;
}

export function useSyncEngine(): SyncEngine {
  const engine = useContext(SyncContext);
  if (!engine) throw new Error('useSyncEngine must be used within <SyncProvider>');
  return engine;
}
