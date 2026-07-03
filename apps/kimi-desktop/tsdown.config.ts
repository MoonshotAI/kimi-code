import { defineConfig } from 'tsdown';

// The Electron main process is loaded as CommonJS (`out/main.cjs`). All sources
// under src/main are bundled into a single file; `electron` stays external
// (provided by the Electron runtime) and Node built-ins are external by default.
export default defineConfig({
  entry: { main: 'src/main/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'out',
  clean: true,
  dts: false,
  fixedExtension: true,
  deps: { neverBundle: ['electron'] },
});
