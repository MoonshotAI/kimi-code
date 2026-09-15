import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/device.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
});
