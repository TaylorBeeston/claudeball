import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/sim/**/*.test.ts', 'src/engine/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
  },
});
