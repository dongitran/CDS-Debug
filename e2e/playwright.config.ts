import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  timeout: 180_000,
  expect: {
    timeout: 45_000,
  },
  failOnFlakyTests: !!process.env.CI,
  fullyParallel: false,
  preserveOutput: 'always',
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: [
    ['list'],
    ['html', { open: 'never' }],
    ['json', { outputFile: './playwright-report/results.json' }],
  ],
  outputDir: './test-results',
  use: {
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'off',
  },
});
