# Kimi Code for VS Code

A VS Code extension (workspace package `kimi-vscode`) that adds a
Kimi icon to the activity bar. Clicking it opens a sidebar webview that embeds
the existing web UI (`apps/kimi-web`) — same UI as the browser and the desktop
app, not a reimplementation.

## How it works

It follows the `apps/kimi-desktop` model (shell + process manager, no UI or
backend code of its own):

1. On first open the extension starts the local Kimi server **in the
   foreground** with `KIMI_CODE_EXPERIMENTAL_MULTI_SERVER=1` so it coexists
   with a user's own daemon (its port falls through the kap-server `port + 1`
   walk). What it spawns depends on how the extension itself was installed:
   - **packaged (vsix)**: the CLI's single-file JS bundle (`server/main.cjs`)
     running under VS Code's own Electron Node (`ELECTRON_RUN_AS_NODE=1` on
     the extension host's `process.execPath` — the same switch VS Code's
     `code` launcher uses). The bundle is staged into global storage together
     with the embedded web UI and node-pty's native binaries, which are
     **lifted from VS Code's own install** (`resources/app/node_modules/
     node-pty`, the copy the integrated terminal uses — so the ABI always
     matches; lifting the native payloads of another app is the same trick
     `p2p-live-share` uses). No platform binaries ship inside the extension.
   - **dev (this monorepo)**: the apps/kimi-code sources via tsx (same spawn
     line as the root `pnpm dev:kap-server` script, plus `--log-level error`),
     serving `apps/kimi-code/dist-web`.
2. The actual origin and bearer token are parsed from the server's ready line
   (`Kimi server: http://127.0.0.1:PORT/#token=<token>`), then the extension
   registers EVERY workspace folder (single- or multi-root) via
   `POST /api/v1/workspaces`, in VS Code folder order (idempotent on root).
3. The webview is a one-file shell whose `<iframe>` points at that origin with
   the token in the `#token=` fragment (exactly what `kimi web` appends when
   opening a browser), the primary folder in `?workspace=`, and the full
   folder list as repeatable `&folder=` params — kimi-web's workspace hint
   (`apps/kimi-web/src/lib/workspaceHint.ts`) then pins its initial selection
   to the primary folder AND focuses every workspace listing (sidebar groups,
   switchers, per-workspace session loading) on exactly those folders, in the
   VS Code folder order: the embedded view shows no other workspaces, and
   add-workspace entry points are hidden. The server serves the built web UI
   same-origin, so the iframe needs no CORS, no special kimi-web build, and no
   copied code: the standard self-contained `vite build` output is used as-is.
   Because VS Code theming never reaches the cross-origin iframe via
   `prefers-color-scheme`, the extension also pushes its active theme kind
   through a postMessage bridge (`window.activeColorTheme.kind` +
   `onDidChangeActiveColorTheme`, answered by the shell after each load) —
   kimi-web's 'system' mode then resolves to the VS Code theme at the
   `data-color-scheme` attribute level.

`Kimi Code: Restart Server` (command palette) respawns the server and
re-renders the view. Closing VS Code kills the spawned server.

## Develop

Prereq — build the web UI assets that the server serves (same step as
kimi-desktop's dev flow, rerun when kimi-web / kimi-code change):

```bash
pnpm --filter @moonshot-ai/kimi-web run build
node apps/kimi-code/scripts/copy-web-assets.mjs
```

Then build the extension and open an Extension Development Host (a new VS Code
window running the extension, with this repo root as its workspace):

```bash
pnpm -C apps/kimi-vscode run dev
```

Click the Kimi icon in the activity bar. Server logs go to the
**Output → Kimi Code** channel.

## Debug (F5)

The repo root carries a tracked `.vscode/launch.json` ("Run Kimi Extension")
and `.vscode/tasks.json`. With the repo root folder open:

1. Press **F5** (Run and Debug → "Run Kimi Extension"). The `preLaunchTask`
   rebuilds the extension (tsdown, with sourcemaps), then an Extension
   Development Host window opens on this repo.
2. Set breakpoints in `apps/kimi-vscode/src/extension.ts` — they bind through
   the emitted sourcemap into `dist/extension.cjs`.
3. Iterate: edit source → **Ctrl/Cmd-R (Restart)** in the debug toolbar (the
   preLaunchTask rebuilds first). For watch-mode rebuilds, run the
   `watch: kimi-vscode` task and use **Developer: Reload Window** in the dev
   host.

Caveats: breakpoints only bind after the bundle is built; the spawned Kimi
server is a separate child process, so extension breakpoints do not pause it —
use **Output → Kimi Code** for its logs. In the dev host the extension prefers
the repo's CLI sources (tsx) over the packaged bundle, so after web or CLI
edits just rebuild (`pnpm --filter @moonshot-ai/kimi-web run build && node
apps/kimi-code/scripts/copy-web-assets.mjs`) and run `Kimi Code: Restart
Server` — no repackaging needed.

Checks:

```bash
pnpm -C apps/kimi-vscode run typecheck
```

## Package / release

The vsix is a **universal** package (no per-platform builds): it ships the
CLI's single-file server bundle + the web UI, and node-pty natives come from
the user's own VS Code at runtime.

```bash
# one-time prereqs (also run by CI):
pnpm --filter @moonshot-ai/kimi-web run build
node apps/kimi-code/scripts/copy-web-assets.mjs
pnpm --filter @moonshot-ai/kimi-code run build:native:js

# stage server/ (main.cjs + package.json + dist-web) and package the vsix:
pnpm -C apps/kimi-vscode run prepare:server
pnpm -C apps/kimi-vscode run package    # -> apps/kimi-vscode/artifacts/*.vsix
```

Test the packaged flow without installing: `code --install-extension
apps/kimi-vscode/artifacts/kimi-vscode-*.vsix` (then reload the window and
open the Kimi view; uninstall afterwards with
`code --uninstall-extension moonshot-ai.kimi-vscode`).

Release automation lives in `.github/workflows/vscode-extension.yml` —
currently **manual-only** (`workflow_dispatch`), building the universal vsix
as an artifact and publishing to the marketplace only when dispatched with
`publish: true` (requires the `VSCE_PAT` secret for the `moonshot-ai`
publisher; `--skip-duplicate` makes re-runs idempotent).
