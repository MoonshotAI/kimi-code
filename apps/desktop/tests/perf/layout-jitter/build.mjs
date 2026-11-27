import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { build } = await import(require.resolve('vite'));
const root = fileURLToPath(new URL('.', import.meta.url));
await build({
  configFile: fileURLToPath(new URL('../../../vite.renderer.config.ts', import.meta.url)),
  root,
  base: './',
  logLevel: 'warn',
  plugins: [{
    name: 'layout-jitter-client', enforce: 'pre',
    options(options) {
      return { ...options, input: { main: resolve(root, 'index.html') } };
    },
    resolveId(id) {
      if (id === '@moonshot-ai/app-client/client') return resolve(root, 'client.mjs');
    },
  }],
  build: { outDir: resolve(process.argv[2]), emptyOutDir: true, rollupOptions: { input: { main: resolve(root, 'index.html') } } },
});
