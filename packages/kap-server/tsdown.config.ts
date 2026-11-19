import { defineConfig } from 'tsdown';

import {
  BUILT_IN_CATALOG_DEFINE,
  builtInCatalogDefine,
} from '../../apps/kimi-code/scripts/built-in-catalog.mjs';
import { rawTextPlugin } from '../../build/raw-text-plugin.mjs';

export default defineConfig({
  entry: ['./src/index.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
  plugins: [rawTextPlugin()],
  define: {
    [BUILT_IN_CATALOG_DEFINE]: builtInCatalogDefine(),
  },
});
