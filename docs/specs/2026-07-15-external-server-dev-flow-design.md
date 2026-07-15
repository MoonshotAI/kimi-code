# External Server Dev Flow — Design

Date: 2026-07-15
Status: Approved by user (2026-07-15)

## Problem

`kimi-code` is a git submodule of `code-app`. Iterating on `kimi-code` server
changes through the desktop app is painful: every server-side change has to be
applied inside the submodule checkout and picked up by the Electron main
process that spawns the embedded server.

## Goal

Allow running the server directly from a `kimi-code` working clone (where
changes can be edited and restarted freely), and point both `code-app`
frontends at it via one environment variable:

```bash
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:web
```

When `KIMI_SERVER_URL` is set, the Electron main process must NOT spawn the
embedded server.

## Current State (verified)

- **web**: already supported. `apps/web/vite.config.ts` reads
  `process.env.KIMI_SERVER_URL` (default `http://127.0.0.1:58627`) and proxies
  `/api/v1` (REST + WS) to it. No code change needed.
- **desktop**: `connect()` in `apps/desktop/src/main/index.ts` unconditionally
  calls `startDesktopServer()` (`src/main/server.ts`), then loads the renderer
  with `rendererUrl(origin, token)` — the renderer reads `kimi_origin` from the
  URL query (see `apps/web/src/api/config.ts`). Token comes from
  `readServerToken()` in main, which reads
  `serverTokenPath(resolveKimiHome())`.
- **kimi-code side**: `pnpm dev:server` in a kimi-code clone runs
  `kimi server run --foreground`; default port is `DEFAULT_SERVER_PORT = 58627`
  (`apps/kimi-code/src/cli/sub/server/shared.ts`). `kap-server` accepts a
  `KIMI_CODE_CORS_ORIGINS` env allowlist
  (`packages/kap-server/src/middleware/origin.ts`), covering both REST and WS
  origin checks.

## Decisions (from user)

1. **Server startup**: fully manual + documented. The user starts the server
   in the kimi-code clone themselves; no wrapper script in `code-app`, no
   changes to kimi-code's `dev:server` script.
2. **Token**: shared `KIMI_HOME`. Both sides default to `~/.kimi-code`, so the
   desktop's existing `readServerToken()` reads the same token file the
   external server writes — zero token plumbing. If the server is started with
   a custom `KIMI_HOME`, the desktop must be started with the same one
   (documented).

## Design

### 1. Desktop change (`apps/desktop/src/main/index.ts`)

At the top of `connect()`:

- Read `process.env.KIMI_SERVER_URL`; normalize (trim trailing slash / `/v1`,
  same rules as `normalizeServerOrigin` in web's `config.ts`).
- If set (**external mode**):
  - Close and clear any existing `serverHandle` (so menu "重试连接" after an
    embedded session cannot leak an embedded server).
  - Skip `startDesktopServer()` entirely.
  - `origin = <external url>`, `token = readServerToken()` (shared KIMI_HOME).
  - Log `[kimi-desktop] connected to external server <origin>`.
- If unset: existing embedded path, unchanged.

Both modes then converge on `win.loadURL(rendererUrl(origin, token))`.
Failure to reach the external server surfaces through the renderer's own
connection error UI; the "重试连接" menu naturally re-attempts the external
URL. No dedicated health check.

### 2. Web change

None.

### 3. Documentation (`docs/dev-with-external-server.md`)

New doc with the exact workflow:

```bash
# 1. In a kimi-code clone (e.g. ~/code/kimi-code-5), start the server with
#    the desktop renderer origin allowlisted (needed only for desktop; the
#    web dev server proxies same-origin and needs no CORS):
KIMI_CODE_CORS_ORIGINS=app://renderer pnpm dev:server

# 2a. Desktop against that server (embedded server is NOT started):
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:desktop

# 2b. Or web against that server:
KIMI_SERVER_URL=http://127.0.0.1:58627 pnpm dev:web
```

Notes to include:

- Token is shared via `KIMI_HOME` (`~/.kimi-code` by default); if the server
  runs with a custom `KIMI_HOME`, pass the same `KIMI_HOME` to `pnpm
  dev:desktop`.
- The external server uses the CLI's host identity (not `kimi-desktop`),
  which is fine for development.
- `pnpm dev:desktop` without `KIMI_SERVER_URL` keeps the current embedded
  behavior.

### 4. Tests

- Embedded path stays covered by existing `src/main/server.test.ts`.
- Add a focused unit test for the external-mode branch if the extracted
  origin-resolution helper is testable in isolation (extract a small pure
  helper `resolveConnectTarget(): { origin, token, external }` to make it so);
  otherwise manual verification per the doc.

### 5. Out of scope (YAGNI)

- No `KIMI_SERVER_TOKEN` env override.
- No `code-app`-side wrapper script for starting the kimi-code server.
- No kimi-code changes.
- No health check / auto-fallback to embedded mode.
- No changes to the web renderer copy sync flow.

## Errata

- 2026-07-15 (final review): the custom-home env var is `KIMI_CODE_HOME`, not
  `KIMI_HOME` — nothing in kimi-code (CLI `KIMI_CODE_HOME_ENV`,
  `apps/kimi-code/src/constant/app.ts:41`) or the desktop stack
  (`resolveKimiHome`, `packages/agent-core/src/config/path.ts:6`) reads
  `KIMI_HOME`. `docs/dev-with-external-server.md` uses `KIMI_CODE_HOME`.
