import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  clampBoundsToWorkArea,
  drainLaunchActions,
  installWindowsSessionEndWatch,
  isAppRendererUrl,
  looksMaximizedBounds,
  shouldHideOnClose,
  shouldPersistBounds,
  titleBarWindowOptions,
  vibrancyWindowOptions,
  windowsAppDetails,
  windowsWindowOptions,
} from '../../src/main/window';

describe('titleBarWindowOptions', () => {
  it('uses Window Controls Overlay only on Windows', () => {
    expect(titleBarWindowOptions('win32', false)).toMatchObject({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#202020', height: 40 },
    });
    expect(titleBarWindowOptions('win32', true)).toMatchObject({
      titleBarOverlay: { symbolColor: '#f2f2f2' },
    });
    expect(titleBarWindowOptions('darwin')).toMatchObject({
      titleBarStyle: 'hidden',
      trafficLightPosition: { x: 16, y: 17 },
    });
    expect(titleBarWindowOptions('linux')).toEqual({ titleBarStyle: 'default' });
  });
});

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

// Mock Electron + the neighboring main modules so lifecycle telemetry can run
// through createWindow in the node test environment.
vi.mock('electron', () => {
  class FakeWebContents {
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    on(event: string, cb: (...args: unknown[]) => void): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    send = vi.fn();
    session = {};
    openDevTools = vi.fn();
    isDevToolsOpened(): boolean {
      return false;
    }
    closeDevTools = vi.fn();
    getURL(): string {
      return 'app://renderer/index.html';
    }
    getZoomFactor(): number {
      return 1;
    }
    getZoomLevel(): number {
      return 0;
    }
    executeJavaScript(): Promise<unknown> {
      return Promise.resolve(1);
    }
  }
  class FakeBrowserWindow {
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    webContents = new FakeWebContents();
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
    isVisible(): boolean {
      return true;
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
    nativeTheme: { shouldUseDarkColors: false },
    screen: { getPrimaryDisplay: () => ({ workArea: { width: 1512, height: 944 } }) },
    shell: { openExternal: vi.fn() },
  };
});
vi.mock('../../src/main/connect', () => ({ connect: mocks.connect }));
vi.mock('../../src/main/downloads', () => ({ installDownloadHandler: mocks.installDownloadHandler }));
vi.mock('../../src/main/external-links', () => ({ installExternalLinkGuard: mocks.installExternalLinkGuard }));
vi.mock('../../src/main/log', () => ({
  log: { info: mocks.logInfo, error: vi.fn(), warn: vi.fn() },
  redactUrlForLog: (url: string) => url,
}));
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
  it('hides instead of destroying on macOS and Windows (tray-resident model)', () => {
    expect(shouldHideOnClose('darwin', false)).toBe(true);
    expect(shouldHideOnClose('win32', false)).toBe(true);
  });

  it('lets real quits destroy the window', () => {
    expect(shouldHideOnClose('darwin', true)).toBe(false);
    expect(shouldHideOnClose('win32', true)).toBe(false);
  });

  it('keeps destroy-on-close on other platforms', () => {
    expect(shouldHideOnClose('linux', false)).toBe(false);
  });
});

describe('installWindowsSessionEndWatch', () => {
  it('marks only the final Windows session-end event as quitting', () => {
    const listeners = new Map<string, () => void>();
    const markEnding = vi.fn();
    installWindowsSessionEndWatch(
      'win32',
      { on: (event, listener) => listeners.set(event, listener) },
      markEnding,
    );

    expect(listeners.has('query-session-end')).toBe(false);
    listeners.get('session-end')?.();
    expect(markEnding).toHaveBeenCalledOnce();
  });

  it('does not install Windows session listeners on other platforms', () => {
    const on = vi.fn();
    installWindowsSessionEndWatch('darwin', { on }, vi.fn());
    expect(on).not.toHaveBeenCalled();
  });
});

describe('drainLaunchActions', () => {
  it('preserves every queued launch action in order and empties the queue', () => {
    const actions = [
      { action: 'new-chat' as const },
      { action: 'open-workspace' as const, root: 'C:\\workspace' },
    ];
    expect(drainLaunchActions(actions)).toEqual([
      { action: 'new-chat' },
      { action: 'open-workspace', root: 'C:\\workspace' },
    ]);
    expect(actions).toEqual([]);
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

describe('clampBoundsToWorkArea', () => {
  const workArea = { x: 0, y: 0, width: 1920, height: 1080 };

  it('leaves on-screen bounds untouched (same reference)', () => {
    const bounds = { width: 1280, height: 860, x: 100, y: 80 };
    expect(clampBoundsToWorkArea(bounds, workArea)).toBe(bounds);
  });

  it('leaves position-less bounds untouched', () => {
    const bounds = { width: 1280, height: 860 };
    expect(clampBoundsToWorkArea(bounds, workArea)).toBe(bounds);
  });

  it('pulls a fully off-screen window (unplugged monitor) back onto the work area', () => {
    const clamped = clampBoundsToWorkArea({ width: 1280, height: 860, x: 3000, y: 400 }, workArea);
    expect(clamped.x).toBe(1920 - 100);
    expect(clamped.y).toBe(400);
  });

  it('pulls a window parked left of the work area back (keeps 100px visible)', () => {
    const clamped = clampBoundsToWorkArea({ width: 1280, height: 860, x: -2000, y: 100 }, workArea);
    expect(clamped.x).toBe(-1280 + 100);
  });

  it('never lets the title bar go above the work area', () => {
    const clamped = clampBoundsToWorkArea({ width: 1280, height: 860, x: 200, y: -300 }, workArea);
    expect(clamped.y).toBe(0);
  });

  it('clamps a window sunk below the work area', () => {
    const clamped = clampBoundsToWorkArea({ width: 1280, height: 860, x: 200, y: 2000 }, workArea);
    expect(clamped.y).toBe(1080 - 100);
  });

  it('respects a non-zero work area origin (secondary display)', () => {
    const secondary = { x: -2560, y: 30, width: 2560, height: 1410 };
    const bounds = { width: 1280, height: 860, x: -2400, y: 100 };
    expect(clampBoundsToWorkArea(bounds, secondary)).toBe(bounds);
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

  it("tracks the initial 'shown' state once", async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow(); // no live window → createWindow
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', { action: 'shown' });
    mocks.trackDesktopEvent.mockClear();
    lastWindow().emit('show');
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
    showMainWindow(); // live window → show/focus
    expect(lastWindow().show).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
  });

  it("tracks 'hidden' only when Electron reports the window was hidden", async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow();
    const win = lastWindow();
    mocks.trackDesktopEvent.mockClear();
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.hide).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
    win.emit('hide');
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', {
      action: 'hidden',
      reason: 'close_to_tray',
      visible_duration_ms: expect.any(Number),
    });
  });

  it("tracks 'hidden' with reason 'deactivate' on minimize", async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow();
    const win = lastWindow();
    mocks.trackDesktopEvent.mockClear();
    win.emit('minimize');
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', {
      action: 'hidden',
      reason: 'deactivate',
      visible_duration_ms: expect.any(Number),
    });
  });

  it('keeps a plain hide reason-less', async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow();
    const win = lastWindow();
    mocks.trackDesktopEvent.mockClear();
    win.emit('hide');
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', {
      action: 'hidden',
      visible_duration_ms: expect.any(Number),
    });
  });

  it("tracks 'closed' on real window destruction", async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow();
    mocks.trackDesktopEvent.mockClear();
    lastWindow().emit('closed');
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', {
      action: 'closed',
      visible_duration_ms: expect.any(Number),
    });
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith(
      'window_lifecycle',
      expect.objectContaining({ action: 'hidden' }),
    );
  });

  it('reports each startup_timing phase once', async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow(); // createWindow: isVisible → window_shown
    const win = lastWindow() as unknown as { webContents: { emit(event: string, ...args: unknown[]): void } };

    const phases = (): string[] =>
      mocks.trackDesktopEvent.mock.calls
        .filter((call) => call[0] === 'startup_timing')
        .map((call) => (call[1] as { phase: string }).phase);
    expect(phases()).toEqual(['window_shown']);

    win.webContents.emit('did-finish-load');
    win.webContents.emit('did-finish-load');
    expect(phases()).toEqual(['window_shown', 'renderer_loaded', 'renderer_ready']);

    for (const call of mocks.trackDesktopEvent.mock.calls) {
      if (call[0] === 'startup_timing') {
        expect((call[1] as { duration_ms: number }).duration_ms).toEqual(expect.any(Number));
      }
    }
  });

  it('tracks renderer_crashed with the raw reason and exit code', async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow();
    const win = lastWindow() as unknown as { webContents: { emit(event: string, ...args: unknown[]): void } };
    mocks.trackDesktopEvent.mockClear();

    win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('renderer_crashed', {
      reason: 'crashed',
      exit_code: -1,
    });
  });

  it('folds memory-eviction into oom and skips clean-exit teardowns', async () => {
    const { showMainWindow } = await import('../../src/main/window');
    showMainWindow();
    const win = lastWindow() as unknown as { webContents: { emit(event: string, ...args: unknown[]): void } };
    mocks.trackDesktopEvent.mockClear();

    win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('renderer_crashed', expect.anything());

    win.webContents.emit('render-process-gone', {}, { reason: 'memory-eviction', exitCode: 1 });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('renderer_crashed', {
      reason: 'oom',
      exit_code: 1,
    });
  });
});

describe('Windows taskbar identity', () => {
  it('uses a separate branded identity for an unpackaged Windows window', () => {
    const options = windowsWindowOptions(
      'win32',
      false,
      'C:\\repo\\apps\\desktop\\out',
      'C:\\resources',
    );
    expect(options).toEqual({ icon: 'C:\\repo\\apps\\desktop\\build\\icon.ico' });
    expect(
      windowsAppDetails(
        'win32',
        false,
        options.icon as string,
        'C:\\Program Files\\Electron\\electron.exe',
        'C:\\repo\\apps\\desktop',
      ),
    ).toEqual({
      appId: 'com.kimi.code.desktop.dev',
      appIconPath: 'C:\\repo\\apps\\desktop\\build\\icon.ico',
      appIconIndex: 0,
      relaunchCommand:
        '"C:\\Program Files\\Electron\\electron.exe" "C:\\repo\\apps\\desktop"',
      relaunchDisplayName: 'Kimi Code Dev',
    });
  });

  it('pins packaged Windows windows to the installed app metadata', () => {
    const options = windowsWindowOptions(
      'win32',
      true,
      'C:\\app\\resources\\app.asar\\out',
      'C:\\app\\resources',
    );
    expect(options).toEqual({ icon: 'C:\\app\\resources\\build\\icon.ico' });
    expect(
      windowsAppDetails(
        'win32',
        true,
        options.icon as string,
        'C:\\Program Files\\Kimi Code\\Kimi Code.exe',
        'C:\\Program Files\\Kimi Code\\resources\\app.asar',
      ),
    ).toEqual({
      appId: 'com.kimi.code.desktop',
      appIconPath: 'C:\\app\\resources\\build\\icon.ico',
      appIconIndex: 0,
      relaunchCommand: '"C:\\Program Files\\Kimi Code\\Kimi Code.exe"',
      relaunchDisplayName: 'Kimi Code',
    });
  });

  it('leaves non-Windows windows to their platform packaging', () => {
    expect(windowsWindowOptions('darwin', false, '/app/out', '/app/resources')).toEqual({});
    expect(windowsAppDetails('linux', false, undefined, 'electron', '/app')).toBeNull();
  });
});
