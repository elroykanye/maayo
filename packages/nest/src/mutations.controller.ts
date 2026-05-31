import { Controller, Post, Body, Req, Inject } from '@nestjs/common';
import type {
  BatchMutationsRequest,
  BatchMutationsResponse,
  AcceptedMutation,
  RejectedMutation,
} from '@maayo/protocol';
import { MAAYO_OPTIONS } from './maayo.constants';
import type { MaayoModuleOptions } from './maayo.options';

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

    return { accepted, rejected };
  }
}
