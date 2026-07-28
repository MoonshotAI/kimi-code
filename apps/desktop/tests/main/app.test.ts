import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let resolveReady = (): void => {};
  const app = {
    isPackaged: true,
    getVersion: vi.fn(() => '0.0.0-test'),
    setAppUserModelId: vi.fn(),
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
    closeServerHandle: vi.fn(() => new Promise<void>(() => {})),
    stopShellEnvProbe: vi.fn(),
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
  closeServerHandle: mocks.closeServerHandle,
}));
vi.mock('../../src/main/window', () => ({
  createWindow: mocks.createWindow,
  selectSessionInRenderer: vi.fn(),
  sendLaunchAction: mocks.sendLaunchAction,
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
vi.mock('../../src/main/ipc', () => ({ registerIpcHandlers: vi.fn() }));
vi.mock('../../src/main/updater', () => ({ initAutoUpdater: vi.fn() }));
vi.mock('../../src/main/track', () => ({ trackDesktopEvent: mocks.trackDesktopEvent }));
vi.mock('../../src/main/window-lifecycle', () => ({
  finalizeWindowLifecycle: mocks.finalizeWindowLifecycle,
}));

import { main } from '../../src/main/app';

describe('app second-instance routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
    mocks.app.isPackaged = true;
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
    expect(mocks.closeServerHandle).toHaveBeenCalledOnce();
    expect(mocks.unregisterGlobalShortcuts).toHaveBeenCalledOnce();
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

    onGone?.({}, { type: 'GPU', reason: 'crashed', exitCode: 1 });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('app_crashed', {
      process: 'gpu',
      kind: 'crashed',
      app_uptime_ms: expect.any(Number),
    });
  });
});
