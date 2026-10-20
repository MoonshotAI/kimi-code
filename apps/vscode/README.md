# Kimi Code for VS Code — web-UI shell prototype

This is a **prototype**, not the production extension. It exists to prove one
thing end-to-end: the real Kimi web UI (the bundle served by `kap-server`) can
run inside a VS Code webview iframe, replacing the old in-process React chat
app that lived here.

## Architecture (3 lines)

1. The extension starts (or discovers) a local `kap-server` via the `kimi` CLI
   (`kimi web --port <port> --no-open`), or connects to an external URL.
2. It reads the server bearer token from `<kimi-home>/server.token`.
3. It renders a full-viewport `<iframe>` pointing at the server itself
   (`<origin>/?kimi_origin=<origin>#token=<token>`) inside a sidebar webview
   view or an editor-area webview panel. Same-origin serving means no CORS
   work; the server allows VS Code webview parents via
   `frame-ancestors ... vscode-webview:` in its CSP.

## How to run

Prerequisites:

- A `kimi` CLI on `PATH`, or a running `kimi web` server (the extension
  discovers live instances from `<kimi-home>/server/instances/`).
- First server start creates `~/.kimi-code/server.token` (0600); the extension
  reads it from there. `~/.kimi-code` is `$KIMI_CODE_HOME` when set.
- Node 20+ and pnpm for building.

Build:

```
pnpm install && pnpm build
```

Then either:

- Press **F5** in VS Code with this folder open to launch an Extension
  Development Host (the `vscode: build extension` task runs first), or
- `npx vsce package --no-dependencies` and install the resulting VSIX
  (`code --install-extension kimi-code-*.vsix`).

Inside VS Code: click the Kimi icon in the activity bar (sidebar view
`kimi.webview`), or run **Kimi Code: Open in New Tab** / **Kimi Code: Open in
Side Panel** from the command palette.

### Settings

- `kimi.serverUrl` — connect to an external server instead of
  discovering/starting one (e.g. `http://127.0.0.1:58627`).
- `kimi.serverToken` — bearer token for the server; defaults to the
  `<kimi-home>/server.token` file.
- `kimi.cliPath` — explicit path to the `kimi` CLI binary.

## Sandbox verification status (2026-10-15, ef727e51 base)

Verified in a headless Linux sandbox (no real VS Code host):

- Extension typecheck + tsdown build clean (`dist/extension.js` ~9.4 kB).
- kap-server comment-free check + security header tests pass (13/13).
- server-manager unit-run: dead/stale instances skipped, live instance
  discovered via healthz, token read, free-port spawn all OK.
- Real kap-server serving the real web bundle: healthz 200, CSP header
  includes `vscode-webview:`, bearer-authed REST `/api/v1/sessions` 200,
  WS handshake with `kimi-code.bearer.<token>` subprotocol -> `server_hello`.
- Headless Chromium loading the exact iframe HTML the extension generates:
  the real UI boots (login via `#token=`), and a full prompt roundtrip
  against a mock LLM rendered streamed answers — both via REST and by typing
  into the composer in the iframe.

Not verified: the vscode-API glue itself (needs a 5-minute F5 smoke test in
real VS Code), VSIX packaging, and the model picker quirk noted below.

## Known limitations

- External links / `window.open` are not intercepted; they may open inside the
  iframe or nowhere.
- Web UI notifications and OS-level integrations degrade inside a webview.
- Remote WSL/SSH scenarios are untested.
- Multi-window behavior is untested (both windows may spawn or attach to the
  same server).
- All old settings (`kimi.yoloMode`, `kimi.autosave`, …) and commands
  (mentions, new conversation, logout, …) are gone in this prototype.
- No editor-context mentions, no inline diff, no keybindings — phase 2.

## Layout

- `src/extension.ts` — the only file importing `vscode`: activation,
  commands, sidebar view, panel, lifecycle.
- `src/server-manager.ts` — pure Node server discovery/spawn/health/token
  logic (no `vscode` import; runnable under plain `node`).
- `src/webview-html.ts` — pure string builder for the iframe HTML.
