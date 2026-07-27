import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import { isAppRendererUrl, looksMaximizedBounds, shouldHideOnClose, shouldPersistBounds, vibrancyWindowOptions } from '../../src/main/window';

const mocks = vi.hoisted(() => ({
  trackDesktopEvent: vi.fn(),
  connect: vi.fn(),
  installDownloadHandler: vi.fn(),
  installExternalLinkGuard: vi.fn(),
  isVibrancyEnabled: vi.fn(() => true),
  logInfo: vi.fn(),
  // Every constructed BrowserWindow (createWindow pushes here).
  windows: [] as unknown[],
}));

// Lifecycle telemetry fires from showMainWindow and the close/closed handlers;
// mock Electron + the neighboring main modules so createWindow can run in the
// node test environment.
vi.mock('electron', () => {
  class FakeBrowserWindow {
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    webContents = {
      on: vi.fn(),
      send: vi.fn(),
      session: {},
      openDevTools: vi.fn(),
      isDevToolsOpened: () => false,
      closeDevTools: vi.fn(),
    };
    show = vi.fn();
    hide = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    setFullScreen = vi.fn();
    setVibrancy = vi.fn();
    setBackgroundColor = vi.fn();
    setWindowButtonPosition = vi.fn();
    setWindowButtonVisibility = vi.fn();
    constructor() {
      mocks.windows.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      return this;
    }
    once(event: string, cb: (...args: unknown[]) => void): this {
      return this.on(event, cb);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    isDestroyed(): boolean {
      return false;
    }
    isMinimized(): boolean {
      return false;
    }
    isMaximized(): boolean {
      return false;
    }
    isFullScreen(): boolean {
      return false;
    }
    getBounds(): { width: number; height: number; x: number; y: number } {
      return { width: 1280, height: 860, x: 10, y: 10 };
    }
    getNormalBounds(): { width: number; height: number; x: number; y: number } {
      return this.getBounds();
    }
  }
  return {
    app: {
      isPackaged: true,
      getPath: () => '/tmp/kimi-window-test',
      on: vi.fn(),
    },
    BrowserWindow: FakeBrowserWindow,
    dialog: { showSaveDialogSync: vi.fn(), showErrorBox: vi.fn() },
    screen: { getPrimaryDisplay: () => ({ workArea: { width: 1512, height: 944 } }) },
    shell: { openExternal: vi.fn() },
  };
});
vi.mock('../../src/main/connect', () => ({ connect: mocks.connect }));
vi.mock('../../src/main/downloads', () => ({ installDownloadHandler: mocks.installDownloadHandler }));
vi.mock('../../src/main/external-links', () => ({ installExternalLinkGuard: mocks.installExternalLinkGuard }));
vi.mock('../../src/main/log', () => ({ log: { info: mocks.logInfo }, redactUrlForLog: (url: string) => url }));
vi.mock('../../src/main/ui-state', () => ({ isVibrancyEnabled: mocks.isVibrancyEnabled }));
vi.mock('../../src/main/track', () => ({ trackDesktopEvent: mocks.trackDesktopEvent }));

describe('isAppRendererUrl', () => {
  it('accepts the packaged renderer protocol and the dev-server http URL', () => {
    expect(isAppRendererUrl('app://renderer/index.html')).toBe(true);
    expect(isAppRendererUrl('app://renderer/sessions/session_abc')).toBe(true);
    expect(isAppRendererUrl('http://127.0.0.1:5174/')).toBe(true);
    expect(isAppRendererUrl('https://127.0.0.1:5174/')).toBe(true);
  });

  it('rejects pages without a tray-select subscription (error page, blank)', () => {
    expect(isAppRendererUrl('data:text/html;charset=utf-8,%3C!doctype%20html%3E')).toBe(false);
    expect(isAppRendererUrl('about:blank')).toBe(false);
    expect(isAppRendererUrl('')).toBe(false);
  });
});

describe('shouldHideOnClose', () => {
  it('hides instead of destroying on macOS (tray-resident model)', () => {
    expect(shouldHideOnClose('darwin', false)).toBe(true);
  });

  it('lets real quits destroy the window', () => {
    expect(shouldHideOnClose('darwin', true)).toBe(false);
  });

  it('keeps destroy-on-close on other platforms', () => {
    expect(shouldHideOnClose('win32', false)).toBe(false);
    expect(shouldHideOnClose('linux', false)).toBe(false);
  });
});

describe('shouldPersistBounds', () => {
  it('persists normal window bounds', () => {
    expect(shouldPersistBounds(false, false)).toBe(true);
  });

  it('never persists a maximized or full-screen size (would restore as a fake full screen)', () => {
    expect(shouldPersistBounds(true, false)).toBe(false);
    expect(shouldPersistBounds(false, true)).toBe(false);
    expect(shouldPersistBounds(true, true)).toBe(false);
  });
});

describe('looksMaximizedBounds', () => {
  it('flags bounds that (nearly) fill the display work area', () => {
    const workArea = { width: 1512, height: 944 };
    expect(looksMaximizedBounds({ width: 1512, height: 944 }, workArea)).toBe(true);
    expect(looksMaximizedBounds({ width: 1450, height: 900 }, workArea)).toBe(true);
  });

  it('passes normal window bounds', () => {
    const workArea = { width: 1512, height: 944 };
    expect(looksMaximizedBounds({ width: 1280, height: 860 }, workArea)).toBe(false);
    expect(looksMaximizedBounds({ width: 900, height: 600 }, workArea)).toBe(false);
  });
});

describe('vibrancyWindowOptions', () => {
  it('always passes the pinned flat material + transparent flash on macOS (an opt-out launch removes it right after creation)', () => {
    expect(vibrancyWindowOptions('darwin')).toEqual({
      vibrancy: 'menu',
      visualEffectState: 'inactive',
      backgroundColor: '#00000000',
    });
  });

  it('passes no vibrancy options off macOS', () => {
    expect(vibrancyWindowOptions('win32')).toEqual({ backgroundColor: '#0b0b0c' });
    expect(vibrancyWindowOptions('linux')).toEqual({ backgroundColor: '#0b0b0c' });
  });
});

describe('window lifecycle telemetry', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.windows.length = 0;
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
  });

  interface FakeWindowHandle {
    emit(event: string, ...args: unknown[]): void;
    show: ReturnType<typeof vi.fn>;
    hide: ReturnType<typeof vi.fn>;
  }

  function lastWindow(): FakeWindowHandle {
    const win = mocks.windows.at(-1) as FakeWindowHandle | undefined;
    expect(win, 'a BrowserWindow was created').toBeDefined();
    return win as FakeWindowHandle;
  }

  it("tracks 'shown' on showMainWindow — recreate and re-show alike", async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow(); // no live window → createWindow
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', { action: 'shown' });
    showMainWindow(); // live window → show/focus
    expect(lastWindow().show).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledTimes(2);
  });

  it("tracks 'hidden' on the macOS hide-on-close path", async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow();
    const win = lastWindow();
    mocks.trackDesktopEvent.mockClear();
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.hide).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', { action: 'hidden' });
  });

  it("tracks 'closed' on real window destruction", async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow();
    mocks.trackDesktopEvent.mockClear();
    lastWindow().emit('closed');
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', { action: 'closed' });
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('window_lifecycle', { action: 'hidden' });
  });
});
