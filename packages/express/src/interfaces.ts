import type { CheckpointProvider as ProtocolCheckpointProvider, Mutation } from '@maayo/protocol';
import type { Request } from 'express';

export interface SavedMutation {
  mutation: Mutation;
  receivedAt: Date;
}

export interface MaayoStore {
  existsById(id: string): Promise<boolean>;
  saveAll(mutations: Mutation[]): Promise<SavedMutation[]>;
  findChanges(channel: string, since: Date | null, limit: number): Promise<SavedMutation[]>;
  /**
   * Continue after the compound (receivedAt, mutationId) cursor returned by Maayo.
   * Stores must order by receivedAt ASC, mutation id ASC and exclude the cursor row.
   */
  findChangesByCursor?(
    channel: string,
    since: Date,
    lastMutationId: string,
    limit: number,
  ): Promise<SavedMutation[]>;
  /** Return false when this compound cursor predates retained replay history. */
  isCursorRetained?(channel: string, since: Date, lastMutationId: string): Promise<boolean>;
}

export interface ChannelAuthorizer {
  canPush(req: Request, channel: string): boolean | Promise<boolean>;
  canPull(req: Request, channel: string): boolean | Promise<boolean>;
}

export type CheckpointProvider = ProtocolCheckpointProvider<Request>;
export type CheckpointProjectionKeyResolver = (
  req: Request,
  channel: string,
) => string | Promise<string>;

interface MaayoRouterBaseOptions {
  store: MaayoStore;
  authorizer?: ChannelAuthorizer;
  defaultLimit?: number;
}

export type MaayoRouterOptions = MaayoRouterBaseOptions & (
  | {
    checkpointProvider?: never;
    checkpointProjectionKey?: never;
  }
  | {
    /** Required because generic adapters cannot infer application projections or tables. */
    checkpointProvider: CheckpointProvider;
    /** Must partition checkpoints by every authorization input that can change visible rows. */
    checkpointProjectionKey: CheckpointProjectionKeyResolver;
  }
);
