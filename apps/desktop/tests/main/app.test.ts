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
  };
  return {
    app,
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
    destroyTray: vi.fn(),
    unregisterGlobalShortcuts: vi.fn(),
    finalizeWindowLifecycle: vi.fn(),
    trackDesktopEvent: vi.fn(),
  };
});

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('../../src/main/protocol', () => ({
  registerRendererScheme: vi.fn(),
  registerRendererProtocol: vi.fn(),
}));
vi.mock('../../src/main/connect', () => ({
  rendererDistRoot: '/renderer',
  getPreviewDistRoot: () => null,
  closeServerHandle: mocks.closeServerHandle,
  shutdownServerTelemetry: mocks.shutdownServerTelemetry,
}));
vi.mock('../../src/main/window', () => ({
  createWindow: mocks.createWindow,
  selectSessionInRenderer: vi.fn(),
  sendLaunchAction: mocks.sendLaunchAction,
  sendToRenderer: mocks.sendToRenderer,
  showMainWindow: mocks.showMainWindow,
}));
vi.mock('../../src/main/tray', () => ({
  createTray: vi.fn(),
  destroyTray: mocks.destroyTray,
}));
vi.mock('../../src/main/dock-icon', () => ({ initDockIcon: vi.fn() }));
vi.mock('../../src/main/menu', () => ({ buildMenu: vi.fn() }));
vi.mock('../../src/main/shortcuts', () => ({
  unregisterGlobalShortcuts: mocks.unregisterGlobalShortcuts,
}));
vi.mock('../../src/main/shell-env', () => ({ stopShellEnvProbe: mocks.stopShellEnvProbe }));
vi.mock('../../src/main/terminal', () => ({ killAllTerminals: mocks.killAllTerminals }));
vi.mock('../../src/main/ipc', () => ({ registerIpcHandlers: vi.fn() }));
vi.mock('../../src/main/preview-window', () => ({
  initPreviewSession: vi.fn(),
  openPreviewWindow: vi.fn(),
  closePreviewWindow: vi.fn(),
}));
vi.mock('../../src/main/updater', () => ({ initAutoUpdater: vi.fn(), setUpdateController: vi.fn() }));
vi.mock('../../src/main/canary-updater', () => ({ initCanaryGithubUpdater: vi.fn() }));
vi.mock('../../src/main/track', () => ({ trackDesktopEvent: mocks.trackDesktopEvent }));
vi.mock('../../src/main/window-lifecycle', () => ({
  finalizeWindowLifecycle: mocks.finalizeWindowLifecycle,
}));

import { main } from '../../src/main/app';

describe('app second-instance routing', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.app.isPackaged = true;
    mocks.shutdownServerTelemetry.mockReturnValue(null);
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
  });

  it('isolates unpackaged Windows launches from the installed shell identity', () => {
    mocks.app.isPackaged = false;
    main();

    expect(mocks.app.setAppUserModelId).toHaveBeenCalledWith('com.kimi.code.desktop.dev');
  });

  it('registers immediately and replays launches received before the window is ready', async () => {
    main();

    expect(mocks.app.setAppUserModelId).toHaveBeenCalledWith('com.kimi.code.desktop');
    const onSecondInstance = mocks.listeners.get('second-instance');
    expect(onSecondInstance).toBeTypeOf('function');
    onSecondInstance?.({}, ['electron.exe', '--new-chat']);
    expect(mocks.sendLaunchAction).not.toHaveBeenCalled();

    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

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

    // Second-instance argv (Windows/Linux) wakes the renderer the same way.
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
    // Same protocol despite the case (RFC 3986): it must hit the whitelist,
    // not the unconditional plain-relaunch focus.
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

    // Only the whitelisted URL surfaces the window; the unknown one is dropped.
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('self-registers the deep link scheme on Windows (packaged or dev)', () => {
    // beforeEach pins win32: NSIS writes no protocol registry entry, so the
    // app always registers itself there.
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

  it('does not block quit while closing the embedded server', () => {
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(mocks.finalizeWindowLifecycle).toHaveBeenCalledOnce();
    expect(mocks.closeServerHandle).toHaveBeenCalledOnce();
    expect(mocks.finalizeWindowLifecycle.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.closeServerHandle.mock.invocationCallOrder[0]!,
    );
    expect(mocks.stopShellEnvProbe).toHaveBeenCalledOnce();
    expect(mocks.killAllTerminals).toHaveBeenCalledOnce();
    expect(mocks.destroyTray).toHaveBeenCalledOnce();
    expect(mocks.unregisterGlobalShortcuts).toHaveBeenCalledOnce();
  });

  it('still starts every cleanup step when another cleanup step fails', () => {
    mocks.destroyTray.mockImplementationOnce(() => {
      throw new Error('tray cleanup failed');
    });
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).not.toHaveBeenCalled();
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

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.app.quit).not.toHaveBeenCalled();
    release();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());

    // The re-entrant before-quit from app.quit() must not re-arm the barrier.
    const second = { preventDefault: vi.fn() };
    onBeforeQuit?.(second);
    expect(second.preventDefault).not.toHaveBeenCalled();
  });

  it('quits even when the telemetry flush rejects', async () => {
    mocks.shutdownServerTelemetry.mockReturnValue(Promise.reject(new Error('flush failed')));
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
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

  it('tracks app_crashed only for GPU child-process exits', async () => {
    await ready();
    const onGone = mocks.listeners.get('child-process-gone');
    expect(onGone).toBeTypeOf('function');

    onGone?.({}, { type: 'Tab', reason: 'crashed', exitCode: 1 });
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('app_crashed', expect.anything());

    // Chromium recycles the GPU process in normal operation — not a crash.
    onGone?.({}, { type: 'GPU', reason: 'clean-exit', exitCode: 0 });
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('app_crashed', expect.anything());

    onGone?.({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('app_crashed', {
      process: 'gpu',
      kind: 'crashed',
      app_uptime_ms: expect.any(Number),
    });
  });
});
