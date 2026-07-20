import { defineConfig } from 'tsdown';
import { rawTextPlugin } from './scripts/raw-text-plugin.mjs';
import { KIMI_CORE_VERSION } from './scripts/kimi-core-version.mjs';

// The embedded server reports `server_version` (GET /api/v1/meta) from
// kap-server's `version` opt. Its default reads the package.json next to the
// kap-server module — which, once everything is bundled into out/main.cjs, is
// the DESKTOP app's own package.json, so the settings "server version" row
// duplicated the app version. Inject the kimi-code core (CLI) version from
// the submodule instead (scripts/kimi-core-version.mjs), so the embedded
// server reports the same engine version a standalone CLI daemon would.

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
  define: {
    __KIMI_CORE_VERSION__: JSON.stringify(KIMI_CORE_VERSION),
  },
  deps: {
    // Bundle every @moonshot-ai/* package (server / agent-core / sdk / oauth /
    // kaos / kosong / protocol …) and transpile their TypeScript sources into the
    // CJS main process. They are `workspace:^` packages whose `exports` point at
    // `src/*.ts`; Electron (Node 20) cannot `require()` raw `.ts`, so leaving them
    // external makes the main process throw on load at runtime.
    alwaysBundle: [/^@moonshot-ai\//],
    neverBundle: [
      'electron',
      'node-pty',
      // electron-updater lazy-requires `electron` and resolves the app update
      // feed at runtime; bundling breaks both. It ships as a production dep
      // (packed into the asar like node-pty) and stays an external require.
      'electron-updater',
    ],
    // This is an app bundle (private package, not published): inlining the
    // transitive deps of the workspace packages is intended, so acknowledge the
    // `deps.onlyBundle` hint instead of maintaining a second allowlist.
    onlyBundle: false,
  },
});
