import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    setupFiles: ['test/setup.ts'],
    // A page's test on a busy computer (CI, or several suites at once) can take seconds while nothing
    // is wrong; a test that hangs still fails, after 15 s rather than 5.
    testTimeout: 15_000,
  },
});
