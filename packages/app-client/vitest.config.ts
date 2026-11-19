import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';

const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  iconsDir: fileURLToPath(new URL('./src/icons/kimi', import.meta.url)),
});

export default defineConfig({
  plugins: preset.plugins,
  assetsInclude: preset.assetsInclude,
  test: {
    include: ['test/**/*.test.ts'],
  },
});
