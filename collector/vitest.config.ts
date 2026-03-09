import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/normalizer/**', 'src/parsers/**'],
      exclude: ['src/**/*.test.ts'],
    },
  },
});
