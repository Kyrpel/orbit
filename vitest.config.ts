import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/server/test/**/*.test.ts', 'apps/web/test/**/*.test.ts'],
    environment: 'node',
    pool: 'forks',
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
