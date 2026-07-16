import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';

// Renderer tests import src/renderer code, which pulls in unplugin-icons
// virtual modules (`~icons/*`) and `?raw` SVGs. Mirror the renderer build's
// plugin set (Vue + the `kimi` custom icon collection) so those imports
// resolve under vitest too — same preset as vite.renderer.config.ts, but
// only the plugins (root/build stay test-scoped).
const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  iconsDir: fileURLToPath(new URL('./src/renderer/icons/kimi', import.meta.url)),
});

export default defineConfig({
  plugins: preset.plugins,
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
