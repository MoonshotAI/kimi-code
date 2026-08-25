// PR preview window: the preview renderer build opens in its own
// BrowserWindow; the main window is never swapped.
//
// How it works: the preview window lives in a dedicated in-memory session
// partition, and `app://renderer/*` is registered per session
// (protocol.ts registerPreviewRendererProtocol) — the default session serves
// the regular dist, the preview session serves the preview worktree's dist.
// Both windows share scheme and origin, so the embedded server's origin
// allowlist needs no change, while in-app URL pushes (`/sessions/<id>`) and
// window reloads always stay on the preview build (there is no prefix to
// escape). The server is still the host process's (renderer-only preview —
// server / main-process behavior is out of scope, the standing Phase 1
// boundary).
//
// Lifecycle: at most one preview window exists — opening a new preview
// reuses it (swap dist root, reload, retitle, focus); closing the window
// directly is equivalent to exiting the preview (reported back through the
// injected setDistRoot); stopPreview / app teardown destroys the window. The
// window does not hide-on-close and does not persist window-state.

import { join } from 'node:path';

import { BrowserWindow, app, nativeTheme, session, shell } from 'electron';

import { rendererUrl, registerPreviewRendererProtocol } from './protocol';
import { installEditableContextMenu } from './context-menu';
import { installExternalLinkGuard } from './external-links';
import { log } from './log';
import { isVibrancyEnabled } from './ui-state';
import { titleBarWindowOptions, vibrancyWindowOptions, windowsWindowOptions } from './window';

// In-memory partition (no `persist:`): storage starts empty each app run and
// survives reloads within it — a fresh, isolated renderer profile per boot.
const PREVIEW_PARTITION = 'kimi-pr-preview';

export interface OpenPreviewWindowOptions {
  /** Display label (`#362` / branch name), goes into the window title. */
  label: string;
  /** Absolute path of the preview worktree's desktop-dist (the session's content root). */
  distRoot: string;
  /** Server origin (the embedded server's loopback address, or an external server origin). */
  origin: string;
  /** Bearer token for an external server (undefined for the embedded server). */
  token?: string;
}

/** Sets the preview dist root (the session route's data source) — injected
    by the caller (connect.ts's setPreviewDistRoot) so this module does not
    depend back on the connection layer. */
export type SetPreviewDistRoot = (root: string | null) => void;

let previewWindow: BrowserWindow | null = null;
let previewSessionInitialised = false;

/** Register `app://renderer/*` on the preview session partition (idempotent;
    call once at app ready, next to registerRendererProtocol). */
export function initPreviewSession(getDistRoot: () => string | null): void {
  if (previewSessionInitialised) return;
  previewSessionInitialised = true;
  registerPreviewRendererProtocol(session.fromPartition(PREVIEW_PARTITION), getDistRoot);
}

export function isPreviewWindowOpen(): boolean {
  return previewWindow !== null && !previewWindow.isDestroyed();
}

/** Open (or reuse) the preview window for a freshly built preview. */
export function openPreviewWindow(opts: OpenPreviewWindowOptions, setDistRoot: SetPreviewDistRoot): void {
  setDistRoot(opts.distRoot);
  const url = rendererUrl(opts.origin, opts.token, undefined, true, isVibrancyEnabled());
  if (isPreviewWindowOpen()) {
    const win = previewWindow!;
    win.setTitle(`PR Preview ${opts.label}`);
    void win.loadURL(url);
    win.show();
    win.focus();
    log.info(`[kimi-desktop] preview window reloaded for ${opts.label}`);
    return;
  }

  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 480,
    ...vibrancyWindowOptions(process.platform),
    ...windowsWindowOptions(process.platform, app.isPackaged, __dirname, process.resourcesPath),
    title: `PR Preview ${opts.label}`,
    ...titleBarWindowOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      session: session.fromPartition(PREVIEW_PARTITION),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  previewWindow = win;
  // Same affordances as the main window: external links open in the system
  // browser, text fields get the native editing context menu.
  installExternalLinkGuard(win.webContents, (target) => shell.openExternal(target));
  installEditableContextMenu(win.webContents);
  win.once('closed', () => {
    previewWindow = null;
    // A direct user close = exit preview: clear the dist root too (the
    // session route then 404s, so no stale preview is served before the next
    // open). State cleanup proper happens via stopPreview at the call sites.
    setDistRoot(null);
    log.info('[kimi-desktop] preview window closed by user');
  });
  void win.loadURL(url);
  win.show();
  log.info(`[kimi-desktop] preview window opened for ${opts.label}`);
}

/** Destroy the preview window (stopPreview / app teardown). Idempotent. */
export function closePreviewWindow(): void {
  if (isPreviewWindowOpen()) {
    previewWindow!.destroy();
  }
  previewWindow = null;
}
