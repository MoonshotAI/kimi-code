import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';
import { KIMI_CORE_VERSION } from './scripts/kimi-core-version.mjs';

const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  iconsDir: fileURLToPath(
    new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-ui/package.json')),
  ),
});

export default defineConfig({
  plugins: preset.plugins,
  assetsInclude: preset.assetsInclude,
  define: {
    __KIMI_CORE_VERSION__: JSON.stringify(KIMI_CORE_VERSION),
  },
  resolve: {
    alias: {
      'katex/dist/contrib/mhchem': 'katex/contrib/mhchem',
    },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    globalSetup: ['tests/globalSetup.ts'],
    server: {
      deps: {
        inline: [/markstream-vue/],
      },
    },
  },
});
