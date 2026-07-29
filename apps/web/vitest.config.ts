import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';

// Web tests import src code, which pulls in unplugin-icons virtual modules
// (`~icons/*`) and `?raw` SVGs. Mirror the web build's plugin set (Vue + the
// `kimi` custom icon collection) so those imports resolve under vitest too —
// same preset as vite.config.ts, but only the plugins (root/build stay
// test-scoped).
const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  iconsDir: fileURLToPath(new URL('./src/icons/kimi', import.meta.url)),
});

export default defineConfig({
  plugins: preset.plugins,
  resolve: {
    alias: {
      // markstream-vue 1.0.7's KaTeX worker imports `katex/dist/contrib/mhchem`,
      // which is not in katex's exports map (`./contrib/mhchem` is). Vite's
      // bundler falls back to filesystem resolution, but vitest's Node-ESM
      // loader is strict — point it at the exported subpath.
      'katex/dist/contrib/mhchem': 'katex/contrib/mhchem',
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    server: {
      deps: {
        // Externalized deps load via Node ESM, where the alias above cannot
        // reach them; run markstream-vue through the Vite pipeline instead.
        inline: [/markstream-vue/],
      },
    },
  },
});
