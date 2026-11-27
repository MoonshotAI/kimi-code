vi.mock('../../../src/main/browser/browser-overlay', () => ({ attachBrowserOverlayWindow: vi.fn() }));
import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';

import {
  clampBoundsToWorkArea,
  devToolsMode,
  drainLaunchActions,
  installWindowsSessionEndWatch,
  isAppRendererUrl,
  isMarkedQuitting,
  isQuitConfirmSkipped,
  looksMaximizedBounds,
  markQuitting,
  shouldHideOnClose,
  shouldPersistBounds,
  titleBarWindowOptions,
  usesCustomTitleBar,
  vibrancyWindowOptions,
  windowsAppDetails,
  windowsWindowOptions,
} from '../../../src/main/window/main-window';
import { IPC } from '../../../src/main/ipc/ipc-channels';

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
  });

  it('frames Linux with the same overlay by default, keeping the native frame on opt-out', () => {
    expect(titleBarWindowOptions('linux', false)).toEqual({
      frame: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#202020', height: 40 },
    });
    expect(titleBarWindowOptions('linux', true)).toMatchObject({
      titleBarOverlay: { symbolColor: '#f2f2f2' },
    });
    expect(titleBarWindowOptions('linux', false, true)).toEqual({ titleBarStyle: 'default' });
  });
});

describe('usesCustomTitleBar', () => {
  it('covers Windows always and Linux unless the native opt-out is on', () => {
    expect(usesCustomTitleBar('win32', false)).toBe(true);
    expect(usesCustomTitleBar('win32', true)).toBe(true);
    expect(usesCustomTitleBar('linux', false)).toBe(true);
    expect(usesCustomTitleBar('linux', true)).toBe(false);
    expect(usesCustomTitleBar('darwin', false)).toBe(false);
  });
});

describe('devToolsMode', () => {
  const realPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
    mocks.isLinuxNativeTitleBar.mockReturnValue(false);
  });

  it('docks DevTools on a Linux custom title bar and detaches elsewhere', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
    expect(devToolsMode()).toBe('right');
    mocks.isLinuxNativeTitleBar.mockReturnValue(true);
    expect(devToolsMode()).toBe('detach');
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
    expect(devToolsMode()).toBe('detach');
  });
});

const mocks = vi.hoisted(() => ({
  trackDesktopEvent: vi.fn(),
  connect: vi.fn(),
  installDownloadHandler: vi.fn(),
  installExternalLinkGuard: vi.fn(),
  installPermissionHandler: vi.fn(),
  setFailureToastSender: vi.fn(),
  installEmbeddedServerAuthInjection: vi.fn(),
  registerAppWebContents: vi.fn(),
  isVibrancyEnabled: vi.fn(() => true),
  isLinuxNativeTitleBar: vi.fn(() => false),
  attachBrowserWindow: vi.fn(),
  attachBrowserOverlayWindow: vi.fn(),
  logInfo: vi.fn(),
  logStartup: vi.fn(),
  startupListeners: [] as Array<(entry: { step: string }) => void>,
  nativeThemeOn: vi.fn(),
  attachWindowDiagnostics: vi.fn(),
  attachWhiteScreenWatchdog: vi.fn(),
  markCleanExit: vi.fn(),
  windows: [] as unknown[],
  focusedWebContents: null as unknown,
  browserOccluded: false,
  windowFocused: false,
  contentBounds: { x: 0, y: 0, width: 1280, height: 832 },
}));

vi.mock('electron', () => {
  class FakeWebContents {
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    destroyed = false;
    crashed = false;
    loadingMainFrame = false;
    on(event: string, cb: (...args: unknown[]) => void): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    }
    removeListener(event: string, cb: (...args: unknown[]) => void): void {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((handler) => handler !== cb));
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    send = vi.fn();
    isDestroyed(): boolean {
      return this.destroyed;
    }
    isCrashed(): boolean {
      return this.crashed;
    }
    isLoadingMainFrame(): boolean {
      return this.loadingMainFrame;
    }
    session = {};
    mainFrame = { processId: 1, routingId: 1 };
    openDevTools = vi.fn();
    isDevToolsOpened(): boolean {
      return false;
    }
    closeDevTools = vi.fn();
    close = vi.fn();
    focus = vi.fn();
    getURL(): string {
      return 'app://renderer/index.html';
    }
    getZoomFactor(): number {
      return 1;
    }
    getZoomLevel(): number {
      return 0;
    }
    loadURL = vi.fn(async (_url: string) => undefined);
    navigationHistory = { clear: vi.fn() };
    reload = vi.fn();
    executeJavaScript(): Promise<unknown> {
      return Promise.resolve(1);
    }
  }
  class FakeWebContentsView {
    webContents = new FakeWebContents();
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
  }
  class FakeBaseWindow {
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    contentView = {
      children: [] as unknown[],
      handlers: new Map<string, (() => void)[]>(),
      addChildView: vi.fn((view: unknown) => { this.contentView.children.push(view); }),
      getBounds: () => ({ ...mocks.contentBounds }),
      on: (event: string, cb: () => void) => { this.contentView.handlers.set(event, [...(this.contentView.handlers.get(event) ?? []), cb]); },
      emit: (event: string) => { for (const cb of this.contentView.handlers.get(event) ?? []) cb(); },
    };
    options: unknown;
    show = vi.fn();
    hide = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    setFullScreen = vi.fn();
    setVibrancy = vi.fn();
    setBackgroundColor = vi.fn();
    setWindowButtonPosition = vi.fn();
    setWindowButtonVisibility = vi.fn();
    setAppDetails = vi.fn();
    setMenuBarVisibility = vi.fn();
    setTitleBarOverlay = vi.fn();
    constructor(options?: unknown) {
      this.options = options;
      mocks.windows.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      return this;
    }
    once(event: string, cb: (...args: unknown[]) => void): this {
      return this.on(event, cb);
    }
    removeListener(event: string, cb: (...args: unknown[]) => void): this {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter((handler) => handler !== cb));
      return this;
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
    isFocused(): boolean {
      return mocks.windowFocused;
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
      getAppPath: () => '/tmp/kimi-window-test/app',
      getVersion: () => '1.0.1',
      on: vi.fn(),
    },
    BaseWindow: FakeBaseWindow,
    BrowserWindow: { fromWebContents: vi.fn(() => null) },
    WebContentsView: FakeWebContentsView,
    webContents: { getFocusedWebContents: () => mocks.focusedWebContents },
    dialog: { showSaveDialogSync: vi.fn(), showErrorBox: vi.fn() },
    nativeTheme: { shouldUseDarkColors: false, on: mocks.nativeThemeOn, removeListener: vi.fn() },
    nativeImage: { createFromPath: () => ({ isEmpty: () => true }) },
    screen: { getPrimaryDisplay: () => ({ workArea: { width: 1512, height: 944 } }) },
    shell: { openExternal: vi.fn() },
  };
});
vi.mock('../../../src/main/server/connect', () => ({ connect: mocks.connect }));
vi.mock('../../../src/main/browser/downloads', () => ({ installDownloadHandler: mocks.installDownloadHandler }));
vi.mock('../../../src/main/shell/external-links', () => ({ installExternalLinkGuard: mocks.installExternalLinkGuard }));
vi.mock('../../../src/main/app/permissions', () => ({ installPermissionHandler: mocks.installPermissionHandler }));
vi.mock('../../../src/main/app/failure-dialog', () => ({ setFailureToastSender: mocks.setFailureToastSender }));
vi.mock('../../../src/main/server/server-auth', () => ({
  installEmbeddedServerAuthInjection: mocks.installEmbeddedServerAuthInjection,
  registerAppWebContents: mocks.registerAppWebContents,
}));
vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { info: mocks.logInfo, error: vi.fn(), warn: vi.fn() },
  logStartup: mocks.logStartup,
  onStartupStep: (listener: (entry: { step: string }) => void) => {
    mocks.startupListeners.push(listener);
    return () => {
      mocks.startupListeners.splice(mocks.startupListeners.indexOf(listener) >>> 0, 1);
    };
  },
  redactUrlForLog: (url: string) => url,
}));
vi.mock('../../../src/main/window/window-diagnostics', () => ({ attachWindowDiagnostics: mocks.attachWindowDiagnostics }));
vi.mock('../../../src/main/window/white-screen-watchdog', () => ({
  attachWhiteScreenWatchdog: mocks.attachWhiteScreenWatchdog,
  RENDERER_GONE_GRACE_MS: 5_000,
  STARTUP_STALL_MS: 10_000,
}));
vi.mock('../../../src/main/app/launch-state', () => ({ markCleanExit: mocks.markCleanExit }));
vi.mock('../../../src/main/app/ui-state', () => ({
  isVibrancyEnabled: mocks.isVibrancyEnabled,
  isLinuxNativeTitleBar: mocks.isLinuxNativeTitleBar,
}));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: mocks.trackDesktopEvent, trySendDesktopEvent: vi.fn() }));
vi.mock('../../../src/main/browser/browser-view', () => ({ attachBrowserWindow: mocks.attachBrowserWindow, isBrowserOccluded: () => mocks.browserOccluded }));
vi.mock('../../../src/main/shell/terminal-menu-focus', () => ({ setTerminalMenuFocus: vi.fn(), getTerminalMenuFocus: vi.fn(() => false) }));
vi.mock('../../../src/main/browser/browser-overlay', () => ({
  attachBrowserOverlayWindow: mocks.attachBrowserOverlayWindow,
}));

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

describe('quit confirmation skip marker', () => {
  it('is set by explicit quit paths through markQuitting', () => {
    expect(isQuitConfirmSkipped()).toBe(false);
    markQuitting();
    expect(isQuitConfirmSkipped()).toBe(true);
    expect(isMarkedQuitting()).toBe(true);
  });
});

describe('installWindowsSessionEndWatch', () => {
  it('reacts only to the final Windows session-end event and passes its reasons on', () => {
    const listeners = new Map<string, (event: { reasons: readonly string[] }) => void>();
    const markEnding = vi.fn();
    installWindowsSessionEndWatch(
      'win32',
      { on: (event, listener) => listeners.set(event, listener) },
      markEnding,
    );

    expect(listeners.has('query-session-end')).toBe(false);
    listeners.get('session-end')?.({ reasons: ['logoff'] });
    expect(markEnding.mock.calls).toEqual([[['logoff']]]);
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
  it('always passes the pinned translucent material + transparent flash on macOS (an opt-out launch removes it right after creation)', () => {
    expect(vibrancyWindowOptions('darwin', false)).toEqual({
      vibrancy: 'menu',
      visualEffectState: 'active',
      backgroundColor: '#00000000',
    });
  });

  it('passes no vibrancy options off macOS and paints the app background of the current theme', () => {
    expect(vibrancyWindowOptions('win32', true)).toEqual({ backgroundColor: '#121212' });
    expect(vibrancyWindowOptions('linux', false)).toEqual({ backgroundColor: '#ffffff' });
  });
});

describe('window lifecycle telemetry', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.windows.length = 0;
    mocks.startupListeners.length = 0;
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
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
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('window_lifecycle', { action: 'shown' });
    mocks.trackDesktopEvent.mockClear();
    lastWindow().emit('show');
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
    showMainWindow();
    expect(lastWindow().show).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
  });

  it('installs embedded server auth injection on the window session and registers its webContents', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = mocks.windows.at(-1) as { webContents: { session: unknown } };
    expect(mocks.installEmbeddedServerAuthInjection).toHaveBeenCalledWith(win.webContents.session);
    expect(mocks.registerAppWebContents).toHaveBeenCalledWith(win.webContents);
    expect(mocks.installPermissionHandler).toHaveBeenCalledWith(win.webContents.session);
  });

  it("tracks 'hidden' only when Electron reports the window was hidden", async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
    const { showMainWindow } = await import('../../../src/main/window/main-window');
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

  it('lets a close interceptor swallow the close before hide-on-close runs', async () => {
    const { showMainWindow, addMainWindowCloseInterceptor } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow();
    addMainWindowCloseInterceptor(() => true);
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.hide).not.toHaveBeenCalled();
  });

  it('falls through to hide-on-close when every close interceptor declines', async () => {
    const { showMainWindow, addMainWindowCloseInterceptor } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow();
    addMainWindowCloseInterceptor(() => false);
    const event = { preventDefault: vi.fn() };
    win.emit('close', event);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(win.hide).toHaveBeenCalledOnce();
  });

  it("tracks 'hidden' with reason 'deactivate' on minimize", async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
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
    const { showMainWindow } = await import('../../../src/main/window/main-window');
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
    const { showMainWindow } = await import('../../../src/main/window/main-window');
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
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
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

  it('ignores transient data: pages when reporting renderer_loaded', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow() as unknown as {
      webContents: { emit(event: string, ...args: unknown[]): void; getURL: () => string };
    };

    const phases = (): string[] =>
      mocks.trackDesktopEvent.mock.calls
        .filter((call) => call[0] === 'startup_timing')
        .map((call) => (call[1] as { phase: string }).phase);

    win.webContents.getURL = () => 'data:text/html;charset=utf-8,%3C!doctype%20html%3E';
    win.webContents.emit('did-finish-load');
    expect(phases()).toEqual(['window_shown']);

    win.webContents.getURL = () => 'app://renderer/index.html';
    win.webContents.emit('did-finish-load');
    expect(phases()).toEqual(['window_shown', 'renderer_loaded', 'renderer_ready']);
  });

  it.each(['did-fail-load', 'did-fail-provisional-load', 'did-finish-load'])(
    'keeps startup actions queued until the renderer subscribes, even after %s',
    async (event) => {
      const { showMainWindow, sendLaunchAction, sendMenuActionWhenReady, selectSessionInRenderer, markRendererUiMounted } = await import('../../../src/main/window/main-window');
      showMainWindow();
      const contents = (lastWindow() as unknown as { webContents: StartupContents }).webContents;
      const startupUrl = 'data:text/html,startup';
      const appUrl = 'app://renderer/index.html';
      contents.getURL = () => startupUrl;
      const project = { action: 'open-workspace', root: '/project' } as const;
      sendLaunchAction(project);
      sendLaunchAction({ action: 'new-chat' });
      sendLaunchAction({ action: 'open-session', sessionId: 'linked-session' });
      selectSessionInRenderer('tray-session');
      sendMenuActionWhenReady('open-update-dialog');

      contents.emit('did-start-navigation', { url: appUrl, isMainFrame: true, isSameDocument: false });
      contents.getURL = () => appUrl;
      contents.emit('did-navigate', {}, appUrl);
      contents.emit(event, {}, -3, 'ERR_ABORTED', startupUrl, true);
      markRendererUiMounted(startupUrl);

      expect(contents.send).not.toHaveBeenCalledWith(IPC.launchAction, expect.anything());
      expect(contents.send).not.toHaveBeenCalledWith(IPC.traySelectSession, expect.anything());
      expect(contents.send).not.toHaveBeenCalledWith(IPC.menuAction, expect.anything());

      markRendererUiMounted(appUrl);
      markRendererUiMounted(appUrl);
      expect(contents.send.mock.calls).toEqual([
        [IPC.traySelectSession, 'tray-session'],
        [IPC.launchAction, project],
        [IPC.launchAction, { action: 'new-chat' }],
        [IPC.launchAction, { action: 'open-session', sessionId: 'linked-session' }],
        [IPC.menuAction, 'open-update-dialog'],
      ]);
    },
  );

  it.each(['reload', 'crash'])('waits for the replacement renderer after %s', async (transition) => {
    const { showMainWindow, sendLaunchAction, markRendererUiMounted } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const contents = (lastWindow() as unknown as { webContents: StartupContents }).webContents;
    const appUrl = contents.getURL();
    contents.emit('did-finish-load');
    markRendererUiMounted(appUrl);
    sendLaunchAction({ action: 'new-chat' });
    expect(contents.send).toHaveBeenCalledExactlyOnceWith(IPC.launchAction, { action: 'new-chat' });
    contents.send.mockClear();

    if (transition === 'crash') {
      contents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });
    }
    contents.emit('did-start-navigation', { url: appUrl, isMainFrame: true, isSameDocument: false });
    contents.emit('did-navigate', {}, appUrl);
    const action = { action: 'open-session', sessionId: 'after-reload' } as const;
    sendLaunchAction(action);
    markRendererUiMounted(appUrl);
    expect(contents.send).not.toHaveBeenCalled();
    contents.emit('did-finish-load');
    expect(contents.send).toHaveBeenCalledExactlyOnceWith(IPC.launchAction, action);
  });

  it('resumes delivery to an already mounted renderer when navigation is cancelled before commit', async () => {
    const { showMainWindow, sendLaunchAction, markRendererUiMounted } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const contents = (lastWindow() as unknown as { webContents: StartupContents }).webContents;
    contents.emit('did-finish-load');
    markRendererUiMounted(contents.getURL());
    const target = 'app://renderer/other.html';
    contents.loadingMainFrame = true;
    contents.emit('did-start-navigation', { url: target, isMainFrame: true, isSameDocument: false });
    const action = { action: 'new-chat' } as const;
    sendLaunchAction(action);
    expect(contents.send).not.toHaveBeenCalled();
    contents.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', target, true);
    expect(contents.send).not.toHaveBeenCalled();
    contents.loadingMainFrame = false;
    contents.emit('did-stop-loading');
    expect(contents.send).toHaveBeenCalledExactlyOnceWith(IPC.launchAction, action);
  });

  it('does not dispatch to the old renderer while a replacement navigation is still loading', async () => {
    const { showMainWindow, sendLaunchAction, markRendererUiMounted } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const contents = (lastWindow() as unknown as { webContents: StartupContents }).webContents;
    contents.emit('did-finish-load');
    markRendererUiMounted(contents.getURL());

    contents.loadingMainFrame = true;
    const firstTarget = 'app://renderer/first.html';
    const lastTarget = 'app://renderer/last.html';
    contents.emit('did-start-navigation', { url: firstTarget, isMainFrame: true, isSameDocument: false });
    contents.emit('did-start-navigation', { url: lastTarget, isMainFrame: true, isSameDocument: false });
    const action = { action: 'open-session', sessionId: 'after-navigation' } as const;
    sendLaunchAction(action);
    contents.emit('did-fail-provisional-load', {}, -3, 'ERR_ABORTED', firstTarget, true);
    expect(contents.send).not.toHaveBeenCalled();

    contents.getURL = () => lastTarget;
    contents.emit('did-navigate', {}, lastTarget);
    markRendererUiMounted(lastTarget);
    expect(contents.send).not.toHaveBeenCalled();
    contents.loadingMainFrame = false;
    contents.emit('did-stop-loading');
    contents.emit('did-finish-load');
    expect(contents.send).toHaveBeenCalledExactlyOnceWith(IPC.launchAction, action);
  });

  it('does not reuse the old mount when navigation commits an error page at the app URL', async () => {
    const { showMainWindow, sendLaunchAction, markRendererUiMounted } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const contents = (lastWindow() as unknown as { webContents: StartupContents }).webContents;
    const appUrl = contents.getURL();
    contents.emit('did-finish-load');
    markRendererUiMounted(appUrl);
    contents.loadingMainFrame = true;
    contents.emit('did-start-navigation', { url: appUrl, isMainFrame: true, isSameDocument: false });
    const action = { action: 'new-chat' } as const;
    sendLaunchAction(action);

    const frame = { processId: 2, routingId: 2 };
    contents.mainFrame = frame;
    contents.emit('did-fail-provisional-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', appUrl, true, frame.processId, frame.routingId);
    contents.loadingMainFrame = false;
    contents.emit('did-stop-loading');
    expect(contents.send).not.toHaveBeenCalled();

    contents.emit('did-navigate', {}, appUrl);
    contents.emit('did-finish-load');
    markRendererUiMounted(appUrl);
    expect(contents.send).toHaveBeenCalledExactlyOnceWith(IPC.launchAction, action);
  });

  it('clears transient startup history after the app renderer loads', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const contents = (lastWindow() as unknown as {
      webContents: StartupContents & { navigationHistory: { clear: ReturnType<typeof vi.fn> } };
    }).webContents;

    contents.getURL = () => 'data:text/html;charset=utf-8,%3C!doctype%20html%3E';
    contents.emit('did-finish-load');
    expect(contents.navigationHistory.clear).not.toHaveBeenCalled();

    contents.emit('did-start-navigation', { url: 'app://renderer/index.html', isMainFrame: true, isSameDocument: false });
    contents.getURL = () => 'app://renderer/index.html';
    contents.emit('did-finish-load');
    expect(contents.navigationHistory.clear).toHaveBeenCalledOnce();

    contents.emit('did-start-navigation', { url: 'app://renderer/index.html', isMainFrame: true, isSameDocument: false });
    contents.emit('did-finish-load');
    expect(contents.navigationHistory.clear).toHaveBeenCalledOnce();
  });

  it('attaches window diagnostics to the main renderer and marks the window creation', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    mocks.attachWindowDiagnostics.mockClear();
    mocks.logStartup.mockClear();
    showMainWindow();
    const win = lastWindow() as unknown as { webContents: unknown };
    expect(mocks.attachWindowDiagnostics).toHaveBeenCalledWith(win.webContents);
    expect(mocks.attachWhiteScreenWatchdog).toHaveBeenCalledWith(win.webContents, {
      isAppUrl: expect.any(Function),
      isQuitting: expect.any(Function),
    });
    const options = mocks.attachWhiteScreenWatchdog.mock.calls.at(-1)?.[1] as { isAppUrl: (url: string) => boolean };
    expect(options.isAppUrl('app://renderer/index.html')).toBe(true);
    expect(options.isAppUrl('data:text/html,error')).toBe(false);
    expect(mocks.logStartup).toHaveBeenCalledWith('window-created');
  });

  interface StartupContents {
    send: ReturnType<typeof vi.fn>;
    loadingMainFrame: boolean;
    mainFrame: { processId: number; routingId: number };
    loadURL: ReturnType<typeof vi.fn>;
    executeJavaScript: (...args: unknown[]) => Promise<unknown>;
    getURL: () => string;
    emit(event: string, ...args: unknown[]): void;
  }

  it('shows the startup screen before connecting to the server', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const contents = (lastWindow() as unknown as { webContents: StartupContents }).webContents;
    const [url] = contents.loadURL.mock.calls[0] as [string];
    expect(url.startsWith('data:text/html')).toBe(true);
    expect(decodeURIComponent(url)).toContain('<h1>Starting Kimi Code…</h1>');
    expect(decodeURIComponent(url)).toContain('<p id="stage">Preparing the environment</p>');
    expect(contents.loadURL.mock.invocationCallOrder[0]).toBeLessThan(mocks.connect.mock.invocationCallOrder[0]!);
  });

  it('updates the step on the startup screen only while it is showing', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const contents = (lastWindow() as unknown as { webContents: StartupContents }).webContents;
    const [startupUrl] = contents.loadURL.mock.calls[0] as [string];
    const executeJavaScript = vi.fn(async (..._args: unknown[]) => undefined);
    contents.executeJavaScript = executeJavaScript;
    const step = (name: string): void => {
      for (const listener of mocks.startupListeners) listener({ step: name });
    };

    contents.getURL = () => startupUrl;
    step('server-start');
    step('server-start');
    expect(executeJavaScript.mock.calls).toEqual([['window.__kimiStartupStage?.("Starting the local server")']]);

    contents.getURL = () => 'app://renderer/index.html';
    step('load-url');
    expect(executeJavaScript).toHaveBeenCalledOnce();
  });

  it('shows the startup screen again without stacking its listeners', async () => {
    const { showMainWindow, showStartupScreen } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow() as unknown as { webContents: StartupContents } & FakeWindowHandle;
    const contents = win.webContents;
    const [startupUrl] = contents.loadURL.mock.calls[0] as [string];
    const executeJavaScript = vi.fn(async (..._args: unknown[]) => undefined);
    contents.executeJavaScript = executeJavaScript;
    contents.getURL = () => startupUrl;
    for (const listener of mocks.startupListeners) listener({ step: 'load-url' });
    executeJavaScript.mockClear();

    showStartupScreen(win as never);
    expect(contents.loadURL).toHaveBeenLastCalledWith(startupUrl);
    expect(mocks.startupListeners).toHaveLength(1);
    contents.emit('did-finish-load');
    expect(executeJavaScript.mock.calls.filter(([code]) => String(code).includes('__kimiStartupStage'))).toEqual([
      ['window.__kimiStartupStage?.("Preparing the environment")'],
    ]);

    win.emit('closed');
    expect(mocks.startupListeners).toHaveLength(0);
  });

  it('runs screen actions only from the built-in screens', async () => {
    const { showMainWindow, setScreenActionHandler } = await import('../../../src/main/window/main-window');
    const handler = vi.fn();
    setScreenActionHandler(handler);
    showMainWindow();
    const win = lastWindow() as unknown as { webContents: StartupContents };
    const navigate = (url: string): ReturnType<typeof vi.fn> => {
      const event = { preventDefault: vi.fn() };
      win.webContents.emit('will-navigate', event, url);
      return event.preventDefault;
    };

    win.webContents.getURL = () => 'data:text/html;charset=utf-8,%3Ch1%3E';
    expect(navigate('kimi-screen-action:restart-app')).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith('restart-app', win);

    win.webContents.getURL = () => 'app://renderer/index.html';
    expect(navigate('kimi-screen-action:restart-app')).toHaveBeenCalledOnce();
    expect(navigate('app://renderer/index.html')).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledOnce();
  });

  it('records the final Windows session end as a clean exit of this launch', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
    Object.defineProperty(process, 'resourcesPath', { configurable: true, value: 'C:\\Kimi Code\\resources' });
    try {
      const { showMainWindow, isMarkedQuitting } = await import('../../../src/main/window/main-window');
      showMainWindow();
      expect(isMarkedQuitting()).toBe(false);

      lastWindow().emit('session-end', { reasons: ['shutdown'] });

      expect(isMarkedQuitting()).toBe(true);
      expect(mocks.markCleanExit).toHaveBeenCalledOnce();
      expect(mocks.logInfo).toHaveBeenCalledWith('[power] session-end reasons=shutdown');
    } finally {
      Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  it('tracks renderer_crashed with the raw reason and exit code once the app is still running after the grace period', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow() as unknown as { webContents: { emit(event: string, ...args: unknown[]): void } };
    mocks.trackDesktopEvent.mockClear();
    vi.useFakeTimers();
    try {
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });
      vi.advanceTimersByTime(4_999);
      expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('renderer_crashed', expect.anything());
      vi.advanceTimersByTime(1);
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('renderer_crashed', {
        reason: 'crashed',
        exit_code: -1,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('folds memory-eviction into oom and skips clean-exit teardowns', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow() as unknown as { webContents: { emit(event: string, ...args: unknown[]): void } };
    mocks.trackDesktopEvent.mockClear();
    vi.useFakeTimers();
    try {
      win.webContents.emit('render-process-gone', {}, { reason: 'clean-exit', exitCode: 0 });
      win.webContents.emit('render-process-gone', {}, { reason: 'memory-eviction', exitCode: 1 });
      vi.advanceTimersByTime(5_000);
      expect(mocks.trackDesktopEvent.mock.calls.filter(([event]) => event === 'renderer_crashed')).toEqual([
        ['renderer_crashed', { reason: 'oom', exit_code: 1 }],
      ]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads a crashed renderer after the grace period and bounds rapid recovery attempts', async () => {
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow() as unknown as {
      webContents: { emit(event: string, ...args: unknown[]): void; reload: ReturnType<typeof vi.fn> };
    };
    vi.useFakeTimers();
    try {
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });
      vi.advanceTimersByTime(4_999);
      expect(win.webContents.reload).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(win.webContents.reload).toHaveBeenCalledTimes(1);

      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });
      vi.advanceTimersByTime(5_000);
      expect(win.webContents.reload).toHaveBeenCalledTimes(2);
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });
      vi.advanceTimersByTime(5_000);
      expect(win.webContents.reload).toHaveBeenCalledTimes(2);

      win.webContents.emit('did-finish-load', true);
      vi.advanceTimersByTime(60_000);
      win.webContents.emit('render-process-gone', {}, { reason: 'crashed', exitCode: -1 });
      vi.advanceTimersByTime(5_000);
      expect(win.webContents.reload).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('drops renderer_crashed and recovery when the app starts quitting within the grace period', async () => {
    const { showMainWindow, markQuitting } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow() as unknown as {
      webContents: { emit(event: string, ...args: unknown[]): void; reload: ReturnType<typeof vi.fn> };
    };
    mocks.trackDesktopEvent.mockClear();
    vi.useFakeTimers();
    try {
      win.webContents.emit('render-process-gone', {}, { reason: 'killed', exitCode: 15 });
      markQuitting();
      vi.advanceTimersByTime(5_000);
      expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('renderer_crashed', expect.anything());
      expect(win.webContents.reload).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips sendToRenderer once the renderer process is gone', async () => {
    const { showMainWindow, sendToRenderer } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow() as unknown as {
      webContents: { crashed: boolean; destroyed: boolean; send: ReturnType<typeof vi.fn> };
    };

    sendToRenderer(IPC.quitConfirmCancel, 1);
    expect(win.webContents.send).toHaveBeenCalledWith(IPC.quitConfirmCancel, 1);

    win.webContents.send.mockClear();
    win.webContents.crashed = true;
    sendToRenderer(IPC.quitConfirmCancel, 2);
    expect(win.webContents.send).not.toHaveBeenCalled();

    win.webContents.crashed = false;
    win.webContents.destroyed = true;
    sendToRenderer(IPC.quitConfirmCancel, 3);
    expect(win.webContents.send).not.toHaveBeenCalled();
  });

  it('swallows a sendToRenderer failure from a disposed render frame', async () => {
    const { showMainWindow, sendToRenderer } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow() as unknown as {
      webContents: { send: ReturnType<typeof vi.fn> };
    };
    win.webContents.send.mockImplementation(() => {
      throw new Error('Render frame was disposed before WebFrameMain could be accessed');
    });
    expect(() => sendToRenderer(IPC.quitConfirmCancel, 1)).not.toThrow();
  });
});

describe('fullscreen state sync', () => {
  const realPlatform = process.platform;
  const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.windows.length = 0;
    Object.defineProperty(process, 'resourcesPath', { value: '/tmp/kimi-window-test/resources', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
    } else {
      Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  it.each(['win32', 'darwin', 'linux'])('pushes the event-implied state on %s despite a stale query', async (platform) => {
    Object.defineProperty(process, 'platform', { value: platform, enumerable: true, configurable: true });
    const { IPC } = await import('../../../src/main/ipc/ipc-channels');
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = mocks.windows.at(-1) as {
      emit(event: string, ...args: unknown[]): void;
      isFullScreen(): boolean;
      webContents: { send: ReturnType<typeof vi.fn> };
    };
    for (let cycle = 0; cycle < 3; cycle++) {
      win.webContents.send.mockClear();
      win.isFullScreen = () => false;
      win.emit('enter-full-screen');
      expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.fullscreenChanged, true);

      win.webContents.send.mockClear();
      win.isFullScreen = () => true;
      win.emit('leave-full-screen');
      expect(win.webContents.send).toHaveBeenCalledExactlyOnceWith(IPC.fullscreenChanged, false);
    }
  });
});

describe('custom title bar window chrome', () => {
  const realPlatform = process.platform;
  const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.windows.length = 0;
    mocks.isLinuxNativeTitleBar.mockReturnValue(false);
    Object.defineProperty(process, 'resourcesPath', { value: '/tmp/kimi-window-test/resources', configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
    } else {
      Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  function lastWindow(): {
    options: Record<string, unknown>;
    setMenuBarVisibility: ReturnType<typeof vi.fn>;
    webContents: { openDevTools: ReturnType<typeof vi.fn> };
  } {
    const win = mocks.windows.at(-1) as
      | {
          options: Record<string, unknown>;
          setMenuBarVisibility: ReturnType<typeof vi.fn>;
          webContents: { openDevTools: ReturnType<typeof vi.fn> };
        }
      | undefined;
    expect(win, 'a BrowserWindow was created').toBeDefined();
    return win!;
  }

  it('frames a Linux window with the hidden title bar and hides the native menu bar', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
    const { nativeTheme } = await import('electron');
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow();
    expect(win.options).toMatchObject({
      frame: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#202020', height: 40 },
    });
    expect(win.setMenuBarVisibility).toHaveBeenCalledWith(false);
    expect(nativeTheme.on).toHaveBeenCalledWith('updated', expect.any(Function));
  });

  it('keeps the native Linux frame and menu bar on the native title bar opt-out', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
    mocks.isLinuxNativeTitleBar.mockReturnValue(true);
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow();
    expect(win.options).toMatchObject({ titleBarStyle: 'default' });
    expect(win.options).not.toHaveProperty('frame');
    expect(win.options).not.toHaveProperty('titleBarOverlay');
    expect(win.setMenuBarVisibility).not.toHaveBeenCalled();
    for (const [event, listener] of mocks.nativeThemeOn.mock.calls) {
      if (event === 'updated') (listener as () => void)();
    }
    const painted = win as unknown as { setTitleBarOverlay: ReturnType<typeof vi.fn>; setBackgroundColor: ReturnType<typeof vi.fn> };
    expect(painted.setTitleBarOverlay).not.toHaveBeenCalled();
    expect(painted.setBackgroundColor).toHaveBeenLastCalledWith('#ffffff');
  });

  it('keeps the Windows framed overlay path unchanged', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
    const { showMainWindow } = await import('../../../src/main/window/main-window');
    showMainWindow();
    const win = lastWindow();
    expect(win.options).toMatchObject({
      titleBarStyle: 'hidden',
      titleBarOverlay: { color: '#00000000', symbolColor: '#202020', height: 40 },
    });
    expect(win.options).not.toHaveProperty('frame');
    expect(win.setMenuBarVisibility).toHaveBeenCalledWith(false);
  });

  it('docks devtools on Linux dev windows to avoid the detached Wayland crash', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
    const { app } = await import('electron');
    (app as { isPackaged: boolean }).isPackaged = false;
    try {
      const { showMainWindow } = await import('../../../src/main/window/main-window');
      showMainWindow();
      expect(lastWindow().webContents.openDevTools).toHaveBeenCalledWith({ mode: 'right' });
    } finally {
      (app as { isPackaged: boolean }).isPackaged = true;
    }
  });

  it('keeps detached devtools on Windows dev windows', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
    const { app } = await import('electron');
    (app as { isPackaged: boolean }).isPackaged = false;
    try {
      const { showMainWindow } = await import('../../../src/main/window/main-window');
      showMainWindow();
      expect(lastWindow().webContents.openDevTools).toHaveBeenCalledWith({ mode: 'detach' });
    } finally {
      (app as { isPackaged: boolean }).isPackaged = true;
    }
  });
});

describe('Windows taskbar identity', () => {
  it('keeps Preview taskbar grouping and relaunch metadata separate from stable', () => {
    expect(windowsAppDetails('win32', true, 'C:\\Preview\\icon.ico', 'C:\\Preview\\Kimi Code Preview.exe', 'C:\\Preview', '0.0.25-preview.123.1.g12345678')).toEqual({
      appId: 'com.kimi.code.desktop.preview',
      appIconPath: 'C:\\Preview\\icon.ico',
      appIconIndex: 0,
      relaunchCommand: '"C:\\Preview\\Kimi Code Preview.exe"',
      relaunchDisplayName: 'Kimi Code Preview',
    });
  });
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

describe('main window host view', () => {
  const resourcesPathDescriptor = Object.getOwnPropertyDescriptor(process, 'resourcesPath');

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.windows.length = 0;
    mocks.focusedWebContents = null;
    mocks.browserOccluded = false;
    mocks.windowFocused = false;
    mocks.contentBounds = { x: 0, y: 0, width: 1280, height: 832 };
    Object.defineProperty(process, 'resourcesPath', { value: '/tmp/kimi-window-test/resources', configurable: true });
  });

  afterEach(() => {
    if (resourcesPathDescriptor) {
      Object.defineProperty(process, 'resourcesPath', resourcesPathDescriptor);
    } else {
      Reflect.deleteProperty(process, 'resourcesPath');
    }
  });

  interface FakeHostView {
    webContents: { focus: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> };
    setBackgroundColor: ReturnType<typeof vi.fn>;
    setBounds: ReturnType<typeof vi.fn>;
  }

  interface FakeMainWindow {
    hostView: FakeHostView;
    webContents: unknown;
    contentView: { children: unknown[]; emit(event: string): void };
    emit(event: string, ...args: unknown[]): void;
  }

  async function created(): Promise<FakeMainWindow> {
    const { createWindow } = await import('../../../src/main/window/main-window');
    createWindow();
    return mocks.windows.at(-1) as FakeMainWindow;
  }

  it('sends failure feedback to the ready renderer and reports delivery failure for fallback', async () => {
    const win = await created();
    const sendFailure = mocks.setFailureToastSender.mock.calls[0]?.[0] as ((kind: 'external-link', url?: string) => boolean) | undefined;
    if (sendFailure === undefined) throw new Error('failure toast sender not registered');
    const contents = win.webContents as {
      emit: (event: string) => void;
      send: ReturnType<typeof vi.fn>;
    };
    expect(sendFailure('external-link')).toBe(false);
    contents.emit('did-finish-load');
    expect(sendFailure('external-link', 'https://example.com/docs?token=secret')).toBe(true);
    expect(contents.send).toHaveBeenCalledWith(IPC.failureToast, 'external-link', 'https://example.com/docs?token=secret');
    const visible = vi.spyOn(win as unknown as { isVisible: () => boolean }, 'isVisible').mockReturnValue(false);
    expect(sendFailure('external-link')).toBe(false);
    visible.mockRestore();
    const minimized = vi.spyOn(win as unknown as { isMinimized: () => boolean }, 'isMinimized').mockReturnValue(true);
    expect(sendFailure('external-link')).toBe(false);
    minimized.mockRestore();
    contents.send.mockImplementation(() => {
      throw new Error('renderer gone');
    });
    expect(sendFailure('external-link')).toBe(false);
  });

  it('hosts the app renderer in a transparent view that fills the window and follows resizes', async () => {
    const win = await created();
    expect(win.contentView.children).toEqual([win.hostView]);
    expect(win.webContents).toBe(win.hostView.webContents);
    expect(win.hostView.setBackgroundColor).toHaveBeenCalledWith('#00000000');
    expect(win.hostView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 832 });
    win.hostView.setBounds.mockClear();
    win.emit('resize');
    expect(win.hostView.setBounds).toHaveBeenCalledTimes(1);
    win.emit('closed');
    expect(win.hostView.webContents.close).toHaveBeenCalled();
  });

  it('follows a content view bounds change that arrives without a window event', async () => {
    const win = await created();
    win.hostView.setBounds.mockClear();
    mocks.contentBounds = { x: 0, y: 0, width: 1280, height: 804 };
    win.contentView.emit('bounds-changed');
    expect(win.hostView.setBounds).toHaveBeenCalledTimes(1);
    expect(win.hostView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1280, height: 804 });
  });

  it('ends at the final content bounds when maximize fires before the content view settles', async () => {
    const win = await created();
    mocks.contentBounds = { x: 0, y: 0, width: 1920, height: 1030 };
    win.emit('maximize');
    win.emit('resize');
    expect(win.hostView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1920, height: 1030 });
    mocks.contentBounds = { x: 0, y: 0, width: 1920, height: 1032 };
    win.contentView.emit('bounds-changed');
    expect(win.hostView.setBounds).toHaveBeenLastCalledWith({ x: 0, y: 0, width: 1920, height: 1032 });
  });

  it('focuses the app renderer at creation when the window took focus before the listener existed', async () => {
    mocks.windowFocused = true;
    const win = await created();
    expect(win.hostView.webContents.focus).toHaveBeenCalledTimes(1);
  });

  it('leaves the app renderer unfocused at creation while the window is not focused', async () => {
    const win = await created();
    expect(win.hostView.webContents.focus).not.toHaveBeenCalled();
  });

  it('focuses the app renderer on window focus unless a browser page kept focus', async () => {
    const win = await created();
    const page = { webContents: { id: 'page' }, getVisible: () => true };
    win.contentView.children.push(page);
    win.emit('focus');
    expect(win.hostView.webContents.focus).toHaveBeenCalledTimes(1);
    mocks.focusedWebContents = page.webContents;
    win.emit('focus');
    expect(win.hostView.webContents.focus).toHaveBeenCalledTimes(1);
    mocks.browserOccluded = true;
    win.emit('focus');
    expect(win.hostView.webContents.focus).toHaveBeenCalledTimes(2);
  });

  it('focuses the app renderer on window focus when the page that kept focus was hidden meanwhile', async () => {
    const win = await created();
    let visible = true;
    const page = { webContents: { id: 'page' }, getVisible: () => visible };
    win.contentView.children.push(page);
    mocks.focusedWebContents = page.webContents;
    win.emit('focus');
    expect(win.hostView.webContents.focus).not.toHaveBeenCalled();
    visible = false;
    win.emit('focus');
    expect(win.hostView.webContents.focus).toHaveBeenCalledTimes(1);
  });
});
