# Kimi Code Desktop

An Electron desktop client for Kimi Code (product name **Kimi Code Desktop**;
workspace package `@moonshot-ai/kimi-desktop`). It is a thin **shell + process manager**
around the existing web UI (`apps/kimi-web`): it does not reimplement any UI or
backend, it just opens a native window onto the local Kimi server.

## How it works

The web UI cannot run on its own — it needs the Kimi Code **server** (REST + WS
under `/api/v1`). That server already ships as a self-contained single-file
executable (SEA) built from `apps/kimi-code`, with the web UI bundled inside it.

On launch the app:

1. Runs the bundled SEA's `server run`, which reuses a live shared daemon if one
   is already running, or starts one — exactly the same `ensureDaemon` flow the
   CLI (`kimi web`) uses. The daemon binds the well-known port (`58627`) and
   writes `~/.kimi-code/server/lock`, so the CLI, the browser and the TUI all
   share the **same** server.
2. Reads that lock file for the real port and loads the web UI from the daemon's
   origin (e.g. `http://127.0.0.1:58627`) — same-origin, no CORS, no preload.

On quit the daemon is **left running**; it self-exits ~60s after the last client
disconnects, so closing the desktop app never tears down a server another client
is still using.

Key files:

- `src/main/ensure-server.ts` — run the SEA, read the lock, confirm `/healthz`.
- `src/main/sea-path.ts` — resolve the bundled SEA path (dev vs packaged).
- `src/main/index.ts` — window, native menu, window-state, loading/error screens.

## Develop

The dev build loads the SEA from `apps/kimi-code/dist-native/bin/<target>/`, so
build the backend once for your platform first:

```bash
# one-time (rebuild when kimi-code / kimi-web change):
pnpm --filter @moonshot-ai/kimi-web run build
node apps/kimi-code/scripts/copy-web-assets.mjs
pnpm --filter @moonshot-ai/kimi-code run build:native:sea

# then run the desktop app (builds the main process, launches Electron):
pnpm -C apps/kimi-desktop run dev      # or: pnpm dev:desktop  (from repo root)
```

Checks:

```bash
pnpm -C apps/kimi-desktop run typecheck
```

## Package

`dist` builds the main process and runs electron-builder for the **current**
platform. `scripts/before-pack.cjs` stages the matching-platform SEA into the
app's resources (`<resources>/bin/<target>/`).

```bash
# unsigned local build (for your own machine):
CSC_IDENTITY_AUTO_DISCOVERY=false pnpm -C apps/kimi-desktop run dist
# -> apps/kimi-desktop/dist-app/
```

> Do **not** rename a built `.app` bundle — renaming invalidates its code
> signature and macOS will report it as "damaged".

Cross-platform installers are produced in CI (`.github/workflows/desktop-build.yml`),
which builds the SEA on each platform runner and packages there. SEA injection
is per-platform (the blob is injected into the host Node binary), so each OS must
be built on its own runner.

### macOS signing + notarization

An **unsigned** macOS build shows *"app is damaged and can't be opened"* once it
has been transferred to another Mac (Gatekeeper quarantine). To distribute it,
the app must be signed with a **Developer ID Application** certificate and
notarized by Apple. The config (`electron-builder.config.cjs`) applies the
hardened runtime + entitlements (`build/entitlements.mac.plist`) to the app and
the nested SEA, and signing/notarization are environment-driven:

```bash
KIMI_DESKTOP_NOTARIZE=true \
CSC_NAME="Developer ID Application: … (TEAMID)" \
APPLE_API_KEY=/path/AuthKey_XXX.p8 APPLE_API_KEY_ID=XXXX APPLE_API_ISSUER=…uuid… \
pnpm -C apps/kimi-desktop run dist
```

In CI, run the **desktop-build** workflow with `sign-macos: true`; it reuses the
same Apple secrets / keychain action as the TUI native build
(`APPLE_CERTIFICATE_P12`, `APPLE_NOTARIZATION_KEY_*`). The resulting `.dmg` opens
on any Mac without warnings.

> An `Apple Development` certificate is **not** enough — it can sign for your own
> machine but cannot be notarized. You need a `Developer ID Application` cert.

## v1 scope / not done yet

- **Auto-update**: not implemented (v2).
- **Windows / Linux signing**: unsigned in v1 (Windows shows a SmartScreen
  prompt). Only macOS is signed + notarized.
- **App icon**: builds ship the Kimi logo (sourced from the docs site art) on
  macOS, Windows, and Linux.
- **First launch may need network**: the SEA resolves its native sidecars
  (clipboard / koffi) the same way the installed CLI does.
