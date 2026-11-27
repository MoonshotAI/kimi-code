import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScreenshotGuidance } from '../../../src/shared/screenshot-guidance';
import { IPC } from '../../../src/main/ipc/ipc-channels';

const windows: OverlayWindow[] = [];
const ipc = Object.assign(new EventEmitter(), { handle: vi.fn() });
const focus = vi.fn();
const app = Object.assign(new EventEmitter(), { isPackaged: false, getPath: (): string => '/Applications/Kimi Code Preview.app/Contents/MacOS/Kimi Code Preview', focus, hide: vi.fn(), getName: (): string => 'Kimi Code Preview', relaunch: vi.fn(), quit: vi.fn(), exit: vi.fn() });
const getMediaAccessStatus = vi.fn();
const showMessageBox = vi.fn();
const openExternal = vi.fn();
const showItemInFolder = vi.fn();
const createPinnedScreenshot = vi.fn();
const copyScreenshot = vi.fn();
const writeText = vi.fn();
const createFromBuffer = vi.fn();
const saveScreenshot = vi.fn(async () => 'saved');
const getSources = vi.fn();
const configureScreenshotOverlay = vi.fn();
const captureNativeScreenshotFrames = vi.fn();
const listScreenshotWindows = vi.fn();
const globalShortcut = { isRegistered: vi.fn(), register: vi.fn(), unregister: vi.fn() };
const startupContents = new EventEmitter();
const mainWindow = Object.assign(new EventEmitter(), { isDestroyed: () => false, webContents: { send: vi.fn() } });
const protocol = { handle: vi.fn() };
const displays = [
  { id: 1, bounds: { x: 0, y: 0, width: 160, height: 100 }, scaleFactor: 2 },
  { id: 2, bounds: { x: -160, y: 0, width: 160, height: 100 }, scaleFactor: 1 },
];
const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const screen = Object.assign(new EventEmitter(), {
  getAllDisplays: () => displays,
  getCursorScreenPoint: () => ({ x: -80, y: 50 }),
  getDisplayNearestPoint: () => displays[1],
});

class OverlayWindow extends EventEmitter {
  static fromWebContents(contents: unknown): OverlayWindow | undefined {
    return windows.find((win) => win.webContents === contents);
  }

  readonly webContents = Object.assign(new EventEmitter(), {
    id: windows.length + 1,
    setZoomFactor: vi.fn(),
    setIgnoreMenuShortcuts: vi.fn(),
    selectAll: vi.fn(), cut: vi.fn(), copy: vi.fn(), paste: vi.fn(), undo: vi.fn(), redo: vi.fn(),
    setWindowOpenHandler: vi.fn(),
    send: vi.fn(),
    capturePage: vi.fn().mockResolvedValue({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 255]) }) }),
  });
  readonly show = vi.fn();
  readonly showInactive = vi.fn();
  readonly hide = vi.fn();
  readonly focus = vi.fn();
  readonly moveTop = vi.fn();
  readonly setAlwaysOnTop = vi.fn();
  readonly setWindowButtonVisibility = vi.fn();
  readonly setVisibleOnAllWorkspaces = vi.fn();
  readonly loadURL = vi.fn().mockResolvedValue(undefined);
  readonly setBounds = vi.fn();
  readonly getContentBounds = vi.fn(() => this.setBounds.mock.calls.at(-1)?.[0] ?? displays[0]!.bounds);
  readonly getBounds = this.getContentBounds;
  destroyed = false;

  constructor(readonly options: { show: boolean; type?: string; transparent?: boolean; backgroundColor: string; thickFrame?: boolean; enableLargerThanScreen: boolean; webPreferences: { backgroundThrottling: boolean } }) {
    super();
    windows.push(this);
  }

  isDestroyed(): boolean {
    return this.destroyed;
  }

  destroy(): void {
    this.destroyed = true;
    this.emit('closed');
  }
}

vi.mock('../../../src/main/screenshot/screenshot-output', () => ({ initPinnedScreenshotIpc: vi.fn(), createPinnedScreenshot, copyScreenshot, saveScreenshot }));
vi.mock('../../../src/main/window/window-registry', () => ({ getMainWindow: () => mainWindow, focusedWindowWebContents: () => startupContents }));
vi.mock('../../../src/main/window/main-window', () => ({ showMainWindow: vi.fn() }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { info: vi.fn(), warn: vi.fn() } }));
vi.mock('../../../src/main/screenshot/screenshot-native', () => ({ configureScreenshotOverlay, captureNativeScreenshotFrames }));
vi.mock('node:os', () => ({ release: () => '23.0.0' }));
vi.mock('../../../src/main/screenshot/screenshot-windows', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/main/screenshot/screenshot-windows')>(), listScreenshotWindows,
}));

let capture: typeof import('../../../src/main/screenshot/controller');

beforeEach(async () => {
  Object.defineProperty(process, 'platform', { value: 'darwin' });
  vi.resetModules();
  vi.useFakeTimers();
  vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '1');
  windows.length = 0;
  ipc.removeAllListeners();
  screen.removeAllListeners();
  focus.mockClear();
  app.hide.mockClear();
  createPinnedScreenshot.mockClear();
  copyScreenshot.mockClear();
  saveScreenshot.mockClear();
  ipc.handle.mockClear();
  app.removeAllListeners();
  app.relaunch.mockClear();
  app.quit.mockClear();
  app.exit.mockClear();
  getMediaAccessStatus.mockReset().mockReturnValue('granted');
  showMessageBox.mockReset().mockImplementation((_parent, options) => Promise.resolve({ response: options.cancelId }));
  app.isPackaged = false;
  mainWindow.webContents.send.mockClear();
  showItemInFolder.mockClear();
  openExternal.mockReset().mockResolvedValue(undefined);
  getSources.mockReset();
  configureScreenshotOverlay.mockReset();
  captureNativeScreenshotFrames.mockReset();
  listScreenshotWindows.mockReset().mockResolvedValue(new Map());
  copyScreenshot.mockReset();
  writeText.mockReset();
  createFromBuffer.mockReset().mockImplementation(() => ({ isEmpty: () => false, getSize: () => ({ width: 320, height: 200 }) }));
  globalShortcut.isRegistered.mockReset().mockReturnValue(false);
  globalShortcut.register.mockReset().mockReturnValue(true);
  globalShortcut.unregister.mockReset();
  startupContents.removeAllListeners();
  mainWindow.removeAllListeners();
  ipc.handle.mockClear();
  protocol.handle.mockClear();
  vi.doMock('electron', () => ({
    app,
    BrowserWindow: OverlayWindow,
    clipboard: { writeText },
    desktopCapturer: { getSources },
    dialog: { showMessageBox },
    ipcMain: ipc,
    globalShortcut,
    nativeImage: { createFromBuffer },
    protocol,
    screen,
    shell: { openExternal, showItemInFolder },
    systemPreferences: { getMediaAccessStatus },
  }));
  capture = await import('../../../src/main/screenshot/controller');
  capture.initScreenshot();
});

afterEach(() => {
  capture.shutdownScreenshot();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.doUnmock('electron');
  Object.defineProperty(process, 'platform', originalPlatform);
});

async function ready(win: OverlayWindow): Promise<void> {
  ipc.emit(IPC.shotLoaded, { sender: win.webContents });
  ipc.emit(IPC.shotReady, { sender: win.webContents }, captureId(win));
  await vi.advanceTimersByTimeAsync(0);
}

function captureId(win: OverlayWindow): string {
  const call = win.webContents.send.mock.calls.findLast(([channel, value]) => channel === IPC.shotSetContext && value !== null);
  if (call === undefined) throw new Error('capture context was not sent');
  return (call[1] as { captureId: string }).captureId;
}

function guidance(): ScreenshotGuidance | null {
  return ipc.handle.mock.calls.find(([channel]) => channel === IPC.screenshotGuideGet)![1]({ sender: mainWindow.webContents });
}

function guideAction(action: string, token = guidance()?.captureId, sender: unknown = mainWindow.webContents): Promise<void> {
  return ipc.handle.mock.calls.find(([channel]) => channel === IPC.screenshotGuideAction)![1]({ sender }, token, action);
}

describe('screenshot startup cancellation and output', () => {
  it.each(['darwin', 'win32'])('cleans up an active %s capture on confirmed shutdown without prewarming again', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    for (const win of windows) {
      win.emit('ready-to-show');
      await ready(win);
    }
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    capture.shutdownScreenshot();
    capture.shutdownScreenshot();

    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(windows.every((win) => win.isDestroyed())).toBe(true);
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Escape');
    await vi.advanceTimersByTimeAsync(2000);
    expect(windows).toHaveLength(displays.length);
  });

  it('stops pending warmup on confirmed shutdown', async () => {
    capture.shutdownScreenshot();
    await vi.advanceTimersByTimeAsync(2000);
    expect(windows).toHaveLength(0);
  });

  it('does not create a desktop capture host during Windows warmup', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await vi.advanceTimersByTimeAsync(1500);
    expect(windows).toHaveLength(displays.length);
  });

  it.each(['darwin', 'win32'])('preserves the current %s capture when quitting is cancelled', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    for (const win of windows) {
      win.emit('ready-to-show');
      await ready(win);
    }
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } };
    app.prependOnceListener('before-quit', (event) => event.preventDefault());
    app.emit('before-quit', event);

    expect(event.defaultPrevented).toBe(true);
    expect(windows).toHaveLength(displays.length);
    expect(windows.every((win) => !win.isDestroyed())).toBe(true);
    for (const win of windows) {
      expect(win.hide).not.toHaveBeenCalled();
      expect(win.webContents.send).not.toHaveBeenCalledWith(IPC.shotSetContext, null);
    }
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('keeps Windows prewarming after quitting is cancelled', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    await vi.advanceTimersByTimeAsync(1500);
    const prepared = [...windows];
    const event = { preventDefault: vi.fn() };
    app.prependOnceListener('before-quit', (event) => event.preventDefault());
    app.emit('before-quit', event);
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(windows).toEqual(prepared);
    for (const win of prepared) await ready(win);
    capture.cancelScreenshotCapture();
    await result;
    await vi.advanceTimersByTimeAsync(1500);
    expect(prepared.every((win) => win.isDestroyed())).toBe(true);
    expect(windows.filter((win) => !win.isDestroyed())).toHaveLength(displays.length);
  });

  it('cancels Windows capture on the first global Escape without showing late frames or macOS permission prompts', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    let finish!: (sources: unknown[]) => void;
    getSources.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(getSources).toHaveBeenCalledWith({ types: ['screen'], thumbnailSize: { width: 320, height: 320 } });
    const cancel = globalShortcut.register.mock.calls.find(([key]) => key === 'Escape')?.[1] as (() => void) | undefined;
    expect(cancel).toBeTypeOf('function');
    cancel!();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    finish([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Escape');
    expect(getMediaAccessStatus).not.toHaveBeenCalled();
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(captureNativeScreenshotFrames).not.toHaveBeenCalled();
    expect(windows.every((win) => win.show.mock.calls.length === 0 && win.showInactive.mock.calls.length === 0)).toBe(true);
  });

  it('uses composited display frames and forwards only overlay IDs on Windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    configureScreenshotOverlay.mockReturnValueOnce('9001').mockReturnValueOnce('9002');
    getSources.mockResolvedValue(displays.map((display) => ({
      display_id: String(display.id),
      thumbnail: {
        toPNG: () => Buffer.from(`composited-${display.id}`),
        toBitmap: () => Buffer.alloc(display.bounds.width * display.bounds.height * display.scaleFactor ** 2 * 4, 255),
        getSize: () => ({ width: display.bounds.width * display.scaleFactor, height: display.bounds.height * display.scaleFactor }),
        isEmpty: () => false,
      },
    })));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(listScreenshotWindows).toHaveBeenCalledWith(displays, ['9001', '9002']);
    expect(captureNativeScreenshotFrames).not.toHaveBeenCalled();
    for (const win of windows) {
      expect(win.show).not.toHaveBeenCalled();
      win.emit('ready-to-show');
      await ready(win);
    }
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    expect(windows[0]!.showInactive).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('cancels an early Escape delivered to the original app window and removes the listener', async () => {
    const result = capture.captureScreenshot();
    const event = { preventDefault: vi.fn() };
    startupContents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape', isComposing: true });
    expect(event.preventDefault).not.toHaveBeenCalled();
    startupContents.emit('before-input-event', event, { type: 'keyDown', key: 'Escape', isComposing: false });
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(startupContents.listenerCount('before-input-event')).toBe(0);
  });
  it.runIf(process.platform === 'darwin')('cancels on the first Escape during capture and ignores late frames', async () => {
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    let resolveFrames!: (frames: never[]) => void;
    captureNativeScreenshotFrames.mockReturnValue(new Promise((resolve) => { resolveFrames = resolve; }));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(globalShortcut.register).toHaveBeenCalledWith('Escape', expect.any(Function));
    globalShortcut.register.mock.calls[0]![1]();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(globalShortcut.unregister).toHaveBeenCalledExactlyOnceWith('Escape');
    resolveFrames([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(windows.every((win) => win.show.mock.calls.length === 0)).toBe(true);
  });

  it('releases the temporary Escape when the overlay takes over the keyboard', async () => {
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = capture.captureScreenshot();
      expect(globalShortcut.register).toHaveBeenCalledTimes(attempt + 1);
      for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
      expect(globalShortcut.unregister).toHaveBeenCalledTimes(attempt + 1);
      expect(startupContents.listenerCount('before-input-event')).toBe(0);
      ipc.emit(IPC.shotCancel, { sender: windows[0]!.webContents }, captureId(windows[0]!));
      await expect(result).resolves.toEqual({ status: 'cancelled' });
      expect(globalShortcut.unregister).toHaveBeenCalledTimes(attempt + 1);
    }
  });

  it.each([true, false])('does not remove another Escape registration (already registered: %s)', async (registered) => {
    globalShortcut.isRegistered.mockReturnValue(registered);
    globalShortcut.register.mockReturnValue(false);
    const result = capture.captureScreenshot();
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(globalShortcut.unregister).not.toHaveBeenCalled();
  });

  it.each(['', 'Look at this'])('copies the same image when adding it with comment %j', async (comment) => {
    const result = capture.captureScreenshot();
    const win = windows[0]!;
    await ready(win);
    const action = ipc.handle.mock.calls.find(([channel]) => channel === IPC.shotAction)![1];
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
    await expect(action({ sender: win.webContents }, {
      captureId: captureId(win), displayId: '1', action: 'add', pngBytes, width: 320, height: 200, comment,
    })).resolves.toEqual({ status: 'ok' });
    expect(createFromBuffer).toHaveBeenCalledOnce();
    expect(copyScreenshot).toHaveBeenCalledExactlyOnceWith(pngBytes);
    await vi.advanceTimersByTimeAsync(40);
    await expect(result).resolves.toEqual({ status: 'ok', pngBytes: new Uint8Array(pngBytes), comment, captureId: captureId(win) });
  });

  it('validates the output image once and copies its PNG bytes for the copy action', async () => {
    const result = capture.captureScreenshot();
    const win = windows[0]!;
    await ready(win);
    const action = ipc.handle.mock.calls.find(([channel]) => channel === IPC.shotAction)![1];
    const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10]);
    await expect(action({ sender: win.webContents }, {
      captureId: captureId(win), displayId: '1', action: 'copy', pngBytes, width: 320, height: 200, comment: '',
    })).resolves.toEqual({ status: 'ok' });
    expect(createFromBuffer).toHaveBeenCalledExactlyOnceWith(pngBytes);
    expect(copyScreenshot).toHaveBeenCalledExactlyOnceWith(pngBytes);
    await vi.advanceTimersByTimeAsync(40);
    await expect(result).resolves.toEqual({ status: 'completed', action: 'copy' });
  });
});

describe('screen recording permissions', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    captureNativeScreenshotFrames.mockResolvedValue(displays.map((display) => ({
      displayId: String(display.id), png: Buffer.from('frame'), width: 320, height: 200,
    })));
  });

  it.each(['Kimi Code', 'Kimi Code Preview', 'Kimi Code Canary'])('uses the installed macOS name %s instead of the internal package name', async (product) => {
    app.isPackaged = true;
    const name = vi.spyOn(app, 'getName').mockReturnValue('kimi-code-app');
    const path = vi.spyOn(app, 'getPath').mockReturnValue(`/Applications/${product}.app/Contents/MacOS/${product}`);
    getMediaAccessStatus.mockReturnValue('denied');
    try {
      const result = capture.captureScreenshot();
      await vi.advanceTimersByTimeAsync(0);
      expect(guidance()).toMatchObject({ appName: product });
      await guideAction('cancel');
      await expect(result).resolves.toEqual({ status: 'cancelled' });
    } finally {
      name.mockRestore();
      path.mockRestore();
    }
  });

  it('explains first use without prompting until the user requests access, then verifies real frames', async () => {
    getMediaAccessStatus.mockReturnValue('not-determined');
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(guidance()).toMatchObject({ kind: 'permission', canRequest: true, appName: 'Kimi Code Preview' });
    expect(captureNativeScreenshotFrames).not.toHaveBeenCalled();
    await guideAction('request');
    expect(guidance()).toMatchObject({ phase: 'ready', canRequest: false });
    expect(windows).toHaveLength(0);
    await guideAction('continue');
    await vi.advanceTimersByTimeAsync(0);
    expect(captureNativeScreenshotFrames).toHaveBeenCalledTimes(2);
    expect(guidance()).toBeNull();
    await ready(windows[0]!);
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('handles a real native permission denial even when the system reports granted', async () => {
    const error = Object.assign(new Error('native-capture-content:com.apple.ScreenCaptureKit.SCStreamErrorDomain:-3801'), { code: 'screen-capture-permission-denied' });
    captureNativeScreenshotFrames.mockRejectedValue(error);
    const finished = vi.fn();
    const result = capture.captureScreenshot().then(finished);
    await vi.advanceTimersByTimeAsync(0);
    expect(guidance()).toMatchObject({ kind: 'permission', reason: expect.stringContaining('-3801') });
    expect(finished).not.toHaveBeenCalled();
    await guideAction('check');
    expect(guidance()).toMatchObject({ kind: 'permission', phase: 'idle', notice: 'not-ready' });
    await guideAction('continue');
    expect(guidance()).not.toBeNull();
    await guideAction('cancel');
    await result;
    expect(finished).toHaveBeenCalledWith({ status: 'cancelled' });
    expect(showMessageBox).not.toHaveBeenCalled();
  });

  it('shows every screen after recovering from a native capture failure with prebuilt windows', async () => {
    captureNativeScreenshotFrames.mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'screen-capture-permission-denied' }));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(windows).toHaveLength(2);
    await guideAction('check');
    expect(guidance()?.phase).toBe('ready');
    await guideAction('continue');
    await vi.advanceTimersByTimeAsync(0);
    for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
    expect(windows[0]!.showInactive).toHaveBeenCalledOnce();
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('retains a persistent guide when settings cannot open', async () => {
    getMediaAccessStatus.mockReturnValue('denied');
    openExternal.mockRejectedValue(new Error('unavailable'));
    const result = capture.captureScreenshot();
    await guideAction('settings');
    expect(openExternal).toHaveBeenCalledWith(expect.stringContaining('Privacy_ScreenCapture'));
    expect(guidance()).toMatchObject({ notice: 'settings-failed', settingsOpened: true });
    expect(captureNativeScreenshotFrames).not.toHaveBeenCalled();
    await guideAction('cancel');
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('checks once on return from settings and waits for explicit continuation', async () => {
    getMediaAccessStatus.mockReturnValue('denied');
    const result = capture.captureScreenshot();
    await guideAction('settings');
    mainWindow.emit('focus');
    mainWindow.emit('focus');
    await vi.advanceTimersByTimeAsync(0);
    expect(captureNativeScreenshotFrames).toHaveBeenCalledOnce();
    expect(guidance()?.phase).toBe('ready');
    expect(windows).toHaveLength(0);
    await guideAction('continue');
    await vi.advanceTimersByTimeAsync(0);
    expect(captureNativeScreenshotFrames).toHaveBeenCalledTimes(2);
    expect(mainWindow.listenerCount('focus')).toBe(0);
    capture.cancelScreenshotCapture();
    await result;
  });

  it('keeps settings guidance beyond capture timeout, without reserving Escape', async () => {
    getMediaAccessStatus.mockReturnValue('denied');
    const finished = vi.fn();
    const result = capture.captureScreenshot().then(finished);
    await vi.advanceTimersByTimeAsync(60_001);
    expect(finished).not.toHaveBeenCalled();
    expect(globalShortcut.register).not.toHaveBeenCalled();
    await guideAction('cancel');
    await result;
  });

  it('deduplicates checks and ignores their results after cancellation', async () => {
    getMediaAccessStatus.mockReturnValue('denied');
    let finish!: (frames: unknown[]) => void;
    captureNativeScreenshotFrames.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const result = capture.captureScreenshot();
    const token = guidance()!.captureId;
    const check = guideAction('check');
    await guideAction('check');
    expect(captureNativeScreenshotFrames).toHaveBeenCalledOnce();
    await guideAction('cancel');
    finish([{ displayId: '1', png: Buffer.from('frame'), width: 320, height: 200 }]);
    await check;
    await guideAction('restart', token);
    await guideAction('continue', token);
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(guidance()).toBeNull();
    expect(mainWindow.listenerCount('focus')).toBe(0);
    expect(windows).toHaveLength(0);
  });

  it('times out a stalled access check and keeps recovery usable', async () => {
    getMediaAccessStatus.mockReturnValue('denied');
    captureNativeScreenshotFrames.mockReturnValue(new Promise(() => {}));
    const result = capture.captureScreenshot();
    const check = guideAction('check');
    await vi.advanceTimersByTimeAsync(15_001);
    await check;
    expect(guidance()).toMatchObject({ phase: 'idle', notice: 'not-ready', reason: expect.stringContaining('screen-access-check-timeout') });
    await guideAction('cancel');
    await result;
  });

  it('keeps one request on repeated triggers and cancels when its host window closes', async () => {
    getMediaAccessStatus.mockReturnValue('denied');
    const first = capture.captureScreenshot();
    const token = guidance()!.captureId;
    const second = capture.captureScreenshot();
    expect(guidance()!.captureId).toBe(token);
    expect(mainWindow.listenerCount('focus')).toBe(1);
    mainWindow.emit('closed');
    await expect(first).resolves.toEqual({ status: 'cancelled' });
    await expect(second).resolves.toEqual({ status: 'cancelled' });
    expect(mainWindow.listenerCount('focus')).toBe(0);
    expect(guidance()).toBeNull();
  });

  it('explains restrictions without settings, capture, or restart actions', async () => {
    getMediaAccessStatus.mockReturnValue('restricted');
    const result = capture.captureScreenshot();
    expect(guidance()?.kind).toBe('restricted');
    for (const action of ['settings', 'check', 'restart']) await guideAction(action);
    expect(openExternal).not.toHaveBeenCalled();
    expect(captureNativeScreenshotFrames).not.toHaveBeenCalled();
    expect(app.relaunch).not.toHaveBeenCalled();
    await guideAction('cancel');
    await result;
  });

  it('reveals only the installed App and rejects actions from overlay senders or old sessions', async () => {
    app.isPackaged = true;
    getMediaAccessStatus.mockReturnValue('denied');
    const result = capture.captureScreenshot();
    expect(guidance()?.canRevealApp).toBe(true);
    await guideAction('reveal', 'old-token');
    await guideAction('reveal', guidance()!.captureId, { id: 123 });
    expect(showItemInFolder).not.toHaveBeenCalled();
    await guideAction('reveal');
    expect(showItemInFolder).toHaveBeenCalledWith('/Applications/Kimi Code Preview.app');
    await guideAction('restart');
    expect(app.relaunch).toHaveBeenCalledOnce();
    expect(app.quit).toHaveBeenCalledOnce();
    await result;
  });

  it.each(['empty', 'failure'])('retains %s capture diagnostics without falsely claiming permission denial', async (mode) => {
    if (mode === 'empty') captureNativeScreenshotFrames.mockResolvedValue([]);
    else captureNativeScreenshotFrames.mockRejectedValue(new Error('native-capture-frame-timeout'));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(guidance()).toMatchObject({ kind: 'capture', reason: expect.stringContaining(mode === 'empty' ? 'no-screen-frames' : 'native-capture-frame-timeout') });
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Escape');
    await guideAction('cancel');
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });
});

describe('Windows capture recovery', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
  });

  it.each(['empty', 'failure'])('offers recovery for %s frames without macOS permission or restart actions', async (mode) => {
    if (mode === 'empty') getSources.mockResolvedValue([]);
    else getSources.mockRejectedValue(new Error('capture unavailable'));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(guidance()).toMatchObject({ kind: 'capture', platform: 'win32', canRequest: false, canRevealApp: false });
    for (const action of ['settings', 'request', 'reveal', 'restart']) await guideAction(action);
    expect(getMediaAccessStatus).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(app.relaunch).not.toHaveBeenCalled();
    await guideAction('cancel');
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('checks real frames then retries the original request', async () => {
    getSources.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValue(displays.map((display) => ({
      display_id: String(display.id), thumbnail: { toPNG: () => Buffer.from('frame'), toBitmap: () => Buffer.alloc(320 * 200 * 4, 255), getSize: () => ({ width: 320, height: 200 }), isEmpty: () => false },
    })));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(globalShortcut.unregister).toHaveBeenCalledWith('Escape');
    await guideAction('check');
    expect(guidance()?.phase).toBe('ready');
    await guideAction('continue');
    await vi.advanceTimersByTimeAsync(0);
    expect(getSources).toHaveBeenCalledTimes(3);
    for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
    expect(windows[0]!.showInactive).toHaveBeenCalledOnce();
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    expect(windows[0]!.webContents.send).toHaveBeenCalledWith(IPC.shotSetContext, expect.any(Object));
    capture.cancelScreenshotCapture();
    await result;
  });
});

describe('screenshot overlay visibility', () => {
  it('keeps macOS overlays hidden until transparent stale frames have been replaced', async () => {
    const result = capture.captureScreenshot();
    windows[0]!.webContents.capturePage.mockResolvedValueOnce({
      isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 0]) }),
    });
    for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
    expect(windows.every((win) => win.show.mock.calls.length === 0 && win.showInactive.mock.calls.length === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(16);
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    expect(windows[0]!.webContents.capturePage).toHaveBeenCalledTimes(2);
    capture.cancelScreenshotCapture();
    await result;
  });

  it('paints and shows Windows overlays even when a hidden window never emits ready-to-show', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const result = capture.captureScreenshot();
    windows[0]!.emit('ready-to-show');
    for (const win of windows) await ready(win);
    await vi.advanceTimersByTimeAsync(0);
    expect(windows.every((win) => win.webContents.capturePage.mock.calls.length === 1)).toBe(true);
    expect(windows[0]!.showInactive).toHaveBeenCalledOnce();
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await result;
  });

  it('stops waiting for macOS transparent frames when the capture is cancelled or times out', async () => {
    for (const timeout of [false, true]) {
      const result = capture.captureScreenshot();
      for (const win of windows.filter((win) => !win.destroyed)) {
        win.webContents.capturePage.mockResolvedValue({
          isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 0]) }),
        });
        win.emit('ready-to-show');
        await ready(win);
      }
      if (timeout) await vi.advanceTimersByTimeAsync(10_001);
      else capture.cancelScreenshotCapture();
      await expect(result).resolves.toEqual(timeout ? { status: 'error', reason: 'overlay-ready-timeout', captureId: expect.any(String) } : { status: 'cancelled' });
      const calls = windows.map((win) => win.webContents.capturePage.mock.calls.length);
      await vi.advanceTimersByTimeAsync(32);
      expect(windows.map((win) => win.webContents.capturePage.mock.calls.length)).toEqual(calls);
      expect(windows.every((win) => win.show.mock.calls.length === 0 && win.showInactive.mock.calls.length === 0)).toBe(true);
    }
  });

  it('checks every macOS frame again on reuse and ignores completion after cancellation', async () => {
    await vi.advanceTimersByTimeAsync(1_500);
    const finish: Array<() => void> = [];
    for (const win of windows) {
      expect(win.options).toMatchObject({ type: 'panel', transparent: true, backgroundColor: '#00000000' });
      win.webContents.capturePage.mockImplementation(() => new Promise((resolve) => {
        finish.push(() => resolve({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 255]) }) }));
      }));
      win.emit('ready-to-show');
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const result = capture.captureScreenshot();
      for (const win of windows) await ready(win);
      expect(windows).toHaveLength(2);
      expect(finish).toHaveLength(2);
      expect(windows[1]!.show).toHaveBeenCalledTimes(cycle === 0 ? 0 : 1);
      finish.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      expect(windows[1]!.show).toHaveBeenCalledTimes(cycle === 0 ? 0 : 1);
      if (cycle === 1) capture.cancelScreenshotCapture();
      finish.shift()!();
      await vi.advanceTimersByTimeAsync(0);
      expect(windows[1]!.show).toHaveBeenCalledTimes(cycle === 2 ? 2 : 1);
      capture.cancelScreenshotCapture();
      await expect(result).resolves.toEqual({ status: 'cancelled' });
      expect(windows.every((win) => !win.destroyed)).toBe(true);
    }
    expect(windows[0]!.webContents.capturePage).toHaveBeenCalledTimes(3);
  });

  it.each(['pin', 'copy', 'save', 'cancel'] as const)('preserves pinned output when completing a global capture (%s)', async (action) => {
    capture.noteHotkeyTrigger(false);
    const result = capture.captureScreenshot();
    for (const win of windows) {
      win.emit('ready-to-show');
      await ready(win);
    }
    const first = windows[0]!;
    if (action === 'cancel') {
      capture.cancelScreenshotCapture();
      await expect(result).resolves.toEqual({ status: 'cancelled' });
    } else {
      const handler = ipc.handle.mock.calls.find(([channel]) => channel === IPC.shotAction)![1];
      await expect(handler({ sender: first.webContents }, {
        captureId: captureId(first), displayId: '1', action, width: 320, height: 200, comment: '',
        pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
      })).resolves.toEqual({ status: 'ok' });
      await vi.advanceTimersByTimeAsync(40);
      await expect(result).resolves.toEqual({ status: 'completed', action });
    }
    expect(createPinnedScreenshot).toHaveBeenCalledTimes(action === 'pin' ? 1 : 0);
    expect(app.hide).toHaveBeenCalledTimes(action === 'pin' ? 0 : 1);
    expect(windows.every((win) => win.hide.mock.calls.length > 0)).toBe(true);
  });

  it('keeps the screenshot available when pin loading fails and aborts a pending pin on Escape', async () => {
    const result = capture.captureScreenshot();
    for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
    const first = windows[0]!;
    const handler = ipc.handle.mock.calls.find(([channel]) => channel === IPC.shotAction)![1];
    const payload = {
      captureId: captureId(first), displayId: '1', action: 'pin', width: 320, height: 200, comment: '',
      pngBytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    };
    createPinnedScreenshot.mockRejectedValueOnce(new Error('pin-image-load-failed'));
    await expect(handler({ sender: first.webContents }, payload)).resolves.toEqual({ status: 'error', reason: 'pin-image-load-failed' });
    expect(first.hide).not.toHaveBeenCalled();
    let signal!: AbortSignal;
    createPinnedScreenshot.mockImplementationOnce((_png, _width, _height, _locale, pendingSignal: AbortSignal) => {
      signal = pendingSignal;
      return new Promise((_resolve, reject) => pendingSignal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true }));
    });
    const pending = handler({ sender: first.webContents }, payload);
    expect(signal.aborted).toBe(false);
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    await expect(pending).resolves.toMatchObject({ status: 'error' });
    expect(signal.aborted).toBe(true);
  });

  it('waits for an actual Windows frame on every screen, replaces used windows and ignores cancelled painting', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const result = capture.captureScreenshot();
    const finish: Array<(frame: { isEmpty: () => boolean; resize: () => { toBitmap: () => Buffer } }) => void> = [];
    for (const win of windows) {
      win.webContents.capturePage.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
      win.emit('ready-to-show');
      await ready(win);
    }
    expect(finish).toHaveLength(2);
    for (const win of windows) {
      expect(win.webContents.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: false, stayAwake: true });
      expect(win.show).not.toHaveBeenCalled();
      expect(win.showInactive).not.toHaveBeenCalled();
    }
    finish[0]!({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 255]) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(windows[1]!.show).not.toHaveBeenCalled();
    capture.cancelScreenshotCapture();
    await result;
    expect(windows.every((win) => win.destroyed)).toBe(true);
    const next = capture.captureScreenshot();
    finish[1]!({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 255]) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(windows[1]!.show).not.toHaveBeenCalled();
    for (const win of windows.filter((win) => !win.destroyed)) {
      win.webContents.capturePage.mockImplementation(() => new Promise((resolve) => { finish.push(resolve); }));
      win.emit('ready-to-show');
      await ready(win);
    }
    finish[2]!({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 255]) }) });
    finish[3]!({ isEmpty: () => false, resize: () => ({ toBitmap: () => Buffer.from([0, 0, 0, 255]) }) });
    await vi.advanceTimersByTimeAsync(0);
    expect(windows[3]!.show).toHaveBeenCalledOnce();
    expect(windows[1]!.show).not.toHaveBeenCalled();
    capture.cancelScreenshotCapture();
    await next;
  });

  it.each([['darwin', 'empty'], ['darwin', 'rejected'], ['win32', 'empty'], ['win32', 'rejected']])('cleans up when %s painting returns an %s frame', async (platform, failure) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const result = capture.captureScreenshot();
    if (failure === 'empty') windows[0]!.webContents.capturePage.mockResolvedValue({ isEmpty: () => true });
    else windows[0]!.webContents.capturePage.mockRejectedValue(new Error('paint failed'));
    for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ status: 'error', reason: 'overlay-paint-failed', captureId: expect.any(String) });
    expect(windows.every((win) => win.destroyed)).toBe(true);
  });

  it('ends a pending capture immediately when native preparation fails before frames arrive', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    getSources.mockReturnValue(new Promise(() => {}));
    configureScreenshotOverlay.mockRejectedValueOnce(new Error('native setup failed'));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ status: 'error', reason: 'overlay-native-setup-failed', captureId: expect.any(String) });
    expect(windows.every((win) => win.destroyed)).toBe(true);
  });

  it.each([0, 1])('reports an incomplete Windows capture with %i frames without opening macOS permission guidance', async (count) => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    getSources.mockResolvedValue(displays.slice(0, count).map((display) => ({
      display_id: String(display.id),
      thumbnail: { toPNG: () => Buffer.from('png'), toBitmap: () => Buffer.alloc(320 * 200 * 4), getSize: () => ({ width: 320, height: 200 }), isEmpty: () => false },
    })));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    if (count === 0) {
      expect(guidance()).toMatchObject({ kind: 'capture', platform: 'win32' });
      await guideAction('cancel');
      await expect(result).resolves.toEqual({ status: 'cancelled' });
    } else {
      await expect(result).resolves.toEqual({ status: 'error', reason: 'missing-display-frames', captureId: expect.any(String) });
    }
    expect(showMessageBox).not.toHaveBeenCalled();
    expect(windows.every((win) => win.show.mock.calls.length === 0 && win.showInactive.mock.calls.length === 0)).toBe(true);
  });

  it('serves uncompressed Windows frames only during their capture and never calls PNG encoding', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    const toPNG = vi.fn(() => { throw new Error('unexpected-png-encoding'); });
    getSources.mockResolvedValue(displays.map((display) => ({
      display_id: String(display.id),
      thumbnail: { toPNG, toBitmap: () => Buffer.alloc(320 * 200 * 4, 255), getSize: () => ({ width: 320, height: 200 }), isEmpty: () => false },
    })));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    for (const win of windows) await ready(win);
    const handle = protocol.handle.mock.calls[0]![1] as (request: { url: string }) => Response;
    const url = `shot://frame/${captureId(windows[0]!)}/1.bmp`;
    const response = handle({ url });
    expect(response.headers.get('content-type')).toBe('image/bmp');
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect((await response.arrayBuffer()).byteLength).toBe(320 * 200 * 4 + 122);
    expect(handle({ url: url.replace('.bmp', '.png') }).status).toBe(404);
    expect(toPNG).not.toHaveBeenCalled();
    capture.cancelScreenshotCapture();
    await result;
    expect(handle({ url }).status).toBe(404);
  });

  it.runIf(process.platform === 'darwin')('opens permission settings without capturing or showing overlays when access is denied', async () => {
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    getMediaAccessStatus.mockReturnValue('denied');
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    await guideAction('settings');
    await guideAction('cancel');
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(openExternal).toHaveBeenCalledWith('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
    expect(configureScreenshotOverlay).not.toHaveBeenCalled();
    expect(captureNativeScreenshotFrames).not.toHaveBeenCalled();
    expect(getSources).not.toHaveBeenCalled();
  });

  it.runIf(process.platform === 'darwin')('does not request screen access after cancelling the first-use explanation', async () => {
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    getMediaAccessStatus.mockReturnValue('not-determined');
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    await guideAction('cancel');
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(configureScreenshotOverlay).not.toHaveBeenCalled();
    expect(captureNativeScreenshotFrames).not.toHaveBeenCalled();
    expect(getSources).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
  });

  it('uses animation-free Windows frames and raises every display without stealing secondary focus', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32' });
    try {
      configureScreenshotOverlay.mockResolvedValue('9001');
      const result = capture.captureScreenshot();
      for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
      await vi.advanceTimersByTimeAsync(0);
      for (const win of windows) {
        expect(win.options.thickFrame).toBe(false);
        expect(win.setBounds).toHaveBeenCalledWith(displays[windows.indexOf(win)]!.bounds, false);
        expect(win.options.type).toBeUndefined();
        expect(win.moveTop).toHaveBeenCalledOnce();
        expect(win.setWindowButtonVisibility).not.toHaveBeenCalled();
      }
      expect(windows[0]!.showInactive).toHaveBeenCalledOnce();
      expect(windows[0]!.focus).not.toHaveBeenCalled();
      expect(windows[1]!.show).toHaveBeenCalledOnce();
      expect(windows[1]!.focus).toHaveBeenCalledOnce();
      expect(windows[1]!.focus.mock.invocationCallOrder[0]).toBeLessThan(windows[0]!.moveTop.mock.invocationCallOrder[0]!);
      capture.cancelScreenshotCapture();
      await result;
    } finally {
      capture.cancelScreenshotCapture();
      Object.defineProperty(process, 'platform', platform);
    }
  });

  it('waits for native setup on every display before showing decoded frames', async () => {
    const finish: Array<(id: string) => void> = [];
    configureScreenshotOverlay.mockImplementation(() => new Promise<string>((resolve) => { finish.push(resolve); }));
    const result = capture.captureScreenshot();
    for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
    expect(windows[1]!.show).not.toHaveBeenCalled();
    finish[0]!('9001');
    await vi.advanceTimersByTimeAsync(0);
    expect(windows[1]!.show).not.toHaveBeenCalled();
    finish[1]!('9002');
    await vi.advanceTimersByTimeAsync(0);
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    if (process.platform === 'win32') {
      for (const win of windows) {
        expect(win.options.thickFrame).toBe(false);
        expect(win.moveTop).toHaveBeenCalledOnce();
      }
    }
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    const next = capture.captureScreenshot();
    for (const win of windows) await ready(win);
    expect(configureScreenshotOverlay).toHaveBeenCalledTimes(2);
    expect(windows[1]!.show).toHaveBeenCalledTimes(2);
    capture.cancelScreenshotCapture();
    await next;
  });

  it('does not show or raise windows when setup completes after cancellation', async () => {
    let finish!: (id: string) => void;
    configureScreenshotOverlay.mockReturnValue(new Promise<string>((resolve) => { finish = resolve; }));
    const result = capture.captureScreenshot();
    for (const win of windows) { win.emit('ready-to-show'); await ready(win); }
    capture.cancelScreenshotCapture();
    await result;
    finish('9001');
    await vi.advanceTimersByTimeAsync(0);
    for (const win of windows) {
      expect(win.show).not.toHaveBeenCalled();
      expect(win.showInactive).not.toHaveBeenCalled();
      expect(win.moveTop).not.toHaveBeenCalled();
    }
  });

  it('reports asynchronous native setup failure and recreates the window for a retry', async () => {
    configureScreenshotOverlay.mockRejectedValueOnce(new Error('taskbar-fullscreen-failed'));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    await expect(result).resolves.toEqual({ status: 'error', reason: 'overlay-native-setup-failed', captureId: expect.any(String) });
    expect(windows.every((win) => win.destroyed)).toBe(true);
    configureScreenshotOverlay.mockReturnValue('9001');
    const next = capture.captureScreenshot();
    for (const win of windows.filter((win) => !win.destroyed)) { win.emit('ready-to-show'); await ready(win); }
    expect(windows.at(-1)!.show).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await next;
  });

  it.runIf(process.platform === 'darwin')('uses shadow-preserving native frames at each display resolution without showing overlays early', async () => {
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    configureScreenshotOverlay.mockReturnValueOnce('9001').mockReturnValueOnce('9002');
    const bytes = Buffer.from('native-frame-with-shadows');
    captureNativeScreenshotFrames.mockResolvedValue([
      { displayId: '2', png: bytes, width: 160, height: 100 },
      { displayId: '1', png: bytes, width: 320, height: 200 },
    ]);
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    expect(captureNativeScreenshotFrames).toHaveBeenCalledWith('all-shadows');
    expect(getSources).not.toHaveBeenCalled();
    expect(listScreenshotWindows).toHaveBeenCalledWith(displays, ['9001', '9002']);
    expect(windows.every((win) => win.show.mock.calls.length === 0 && win.showInactive.mock.calls.length === 0)).toBe(true);
    for (const win of windows) await ready(win);
    expect(windows[1]!.webContents.send).toHaveBeenCalledWith(IPC.shotSetContext, expect.objectContaining({ sourceSize: { width: 160, height: 100 } }));
    const handler = protocol.handle.mock.calls[0]![1] as (request: { url: string }) => Response;
    const url = `shot://frame/${captureId(windows[0]!)}/1.png`;
    expect(Buffer.from(await handler({ url }).arrayBuffer())).toEqual(bytes);
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(handler({ url }).status).toBe(404);
  });

  it.runIf(process.platform === 'darwin')('discards a native capture that arrives after cancellation', async () => {
    vi.stubEnv('KIMI_SCREENSHOT_FAKE_FRAME', '0');
    let finish!: (frames: unknown[]) => void;
    captureNativeScreenshotFrames.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const result = capture.captureScreenshot();
    await vi.advanceTimersByTimeAsync(0);
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    finish([{ displayId: '1', png: Buffer.from('late-frame'), width: 320, height: 200 }]);
    await vi.advanceTimersByTimeAsync(0);
    expect(windows.every((win) => win.show.mock.calls.length === 0 && win.showInactive.mock.calls.length === 0)).toBe(true);
    expect(windows.every((win) => !win.webContents.send.mock.calls.some(([channel, value]) => channel === IPC.shotSetContext && value !== null))).toBe(true);
  });

  it('applies text commands only to the sending window in the current capture', async () => {
    const result = capture.captureScreenshot();
    const [first, second] = windows as [OverlayWindow, OverlayWindow];
    await ready(first);
    await ready(second);
    const token = captureId(first);
    for (const command of ['selectAll', 'cut', 'copy', 'paste', 'undo', 'redo'] as const) {
      ipc.emit(IPC.shotEditText, { sender: first.webContents }, token, command);
      expect(first.webContents[command]).toHaveBeenCalledOnce();
      expect(second.webContents[command]).not.toHaveBeenCalled();
    }
    ipc.emit(IPC.shotEditText, { sender: first.webContents }, 'stale', 'selectAll');
    ipc.emit(IPC.shotEditText, { sender: { id: 999, selectAll: first.webContents.selectAll } }, token, 'selectAll');
    ipc.emit(IPC.shotEditText, { sender: first.webContents }, token, 'send');
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    ipc.emit(IPC.shotEditText, { sender: first.webContents }, token, 'selectAll');
    expect(first.webContents.selectAll).toHaveBeenCalledOnce();
  });

  it('copies validated hex and rgba colors only for the current capture', async () => {
    const result = capture.captureScreenshot();
    const [first, second] = windows as [OverlayWindow, OverlayWindow];
    await ready(first);
    await ready(second);
    const token = captureId(first);
    const handler = ipc.handle.mock.calls.find(([channel]) => channel === IPC.shotCopyColor)![1];
    for (const color of ['#17A2B8', 'rgba(23,162,184,0.5)']) {
      await expect(handler({ sender: first.webContents }, token, color)).resolves.toBe(true);
      expect(writeText).toHaveBeenLastCalledWith(color);
    }
    for (const color of ['#17a2b8', 'rgba(256,162,184,1)', 'text']) {
      await expect(handler({ sender: first.webContents }, token, color)).resolves.toBe(false);
    }
    await expect(handler({ sender: first.webContents }, 'stale', '#17A2B8')).resolves.toBe(false);
    await expect(handler({ sender: second.webContents }, token, '#17A2B8')).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledTimes(3);
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    await expect(handler({ sender: first.webContents }, token, '#17A2B8')).resolves.toBe(false);
    expect(writeText).toHaveBeenCalledTimes(3);
  });

  it('preloads blank windows without capturing any screen, and reuses them for the first capture', async () => {
    await vi.advanceTimersByTimeAsync(1_500);
    expect(windows).toHaveLength(2);
    expect(getSources).not.toHaveBeenCalled();
    for (const win of windows) {
      expect(win.options.enableLargerThanScreen).toBe(true);
      expect(win.webContents.setIgnoreMenuShortcuts).toHaveBeenCalledWith(true);
      expect(win.options.webPreferences.backgroundThrottling).toBe(false);
      expect(configureScreenshotOverlay).toHaveBeenCalledWith(win);
      if (process.platform === 'darwin') {
        expect(win.options.type).toBe('panel');
        expect(win.options.transparent).toBe(true);
        expect(win.options.backgroundColor).toBe('#00000000');
      }
      expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
      ipc.emit(IPC.shotLoaded, { sender: win.webContents });
      win.emit('ready-to-show');
      expect(win.webContents.send).not.toHaveBeenCalled();
    }
    const result = capture.captureScreenshot();
    expect(windows).toHaveLength(2);
    for (const win of windows) ipc.emit(IPC.shotReady, { sender: win.webContents }, captureId(win));
    await vi.advanceTimersByTimeAsync(0);
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('keeps both screens hidden until every frame is ready and painted, then focuses the cursor screen once', async () => {
    const result = capture.captureScreenshot();
    expect(windows).toHaveLength(2);
    const [first, second] = windows as [OverlayWindow, OverlayWindow];
    expect(windows.every((win) => win.options.show === false)).toBe(true);
    await ready(first);
    await ready(second);
    first.emit('ready-to-show');
    expect(first.showInactive).not.toHaveBeenCalled();
    expect(second.show).not.toHaveBeenCalled();
    expect(focus).not.toHaveBeenCalled();

    second.emit('ready-to-show');
    await vi.advanceTimersByTimeAsync(0);
    expect(first.showInactive).toHaveBeenCalledOnce();
    expect(first.focus).not.toHaveBeenCalled();
    expect(second.show).toHaveBeenCalledOnce();
    expect(second.focus).toHaveBeenCalledOnce();
    expect(focus).not.toHaveBeenCalled();
    await ready(second);
    expect(second.show).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(windows.every((win) => !win.destroyed)).toBe(true);
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('does not show a painted window before the renderer has decoded its frame', async () => {
    const result = capture.captureScreenshot();
    const [first, second] = windows as [OverlayWindow, OverlayWindow];
    first.emit('ready-to-show');
    second.emit('ready-to-show');
    await ready(first);
    expect(second.show).not.toHaveBeenCalled();
    await ready(second);
    expect(second.show).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('closes all hidden overlays if a screen never becomes ready', async () => {
    const result = capture.captureScreenshot();
    const first = windows[0]!;
    first.emit('ready-to-show');
    await ready(first);
    await vi.advanceTimersByTimeAsync(10_000);
    await expect(result).resolves.toEqual({ status: 'error', reason: 'overlay-ready-timeout', captureId: expect.any(String) });
    expect(windows.every((win) => win.destroyed)).toBe(true);
    expect(windows.every((win) => win.show.mock.calls.length === 0 && win.showInactive.mock.calls.length === 0)).toBe(true);
  });

  it('hides every screen before clearing any screenshot content', async () => {
    const result = capture.captureScreenshot();
    for (const win of windows) {
      win.emit('ready-to-show');
      await ready(win);
    }
    const events: string[] = [];
    for (const [index, win] of windows.entries()) {
      win.hide.mockImplementation(() => { events.push(`hide-${index}`); });
      win.webContents.send.mockImplementation((channel, value) => {
        if (channel === IPC.shotSetContext && value === null) events.push(`clear-${index}`);
      });
    }
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(events).toEqual(['hide-0', 'hide-1', 'clear-0', 'clear-1']);
  });

  it('clears capture data while keeping windows warm, and ignores callbacks from the previous capture', async () => {
    const firstResult = capture.captureScreenshot();
    for (const win of windows) {
      win.emit('ready-to-show');
      await ready(win);
    }
    const first = windows[0]!;
    const previousId = captureId(first);
    capture.cancelScreenshotCapture();
    await expect(firstResult).resolves.toEqual({ status: 'cancelled' });
    expect(first.hide).toHaveBeenCalledOnce();
    expect(first.webContents.send).toHaveBeenLastCalledWith(IPC.shotSetContext, null);
    expect(first.destroyed).toBe(false);
    const nextResult = capture.captureScreenshot();
    expect(windows).toHaveLength(2);
    expect(captureId(first)).not.toBe(previousId);
    ipc.emit(IPC.shotCancel, { sender: first.webContents }, previousId);
    ipc.emit(IPC.shotReady, { sender: first.webContents }, previousId);
    ipc.emit(IPC.shotFailed, { sender: first.webContents }, previousId, 'frame-decode');
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    for (const win of windows) await ready(win);
    expect(windows[1]!.show).toHaveBeenCalledTimes(2);
    capture.cancelScreenshotCapture();
    await expect(nextResult).resolves.toEqual({ status: 'cancelled' });
  });

  it('does not keep hidden capture windows alive on Linux X11', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    vi.stubEnv('XDG_SESSION_TYPE', 'x11');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(windows).toHaveLength(0);
    const result = capture.captureScreenshot();
    for (const win of windows) {
      win.emit('ready-to-show');
      await ready(win);
    }
    expect(windows).toHaveLength(2);
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(windows.every((win) => win.destroyed)).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(windows).toHaveLength(2);
    screen.emit('display-metrics-changed', {}, displays[0], ['bounds']);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(windows).toHaveLength(2);
  });

  it('ignores work-area changes but cancels when display geometry really changes', async () => {
    const result = capture.captureScreenshot();
    screen.emit('display-metrics-changed', {}, displays[0], ['workArea']);
    expect(windows.every((win) => !win.destroyed)).toBe(true);
    screen.emit('display-metrics-changed', {}, displays[0], ['scaleFactor']);
    await expect(result).resolves.toEqual({ status: 'cancelled' });
    expect(windows.every((win) => win.destroyed)).toBe(true);
  });

  it('reports initialization failures as errors and recreates the failed windows on retry', async () => {
    const result = capture.captureScreenshot();
    const first = windows[0]!;
    await ready(first);
    ipc.emit(IPC.shotFailed, { sender: first.webContents }, captureId(first), 'frame-decode');
    await expect(result).resolves.toEqual({ status: 'error', reason: 'frame-decode', captureId: expect.any(String) });
    expect(windows.every((win) => win.destroyed)).toBe(true);
    const nextResult = capture.captureScreenshot();
    expect(windows).toHaveLength(4);
    capture.cancelScreenshotCapture();
    await expect(nextResult).resolves.toEqual({ status: 'cancelled' });
  });

  it.each(['did-fail-load', 'render-process-gone'])('replaces a window that fails during warmup (%s)', async (event) => {
    await vi.advanceTimersByTimeAsync(1_500);
    const first = windows[0]!;
    first.webContents.emit(event);
    expect(first.destroyed).toBe(true);
    const result = capture.captureScreenshot();
    expect(windows).toHaveLength(3);
    for (const win of windows.filter((win) => !win.destroyed)) {
      win.emit('ready-to-show');
      await ready(win);
    }
    expect(windows[1]!.show).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('destroys a crashed capture without sending cleanup messages to its renderer', async () => {
    const result = capture.captureScreenshot();
    const first = windows[0]!;
    await ready(first);
    first.webContents.send.mockImplementation(() => { throw new Error('Render frame was disposed'); });
    first.webContents.emit('render-process-gone');
    await expect(result).resolves.toEqual({ status: 'error', reason: 'overlay-renderer-gone', captureId: expect.any(String) });
    expect(windows.every((win) => win.destroyed)).toBe(true);
  });

  it('seeds the cursor screen, follows pointer focus and clears other previews without clearing annotations', async () => {
    const result = capture.captureScreenshot();
    const [first, second] = windows as [OverlayWindow, OverlayWindow];
    await ready(first);
    await ready(second);
    expect(first.webContents.send).toHaveBeenCalledWith(IPC.shotSetContext, expect.objectContaining({ pointer: null }));
    expect(second.webContents.send).toHaveBeenCalledWith(IPC.shotSetContext, expect.objectContaining({ pointer: { x: 80, y: 50 } }));
    const token = captureId(first);
    first.webContents.send.mockClear();
    second.webContents.send.mockClear();
    first.focus.mockClear();
    second.focus.mockClear();
    ipc.emit(IPC.shotPointerEnter, { sender: first.webContents }, token);
    expect(second.webContents.send).toHaveBeenCalledWith(IPC.shotPointerLeave, expect.any(String));
    expect(second.webContents.send).not.toHaveBeenCalledWith(IPC.shotClearSelection, expect.anything());
    expect(first.webContents.send).not.toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalledOnce();
    expect(second.focus).not.toHaveBeenCalled();
    second.webContents.send.mockClear();
    ipc.emit(IPC.shotPointerEnter, { sender: first.webContents }, 'old-capture');
    expect(second.webContents.send).not.toHaveBeenCalled();
    expect(first.focus).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('locks previews to the selected screen and only lets its owner release them', async () => {
    const result = capture.captureScreenshot();
    const [first, second] = windows as [OverlayWindow, OverlayWindow];
    await ready(first);
    await ready(second);
    const token = captureId(first);
    first.webContents.send.mockClear();
    second.webContents.send.mockClear();
    ipc.emit(IPC.shotBandStart, { sender: first.webContents }, token);
    expect(second.webContents.send).toHaveBeenCalledWith(IPC.shotClearSelection, token);
    second.webContents.send.mockClear();
    ipc.emit(IPC.shotPointerEnter, { sender: second.webContents }, token);
    ipc.emit(IPC.shotBandEnd, { sender: second.webContents }, token);
    ipc.emit(IPC.shotBandEnd, { sender: first.webContents }, 'old-capture');
    expect(first.webContents.send).not.toHaveBeenCalled();
    expect(second.webContents.send).not.toHaveBeenCalled();
    ipc.emit(IPC.shotBandStart, { sender: second.webContents }, token);
    expect(first.webContents.send).toHaveBeenCalledWith(IPC.shotClearSelection, token);
    first.webContents.send.mockClear();
    ipc.emit(IPC.shotBandEnd, { sender: first.webContents }, token);
    expect(first.webContents.send).not.toHaveBeenCalled();
    expect(second.webContents.send).not.toHaveBeenCalled();
    ipc.emit(IPC.shotBandEnd, { sender: second.webContents }, token);
    expect(first.webContents.send).toHaveBeenCalledWith(IPC.shotPreviewEnabled, token);
    expect(second.webContents.send).toHaveBeenCalledWith(IPC.shotPreviewEnabled, token);
    first.webContents.send.mockClear();
    ipc.emit(IPC.shotPointerEnter, { sender: second.webContents }, token);
    expect(first.webContents.send).toHaveBeenCalledWith(IPC.shotPointerLeave, token);
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });

  it('recovers on the next capture when native window setup fails during warmup', async () => {
    configureScreenshotOverlay.mockImplementationOnce(() => { throw new Error('Native module unavailable'); });
    await vi.advanceTimersByTimeAsync(1_500);
    expect(windows).toHaveLength(1);
    expect(windows[0]!.destroyed).toBe(true);
    const result = capture.captureScreenshot();
    expect(windows).toHaveLength(3);
    for (const win of windows.filter((win) => !win.destroyed)) {
      win.emit('ready-to-show');
      await ready(win);
    }
    expect(windows[2]!.show).toHaveBeenCalledOnce();
    capture.cancelScreenshotCapture();
    await expect(result).resolves.toEqual({ status: 'cancelled' });
  });
});
