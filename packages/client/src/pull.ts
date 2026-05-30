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

  for (const mutation of mutations) {
    const table = db.table(mutation.entityType);
    if (!table) { skipped++; continue; }

    if (mutation.op === 'DELETE') {
      await table.delete(mutation.entityId);
      applied++;
      continue;
    }

    const incoming = JSON.parse(mutation.payload) as Record<string, unknown>;
    const existing = await table.get(mutation.entityId) as Record<string, unknown> | undefined;

    if (existing) {
      const existingTs = String(existing['updatedAt'] ?? '');
      const incomingTs = String(incoming['updatedAt'] ?? mutation.clientTs);
      if (existingTs >= incomingTs) { skipped++; continue; } // LWW: local is newer
    }

    await table.put(incoming);
    applied++;
  }

  return { applied, skipped };
}
