import type { ModuleMetadata, Type } from '@nestjs/common';
import type {
  MaayoStore,
  ChannelAuthorizer,
  CheckpointProvider,
  CheckpointProjectionKeyResolver,
} from './interfaces';

interface MaayoModuleBaseOptions {
  store: MaayoStore;
  /** Optional channel-level authorization. Defaults to permit-all. */
  authorizer?: ChannelAuthorizer;
  /** Max mutations per GET /sync/changes page. Default 500. */
  defaultLimit?: number;
}

export type MaayoModuleOptions = MaayoModuleBaseOptions & (
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

export interface MaayoOptionsFactory {
  createMaayoOptions(): MaayoModuleOptions | Promise<MaayoModuleOptions>;
}

export interface MaayoModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: unknown[]) => MaayoModuleOptions | Promise<MaayoModuleOptions>;
  inject?: unknown[];
  useClass?: Type<MaayoOptionsFactory>;
  useExisting?: Type<MaayoOptionsFactory>;
}
