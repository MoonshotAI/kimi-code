import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const require = createRequire(new URL('../../../package.json', import.meta.url));
const { build } = await import(require.resolve('vite'));
const root = fileURLToPath(new URL('.', import.meta.url));
await build({
  configFile: fileURLToPath(new URL(process.env.PERF_WEB ? '../../../vite.web.config.ts' : '../../../vite.renderer.config.ts', import.meta.url)),
  root,
  base: './',
  plugins: [{
    name: 'history-fixture-client', enforce: 'pre',
    options(options) {
      return { ...options, input: { main: resolve(root, 'index.html') } };
    },
    resolveId(id) {
      if (id === '@moonshot-ai/app-client/client') return resolve(root, 'client.mjs');
    },
    transform(source, id) {
      if (process.argv[2] === 'baseline' && id.endsWith('/chat/ConversationPane.vue')) {
        return source.replace(/:window-history="[^"]*"/g, ':window-history="false"');
      }
    },
  }],
  build: { outDir: resolve(process.argv[3]), emptyOutDir: true, rollupOptions: { input: { main: resolve(root, 'index.html') } } },
});
