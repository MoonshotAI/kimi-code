import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { app, BrowserWindow, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { ensureServer, kimiHome, serverLogPath } from './ensure-server';
import { resolveSeaPath } from './sea-path';

let mainWindow: BrowserWindow | null = null;

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
    .spinner {
      width: 34px; height: 34px; border-radius: 50%;
      border: 3px solid #2a2a2e; border-top-color: #7c8cff; animation: spin 0.9s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h1 { font-size: 15px; font-weight: 600; margin: 0; }
    p { margin: 0; color: #9a9aa2; max-width: 560px; }
    code { color: #c8c8d0; word-break: break-all; }
  </style>
`;

function loadingHtml(): string {
  return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <div class="spinner"></div>
    <h1>正在启动 Kimi 本地服务…</h1>
    <p>首次启动可能需要几秒。</p>`;
}

function errorHtml(message: string): string {
  const safe = message.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<!doctype html><meta charset="utf-8">${SCREEN_STYLE}
    <h1>无法启动本地服务</h1>
    <p>${safe}</p>
    <p>查看日志：<code>${serverLogPath()}</code></p>
    <p>菜单 → Kimi Code Desktop → 重试连接，或先检查日志。</p>`;
}

// --- server auth token --------------------------------------------------------

/** On-disk filename of the daemon's persistent bearer token (under KIMI_CODE_HOME). */
const SERVER_TOKEN_FILE = 'server.token';

/**
 * Read the daemon's bearer token so the web UI can authenticate without showing
 * the manual token dialog on a fresh launch. Returns undefined when the token
 * cannot be read (the web UI then falls back to the dialog).
 */
function readServerToken(): string | undefined {
  try {
    const token = readFileSync(join(kimiHome(), SERVER_TOKEN_FILE), 'utf-8').trim();
    return token.length > 0 ? token : undefined;
  } catch {
    return undefined;
  }
}

// --- connect flow -------------------------------------------------------------

async function connect(win: BrowserWindow): Promise<void> {
  await win.loadURL(dataUrl(loadingHtml()));
  try {
    const { origin } = await ensureServer(resolveSeaPath());
    process.stdout.write(`[kimi-desktop] connected to ${origin}\n`);
    if (!win.isDestroyed()) {
      // Append a desktop marker so the web UI shows the internal-build banner
      // even when it is served by an already-running shared daemon (the desktop
      // reuses the local daemon rather than starting a private one). Carry the
      // server token in the `#token=` fragment — like `kimi web` does — so the
      // web UI can authenticate without falling into the manual token dialog on
      // a fresh launch.
      const token = readServerToken();
      const fragment = token === undefined ? '' : `#token=${encodeURIComponent(token)}`;
      await win.loadURL(
        `${origin}/?kimi_desktop=1&platform=${process.platform}${fragment}`,
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`[kimi-desktop] ensureServer failed: ${message}\n`);
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
    title: 'Kimi Code Desktop',
    // macOS: hide the native title bar and float the traffic lights over the
    // content; the web UI reserves a draggable strip at the top to clear them.
    // 'default' on other platforms (they keep their native title bar).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow = win;
  // Keep the window title as the product name. The web page sets document.title
  // ("Kimi Code Web"), which would otherwise replace it.
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  win.on('close', () => {
    saveBounds(win);
  });
  win.on('closed', () => {
    if (mainWindow === win) {
      mainWindow = null;
    }
  });
  void connect(win);
}

// --- native menu --------------------------------------------------------------

function buildMenu(): void {
  const isMac = process.platform === 'darwin';
  const appMenu: MenuItemConstructorOptions = {
    label: 'Kimi Code Desktop',
    submenu: [
      ...(isMac ? [{ role: 'about' as const }, { type: 'separator' as const }] : []),
      {
        label: '重试连接',
        click: () => {
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
  // The shared daemon is deliberately left running on quit — it self-exits ~60s
  // after the last client disconnects, so we never tear down a server another
  // client (CLI / browser / TUI) may still be using.
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
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
