import { beforeEach, describe, expect, it, vi } from 'vitest';

import { IPC } from '../../src/main/ipc-channels';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  handlers: new Map<string, IpcHandler>(),
  listeners: new Map<string, IpcHandler>(),
  trackDesktopEvent: vi.fn(),
  setDockIconChoice: vi.fn(),
  listAvailableOpenInApps: vi.fn(() => []),
  openInApp: vi.fn<
    (appId: string, path: string) => Promise<{ ok: boolean; error?: string }>
  >(async () => ({ ok: true })),
  setGlobalShortcut: vi.fn(() => true),
  showMainWindow: vi.fn(),
  setVibrancyEnabled: vi.fn(),
  applyWindowVibrancy: vi.fn(),
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
}));

vi.mock('electron', () => ({
  dialog: {
    showOpenDialog: mocks.showOpenDialog,
    showSaveDialog: mocks.showSaveDialog,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => mocks.listeners.set(channel, handler)),
  },
  nativeTheme: { themeSource: 'system' },
  shell: { openExternal: vi.fn(async () => undefined) },
}));

vi.mock('../../src/main/window', () => ({
  getMainWindow: vi.fn(() => null),
  showMainWindow: mocks.showMainWindow,
  applyWindowVibrancy: mocks.applyWindowVibrancy,
}));
vi.mock('../../src/main/connect', () => ({ readServerToken: vi.fn() }));
vi.mock('../../src/main/open-in', () => ({
  listAvailableOpenInApps: mocks.listAvailableOpenInApps,
  openInApp: mocks.openInApp,
}));
vi.mock('../../src/main/updater', () => ({
  getUpdateAutoDownload: vi.fn(() => false),
  getUpdateStatus: vi.fn(() => ({ state: 'idle' })),
  requestUpdateCheck: vi.fn(),
  requestUpdateDownload: vi.fn(),
  requestUpdateInstall: vi.fn(),
  setUpdateAutoDownload: vi.fn(),
}));
vi.mock('../../src/main/tray', () => ({
  asTrayAttention: vi.fn(() => null),
  setTrayAttention: vi.fn(),
  setTrayLocale: vi.fn(),
}));
vi.mock('../../src/main/context-menu', () => ({ setContextMenuLocale: vi.fn() }));
vi.mock('../../src/main/jump-list', () => ({
  asJumpListWorkspaces: vi.fn(() => null),
  setJumpListLocale: vi.fn(),
  updateJumpList: vi.fn(),
}));
vi.mock('../../src/main/menu', () => ({
  popupWindowsMenu: vi.fn(),
  setMenuLocale: vi.fn(),
  setMenuShortcuts: vi.fn(),
  setMenuSuspended: vi.fn(),
}));
vi.mock('../../src/main/shortcuts', () => ({
  setGlobalShortcut: mocks.setGlobalShortcut,
  setGlobalShortcutSuspended: vi.fn(() => true),
}));
vi.mock('../../src/main/ui-state', () => ({
  isVibrancyEnabled: vi.fn(() => true),
  markOnboarded: vi.fn(),
  setVibrancyEnabled: mocks.setVibrancyEnabled,
}));
vi.mock('../../src/main/dock-icon', () => ({
  isDockIconChoice: vi.fn((value: unknown) => value === 'light' || value === 'dark' || value === 'auto'),
  osAppearance: vi.fn(() => 'light'),
  setDockIconChoice: mocks.setDockIconChoice,
}));
vi.mock('../../src/main/log', () => ({
  log: { error: vi.fn() },
  redactUrlForLog: vi.fn((url: string) => url),
}));
vi.mock('../../src/main/renderer-log', () => ({ createRendererLogWriter: vi.fn(() => vi.fn()) }));
vi.mock('../../src/main/track', () => ({
  asRendererTrackEvent: vi.fn(() => null),
  trackDesktopEvent: mocks.trackDesktopEvent,
}));

import { registerIpcHandlers } from '../../src/main/ipc';

function listener(channel: string): IpcHandler {
  const registered = mocks.listeners.get(channel);
  expect(registered, `listener for ${channel}`).toBeDefined();
  return registered!;
}

function handler(channel: string): IpcHandler {
  const registered = mocks.handlers.get(channel);
  expect(registered, `handler for ${channel}`).toBeDefined();
  return registered!;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handlers.clear();
  mocks.listeners.clear();
  registerIpcHandlers();
});

describe('native_ipc_used telemetry', () => {
  it('does not count startup synchronization or capability queries as user actions', async () => {
    listener(IPC.theme)({}, 'dark');
    listener(IPC.dockIconChoice)({}, 'dark');
    await handler(IPC.openInList)({});
    await handler(IPC.globalShortcut)({}, { action: 'summonApp', binding: 'mod+space' });

    expect(mocks.setDockIconChoice).toHaveBeenCalledWith('dark');
    expect(mocks.listAvailableOpenInApps).toHaveBeenCalledOnce();
    expect(mocks.setGlobalShortcut).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
  });

  it('counts only validated, user-initiated native IPC calls', async () => {
    await handler(IPC.dialogOpen)({}, { properties: ['openDirectory'] });
    await handler(IPC.dialogSave)({}, { defaultPath: 'trace.json' });
    await handler(IPC.openInApp)({}, 'vscode', '/work/project');
    listener(IPC.showWindow)({});
    listener(IPC.vibrancy)({}, false);

    expect(mocks.trackDesktopEvent.mock.calls).toEqual([
      ['native_ipc_used', { channel: 'dialog-open' }],
      ['native_ipc_used', { channel: 'dialog-save' }],
      ['native_ipc_used', { channel: 'open-in' }],
      ['native_ipc_used', { channel: 'show-window' }],
      ['native_ipc_used', { channel: 'vibrancy' }],
    ]);

    mocks.trackDesktopEvent.mockClear();
    await handler(IPC.openInApp)({}, 42, '/work/project');
    listener(IPC.vibrancy)({}, 'yes');
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
  });

  it('does not count native operations that fail before completing', async () => {
    mocks.openInApp.mockResolvedValueOnce({ ok: false as const, error: 'launch failed' });
    await handler(IPC.openInApp)({}, 'vscode', '/work/project');
    mocks.showOpenDialog.mockRejectedValueOnce(new Error('dialog failed'));
    await expect(handler(IPC.dialogOpen)({}, {})).rejects.toThrow('dialog failed');

    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
  });
});
