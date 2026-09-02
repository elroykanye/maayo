import { defineConfig } from 'tsup';
const external = [
  '@angular/core',
  '@angular/core/*',
  '@maayo/client',
  '@maayo/protocol',
  '@nestjs/common',
  '@nestjs/core',
  'dexie',
  'express',
  'react',
  'react/*',
  'reflect-metadata',
  'rxjs',
  'rxjs/*',
];

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  target: 'es2022',
  tsconfig: 'tsconfig.build.json',
  external,
  outExtension({ format }) {
    return { js: format === 'cjs' ? '.cjs' : '.js' };
  },
});
