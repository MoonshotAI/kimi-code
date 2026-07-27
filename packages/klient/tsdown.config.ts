import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/transports/ipc/index.ts', './src/transports/memory/index.ts'],
  format: ['esm'],
  dts: false,
  outDir: 'dist',
  clean: true,
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [],
  },
});
