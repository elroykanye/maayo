import { Router } from 'express';
import type {
  BatchMutationsRequest,
  AcceptedMutation,
  RejectedMutation,
  Cursor,
} from '@maayo/protocol';
import type { MaayoRouterOptions, SavedMutation } from './interfaces';

export function maayoRouter(options: MaayoRouterOptions): Router {
  const { store, authorizer, defaultLimit = 500 } = options;
  const router = Router();

  router.post('/mutations', async (req, res) => {
    const body = req.body as BatchMutationsRequest;
    const accepted: AcceptedMutation[] = [];
    const rejected: RejectedMutation[] = [];
    const toSave = [];

    for (const mutation of body.mutations) {
      if (!mutation.id?.trim()) {
        rejected.push({ id: mutation.id, reason: 'id is required' });
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
      const saved = await store.saveAll(toSave);
      for (const s of saved) {
        accepted.push({ id: s.mutation.id, receivedAt: s.receivedAt.toISOString() });
      }
    }

    res.json({ accepted, rejected });
  });

  router.get('/changes', async (req, res) => {
    const channel = req.query['channel'] as string;
    const since = req.query['since'] as string | undefined;
    const limitStr = req.query['limit'] as string | undefined;

    if (authorizer && !(await authorizer.canPull(req, channel))) {
      res.status(403).json({ error: `unauthorized for channel ${channel}` });
      return;
    }

    const limit = clamp(parseInt(limitStr ?? String(defaultLimit), 10) || defaultLimit, 1, 2000);
    const sinceDate = since ? new Date(since) : null;
    const rows = await store.findChanges(channel, sinceDate, limit + 1);

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

function buildCursor(page: SavedMutation[]): Cursor {
  const last = page[page.length - 1];
  if (!last) return { lastMutationId: null, lastReceivedAt: null };
  return { lastMutationId: last.mutation.id, lastReceivedAt: last.receivedAt.toISOString() };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
