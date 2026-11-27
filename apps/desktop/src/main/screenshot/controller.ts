import { randomUUID } from 'node:crypto';
import { release } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { app, BrowserWindow, clipboard, desktopCapturer, globalShortcut, ipcMain, nativeImage, protocol, screen, shell, systemPreferences } from 'electron';
import type { ScreenshotGuidance } from '../../shared/screenshot-guidance';
import { IPC } from '../ipc/ipc-channels';
import { gradientFramePng } from './screenshot-fake-frame';
import { screenshotBitmapFrame, screenshotRgbaFrame } from './screenshot-frame';
import { grabStreamFrames, resetCaptureStreamsForDisplayChange, shutdownCaptureStreams } from './screenshot-capture-stream';
import { copyScreenshot, createPinnedScreenshot, initPinnedScreenshotIpc, pinnedScreenshotBuffer, saveScreenshot } from './screenshot-output';
import { fakeCandidatesByDisplay, listScreenshotWindows, type ScreenshotWindowCandidate } from './screenshot-windows';
import { focusedWindowWebContents, getMainWindow } from '../window/window-registry';
import { showMainWindow } from '../window/main-window';
import { log } from '../diagnostics/log';
import { captureNativeScreenshotFrames, configureScreenshotOverlay } from './screenshot-native';
import { findSingleDisplaySourceFallback } from './screenshot-source';

export type ScreenshotCaptureResult =
  | { status: 'ok'; pngBytes: Uint8Array; comment: string; captureId: string }
  | { status: 'completed'; action: 'copy' | 'save' | 'pin' }
  | { status: 'cancelled' }
  | { status: 'denied' }
  | { status: 'error'; reason: string; captureId?: string };

export interface DisplayLike {
  id: number;
  bounds: { x: number; y: number; width: number; height: number };
  scaleFactor: number;
}

export interface FrameSourceLike {
  display_id: string;
  thumbnailSize: { width: number; height: number };
  thumbnailEmpty: boolean;
}

export interface RegionRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function matchFramesToDisplays<T extends FrameSourceLike, D extends DisplayLike>(
  sources: readonly T[],
  displays: readonly D[],
): { matched: Array<{ display: D; source: T }>; skipped: D[] } {
  const byDisplayId = new Map(sources.map((source) => [source.display_id, source]));
  const fallback = findSingleDisplaySourceFallback(sources, displays.length);
  if (fallback !== undefined && !fallback.thumbnailEmpty) byDisplayId.set(String(displays[0]!.id), fallback);
  const matched: Array<{ display: D; source: T }> = [];
  const skipped: D[] = [];
  for (const display of displays) {
    const source = byDisplayId.get(String(display.id));
    if (source === undefined || source.thumbnailEmpty) skipped.push(display);
    else matched.push({ display, source });
  }
  return { matched, skipped };
}

export function cropRegionPixels(
  rect: RegionRect,
  source: Pick<FrameSourceLike, 'thumbnailSize'>,
  display: DisplayLike,
): RegionRect {
  const ratioX = source.thumbnailSize.width / display.bounds.width;
  const ratioY = source.thumbnailSize.height / display.bounds.height;
  const x = Math.max(0, Math.min(Math.round(rect.x * ratioX), source.thumbnailSize.width - 1));
  const y = Math.max(0, Math.min(Math.round(rect.y * ratioY), source.thumbnailSize.height - 1));
  return {
    x,
    y,
    width: Math.max(1, Math.min(Math.round(rect.width * ratioX), source.thumbnailSize.width - x)),
    height: Math.max(1, Math.min(Math.round(rect.height * ratioY), source.thumbnailSize.height - y)),
  };
}

type Locale = 'en' | 'zh';

interface OverlayContext {
  captureId: string;
  displayId: string;
  locale: Locale;
  frameUrl: string;
  sourceSize: { width: number; height: number };
  displaySize: { width: number; height: number };
  windows: ScreenshotWindowCandidate[];
  pointer: { x: number; y: number } | null;
}

interface CaptureSession {
  token: string;
  windows: BrowserWindow[];
  frames: Map<string, { data: Buffer; format: 'png' | 'bmp' }>;
  displays: Map<string, DisplayLike>;
  contexts: Map<number, OverlayContext>;
  readyContents: Set<number>;
  selectionContentsId: number | null;
  startedAt: number;
  phase: string;
  shown: boolean;
  presenting: boolean;
  presented: boolean;
  resolve: (result: ScreenshotCaptureResult) => void;
  settled: boolean;
  promise: Promise<ScreenshotCaptureResult>;
  captureTimer: ReturnType<typeof setTimeout> | null;
  readyTimer: ReturnType<typeof setTimeout> | null;
  releaseEscape: (() => void) | null;
  guidance: ScreenshotGuidance | null;
  resolveGuidance: ((retry: boolean) => void) | null;
  cleanupGuidance: (() => void) | null;
}

interface OutputPayload {
  captureId: string;
  action: 'add' | 'copy' | 'save' | 'pin';
  displayId: string;
  pngBytes: Buffer;
  width: number;
  height: number;
  comment: string;
}

let currentLocale: Locale = 'en';
let activeSession: CaptureSession | null = null;
let hotkeyFocusReturnArmed = false;
let mainWindowVisibleAtTrigger = true;
const overlayWindows = new Map<string, { window: BrowserWindow; nativeId: string | undefined; nativeReady: boolean; loaded: boolean; painted: boolean }>();
let warmupTimer: ReturnType<typeof setTimeout> | null = null;
let shuttingDown = false;

const SCREEN_CAPTURE_SETTINGS_URL = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture';

export function setScreenshotLocale(locale: Locale): void {
  currentLocale = locale;
}

function createSession(): CaptureSession {
  let resolvePromise!: (result: ScreenshotCaptureResult) => void;
  const promise = new Promise<ScreenshotCaptureResult>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    token: randomUUID(),
    windows: [],
    frames: new Map(),
    displays: new Map(),
    contexts: new Map(),
    readyContents: new Set(),
    selectionContentsId: null,
    startedAt: performance.now(),
    phase: 'starting',
    shown: false,
    presenting: false,
    presented: false,
    resolve: resolvePromise,
    settled: false,
    promise,
    captureTimer: null,
    readyTimer: null,
    releaseEscape: null,
    guidance: null,
    resolveGuidance: null,
    cleanupGuidance: null,
  };
}

function isCurrent(session: CaptureSession): boolean {
  return activeSession === session && !session.settled;
}

function capturePhase(session: CaptureSession, phase: string): void {
  session.phase = phase;
  log.info(`[screenshot] phase=${phase} elapsed_ms=${Math.round(performance.now() - session.startedAt)} screens=${session.windows.length}`);
}

function releaseStartupEscape(session: CaptureSession): void {
  session.releaseEscape?.();
  session.releaseEscape = null;
}

function settle(session: CaptureSession, result: ScreenshotCaptureResult): void {
  if (session.settled) return;
  session.settled = true;
  closeGuidance(session, false);
  releaseStartupEscape(session);
  if (session.captureTimer !== null) clearTimeout(session.captureTimer);
  if (session.readyTimer !== null) clearTimeout(session.readyTimer);
  if (result.status === 'error') log.warn(`[screenshot] failed phase=${session.phase} reason=${result.reason} elapsed_ms=${Math.round(performance.now() - session.startedAt)}`);
  else capturePhase(session, result.status);
  for (const win of session.windows) {
    if (!win.isDestroyed()) {
      if (result.status === 'error' || process.platform !== 'darwin') win.destroy();
      else {
        win.hide();
      }
    }
  }
  for (const win of session.windows) {
    if (!win.isDestroyed()) win.webContents.send(IPC.shotSetContext, null);
  }
  session.windows = [];
  session.frames.clear();
  session.contexts.clear();
  session.readyContents.clear();
  if (activeSession === session) activeSession = null;
  session.resolve(result);
  if (process.platform === 'win32' && !shuttingDown) scheduleWarmup();
}

function completeAfterReply(session: CaptureSession, result: ScreenshotCaptureResult): void {
  setTimeout(() => {
    if (isCurrent(session)) settle(session, result);
  }, 40);
}

function abortOnDisplayChange(): void {
  if (activeSession !== null) {
    log.info('[screenshot] cancelled reason=display-changed');
    settle(activeSession, { status: 'cancelled' });
  }
  for (const { window } of overlayWindows.values()) if (!window.isDestroyed()) window.destroy();
  resetCaptureStreamsForDisplayChange();
  scheduleWarmup();
}

function onDisplayMetricsChanged(_event: Electron.Event, _display: Electron.Display, metrics: string[]): void {
  if (metrics.some((metric) => metric === 'bounds' || metric === 'scaleFactor' || metric === 'rotation')) abortOnDisplayChange();
}

function scheduleWarmup(): void {
  if (warmupTimer !== null) clearTimeout(warmupTimer);
  warmupTimer = setTimeout(() => {
    warmupTimer = null;
    if (shuttingDown || activeSession !== null) return;
    if (process.platform === 'linux') return;
    try {
      for (const display of screen.getAllDisplays()) getOverlayWindow(display);
    } catch {
      log.warn('[screenshot] warmup failed reason=overlay-create-failed');
    }
  }, 1_500);
  warmupTimer.unref();
}

function publishGuidance(session: CaptureSession): void {
  const window = getMainWindow();
  if (window !== null && !window.isDestroyed()) window.webContents.send(IPC.screenshotGuideChanged, session.guidance);
}

function closeGuidance(session: CaptureSession, retry: boolean): void {
  session.cleanupGuidance?.();
  session.cleanupGuidance = null;
  if (session.guidance !== null) {
    session.guidance = null;
    publishGuidance(session);
  }
  session.resolveGuidance?.(retry);
  session.resolveGuidance = null;
}

function captureErrorReason(error: unknown): string {
  if (!(error instanceof Error)) return 'capture-failed:unknown';
  const code = 'code' in error && typeof error.code === 'string' ? error.code : error.name;
  return `${code}:${error.message}`.replace(/[\r\n]/g, ' ').slice(0, 500);
}

function isPermissionError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'screen-capture-permission-denied';
}

async function checkGuidance(session: CaptureSession): Promise<void> {
  const guide = session.guidance;
  if (guide === null || guide.phase === 'checking' || guide.kind === 'restricted') return;
  guide.phase = 'checking';
  guide.notice = 'none';
  guide.canRequest = false;
  publishGuidance(session);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const probe = async () => {
      if (process.platform === 'darwin' && Number.parseInt(release(), 10) >= 23) {
        const frames = await captureNativeScreenshotFrames('all-shadows');
        return frames.some((frame) => frame.png.length > 0 && frame.width > 0 && frame.height > 0);
      }
      const frames = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 16, height: 16 } });
      return frames.some((frame) => !frame.thumbnail.isEmpty());
    };
    const available = await Promise.race([
      probe(),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('screen-access-check-timeout')), 15_000);
      }),
    ]);
    if (!available) throw new Error('no-screen-frames');
    if (!isCurrent(session) || session.guidance !== guide) return;
    guide.phase = 'ready';
    guide.reason = '';
  } catch (error) {
    if (!isCurrent(session) || session.guidance !== guide) return;
    guide.phase = 'idle';
    guide.notice = 'not-ready';
    guide.reason = captureErrorReason(error);
    if (isPermissionError(error)) guide.kind = 'permission';
    log.warn(`[screenshot] access check failed reason=${guide.reason}`);
  } finally {
    clearTimeout(timer);
  }
  if (isCurrent(session) && session.guidance === guide) publishGuidance(session);
}

function showGuidance(session: CaptureSession, kind: ScreenshotGuidance['kind'], reason: string): Promise<boolean> {
  releaseStartupEscape(session);
  if (session.captureTimer !== null) clearTimeout(session.captureTimer);
  session.captureTimer = null;
  session.guidance = {
    captureId: session.token, locale: currentLocale, platform: process.platform,
    appName: process.platform === 'darwin' && app.isPackaged ? basename(app.getPath('exe')) : app.getName(),
    kind, phase: 'idle', canRequest: process.platform === 'darwin' && systemPreferences.getMediaAccessStatus('screen') === 'not-determined',
    canRevealApp: process.platform === 'darwin' && app.isPackaged,
    settingsOpened: false, notice: 'none', reason,
  };
  const result = new Promise<boolean>((resolve) => { session.resolveGuidance = resolve; });
  showMainWindow();
  const parent = getMainWindow();
  const onFocus = () => {
    if (isCurrent(session) && session.guidance?.settingsOpened && session.guidance.phase === 'idle') void checkGuidance(session);
  };
  const onClosed = () => {
    if (isCurrent(session)) settle(session, { status: 'cancelled' });
  };
  parent?.on('focus', onFocus);
  parent?.once('closed', onClosed);
  session.cleanupGuidance = () => {
    parent?.removeListener('focus', onFocus);
    parent?.removeListener('closed', onClosed);
  };
  publishGuidance(session);
  return result;
}

async function tccPreflight(session: CaptureSession): Promise<boolean> {
  if (process.platform !== 'darwin') return true;
  const access = systemPreferences.getMediaAccessStatus('screen');
  if (access === 'granted') return true;
  return showGuidance(session, access === 'restricted' ? 'restricted' : 'permission', `screen-access:${access}`);
}

async function recoverCapture(session: CaptureSession, reason: string, permissionDenied = false): Promise<void> {
  log.warn(`[screenshot] capture recovery reason=${reason}`);
  const access = process.platform === 'darwin' ? systemPreferences.getMediaAccessStatus('screen') : 'granted';
  const kind = access === 'restricted' ? 'restricted' : permissionDenied || access !== 'granted' ? 'permission' : 'capture';
  if (await showGuidance(session, kind, reason)) {
    if (isCurrent(session)) await runCapture(session, false, true);
  } else if (isCurrent(session)) settle(session, { status: 'cancelled' });
}

function rendererPageUrl(page: string, params: URLSearchParams): string {
  const dev = process.env['KIMI_RENDERER_DEV_URL'];
  if (!app.isPackaged && dev !== undefined && dev.trim() !== '') {
    return `${new URL(`${page}/index.html`, dev).toString()}?${params.toString()}`;
  }
  return `app://renderer/${page}/index.html?${params.toString()}`;
}

function showOverlays(session: CaptureSession): void {
  if (!isCurrent(session) || session.shown || session.windows.length === 0 || session.readyContents.size !== session.windows.length) return;
  if (process.platform !== 'win32' && session.windows.some((win) => !overlayWindows.get(session.contexts.get(win.webContents.id)!.displayId)?.painted)) return;
  if (session.windows.some((win) => !overlayWindows.get(session.contexts.get(win.webContents.id)!.displayId)?.nativeReady)) return;
  if ((process.platform === 'darwin' || process.platform === 'win32') && !session.presented) {
    if (session.presenting) return;
    session.presenting = true;
    void Promise.all(session.windows.map(async (win) => {
      while (isCurrent(session) && !win.isDestroyed()) {
        const frame = await win.webContents.capturePage(undefined, { stayHidden: false, stayAwake: true });
        if (frame.isEmpty()) throw new Error('empty-overlay-frame');
        if (process.platform !== 'darwin' || frame.resize({ width: 1, height: 1 }).toBitmap()[3] === 255) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 16));
      }
    }))
      .then(() => {
        if (!isCurrent(session)) return;
        session.presented = true;
        showOverlays(session);
      }).catch(() => {
        if (isCurrent(session)) settle(session, { status: 'error', reason: 'overlay-paint-failed' });
      });
    return;
  }
  session.shown = true;
  if (session.readyTimer !== null) {
    clearTimeout(session.readyTimer);
    session.readyTimer = null;
  }
  const cursorDisplayId = String(screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).id);
  const first = session.windows.find((win) => session.contexts.get(win.webContents.id)?.displayId === cursorDisplayId) ?? session.windows[0];
  for (const win of session.windows) {
    if (win !== first && !win.isDestroyed()) win.showInactive();
  }
  if (first !== undefined && !first.isDestroyed()) {
    first.show();
    first.focus();
  }
  if (process.platform === 'win32') {
    for (const win of session.windows) {
      if (!win.isDestroyed()) win.moveTop();
    }
  }
  releaseStartupEscape(session);
  capturePhase(session, 'visible');
}

function getOverlayWindow(display: Electron.Display): BrowserWindow {
  const displayId = String(display.id);
  const cached = overlayWindows.get(displayId);
  if (cached !== undefined && !cached.window.isDestroyed()) return cached.window;
  const win = new BrowserWindow({
    x: display.bounds.x,
    y: display.bounds.y,
    width: display.bounds.width,
    height: display.bounds.height,
    frame: false,
    ...(process.platform === 'win32' ? { thickFrame: false } : {}),
    ...(process.platform === 'darwin' ? { type: 'panel', transparent: true } : {}),
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    enableLargerThanScreen: true,
    hasShadow: false,
    skipTaskbar: true,
    show: false,
    backgroundColor: process.platform === 'darwin' ? '#00000000' : '#000000',
    webPreferences: {
      preload: join(__dirname, 'shotPreload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  const createdAt = performance.now();
  let nativeId: ReturnType<typeof configureScreenshotOverlay>;
  try {
    if (process.platform === 'win32') {
      win.setBounds(display.bounds, false);
      const actual = win.getContentBounds();
      if (actual.x !== display.bounds.x || actual.y !== display.bounds.y || actual.width !== display.bounds.width || actual.height !== display.bounds.height) {
        throw new Error('overlay-bounds-mismatch');
      }
    }
    nativeId = configureScreenshotOverlay(win);
  } catch (error) {
    win.destroy();
    throw error;
  }
  const entry = { window: win, nativeId: typeof nativeId === 'string' ? nativeId : undefined, nativeReady: !(nativeId instanceof Promise), loaded: false, painted: false };
  overlayWindows.set(displayId, entry);
  if (nativeId instanceof Promise) {
    void nativeId.then((id) => {
      if (win.isDestroyed() || overlayWindows.get(displayId) !== entry) return;
      entry.nativeId = id;
      entry.nativeReady = true;
      if (activeSession !== null) showOverlays(activeSession);
    }).catch((error: unknown) => {
      log.warn(`[screenshot] native setup failed: ${error instanceof Error ? error.message : String(error)}`);
      failOverlay(win, 'overlay-native-setup-failed');
    });
  }
  win.webContents.setIgnoreMenuShortcuts(true);
  win.webContents.setZoomFactor(1);
  win.webContents.on('did-finish-load', () => win.webContents.setZoomFactor(1));
  win.webContents.on('zoom-changed', (event) => {
    event.preventDefault();
    win.webContents.setZoomFactor(1);
  });
  win.setAlwaysOnTop(true, 'screen-saver');
  if (process.platform === 'darwin') win.setWindowButtonVisibility(false);
  win.once('ready-to-show', () => {
    log.info(`[screenshot] overlay-painted display=${displayId} elapsed_ms=${Math.round(performance.now() - createdAt)} bounds=${JSON.stringify(win.getBounds())}`);
    entry.painted = true;
    if (activeSession !== null) showOverlays(activeSession);
  });
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event) => event.preventDefault());
  win.webContents.on('did-fail-load', () => {
    failOverlay(win, 'overlay-load-failed');
  });
  win.webContents.on('render-process-gone', () => {
    failOverlay(win, 'overlay-renderer-gone');
  });
  win.on('closed', () => {
    if (overlayWindows.get(displayId) === entry) overlayWindows.delete(displayId);
    if (activeSession?.windows.includes(win)) settle(activeSession, { status: 'cancelled' });
  });
  const params = new URLSearchParams({ display: displayId });
  void win.loadURL(rendererPageUrl('screenshot', params)).catch(() => failOverlay(win, 'overlay-load-failed'));
  return win;
}

function failOverlay(win: BrowserWindow, reason: string): void {
  if (win.isDestroyed()) return;
  if (activeSession?.windows.includes(win)) settle(activeSession, { status: 'error', reason });
  else log.warn(`[screenshot] warmup failed reason=${reason}`);
  if (!win.isDestroyed()) win.destroy();
}

async function runCapture(session: CaptureSession, fakeFrame: boolean, accessChecked = false): Promise<void> {
  if (!fakeFrame && !accessChecked) {
    const preflight = await tccPreflight(session);
    if (!isCurrent(session)) return;
    if (!preflight) {
      settle(session, { status: 'cancelled' });
      return;
    }
  }
  const cancelStartup = () => {
    if (isCurrent(session) && !session.shown) settle(session, { status: 'cancelled' });
  };
  const contents = focusedWindowWebContents();
  const onInput = (event: Electron.Event, input: Electron.Input) => {
    if (input.type !== 'keyDown' || input.key !== 'Escape' || input.isComposing) return;
    event.preventDefault();
    cancelStartup();
  };
  contents?.on('before-input-event', onInput);
  const escapeRegistered = !globalShortcut.isRegistered('Escape') && globalShortcut.register('Escape', cancelStartup);
  session.releaseEscape = () => {
    if (escapeRegistered) globalShortcut.unregister('Escape');
    contents?.removeListener('before-input-event', onInput);
  };
  if (!escapeRegistered) log.warn('[screenshot] startup Escape shortcut is unavailable');
  session.captureTimer = setTimeout(() => {
    if (isCurrent(session)) settle(session, { status: 'error', reason: 'capture-timeout' });
  }, 60_000);
  const displays = screen.getAllDisplays();
  if (displays.length === 0) {
    settle(session, { status: 'error', reason: 'no-displays' });
    return;
  }
  session.windows = displays.map((display) => getOverlayWindow(display));
  const excludedWindowIds = [...overlayWindows.values()].flatMap(({ nativeId }) => nativeId === undefined ? [] : [nativeId]);
  const candidatePromise = fakeFrame ? Promise.resolve(fakeCandidatesByDisplay(displays)) : listScreenshotWindows(displays, excludedWindowIds);
  capturePhase(session, 'capturing');
  let sources: Array<FrameSourceLike & { data: Buffer; format: 'png' | 'bmp' }> = [];
  try {
    if (!fakeFrame) {
      if (process.platform === 'darwin' && Number.parseInt(release(), 10) >= 23) {
        sources = (await captureNativeScreenshotFrames('all-shadows')).map(({ displayId, png, width, height }) => ({
          display_id: displayId, data: png, format: 'png', thumbnailSize: { width, height }, thumbnailEmpty: png.length === 0,
        }));
      } else {
        const displayIds = displays.map((display) => String(display.id));
        const streamed = await grabStreamFrames(displayIds);
        if (!isCurrent(session)) return;
        if (streamed !== null) {
          capturePhase(session, 'sources-ready');
          sources = [...streamed.entries()].map(([displayId, frame]) => ({
            display_id: displayId,
            data: screenshotRgbaFrame(Buffer.from(frame.data.buffer, frame.data.byteOffset, frame.data.byteLength), frame.width, frame.height),
            format: 'bmp' as const,
            thumbnailSize: { width: frame.width, height: frame.height },
            thumbnailEmpty: false,
          }));
        } else {
          const maxEdge = Math.max(...displays.map((display) => Math.max(display.bounds.width, display.bounds.height) * display.scaleFactor));
          const captured = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: maxEdge, height: maxEdge } });
          if (!isCurrent(session)) return;
          capturePhase(session, 'sources-ready');
          sources = captured.map(({ display_id, thumbnail }) => {
            const size = thumbnail.getSize();
            const empty = thumbnail.isEmpty();
            const format = process.platform === 'win32' && !empty ? 'bmp' : 'png';
            const data = format === 'bmp' ? screenshotBitmapFrame(thumbnail.toBitmap(), size.width, size.height) : thumbnail.toPNG();
            return { display_id, data, format, thumbnailSize: size, thumbnailEmpty: empty };
          });
        }
      }
    }
  } catch (error) {
    if (!isCurrent(session)) return;
    await recoverCapture(session, captureErrorReason(error), isPermissionError(error));
    return;
  }
  if (!isCurrent(session)) return;
  capturePhase(session, 'captured');
  if (session.captureTimer !== null) {
    clearTimeout(session.captureTimer);
    session.captureTimer = null;
  }
  const result: { matched: Array<{ display: Electron.Display; source: FrameSourceLike }>; skipped: Electron.Display[] } = fakeFrame
    ? {
        matched: displays.map((display) => ({
          display,
          source: {
            display_id: String(display.id),
            thumbnailSize: {
              width: Math.round(display.bounds.width * display.scaleFactor),
              height: Math.round(display.bounds.height * display.scaleFactor),
            },
            thumbnailEmpty: false,
          },
        })),
        skipped: [],
      }
    : matchFramesToDisplays(sources, displays);
  if (result.matched.length === 0) {
    await recoverCapture(session, 'no-screen-frames');
    return;
  }
  if (result.skipped.length > 0) {
    settle(session, { status: 'error', reason: 'missing-display-frames' });
    return;
  }
  const tints: Array<readonly [readonly [number, number, number], readonly [number, number, number]]> = [
    [[30, 41, 59], [88, 101, 129]],
    [[44, 30, 59], [96, 70, 120]],
    [[30, 59, 52], [70, 110, 96]],
    [[59, 48, 30], [120, 100, 70]],
  ];
  session.readyTimer = setTimeout(() => {
    if (isCurrent(session)) settle(session, { status: 'error', reason: 'overlay-ready-timeout' });
  }, 10_000);
  const cursor = screen.getCursorScreenPoint();
  const cursorDisplayId = String(screen.getDisplayNearestPoint(cursor).id);
  for (const { display, source } of result.matched) {
    const displayId = String(display.id);
    let frame: { data: Buffer; format: 'png' | 'bmp' };
    if (fakeFrame) {
      const tint = tints[session.frames.size % tints.length]!;
      frame = { data: gradientFramePng(source.thumbnailSize.width, source.thumbnailSize.height, tint[0], tint[1]), format: 'png' };
    } else {
      const raw = sources.find((item) => item.display_id === source.display_id);
      if (raw === undefined) continue;
      frame = { data: raw.data, format: raw.format };
    }
    session.frames.set(displayId, frame);
    session.displays.set(displayId, display);
    const win = getOverlayWindow(display);
    session.contexts.set(win.webContents.id, {
      captureId: session.token,
      displayId,
      locale: currentLocale,
      frameUrl: `shot://frame/${session.token}/${displayId}.${frame.format}`,
      sourceSize: source.thumbnailSize,
      displaySize: { width: display.bounds.width, height: display.bounds.height },
      windows: [],
      pointer: displayId === cursorDisplayId ? { x: cursor.x - display.bounds.x, y: cursor.y - display.bounds.y } : null,
    });
  }
  if (session.windows.length === 0) {
    settle(session, { status: 'error', reason: 'no-overlay-windows' });
    return;
  }
  capturePhase(session, 'frames-encoded');
  for (const [id, context] of session.contexts) {
    const entry = overlayWindows.get(context.displayId)!;
    if (entry.loaded) entry.window.webContents.send(IPC.shotSetContext, session.contexts.get(id));
  }
  void candidatePromise.then((candidates) => {
    if (!isCurrent(session)) return;
    for (const context of session.contexts.values()) {
      context.windows = candidates.get(context.displayId) ?? [];
      const entry = overlayWindows.get(context.displayId);
      if (entry?.loaded) entry.window.webContents.send(IPC.shotWindowCandidates, session.token, context.windows);
    }
  });
}

function outputPayload(value: unknown): OutputPayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const payload = value as Record<string, unknown>;
  if (typeof payload['captureId'] !== 'string') return null;
  if (payload['action'] !== 'add' && payload['action'] !== 'copy' && payload['action'] !== 'save' && payload['action'] !== 'pin') return null;
  if (typeof payload['displayId'] !== 'string' || payload['displayId'] === '') return null;
  if (typeof payload['comment'] !== 'string' || payload['comment'].length > 20_000) return null;
  if (typeof payload['width'] !== 'number' || !Number.isInteger(payload['width']) || payload['width'] < 1 || payload['width'] > 50_000) return null;
  if (typeof payload['height'] !== 'number' || !Number.isInteger(payload['height']) || payload['height'] < 1 || payload['height'] > 50_000) return null;
  const bytes = payload['pngBytes'];
  if (!ArrayBuffer.isView(bytes) || bytes.byteLength < 8 || bytes.byteLength > 256 * 1024 * 1024) return null;
  const pngBytes = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (pngBytes[0] !== 0x89 || pngBytes[1] !== 0x50 || pngBytes[2] !== 0x4e || pngBytes[3] !== 0x47) return null;
  return {
    captureId: payload['captureId'],
    action: payload['action'],
    displayId: payload['displayId'],
    pngBytes: Buffer.from(pngBytes),
    width: payload['width'],
    height: payload['height'],
    comment: payload['comment'],
  };
}

function senderSession(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent, captureId: unknown): CaptureSession | null {
  const session = activeSession;
  if (session === null || session.settled || captureId !== session.token) return null;
  return session.contexts.has(event.sender.id) ? session : null;
}

async function onShotAction(event: Electron.IpcMainInvokeEvent, value: unknown): Promise<{ status: 'ok' | 'cancelled' | 'error'; reason?: string }> {
  const payload = outputPayload(value);
  const session = senderSession(event, payload?.captureId);
  if (session === null || payload === null || session.contexts.get(event.sender.id)?.displayId !== payload.displayId) return { status: 'error', reason: 'invalid-output' };
  const sender = BrowserWindow.fromWebContents(event.sender) ?? undefined;
  try {
    const image = nativeImage.createFromBuffer(payload.pngBytes);
    const size = image.getSize();
    if (image.isEmpty() || size.width !== payload.width || size.height !== payload.height) {
      return { status: 'error', reason: 'invalid-output-image' };
    }
    if (payload.action === 'add') {
      await copyScreenshot(payload.pngBytes);
      completeAfterReply(session, { status: 'ok', pngBytes: new Uint8Array(payload.pngBytes), comment: payload.comment, captureId: session.token });
      return { status: 'ok' };
    }
    if (payload.action === 'copy') await copyScreenshot(payload.pngBytes);
    else if (payload.action === 'save') {
      const saved = await saveScreenshot(payload.pngBytes, sender);
      if (saved === 'cancelled') return { status: 'cancelled' };
    } else {
      const controller = new AbortController();
      void session.promise.then(() => controller.abort());
      const pin = await createPinnedScreenshot(payload.pngBytes, payload.width, payload.height, currentLocale, controller.signal);
      if (!isCurrent(session)) {
        if (!pin.isDestroyed()) pin.destroy();
        return { status: 'cancelled' };
      }
    }
    completeAfterReply(session, { status: 'completed', action: payload.action });
    return { status: 'ok' };
  } catch (error) {
    return { status: 'error', reason: error instanceof Error ? error.message : String(error) };
  }
}

export function cancelScreenshotCapture(): void {
  if (activeSession !== null) settle(activeSession, { status: 'cancelled' });
}

export function shutdownScreenshot(): void {
  shuttingDown = true;
  if (warmupTimer !== null) clearTimeout(warmupTimer);
  warmupTimer = null;
  cancelScreenshotCapture();
  shutdownCaptureStreams();
  for (const { window } of overlayWindows.values()) if (!window.isDestroyed()) window.destroy();
}

export function captureScreenshot(): Promise<ScreenshotCaptureResult> {
  if (process.platform === 'linux' && process.env['XDG_SESSION_TYPE']?.toLowerCase() !== 'x11' && process.env['WAYLAND_DISPLAY'] !== undefined) {
    return Promise.resolve({ status: 'error', reason: 'wayland-unsupported' });
  }
  if (activeSession !== null) {
    if (activeSession.guidance !== null) showMainWindow();
    for (const win of activeSession.windows) {
      if (activeSession.shown && !win.isDestroyed()) win.focus();
    }
    return activeSession.promise;
  }
  const session = createSession();
  activeSession = session;
  void runCapture(session, process.env['KIMI_SCREENSHOT_FAKE_FRAME'] === '1').catch((error) => {
    if (isCurrent(session)) settle(session, { status: 'error', reason: `startup-failed:${error instanceof Error ? error.name : 'unknown'}` });
  });
  return session.promise.then((result) => {
    if (result.status === 'ok') showMainWindow();
    if (hotkeyFocusReturnArmed) {
      hotkeyFocusReturnArmed = false;
      if (result.status !== 'ok' && !(result.status === 'completed' && result.action === 'pin') && !mainWindowVisibleAtTrigger && process.platform === 'darwin') app.hide();
    }
    return result.status === 'error' ? { ...result, captureId: session.token } : result;
  });
}

export function noteHotkeyTrigger(mainWindowVisible: boolean): void {
  hotkeyFocusReturnArmed = true;
  mainWindowVisibleAtTrigger = mainWindowVisible;
}

export function initScreenshot(): void {
  ipcMain.handle(IPC.screenshotGuideGet, (event) => {
    return event.sender === getMainWindow()?.webContents ? activeSession?.guidance ?? null : null;
  });
  ipcMain.handle(IPC.screenshotGuideAction, async (event, token: unknown, action: unknown) => {
    const session = activeSession;
    if (event.sender !== getMainWindow()?.webContents || session === null || session.token !== token || session.guidance === null) return;
    const guide = session.guidance;
    if (action === 'cancel') {
      settle(session, { status: 'cancelled' });
    } else if (action === 'continue' && guide.phase === 'ready') {
      closeGuidance(session, true);
    } else if (action === 'check' || (action === 'request' && guide.canRequest)) {
      await checkGuidance(session);
    } else if (action === 'settings' && process.platform === 'darwin' && guide.kind !== 'restricted') {
      guide.settingsOpened = true;
      guide.notice = 'none';
      publishGuidance(session);
      try {
        await shell.openExternal(SCREEN_CAPTURE_SETTINGS_URL);
      } catch {
        if (!isCurrent(session) || session.guidance !== guide) return;
        guide.notice = 'settings-failed';
        publishGuidance(session);
      }
    } else if (action === 'reveal' && guide.canRevealApp) {
      shell.showItemInFolder(dirname(dirname(dirname(app.getPath('exe')))));
    } else if (action === 'restart' && process.platform === 'darwin' && guide.kind !== 'restricted' && !guide.canRequest) {
      settle(session, { status: 'cancelled' });
      app.relaunch();
      app.quit();
    }
  });
  protocol.handle('shot', (request) => {
    const url = new URL(request.url);
    if (url.host === 'frame' && activeSession !== null) {
      const parts = url.pathname.split('/').filter(Boolean);
      if (parts.length === 2 && parts[0] === activeSession.token) {
        const frame = activeSession.frames.get(parts[1]!.replace(/\.(?:png|bmp)$/, ''));
        if (frame !== undefined && parts[1]!.endsWith(`.${frame.format}`)) {
          return new Response(new Uint8Array(frame.data), { headers: { 'content-type': `image/${frame.format}`, 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
        }
      }
    }
    if (url.host === 'pin') {
      const token = url.pathname.replace(/^\//, '').replace(/\.png$/, '');
      const frame = pinnedScreenshotBuffer(token);
      if (frame !== undefined) return new Response(new Uint8Array(frame), { headers: { 'content-type': 'image/png', 'cache-control': 'no-store', 'access-control-allow-origin': '*' } });
    }
    return new Response('not found', { status: 404 });
  });
  ipcMain.on(IPC.shotLoaded, (event) => {
    const entry = [...overlayWindows.values()].find(({ window }) => window.webContents.id === event.sender.id);
    if (entry === undefined) return;
    entry.loaded = true;
    if (activeSession !== null) capturePhase(activeSession, 'overlay-loaded');
    const context = activeSession?.contexts.get(event.sender.id);
    if (context !== undefined) event.sender.send(IPC.shotSetContext, context);
  });
  ipcMain.handle(IPC.shotAction, onShotAction);
  ipcMain.handle(IPC.shotCopyColor, async (event, captureId: unknown, color: unknown) => {
    if (senderSession(event, captureId) === null || typeof color !== 'string') return false;
    const rgba = /^rgba\((\d{1,3}),(\d{1,3}),(\d{1,3}),(0(?:\.\d{1,2})?|1(?:\.0{1,2})?)\)$/.exec(color);
    if (!/^#[0-9A-F]{6}$/.test(color) && (rgba === null || rgba.slice(1, 4).some((channel) => Number(channel) > 255))) return false;
    await clipboard.writeText(color);
    return true;
  });
  ipcMain.on(IPC.shotEditText, (event, captureId: unknown, command: unknown) => {
    if (senderSession(event, captureId) === null) return;
    if (command === 'selectAll' || command === 'cut' || command === 'copy' || command === 'paste' || command === 'undo' || command === 'redo') {
      event.sender[command]();
    }
  });
  ipcMain.on(IPC.shotReady, (event, captureId: unknown) => {
    const session = senderSession(event, captureId);
    if (session === null) return;
    session.readyContents.add(event.sender.id);
    capturePhase(session, 'frame-ready');
    showOverlays(session);
  });
  ipcMain.on(IPC.shotFailed, (event, captureId: unknown, stage: unknown) => {
    const session = senderSession(event, captureId);
    if (session === null) return;
    const reason = stage === 'frame-decode' || stage === 'editor-init' ? stage : 'overlay-init';
    settle(session, { status: 'error', reason });
  });
  ipcMain.on(IPC.shotCancel, (event, captureId: unknown) => {
    const session = senderSession(event, captureId);
    if (session !== null) settle(session, { status: 'cancelled' });
  });
  ipcMain.on(IPC.shotBandStart, (event, captureId: unknown) => {
    const session = senderSession(event, captureId);
    if (session === null) return;
    session.selectionContentsId = event.sender.id;
    for (const win of session.windows) {
      if (win.webContents !== event.sender && !win.isDestroyed()) win.webContents.send(IPC.shotClearSelection, session.token);
    }
  });
  ipcMain.on(IPC.shotBandEnd, (event, captureId: unknown) => {
    const session = senderSession(event, captureId);
    if (session === null || session.selectionContentsId !== event.sender.id) return;
    session.selectionContentsId = null;
    for (const win of session.windows) {
      if (!win.isDestroyed()) win.webContents.send(IPC.shotPreviewEnabled, session.token);
    }
  });
  ipcMain.on(IPC.shotPointerEnter, (event, captureId: unknown) => {
    const session = senderSession(event, captureId);
    if (session === null || session.selectionContentsId !== null) return;
    for (const win of session.windows) {
      if (win.webContents !== event.sender && !win.isDestroyed()) win.webContents.send(IPC.shotPointerLeave, session.token);
    }
    const target = session.windows.find((win) => win.webContents === event.sender && !win.isDestroyed());
    target?.focus();
  });
  initPinnedScreenshotIpc();
  screen.on('display-added', abortOnDisplayChange);
  screen.on('display-removed', abortOnDisplayChange);
  screen.on('display-metrics-changed', onDisplayMetricsChanged);
  scheduleWarmup();
}
