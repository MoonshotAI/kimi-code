import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

const appRoot = import.meta.dirname;

const alias = {
  '@': resolve(appRoot, 'webview-ui/src'),
  shared: resolve(appRoot, 'shared'),
};

export const vscodeProjects = [
  {
    root: appRoot,
    resolve: { alias },
    test: {
      name: 'extension',
      include: ['test/**/*.test.ts'],
      exclude: ['test/webview/**'],
      environment: 'node',
    },
  },
  {
    root: appRoot,
    plugins: [react()],
    resolve: { alias },
    test: {
      name: 'webview',
      include: ['test/webview/**/*.test.{ts,tsx}'],
      environment: 'jsdom',
      setupFiles: ['./test/webview/setup.ts'],
    },
  },
];
