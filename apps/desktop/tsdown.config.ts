import { defineConfig } from 'tsdown';

// Electron main process is CommonJS (`out/main.cjs`). Native modules loaded via
// agent-core (`node-pty`, optional clipboard/koffi) must stay external so
// Electron loads the rebuilt `.node` binaries at runtime (see asarUnpack).
export default defineConfig({
  entry: { main: 'src/main/index.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'out',
  clean: true,
  dts: false,
  fixedExtension: true,
  deps: {
    neverBundle: [
      'electron',
      'node-pty',
      '@mariozechner/clipboard',
      '@mariozechner/clipboard-darwin-arm64',
      '@mariozechner/clipboard-darwin-x64',
      '@mariozechner/clipboard-win32-x64',
      '@mariozechner/clipboard-linux-x64',
      '@mariozechner/clipboard-linux-arm64',
      'koffi',
    ],
  },
});
