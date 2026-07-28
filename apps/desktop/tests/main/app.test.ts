import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: unknown[]) => void>();
  let resolveReady = (): void => {};
  let resolveClose = (): void => {};
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
    closeServerHandle: vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveClose = resolve;
        }),
    ),
    closeDone: () => resolveClose(),
    stopShellEnvProbe: vi.fn(),
    destroyTray: vi.fn(),
    unregisterGlobalShortcuts: vi.fn(),
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

import { main } from '../../src/main/app';

describe('app second-instance routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.listeners.clear();
  });

  it('registers immediately and replays launches received before the window is ready', async () => {
    main();

    const onSecondInstance = mocks.listeners.get('second-instance');
    expect(onSecondInstance).toBeTypeOf('function');
    onSecondInstance?.({}, ['electron.exe', '--new-chat']);
    expect(mocks.sendLaunchAction).not.toHaveBeenCalled();

    mocks.ready();
    await vi.waitFor(() => expect(mocks.createWindow).toHaveBeenCalledOnce());

    expect(mocks.sendLaunchAction).toHaveBeenCalledWith({ action: 'new-chat' });
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
  });

  it('waits for the embedded server to close before resuming quit', async () => {
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    const event = { preventDefault: vi.fn() };
    onBeforeQuit?.(event);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    await vi.waitFor(() => expect(mocks.closeServerHandle).toHaveBeenCalledOnce());
    expect(mocks.app.quit).not.toHaveBeenCalled();

    mocks.closeDone();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());

    const resumedEvent = { preventDefault: vi.fn() };
    onBeforeQuit?.(resumedEvent);
    expect(resumedEvent.preventDefault).not.toHaveBeenCalled();
  });

  it('still closes the server and resumes quit when another cleanup step fails', async () => {
    mocks.destroyTray.mockImplementationOnce(() => {
      throw new Error('tray cleanup failed');
    });
    main();

    const onBeforeQuit = mocks.listeners.get('before-quit');
    onBeforeQuit?.({ preventDefault: vi.fn() });

    await vi.waitFor(() => expect(mocks.closeServerHandle).toHaveBeenCalledOnce());
    expect(mocks.unregisterGlobalShortcuts).toHaveBeenCalledOnce();
    expect(mocks.app.quit).not.toHaveBeenCalled();

    mocks.closeDone();
    await vi.waitFor(() => expect(mocks.app.quit).toHaveBeenCalledOnce());
  });
});
