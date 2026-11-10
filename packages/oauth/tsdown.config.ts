import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/index.ts', './src/device.ts', './src/provider-credential.ts'],
  format: ['esm'],
  dts: true,
  outDir: 'dist',
  clean: true,
});
