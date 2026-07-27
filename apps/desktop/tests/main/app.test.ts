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
  };
});

vi.mock('electron', () => ({ app: mocks.app }));
vi.mock('../../src/main/protocol', () => ({
  registerRendererScheme: vi.fn(),
  registerRendererProtocol: vi.fn(),
}));
vi.mock('../../src/main/connect', () => ({
  rendererDistRoot: '/renderer',
  closeServerHandle: vi.fn(),
}));
vi.mock('../../src/main/window', () => ({
  createWindow: mocks.createWindow,
  selectSessionInRenderer: vi.fn(),
  sendLaunchAction: mocks.sendLaunchAction,
  showMainWindow: mocks.showMainWindow,
}));
vi.mock('../../src/main/tray', () => ({
  createTray: vi.fn(),
  destroyTray: vi.fn(),
}));
vi.mock('../../src/main/dock-icon', () => ({ initDockIcon: vi.fn() }));
vi.mock('../../src/main/menu', () => ({ buildMenu: vi.fn() }));
vi.mock('../../src/main/shortcuts', () => ({ unregisterGlobalShortcuts: vi.fn() }));
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
});
