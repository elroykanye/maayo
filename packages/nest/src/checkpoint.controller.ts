import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  InternalServerErrorException,
  NotFoundException,
  Query,
  Req,
  Res,
} from '@nestjs/common';
import { brotliCompress, gzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { isCheckpointEnvelope, type CheckpointEnvelope } from '@maayo/protocol';
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

  const body = Buffer.from(JSON.stringify(checkpoint));
  const encoding = chooseEncoding(acceptEncoding);
  const encoded = encoding === 'br'
    ? await brotliCompressAsync(body)
    : encoding === 'gzip'
      ? await gzipAsync(body)
      : body;
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
