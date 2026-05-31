import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  resolve: {
    alias: {
      '@maayo/protocol': resolve(__dirname, '../protocol/src/index.ts'),
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.spec.ts'],
  },
});
