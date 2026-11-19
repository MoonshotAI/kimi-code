import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { BrowserWindow } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  requireNative: vi.fn(),
  configure: vi.fn(),
  configurePin: vi.fn(),
  capture: vi.fn(),
  app: { isPackaged: false, getAppPath: () => '/desktop' },
}));
vi.mock('node:child_process', () => ({ execFile: mocks.execFile }));
vi.mock('node:module', () => ({ createRequire: () => mocks.requireNative }));
vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { info: vi.fn() } }));

const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
const resourcesPath = Object.getOwnPropertyDescriptor(process, 'resourcesPath');
let finish: (error: Error | null, stdout: string) => void;
let kill: ReturnType<typeof vi.fn>;

function overlay(bytes: number, handle: bigint): BrowserWindow {
  const buffer = Buffer.alloc(bytes);
  if (bytes === 8) buffer.writeBigUInt64LE(handle);
  else buffer.writeUInt32LE(Number(handle));
  return Object.assign(new EventEmitter(), { getNativeWindowHandle: () => buffer }) as BrowserWindow;
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  Object.defineProperty(process, 'platform', { value: 'win32' });
  Object.defineProperty(process, 'resourcesPath', { configurable: true, value: '/packed' });
  mocks.app.isPackaged = false;
  kill = vi.fn();
  mocks.execFile.mockImplementation((_file, _args, _options, callback) => {
    finish = callback;
    return { kill };
  });
  mocks.requireNative.mockReturnValue({ configure: mocks.configure, configurePin: mocks.configurePin, capture: mocks.capture });
});

afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  if (resourcesPath) Object.defineProperty(process, 'resourcesPath', resourcesPath);
  else Reflect.deleteProperty(process, 'resourcesPath');
});

describe('native screenshot overlay setup', () => {
  it('configures pin activation separately from screenshot overlays on macOS', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const { configurePinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-native');
    const window = overlay(8, 456n);
    configurePinnedScreenshot(window);
    expect(mocks.configurePin).toHaveBeenCalledWith(window.getNativeWindowHandle());
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each(['win32', 'linux'])('does not load macOS pin behavior on %s', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform });
    const { configurePinnedScreenshot } = await import('../../../src/main/screenshot/screenshot-native');
    const window = overlay(8, 456n);
    configurePinnedScreenshot(window);
    expect(mocks.requireNative).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it.each([[4, 4294967294n], [8, 9007199254740993n]])('configures a %i-byte HWND asynchronously without a console', async (bytes, hwnd) => {
    const { configureScreenshotOverlay } = await import('../../../src/main/screenshot/screenshot-native');
    const window = overlay(bytes, hwnd);
    const result = configureScreenshotOverlay(window);
    expect(result).toBeInstanceOf(Promise);
    expect(mocks.execFile).toHaveBeenCalledWith(
      join('/desktop', 'native', 'screenshot-window-list', 'dist', 'screenshot-window-list.exe'),
      ['configure', String(hwnd), String(process.pid)],
      { timeout: 2_000, windowsHide: true },
      expect.any(Function),
    );
    expect(window.listenerCount('closed')).toBe(1);
    finish(null, '{"ok":true}');
    await expect(result).resolves.toBe(String(hwnd));
    expect(window.listenerCount('closed')).toBe(0);
    window.emit('closed');
    expect(kill).not.toHaveBeenCalled();
  });

  it('loads the packaged helper from resources', async () => {
    mocks.app.isPackaged = true;
    const { configureScreenshotOverlay } = await import('../../../src/main/screenshot/screenshot-native');
    const result = configureScreenshotOverlay(overlay(8, 123n));
    expect(mocks.execFile.mock.calls[0]![0]).toBe(join('/packed', 'screenshot-window-list', 'screenshot-window-list.exe'));
    finish(null, '{}');
    await result;
  });

  it('surfaces helper failure and removes its close listener', async () => {
    const { configureScreenshotOverlay } = await import('../../../src/main/screenshot/screenshot-native');
    const window = overlay(8, 123n);
    const result = configureScreenshotOverlay(window);
    finish(new Error('taskbar-fullscreen-failed'), '');
    await expect(result).rejects.toThrow('taskbar-fullscreen-failed');
    expect(window.listenerCount('closed')).toBe(0);
  });

  it('stops pending setup when its native window is destroyed', async () => {
    const { configureScreenshotOverlay } = await import('../../../src/main/screenshot/screenshot-native');
    const window = overlay(8, 123n);
    const result = configureScreenshotOverlay(window);
    window.emit('closed');
    expect(kill).toHaveBeenCalledOnce();
    finish(new Error('killed'), '');
    await expect(result).rejects.toThrow('killed');
    expect(window.listenerCount('closed')).toBe(0);
  });

  it('keeps macOS configuration synchronous and captures all shadows', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    mocks.configure.mockReturnValue('456');
    const frames = [{ displayId: '1', png: Buffer.from('png'), width: 200, height: 100 }];
    mocks.capture.mockResolvedValue(frames);
    const { configureScreenshotOverlay, captureNativeScreenshotFrames } = await import('../../../src/main/screenshot/screenshot-native');
    const window = overlay(8, 456n);
    expect(configureScreenshotOverlay(window)).toBe('456');
    expect(mocks.configure).toHaveBeenCalledWith(window.getNativeWindowHandle());
    await expect(captureNativeScreenshotFrames()).resolves.toBe(frames);
    expect(mocks.capture).toHaveBeenCalledWith(2);
    expect(mocks.requireNative.mock.calls.map(([file]) => file)).toEqual([
      join('/desktop', 'native', 'screenshot-window-list', 'dist', 'screenshot-overlay.node'),
      join('/desktop', 'native', 'screenshot-window-list', 'dist', 'screenshot-capture.node'),
    ]);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });

  it('does not load native overlay helpers on Linux', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const { configureScreenshotOverlay } = await import('../../../src/main/screenshot/screenshot-native');
    expect(configureScreenshotOverlay(overlay(8, 123n))).toBeUndefined();
    expect(mocks.requireNative).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
