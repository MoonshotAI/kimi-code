import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      'packages/*',
      'apps/kimi-code',
      'apps/vscode/agent-sdk',
      'apps/vscode/agent-display-model',
      'apps/vscode/webview-ui',
    ],
    coverage: {
      provider: 'v8',
      include: [
        'packages/*/src/**/*.ts',
        'apps/*/src/**/*.ts',
        'apps/vscode/agent-sdk/**/*.ts',
        'apps/vscode/agent-display-model/src/**/*.ts',
      ],
      exclude: ['**/*.test.ts', '**/*.spec.ts', '**/dist/**'],
      reporter: ['text', 'html'],
    },
  },
});
