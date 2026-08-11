import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';

// The icons registry imports unplugin-icons virtual modules (`~icons/*`) and
// `?raw` SVGs — mirror the apps' plugin set (Vue + the `kimi` custom icon
// collection, sourced from this package's own svg dir) so those imports
// resolve under vitest too.
const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  iconsDir: fileURLToPath(new URL('./src/icons/kimi', import.meta.url)),
});

export default defineConfig({
  plugins: preset.plugins,
  test: {
    include: ['test/**/*.test.ts'],
  },
});
