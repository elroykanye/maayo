import { Router } from 'express';
import type {
  BatchMutationsRequest,
  AcceptedMutation,
  RejectedMutation,
  Cursor,
} from '@maayo/protocol';
import { DuplicateMutationError, SYSTEM_AUTHOR } from '@maayo/protocol';
import type { MaayoRouterOptions, SavedMutation } from './interfaces';

export function maayoRouter(options: MaayoRouterOptions): Router {
  const { store, authorizer, defaultLimit = 500 } = options;
  const router = Router();

  router.post('/mutations', async (req, res) => {
    const body = req.body as BatchMutationsRequest;
    const accepted: AcceptedMutation[] = [];
    const rejected: RejectedMutation[] = [];
    const toSave = [];
    const seenIds = new Set<string>();

    for (const mutation of body.mutations) {
      if (seenIds.has(mutation.id)) continue;
      seenIds.add(mutation.id);
      if (!mutation.id?.trim()) {
        rejected.push({ id: mutation.id, reason: 'id is required' });
        continue;
      }
      if (mutation.authorIdentityId === SYSTEM_AUTHOR) {
        rejected.push({
          id: mutation.id,
          reason: 'reserved author identity',
          code: 'reserved_author',
        });
        continue;
      }
      if (authorizer && !(await authorizer.canPush(req, mutation.channel))) {
        rejected.push({ id: mutation.id, reason: `unauthorized for channel ${mutation.channel}` });
        continue;
      }
      if (await store.existsById(mutation.id)) {
        accepted.push({ id: mutation.id, receivedAt: new Date().toISOString() });
        continue;
      }
      toSave.push(mutation);
    }

    if (toSave.length > 0) {
      try {
        acceptSaved(await store.saveAll(toSave), accepted);
      } catch (error) {
        if (!(error instanceof DuplicateMutationError)) throw error;
        const remaining = [];
        for (const mutation of toSave) {
          if (await store.existsById(mutation.id)) {
            accepted.push({ id: mutation.id, receivedAt: new Date().toISOString() });
          } else {
            remaining.push(mutation);
          }
        }
        if (remaining.length === toSave.length) throw error;
        if (remaining.length > 0) {
          acceptSaved(await store.saveAll(remaining), accepted);
        }
      }
    }

    res.json({ accepted, rejected });
  });

  router.get('/changes', async (req, res) => {
    const channel = req.query['channel'] as string;
    const since = req.query['since'] as string | undefined;
    const lastMutationId = req.query['lastMutationId'] as string | undefined;
    const limitStr = req.query['limit'] as string | undefined;

    if (authorizer && !(await authorizer.canPull(req, channel))) {
      res.status(403).json({ error: `unauthorized for channel ${channel}` });
      return;
    }

    const limit = clamp(parseInt(limitStr ?? String(defaultLimit), 10) || defaultLimit, 1, 2000);
    const hasSince = typeof since === 'string' && since.trim().length > 0;
    const hasLastMutationId = typeof lastMutationId === 'string' && lastMutationId.trim().length > 0;
    if (hasSince !== hasLastMutationId) {
      res.status(400).json({ error: 'since and lastMutationId must be provided together' });
      return;
    }

    let rows: SavedMutation[];
    if (hasSince && hasLastMutationId) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        res.status(400).json({ error: 'since must be a valid ISO-8601 timestamp' });
        return;
      }
      if (!store.findChangesByCursor) {
        res.status(501).json({ error: 'store does not support compound-cursor pagination' });
        return;
      }
      rows = await store.findChangesByCursor(channel, sinceDate, lastMutationId, limit + 1);
    } else {
      rows = await store.findChanges(channel, null, limit + 1);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    res.json({
      channel,
      mutations: page.map((r) => r.mutation),
      cursor: buildCursor(page),
      hasMore,
    });
  });

  return router;
}

function acceptSaved(saved: SavedMutation[], accepted: AcceptedMutation[]): void {
  for (const row of saved) {
    accepted.push({ id: row.mutation.id, receivedAt: row.receivedAt.toISOString() });
  }
}

function buildCursor(page: SavedMutation[]): Cursor {
  const last = page[page.length - 1];
  if (!last) return { lastMutationId: null, lastReceivedAt: null };
  return { lastMutationId: last.mutation.id, lastReceivedAt: last.receivedAt.toISOString() };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
