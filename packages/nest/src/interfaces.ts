import type { Mutation } from '@maayo/protocol';

export interface SavedMutation {
  mutation: Mutation;
  receivedAt: Date;
}

export interface MaayoStore {
  existsById(id: string): Promise<boolean>;
  saveAll(mutations: Mutation[]): Promise<SavedMutation[]>;
  /** Return mutations for channel and all sub-channels, since date, capped at limit. */
  findChanges(channel: string, since: Date | null, limit: number): Promise<SavedMutation[]>;
  /** Continue after a compound (receivedAt, mutationId) cursor, in ascending order. */
  findChangesByCursor?(
    channel: string,
    since: Date,
    lastMutationId: string,
    limit: number,
  ): Promise<SavedMutation[]>;
}

export interface ChannelAuthorizer {
  canPush(request: unknown, channel: string): boolean | Promise<boolean>;
  canPull(request: unknown, channel: string): boolean | Promise<boolean>;
}
