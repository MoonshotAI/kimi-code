import { defineConfig } from 'tsdown';

// Electron main process is CommonJS (`out/main.cjs`). `node-pty` (used by
// agent-core's terminal service) is the only native module in the desktop
// closure and must stay external so Electron loads the rebuilt `.node` binary
// at runtime (see asarUnpack).
// Note: `@mariozechner/clipboard` and `koffi` belong to the CLI / pi-tui, not to
// the server/agent-core closure, so they are intentionally NOT listed here.
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
    ],
  },
});
