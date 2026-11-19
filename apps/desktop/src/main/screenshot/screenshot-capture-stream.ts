import { app, BrowserWindow, desktopCapturer, session } from 'electron';
import { log } from '../diagnostics/log';
import { findSingleDisplaySourceFallback } from './screenshot-source';

export interface StreamFrame {
  width: number;
  height: number;
  data: Uint8Array;
}

interface StartResult {
  ok: boolean;
  width: number;
  height: number;
  error?: string;
}

const GRAB_TIMEOUT_MS = 1_000;
const STREAM_START_TIMEOUT_MS = 5_000;

let hostWindow: BrowserWindow | null = null;
let hostReady: Promise<boolean> | null = null;
let handlerInstalled = false;
let pendingSource: Electron.DesktopCapturerSource | null = null;

function captureHostUrl(): string {
  const dev = process.env['KIMI_RENDERER_DEV_URL'];
  if (!app.isPackaged && dev !== undefined && dev.trim() !== '') {
    return new URL('capture-host/index.html', dev).toString();
  }
  return 'app://renderer/capture-host/index.html';
}

function installDisplayMediaHandler(): void {
  if (handlerInstalled) return;
  handlerInstalled = true;
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    const win = hostWindow;
    if (win !== null && !win.isDestroyed() && request.frame === win.webContents.mainFrame && pendingSource !== null) {
      callback({ video: pendingSource });
      return;
    }
    callback({});
  });
}

function destroyHost(): void {
  if (hostWindow !== null && !hostWindow.isDestroyed()) hostWindow.destroy();
  hostWindow = null;
  hostReady = null;
}

async function createHost(): Promise<boolean> {
  destroyHost();
  installDisplayMediaHandler();
  const win = new BrowserWindow({
    width: 64,
    height: 64,
    show: false,
    frame: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  hostWindow = win;
  win.on('closed', () => {
    if (hostWindow === win) {
      hostWindow = null;
      hostReady = null;
    }
  });
  win.webContents.on('render-process-gone', () => {
    if (hostWindow === win) destroyHost();
  });
  try {
    await win.loadURL(captureHostUrl());
    return true;
  } catch (error) {
    log.warn(`[screenshot] capture host load failed: ${error instanceof Error ? error.message : String(error)}`);
    if (hostWindow === win) destroyHost();
    else if (!win.isDestroyed()) win.destroy();
    return false;
  }
}

async function ensureHost(): Promise<boolean> {
  if (hostWindow !== null && !hostWindow.isDestroyed()) {
    const contents = hostWindow.webContents;
    if (!contents.isDestroyed() && !contents.isCrashed()) return true;
    destroyHost();
  }
  if (hostReady === null) hostReady = createHost();
  const ready = await hostReady;
  if (!ready) hostReady = null;
  return ready;
}

async function enumerateSources(): Promise<Electron.DesktopCapturerSource[]> {
  return desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
}

export async function warmCaptureStreams(displayIds: readonly string[]): Promise<void> {
  if (process.platform !== 'win32') return;
  try {
    if (!(await ensureHost())) return;
    const win = hostWindow;
    if (win === null) return;
    const sources = await enumerateSources();
    const fallback = findSingleDisplaySourceFallback(sources, displayIds.length);
    for (const displayId of displayIds) {
      if (hostWindow !== win) return;
      const has = await win.webContents.executeJavaScript(`window.__shotCapture?.has(${JSON.stringify(displayId)}) ?? false`) as boolean;
      if (has) continue;
      const source = sources.find((item) => item.display_id === displayId) ?? fallback;
      if (source === undefined) continue;
      pendingSource = source;
      try {
        const result = await Promise.race<StartResult>([
          win.webContents.executeJavaScript(`window.__shotCapture.startStream(${JSON.stringify(displayId)})`),
          new Promise<never>((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('stream-start-timeout')), STREAM_START_TIMEOUT_MS);
            timer.unref();
          }),
        ]);
        if (result.ok) log.info(`[screenshot] capture stream ready display=${displayId} size=${result.width}x${result.height}`);
        else log.warn(`[screenshot] capture stream failed display=${displayId} reason=${result.error ?? 'unknown'}`);
      } catch (error) {
        log.warn(`[screenshot] capture stream failed display=${displayId} reason=${error instanceof Error ? error.message : String(error)}`);
      } finally {
        pendingSource = null;
      }
    }
  } catch (error) {
    log.warn(`[screenshot] capture stream warmup failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function discardFailedGrabHost(win: BrowserWindow): null {
  if (hostWindow === win) destroyHost();
  return null;
}

export async function grabStreamFrames(displayIds: readonly string[]): Promise<Map<string, StreamFrame> | null> {
  const win = hostWindow;
  if (win === null || win.isDestroyed() || win.webContents.isDestroyed() || win.webContents.isCrashed()) return null;
  const frames = new Map<string, StreamFrame>();
  for (const displayId of displayIds) {
    try {
      const frame = await Promise.race<StreamFrame>([
        win.webContents.executeJavaScript(`window.__shotCapture.grab(${JSON.stringify(displayId)})`),
        new Promise<never>((_resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('grab-timeout')), GRAB_TIMEOUT_MS);
          timer.unref();
        }),
      ]);
      if (frame === null || typeof frame !== 'object' || !(frame.data instanceof Uint8Array) || frame.data.byteLength === 0) return discardFailedGrabHost(win);
      frames.set(displayId, frame);
    } catch {
      return discardFailedGrabHost(win);
    }
  }
  return frames;
}

export function shutdownCaptureStreams(): void {
  destroyHost();
}

export function resetCaptureStreamsForDisplayChange(): void {
  destroyHost();
}
