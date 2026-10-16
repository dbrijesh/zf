import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/**/test/**/*.test.ts', 'apps/**/test/**/*.test.{ts,tsx}', 'tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', 'tests/e2e/**'],
    testTimeout: 30_000,
    hookTimeout: 60_000,
    pool: 'forks',
  },
});
