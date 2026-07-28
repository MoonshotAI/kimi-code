import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, dialog, nativeTheme, screen, shell } from 'electron';
import type { AppDetailsOptions, BrowserWindowConstructorOptions } from 'electron';

import {
  DESKTOP_DISPLAY_NAME,
  DESKTOP_WINDOWS_APP_ID,
  DESKTOP_WINDOWS_DEV_APP_ID,
} from '../shared/identity';
import { connect } from './connect';
import { installEditableContextMenu } from './context-menu';
import { installDownloadHandler } from './downloads';
import { installExternalLinkGuard } from './external-links';
import { IPC, type LaunchActionPayload, type RendererEventChannel } from './ipc-channels';
import { quoteWindowsCommandLineArg } from './jump-list';
import { log, redactUrlForLog } from './log';
import { isVibrancyEnabled } from './ui-state';

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

/** Bring the main window back on screen (Dock click, tray, notification
    click): un-minimize + show + focus when it exists (including hidden via
    hide-on-close); recreate it after a real destroy. */
export function showMainWindow(): void {
  // Cancel a deferred full-screen hide scheduled by the close handler: the
  // explicit re-show is the fresher intent and wins.
  pendingFullscreenHide = false;
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  } else {
    createWindow();
  }
}

// --- window lifecycle ---------------------------------------------------------

// macOS/Windows hide-on-close (the tray-resident model, like Slack/Discord):
// closing the window only hides it — the renderer, its session state, WS, and
// the tray-select subscription all stay alive, so re-showing (Dock click,
// tray, taskbar) is instant and tray jumps deliver immediately without the
// boot/reload queue. Real quits (Cmd+Q, tray 退出, updater install) go through
// before-quit, which fires before any window close event and flips this
// flag, letting the close proceed to destruction. The listener installs
// lazily from createWindow: module scope must stay Electron-free for tests.
let isQuitting = false;
let quitWatchInstalled = false;

function installQuitWatch(): void {
  if (quitWatchInstalled) return;
  quitWatchInstalled = true;
  app.on('before-quit', () => {
    isQuitting = true;
  });
}

/** Mark the app as quitting so hide-on-close lets real closes through.
    Programmatic quits that bypass before-quit's normal ordering need this:
    Electron emits before-quit only AFTER the window close events when quit
    is initiated by `autoUpdater.quitAndInstall`, so the updater marks it
    explicitly before calling (updater.ts). */
export function markQuitting(): void {
  isQuitting = true;
}

// Deferred hide scheduled by the close handler for a full-screen window (the
// hide only fires once the leave-full-screen transition settles — see
// createWindow). Cleared by showMainWindow: a re-show during the transition
// cancels the stale close intent.
let pendingFullscreenHide = false;

/** Close-button policy: hide instead of destroy on macOS/Windows, unless quitting. */
export function shouldHideOnClose(platform: NodeJS.Platform, quitting: boolean): boolean {
  return (platform === 'darwin' || platform === 'win32') && !quitting;
}

interface SessionEndWindowLike {
  on(event: 'session-end', listener: () => void): unknown;
}

/** Windows does not emit app.before-quit for shutdown, restart, or logoff.
    session-end is final (unlike query-session-end, which can be cancelled),
    so it is safe to let the following close destroy the window. */
export function installWindowsSessionEndWatch(
  platform: NodeJS.Platform,
  win: SessionEndWindowLike,
  markEnding: () => void,
): void {
  if (platform !== 'win32') return;
  win.on('session-end', markEnding);
}

// --- tray "jump to session" routing -------------------------------------------
//
// Tray menu clicks target a renderer that may still be booting or may be
// mid-reload (the View menu exposes Reload/Force Reload). Pushes are only
// safe once the page has settled — by then the Vue app's
// `onTraySelectSession` subscription is in place (module scripts run before
// the load event) — so clicks before that queue up and flush when the load
// settles (did-finish-load, or did-fail-load: a failed/aborted load leaves
// the old, still-subscribed page displayed). With hide-on-close
// (shouldHideOnClose) the renderer otherwise stays alive for the app's
// lifetime, so clicks deliver immediately and the queue only covers boot and
// reload.
let rendererReady = false;
let pendingTraySessionSelect: string | null = null;

/** The tray-select subscription lives in the renderer page (app:// in
    production, the http dev server in dev). The connect error page (data:
    URL) and about:blank have none — readiness must never be marked for them,
    or a queued push would flush into a page that drops it silently. */
export function isAppRendererUrl(url: string): boolean {
  return url.startsWith('app://') || url.startsWith('http://') || url.startsWith('https://');
}

/** Tray menu "jump to this session": push straight to a live, loaded renderer;
    queue while the window is closed or still loading (flushed on load). */
export function selectSessionInRenderer(sessionId: string): void {
  if (mainWindow !== null && !mainWindow.isDestroyed() && rendererReady) {
    sendToRenderer(IPC.traySelectSession, sessionId);
  } else {
    pendingTraySessionSelect = sessionId;
  }
}

let pendingLaunchActions: LaunchActionPayload[] = [];

export function drainLaunchActions(actions: LaunchActionPayload[]): LaunchActionPayload[] {
  return actions.splice(0);
}

/** Forward a launch action (Jump List item, second-instance argv) to a live,
    loaded renderer; queue behind the same readiness gate as tray clicks and
    flush together with them when the load settles. */
export function sendLaunchAction(action: LaunchActionPayload): void {
  if (mainWindow !== null && !mainWindow.isDestroyed() && rendererReady) {
    sendToRenderer(IPC.launchAction, action);
  } else {
    pendingLaunchActions.push(action);
  }
}

// --- renderer event channels (menu / shortcut) -------------------------------
//
// Native menu items and global shortcuts forward to the renderer over the
// preload-whitelisted `kimi:menu-action` / `kimi:shortcut` channels. Task 4.5
// connects the renderer side; here we only open the channels.

export function sendToRenderer(channel: RendererEventChannel, payload: unknown): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// --- window state persistence -------------------------------------------------

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 860 };

/** Saved bounds that (nearly) fill a whole display mean the window was closed
    while maximized or full-screen — relaunch at the default size instead of a
    fake full screen (see shouldPersistBounds; this also heals state files
    written before that guard existed). */
export function looksMaximizedBounds(
  bounds: { width: number; height: number },
  workArea: { width: number; height: number },
): boolean {
  return bounds.width >= workArea.width * 0.95 && bounds.height >= workArea.height * 0.95;
}

/** Clamp saved bounds into the matched display's work area. Display layouts
    change between runs (laptop undocked, monitor re-arranged), and an
    unreachable window — title bar off every screen — is unrecoverable without
    editing the state file. At least MIN_VISIBLE px stay on screen; the top
    edge never goes above the work area (that's where the drag handle is). */
const MIN_VISIBLE_PX = 100;

export function clampBoundsToWorkArea(
  bounds: WindowBounds,
  workArea: { x: number; y: number; width: number; height: number },
): WindowBounds {
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const x = Math.min(
    Math.max(bounds.x, workArea.x - bounds.width + MIN_VISIBLE_PX),
    workArea.x + workArea.width - MIN_VISIBLE_PX,
  );
  const y = Math.min(
    Math.max(bounds.y, workArea.y),
    workArea.y + workArea.height - MIN_VISIBLE_PX,
  );
  return x === bounds.x && y === bounds.y ? bounds : { ...bounds, x, y };
}

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadBounds(): WindowBounds {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Partial<WindowBounds>;
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      const bounds: WindowBounds = {
        width: parsed.width,
        height: parsed.height,
        x: typeof parsed.x === 'number' ? parsed.x : undefined,
        y: typeof parsed.y === 'number' ? parsed.y : undefined,
      };
      const workArea = (
        bounds.x === undefined
          ? screen.getPrimaryDisplay()
          : screen.getDisplayMatching({
              x: bounds.x,
              y: bounds.y ?? 0,
              width: bounds.width,
              height: bounds.height,
            })
      ).workArea;
      if (!looksMaximizedBounds(bounds, workArea)) return clampBoundsToWorkArea(bounds, workArea);
    }
  } catch {
    // No saved state yet, or it is unreadable — fall back to defaults.
  }
  return DEFAULT_BOUNDS;
}

/** Persisted-bounds policy: the live size is only usable from the normal
    state — a maximized/full-screen size would relaunch the window looking
    full-screen, so that path persists the last normal bounds instead. */
export function shouldPersistBounds(maximized: boolean, fullscreen: boolean): boolean {
  return !maximized && !fullscreen;
}

function saveBounds(win: BrowserWindow): void {
  try {
    // In the maximized/full-screen close path, getNormalBounds() still holds
    // the pre-maximize rectangle — persist THAT rather than skipping the
    // write, or the next launch falls back to a stale, older size.
    const bounds = shouldPersistBounds(win.isMaximized(), win.isFullScreen())
      ? win.getBounds()
      : win.getNormalBounds();
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(
      stateFile(),
      JSON.stringify({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y }),
    );
  } catch {
    // Best-effort; losing window position is not worth surfacing an error.
  }
}

// macOS traffic-light anchor, shared by the BrowserWindow option and the
// re-asserts on focus / full-screen transitions below (one value, so the
// re-assert can't drift from the creation-time position). The y offset is
// the top of the traffic-light BUTTON FRAME (≈14px tall), not the 12px dot:
// the dot centres inside its frame, so y 17 puts the dot's centre at ≈24px —
// the midline of the web UI's 48px header row, same line as the
// sidebar-toggle button and header icons.
const TRAFFIC_LIGHT_POSITION = { x: 16, y: 17 } as const;
const WINDOWS_TITLEBAR_HEIGHT = 40;

export function titleBarWindowOptions(
  platform: NodeJS.Platform,
  dark = false,
): Partial<
  Pick<BrowserWindowConstructorOptions, 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'>
> {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHT_POSITION };
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: dark ? '#f2f2f2' : '#202020',
        height: WINDOWS_TITLEBAR_HEIGHT,
      },
    };
  }
  return { titleBarStyle: 'default' };
}

export function applyWindowsTitleBarOverlay(win: BrowserWindow): void {
  if (process.platform !== 'win32' || win.isDestroyed()) return;
  win.setTitleBarOverlay({
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#f2f2f2' : '#202020',
    height: WINDOWS_TITLEBAR_HEIGHT,
  });
}

/** macOS frosted chrome: the window carries a native NSVisualEffectView
    ('menu') behind the renderer's unpainted sidebar column, so backgroundColor
    must stay transparent or it would cover the material. visualEffectState
    'inactive' pins the flat rendering with no focus drift; Electron re-applies
    it from the creation options on every later setVibrancy, so the option is
    always passed and an opt-out launch removes the material right after
    creation instead (see createWindow). */
export function vibrancyWindowOptions(
  platform: NodeJS.Platform,
): { vibrancy?: 'menu'; visualEffectState?: 'inactive'; backgroundColor: string } {
  if (platform === 'darwin') {
    return { vibrancy: 'menu', visualEffectState: 'inactive', backgroundColor: '#00000000' };
  }
  return { backgroundColor: '#0b0b0c' };
}

export function windowsWindowOptions(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  bundleDir: string,
  resourcesPath: string,
): Pick<BrowserWindowConstructorOptions, 'icon'> {
  if (platform !== 'win32') return {};
  return {
    icon: isPackaged
      ? join(resourcesPath, 'build', 'icon.ico')
      : join(bundleDir, '..', 'build', 'icon.ico'),
  };
}

export function windowsAppDetails(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  iconPath: string | undefined,
  execPath: string,
  appPath: string,
): AppDetailsOptions | null {
  if (platform !== 'win32' || iconPath === undefined) return null;
  return {
    appId: isPackaged ? DESKTOP_WINDOWS_APP_ID : DESKTOP_WINDOWS_DEV_APP_ID,
    appIconPath: iconPath,
    appIconIndex: 0,
    relaunchCommand: [execPath, ...(isPackaged ? [] : [appPath])]
      .map(quoteWindowsCommandLineArg)
      .join(' '),
    relaunchDisplayName: isPackaged ? DESKTOP_DISPLAY_NAME : `${DESKTOP_DISPLAY_NAME} Dev`,
  };
}

/** Live-apply the settings vibrancy toggle to the created window. Re-enabling
    re-pins visualEffectState 'inactive' — Electron keeps it from the creation
    options and applies it on every SetVibrancy. */
export function applyWindowVibrancy(enabled: boolean): void {
  if (process.platform !== 'darwin') return;
  if (mainWindow === null || mainWindow.isDestroyed()) return;
  mainWindow.setVibrancy(enabled ? 'menu' : null);
  mainWindow.setBackgroundColor(enabled ? '#00000000' : '#0b0b0c');
}

export function createWindow(): void {
  installQuitWatch();
  const windowsOptions = windowsWindowOptions(
    process.platform,
    app.isPackaged,
    __dirname,
    process.resourcesPath,
  );
  const win = new BrowserWindow({
    ...loadBounds(),
    // Sidebar (264px) + a usable conversation column (~636px) — just above the
    // 640px viewport breakpoint where the UI drops into the mobile layout.
    minWidth: 900,
    minHeight: 480,
    ...vibrancyWindowOptions(process.platform),
    ...windowsOptions,
    title: 'Kimi Code',
    // macOS: hide the native title bar and float the traffic lights over the
    // content; the web UI reserves a draggable strip at the top to clear them.
    // 'hidden' (not 'hiddenInset') so trafficLightPosition can pin the lights
    // (see TRAFFIC_LIGHT_POSITION). 'default' on other platforms (they keep
    // their native title bar).
    ...titleBarWindowOptions(process.platform, nativeTheme.shouldUseDarkColors),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  if (process.platform === 'win32') {
    const details = windowsAppDetails(
      process.platform,
      app.isPackaged,
      typeof windowsOptions.icon === 'string' ? windowsOptions.icon : undefined,
      process.execPath,
      app.getAppPath(),
    );
    if (details !== null) win.setAppDetails(details);
    win.setMenuBarVisibility(false);
    const syncTitleBar = (): void => applyWindowsTitleBarOverlay(win);
    nativeTheme.on('updated', syncTitleBar);
    win.once('closed', () => nativeTheme.removeListener('updated', syncTitleBar));
  }
  // Opted-out launch: the window is still created WITH the material (so the
  // 'inactive' pin is stored for any later re-enable) and it is removed
  // immediately — before the first paint, so there is no frosted flash.
  if (!isVibrancyEnabled()) applyWindowVibrancy(false);
  // The fresh renderer boot is not subscribed yet — tray session-select clicks
  // queue until did-finish-load below flips this back on.
  rendererReady = false;
  // External http(s) links (PR pages, OAuth, Markdown anchors) open in the
  // system browser, not in frameless Electron windows; cross-origin
  // navigation of the main window is intercepted the same way.
  installExternalLinkGuard(win.webContents, (url) => shell.openExternal(url));
  // Right-click in any text field (find bar, composer, rename inputs) shows
  // the native editing menu — Electron has no default one.
  installEditableContextMenu(win.webContents);
  // Exports (session zip, trace logs) always prompt a native save dialog and
  // remember the last used directory. The handler outlives this window (one
  // install per session), so the dialog parent is resolved at call time.
  installDownloadHandler(win.webContents.session, {
    showSaveDialog: (opts) => {
      const current = getMainWindow();
      return current === null || current.isDestroyed()
        ? dialog.showSaveDialogSync(opts)
        : dialog.showSaveDialogSync(current, opts);
    },
    downloadsDir: app.getPath('downloads'),
  });
  // Keep the window title as the product name. The web page sets document.title
  // ("Kimi Code"), which would otherwise replace it.
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  // macOS traffic lights.
  //
  // 1) Visibility across transitions: with titleBarStyle 'hidden' + a custom
  //    trafficLightPosition, the buttons can vanish (or lose their custom
  //    position) after a full-screen round-trip or on re-focus. Re-assert both
  //    on those transitions (observed on Electron 33; belt-and-braces).
  //
  // 2) Blur is NOT such a case: unfocused traffic lights are merely DIMMED by
  //    AppKit, and the dimmed color follows the WINDOW appearance, not the
  //    page (electron#27295) — with the OS in dark mode but the web UI on a
  //    light theme, the light-gray dimmed dots become invisible against the
  //    light sidebar. That is fixed by the theme sync over the preload IPC
  //    channel (`kimi:theme`), which keeps the window appearance aligned with
  //    the web UI's <html data-color-scheme>.
  if (process.platform === 'darwin') {
    const showTrafficLights = (): void => {
      if (win.isDestroyed()) return;
      win.setWindowButtonPosition(TRAFFIC_LIGHT_POSITION);
      win.setWindowButtonVisibility(true);
    };
    win.on('enter-full-screen', showTrafficLights);
    win.on('leave-full-screen', showTrafficLights);
    win.on('focus', showTrafficLights);
  }
  // Keep the renderer's fullscreen state in sync so the web UI can adapt (on
  // macOS the traffic lights hide in full-screen, so the sidebar expand button
  // hugs the left edge instead of leaving their slot empty). `isFullScreen()`
  // is already true/false when these fire; the pair covers every transition.
  const notifyFullscreen = (): void => {
    sendToRenderer(IPC.fullscreenChanged, win.isFullScreen());
  };
  win.on('enter-full-screen', notifyFullscreen);
  win.on('leave-full-screen', notifyFullscreen);
  installWindowsSessionEndWatch(process.platform, win, markQuitting);
  win.on('close', (event) => {
    saveBounds(win);
    if (shouldHideOnClose(process.platform, isQuitting)) {
      event.preventDefault();
      // A detached DevTools window would linger on screen after the hide.
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      // Hiding a full-screen window would leave a black space behind (macOS)
      // — exit full-screen first, hide once the transition settles.
      if (win.isFullScreen()) {
        pendingFullscreenHide = true;
        win.setFullScreen(false);
        win.once('leave-full-screen', () => {
          if (pendingFullscreenHide && !win.isDestroyed()) win.hide();
          pendingFullscreenHide = false;
        });
      } else {
        win.hide();
      }
    }
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
    // With hide-on-close this only fires on real destruction (quit / updater
    // install) — the tray is torn down on quit anyway. Unread flags are
    // durable (localStorage) and pending approvals/questions live server-side,
    // so the badge's last-known state stays plausible until then.
  });
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  // Gate readiness on REAL renderer replacements only: cross-document,
  // main-frame navigations. did-start-loading must NOT do this — Electron 43
  // fires it for same-document navigations too (pushState route changes,
  // history back/forward), which never get a did-finish-load; gating on it
  // wedged the flag false after the first in-app route change (including the
  // boot auto-select), silently queueing every later tray click forever.
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    // A reload replaces the renderer and its tray-select subscription; queue
    // clicks again until the load settles (either handler below).
    rendererReady = false;
  });
  // Settle funnel for the ready flag. Success marks the fresh page ready; a
  // failed/aborted navigation leaves the previously committed page (and its
  // tray-select subscription) displayed, so failure restores readiness too —
  // one wedged false here used to swallow every later tray click into a flush
  // that never came. The connect error page never qualifies (isAppRendererUrl),
  // so a queued click survives it and flushes once the real renderer loads.
  const settleRendererReady = (isMainFrame: boolean): void => {
    if (win.isDestroyed() || !isMainFrame || !isAppRendererUrl(win.webContents.getURL())) return;
    rendererReady = true;
    if (pendingTraySessionSelect !== null) {
      sendToRenderer(IPC.traySelectSession, pendingTraySessionSelect);
      pendingTraySessionSelect = null;
    }
    for (const action of drainLaunchActions(pendingLaunchActions)) {
      sendToRenderer(IPC.launchAction, action);
    }
  };
  win.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    settleRendererReady(isMainFrame);
  });
  win.webContents.on('did-fail-provisional-load', (_event, _code, _desc, _url, isMainFrame) => {
    settleRendererReady(isMainFrame);
  });
  // A crashed/killed renderer (OOM, GPU fault) shows the user a frozen or
  // blank page with no other trace — the log file is the only record.
  win.webContents.on('render-process-gone', (_event, details) => {
    log.error(
      `[kimi-desktop] renderer process gone (reason=${details.reason} exitCode=${details.exitCode})`,
    );
  });
  win.webContents.on('did-finish-load', () => {
    settleRendererReady(true);
    if (win.isDestroyed()) return;
    const factor = win.webContents.getZoomFactor();
    const level = win.webContents.getZoomLevel();
    void win.webContents
      .executeJavaScript('window.devicePixelRatio')
      .then((dpr) => {
        if (win.isDestroyed()) return;
        // Redact before logging: the loaded URL carries the server token in
        // `#token=` and the connect origin (possibly with basic-auth
        // userinfo) in `?kimi_origin=` — neither may persist to the log file.
        const url = redactUrlForLog(win.webContents.getURL());
        log.info(
          `[kimi-desktop diag] zoom factor=${factor} level=${level} devicePixelRatio=${dpr} url=${url}`,
        );
      })
      .catch(() => {});
  });
  void connect(win);
}
