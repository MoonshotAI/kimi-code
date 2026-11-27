import { TIMEOUTS } from '@moonshot-ai/testkit/fixtures';
import { defineConfig } from '@playwright/test';

import type { SurfaceOptions } from './support/scenario';

const SCENARIOS = ['scenarios/**/*.spec.ts', 'self-test/**/*.spec.ts'];

export default defineConfig<SurfaceOptions>({
  testDir: '.',
  testMatch: SCENARIOS,
  outputDir: 'test-results',
  globalSetup: './support/global-setup.ts',
  fullyParallel: true,
  retries: 0,
  forbidOnly: true,
  timeout: TIMEOUTS.server * 4,
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }], ['./support/run-summary.ts']],
  projects: [
    { name: 'tui', use: { surface: 'tui' } },
    { name: 'tui-kitty', use: { surface: 'tui', variant: 'kitty-keyboard' } },
    { name: 'acp', testMatch: [...SCENARIOS, 'surfaces/acp-*.spec.ts'], use: { surface: 'acp' } },
    { name: 'acp-bare', use: { surface: 'acp', variant: 'bare-editor' } },
    { name: 'desktop', use: { surface: 'desktop' }, workers: process.env['E2E_HEADED'] === '1' || process.platform !== 'darwin' ? 1 : 2 },
    { name: 'web', use: { surface: 'web' } },
  ],
});
