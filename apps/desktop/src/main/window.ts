import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, dialog, shell } from 'electron';

import { connect } from './connect';
import { installDownloadHandler } from './downloads';
import { installExternalLinkGuard } from './external-links';
import { IPC, type RendererEventChannel } from './ipc-channels';

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// --- renderer event channels (menu / shortcut) -------------------------------
//
// Native menu items and global shortcuts forward to the renderer over the
// preload-whitelisted `kimi:menu-action` / `kimi:shortcut` channels. Task 4.5
// connects the renderer side; here we only open the channels.

export function sendToRenderer(channel: RendererEventChannel, payload: string | boolean): void {
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

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadBounds(): WindowBounds {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Partial<WindowBounds>;
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      return {
        width: parsed.width,
        height: parsed.height,
        x: typeof parsed.x === 'number' ? parsed.x : undefined,
        y: typeof parsed.y === 'number' ? parsed.y : undefined,
      };
    }
  } catch {
    // No saved state yet, or it is unreadable — fall back to defaults.
  }
  return DEFAULT_BOUNDS;
}

function saveBounds(win: BrowserWindow): void {
  try {
    const bounds = win.getBounds();
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

export function createWindow(): void {
  const win = new BrowserWindow({
    ...loadBounds(),
    // Sidebar (264px) + a usable conversation column (~636px) — just above the
    // 640px viewport breakpoint where the UI drops into the mobile layout.
    minWidth: 900,
    minHeight: 480,
    backgroundColor: '#0b0b0c',
    title: 'Kimi Code',
    // macOS: hide the native title bar and float the traffic lights over the
    // content; the web UI reserves a draggable strip at the top to clear them.
    // 'hidden' (not 'hiddenInset') so trafficLightPosition can pin the lights
    // (see TRAFFIC_LIGHT_POSITION). 'default' on other platforms (they keep
    // their native title bar).
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: TRAFFIC_LIGHT_POSITION,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  mainWindow = win;
  // External http(s) links (PR pages, OAuth, Markdown anchors) open in the
  // system browser, not in frameless Electron windows; cross-origin
  // navigation of the main window is intercepted the same way.
  installExternalLinkGuard(win.webContents, (url) => shell.openExternal(url));
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
  // ("Kimi Code Web"), which would otherwise replace it.
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
  win.on('close', () => {
    saveBounds(win);
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  if (!app.isPackaged) {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  win.webContents.on('did-finish-load', () => {
    if (win.isDestroyed()) return;
    const factor = win.webContents.getZoomFactor();
    const level = win.webContents.getZoomLevel();
    void win.webContents
      .executeJavaScript('window.devicePixelRatio')
      .then((dpr) => {
        if (win.isDestroyed()) return;
        process.stdout.write(
          `[kimi-desktop diag] zoom factor=${factor} level=${level} devicePixelRatio=${dpr} url=${win.webContents.getURL()}\n`,
        );
      })
      .catch(() => {});
  });
  void connect(win);
}
