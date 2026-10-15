import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['./src/extension.ts'],
  format: ['esm'],
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: false,
  sourcemap: false,
  banner: {
    js: [
      "import { fileURLToPath as __cjsShimFileURLToPath } from 'node:url';",
      "import { dirname as __cjsShimDirname } from 'node:path';",
      'const __filename = __cjsShimFileURLToPath(import.meta.url);',
      'const __dirname = __cjsShimDirname(__filename);',
    ].join('\n'),
  },
  deps: {
    onlyBundle: false,
    neverBundle: ['vscode'],
  },
  outputOptions: {
    entryFileNames: 'extension.js',
  },
});
