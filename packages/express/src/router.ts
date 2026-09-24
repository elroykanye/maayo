import { Router } from 'express';
import { brotliCompress, gzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import type {
  BatchMutationsRequest,
  AcceptedMutation,
  RejectedMutation,
  Cursor,
} from '@maayo/protocol';
import {
  CHECKPOINT_REQUIRED,
  isCheckpointEnvelope,
  isSnapshotPackManifest,
  isDuplicateMutationError,
  SYSTEM_AUTHOR,
} from '@maayo/protocol';
import type { MaayoRouterOptions, SavedMutation } from './interfaces';

export function maayoRouter(options: MaayoRouterOptions): Router {
  const { store, authorizer, defaultLimit = 500 } = options;
  const router = Router();

  router.post('/mutations', async (req, res) => {
    const body = req.body as BatchMutationsRequest;
    const accepted: AcceptedMutation[] = [];
    const rejected: RejectedMutation[] = [];
    const toSave: SavedMutation['mutation'][] = [];
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

    await persistWithDuplicateRecovery(store, toSave, accepted);

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
      if (store.isCursorRetained
        && !(await store.isCursorRetained(channel, sinceDate, lastMutationId))) {
        res.status(409).json({ code: CHECKPOINT_REQUIRED, channel });
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

  if (options.checkpointProvider) {
    router.get('/checkpoint', async (req, res) => {
      const channel = req.query['channel'];
      if (typeof channel !== 'string' || channel.trim().length === 0) {
        res.status(400).json({ error: 'channel is required' });
        return;
      }
      if (authorizer && !(await authorizer.canPull(req, channel))) {
        res.status(403).json({ error: `unauthorized for channel ${channel}` });
        return;
      }

      const projectionKey = await options.checkpointProjectionKey(req, channel);
      if (!projectionKey.trim()) {
        res.status(500).json({ error: 'checkpoint projection key must not be blank' });
        return;
      }
      const checkpoint = await options.checkpointProvider.getCheckpoint({
        request: req,
        channel,
        projectionKey,
        ifNoneMatch: req.header('If-None-Match'),
      });
      if (!checkpoint) {
        res.status(404).json({ error: `checkpoint unavailable for channel ${channel}` });
        return;
      }
      if (!isCheckpointEnvelope(checkpoint)
        || checkpoint.channel !== channel
        || checkpoint.projectionKey !== projectionKey) {
        res.status(500).json({ error: 'checkpoint provider returned a mismatched or invalid envelope' });
        return;
      }

      await sendCheckpoint(req.header('Accept-Encoding'), req.header('If-None-Match'), checkpoint, res);
    });
  }

  if (options.snapshotPackProvider) {
    router.get('/snapshot-packs/manifest', async (req, res) => {
      const identity = await resolveSnapshotPackIdentity(options, req, res);
      if (!identity) return;
      const manifest = await options.snapshotPackProvider!.getSnapshotPackManifest({
        request: req,
        ...identity,
        ifNoneMatch: req.header('If-None-Match'),
      });
      if (!manifest) {
        res.status(404).json({ error: `snapshot pack unavailable for channel ${identity.channel}` });
        return;
      }
      if (!isSnapshotPackManifest(manifest)
        || manifest.identity.tenantId !== identity.tenantId
        || manifest.identity.channel !== identity.channel
        || manifest.identity.projectionKey !== identity.projectionKey) {
        res.status(500).json({ error: 'snapshot pack provider returned a mismatched manifest' });
        return;
      }
      const etag = `"snapshot-pack-${manifest.generation}"`;
      res.set('ETag', etag);
      res.set('Cache-Control', 'private, no-cache');
      res.vary('Authorization');
      res.vary('Cookie');
      if (req.header('If-None-Match')?.split(',').map((item) => item.trim()).includes(etag)) {
        res.status(304).end();
        return;
      }
      res.json(manifest);
    });

    router.get('/snapshot-packs/chunks/:digest', async (req, res) => {
      const identity = await resolveSnapshotPackIdentity(options, req, res);
      if (!identity) return;
      const digest = req.params['digest'];
      if (!/^[a-f0-9]{64}$/.test(digest)) {
        res.status(400).json({ error: 'invalid snapshot chunk digest' });
        return;
      }
      const token = typeof req.query['token'] === 'string' ? req.query['token'] : undefined;
      if (!token?.trim()) {
        res.status(401).json({ error: 'snapshot delivery token is required' });
        return;
      }
      const chunk = await options.snapshotPackProvider!.getSnapshotPackChunk({
        request: req,
        ...identity,
        deliveryToken: token,
      }, digest);
      if (!chunk || chunk.digest !== digest) {
        res.status(404).json({ error: 'snapshot chunk not found' });
        return;
      }
      res.set('Cache-Control', 'private, max-age=31536000, immutable');
      res.set('X-Content-Type-Options', 'nosniff');
      res.json(chunk);
    });
  }

  return router;
}

async function resolveSnapshotPackIdentity(
  options: MaayoRouterOptions,
  req: import('express').Request,
  res: import('express').Response,
): Promise<{ tenantId: string; channel: string; projectionKey: string } | undefined> {
  const channel = req.query['channel'];
  if (typeof channel !== 'string' || !channel.trim()) {
    res.status(400).json({ error: 'channel is required' });
    return undefined;
  }
  if (options.authorizer && !(await options.authorizer.canPull(req, channel))) {
    res.status(403).json({ error: `unauthorized for channel ${channel}` });
    return undefined;
  }
  if (!options.snapshotPackTenant || !options.snapshotPackProjectionKey) {
    res.status(500).json({ error: 'snapshot pack identity resolvers are not configured' });
    return undefined;
  }
  const tenantId = await options.snapshotPackTenant(req, channel);
  const projectionKey = await options.snapshotPackProjectionKey(req, channel);
  if (!tenantId.trim() || !projectionKey.trim()) {
    res.status(500).json({ error: 'snapshot pack identity must not be blank' });
    return undefined;
  }
  return { tenantId, channel, projectionKey };
}

const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);

async function sendCheckpoint(
  acceptEncoding: string | undefined,
  ifNoneMatch: string | undefined,
  checkpoint: import('@maayo/protocol').CheckpointEnvelope,
  res: import('express').Response,
): Promise<void> {
  const etag = checkpointEtag(checkpoint);
  res.set('ETag', etag);
  res.set('Cache-Control', 'private, no-cache');
  res.vary('Accept-Encoding');
  res.vary('Authorization');
  res.vary('Cookie');
  if (ifNoneMatch?.split(',').map((value) => value.trim()).includes(etag)) {
    res.status(304).end();
    return;
  }

  const body = Buffer.from(JSON.stringify(checkpoint));
  const encoding = chooseEncoding(acceptEncoding);
  const encoded = encoding === 'br'
    ? await brotliCompressAsync(body)
    : encoding === 'gzip'
      ? await gzipAsync(body)
      : body;
  res.status(200).type('application/json');
  if (encoding !== 'identity') res.set('Content-Encoding', encoding);
  res.send(encoded);
}

function checkpointEtag(checkpoint: import('@maayo/protocol').CheckpointEnvelope): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([
      checkpoint.channel,
      checkpoint.projectionKey,
      checkpoint.projectionRevision,
      checkpoint.integrity.checksum,
    ]))
    .digest('base64url');
  return `W/"checkpoint-${digest}"`;
}

function chooseEncoding(header: string | undefined): 'br' | 'gzip' | 'identity' {
  const quality = new Map<string, number>();
  for (const part of (header ?? '').split(',')) {
    const [rawName, ...params] = part.trim().toLowerCase().split(';');
    if (!rawName) continue;
    const qParam = params.find((value) => value.trim().startsWith('q='));
    const parsed = qParam ? Number(qParam.trim().slice(2)) : 1;
    quality.set(rawName, Number.isFinite(parsed) ? parsed : 0);
  }
  const br = quality.get('br') ?? quality.get('*') ?? 0;
  const gzipQuality = quality.get('gzip') ?? quality.get('*') ?? 0;
  if (br > 0 && br >= gzipQuality) return 'br';
  if (gzipQuality > 0) return 'gzip';
  return 'identity';
}

async function persistWithDuplicateRecovery(
  store: MaayoRouterOptions['store'],
  mutations: SavedMutation['mutation'][],
  accepted: AcceptedMutation[],
): Promise<void> {
  let remaining = mutations;
  while (remaining.length > 0) {
    try {
      acceptSaved(await store.saveAll(remaining), accepted);
      return;
    } catch (error) {
      if (!isDuplicateMutationError(error)) throw error;
      const unresolved: SavedMutation['mutation'][] = [];
      for (const mutation of remaining) {
        if (await store.existsById(mutation.id)) {
          accepted.push({ id: mutation.id, receivedAt: new Date().toISOString() });
        } else {
          unresolved.push(mutation);
        }
      }
      if (unresolved.length === remaining.length) throw error;
      remaining = unresolved;
    }
  }
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
