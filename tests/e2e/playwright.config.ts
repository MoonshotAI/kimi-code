import { TIMEOUTS } from '@moonshot-ai/testkit/fixtures';
import { defineConfig } from '@playwright/test';

import type { SurfaceOptions } from './support/scenario';

export default defineConfig<SurfaceOptions>({
  testDir: '.',
  testMatch: ['scenarios/**/*.spec.ts', 'self-test/**/*.spec.ts'],
  outputDir: 'test-results',
  fullyParallel: true,
  retries: 0,
  forbidOnly: true,
  timeout: TIMEOUTS.server * 4,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['./support/run-summary.ts']],
  projects: [
    { name: 'tui', use: { surface: 'tui' } },
    { name: 'tui-kitty', use: { surface: 'tui', variant: 'kitty-keyboard' } },
    { name: 'acp', use: { surface: 'acp' } },
    { name: 'acp-bare', use: { surface: 'acp', variant: 'bare-editor' } },
    { name: 'desktop', use: { surface: 'desktop' }, workers: process.env['E2E_HEADED'] === '1' ? 1 : 2 },
    { name: 'web', use: { surface: 'web' } },
  ],
});
