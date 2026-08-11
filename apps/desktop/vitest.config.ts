import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';
import { kimiRendererViteConfig } from '@moonshot-ai/vite-preset';
import { KIMI_CORE_VERSION } from './scripts/kimi-core-version.mjs';

// Renderer tests import src/renderer code, which pulls in unplugin-icons
// virtual modules (`~icons/*`) and `?raw` SVGs. Mirror the renderer build's
// plugin set (Vue + the `kimi` custom icon collection) so those imports
// resolve under vitest too — same preset as vite.renderer.config.ts, but
// only the plugins (root/build stay test-scoped).
const preset = kimiRendererViteConfig({
  root: fileURLToPath(new URL('./src/renderer', import.meta.url)),
  iconsDir: fileURLToPath(
    new URL('./src/icons/kimi', import.meta.resolve('@moonshot-ai/app-client/package.json')),
  ),
});

export default defineConfig({
  plugins: preset.plugins,
  // Main-process code (src/main/server.ts) references the tsdown-injected
  // __KIMI_CORE_VERSION__; provide the same define so main tests can import it.
  define: {
    __KIMI_CORE_VERSION__: JSON.stringify(KIMI_CORE_VERSION),
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
  },
});
