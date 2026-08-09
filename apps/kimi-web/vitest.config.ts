import { fileURLToPath } from 'node:url';

import Icons from 'unplugin-icons/vite';
import { FileSystemIconLoader } from 'unplugin-icons/loaders';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    // The `~icons/kimi/*` virtual modules used by src/lib/icons.ts come from
    // the Icons plugin; without it the imports fail to resolve in tests.
    Icons({
      compiler: 'vue3',
      customCollections: {
        kimi: FileSystemIconLoader(fileURLToPath(new URL('./src/icons/kimi', import.meta.url))),
      },
    }),
  ],
  test: {
    name: 'kimi-web',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});
