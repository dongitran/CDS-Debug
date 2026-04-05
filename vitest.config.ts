import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/core/**/*.ts', 'src/storage/**/*.ts'],
      exclude: ['src/core/logger.ts', 'src/core/processManager.ts', 'src/core/cacheSync.ts', 'src/webview/**', 'src/extension.ts', 'src/types/**'],
      thresholds: {
        branches: 80,
        functions: 80,
        lines: 80,
        statements: 80,
      },
    },
  },
});
