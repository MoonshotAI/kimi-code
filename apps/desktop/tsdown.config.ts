import { defineConfig } from 'tsdown';
import { rawTextPlugin } from './scripts/raw-text-plugin.mjs';

// Electron main process is CommonJS (`out/main.cjs`). `node-pty` (used by
// agent-core's terminal service) is the only native module in the desktop
// closure and must stay external so Electron loads the rebuilt `.node` binary
// at runtime (see asarUnpack). `@moonshot-ai/*` workspace packages are bundled
// (transpiled) because Electron cannot `require()` their raw `.ts` sources; the
// `?raw` asset suffix used inside agent-core is inlined by `rawTextPlugin`.
// Note: `@mariozechner/clipboard` and `koffi` belong to the CLI / pi-tui, not to
// the server/agent-core closure, so they are intentionally NOT listed here.
export default defineConfig({
  entry: { main: 'src/main/index.ts', preload: 'src/main/preload.ts' },
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  outDir: 'out',
  clean: true,
  dts: false,
  fixedExtension: true,
  plugins: [rawTextPlugin()],
  // Bundle every @moonshot-ai/* package (server / agent-core / sdk / oauth /
  // kaos / kosong / protocol …) and transpile their TypeScript sources into the
  // CJS main process. They are `workspace:^` packages whose `exports` point at
  // `src/*.ts`; Electron (Node 20) cannot `require()` raw `.ts`, so leaving them
  // external makes the main process throw on load at runtime.
  noExternal: [/^@moonshot-ai\//],
  deps: {
    neverBundle: [
      'electron',
      'node-pty',
    ],
  },
});
