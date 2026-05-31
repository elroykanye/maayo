import type { ModuleMetadata, Type } from '@nestjs/common';
import type { MaayoStore, ChannelAuthorizer } from './interfaces';

export interface MaayoModuleOptions {
  store: MaayoStore;
  /** Optional channel-level authorization. Defaults to permit-all. */
  authorizer?: ChannelAuthorizer;
  /** Max mutations per GET /sync/changes page. Default 500. */
  defaultLimit?: number;
}

export interface MaayoOptionsFactory {
  createMaayoOptions(): MaayoModuleOptions | Promise<MaayoModuleOptions>;
}

export interface MaayoModuleAsyncOptions extends Pick<ModuleMetadata, 'imports'> {
  useFactory?: (...args: unknown[]) => MaayoModuleOptions | Promise<MaayoModuleOptions>;
  inject?: unknown[];
  useClass?: Type<MaayoOptionsFactory>;
  useExisting?: Type<MaayoOptionsFactory>;
}
