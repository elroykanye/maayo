import { inject, signal, type Signal, DestroyRef } from '@angular/core';
import type { SyncStatus } from '@maayo/client';
import { SYNC_ENGINE } from './tokens';

/**
 * Returns a Signal<SyncStatus> that reflects the current engine sync state.
 * Must be called in an injection context.
 */
export function injectSyncStatus(): Signal<SyncStatus> {
  const engine = inject(SYNC_ENGINE);
  const destroyRef = inject(DestroyRef);
  const status = signal<SyncStatus>(engine.status);
  const unsubscribe = engine.onStatusChange((s) => status.set(s));
  destroyRef.onDestroy(unsubscribe);
  return status.asReadonly();
}
