import { defineConfig } from 'tsdown';

// The extension host loads `./dist/extension.cjs` as CommonJS. All sources
// under src/ are bundled into a single file; `vscode` stays external (provided
// by VS Code) and Node built-ins are external by default. Mirrors
// apps/kimi-desktop's tsdown config (Electron main → out/main.cjs).
export default defineConfig({
  entry: { extension: 'src/extension.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'dist',
  clean: true,
  dts: false,
  fixedExtension: true,
  // Sourcemaps for F5 debugging of src/extension.ts (see .vscode/launch.json).
  sourcemap: true,
  deps: { neverBundle: ['vscode'] },
});
