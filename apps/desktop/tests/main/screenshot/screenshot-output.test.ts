import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../../src/main/ipc/ipc-channels';

const windows: PinWindow[] = [];
const ipcMain = new EventEmitter();
const popup = vi.fn();
const buildFromTemplate = vi.fn().mockReturnValue({ popup });
const configurePinnedScreenshot = vi.fn();
const write = vi.fn(async (_items: Electron.ClipboardItem[]) => {});
const ClipboardItem = vi.fn();
const createFromBuffer = vi.fn();
const warn = vi.fn();
let autoReady = true;

class PinWindow extends EventEmitter {
  readonly webContents = Object.assign(new EventEmitter(), {
    id: windows.length + 1, isDestroyed: () => this.destroyed, capturePage: vi.fn().mockResolvedValue({ isEmpty: () => false }), setZoomFactor: vi.fn(), setWindowOpenHandler: vi.fn(),
  });
  readonly setAlwaysOnTop = vi.fn();
  readonly setVisibleOnAllWorkspaces = vi.fn();
  readonly show = vi.fn();
  readonly showInactive = vi.fn();
  readonly moveTop = vi.fn();
  readonly setAspectRatio = vi.fn();
  readonly loadURL = vi.fn(async (_url: string) => {
    if (autoReady) ipcMain.emit(IPC.shotPinReady, { sender: this.webContents }, true);
  });
  readonly getBounds = vi.fn(() => ({ x: 100, y: 200, width: 720, height: 360 }));
  readonly setPosition = vi.fn();
  readonly setSize = vi.fn();
  readonly getPosition = vi.fn(() => [this.options.x!, this.options.y!]);
  readonly setBounds = vi.fn((bounds: Electron.Rectangle) => {
    this.getPosition.mockReturnValue([bounds.x, bounds.y]);
  });
  readonly getOpacity = vi.fn(() => 1);
  destroyed = false;
  readonly isDestroyed = () => this.destroyed;
  readonly close = vi.fn(() => {
    this.destroyed = true;
    this.emit('closed');
  });
  readonly destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit('closed');
  });

  constructor(readonly options: Electron.BrowserWindowConstructorOptions) {
    super();
    windows.push(this);
  }
}

beforeEach(() => {
  vi.resetModules();
  windows.length = 0;
  ipcMain.removeAllListeners();
  vi.clearAllMocks();
  configurePinnedScreenshot.mockReset();
  autoReady = true;
  vi.doMock('../../../src/main/screenshot/screenshot-native', () => ({ configurePinnedScreenshot }));
  vi.doMock('../../../src/main/diagnostics/log', () => ({ log: { info: vi.fn(), warn, error: vi.fn() } }));
  vi.doMock('electron', () => ({
    app: { isPackaged: true }, BrowserWindow: PinWindow,
    Menu: { buildFromTemplate }, ClipboardItem, clipboard: { write }, dialog: {}, ipcMain, nativeImage: { createFromBuffer },
    screen: {
      getCursorScreenPoint: () => ({ x: 200, y: 200 }),
      getDisplayNearestPoint: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
      getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1440, height: 900 } }),
    },
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.doUnmock('electron');
  vi.doUnmock('../../src/main/screenshot-native');
  vi.doUnmock('../../src/main/log');
});

describe('pinned screenshots', () => {
  it.runIf(process.platform === 'win32')('waits briefly for the Windows compositor to accept a first frame', async () => {
    vi.useFakeTimers();
    autoReady = false;
    const { createPinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    const pending = createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh');
    const win = windows[0]!;
    win.webContents.capturePage.mockRejectedValueOnce(new Error('UnknownVizError'));
    ipcMain.emit(IPC.shotPinReady, { sender: win.webContents }, true);
    await vi.advanceTimersByTimeAsync(25);
    await expect(pending).resolves.toBe(win);
    expect(win.webContents.capturePage).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows a decoded and painted image without waiting for ready-to-show', async () => {
    autoReady = false;
    const { createPinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    const pending = createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh');
    const win = windows[0]!;
    win.emit('ready-to-show');
    ipcMain.emit(IPC.shotPinReady, { sender: { id: 999 } }, true);
    expect(win.showInactive).not.toHaveBeenCalled();
    let painted!: (value: { isEmpty: () => boolean }) => void;
    win.webContents.capturePage.mockReturnValueOnce(new Promise((resolve) => { painted = resolve; }));
    ipcMain.emit(IPC.shotPinReady, { sender: win.webContents }, true);
    expect(win.showInactive).not.toHaveBeenCalled();
    painted({ isEmpty: () => false });
    await expect(pending).resolves.toBe(win);
    expect(win.showInactive).toHaveBeenCalledOnce();
    expect(win.moveTop).toHaveBeenCalledOnce();
    expect(ipcMain.listenerCount(IPC.shotPinReady)).toBe(0);
  });

  it.each(['image', 'closed', 'renderer', 'timeout', 'empty-frame', 'cancelled'])('releases an unshown pin after %s failure', async (failure) => {
    vi.useFakeTimers();
    autoReady = false;
    const { createPinnedScreenshot, pinnedScreenshotBuffer } = await import('../../../src/main/screenshot/screenshot-output');
    const controller = new AbortController();
    const pending = createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh', controller.signal);
    const rejected = expect(pending).rejects.toBeInstanceOf(Error);
    const win = windows[0]!;
    const src = new URL(win.loadURL.mock.calls[0]![0] as string).searchParams.get('src')!;
    const token = new URL(src).pathname.slice(1, -4);
    if (failure === 'image') ipcMain.emit(IPC.shotPinReady, { sender: win.webContents }, false);
    else if (failure === 'renderer') win.webContents.emit('render-process-gone');
    else if (failure === 'closed') win.close();
    else if (failure === 'cancelled') controller.abort();
    else if (failure === 'empty-frame') {
      win.webContents.capturePage.mockResolvedValueOnce({ isEmpty: () => true });
      ipcMain.emit(IPC.shotPinReady, { sender: win.webContents }, true);
    } else await vi.advanceTimersByTimeAsync(10_000);
    await rejected;
    expect(win.isDestroyed()).toBe(true);
    expect(win.showInactive).not.toHaveBeenCalled();
    expect(pinnedScreenshotBuffer(token)).toBeUndefined();
    expect(ipcMain.listenerCount(IPC.shotPinReady)).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([[8, 8, 120, 120], [8, 32, 120, 480], [32, 8, 320, 80]])(
    'scales a %i by %i image uniformly on creation and wheel resize', async (width, height, expectedWidth, expectedHeight) => {
      const { createPinnedScreenshot, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
      initPinnedScreenshotIpc();
      const win = await createPinnedScreenshot(Buffer.from('image'), width, height, 'zh') as unknown as PinWindow;
      expect(win.options).toMatchObject({ width: expectedWidth, height: expectedHeight });
      ipcMain.emit(IPC.shotPinResize, { sender: win.webContents }, -0.5);
      const { width: newWidth, height: newHeight } = win.setBounds.mock.calls[0]![0] as Electron.Rectangle;
      expect(newWidth! / newHeight!).toBeCloseTo(width / height, 2);
    },
  );

  it.each(['zh', 'en'] as const)('passes the %s locale to the pinned image page', async (locale) => {
    const { createPinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    const win = await createPinnedScreenshot(Buffer.from('image'), 800, 400, locale) as unknown as PinWindow;
    expect(new URL(win.loadURL.mock.calls[0]![0] as string).searchParams.get('locale')).toBe(locale);
  });

  it.each([[8000, 8], [8, 8000]])('can shrink an extreme %i by %i image without forcing it to screen size', async (width, height) => {
    const { createPinnedScreenshot, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
    initPinnedScreenshotIpc();
    const win = await createPinnedScreenshot(Buffer.from('image'), width, height, 'en') as unknown as PinWindow;
    const bounds = { x: 0, y: 0, width: win.options.width!, height: win.options.height! };
    ipcMain.emit(IPC.shotPinResize, { sender: win.webContents }, -0.5);
    const { width: nextWidth, height: nextHeight } = win.setBounds.mock.calls[0]![0] as Electron.Rectangle;
    expect(Math.min(nextWidth! / width, nextHeight! / height)).toBeLessThan(Math.min(bounds.width / width, bounds.height / height));
  });

  it('opens an unrounded native window and releases its image when closed', async () => {
    const { createPinnedScreenshot, pinnedScreenshotBuffer, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
    initPinnedScreenshotIpc();
    const png = Buffer.from('test-image');
    const win = await createPinnedScreenshot(png, 800, 400, 'zh') as unknown as PinWindow;
    expect(win.options).toMatchObject({ frame: false, roundedCorners: false, transparent: false, resizable: true, focusable: false, acceptFirstMouse: true, width: 720, height: 360 });
    if (process.platform === 'darwin') expect(win.options.type).toBe('panel');
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true, process.platform === 'win32' ? 'screen-saver' : 'floating');
    if (process.platform !== 'win32') expect(win.setAspectRatio).toHaveBeenCalledWith(2);
    else expect(win.setAspectRatio).not.toHaveBeenCalled();
    expect(configurePinnedScreenshot).toHaveBeenCalledWith(win);
    expect(win.setVisibleOnAllWorkspaces).toHaveBeenCalledWith(true, { visibleOnFullScreen: true, skipTransformProcessType: true });
    expect(win.webContents.capturePage).toHaveBeenCalledWith(undefined, { stayHidden: false, stayAwake: true });
    win.emit('ready-to-show');
    expect(win.showInactive).toHaveBeenCalledOnce();
    expect(win.show).not.toHaveBeenCalled();
    const params = new URL(win.loadURL.mock.calls[0]![0] as string).searchParams;
    expect(params.get('locale')).toBe('zh');
    const src = params.get('src')!;
    const token = new URL(src).pathname.slice(1, -4);
    expect(pinnedScreenshotBuffer(token)).toEqual(png);
    ipcMain.emit(IPC.shotPinClose, { sender: win.webContents });
    expect(win.close).toHaveBeenCalledOnce();
    expect(win.isDestroyed()).toBe(true);
    expect(pinnedScreenshotBuffer(token)).toBeUndefined();
    ipcMain.emit(IPC.shotPinClose, { sender: win.webContents });
    expect(win.close).toHaveBeenCalledOnce();
  });

  it('destroys the unshown window if native nonactivating setup fails', async () => {
    configurePinnedScreenshot.mockImplementationOnce(() => { throw new Error('nonactivating-pin-unsupported'); });
    const { createPinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    await expect(createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh')).rejects.toThrow('nonactivating-pin-unsupported');
    expect(windows[0]!.destroy).toHaveBeenCalledOnce();
    expect(windows[0]!.showInactive).not.toHaveBeenCalled();
    expect(windows[0]!.loadURL).not.toHaveBeenCalled();
  });

  it('moves and resizes only the sending pin, rejecting invalid input and closed windows', async () => {
    const { createPinnedScreenshot, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
    initPinnedScreenshotIpc();
    const first = await createPinnedScreenshot(Buffer.from('first'), 800, 400, 'zh') as unknown as PinWindow;
    const second = await createPinnedScreenshot(Buffer.from('second'), 800, 400, 'zh') as unknown as PinWindow;
    ipcMain.emit(IPC.shotPinMove, { sender: first.webContents }, 20, -30);
    expect(first.setBounds).toHaveBeenCalledWith({ x: 380, y: 240, width: 720, height: 360 });
    expect(second.setBounds).not.toHaveBeenCalled();
    for (const [x, y] of [[NaN, 0], [0, Infinity], ['1', 1]]) {
      ipcMain.emit(IPC.shotPinMove, { sender: first.webContents }, x, y);
    }
    ipcMain.emit(IPC.shotPinMove, { sender: { id: 999 } }, 1, 2);
    expect(first.setBounds).toHaveBeenCalledOnce();
    ipcMain.emit(IPC.shotPinResize, { sender: second.webContents }, 0.1);
    expect(second.setBounds).toHaveBeenCalledWith({ x: 360, y: 270, width: 792, height: 396 });
    expect(first.setSize).not.toHaveBeenCalled();
    first.close();
    ipcMain.emit(IPC.shotPinMove, { sender: first.webContents }, 1, 2);
    ipcMain.emit(IPC.shotPinResize, { sender: first.webContents }, 0.1);
    expect(first.setBounds).toHaveBeenCalledOnce();
    expect(first.setSize).not.toHaveBeenCalled();
  });

  it('keeps repeated moves independent of native resize notifications and rounded bounds', async () => {
    vi.stubGlobal('process', { ...process, platform: 'win32' });
    const { createPinnedScreenshot, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
    initPinnedScreenshotIpc();
    const win = await createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh') as unknown as PinWindow;
    win.setBounds.mockImplementation((bounds) => { win.getPosition.mockReturnValue([bounds.x, bounds.y]); win.emit('resize'); win.emit('move'); });
    win.getBounds.mockReturnValue({ x: 360, y: 270, width: 736, height: 368 });
    for (let i = 0; i < 1000; i++) ipcMain.emit(IPC.shotPinMove, { sender: win.webContents }, 1, -0.6);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 1360, y: -730, width: 720, height: 360 });
    expect(win.getBounds).not.toHaveBeenCalled();
    ipcMain.emit(IPC.shotPinResize, { sender: win.webContents }, 0.1);
    ipcMain.emit(IPC.shotPinMove, { sender: win.webContents }, -1000, 1000);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 360, y: 270, width: 792, height: 396 });
    ipcMain.emit(IPC.shotPinResizeEdge, { sender: win.webContents }, 'bottom-right', 8, 4);
    ipcMain.emit(IPC.shotPinMove, { sender: win.webContents }, 1, 1);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 361, y: 271, width: 800, height: 400 });
  });

  it('normalizes negative zero at screen edges and preserves negative monitor coordinates', async () => {
    const { createPinnedScreenshot, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
    initPinnedScreenshotIpc();
    const win = await createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh') as unknown as PinWindow;
    ipcMain.emit(IPC.shotPinMove, { sender: win.webContents }, -360.25, -270.25);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 720, height: 360 });
    ipcMain.emit(IPC.shotPinResize, { sender: win.webContents }, 0.1);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 792, height: 396 });
    ipcMain.emit(IPC.shotPinMove, { sender: win.webContents }, -100.5, -200.5);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: -100, y: -200, width: 792, height: 396 });
  });

  it('tracks Linux native geometry without waiting for unsupported completion events', async () => {
    vi.stubGlobal('process', { ...process, platform: 'linux' });
    const { createPinnedScreenshot, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
    initPinnedScreenshotIpc();
    const win = await createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh') as unknown as PinWindow;
    win.getBounds.mockReturnValue({ x: 40, y: 50, width: 400, height: 200 });
    win.getPosition.mockReturnValue([40, 50]);
    win.emit('resize');
    ipcMain.emit(IPC.shotPinMove, { sender: win.webContents }, 10, 20);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 50, y: 70, width: 400, height: 200 });
    win.getPosition.mockReturnValue([-800, 100]);
    win.emit('move');
    ipcMain.emit(IPC.shotPinResize, { sender: win.webContents }, 0.1);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: -800, y: 100, width: 440, height: 220 });
  });

  it.each(['win32', 'darwin', 'linux'])('preserves native aspect ratio outside Windows on %s', async (platform) => {
    vi.stubGlobal('process', { ...process, platform });
    const { createPinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    const win = await createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh') as unknown as PinWindow;
    if (platform === 'win32') expect(win.setAspectRatio).not.toHaveBeenCalled();
    else expect(win.setAspectRatio).toHaveBeenCalledExactlyOnceWith(2);
  });

  it.each(['win32', 'darwin'])('uses the system-relocated position for all interactions on %s', async (platform) => {
    vi.stubGlobal('process', { ...process, platform });
    const { createPinnedScreenshot, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
    initPinnedScreenshotIpc();
    const win = await createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh') as unknown as PinWindow;
    win.getPosition.mockReturnValue([20, 30]);
    win.emit('move');
    ipcMain.emit(IPC.shotPinResize, { sender: win.webContents }, 0.1);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 20, y: 30, width: 792, height: 396 });
    win.getPosition.mockReturnValue([40, 50]);
    win.emit('move');
    ipcMain.emit(IPC.shotPinResizeEdge, { sender: win.webContents }, 'bottom-right', 8, 4);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: 40, y: 50, width: 800, height: 400 });
    win.getPosition.mockReturnValue([-800, 100]);
    win.emit('move');
    ipcMain.emit(IPC.shotPinMove, { sender: win.webContents }, 10, 20);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: -790, y: 120, width: 800, height: 400 });
    expect(win.getBounds).not.toHaveBeenCalled();
  });

  it('uses completed native resizing and native moves for the next interaction', async () => {
    const { createPinnedScreenshot, initPinnedScreenshotIpc } = await import('../../../src/main/screenshot/screenshot-output');
    initPinnedScreenshotIpc();
    const win = await createPinnedScreenshot(Buffer.from('image'), 800, 400, 'zh') as unknown as PinWindow;
    win.getBounds.mockReturnValue({ x: 0, y: 0, width: 400, height: 200 });
    win.emit('resized');
    win.getPosition.mockReturnValue([-800, 100]);
    ipcMain.emit(IPC.shotPinMove, { sender: win.webContents }, 20, -30);
    expect(win.setBounds).toHaveBeenLastCalledWith({ x: -780, y: 70, width: 400, height: 200 });
  });

  it('keeps a native right-click close action scoped to its pin', async () => {
    const { createPinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    const first = await createPinnedScreenshot(Buffer.from('first'), 800, 400, 'zh') as unknown as PinWindow;
    const second = await createPinnedScreenshot(Buffer.from('second'), 800, 400, 'zh') as unknown as PinWindow;
    first.webContents.emit('context-menu');
    expect(popup).toHaveBeenCalledWith({ window: first });
    const items = buildFromTemplate.mock.calls[0]![0] as Electron.MenuItemConstructorOptions[];
    const close = items.find((item) => item.label === '关闭')!;
    expect(close).toBeDefined();
    (close.click as () => void)();
    expect(first.close).toHaveBeenCalledOnce();
    expect(second.close).not.toHaveBeenCalled();
  });
});

describe('screenshot clipboard', () => {
  async function clipboardPng(call = 0): Promise<{ type: string; text: string }> {
    const blob = (ClipboardItem.mock.calls[call]![0] as Record<string, Blob>)['image/png']!;
    return { type: blob.type, text: Buffer.from(await blob.arrayBuffer()).toString() };
  }

  it('writes the PNG bytes as they are without decoding or re-encoding them', async () => {
    const { copyScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    await copyScreenshot(Buffer.from('png'));
    expect(ClipboardItem).toHaveBeenCalledExactlyOnceWith({ 'image/png': expect.any(Blob) });
    await expect(clipboardPng()).resolves.toEqual({ type: 'image/png', text: 'png' });
    expect(write).toHaveBeenCalledOnce();
    expect(write.mock.calls[0]![0]).toHaveLength(1);
    expect(createFromBuffer).not.toHaveBeenCalled();
  });

  it('rejects empty PNG bytes without touching the clipboard', async () => {
    const { copyScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    await expect(copyScreenshot(new Uint8Array())).rejects.toThrow('invalid-png');
    expect(ClipboardItem).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
  });

  it('copies a pinned screenshot from the pin menu without decoding it', async () => {
    const { createPinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    const pin = await createPinnedScreenshot(Buffer.from('pinned'), 800, 400, 'zh') as unknown as PinWindow;
    pin.webContents.emit('context-menu');
    const items = buildFromTemplate.mock.calls[0]![0] as Electron.MenuItemConstructorOptions[];
    (items.find((item) => item.label === '复制')!.click as () => void)();
    await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
    await expect(clipboardPng()).resolves.toEqual({ type: 'image/png', text: 'pinned' });
    expect(createFromBuffer).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it('logs a pin menu copy that the clipboard rejects', async () => {
    write.mockRejectedValueOnce(new Error('pasteboard unavailable'));
    const { createPinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-output');
    const pin = await createPinnedScreenshot(Buffer.from('pinned'), 800, 400, 'en') as unknown as PinWindow;
    pin.webContents.emit('context-menu');
    const items = buildFromTemplate.mock.calls[0]![0] as Electron.MenuItemConstructorOptions[];
    (items.find((item) => item.label === 'Copy')!.click as () => void)();
    await vi.waitFor(() => expect(warn).toHaveBeenCalledExactlyOnceWith('[screenshot] pin clipboard write failed: pasteboard unavailable'));
  });
});
