import { Controller, Post, Body, Req, Inject } from '@nestjs/common';
import type {
  BatchMutationsRequest,
  BatchMutationsResponse,
  AcceptedMutation,
  RejectedMutation,
} from '@maayo/protocol';
import { DuplicateMutationError, SYSTEM_AUTHOR } from '@maayo/protocol';
import { MAAYO_OPTIONS } from './maayo.constants';
import type { MaayoModuleOptions } from './maayo.options';
import type { SavedMutation } from './interfaces';

@Controller('sync')
export class MutationsController {
  constructor(@Inject(MAAYO_OPTIONS) private readonly options: MaayoModuleOptions) {}

  @Post('mutations')
  async push(
    @Body() body: BatchMutationsRequest,
    @Req() req: unknown,
  ): Promise<BatchMutationsResponse> {
    const { store, authorizer } = this.options;
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
        this.acceptSaved(await store.saveAll(toSave), accepted);
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
          this.acceptSaved(await store.saveAll(remaining), accepted);
        }
      }
    }

    return { accepted, rejected };
  }

  private acceptSaved(saved: SavedMutation[], accepted: AcceptedMutation[]): void {
    for (const row of saved) {
      accepted.push({ id: row.mutation.id, receivedAt: row.receivedAt.toISOString() });
    }
  }
}
