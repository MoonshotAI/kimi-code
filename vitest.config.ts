import { defineConfig } from 'vitest/config';
import { vscodeProjects } from './apps/vscode/vitest.projects';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      '!packages/minidb',
      'apps/kimi-code',
      'apps/vis/server',
      'apps/vis/web',
      ...vscodeProjects,
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'apps/*/src/**/*.ts',
        'apps/vis/*/src/**/*.{ts,tsx}',
      ],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html'],
    },
  },
});
