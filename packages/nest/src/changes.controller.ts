import { Controller, Get, Query, Req, Inject, ForbiddenException } from '@nestjs/common';
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
    @Query('limit') limitStr?: string,
    @Req() req: unknown = undefined,
  ): Promise<ChangesResponse> {
    const { store, authorizer, defaultLimit = 500 } = this.options;

    if (authorizer && !(await authorizer.canPull(req, channel))) {
      throw new ForbiddenException(`unauthorized for channel ${channel}`);
    }

    const limit = clamp(parseInt(limitStr ?? String(defaultLimit), 10) || defaultLimit, 1, 2000);
    const sinceDate = since ? new Date(since) : null;
    const rows = await store.findChanges(channel, sinceDate, limit + 1);

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
