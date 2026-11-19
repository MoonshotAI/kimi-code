import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { BaseWindow, BrowserWindow, ClipboardItem, Menu, app, clipboard, dialog, ipcMain, screen } from 'electron';
import { IPC } from '../ipc/ipc-channels';
import { showFailureFeedback } from '../app/failure-dialog';
import { log } from '../diagnostics/log';
import { configurePinnedScreenshot } from './screenshot-native';
import { PIN_RESIZE_EDGES, resizePinnedBounds, type PinResizeEdge } from '../../shared/screenshot-pin';

type Locale = 'en' | 'zh';

interface PinnedImage {
  token: string;
  png: Buffer;
  width: number;
  height: number;
  window: BrowserWindow;
  bounds: Electron.Rectangle;
}

const pinsByToken = new Map<string, PinnedImage>();
const pinsByContents = new Map<number, PinnedImage>();

function rendererPageUrl(page: string, params: URLSearchParams): string {
  const dev = process.env['KIMI_RENDERER_DEV_URL'];
  if (!app.isPackaged && dev !== undefined && dev.trim() !== '') {
    return `${new URL(`${page}/index.html`, dev).toString()}?${params.toString()}`;
  }
  return `app://renderer/${page}/index.html?${params.toString()}`;
}

export async function saveScreenshot(png: Buffer, parent?: BaseWindow): Promise<'saved' | 'cancelled'> {
  const defaultPath = join(
    app.getPath('pictures'),
    `Kimi-Screenshot-${new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)}.png`,
  );
  const options: Electron.SaveDialogOptions = {
    defaultPath,
    filters: [{ name: 'PNG', extensions: ['png'] }],
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  };
  const owner = parent ?? BaseWindow.getFocusedWindow();
  const result = owner === null || owner === undefined
    ? await dialog.showSaveDialog(options)
    : await dialog.showSaveDialog(owner, options);
  if (result.canceled || result.filePath === undefined) return 'cancelled';
  await writeFile(result.filePath, png);
  return 'saved';
}

export async function copyScreenshot(png: Uint8Array): Promise<void> {
  if (png.byteLength === 0) throw new Error('invalid-png');
  await clipboard.write([
    new ClipboardItem({
      'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }),
    }),
  ]);
}

function fitPinSize(width: number, height: number): { width: number; height: number } {
  const scale = Math.min(Math.max(1, 120 / width, 80 / height), 720 / width, 560 / height);
  return {
    width: Math.max(120, Math.round(width * scale)),
    height: Math.max(80, Math.round(height * scale)),
  };
}

function pinCoordinate(value: number): number {
  return Math.max(-2_147_483_648, Math.min(2_147_483_647, Math.round(value))) + 0;
}

function currentPinBounds(pin: PinnedImage): Electron.Rectangle {
  const [x, y] = pin.window.getPosition();
  return { ...pin.bounds, x: x!, y: y! };
}

function setPinBounds(pin: PinnedImage, bounds: Electron.Rectangle): void {
  const next = { ...bounds, x: pinCoordinate(bounds.x), y: pinCoordinate(bounds.y) };
  pin.window.setBounds(next);
  pin.bounds = next;
}

function resizePin(pin: PinnedImage, scaleDelta: number): void {
  if (pin.window.isDestroyed()) return;
  const bounds = currentPinBounds(pin);
  const display = screen.getDisplayMatching(bounds).workArea;
  const currentScale = Math.min(bounds.width / pin.width, bounds.height / pin.height);
  const maximumScale = Math.min(display.width / pin.width, display.height / pin.height);
  const minimumScale = Math.max(80 / pin.width, 60 / pin.height);
  const scale = Math.min(
    Math.max(
      currentScale * Math.max(0.5, Math.min(1.5, 1 + scaleDelta)),
      minimumScale <= maximumScale ? minimumScale : Math.min(80 / pin.width, 60 / pin.height),
    ),
    maximumScale,
  );
  setPinBounds(pin, { ...bounds, width: Math.max(80, Math.round(pin.width * scale)), height: Math.max(60, Math.round(pin.height * scale)) });
}

export function pinMenu(pin: PinnedImage, locale: Locale): Menu {
  const zh = locale === 'zh';
  return Menu.buildFromTemplate([
    {
      label: zh ? '复制' : 'Copy',
      click: () => {
        void copyScreenshot(pin.png).catch((error: unknown) => {
          log.warn(`[screenshot] pin clipboard write failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      },
    },
    {
      label: zh ? '另存为…' : 'Save As…',
      click: () => {
        void saveScreenshot(pin.png, pin.window).catch((error: unknown) => {
          log.error('[kimi-desktop] pinned screenshot save failed', error);
          showFailureFeedback(
            'screenshot-save',
            { title: '无法保存截图', detail: '请选择其他保存位置后重试', ok: '确定' },
            { title: "Couldn't save screenshot", detail: 'Choose another location and try again', ok: 'OK' },
          );
        });
      },
    },
    { type: 'separator' },
    {
      label: zh ? '透明度' : 'Opacity',
      submenu: [0.25, 0.5, 0.75, 1].map((opacity) => ({
        label: `${Math.round(opacity * 100)}%`,
        type: 'radio' as const,
        checked: Math.abs(pin.window.getOpacity() - opacity) < 0.01,
        click: () => pin.window.setOpacity(opacity),
      })),
    },
    {
      label: zh ? '5 秒内可点击穿透' : 'Click-through for 5 seconds',
      click: () => {
        pin.window.setIgnoreMouseEvents(true, { forward: true });
        setTimeout(() => {
          if (!pin.window.isDestroyed()) pin.window.setIgnoreMouseEvents(false);
        }, 5_000);
      },
    },
    { type: 'separator' },
    { label: zh ? '关闭' : 'Close', click: () => pin.window.close() },
  ]);
}

async function paintPin(win: BrowserWindow): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const image = await win.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
      if (image.isEmpty()) throw new Error('pin-frame-empty');
      return;
    } catch (error) {
      if (process.platform !== 'win32' || win.isDestroyed() || attempt >= 9 || !(error instanceof Error) || error.message !== 'UnknownVizError') throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
    }
  }
}

async function showPin(win: BrowserWindow, url: string, signal?: AbortSignal): Promise<void> {
  let dispose = (): void => {};
  try {
    await new Promise<void>((resolve, reject) => {
      let pageLoaded: Promise<void>;
      const fail = (): void => reject(new Error('pin-window-unavailable'));
      const timeout = setTimeout(() => reject(new Error('pin-load-timeout')), 10_000);
      const ready = (event: Electron.IpcMainEvent, loaded: unknown): void => {
        if (event.sender !== win.webContents || typeof loaded !== 'boolean') return;
        ipcMain.removeListener(IPC.shotPinReady, ready);
        if (!loaded) {
          reject(new Error('pin-image-load-failed'));
          return;
        }
        void Promise.resolve().then(() => pageLoaded).then(() => paintPin(win)).then(() => {
          if (win.isDestroyed()) return;
          win.showInactive();
          win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating');
          win.moveTop();
          resolve();
        }).catch(reject);
      };
      ipcMain.on(IPC.shotPinReady, ready);
      win.once('closed', fail);
      signal?.addEventListener('abort', fail, { once: true });
      win.webContents.once('render-process-gone', fail);
      dispose = () => {
        clearTimeout(timeout);
        ipcMain.removeListener(IPC.shotPinReady, ready);
        win.removeListener('closed', fail);
        signal?.removeEventListener('abort', fail);
        if (!win.webContents.isDestroyed()) win.webContents.removeListener('render-process-gone', fail);
      };
      pageLoaded = win.loadURL(url);
      void pageLoaded.catch(reject);
    });
  } finally {
    dispose();
  }
}

export async function createPinnedScreenshot(png: Buffer, width: number, height: number, locale: Locale, signal?: AbortSignal): Promise<BrowserWindow> {
  signal?.throwIfAborted();
  const token = randomUUID();
  const size = fitPinSize(width, height);
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  const bounds = {
    width: size.width,
    height: size.height,
    x: pinCoordinate(display.x + (display.width - size.width) / 2),
    y: pinCoordinate(display.y + (display.height - size.height) / 2),
  };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 80,
    minHeight: 60,
    frame: false,
    roundedCorners: false,
    transparent: false,
    backgroundColor: '#ffffff',
    focusable: false,
    acceptFirstMouse: true,
    ...(process.platform === 'darwin' ? { type: 'panel' } : {}),
    hasShadow: true,
    resizable: true,
    movable: true,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      preload: join(__dirname, 'shotPinPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  win.webContents.setZoomFactor(1);
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(1));
  win.webContents.on('zoom-changed', (event) => {
    event.preventDefault();
    win.webContents.setZoomFactor(1);
  });
  win.setAlwaysOnTop(true, process.platform === 'win32' ? 'screen-saver' : 'floating');
  if (process.platform !== 'win32') win.setAspectRatio(width / height);
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  try {
    configurePinnedScreenshot(win);
  } catch (error) {
    win.destroy();
    throw error;
  }
  const pin: PinnedImage = { token, png: Buffer.from(png), width, height, window: win, bounds };
  win.on('resized', () => { pin.bounds = win.getBounds(); });
  if (process.platform === 'linux') {
    win.on('resize', () => { pin.bounds = win.getBounds(); });
  }
  const contentsId = win.webContents.id;
  pinsByToken.set(token, pin);
  pinsByContents.set(contentsId, pin);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('context-menu', () => pinMenu(pin, locale).popup({ window: win }));
  win.on('closed', () => {
    pinsByToken.delete(token);
    pinsByContents.delete(contentsId);
    pin.png = Buffer.alloc(0);
  });
  const params = new URLSearchParams({ src: `shot://pin/${token}.png`, locale });
  try {
    await showPin(win, rendererPageUrl('pin', params), signal);
  } catch (error) {
    if (!win.isDestroyed()) win.destroy();
    throw error;
  }
  return win;
}

export function pinnedScreenshotBuffer(token: string): Buffer | undefined {
  return pinsByToken.get(token)?.png;
}

export function initPinnedScreenshotIpc(): void {
  ipcMain.on(IPC.shotPinResizeEdge, (event, edge: unknown, deltaX: unknown, deltaY: unknown) => {
    if (typeof edge !== 'string' || !PIN_RESIZE_EDGES.includes(edge as PinResizeEdge)) return;
    if (typeof deltaX !== 'number' || !Number.isFinite(deltaX) || typeof deltaY !== 'number' || !Number.isFinite(deltaY)) return;
    const pin = pinsByContents.get(event.sender.id);
    if (pin === undefined || pin.window.isDestroyed()) return;
    const bounds = currentPinBounds(pin);
    const area = screen.getDisplayMatching(bounds).workArea;
    setPinBounds(pin, resizePinnedBounds(bounds, area, edge as PinResizeEdge, deltaX, deltaY));
  });
  ipcMain.on(IPC.shotPinClose, (event) => pinsByContents.get(event.sender.id)?.window.close());
  ipcMain.on(IPC.shotPinResize, (event, value: unknown) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return;
    const pin = pinsByContents.get(event.sender.id);
    if (pin !== undefined) resizePin(pin, Math.max(-0.5, Math.min(0.5, value)));
  });
  ipcMain.on(IPC.shotPinMove, (event, deltaX: unknown, deltaY: unknown) => {
    if (typeof deltaX !== 'number' || !Number.isFinite(deltaX) || typeof deltaY !== 'number' || !Number.isFinite(deltaY)) return;
    const pin = pinsByContents.get(event.sender.id);
    if (pin !== undefined && !pin.window.isDestroyed()) {
      const bounds = currentPinBounds(pin);
      setPinBounds(pin, {
        ...bounds,
        x: bounds.x + Math.max(-10_000, Math.min(10_000, deltaX)),
        y: bounds.y + Math.max(-10_000, Math.min(10_000, deltaY)),
      });
    }
  });
}
