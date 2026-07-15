import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, shell } from 'electron';

import { connect } from './connect';
import { installExternalLinkGuard } from './external-links';
import type { RendererEventChannel } from './ipc-channels';

let mainWindow: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

// --- renderer event channels (menu / shortcut) -------------------------------
//
// Native menu items and global shortcuts forward to the renderer over the
// preload-whitelisted `kimi:menu-action` / `kimi:shortcut` channels. Task 4.5
// connects the renderer side; here we only open the channels.

export function sendToRenderer(channel: RendererEventChannel, payload: string): void {
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
    // to the vertical center of the web UI's 48px header row (y 18 + 12px
    // button height / 2 = 24 = the header's midline — same line as the
    // sidebar-expand button and the conversation title).
    // 'default' on other platforms (they keep their native title bar).
    titleBarStyle: process.platform === 'darwin' ? 'hidden' : 'default',
    trafficLightPosition: { x: 16, y: 18 },
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
      win.setWindowButtonPosition({ x: 16, y: 18 });
      win.setWindowButtonVisibility(true);
    };
    win.on('enter-full-screen', showTrafficLights);
    win.on('leave-full-screen', showTrafficLights);
    win.on('focus', showTrafficLights);
  }
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
