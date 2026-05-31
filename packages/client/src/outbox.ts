import type { MutationOp } from '@maayo/protocol';
import type { MaayoDatabase, OutboxRow } from './database';
import { ulid, deviceId } from './ids';

export interface EnqueueOptions {
  channel: string;
  entityType: string;
  entityId: string;
  op: MutationOp;
  payload: unknown;
  authorIdentityId: string;
  parentIds?: string[];
}

export async function enqueue(db: MaayoDatabase, opts: EnqueueOptions): Promise<OutboxRow> {
  const row: OutboxRow = {
    id: ulid(),
    channel: opts.channel,
    entityType: opts.entityType,
    entityId: opts.entityId,
    op: opts.op,
    payload: JSON.stringify(opts.payload),
    authorIdentityId: opts.authorIdentityId,
    deviceId: deviceId(),
    clientTs: new Date().toISOString(),
    parentIds: opts.parentIds ?? [],
  };
  await db._outbox.add(row);
  return row;
}

/** Returns pending (unsynced) outbox rows, oldest first. */
export async function pending(db: MaayoDatabase): Promise<OutboxRow[]> {
  return db._outbox
    .filter((row) => !row.syncedAt)
    .sortBy('clientTs');
}

export async function markSynced(db: MaayoDatabase, ids: string[], receivedAt: string): Promise<void> {
  await db._outbox.where('id').anyOf(ids).modify({ syncedAt: receivedAt });
  const rows = await db._outbox.where('id').anyOf(ids).toArray();
  await db._history.bulkPut(
    rows.map((r) => ({
      id: r.id,
      entityType: r.entityType,
      entityId: r.entityId,
      op: r.op,
      payload: r.payload,
      authorIdentityId: r.authorIdentityId,
      deviceId: r.deviceId,
      clientTs: r.clientTs,
      receivedAt,
      source: 'local' as const,
    })),
  );
}

/** Deletes outbox rows that have been synced. Safe to call periodically for cleanup. */
export async function purgeSynced(db: MaayoDatabase): Promise<number> {
  return db._outbox.filter((row) => !!row.syncedAt).delete();
}
