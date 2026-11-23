import { defineConfig } from '@playwright/test';

import type { SurfaceOptions } from './support/scenario';

export default defineConfig<SurfaceOptions>({
  testDir: '.',
  testMatch: ['scenarios/**/*.spec.ts', 'self-test/**/*.spec.ts'],
  outputDir: 'test-results',
  fullyParallel: true,
  retries: 0,
  forbidOnly: true,
  timeout: 120_000,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  projects: [
    { name: 'tui', use: { surface: 'tui' } },
    { name: 'acp', use: { surface: 'acp' } },
  ],
});
