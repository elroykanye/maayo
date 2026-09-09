import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Inject,
  NotImplementedException,
  Query,
  Req,
} from '@nestjs/common';
import type { ChangesResponse, Cursor } from '@maayo/protocol';
import { MAAYO_OPTIONS } from './maayo.constants';
import type { MaayoModuleOptions } from './maayo.options';
import type { SavedMutation } from './interfaces';

@Controller('sync')
export class ChangesController {
  constructor(@Inject(MAAYO_OPTIONS) private readonly options: MaayoModuleOptions) {}

  @Get('changes')
  async pull(
    @Query('channel') channel: string,
    @Query('since') since?: string,
    @Query('lastMutationId') lastMutationId?: string,
    @Query('limit') limitStr?: string,
    @Req() req: unknown = undefined,
  ): Promise<ChangesResponse> {
    const { store, authorizer, defaultLimit = 500 } = this.options;

    if (authorizer && !(await authorizer.canPull(req, channel))) {
      throw new ForbiddenException(`unauthorized for channel ${channel}`);
    }

    const limit = clamp(parseInt(limitStr ?? String(defaultLimit), 10) || defaultLimit, 1, 2000);
    const hasSince = typeof since === 'string' && since.trim().length > 0;
    const hasLastMutationId = typeof lastMutationId === 'string' && lastMutationId.trim().length > 0;
    if (hasSince !== hasLastMutationId) {
      throw new BadRequestException('since and lastMutationId must be provided together');
    }

    let rows: SavedMutation[];
    if (hasSince && hasLastMutationId) {
      const sinceDate = new Date(since);
      if (Number.isNaN(sinceDate.getTime())) {
        throw new BadRequestException('since must be a valid ISO-8601 timestamp');
      }
      if (!store.findChangesByCursor) {
        throw new NotImplementedException('store does not support compound-cursor pagination');
      }
      rows = await store.findChangesByCursor(channel, sinceDate, lastMutationId, limit + 1);
    } else {
      rows = await store.findChanges(channel, null, limit + 1);
    }

    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;

    return {
      channel,
      mutations: page.map((r) => r.mutation),
      cursor: buildCursor(page),
      hasMore,
    };
  }
}

function buildCursor(page: SavedMutation[]): Cursor {
  const last = page[page.length - 1];
  if (!last) return { lastMutationId: null, lastReceivedAt: null };
  return {
    lastMutationId: last.mutation.id,
    lastReceivedAt: last.receivedAt.toISOString(),
  };
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(Math.max(n, min), max);
}
