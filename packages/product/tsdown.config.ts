import { defineConfig } from 'tsdown';

import packageJson from './package.json' with { type: 'json' };

export default defineConfig({
  entry: Object.fromEntries(
    Object.entries(packageJson.exports).map(([path, entry]) => [path.slice(2), entry.default]),
  ),
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
});
