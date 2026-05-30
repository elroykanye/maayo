import { useState, useEffect } from 'react';
import { liveQuery } from 'dexie';
import type { SyncStatus } from '@maayo/client';
import { useSyncEngine } from './provider';

export function useCollection<T>(tableName: string): T[] {
  const engine = useSyncEngine();
  const [data, setData] = useState<T[]>([]);

  useEffect(() => {
    const sub = liveQuery(() => engine.db.table<T>(tableName).toArray())
      .subscribe({ next: setData, error: console.error });
    return () => sub.unsubscribe();
  }, [engine, tableName]);

  return data;
}

export function useSyncStatus(): SyncStatus {
  const engine = useSyncEngine();
  const [status, setStatus] = useState<SyncStatus>(engine.status);

  useEffect(() => {
    return engine.onStatusChange(setStatus);
  }, [engine]);

  return status;
}
