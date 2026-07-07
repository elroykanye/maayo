import type { ChangesResponse, Mutation } from '@maayo/protocol';
import type { MaayoDatabase } from './database';

export interface PullOptions {
  baseUrl: string;
  channel: string;
  headers?: Record<string, string>;
  limit?: number;
}

export interface ApplyResult {
  applied: number;
  skipped: number;
}

/**
 * Pulls one page of changes for a channel and applies them to the local database.
 * Returns the updated cursor and a count of applied/skipped mutations.
 */
export async function pull(
  db: MaayoDatabase,
  opts: PullOptions,
): Promise<{ cursor: ChangesResponse['cursor']; result: ApplyResult; hasMore: boolean }> {
  const cursor = await db._cursors.get(opts.channel);
  const params = new URLSearchParams({ channel: opts.channel });
  if (cursor?.lastReceivedAt) params.set('since', cursor.lastReceivedAt);
  if (opts.limit) params.set('limit', String(opts.limit));

  const resp = await fetch(`${opts.baseUrl}/sync/changes?${params}`, {
    headers: { 'Content-Type': 'application/json', ...opts.headers },
  });

  if (!resp.ok) throw new Error(`Pull failed: ${resp.status} ${resp.statusText}`);

  const data: ChangesResponse = await resp.json();
  const result = await applyMutations(db, data.mutations);

  if (data.cursor.lastReceivedAt) {
    await db._cursors.put({ channel: opts.channel, ...data.cursor });
  }

  return { cursor: data.cursor, result, hasMore: data.hasMore };
}

async function applyMutations(db: MaayoDatabase, mutations: Mutation[]): Promise<ApplyResult> {
  let applied = 0;
  let skipped = 0;
  const receivedAt = new Date().toISOString();

  for (const mutation of mutations) {
    // Dexie's `.table()` throws InvalidTableError synchronously for a name not in the local
    // schema — it never returns a falsy value — so an entity type this consumer hasn't
    // registered yet (e.g. a newly-added synced type the app's table list lags behind) must
    // be caught here, not checked with `if (!table)`. Left uncaught, this aborts the whole
    // pull (and the sync cycle that called it) instead of just skipping one mutation.
    let table;
    try {
      table = db.table(mutation.entityType);
    } catch {
      skipped++;
      continue;
    }

    if (mutation.op === 'DELETE') {
      await table.delete(mutation.entityId);
    } else {
      const incoming = JSON.parse(mutation.payload) as Record<string, unknown>;
      const existing = await table.get(mutation.entityId) as Record<string, unknown> | undefined;

      if (existing) {
        const existingTs = String(existing['updatedAt'] ?? '');
        const incomingTs = String(incoming['updatedAt'] ?? mutation.clientTs);
        if (existingTs >= incomingTs) { skipped++; continue; } // LWW: local is newer
      }

      await table.put({ ...incoming, id: mutation.entityId });
    }

    await db._history.put({
      id: mutation.id,
      entityType: mutation.entityType,
      entityId: mutation.entityId,
      op: mutation.op,
      payload: mutation.payload,
      authorIdentityId: mutation.authorIdentityId,
      deviceId: mutation.deviceId,
      clientTs: mutation.clientTs,
      receivedAt,
      source: 'remote',
    });
    applied++;
  }

  return { applied, skipped };
}
