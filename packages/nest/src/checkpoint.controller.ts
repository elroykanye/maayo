import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Query,
  Param,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { brotliCompress, gzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import {
  isCheckpointEnvelope,
  isSnapshotPackManifest,
  type CheckpointEnvelope,
} from '@maayo/protocol';
import { MAAYO_OPTIONS } from './maayo.constants';
import type { MaayoModuleOptions } from './maayo.options';

interface RawHttpResponse {
  status(code: number): this;
  setHeader(name: string, value: string): void;
  end(body?: Uint8Array): void;
}

interface HeaderRequest {
  headers?: Record<string, string | string[] | undefined>;
}

const gzipAsync = promisify(gzip);
const brotliCompressAsync = promisify(brotliCompress);

@Controller('sync')
export class CheckpointController {
  constructor(@Inject(MAAYO_OPTIONS) private readonly options: MaayoModuleOptions) {}

  @Get('checkpoint')
  async getCheckpoint(
    @Query('channel') channel: string,
    @Req() request: unknown,
    @Res() response: RawHttpResponse,
  ): Promise<void> {
    const { authorizer, checkpointProvider, checkpointProjectionKey } = this.options;
    if (!checkpointProvider) throw new NotFoundException('checkpoint capability is not configured');
    if (!channel?.trim()) throw new BadRequestException('channel is required');
    if (authorizer && !(await authorizer.canPull(request, channel))) {
      throw new ForbiddenException(`unauthorized for channel ${channel}`);
    }
    if (!checkpointProjectionKey) {
      throw new InternalServerErrorException('checkpoint projection key resolver is not configured');
    }

    const projectionKey = await checkpointProjectionKey(request, channel);
    if (!projectionKey.trim()) {
      throw new InternalServerErrorException('checkpoint projection key must not be blank');
    }
    const ifNoneMatch = requestHeader(request, 'if-none-match');
    const checkpoint = await checkpointProvider.getCheckpoint({
      request,
      channel,
      projectionKey,
      ifNoneMatch,
    });
    if (!checkpoint) throw new NotFoundException(`checkpoint unavailable for channel ${channel}`);
    if (!isCheckpointEnvelope(checkpoint)
      || checkpoint.channel !== channel
      || checkpoint.projectionKey !== projectionKey) {
      throw new InternalServerErrorException('checkpoint provider returned a mismatched or invalid envelope');
    }

    await sendCheckpoint(requestHeader(request, 'accept-encoding'), ifNoneMatch, checkpoint, response);
  }

  @Get('snapshot-packs/manifest')
  async getSnapshotPackManifest(
    @Query('channel') channel: string,
    @Req() request: unknown,
    @Res() response: RawHttpResponse,
  ): Promise<void> {
    const identity = await this.snapshotIdentity(channel, request);
    const provider = this.options.snapshotPackProvider;
    if (!provider) throw new NotFoundException('snapshot pack capability is not configured');
    const manifest = await provider.getSnapshotPackManifest({ request, ...identity });
    if (!manifest) throw new NotFoundException(`snapshot pack unavailable for channel ${channel}`);
    if (!isSnapshotPackManifest(manifest)
      || manifest.identity.tenantId !== identity.tenantId
      || manifest.identity.channel !== channel
      || manifest.identity.projectionKey !== identity.projectionKey) {
      throw new InternalServerErrorException('snapshot pack provider returned a mismatched manifest');
    }
    response.setHeader('ETag', `"snapshot-pack-${manifest.generation}"`);
    response.setHeader('Cache-Control', 'private, no-cache');
    response.setHeader('Vary', 'Authorization, Cookie');
    const body = Buffer.from(JSON.stringify(manifest));
    response.status(200);
    response.setHeader('Content-Type', 'application/json; charset=utf-8');
    response.setHeader('Content-Length', String(body.byteLength));
    response.end(body);
  }

  @Get('snapshot-packs/chunks/:digest')
  async getSnapshotPackChunk(
    @Param('digest') digest: string,
    @Query('channel') channel: string,
    @Query('token') token: string,
    @Req() request: unknown,
    @Res() response: RawHttpResponse,
  ): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new BadRequestException('invalid snapshot chunk digest');
    if (!token?.trim()) throw new UnauthorizedException('snapshot delivery token is required');
    const identity = await this.snapshotIdentity(channel, request);
    const provider = this.options.snapshotPackProvider;
    if (!provider) throw new NotFoundException('snapshot pack capability is not configured');
    const chunk = await provider.getSnapshotPackChunk({ request, ...identity, deliveryToken: token }, digest);
    if (!chunk || chunk.digest !== digest) throw new NotFoundException('snapshot chunk not found');
    response.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    response.setHeader('X-Content-Type-Options', 'nosniff');
    await sendCompressedJson(requestHeader(request, 'accept-encoding'), chunk, response);
  }

  private async snapshotIdentity(
    channel: string,
    request: unknown,
  ): Promise<{ tenantId: string; channel: string; projectionKey: string }> {
    if (!channel?.trim()) throw new BadRequestException('channel is required');
    if (this.options.authorizer && !(await this.options.authorizer.canPull(request, channel))) {
      throw new ForbiddenException(`unauthorized for channel ${channel}`);
    }
    if (!this.options.snapshotPackTenant || !this.options.snapshotPackProjectionKey) {
      throw new InternalServerErrorException('snapshot pack identity resolvers are not configured');
    }
    const tenantId = await this.options.snapshotPackTenant(request, channel);
    const projectionKey = await this.options.snapshotPackProjectionKey(request, channel);
    if (!tenantId.trim() || !projectionKey.trim()) {
      throw new InternalServerErrorException('snapshot pack identity must not be blank');
    }
    return { tenantId, channel, projectionKey };
  }
}

async function sendCheckpoint(
  acceptEncoding: string | undefined,
  ifNoneMatch: string | undefined,
  checkpoint: CheckpointEnvelope,
  response: RawHttpResponse,
): Promise<void> {
  const etag = checkpointEtag(checkpoint);
  response.setHeader('ETag', etag);
  response.setHeader('Cache-Control', 'private, no-cache');
  response.setHeader('Vary', 'Accept-Encoding, Authorization, Cookie');
  if (ifNoneMatch?.split(',').map((value) => value.trim()).includes(etag)) {
    response.status(304).end();
    return;
  }

  await sendCompressedJson(acceptEncoding, checkpoint, response);
}

async function sendCompressedJson(
  acceptEncoding: string | undefined,
  value: unknown,
  response: RawHttpResponse,
): Promise<void> {
  const body = Buffer.from(JSON.stringify(value));
  const encoding = chooseEncoding(acceptEncoding);
  const encoded = encoding === 'br'
    ? await brotliCompressAsync(body)
    : encoding === 'gzip'
      ? await gzipAsync(body)
      : body;
  response.setHeader('Vary', 'Accept-Encoding, Authorization, Cookie');
  response.status(200);
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', String(encoded.byteLength));
  if (encoding !== 'identity') response.setHeader('Content-Encoding', encoding);
  response.end(encoded);
}

function checkpointEtag(checkpoint: CheckpointEnvelope): string {
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

function requestHeader(request: unknown, name: string): string | undefined {
  const headers = (request as HeaderRequest | null)?.headers;
  const value = headers?.[name];
  return Array.isArray(value) ? value.join(', ') : value;
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
