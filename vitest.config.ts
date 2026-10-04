import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/sim/**/*.test.ts', 'src/engine/**/*.test.ts', 'src/audio/**/*.test.ts', 'src/ui/**/*.test.ts', 'tools/announcer/**/*.test.ts'],
    environment: 'node',
    // the sim's full-game tests are CPU heavy: CI runners (2 vCPU) take ~3x longer than a dev machine
    testTimeout: 240000,
    hookTimeout: 240000,
  },
});
