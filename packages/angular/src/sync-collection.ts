import { inject, type Signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { from } from 'rxjs';
import { liveQuery } from 'dexie';
import { SYNC_ENGINE } from './tokens';

/**
 * Returns a Signal<T[]> that stays live as the local IndexedDB table changes.
 * Must be called in an injection context (component field, constructor, or
 * runInInjectionContext).
 *
 * @example
 * readonly students = syncCollection<Student>('student');
 */
export function syncCollection<T>(tableName: string): Signal<T[]> {
  const engine = inject(SYNC_ENGINE);
  const query$ = from(liveQuery(() => engine.db.table<T>(tableName).toArray()));
  return toSignal(query$, { initialValue: [] as T[] });
}
