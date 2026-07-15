import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import {
  app,
  BrowserWindow,
  Menu,
  nativeTheme,
  shell,
  dialog,
  globalShortcut,
  ipcMain,
} from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { resolveKimiHome } from '@moonshot-ai/kimi-code-sdk';
import { serverTokenPath } from '@moonshot-ai/kap-server';

import { startDesktopServer, type DesktopServerHandle } from './server';
import { registerRendererScheme, registerRendererProtocol, rendererUrl } from './protocol';
import { resolveConnectTarget } from './connect-target';
import { DESKTOP_PRODUCT_NAME } from '../shared/identity';

let mainWindow: BrowserWindow | null = null;
let serverHandle: DesktopServerHandle | null = null;

function rendererDistRoot(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'desktop-dist')
    : join(app.getAppPath(), 'desktop-dist');
}

// Token used by the renderer's `credentialStore.getToken()` (Task 4.5). Read in
// the main process from the server's token file; the renderer never touches fs.
function readServerToken(): string | undefined {
  try {
    const token = readFileSync(serverTokenPath(resolveKimiHome()), 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

function serverLogPath(): string {
  return join(resolveKimiHome(), 'server', 'server.log');
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

// --- startup screens (no separate renderer files; inline data URLs) -----------

function dataUrl(html: string): string {
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

const SCREEN_STYLE = `
  <style>
    html, body { height: 100%; margin: 0; }
    body {
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 18px; background: #0b0b0c; color: #e7e7ea; font: 14px/1.5 system-ui, sans-serif;
      -webkit-user-select: none; user-select: none; text-align: center; padding: 0 32px;
    }
    h1 { font-size: 15px; font-weight: 600; margin: 0; }
    p { margin: 0; color: #9a9aa2; max-width: 560px; }
    code { color: #c8c8d0; word-break: break-all; }
  </style>
`;

function errorHtml(message: string): string {
  const safe = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <h1>无法启动本地服务</h1>
    <p>${safe}</p>
    <p>查看日志：<code>${serverLogPath()}</code></p>
    <p>菜单 → Kimi Code → 重试连接，或先检查日志。</p>`;
}

// --- connect flow -------------------------------------------------------------

async function connect(win: BrowserWindow): Promise<void> {
  try {
    serverHandle?.close().catch(() => {});
    serverHandle = null;
    let origin: string;
    let token: string | undefined;
    const target = resolveConnectTarget(process.env['KIMI_SERVER_URL'], readServerToken);
    if (target.external) {
      ({ origin, token } = target);
      process.stdout.write(`[kimi-desktop] connected to external server ${origin}\n`);
    } else {
      serverHandle = await startDesktopServer({
        webAssetsDir: rendererDistRoot(),
        identity: { userAgentProduct: DESKTOP_PRODUCT_NAME, version: app.getVersion() },
      });
      ({ origin, token } = serverHandle);
      process.stdout.write(`[kimi-desktop] connected to ${origin}\n`);
    }
    if (!win.isDestroyed()) {
      await win.loadURL(rendererUrl(origin, token));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[kimi-desktop] startDesktopServer failed: ${message}\n`);
    if (!win.isDestroyed()) {
      await win.loadURL(dataUrl(errorHtml(message)));
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    ...loadBounds(),
    minWidth: 720,
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

// --- renderer event channels (menu / shortcut) -------------------------------
//
// Native menu items and global shortcuts forward to the renderer over the
// preload-whitelisted `kimi:menu-action` / `kimi:shortcut` channels. Task 4.5
// connects the renderer side; here we only open the channels.

function sendToRenderer(channel: string, payload: string): void {
  if (mainWindow !== null && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// Best-effort global shortcut registration (Task 4.4 channel smoke test). A
// registration that collides with an existing OS/app binding returns false and
// is skipped with a warning rather than throwing. Task 4.5 finalizes the set.
const GLOBAL_SHORTCUTS = ['CommandOrControl+Alt+K'];

function registerGlobalShortcuts(): void {
  for (const accel of GLOBAL_SHORTCUTS) {
    const ok = globalShortcut.register(accel, () => sendToRenderer('kimi:shortcut', accel));
    if (!ok) {
      process.stderr.write(`[kimi-desktop] global shortcut ${accel} not registered (already taken)\n`);
    }
  }
}

// --- native menu --------------------------------------------------------------

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const appMenu: MenuItemConstructorOptions = {
    label: 'Kimi Code',
    submenu: [
      ...(isMac ? [{ role: 'about' as const }, { type: 'separator' as const }] : []),
      {
        id: 'retry-connection',
        label: '重试连接',
        click: () => {
          // Forward to the renderer (4.5) in addition to the main-process retry.
          sendToRenderer('kimi:menu-action', 'retry-connection');
          if (mainWindow !== null) {
            void connect(mainWindow);
          } else {
            createWindow();
          }
        },
      },
      {
        label: '打开服务日志',
        click: () => {
          void shell.openPath(serverLogPath());
        },
      },
      { type: 'separator' },
      isMac ? { role: 'quit' } : { role: 'close' },
    ],
  };

  const template: MenuItemConstructorOptions[] = [
    appMenu,
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// --- app lifecycle ------------------------------------------------------------

function main(): void {
  registerRendererScheme();

  ipcMain.on('kimi:theme', (_event, scheme) => {
    if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
      nativeTheme.themeSource = scheme;
    }
  });
  ipcMain.handle('kimi:open-external', (_event, url: string) => shell.openExternal(url));
  // File dialogs: the renderer asks (whitelisted `showOpenDialog`/`showSaveDialog`),
  // the main process opens the native dialog and returns the user's selection.
  ipcMain.handle('kimi:dialog-open', (_event, opts: Record<string, unknown> = {}) => {
    const win = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
    return win === undefined
      ? dialog.showOpenDialog(opts)
      : dialog.showOpenDialog(win, opts);
  });
  ipcMain.handle('kimi:dialog-save', (_event, opts: Record<string, unknown> = {}) => {
    const win = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
    return win === undefined
      ? dialog.showSaveDialog(opts)
      : dialog.showSaveDialog(win, opts);
  });
  // Token for the renderer's credentialStore (Task 4.5); read in main, never fs in renderer.
  ipcMain.handle('kimi:get-server-token', () => readServerToken());

  app.on('before-quit', () => {
    globalShortcut.unregisterAll();
    void serverHandle?.close();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    registerRendererProtocol(rendererDistRoot);
    registerGlobalShortcuts();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

main();
