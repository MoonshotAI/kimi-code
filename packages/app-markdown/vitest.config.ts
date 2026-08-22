import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';

// codeWrap.ts renders icons via @moonshot-ai/app-client/icons, which imports
// unplugin-icons virtual modules (`~icons/*?raw`) — mirror the apps' plugin
// set (the `kimi` custom icon collection, sourced from app-client's own svg
// dir) so those imports resolve under vitest too. Same setup as app-composer.
const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  iconsDir: fileURLToPath(
    new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')),
  ),
});

export default defineConfig({
  plugins: preset.plugins,
  test: {
    include: ['src/**/*.test.ts'],
  },
});
