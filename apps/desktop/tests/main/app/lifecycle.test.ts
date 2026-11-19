import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let resolveReady = (): void => {};
  const app = {
    isPackaged: true,
    getVersion: vi.fn(() => '0.0.0-test'),
    setAppUserModelId: vi.fn(),
    setAsDefaultProtocolClient: vi.fn(),
    requestSingleInstanceLock: vi.fn(() => true),
    quit: vi.fn(),
    on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
      listeners.set(event, listener);
    }),
    whenReady: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveReady = resolve;
        }),
    ),
    relaunch: vi.fn(),
  };
  return {
    app,
    nativeTheme: { themeSource: 'system' as string },
    getColorScheme: vi.fn((): string => 'system'),
    connect: vi.fn((): Promise<void> => Promise.resolve()),
    setScreenActionHandler: vi.fn(),
    showStartupScreen: vi.fn(),
    listeners,
    ready: () => resolveReady(),
    createWindow: vi.fn(),
    showMainWindow: vi.fn(),
    sendLaunchAction: vi.fn(),
    sendToRenderer: vi.fn(),
    closeServerHandle: vi.fn(() => new Promise<void>(() => {})),
    shutdownServerTelemetry: vi.fn((): Promise<void> | null => null),
    stopShellEnvProbe: vi.fn(),
    killAllTerminals: vi.fn(),
    waitForTerminalExits: vi.fn((): Promise<boolean> | null => null),
    destroyTray: vi.fn(),
    unregisterGlobalShortcuts: vi.fn(),
    finalizeWindowLifecycle: vi.fn(),
    shutdownScreenshot: vi.fn(),
    shouldBlockQuit: vi.fn((): Promise<boolean> => Promise.resolve(false)),
    isMarkedQuitting: vi.fn(() => false),
    isQuitConfirmSkipped: vi.fn(() => false),
    cancelQuitting: vi.fn(),
    markQuitting: vi.fn(),
    getMainWindow: vi.fn(() => null),
    trackDesktopEvent: vi.fn(),
    scheduleBrowserReceiptPruning: vi.fn(),
    applyPreventSleepOnLaunch: vi.fn((): Promise<void> => Promise.resolve()),
    restorePreventSleepBeforeQuit: vi.fn(),
    createTray: vi.fn(),
    installAppDiagnostics: vi.fn(),
    startLaunchTracking: vi.fn(),
    markQuitStarted: vi.fn(),
    installUncaughtErrorNotice: vi.fn(),
    reportIfStillRunning: vi.fn((report: () => void) => report()),
    exportDiagnostics: vi.fn((): Promise<void> => Promise.resolve()),
    openLogsFolder: vi.fn((): Promise<void> => Promise.resolve()),
  };
});

vi.mock('electron', () => ({ app: mocks.app, nativeTheme: mocks.nativeTheme }));
vi.mock('../../../src/main/app/ui-state', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/main/app/ui-state')>()),
  getColorScheme: mocks.getColorScheme,
}));
vi.mock('../../../src/main/app/protocol', () => ({
  registerAppSchemes: vi.fn(),
  registerRendererProtocol: vi.fn(),
}));
vi.mock('../../../src/main/server/connect', () => ({
  connect: mocks.connect,
  rendererDistRoot: '/renderer',
  closeServerHandle: mocks.closeServerHandle,
  shutdownServerTelemetry: mocks.shutdownServerTelemetry,
}));
vi.mock('../../../src/main/window/main-window', () => ({
  createWindow: mocks.createWindow,
  cancelQuitting: mocks.cancelQuitting,
  getMainWindow: mocks.getMainWindow,
  isMarkedQuitting: mocks.isMarkedQuitting,
  isQuitConfirmSkipped: mocks.isQuitConfirmSkipped,
  markQuitting: mocks.markQuitting,
  reportIfStillRunning: mocks.reportIfStillRunning,
  selectSessionInRenderer: vi.fn(),
  sendLaunchAction: mocks.sendLaunchAction,
  sendToRenderer: mocks.sendToRenderer,
  showMainWindow: mocks.showMainWindow,
  setScreenActionHandler: mocks.setScreenActionHandler,
  showStartupScreen: mocks.showStartupScreen,
}));
vi.mock('../../../src/main/shell/tray', () => ({
  createTray: mocks.createTray,
  destroyTray: mocks.destroyTray,
}));
vi.mock('../../../src/main/diagnostics/collector', () => ({ installAppDiagnostics: mocks.installAppDiagnostics }));
vi.mock('../../../src/main/app/launch-state', () => ({
  startLaunchTracking: mocks.startLaunchTracking,
  markQuitStarted: mocks.markQuitStarted,
}));
vi.mock('../../../src/main/app/uncaught-error-notice', () => ({
  installUncaughtErrorNotice: mocks.installUncaughtErrorNotice,
}));
vi.mock('../../../src/main/diagnostics/diagnostics-export', () => ({
  exportDiagnostics: mocks.exportDiagnostics,
  openLogsFolder: mocks.openLogsFolder,
}));
vi.mock('../../../src/main/shell/dock-icon', () => ({ initDockIcon: vi.fn() }));
vi.mock('../../../src/main/shell/menu', () => ({ buildMenu: vi.fn() }));
vi.mock('../../../src/main/shell/shortcuts', () => ({
  unregisterGlobalShortcuts: mocks.unregisterGlobalShortcuts,
}));
vi.mock('../../../src/main/system/shell-env', () => ({ stopShellEnvProbe: mocks.stopShellEnvProbe }));
vi.mock('../../../src/main/terminal/manager', () => ({
  killAllTerminals: mocks.killAllTerminals,
  waitForTerminalExits: mocks.waitForTerminalExits,
}));
vi.mock('../../../src/main/ipc/register', () => ({ registerIpcHandlers: vi.fn() }));
vi.mock('../../../src/main/screenshot/controller', () => ({ initScreenshot: vi.fn(), shutdownScreenshot: mocks.shutdownScreenshot }));
vi.mock('../../../src/main/browser/browser-receipts', () => ({ scheduleBrowserReceiptPruning: mocks.scheduleBrowserReceiptPruning }));
vi.mock('../../../src/main/release/updater', () => ({ initAutoUpdater: vi.fn() }));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: mocks.trackDesktopEvent, trySendDesktopEvent: vi.fn() }));
vi.mock('../../../src/main/window/window-lifecycle', () => ({
  finalizeWindowLifecycle: mocks.finalizeWindowLifecycle,
}));
vi.mock('../../../src/main/app/quit-confirm', () => ({
  shouldBlockQuit: mocks.shouldBlockQuit,
}));
vi.mock('../../../src/main/system/prevent-lid-sleep', () => ({
  applyPreventSleepOnLaunch: mocks.applyPreventSleepOnLaunch,
  restorePreventSleepBeforeQuit: mocks.restorePreventSleepBeforeQuit,
}));

import { main, runScreenAction } from '../../../src/main/app/lifecycle';
import { initAutoUpdater } from '../../../src/main/release/updater';

describe('app second-instance routing', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.app.isPackaged = true;
    mocks.app.getVersion.mockReturnValue('0.0.0-test');
    mocks.shutdownServerTelemetry.mockReturnValue(null);
    mocks.waitForTerminalExits.mockReturnValue(null);
    mocks.isMarkedQuitting.mockReturnValue(false);
    mocks.isQuitConfirmSkipped.mockReturnValue(false);
    mocks.shouldBlockQuit.mockResolvedValue(false);
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
  });

  it.each([
    ['win32', ''], ['win32', '/'], ['linux', ''], ['linux', '/'],
  ])('routes cold workspace links on %s with pathname "%s"', async (platform, pathname) => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    const argv = process.argv;
    process.argv = ['desktop', `kimi-code://open${pathname}?root=%2Fwork%2Fproject&new=1`];
    try {
      main();
      mocks.ready();
      await vi.waitFor(() => expect(mocks.sendLaunchAction).toHaveBeenCalledWith({
        action: 'open-workspace', root: '/work/project', newChat: true,
      }));
      expect(mocks.sendToRenderer).not.toHaveBeenCalled();
      expect(mocks.showMainWindow).toHaveBeenCalledOnce();
    } finally {
      process.argv = argv;
    }
  });

  it('queues macOS workspace links until ready and routes subsequent links', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    main();
    const event = { preventDefault: vi.fn() };
    mocks.listeners.get('open-url')!(event, 'kimi-code://open?root=/work/project');
    expect(mocks.sendLaunchAction).not.toHaveBeenCalled();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.sendLaunchAction).toHaveBeenCalledWith({
      action: 'open-workspace', root: '/work/project', newChat: true,
    }));
    mocks.listeners.get('open-url')!(event, 'kimi-code://open?root=/work/second');
    expect(mocks.sendLaunchAction).toHaveBeenLastCalledWith({
      action: 'open-workspace', root: '/work/second', newChat: true,
    });
  });

  it.each(['', '/'])('routes workspace links from an already running second instance with pathname "%s"', async (pathname) => {
    main();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());
    mocks.listeners.get('second-instance')!({}, ['desktop', `kimi-code://open${pathname}?root=/work/project`]);
    expect(mocks.sendLaunchAction).toHaveBeenCalledWith({
      action: 'open-workspace', root: '/work/project', newChat: true,
    });
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('isolates unpackaged Windows launches from the installed shell identity', () => {
    mocks.app.isPackaged = false;
    main();

    expect(mocks.app.setAppUserModelId).toHaveBeenCalledWith('com.kimi.code.desktop.dev');
  });

  it('starts Preview without either updater', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
    mocks.app.getVersion.mockReturnValue('0.0.25-preview.123.1.g12345678');
    main();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());
    expect(initAutoUpdater).not.toHaveBeenCalled();
  });

  it('applies the persisted prevent-sleep state after ready', async () => {
    main();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.applyPreventSleepOnLaunch).toHaveBeenCalled());
  });

  it('uses the Preview shell identity on Windows', () => {
    mocks.app.getVersion.mockReturnValue('0.0.25-preview.123.1.g12345678');
    main();
    expect(mocks.app.setAppUserModelId).toHaveBeenCalledWith('com.kimi.code.desktop.preview');
  });

  it('registers immediately and replays launches received before the window is ready', async () => {
    main();

    expect(mocks.app.setAppUserModelId).toHaveBeenCalledWith('com.kimi.code.desktop');
    const onSecondInstance = mocks.listeners.get('second-instance');
    expect(onSecondInstance).toBeTypeOf('function');
    onSecondInstance?.({}, ['electron.exe', '--new-chat']);
    expect(mocks.sendLaunchAction).not.toHaveBeenCalled();

    expect(mocks.scheduleBrowserReceiptPruning).not.toHaveBeenCalled();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

    expect(mocks.scheduleBrowserReceiptPruning).toHaveBeenCalledOnce();
    expect(mocks.sendLaunchAction).toHaveBeenCalledWith({ action: 'new-chat' });
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('queues deep links received before the window is ready and shows the window after', async () => {
    main();

    const onOpenUrl = mocks.listeners.get('open-url');
    expect(onOpenUrl).toBeTypeOf('function');
    const event = { preventDefault: vi.fn() };
    onOpenUrl?.(event, 'kimi-code://auth/success');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(mocks.showMainWindow).not.toHaveBeenCalled();

    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('shows the window for a whitelisted deep link after ready and ignores unknown URLs', async () => {
    main();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

    const onOpenUrl = mocks.listeners.get('open-url');
    const event = { preventDefault: vi.fn() };
    onOpenUrl?.(event, 'kimi-code://unknown/path');
    expect(mocks.showMainWindow).not.toHaveBeenCalled();

    onOpenUrl?.(event, 'kimi-code://auth/success');
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('pushes the deep-link-auth wake to the renderer for whitelisted URLs only', async () => {
    main();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

    const onOpenUrl = mocks.listeners.get('open-url');
    const event = { preventDefault: vi.fn() };
    onOpenUrl?.(event, 'kimi-code://unknown/path');
    expect(mocks.sendToRenderer).not.toHaveBeenCalled();

    onOpenUrl?.(event, 'kimi-code://auth/success');
    expect(mocks.sendToRenderer).toHaveBeenCalledWith('kimi:deep-link-auth', undefined);

    mocks.sendToRenderer.mockClear();
    const onSecondInstance = mocks.listeners.get('second-instance');
    onSecondInstance?.({}, ['electron.exe', 'kimi-code://auth/success']);
    expect(mocks.sendToRenderer).toHaveBeenCalledWith('kimi:deep-link-auth', undefined);
  });

  it('gates deep-link second instances through the whitelist (Windows/Linux argv)', async () => {
    main();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

    const onSecondInstance = mocks.listeners.get('second-instance');
    onSecondInstance?.({}, ['electron.exe', 'kimi-code://unknown/path']);
    expect(mocks.showMainWindow).not.toHaveBeenCalled();

    onSecondInstance?.({}, ['electron.exe', 'kimi-code://auth/success']);
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('gates an uppercased-scheme deep link instead of treating it as a plain relaunch', async () => {
    main();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

    const onSecondInstance = mocks.listeners.get('second-instance');
    onSecondInstance?.({}, ['electron.exe', 'KIMI-CODE://unknown/path']);
    expect(mocks.showMainWindow).not.toHaveBeenCalled();

    onSecondInstance?.({}, ['electron.exe', 'KIMI-CODE://auth/success']);
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('applies the same whitelist gate to deep-link launches queued before ready', async () => {
    main();

    const onSecondInstance = mocks.listeners.get('second-instance');
    onSecondInstance?.({}, ['electron.exe', 'kimi-code://unknown/path']);
    onSecondInstance?.({}, ['electron.exe', 'kimi-code://auth/success']);

    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('self-registers the deep link scheme on Windows (packaged or dev)', () => {
    main();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledWith('kimi-code');

    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.app.isPackaged = false;
    main();
    expect(mocks.app.setAsDefaultProtocolClient).toHaveBeenCalledWith(
      'kimi-code',
      process.execPath,
      [process.argv[1] ?? '.'],
    );
  });

  it('does not block quit while closing the embedded server', async () => {
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.finalizeWindowLifecycle).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
    expect(mocks.shutdownScreenshot).not.toHaveBeenCalled();

    const confirmed = { preventDefault: vi.fn() };
    onBeforeQuit?.(confirmed);

    expect(confirmed.preventDefault).not.toHaveBeenCalled();
    expect(mocks.finalizeWindowLifecycle).toHaveBeenCalledOnce();
    expect(mocks.closeServerHandle).toHaveBeenCalledOnce();
    expect(mocks.shutdownScreenshot).toHaveBeenCalledOnce();
    expect(mocks.finalizeWindowLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeServerHandle.mock.invocationCallOrder[0]!,
    );
    expect(mocks.stopShellEnvProbe).toHaveBeenCalledOnce();
    expect(mocks.killAllTerminals).toHaveBeenCalledOnce();
    expect(mocks.destroyTray).toHaveBeenCalledOnce();
    expect(mocks.unregisterGlobalShortcuts).toHaveBeenCalledOnce();
  });

  it('marks quitting once the confirmation passes so an overlapping check cannot trap the window close', async () => {
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
    expect(mocks.markQuitting).toHaveBeenCalledOnce();
    expect(mocks.markQuitting.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.app.quit.mock.invocationCallOrder[0]!,
    );
  });

  it('cancels the quit when the active-session confirmation is rejected', async () => {
    mocks.shouldBlockQuit.mockResolvedValueOnce(true);
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.cancelQuitting).toHaveBeenCalledOnce());
    expect(mocks.app.quit).not.toHaveBeenCalled();
    expect(mocks.markQuitting).not.toHaveBeenCalled();
    expect(mocks.shutdownScreenshot).not.toHaveBeenCalled();
    expect(mocks.finalizeWindowLifecycle).not.toHaveBeenCalled();
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();

    const retry = { preventDefault: vi.fn() };
    onBeforeQuit?.(retry);
    expect(retry.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
    expect(mocks.shutdownScreenshot).not.toHaveBeenCalled();
    onBeforeQuit?.({ preventDefault: vi.fn() });
    expect(mocks.shutdownScreenshot).toHaveBeenCalledOnce();
  });

  it('records the quit start in the launch state only once the quit is committed', async () => {
    mocks.shouldBlockQuit.mockResolvedValueOnce(true);
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    onBeforeQuit?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(mocks.cancelQuitting).toHaveBeenCalledOnce());
    onBeforeQuit?.({ preventDefault: vi.fn() });
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
    expect(mocks.markQuitStarted).not.toHaveBeenCalled();

    onBeforeQuit?.({ preventDefault: vi.fn() });
    expect(mocks.markQuitStarted).toHaveBeenCalledOnce();
    expect(mocks.markQuitStarted.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeServerHandle.mock.invocationCallOrder[0]!,
    );
  });

  it('skips the active-session confirmation on an explicit quit path', () => {
    mocks.isQuitConfirmSkipped.mockReturnValue(true);
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.shouldBlockQuit).not.toHaveBeenCalled();
    expect(mocks.finalizeWindowLifecycle).toHaveBeenCalledOnce();
    expect(mocks.shutdownScreenshot).toHaveBeenCalledOnce();
  });

  it('keeps blocking duplicate quit requests while the busy-session check runs', async () => {
    let resolveCheck = (_blocked: boolean): void => {};
    mocks.shouldBlockQuit.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const first = { preventDefault: vi.fn() };
    onBeforeQuit?.(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();

    mocks.isMarkedQuitting.mockReturnValue(true);
    const duplicate = { preventDefault: vi.fn() };
    onBeforeQuit?.(duplicate);

    expect(duplicate.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.shouldBlockQuit).toHaveBeenCalledOnce();
    expect(mocks.finalizeWindowLifecycle).not.toHaveBeenCalled();

    resolveCheck(true);
    await vi.waitFor(() => expect(mocks.cancelQuitting).toHaveBeenCalledOnce());
    expect(mocks.app.quit).not.toHaveBeenCalled();
  });

  it('lets an explicit quit path win over an in-flight confirmation check', async () => {
    let resolveCheck = (_blocked: boolean): void => {};
    mocks.shouldBlockQuit.mockImplementationOnce(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCheck = resolve;
        }),
    );
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const first = { preventDefault: vi.fn() };
    onBeforeQuit?.(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();

    mocks.isQuitConfirmSkipped.mockReturnValue(true);
    const explicit = { preventDefault: vi.fn() };
    onBeforeQuit?.(explicit);

    expect(explicit.preventDefault).not.toHaveBeenCalled();
    expect(mocks.finalizeWindowLifecycle).toHaveBeenCalledOnce();

    resolveCheck(true);
    await vi.waitFor(() => expect(mocks.shouldBlockQuit).toHaveBeenCalledOnce());
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(mocks.cancelQuitting).not.toHaveBeenCalled();
    expect(mocks.showMainWindow).not.toHaveBeenCalled();
  });

  it('fails open and quits when the busy-session check rejects', async () => {
    mocks.shouldBlockQuit.mockRejectedValueOnce(new Error('telemetry exploded'));
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
    expect(mocks.markQuitting).toHaveBeenCalledOnce();

    const confirmed = { preventDefault: vi.fn() };
    onBeforeQuit?.(confirmed);

    expect(confirmed.preventDefault).not.toHaveBeenCalled();
    expect(mocks.finalizeWindowLifecycle).toHaveBeenCalledOnce();
  });

  it('still starts every cleanup step when another cleanup step fails', async () => {
    mocks.destroyTray.mockImplementationOnce(() => {
      throw new Error('tray cleanup failed');
    });
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());

    const confirmed = { preventDefault: vi.fn() };
    onBeforeQuit?.(confirmed);

    expect(confirmed.preventDefault).not.toHaveBeenCalled();
    expect(mocks.killAllTerminals).toHaveBeenCalledOnce();
    expect(mocks.closeServerHandle).toHaveBeenCalledOnce();
    expect(mocks.unregisterGlobalShortcuts).toHaveBeenCalledOnce();
  });

  it('holds quit only for the bounded telemetry flush, then quits without re-arming', async () => {
    let release = (): void => {};
    mocks.shutdownServerTelemetry.mockReturnValue(
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());

    const confirmed = { preventDefault: vi.fn() };
    onBeforeQuit?.(confirmed);

    expect(confirmed.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    release();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(2));

    const second = { preventDefault: vi.fn() };
    onBeforeQuit?.(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it('holds quit for terminal exits once, and quits anyway when a terminal is stuck', async () => {
    mocks.isQuitConfirmSkipped.mockReturnValue(true);
    let finish!: (drained: boolean) => void;
    mocks.waitForTerminalExits.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve; }));
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const first = { preventDefault: vi.fn() };
    onBeforeQuit?.(first);
    expect(first.preventDefault).toHaveBeenCalledOnce();
    await Promise.resolve();
    expect(mocks.app.quit).not.toHaveBeenCalled();

    finish(false);
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());

    mocks.waitForTerminalExits.mockReturnValue(new Promise<boolean>(() => {}));
    const second = { preventDefault: vi.fn() };
    onBeforeQuit?.(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it('quits even when the telemetry flush rejects', async () => {
    mocks.shutdownServerTelemetry.mockImplementation(() => Promise.reject(new Error('flush failed')));
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());

    const confirmed = { preventDefault: vi.fn() };
    onBeforeQuit?.(confirmed);

    expect(confirmed.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledTimes(2));
  });
});

describe('app startup telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.app.isPackaged = true;
  });

  async function ready(): Promise<void> {
    main();
    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());
  }

  it('tracks app_launched with the normal intent and the main_ready timing', async () => {
    await ready();

    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('app_launched', { launch_intent: 'normal' });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_timing', {
      phase: 'main_ready',
      duration_ms: expect.any(Number),
    });
  });

  it('tracks app_launched with the jump_list intent for Jump List flags', async () => {
    const argv = process.argv;
    process.argv = [...argv, '--new-chat'];
    try {
      await ready();
    } finally {
      process.argv = argv;
    }

    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('app_launched', { launch_intent: 'jump_list' });
  });

  it('leaves launch tracking to the running instance when the single-instance lock is taken', () => {
    mocks.app.requestSingleInstanceLock.mockReturnValueOnce(false);
    main();
    expect(mocks.app.quit).toHaveBeenCalledOnce();
    expect(mocks.startLaunchTracking).not.toHaveBeenCalled();
    expect(mocks.installUncaughtErrorNotice).not.toHaveBeenCalled();
  });

  it('installs app diagnostics before the first window and wires the tray diagnostics actions', async () => {
    await ready();

    expect(mocks.startLaunchTracking).toHaveBeenCalledOnce();
    expect(mocks.installUncaughtErrorNotice).toHaveBeenCalledOnce();
    expect(mocks.startLaunchTracking.mock.invocationCallOrder[0]).toBeGreaterThan(
      mocks.app.requestSingleInstanceLock.mock.invocationCallOrder[0]!,
    );
    expect(mocks.installAppDiagnostics).toHaveBeenCalledOnce();
    expect(mocks.installAppDiagnostics.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createWindow.mock.invocationCallOrder[0]!,
    );
    const actions = mocks.createTray.mock.calls[0]?.[0] as {
      exportDiagnostics: (locale: 'en' | 'zh') => void;
      openLogsFolder: () => void;
    };
    actions.exportDiagnostics('zh');
    expect(mocks.exportDiagnostics).toHaveBeenCalledWith('zh');
    actions.openLogsFolder();
    expect(mocks.openLogsFolder).toHaveBeenCalledOnce();
  });

  it('tracks app_crashed only for GPU child-process exits', async () => {
    await ready();
    const onGone = mocks.listeners.get('child-process-gone');
    expect(onGone).toBeTypeOf('function');

    onGone?.({}, { type: 'Tab', reason: 'crashed', exitCode: 1 });
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('app_crashed', expect.anything());

    onGone?.({}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('app_crashed', expect.anything());
    expect(mocks.reportIfStillRunning).not.toHaveBeenCalled();

    onGone?.({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
    expect(mocks.reportIfStillRunning).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('app_crashed', {
      process: 'gpu',
      kind: 'crashed',
      app_uptime_ms: expect.any(Number),
    });
  });

  it('applies the remembered color scheme before the window is created', async () => {
    mocks.nativeTheme.themeSource = 'system';
    mocks.getColorScheme.mockReturnValueOnce('dark');
    await ready();
    expect(mocks.nativeTheme.themeSource).toBe('dark');
    expect(mocks.getColorScheme.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.createWindow.mock.invocationCallOrder[0]!,
    );
  });

  it('wires the buttons on the startup and failure screens to their actions', () => {
    main();
    expect(mocks.setScreenActionHandler).toHaveBeenCalledWith(runScreenAction);
    const win = {} as never;

    runScreenAction('retry-connection', win);
    expect(mocks.showStartupScreen).toHaveBeenCalledWith(win);
    expect(mocks.connect).toHaveBeenCalledWith(win);
    expect(mocks.showStartupScreen.mock.invocationCallOrder[0]).toBeLessThan(mocks.connect.mock.invocationCallOrder[0]!);
    runScreenAction('export-diagnostics', win);
    expect(mocks.exportDiagnostics).toHaveBeenCalledWith('en');
    runScreenAction('open-logs-folder', win);
    expect(mocks.openLogsFolder).toHaveBeenCalledOnce();
    runScreenAction('restart-app', win);
    expect(mocks.markQuitting).toHaveBeenCalledOnce();
    expect(mocks.app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(mocks.app.quit.mock.invocationCallOrder[0]!);
  });

  it('ignores repeated retry clicks until the current retry finishes', async () => {
    let finish = (): void => {};
    mocks.connect.mockImplementationOnce(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const win = {} as never;

    runScreenAction('retry-connection', win);
    runScreenAction('retry-connection', win);
    expect(mocks.connect).toHaveBeenCalledOnce();
    expect(mocks.showStartupScreen).toHaveBeenCalledOnce();

    finish();
    await Promise.resolve();
    runScreenAction('retry-connection', win);
    expect(mocks.connect).toHaveBeenCalledTimes(2);
    expect(mocks.showStartupScreen).toHaveBeenCalledTimes(2);
  });
});
