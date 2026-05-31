import { DynamicModule, Module } from '@nestjs/common';
import { MutationsController } from './mutations.controller';
import { ChangesController } from './changes.controller';
import { MAAYO_OPTIONS } from './maayo.constants';
import type { MaayoModuleOptions, MaayoModuleAsyncOptions, MaayoOptionsFactory } from './maayo.options';

@Module({})
export class MaayoModule {
  static forRoot(options: MaayoModuleOptions): DynamicModule {
    return {
      module: MaayoModule,
      controllers: [MutationsController, ChangesController],
      providers: [{ provide: MAAYO_OPTIONS, useValue: options }],
    };
  }

  static forRootAsync(options: MaayoModuleAsyncOptions): DynamicModule {
    return {
      module: MaayoModule,
      imports: options.imports ?? [],
      controllers: [MutationsController, ChangesController],
      providers: createAsyncProviders(options),
    };
  }
}

function createAsyncProviders(options: MaayoModuleAsyncOptions) {
  if (options.useFactory) {
    return [
      {
        provide: MAAYO_OPTIONS,
        useFactory: options.useFactory,
        inject: (options.inject as never[]) ?? [],
      },
    ];
  }

  const cls = options.useClass ?? options.useExisting!;
  return [
    {
      provide: MAAYO_OPTIONS,
      useFactory: (f: MaayoOptionsFactory) => f.createMaayoOptions(),
      inject: [cls],
    },
    ...(options.useClass ? [{ provide: cls, useClass: cls }] : []),
  ];
}
