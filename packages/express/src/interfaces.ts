import type { Mutation } from '@maayo/protocol';
import type { Request } from 'express';

export interface SavedMutation {
  mutation: Mutation;
  receivedAt: Date;
}

export interface MaayoStore {
  existsById(id: string): Promise<boolean>;
  saveAll(mutations: Mutation[]): Promise<SavedMutation[]>;
  findChanges(channel: string, since: Date | null, limit: number): Promise<SavedMutation[]>;
}

export interface ChannelAuthorizer {
  canPush(req: Request, channel: string): boolean | Promise<boolean>;
  canPull(req: Request, channel: string): boolean | Promise<boolean>;
}

export interface MaayoRouterOptions {
  store: MaayoStore;
  authorizer?: ChannelAuthorizer;
  defaultLimit?: number;
}
