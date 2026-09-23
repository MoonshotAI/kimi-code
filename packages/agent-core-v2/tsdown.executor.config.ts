import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { executor: './src/remote/server/standalone.ts' },
  format: ['esm'],
  dts: false,
  outDir: 'dist-executor',
  clean: true,
  deps: {
    alwaysBundle: [/^@moonshot-ai\//],
  },
});
