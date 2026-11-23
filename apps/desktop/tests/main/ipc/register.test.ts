import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { IPC } from '../../../src/main/ipc/ipc-channels';
import type { BrowserDataSnapshot, BrowserPreferencesPatch } from '../../../src/shared/browser-data';

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;

const mocks = vi.hoisted(() => ({
  takeOverBrowser: vi.fn(),
  takeLocalLinkGrant: vi.fn((_url: string) => false),
  terminalManager: {
    generation: vi.fn(() => 0),
    inspect: vi.fn(async () => []),
    write: vi.fn(),
    resize: vi.fn(),
    close: vi.fn(),
  },
  browserGeneration: vi.fn((_browserId: string) => 0),
  localPagesAllowed: vi.fn(async () => true),
  openBrowserLocalFile: vi.fn(async (_browserId: string, _url: string): Promise<{ url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean; error?: string }> => ({ url: '', title: '', loading: true, canGoBack: false, canGoForward: false })),
  readBrowserReceipt: vi.fn(async (..._args: unknown[]) => null),
  deleteBrowserReceipts: vi.fn(async (_sessionId: string) => undefined),
  copyBrowserReceipts: vi.fn(async (_sourceId: string, _targetId: string) => undefined),
  takeOverAllBrowsers: vi.fn(),
  takeOverClosedBrowser: vi.fn(),
  browserPickAnnotation: vi.fn(async () => null),
  browserFocusEmulation: vi.fn(),
  browserIdsForSite: vi.fn((): string[] => []),
  clearBrowserSiteData: vi.fn(async () => ({ origin: 'https://example.com' })),
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
  setColorScheme: vi.fn(),
  setPreventSystemSleep: vi.fn(),
  setPowerSaveBlockerEnabled: vi.fn(),
  isPowerSaveBlockerEnabled: vi.fn(() => false),
  getPreventSleepState: vi.fn(async () => ({ system: 'allow-sleep', lid: false, lidSupported: true })),
  setSystemSleepPreventionEnabled: vi.fn(async (mode: string) => ({ system: mode, lid: false, lidSupported: true })),
  setLidSleepPreventionEnabled: vi.fn(async (enabled: boolean) => ({ system: 'prevent-app-suspension', lid: enabled, lidSupported: true })),
  setLinuxNativeTitleBar: vi.fn(),
  isLinuxNativeTitleBar: vi.fn(() => true),
  applyWindowVibrancy: vi.fn(),
  showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })),
  showSaveDialog: vi.fn(async () => ({ canceled: true, filePath: undefined })),
  showMessageBox: vi.fn(async (..._args: unknown[]) => ({ response: 0, checkboxChecked: false })),
  contextMenuLocale: 'en' as 'en' | 'zh',
  openExternal: vi.fn(async () => undefined),
  clipboardWriteText: vi.fn(),
  getMainWindow: vi.fn(() => null as { isDestroyed: () => boolean; isFocused?: () => boolean; webContents: object } | null),
  browserGetState: vi.fn((_browserId: string) => ({
    url: '',
    title: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  })),
  browserNavigate: vi.fn(async (_browserId: string, address: string) => ({
    url: `https://${address}/`,
    title: '',
    loading: true,
    canGoBack: false,
    canGoForward: false,
  })),
  browserBack: vi.fn(),
  browserForward: vi.fn(),
  browserReload: vi.fn(),
  browserTabCommand: vi.fn(),
  browserFind: vi.fn(),
  browserStopFind: vi.fn(),
  browserPrint: vi.fn(async () => true),
  browserZoom: vi.fn(() => ({ zoomFactor: 1.1 })),
  browserToggleDeviceMode: vi.fn(async () => ({ device: { profileId: 'responsive' } })),
  browserSetDeviceMode: vi.fn(async () => ({ device: { profileId: 'ipad-mini' } })),
  browserCaptureBackdrop: vi.fn(async () => null),
  browserCaptureScreenshot: vi.fn(async () => true),
  browserGetData: vi.fn(() => ({
    history: [],
    preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
    defaultUserAgent: 'Mozilla/5.0',
  })),
  browserUpdatePreferences: vi.fn<(patch: BrowserPreferencesPatch) => BrowserDataSnapshot>(() => ({
    history: [],
    preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: false, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1.25, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
    defaultUserAgent: 'Mozilla/5.0',
  })),
  setBrowserAgentControl: vi.fn(),
  setBrowserSubagentControl: vi.fn(),
  browserClearHistory: vi.fn(),
  forgetSiteVisits: vi.fn(),
  browserClearDownloads: vi.fn(),
  browserOpenDownload: vi.fn(async () => true),
  browserControlDownload: vi.fn(() => true),
  browserRetryDownload: vi.fn(async () => true),
  browserRemoveDownload: vi.fn(() => true),
  browserDownloadsListeners: [] as Array<() => void>,
  browserDownloadItems: vi.fn(() => [] as unknown[]),
  browserRefreshDownloadFiles: vi.fn(async () => true),
  browserReadDownloads: vi.fn((): unknown[] => []),
  browserApplyDefaultZoom: vi.fn(),
  browserApplyAutoplay: vi.fn(),
  browserApplySound: vi.fn(),
  updateSiteSound: vi.fn(async (origin: string, setting: string) => ({ origin, sound: setting, permissions: {}, lastVisitedAt: 0, cookieCount: 0 })),
  updateSiteAutoplay: vi.fn(async (origin: string, setting: string) => ({ origin, autoplay: setting, permissions: {}, lastVisitedAt: 0, cookieCount: 0 })),
  browserClearData: vi.fn(),
  browserSetBounds: vi.fn(),
  browserSetVisible: vi.fn(),
  browserClose: vi.fn(),
  browserClone: vi.fn(),
  overlaySender: {},
  browserOverlayOpen: vi.fn(),
  browserOverlayClose: vi.fn(),
  browserOverlayDialogOpen: vi.fn(),
  browserOverlayDialogClose: vi.fn(),
  browserOverlayReady: vi.fn(),
  browserOverlayRendered: vi.fn(),
  browserOverlayHidden: vi.fn(),
  browserOverlayActivate: vi.fn(),
  browserOverlayDismiss: vi.fn(),
  shouldBlockQuit: vi.fn(async () => false),
  resolveQuitConfirmResponse: vi.fn(),
  stableSettingsPrecheck: vi.fn(() => 'ok'),
  writeImportMarker: vi.fn(),
  appRelaunch: vi.fn(),
  appExit: vi.fn(),
  appQuit: vi.fn(),
  markQuitting: vi.fn(),
  captureScreenshot: vi.fn(async () => ({ status: 'cancelled' })),
  cancelScreenshotCapture: vi.fn(),
}));

vi.mock('../../../src/main/browser/browser-control', () => ({
  takeOverBrowser: mocks.takeOverBrowser,
  takeOverAllBrowsers: mocks.takeOverAllBrowsers,
  takeOverClosedBrowser: mocks.takeOverClosedBrowser,
  handleBrowserControlTakeover: vi.fn(),
  markBrowserControlReady: vi.fn(),
  setBrowserControls: vi.fn(),
  revokeBrowserSubagentRun: vi.fn(),
  restoreBrowserSubagentRuns: vi.fn(),
  notifyBrowserAgentAction: vi.fn(),
  beginBrowserActivity: () => ({ target: vi.fn(), end: vi.fn() }),
}));
vi.mock('../../../src/main/browser/browser-receipts', () => ({
  readBrowserReceipt: mocks.readBrowserReceipt,
  deleteBrowserReceipts: mocks.deleteBrowserReceipts,
  copyBrowserReceipts: mocks.copyBrowserReceipts,
  withBrowserReceipt: async (_sessionId: string | undefined, work: () => Promise<unknown>) => ({ value: await work(), receiptId: undefined }),
}));
vi.mock('../../../src/main/browser/browser-annotations', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/main/browser/browser-annotations')>(),
  pickBrowserAnnotation: mocks.browserPickAnnotation,
}));
vi.mock('electron', () => ({
  app: {
    getLocale: vi.fn(() => 'en'),
    getVersion: vi.fn(() => '0.0.0-canary'),
    userAgentFallback: 'Mozilla/5.0',
    getPath: vi.fn((name: string) => `/tmp/${name}`),
    relaunch: mocks.appRelaunch,
    exit: mocks.appExit,
    quit: mocks.appQuit,
  },
  dialog: {
    showOpenDialog: mocks.showOpenDialog,
    showSaveDialog: mocks.showSaveDialog,
    showMessageBox: mocks.showMessageBox,
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => mocks.handlers.set(channel, handler)),
    on: vi.fn((channel: string, handler: IpcHandler) => mocks.listeners.set(channel, handler)),
  },
  nativeTheme: { themeSource: 'system' },
  shell: { openExternal: mocks.openExternal },
  clipboard: { writeText: mocks.clipboardWriteText },
}));

vi.mock('../../../src/main/window/main-window', () => ({
  getMainWindow: mocks.getMainWindow,
  showMainWindow: mocks.showMainWindow,
  applyWindowVibrancy: mocks.applyWindowVibrancy,
  markQuitting: mocks.markQuitting,
  sendToRenderer: vi.fn(),
}));
vi.mock('../../../src/main/browser/browser-view', () => ({
  restoreBrowser: mocks.browserGetState,
  suspendBrowser: vi.fn(),
  setBrowserPagePersistence: vi.fn(),
  setLocalPagesExtraPrivileges: vi.fn(),
  setLocalPagesPolicy: vi.fn(),
  agentLocalFilesEnabled: () => false,
  browserLocalPagesAllowed: async () => false,
  navigateBrowser: mocks.browserNavigate,
  openBrowserLocalFile: mocks.openBrowserLocalFile,
  isLocalFileUrl: (value: string) => value.startsWith('file:'),
  getBrowserGeneration: mocks.browserGeneration,
  getBrowserState: mocks.browserGetState,
  getBrowserPage: vi.fn(() => null),
  listBrowserStates: vi.fn(() => []),
  takeLocalLinkGrant: mocks.takeLocalLinkGrant,
  browserGoBack: mocks.browserBack,
  browserGoForward: mocks.browserForward,
  browserReload: mocks.browserReload,
  browserTabCommand: mocks.browserTabCommand,
  browserFind: mocks.browserFind,
  browserStopFind: mocks.browserStopFind,
  browserPrint: mocks.browserPrint,
  browserZoom: mocks.browserZoom,
  toggleBrowserDeviceMode: mocks.browserToggleDeviceMode,
  updateBrowserDeviceMode: mocks.browserSetDeviceMode,
  captureBrowserScreenshot: mocks.browserCaptureScreenshot,
  updateBrowserFocusEmulation: mocks.browserFocusEmulation,
  browserIdsForSite: mocks.browserIdsForSite,
  clearBrowserSiteData: mocks.clearBrowserSiteData,
  captureBrowserBackdrop: mocks.browserCaptureBackdrop,
  applyDefaultBrowserZoom: mocks.browserApplyDefaultZoom,
  applyBrowserAutoplayPolicy: mocks.browserApplyAutoplay,
  applyBrowserSound: mocks.browserApplySound,
  retryBrowserViewDownload: mocks.browserRetryDownload,
  clearBrowserData: mocks.browserClearData,
  setBrowserBounds: mocks.browserSetBounds,
  setBrowserVisible: mocks.browserSetVisible,
  closeBrowser: mocks.browserClose,
  cloneBrowser: mocks.browserClone,
}));
vi.mock('../../../src/main/browser/local-pages-policy', () => ({ createLocalPagesPolicy: () => Object.assign(mocks.localPagesAllowed, { extraPrivileges: () => true }) }));
vi.mock('../../../src/main/browser/browser-data', () => ({
  getBrowserData: mocks.browserGetData,
  updateBrowserPreferences: mocks.browserUpdatePreferences,
  clearBrowserHistory: mocks.browserClearHistory,
  clearBrowserDownloads: mocks.browserClearDownloads,
  getBrowserDownloadItems: mocks.browserDownloadItems,
  refreshBrowserDownloadFiles: mocks.browserRefreshDownloadFiles,
  readBrowserDownloads: mocks.browserReadDownloads,
  openBrowserDownload: mocks.browserOpenDownload,
  controlBrowserDownload: mocks.browserControlDownload,
  removeBrowserDownload: mocks.browserRemoveDownload,
  onBrowserDownloadsChanged: (listener: () => void) => { mocks.browserDownloadsListeners.push(listener); return () => {}; },
}));
vi.mock('../../../src/main/browser/browser-sites', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../../src/main/browser/browser-sites')>(),
  forgetBrowserSiteVisits: mocks.forgetSiteVisits,
  updateBrowserSiteAutoplay: mocks.updateSiteAutoplay,
  updateBrowserSiteSound: mocks.updateSiteSound,
}));
vi.mock('../../../src/main/browser/browser-overlay', () => ({
  openBrowserOverlayMenu: mocks.browserOverlayOpen,
  closeBrowserOverlayMenu: mocks.browserOverlayClose,
  openBrowserOverlayDialog: mocks.browserOverlayDialogOpen,
  closeBrowserOverlayDialog: mocks.browserOverlayDialogClose,
  markBrowserOverlayReady: mocks.browserOverlayReady,
  showBrowserOverlayRendered: mocks.browserOverlayRendered,
  markBrowserOverlayHidden: mocks.browserOverlayHidden,
  activateBrowserOverlayItem: mocks.browserOverlayActivate,
  dismissBrowserOverlay: mocks.browserOverlayDismiss,
  isBrowserOverlaySender: vi.fn((sender: unknown) => sender === mocks.overlaySender),
}));
vi.mock('../../../src/main/server/connect', () => ({ readServerToken: vi.fn() }));
vi.mock('../../../src/main/system/open-in', () => ({
  listAvailableOpenInApps: mocks.listAvailableOpenInApps,
  openInApp: mocks.openInApp,
}));
vi.mock('../../../src/main/release/updater', () => ({
  getUpdateAutoDownload: vi.fn(() => false),
  getUpdateStatus: vi.fn(() => ({ state: 'idle' })),
  requestUpdateCheck: vi.fn(),
  requestUpdateDownload: vi.fn(),
  requestUpdateInstall: vi.fn(),
  setUpdateAutoDownload: vi.fn(),
}));
vi.mock('../../../src/main/shell/tray', () => ({
  asTrayAttention: vi.fn(() => null),
  setTrayAttention: vi.fn(),
  setTrayLocale: vi.fn(),
}));
vi.mock('../../../src/main/shell/context-menu', () => ({ setContextMenuLocale: vi.fn(), effectiveContextMenuLocale: () => mocks.contextMenuLocale }));
vi.mock('../../../src/main/shell/jump-list', () => ({
  asJumpListWorkspaces: vi.fn(() => null),
  setJumpListLocale: vi.fn(),
  updateJumpList: vi.fn(),
}));
vi.mock('../../../src/main/shell/menu', () => ({
  popupWindowsMenu: vi.fn(),
  setMenuLocale: vi.fn(),
  setMenuShortcuts: vi.fn(),
  setMenuSuspended: vi.fn(),
  setTerminalMenuFocus: vi.fn(),
  onTerminalMenuFocus: vi.fn(),
}));
vi.mock('../../../src/main/shell/shortcuts', () => ({
  setGlobalShortcut: mocks.setGlobalShortcut,
  setGlobalShortcutForAction: mocks.setGlobalShortcut,
  setGlobalShortcutSuspended: vi.fn(() => true),
  setGlobalShortcutTerminalFocus: vi.fn(),
}));
vi.mock('../../../src/main/system/shell-env', () => ({ startShellEnvProbe: vi.fn() }));
vi.mock('../../../src/main/screenshot/controller', () => ({
  captureScreenshot: mocks.captureScreenshot,
  cancelScreenshotCapture: mocks.cancelScreenshotCapture,
  setScreenshotLocale: vi.fn(),
}));
vi.mock('../../../src/main/terminal/manager', () => ({
  getTerminalManager: vi.fn(() => mocks.terminalManager),
  initTerminalManager: vi.fn(),
}));
vi.mock('../../../src/main/app/ui-state', async importOriginal => ({
  ...await importOriginal<typeof import('../../../src/main/app/ui-state')>(),
  isVibrancyEnabled: vi.fn(() => true),
  isLinuxNativeTitleBar: mocks.isLinuxNativeTitleBar,
  markOnboarded: vi.fn(),
  setVibrancyEnabled: mocks.setVibrancyEnabled,
  setColorScheme: mocks.setColorScheme,
  setPreventSystemSleep: mocks.setPreventSystemSleep,
  setLinuxNativeTitleBar: mocks.setLinuxNativeTitleBar,
}));
vi.mock('../../../src/main/system/power-save-blocker', () => ({
  isPowerSaveBlockerEnabled: mocks.isPowerSaveBlockerEnabled,
  setPowerSaveBlockerEnabled: mocks.setPowerSaveBlockerEnabled,
}));
vi.mock('../../../src/main/system/prevent-lid-sleep', () => ({
  getPreventSleepState: mocks.getPreventSleepState,
  setSystemSleepPreventionEnabled: mocks.setSystemSleepPreventionEnabled,
  setLidSleepPreventionEnabled: mocks.setLidSleepPreventionEnabled,
}));
vi.mock('../../../src/main/browser/browser-agent-control', () => ({
  setBrowserAgentControl: mocks.setBrowserAgentControl,
  setBrowserSubagentControl: mocks.setBrowserSubagentControl,
}));
vi.mock('../../../src/main/shell/dock-icon', () => ({
  isDockIconChoice: vi.fn((value: unknown) => value === 'light' || value === 'dark'),
  setDockIconChoice: mocks.setDockIconChoice,
}));
vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { error: vi.fn() },
  redactUrlForLog: vi.fn((url: string) => url),
}));
vi.mock('../../../src/main/diagnostics/renderer-log', () => ({ createRendererLogWriter: vi.fn(() => vi.fn()) }));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: mocks.trackDesktopEvent, trySendDesktopEvent: vi.fn() }));
vi.mock('../../../src/main/app/quit-confirm', () => ({
  resolveQuitConfirmResponse: mocks.resolveQuitConfirmResponse,
  setQuitConfirmLocale: vi.fn(),
  shouldBlockQuit: mocks.shouldBlockQuit,
}));
vi.mock('../../../src/main/release/stable-settings-import', () => ({
  stableSettingsPrecheck: mocks.stableSettingsPrecheck,
  stableUserDataDir: vi.fn(() => '/tmp/stable-user-data'),
  writeImportMarker: mocks.writeImportMarker,
}));

import { registerIpcHandlers } from '../../../src/main/ipc/register';
import { getMainWindow, sendToRenderer } from '../../../src/main/window/main-window';
import { setMenuShortcuts } from '../../../src/main/shell/menu';

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
  mocks.browserDownloadsListeners.length = 0;
  mocks.getMainWindow.mockReturnValue(null);
  mocks.isPowerSaveBlockerEnabled.mockReturnValue(false);
  registerIpcHandlers();
});

describe('screenshot sender isolation', () => {
  it.each(['preview', 'missing', 'destroyed', 'main'])('only accepts the live main renderer (%s)', async (source) => {
    const mainWebContents = {};
    vi.mocked(getMainWindow).mockReturnValue(source === 'missing' ? null : {
      webContents: mainWebContents,
      isDestroyed: () => source === 'destroyed',
    } as ReturnType<typeof getMainWindow>);
    const event = { sender: source === 'preview' ? {} : mainWebContents };
    try {
      if (source === 'main') {
        await expect(handler(IPC.screenshotCapture)(event)).resolves.toEqual({ status: 'cancelled' });
        expect(mocks.captureScreenshot).toHaveBeenCalledOnce();
      } else {
        expect(() => handler(IPC.screenshotCapture)(event)).toThrow('screenshot-capture: unknown sender');
        expect(mocks.captureScreenshot).not.toHaveBeenCalled();
      }
      listener(IPC.screenshotCancel)(event);
      expect(mocks.cancelScreenshotCapture).toHaveBeenCalledTimes(source === 'main' ? 1 : 0);
    } finally {
      vi.mocked(getMainWindow).mockReturnValue(null);
    }
  });
});

describe('open-in catalog file path', () => {
  it('passes a validated file path through to listAvailableOpenInApps', async () => {
    await handler(IPC.openInList)({}, '/work/index.html');
    expect(mocks.listAvailableOpenInApps).toHaveBeenCalledWith({ filePath: '/work/index.html' });
  });

  it('drops blank or non-string file paths', async () => {
    await handler(IPC.openInList)({}, '   ');
    await handler(IPC.openInList)({}, 42);
    await handler(IPC.openInList)({});
    expect(mocks.listAvailableOpenInApps.mock.calls).toEqual([
      [{ filePath: undefined }],
      [{ filePath: undefined }],
      [{ filePath: undefined }],
    ]);
  });
});

describe('theme', () => {
  it('applies a valid color scheme and remembers it for the next launch', () => {
    listener(IPC.theme)({}, 'dark');
    listener(IPC.theme)({}, 'sepia');
    expect(mocks.setColorScheme.mock.calls).toEqual([['dark']]);
  });
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

describe('preventSystemSleep channel', () => {
  it('accepts display prevention and rejects obsolete boolean input', async () => {
    await expect(handler(IPC.preventSystemSleep)({}, 'prevent-display-sleep')).resolves.toEqual({ system: 'prevent-display-sleep', lid: false, lidSupported: true });
    expect(mocks.setSystemSleepPreventionEnabled).toHaveBeenCalledWith('prevent-display-sleep');
    mocks.setSystemSleepPreventionEnabled.mockClear();
    await handler(IPC.preventSystemSleep)({}, true);
    expect(mocks.setSystemSleepPreventionEnabled).not.toHaveBeenCalled();
  });
  it('delegates to the prevention module with mode validation and returns state', async () => {
    await expect(handler(IPC.preventSystemSleep)({}, 'prevent-app-suspension')).resolves.toEqual({ system: 'prevent-app-suspension', lid: false, lidSupported: true });
    await handler(IPC.preventSystemSleep)({}, 'allow-sleep');
    expect(mocks.setSystemSleepPreventionEnabled.mock.calls).toEqual([['prevent-app-suspension'], ['allow-sleep']]);

    mocks.getPreventSleepState.mockClear();
    await expect(handler(IPC.preventSystemSleep)({}, 'yes')).resolves.toEqual({ system: 'allow-sleep', lid: false, lidSupported: true });
    expect(mocks.setSystemSleepPreventionEnabled).toHaveBeenCalledTimes(2);
    expect(mocks.getPreventSleepState).toHaveBeenCalledTimes(1);

    expect(mocks.trackDesktopEvent.mock.calls).toEqual([
      ['native_ipc_used', { channel: 'prevent-system-sleep' }],
      ['native_ipc_used', { channel: 'prevent-system-sleep' }],
    ]);

    mocks.isPowerSaveBlockerEnabled.mockReturnValue(true);
    expect(handler(IPC.getPreventSystemSleep)({})).toBe(true);
  });

  it('serves the aggregated state and toggles lid sleep prevention', async () => {
    await expect(handler(IPC.preventSleepState)({})).resolves.toEqual({ system: 'allow-sleep', lid: false, lidSupported: true });

    await expect(handler(IPC.setPreventLidSleep)({}, true)).resolves.toEqual({ system: 'prevent-app-suspension', lid: true, lidSupported: true });
    await handler(IPC.setPreventLidSleep)({}, 'yes');
    expect(mocks.setLidSleepPreventionEnabled.mock.calls).toEqual([[true]]);
    expect(mocks.trackDesktopEvent.mock.calls).toEqual([['native_ipc_used', { channel: 'prevent-lid-sleep' }]]);
  });
});

describe('linuxNativeTitleBar channel', () => {
  const realPlatform = process.platform;

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
  });

  function stubLinux(): void {
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
  }

  it('returns unavailable outside linux and never relaunches', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: { id: 1 } });
    const sender = mocks.getMainWindow()!.webContents;
    await expect(handler(IPC.linuxNativeTitleBar)({ sender }, true)).resolves.toEqual({ status: 'unavailable' });
    expect(mocks.setLinuxNativeTitleBar).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
  });

  it('accepts only boolean payloads from the main window and relaunches', async () => {
    stubLinux();
    const mainWebContents = { id: 1 };
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainWebContents });
    const channel = handler(IPC.linuxNativeTitleBar);

    await expect(channel({ sender: { id: 2 } }, true)).resolves.toEqual({ status: 'unavailable' });
    await expect(channel({ sender: mainWebContents }, 'yes')).resolves.toEqual({ status: 'unavailable' });
    expect(mocks.setLinuxNativeTitleBar).not.toHaveBeenCalled();

    await expect(channel({ sender: mainWebContents }, true)).resolves.toEqual({ status: 'relaunching' });
    expect(mocks.setLinuxNativeTitleBar).toHaveBeenCalledWith(true);
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('native_ipc_used', { channel: 'linux-native-titlebar' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.markQuitting).toHaveBeenCalledOnce();
    expect(mocks.appRelaunch).toHaveBeenCalledOnce();
    expect(mocks.appQuit).toHaveBeenCalledOnce();
    expect(mocks.appExit).not.toHaveBeenCalled();
  });

  it('cancels the relaunch when busy sessions block the quit', async () => {
    stubLinux();
    const mainWebContents = { id: 1 };
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainWebContents });
    mocks.shouldBlockQuit.mockResolvedValueOnce(true);
    await expect(handler(IPC.linuxNativeTitleBar)({ sender: mainWebContents }, true)).resolves.toEqual({ status: 'cancelled' });
    expect(mocks.setLinuxNativeTitleBar).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
  });

  it('reports an error instead of relaunching when the setting fails to persist', async () => {
    stubLinux();
    const mainWebContents = { id: 1 };
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainWebContents });
    mocks.isLinuxNativeTitleBar.mockReturnValueOnce(false);
    await expect(handler(IPC.linuxNativeTitleBar)({ sender: mainWebContents }, true)).resolves.toEqual({ status: 'error' });
    expect(mocks.setLinuxNativeTitleBar).toHaveBeenCalledWith(true);
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('native_ipc_used', { channel: 'linux-native-titlebar' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
  });
});

describe('menuShortcut sender gating', () => {  it('accepts the pushed shortcut map only from the main window webContents', () => {
    const mainWebContents = { id: 1 };
    const previewWebContents = { id: 2 };
    const menuShortcut = listener(IPC.menuShortcut);

    vi.mocked(getMainWindow).mockImplementationOnce(
      () => ({ webContents: mainWebContents }) as unknown as ReturnType<typeof getMainWindow>,
    );
    menuShortcut({ sender: previewWebContents }, { closeSessionView: 'mod+w' });
    expect(vi.mocked(setMenuShortcuts)).not.toHaveBeenCalled();

    vi.mocked(getMainWindow).mockImplementationOnce(
      () => ({ webContents: mainWebContents }) as unknown as ReturnType<typeof getMainWindow>,
    );
    menuShortcut({ sender: mainWebContents }, { closeSessionView: null });
    expect(vi.mocked(setMenuShortcuts)).toHaveBeenCalledWith({ closeSessionView: null });
  });
});

describe('openExternal whitelist', () => {
  it('rejects non-http(s) URLs before touching the shell, allows http(s)', async () => {
    expect(() => handler(IPC.openExternal)({}, 'file:///etc/passwd')).toThrow('http(s)');
    expect(() => handler(IPC.openExternal)({}, 'javascript:alert(1)')).toThrow('http(s)');
    expect(mocks.openExternal).not.toHaveBeenCalled();

    await handler(IPC.openExternal)({}, 'https://kimi.com');
    expect(mocks.openExternal).toHaveBeenCalledWith('https://kimi.com');
  });
});

describe('writeClipboardText', () => {
  it('writes string payloads through the native clipboard and rejects other payloads', async () => {
    expect(handler(IPC.writeClipboardText)({}, 42)).toBe(false);
    expect(mocks.clipboardWriteText).not.toHaveBeenCalled();

    expect(handler(IPC.writeClipboardText)({}, 'session-1')).toBe(true);
    expect(mocks.clipboardWriteText).toHaveBeenCalledWith('session-1');
  });
});

describe('native browser IPC', () => {
  it('restricts browser permission decisions to the main renderer', () => {
    const sender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: sender });
    expect(() => handler(IPC.browserGetPermissionRequests)({ sender: {} })).toThrow('Unknown browser permission sender');
    expect(() => handler(IPC.browserResolvePermissionRequest)({ sender: {} }, { requestId: 'permission-1', decision: 'allow-always' })).toThrow('Invalid browser permission decision');
    expect(() => handler(IPC.browserResolvePermissionRequest)({ sender }, { requestId: 'permission-1', decision: 'approve' })).toThrow('Invalid browser permission decision');
    expect(handler(IPC.browserGetPermissionRequests)({ sender })).toEqual([]);
    expect(handler(IPC.browserResolvePermissionRequest)({ sender }, { requestId: 'expired', decision: 'allow-once' })).toBe(false);
  });

  it.each([
    [IPC.browserNavigate, { browserId: 'browser-1', address: 'example.com' }, 'browserNavigate'],
    [IPC.browserBack, 'browser-1', 'browserBack'],
    [IPC.browserForward, 'browser-1', 'browserForward'],
    [IPC.browserReload, 'browser-1', 'browserReload'],
    [IPC.browserFind, { browserId: 'browser-1', text: 'target', forward: true, findNext: false }, 'browserFind'],
    [IPC.browserPrint, 'browser-1', 'browserPrint'],
    [IPC.browserZoom, { browserId: 'browser-1', action: 'in' }, 'browserZoom'],
    [IPC.browserToggleDeviceMode, 'browser-1', 'browserToggleDeviceMode'],
    [IPC.browserSetFocusEmulation, { browserId: 'browser-1', enabled: true }, 'browserFocusEmulation'],
    [IPC.browserCaptureScreenshot, 'browser-1', 'browserCaptureScreenshot'],
    [IPC.browserSetDeviceMode, { browserId: 'browser-1', request: { enabled: false } }, 'browserSetDeviceMode'],
    [IPC.browserPickAnnotation, { browserId: 'browser-1', options: { borderColor: '#1783ff', ancestorColor: '#bc4c00', fillColor: 'rgba(23, 131, 255, 0.25)', borderRadius: '0px', transitionDuration: '0ms', transitionTiming: 'ease-out', labelColor: 'white', labelFont: 'monospace', labelFontSize: '12px', labelPadding: '2px 4px', labelGap: '4px', labelMaxWidth: '360px', regionLabel: 'Region' } }, 'browserPickAnnotation'],
  ] as const)('takes control before user command %s', async (channel, payload, operation) => {
    const sender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: sender });
    await handler(channel)({ sender }, payload);
    expect(mocks.takeOverBrowser).toHaveBeenCalledExactlyOnceWith('browser-1');
    expect(mocks.takeOverBrowser.mock.invocationCallOrder[0]).toBeLessThan(mocks[operation].mock.invocationCallOrder[0]!);
  });

  it.each([
    [IPC.browserUpdatePreferences, { defaultZoomFactor: 1.25 }, 'browserApplyDefaultZoom'],
    [IPC.browserClearData, 'browser-1', 'browserClearData'],
  ] as const)('revokes all controls before the global mutation %s', async (channel, payload, operation) => {
    const sender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: sender });
    await handler(channel)({ sender }, payload);
    expect(mocks.takeOverAllBrowsers).toHaveBeenCalledOnce();
    expect(mocks.takeOverAllBrowsers.mock.invocationCallOrder[0]).toBeLessThan(mocks[operation].mock.invocationCallOrder[0]!);
  });

  it('lets the control layer decide on a takeover before closing a page', () => {
    const sender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: sender });
    listener(IPC.browserClose)({ sender }, 'browser-1');
    expect(mocks.takeOverClosedBrowser).toHaveBeenCalledExactlyOnceWith('browser-1');
    expect(mocks.takeOverClosedBrowser.mock.invocationCallOrder[0]).toBeLessThan(mocks.browserClose.mock.invocationCallOrder[0]!);
    listener(IPC.browserClose)({ sender }, 'bad id');
    listener(IPC.browserClose)({ sender: {} }, 'browser-2');
    expect(mocks.takeOverClosedBrowser).toHaveBeenCalledOnce();
  });

  it('revokes control of every tab on a site before clearing its data', async () => {
    const sender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: sender });
    mocks.browserIdsForSite.mockReturnValueOnce(['browser-1', 'browser-2']);
    await handler(IPC.browserClearSiteData)({ sender }, 'https://example.com/path');
    expect(mocks.browserIdsForSite).toHaveBeenCalledExactlyOnceWith('https://example.com');
    expect(mocks.takeOverBrowser.mock.calls).toEqual([['browser-1'], ['browser-2']]);
    expect(mocks.takeOverAllBrowsers).not.toHaveBeenCalled();
    expect(mocks.takeOverBrowser.mock.invocationCallOrder.at(-1)).toBeLessThan(mocks.clearBrowserSiteData.mock.invocationCallOrder[0]!);
    expect(mocks.clearBrowserSiteData).toHaveBeenCalledExactlyOnceWith('https://example.com');
  });

  it('validates and projects focus emulation requests before applying them', () => {
    const sender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: sender });
    handler(IPC.browserSetFocusEmulation)({ sender }, { browserId: 'browser-1', enabled: true, extra: true });
    expect(mocks.browserFocusEmulation).toHaveBeenCalledExactlyOnceWith('browser-1', true);
    expect(() => handler(IPC.browserSetFocusEmulation)({ sender }, { browserId: 'browser-1', enabled: 'yes' })).toThrow();
    expect(() => handler(IPC.browserSetFocusEmulation)({ sender: {} }, { browserId: 'browser-1', enabled: true })).toThrow();
  });

  it('applies the agent control preference to the browser MCP after saving it', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    mocks.browserUpdatePreferences.mockReturnValueOnce({
      history: [],
      preferences: { agentControl: false, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
      defaultUserAgent: 'Mozilla/5.0',
    });
    await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { agentControl: false });
    expect(mocks.browserUpdatePreferences).toHaveBeenCalledWith({ agentControl: false });
    expect(mocks.setBrowserAgentControl).toHaveBeenCalledExactlyOnceWith(false);
    expect(mocks.browserApplyDefaultZoom).not.toHaveBeenCalled();
    expect(() => handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { agentControl: 'no' })).toThrow('invalid payload');
    expect(mocks.setBrowserAgentControl).toHaveBeenCalledOnce();
  });

  it('applies global autoplay immediately and emits only fixed settings telemetry', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    mocks.browserUpdatePreferences.mockReturnValueOnce({
      history: [],
      preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'allow', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
      defaultUserAgent: 'Mozilla/5.0',
    });
    await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { autoplay: 'allow' });
    expect(mocks.browserApplyAutoplay).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledExactlyOnceWith('settings_changed', { key: 'browser-autoplay', value: 'allow', source_panel: 'settings' });
    expect(() => handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { autoplay: 'https://example.test/media' })).toThrow('invalid payload');
  });

  it('applies origin autoplay without emitting site telemetry', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    await handler(IPC.browserSetSiteAutoplay)({ sender: mainSender }, { origin: 'https://example.test/path', setting: 'block' });
    expect(mocks.updateSiteAutoplay).toHaveBeenCalledExactlyOnceWith('https://example.test', 'block');
    expect(mocks.browserApplyAutoplay).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
    expect(() => handler(IPC.browserSetSiteAutoplay)({ sender: mainSender }, { origin: 'https://example.test', setting: 'https://example.test/media' })).toThrow('Invalid site autoplay setting');
  });

  it('applies sound immediately and tracks only the global setting', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    mocks.browserUpdatePreferences.mockReturnValueOnce({
      history: [],
      preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'on', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
      defaultUserAgent: 'Mozilla/5.0',
    });
    await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { sound: 'on' });
    expect(mocks.browserApplySound).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledExactlyOnceWith('settings_changed', { key: 'browser-sound', value: 'on', source_panel: 'settings' });
    await handler(IPC.browserSetSiteSound)({ sender: mainSender }, { origin: 'https://example.test/path', setting: 'muted' });
    expect(mocks.updateSiteSound).toHaveBeenCalledExactlyOnceWith('https://example.test', 'muted');
    expect(mocks.browserApplySound).toHaveBeenCalledTimes(2);
    expect(mocks.trackDesktopEvent).toHaveBeenCalledOnce();
    expect(() => handler(IPC.browserSetSiteSound)({ sender: mainSender }, { origin: 'https://example.test', setting: 'loud' })).toThrow('Invalid site sound setting');
  });

  it('applies subagent control through its independent preference setter', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    mocks.browserUpdatePreferences.mockReturnValueOnce({
      history: [],
      preferences: { agentControl: true, subagentControl: true, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
      defaultUserAgent: 'Mozilla/5.0',
    });
    await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { subagentControl: true });
    expect(mocks.browserUpdatePreferences).toHaveBeenCalledWith({ subagentControl: true });
    expect(mocks.setBrowserSubagentControl).toHaveBeenCalledExactlyOnceWith(true);
    expect(mocks.setBrowserAgentControl).not.toHaveBeenCalled();
    expect(() => handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { subagentControl: 'yes' })).toThrow('invalid payload');
    expect(mocks.setBrowserSubagentControl).toHaveBeenCalledOnce();
  });

  it('preserves subagent controllers from real preferences through direct and dynamic execution', async () => {
    const home = mkdtempSync(join(tmpdir(), 'desktop-browser-preference-ipc-'));
    const [
      { app },
      { startServer },
      core,
      { ISessionEventBus },
      { startDesktopBrowserMcp },
      { createDesktopBrowserAccess, registerDesktopBrowserMcp },
      automation,
      { isBrowserUiRequest },
      { browserCommandTakesControl },
      actualControls,
      actualData,
      actualUiState,
      { rm },
    ] = await Promise.all([
      import('electron'),
      import('@moonshot-ai/kap-server'),
      import('@moonshot-ai/agent-core-v2'),
      import('@moonshot-ai/agent-core-v2/app/event/eventBus'),
      import('../../../src/main/browser/browser-mcp'),
      import('../../../src/main/browser/browser-mcp-registration'),
      import('../../../src/main/browser/browser-automation'),
      import('../../../src/shared/browser-automation'),
      import('../../../src/renderer/lib/browserExecutionReadiness'),
      vi.importActual<typeof import('../../../src/main/browser/browser-agent-control')>('../../../src/main/browser/browser-agent-control'),
      vi.importActual<typeof import('../../../src/main/browser/browser-data')>('../../../src/main/browser/browser-data'),
      vi.importActual<typeof import('../../../src/main/app/ui-state')>('../../../src/main/app/ui-state'),
      import('node:fs/promises'),
    ]);
    const originalUpdate = mocks.browserUpdatePreferences.getMockImplementation();
    const originalNavigate = mocks.browserNavigate.getMockImplementation();
    const originalGetState = mocks.browserGetState.getMockImplementation();
    const originalAgentSetter = mocks.setBrowserAgentControl.getMockImplementation();
    const originalSubagentSetter = mocks.setBrowserSubagentControl.getMockImplementation();
    const mainSender = {};
    const pageStates = new Map<string, { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }>();
    const emptyPage = () => ({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false });
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    vi.mocked(app).getPath.mockImplementation(name => name === 'userData' ? home : `/tmp/${name}`);
    mocks.browserUpdatePreferences.mockImplementation(actualData.updateBrowserPreferences);
    mocks.setBrowserAgentControl.mockImplementation(actualControls.setBrowserAgentControl);
    mocks.setBrowserSubagentControl.mockImplementation(actualControls.setBrowserSubagentControl);
    mocks.browserGetState.mockImplementation(browserId => pageStates.get(browserId) ?? emptyPage());
    mocks.browserNavigate.mockImplementation(async (browserId, url) => {
      const next = { url, title: `Title: ${url}`, loading: false, canGoBack: true, canGoForward: false };
      pageStates.set(browserId, next);
      return next;
    });
    let server: Awaited<ReturnType<typeof startServer>> | undefined;
    let browser: Awaited<ReturnType<typeof startDesktopBrowserMcp>> | undefined;
    let registration: ReturnType<typeof registerDesktopBrowserMcp> | undefined;
    let closeHost: (() => void) | undefined;
    try {
      expect(actualControls.browserAgentControl.enabled()).toBe(true);
      expect(actualControls.browserSubagentControl.enabled()).toBe(false);
      const access = createDesktopBrowserAccess(actualControls.browserAgentControl, actualControls.browserSubagentControl);
      browser = await startDesktopBrowserMcp({ access });
      server = await startServer({
        hostIdentity: { productName: 'test-host', platform: 'test_platform', version: '0.0.0' },
        homeDir: home,
        port: 0,
        logLevel: 'silent',
        env: { ...process.env, KIMI_CODE_EXPERIMENTAL_PERSISTENCE_MINIDB_READMODEL: 'false', KIMI_CODE_EXPERIMENTAL_SEARCH_WORKER: 'false' },
      });
      registration = registerDesktopBrowserMcp(server.core, browser.config, access);
      const sessions = server.core.accessor.get(core.ISessionManager);
      const session = await sessions.create({ workDir: home });
      await session.accessor.get(core.ISessionMcpHandle).ready;
      const lifecycle = session.accessor.get(core.IAgentLifecycleService);
      if (lifecycle.handleOf('main') === undefined) await lifecycle.create({ agentId: 'main' });
      const main = lifecycle.handleOf('main')!;
      main.accessor.get(core.IAgentPermissionModeService).setMode('yolo');
      const workerContext = await lifecycle.create({ agentId: 'worker' });
      const directContext = await lifecycle.create({ agentId: 'direct' });
      session.accessor.get(ISessionEventBus).publish(new core.SubagentSpawned({
        subagentId: 'worker', subagentName: 'coder', parentToolCallId: 'parent-call', description: 'Open site', runInBackground: true,
      }));
      type Agent = NonNullable<ReturnType<typeof lifecycle.handleOf>>;
      const prepare = async (agentId: string, dynamic: boolean, turnId: number) => {
        const agent = lifecycle.handleOf(agentId)!;
        const profile = agent.accessor.get(core.IAgentProfileService);
        const data = profile.data();
        vi.spyOn(profile, 'data').mockReturnValue({ ...data, profileName: 'coder' });
        vi.spyOn(profile, 'getModelCapabilities').mockReturnValue({
          image_in: true, video_in: false, audio_in: false, thinking: false, tool_use: true,
          max_context_tokens: 128000, dynamically_loaded_tools: dynamic,
        });
        await agent.accessor.get(core.IAgentMcpService).waitForInitialLoad();
        agent.accessor.get(core.IAgentPermissionModeService).setMode('yolo');
        const loop = agent.accessor.get(core.IAgentLoopService);
        const base = loop.snapshot();
        const activity = { running: true, turnId };
        vi.spyOn(loop, 'snapshot').mockImplementation(() => ({
          ...base,
          state: activity.running ? 'running' : 'idle',
          activeTurnId: activity.turnId,
        }));
        if (dynamic) expect(agent.accessor.get(core.IAgentToolSelectService).load(['mcp__desktop_browser__run']).toLoad).toEqual(['mcp__desktop_browser__run']);
        return { agent, activity };
      };
      await prepare('main', false, 1);
      const worker = await prepare('worker', true, 7);
      const direct = await prepare('direct', false, 8);
      const name = 'mcp__desktop_browser__run';
      const protocol = 'kimi.browser/1.0.0';
      const resolve = (agent: Agent, operation: string, fields: Record<string, unknown> = {}) => agent.accessor.get(core.IAgentToolRegistryService).resolve(name)!.resolveExecution({ protocol, operation, ...fields });
      const dynamicCreate = await resolve(worker.agent, 'browser.create_tab', { url: 'https://example.com/' });
      const directCreate = await resolve(direct.agent, 'browser.create_tab', { url: 'https://example.com/' });
      if (!('execute' in dynamicCreate) || !('execute' in directCreate)) throw new Error('browser creation was not resolved');

      type UiState = import('../../../src/shared/browser-automation').BrowserUiState;
      type UiRequest = import('../../../src/shared/browser-automation').BrowserUiCommandRequest;
      type Controller = import('../../../src/shared/browser-run').BrowserController;
      let state: UiState = { turnId: null, panelVisible: false, activeTabId: null, controlledTabId: null, controlledLeaseId: null, tabs: [] };
      let controlledController: Controller | undefined;
      let mainRunning = false;
      let tabSequence = 0;
      let leaseSequence = 0;
      const mainRequests: unknown[] = [];
      const rendererRequests: UiRequest[] = [];
      const responseState = (): UiState => ({ ...state, turnId: mainRunning ? 'main-turn' : null, ...(controlledController === undefined ? {} : { controlledController }) });
      const handlers = new Map<string, () => void>();
      const webContents = {
        send: vi.fn((_channel: string, payload: unknown) => {
          mainRequests.push(payload);
          if (!isBrowserUiRequest(payload) || !('command' in payload)) return;
          const request = structuredClone(payload);
          rendererRequests.push(request);
          const { command } = request;
          let error: string | undefined;
          if (controlledController === undefined && state.controlledTabId !== null && !mainRunning) {
            state = { ...state, controlledTabId: null, controlledLeaseId: null };
          }
          if (request.sessionId !== session.id) error = 'Browser request has no session identity.';
          else if (request.controller === undefined && browserCommandTakesControl(command.action) && !mainRunning) error = 'Browser control requires a running turn.';
          else if (command.action === 'create_tab') {
            const tabId = `tab-${++tabSequence}`;
            const browserId = `browser-${tabSequence}`;
            controlledController = request.controller;
            state = { ...state, controlledTabId: tabId, controlledLeaseId: `lease-${++leaseSequence}`, tabs: [...state.tabs, { tabId, browserId }] };
            pageStates.set(browserId, emptyPage());
          } else if (command.action === 'activate_tab') {
            if (!state.tabs.some(tab => tab.tabId === command.tabId)) error = `Browser tab "${command.tabId}" does not exist.`;
            else {
              controlledController = request.controller;
              state = { ...state, controlledTabId: command.tabId, controlledLeaseId: `lease-${++leaseSequence}` };
            }
          } else if (command.action === 'release_tab' || command.action === 'close_tab') {
            if (command.tabId !== state.controlledTabId || command.expectedLeaseId !== state.controlledLeaseId) error = 'Browser control changed; request a new operation under the current control.';
            else if (command.action === 'release_tab') {
              controlledController = undefined;
              state = { ...state, controlledTabId: null, controlledLeaseId: null };
            } else {
              controlledController = undefined;
              state = { ...state, controlledTabId: null, controlledLeaseId: null, tabs: state.tabs.filter(tab => tab.tabId !== command.tabId) };
            }
          }
          queueMicrotask(() => automation.handleBrowserUiResponse(webContents as never, {
            requestId: request.requestId,
            ok: error === undefined,
            ...(error === undefined ? { state: responseState() } : { error }),
          }));
        }),
      };
      const host = {
        webContents,
        once: (event: string, callback: () => void) => handlers.set(event, callback),
        isDestroyed: () => false,
      };
      closeHost = () => handlers.get('closed')?.();
      (await import('../../../src/main/browser/browser-control-ownership')).browserControlOwnership.reset();
      automation.attachBrowserAutomationWindow(host as never);

      await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { agentControl: true, subagentControl: true });
      expect(actualControls.browserAgentControl.enabled()).toBe(true);
      expect(actualControls.browserSubagentControl.enabled()).toBe(true);
      expect(actualUiState.getBrowserPreferences(join(home, 'ui-state.json'))).toMatchObject({ agentControl: true, subagentControl: true });
      expect((await dynamicCreate.execute({ turnId: 7, toolCallId: 'dynamic-create', signal: new AbortController().signal })).isError).not.toBe(true);
      expect((await directCreate.execute({ turnId: 8, toolCallId: 'direct-create', signal: new AbortController().signal })).isError).not.toBe(true);
      const workerRequest = rendererRequests.find(request => request.command.action === 'create_tab' && request.controller?.run.agentId === 'worker');
      const directRequest = rendererRequests.find(request => request.command.action === 'create_tab' && request.controller?.run.agentId === 'direct');
      expect(workerRequest?.controller).toEqual({ run: { agentId: 'worker', generation: workerContext.generation, turnId: 7 }, profile: 'coder', description: 'Open site' });
      expect(directRequest?.controller?.run).toEqual({ agentId: 'direct', generation: directContext.generation, turnId: 8 });
      expect(mainRequests).toContainEqual(workerRequest);
      expect(mainRequests).toContainEqual(directRequest);

      let callSequence = 0;
      const call = async (agent: Agent, turnId: number, operation: string, fields: Record<string, unknown> = {}) => {
        if (agent === main) return main.accessor.get(core.IAgentMcpService).resolved('desktop_browser')!.client.callTool('run', { protocol, operation, ...fields });
        const toolCall = { type: 'function' as const, id: `call-${++callSequence}`, name, arguments: JSON.stringify({ protocol, operation, ...fields }) };
        const executor = agent.accessor.get(core.IAgentToolExecutorService);
        const result = await executor.executor.execute(toolCall, { origin: 'loop', turnId });
        if ('detached' in result) throw new Error('unexpected detached tool result');
        return {
          output: result.content.every((part) => part.type === 'text') ? result.content.map((part) => part.type === 'text' ? part.text : '').join('') : result.content,
          isError: result.outcome.type === 'success' ? undefined : true,
        };
      };
      expect((await call(worker.agent, 7, 'browser.activate_tab', { tabId: 'tab-2' })).isError).not.toBe(true);
      expect((await call(direct.agent, 8, 'browser.activate_tab', { tabId: 'tab-1' })).isError).not.toBe(true);
      expect(pageStates.get('browser-1')?.url).toBe('https://example.com/');
      expect(pageStates.get('browser-2')?.url).toBe('https://example.com/');

      const mainDenied = await main.accessor.get(core.IAgentMcpService).resolved('desktop_browser')!.client.callTool('run', { protocol, operation: 'browser.create_tab', url: 'https://example.com/' });
      expect(mainDenied.isError).toBe(true);
      expect(JSON.stringify(mainDenied.content)).toContain('Browser control requires a running turn.');

      let requestCount = rendererRequests.length;
      await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { subagentControl: false });
      expect((await call(worker.agent, 7, 'browser.get_state')).isError).toBe(true);
      expect(rendererRequests).toHaveLength(requestCount);
      await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { subagentControl: true });
      worker.activity.running = false;
      expect((await call(worker.agent, 7, 'browser.get_state')).isError).toBe(true);
      expect(rendererRequests).toHaveLength(requestCount);
      worker.activity.running = true;
      expect((await call(worker.agent, 9, 'browser.get_state')).isError).toBe(true);
      expect(rendererRequests).toHaveLength(requestCount);

      expect((await call(worker.agent, 7, 'browser.release_tab', { tabId: 'tab-1' })).isError).toBe(true);
      const directNavigation = await call(direct.agent, 8, 'tab.navigate', { tabId: 'tab-1', url: 'https://example.org/' });
      expect(directNavigation.isError, JSON.stringify(directNavigation)).not.toBe(true);
      mainRunning = true;
      expect((await call(main, 1, 'browser.activate_tab', { tabId: 'tab-1' })).isError).not.toBe(true);
      expect((await call(worker.agent, 7, 'browser.activate_tab', { tabId: 'tab-1' })).isError).not.toBe(true);
      const mainRelease = await call(main, 1, 'browser.release_tab', { tabId: 'tab-1' });
      expect(mainRelease.isError).toBe(true);
      expect(JSON.stringify(mainRelease)).toContain('TAB_NOT_ACTIVE');
      expect((await call(worker.agent, 7, 'tab.navigate', { tabId: 'tab-1', url: 'https://example.net/' })).isError).not.toBe(true);
      const currentRun = access.runs.resolve(session.id, { agentId: 'worker', generation: workerContext.generation, turnId: 7 })!;
      const currentState = await automation.runBrowserAutomation({ protocol, operation: 'browser.get_state' }, undefined, session.id, currentRun);
      expect(currentState.browser?.activeTabId, JSON.stringify(currentState)).toBe('tab-1');
      expect((await call(main, 1, 'browser.activate_tab', { tabId: 'tab-1' })).isError).not.toBe(true);
      expect(controlledController, JSON.stringify(rendererRequests.slice(-4))).toBeUndefined();
      const workerClose = await call(worker.agent, 7, 'browser.close_tab', { tabId: 'tab-1' });
      expect(JSON.stringify(workerClose)).toContain('TAB_NOT_ACTIVE');
      expect((await call(main, 1, 'tab.navigate', { tabId: 'tab-1', url: 'https://example.org/' })).isError).not.toBe(true);
      expect((await call(main, 1, 'browser.close_tab', { tabId: 'tab-1' })).isError).not.toBe(true);
      expect(state.tabs.map(tab => tab.tabId)).toEqual(['tab-2']);
      requestCount = rendererRequests.length;
      await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, { agentControl: false });
      expect((await call(direct.agent, 8, 'browser.get_state')).isError).toBe(true);
      expect(rendererRequests).toHaveLength(requestCount);
    } finally {
      registration?.dispose();
      await server?.close();
      await browser?.close();
      closeHost?.();
      (await import('../../../src/main/browser/browser-control-ownership')).browserControlOwnership.reset();
      vi.mocked(app).getPath.mockImplementation(name => `/tmp/${name}`);
      if (originalUpdate !== undefined) mocks.browserUpdatePreferences.mockImplementation(originalUpdate);
      if (originalNavigate !== undefined) mocks.browserNavigate.mockImplementation(originalNavigate);
      if (originalGetState !== undefined) mocks.browserGetState.mockImplementation(originalGetState);
      if (originalAgentSetter !== undefined) mocks.setBrowserAgentControl.mockImplementation(originalAgentSetter);
      else mocks.setBrowserAgentControl.mockImplementation(() => undefined);
      if (originalSubagentSetter !== undefined) mocks.setBrowserSubagentControl.mockImplementation(originalSubagentSetter);
      else mocks.setBrowserSubagentControl.mockImplementation(() => undefined);
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    }
  }, 30000);

  it('accepts typed commands and geometry only from the main renderer', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });

    expect(await handler(IPC.browserGetState)({ sender: mainSender }, 'browser-1')).toEqual({
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    await handler(IPC.browserNavigate)({ sender: mainSender }, { browserId: 'browser-1', address: 'example.com' });
    expect(mocks.browserNavigate).toHaveBeenCalledWith('browser-1', 'example.com');
    handler(IPC.browserClone)({ sender: mainSender }, { sourceId: 'browser-1', targetId: 'browser-copy', extra: 'discarded' });
    expect(mocks.browserClone).toHaveBeenCalledWith('browser-1', 'browser-copy');
    handler(IPC.browserTabCommand)({ sender: mainSender }, { browserId: 'browser-1', action: 'mute' });
    expect(mocks.browserTabCommand).toHaveBeenCalledWith({ browserId: 'browser-1', action: 'mute' });
    expect(() => handler(IPC.browserTabCommand)({ sender: {} }, { browserId: 'browser-1', action: 'mute' })).toThrow('unknown sender');
    expect(() => handler(IPC.browserTabCommand)({ sender: mainSender }, { browserId: 'browser-1', action: 'unknown' })).toThrow('invalid request');
    handler(IPC.browserTabCommand)({ sender: mainSender }, { browserId: 'browser-1', action: 'open-external' });
    expect(mocks.browserTabCommand).toHaveBeenLastCalledWith({ browserId: 'browser-1', action: 'open-external' });
    mocks.browserTabCommand.mockClear();
    expect(() => handler(IPC.browserTabCommand)({ sender: {} }, { browserId: 'browser-1', action: 'open-external' })).toThrow('unknown sender');
    expect(() => handler(IPC.browserTabCommand)({ sender: mainSender }, { browserId: 'browser-1', action: 'open-external', url: 'https://attacker.test' })).toThrow('invalid request');
    expect(() => handler(IPC.browserTabCommand)({ sender: mainSender }, { browserId: '../browser', action: 'open-external' })).toThrow('invalid request');
    expect(mocks.browserTabCommand).not.toHaveBeenCalled();
    expect(() => handler(IPC.browserClone)({ sender: {} }, { sourceId: 'browser-1', targetId: 'browser-copy' })).toThrow('unknown sender');
    expect(() => handler(IPC.browserClone)({ sender: mainSender }, { sourceId: 'browser-1', targetId: 'browser-1' })).toThrow('invalid browser ids');
    handler(IPC.browserBack)({ sender: mainSender }, 'browser-1');
    handler(IPC.browserForward)({ sender: mainSender }, 'browser-1');
    handler(IPC.browserReload)({ sender: mainSender }, 'browser-1');
    await handler(IPC.browserFind)({ sender: mainSender }, {
      browserId: 'browser-1',
      text: 'Example',
      forward: true,
      findNext: false,
    });
    await handler(IPC.browserStopFind)({ sender: mainSender }, 'browser-1');
    await handler(IPC.browserPrint)({ sender: mainSender }, 'browser-1');
    await handler(IPC.browserZoom)({ sender: mainSender }, { browserId: 'browser-1', action: 'in' });
    await handler(IPC.browserToggleDeviceMode)({ sender: mainSender }, 'browser-1');
    await handler(IPC.browserSetDeviceMode)({ sender: mainSender }, {
      browserId: 'browser-1',
      request: {
        enabled: true,
        profileId: 'ipad-mini',
        orientation: 'portrait',
        scaleMode: 'fit',
      },
    });
    await handler(IPC.browserCaptureScreenshot)({ sender: mainSender }, 'browser-1');
    await handler(IPC.browserGetData)({ sender: mainSender });
    await handler(IPC.browserUpdatePreferences)({ sender: mainSender }, {
      askWhereToSave: false,
      defaultZoomFactor: 1.25,
    });
    await handler(IPC.browserClearHistory)({ sender: mainSender });
    await handler(IPC.browserClearDownloads)({ sender: mainSender });
    handler(IPC.browserClearData)({ sender: mainSender }, 'browser-1');
    expect(mocks.browserBack).toHaveBeenCalledOnce();
    expect(mocks.browserForward).toHaveBeenCalledOnce();
    expect(mocks.browserReload).toHaveBeenCalledOnce();
    expect(mocks.browserFind).toHaveBeenCalledWith('browser-1', 'Example', {
      forward: true,
      findNext: false,
    });
    expect(mocks.browserStopFind).toHaveBeenCalledWith('browser-1');
    expect(mocks.browserPrint).toHaveBeenCalledWith('browser-1');
    expect(mocks.browserZoom).toHaveBeenCalledWith('browser-1', 'in');
    expect(mocks.browserToggleDeviceMode).toHaveBeenCalledWith('browser-1');
    expect(mocks.browserSetDeviceMode).toHaveBeenCalledWith('browser-1', {
      enabled: true,
      profileId: 'ipad-mini',
      orientation: 'portrait',
      scaleMode: 'fit',
    });
    expect(mocks.browserCaptureScreenshot).toHaveBeenCalledWith('browser-1');
    expect(mocks.browserGetData).toHaveBeenCalledOnce();
    expect(mocks.browserUpdatePreferences).toHaveBeenCalledWith({
      askWhereToSave: false,
      defaultZoomFactor: 1.25,
    });
    expect(mocks.browserApplyDefaultZoom).toHaveBeenCalledWith(1.25);
    expect(mocks.setBrowserAgentControl).not.toHaveBeenCalled();
    expect(mocks.browserClearHistory).toHaveBeenCalledOnce();
    expect(mocks.forgetSiteVisits).toHaveBeenCalledOnce();
    expect(mocks.browserClearDownloads).toHaveBeenCalledOnce();
    expect(mocks.browserClearData).toHaveBeenCalledOnce();

    listener(IPC.browserSetBounds)({ sender: mainSender }, {
      browserId: 'browser-1',
      bounds: { x: 10.4, y: 20, width: 300, height: 199.6, extra: true },
      extra: true,
    });
    expect(mocks.browserSetBounds).toHaveBeenCalledWith('browser-1', { x: 10, y: 20, width: 300, height: 200 });
    listener(IPC.browserSetVisible)({ sender: mainSender }, { browserId: 'browser-1', visible: true });
    expect(mocks.browserSetVisible).toHaveBeenCalledWith('browser-1', true);
    listener(IPC.browserClose)({ sender: mainSender }, 'browser-1');
    expect(mocks.browserClose).toHaveBeenCalledWith('browser-1');
  });

  it('opens only existing absolute local HTML files, and only for the main renderer', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'index.html');
    writeFileSync(page, '<title>Local</title>');
    writeFileSync(join(dir, 'notes.txt'), 'notes');
    mkdirSync(join(dir, 'folder.html'));
    const open = handler(IPC.browserOpenLocalFile);

    await expect(open({ sender: {} }, { browserId: 'browser-1', address: page })).rejects.toThrow('unknown sender');
    await expect(open({ sender: mainSender }, { browserId: 'browser-1' })).rejects.toThrow('invalid payload');
    await expect(open({ sender: mainSender }, { browserId: 'bad id', address: page })).rejects.toThrow('invalid payload');
    await expect(open({ sender: mainSender }, { browserId: 'browser-1', address: '   ' })).rejects.toThrow('invalid payload');
    await expect(open({ sender: mainSender }, { browserId: 'browser-1', address: `/${'a'.repeat(5000)}.html` })).rejects.toThrow('invalid payload');
    await expect(open({ sender: mainSender }, { browserId: 'browser-1', address: 'index.html' })).rejects.toThrow('absolute');
    await expect(open({ sender: mainSender }, { browserId: 'browser-1', address: join(dir, 'notes.txt') })).rejects.toThrow('not an HTML file');
    await expect(open({ sender: mainSender }, { browserId: 'browser-1', address: join(dir, 'missing.html') })).rejects.toThrow('file not found');
    await expect(open({ sender: mainSender }, { browserId: 'browser-1', address: join(dir, 'folder.html') })).rejects.toThrow('not a file');
    await expect(open({ sender: mainSender }, { browserId: 'browser-1', address: 'https://example.com/index.html' })).rejects.toThrow('absolute');
    expect(mocks.openBrowserLocalFile).not.toHaveBeenCalled();
    expect(mocks.takeOverBrowser).not.toHaveBeenCalled();

    await open({ sender: mainSender }, { browserId: 'browser-1', address: join(dir, 'sub', '..', 'index.html') });
    expect(mocks.takeOverBrowser).toHaveBeenCalledWith('browser-1');
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-1', pathToFileURL(page).href);
    await open({ sender: mainSender }, { browserId: 'browser-2', address: pathToFileURL(page).href });
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-2', pathToFileURL(page).href);
  });

  it('accepts upper-case extensions, spaces, percent signs and symlinked pages, and rejects broken links', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    mkdirSync(join(dir, 'my site'));
    const page = join(dir, 'my site', '100% #1.HTM');
    writeFileSync(page, '<title>Odd</title>');
    symlinkSync(page, join(dir, 'link.html'));
    symlinkSync(join(dir, 'my site'), join(dir, 'folder-link.html'));
    symlinkSync(join(dir, 'gone.html'), join(dir, 'broken.html'));
    const open = handler(IPC.browserOpenLocalFile);

    await open({ sender: mainSender }, { browserId: 'browser-1', address: page });
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-1', pathToFileURL(page).href);
    expect(pathToFileURL(page).href).toMatch(/my%20site\/100%25%20%231\.HTM$/);
    await open({ sender: mainSender }, { browserId: 'browser-2', address: `${pathToFileURL(page).href}#top` });
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-2', `${pathToFileURL(page).href}#top`);
    await open({ sender: mainSender }, { browserId: 'browser-3', address: join(dir, 'link.html') });
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-3', pathToFileURL(join(dir, 'link.html')).href);
    await expect(open({ sender: mainSender }, { browserId: 'browser-4', address: join(dir, 'folder-link.html') })).rejects.toThrow('not a file');
    await expect(open({ sender: mainSender }, { browserId: 'browser-4', address: join(dir, 'broken.html') })).rejects.toThrow('file not found');
    await expect(open({ sender: mainSender }, { browserId: 'browser-4', address: 'file://server/share/index.html' })).rejects.toThrow(process.platform === 'win32' ? 'file not found' : 'invalid file URL');
  });

  it.each([
    ['reports a load error', () => mocks.openBrowserLocalFile.mockResolvedValueOnce({ url: '', title: '', loading: false, canGoBack: false, canGoForward: false, error: 'ERR_FILE_NOT_FOUND' })],
    ['throws', () => mocks.openBrowserLocalFile.mockRejectedValueOnce(new Error('Browser data is being cleared.'))],
  ])('rejects and discards the tab when loading the local file %s', async (_case, arrange) => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'index.html');
    writeFileSync(page, '<title>Local</title>');
    arrange();
    await expect(handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-9', address: page })).rejects.toThrow('browser-open-local-file');
    expect(mocks.browserClose).toHaveBeenCalledWith('browser-9');
  });

  it('navigates a new tab to a local link only with a grant from a local page', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const link = 'file:///Users/me/site/next.html';
    mocks.takeLocalLinkGrant.mockReturnValueOnce(true);
    await handler(IPC.browserNavigate)({ sender: mainSender }, { browserId: 'browser-5', address: link });
    expect(mocks.takeLocalLinkGrant).toHaveBeenCalledWith(link);
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-5', link);
    expect(mocks.browserNavigate).not.toHaveBeenCalled();
    await handler(IPC.browserNavigate)({ sender: mainSender }, { browserId: 'browser-6', address: link });
    expect(mocks.browserNavigate).toHaveBeenLastCalledWith('browser-6', link, { localFile: true });
    expect(mocks.openBrowserLocalFile).toHaveBeenCalledTimes(1);
    mocks.takeLocalLinkGrant.mockClear();
    await handler(IPC.browserNavigate)({ sender: mainSender }, { browserId: 'browser-7', address: 'https://example.com' });
    expect(mocks.takeLocalLinkGrant).not.toHaveBeenCalled();
  });

  it('opens a typed local file URL or absolute path in the address bar as a local file navigation', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const navigate = handler(IPC.browserNavigate);
    const page = 'file:///Users/me/site/report.html?tab=2#intro';

    await navigate({ sender: mainSender }, { browserId: 'browser-1', address: page });
    expect(mocks.browserNavigate).toHaveBeenLastCalledWith('browser-1', page, { localFile: true });
    expect(mocks.takeLocalLinkGrant).toHaveBeenCalledWith(page);
    await navigate({ sender: mainSender }, { browserId: 'browser-1', address: 'file:///Users/me/site/notes.txt' });
    expect(mocks.browserNavigate).toHaveBeenLastCalledWith('browser-1', 'file:///Users/me/site/notes.txt', { localFile: true });
    const path = process.platform === 'win32' ? 'C:\\Users\\me\\site\\missing.html' : '/Users/me/site/missing.html';
    await navigate({ sender: mainSender }, { browserId: 'browser-2', address: path });
    expect(mocks.browserNavigate).toHaveBeenLastCalledWith('browser-2', path, { localFile: true });
    expect(mocks.openBrowserLocalFile).not.toHaveBeenCalled();

    mocks.browserNavigate.mockClear();
    mocks.localPagesAllowed.mockResolvedValueOnce(false);
    await expect(navigate({ sender: mainSender }, { browserId: 'browser-2', address: page })).rejects.toThrow('file:// privileges');
    expect(mocks.browserNavigate).not.toHaveBeenCalled();
  });

  it('drops a typed local file navigation that a newer navigation replaced', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'report.html');
    writeFileSync(page, '<h1>Hi</h1>');
    let release: () => void = () => {};
    mocks.localPagesAllowed.mockImplementationOnce(() => new Promise<boolean>((resolve) => { release = () => resolve(true); }));
    mocks.browserGeneration.mockReturnValueOnce(7).mockReturnValue(8);
    const pending = handler(IPC.browserNavigate)({ sender: mainSender }, { browserId: 'browser-1', address: pathToFileURL(page).href });
    release();
    await expect(pending).resolves.toEqual(expect.objectContaining({ url: '' }));
    expect(mocks.openBrowserLocalFile).not.toHaveBeenCalled();
    expect(mocks.browserNavigate).not.toHaveBeenCalled();
    mocks.browserGeneration.mockImplementation(() => 0);
  });

  it('drops a local file open when the renderer navigated meanwhile', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'report.html');
    writeFileSync(page, '<h1>Hi</h1>');
    mocks.terminalManager.generation.mockReturnValueOnce(3).mockReturnValue(4);
    await handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-1', address: page });
    expect(mocks.openBrowserLocalFile).not.toHaveBeenCalled();
    expect(mocks.takeOverBrowser).not.toHaveBeenCalled();
    mocks.terminalManager.generation.mockImplementation(() => 0);
  });

  it('closes the entry when the renderer navigated while the local page was loading', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'report.html');
    writeFileSync(page, '<h1>Hi</h1>');
    mocks.terminalManager.generation.mockReturnValueOnce(3).mockReturnValueOnce(3).mockReturnValue(4);
    await handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-9', address: page });
    expect(mocks.openBrowserLocalFile).toHaveBeenCalledWith('browser-9', pathToFileURL(page).href);
    expect(mocks.browserClose).toHaveBeenCalledWith('browser-9');
    expect(mocks.openBrowserLocalFile).toHaveBeenCalledTimes(1);
    mocks.terminalManager.generation.mockImplementation(() => 0);
  });

  it('drops a typed local file navigation when the renderer navigated meanwhile', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'report.html');
    writeFileSync(page, '<h1>Hi</h1>');
    mocks.terminalManager.generation.mockReturnValueOnce(3).mockReturnValue(4);
    await expect(handler(IPC.browserNavigate)({ sender: mainSender }, { browserId: 'browser-1', address: pathToFileURL(page).href })).resolves.toEqual(expect.objectContaining({ url: '' }));
    expect(mocks.openBrowserLocalFile).not.toHaveBeenCalled();
    expect(mocks.browserNavigate).not.toHaveBeenCalled();
    mocks.terminalManager.generation.mockImplementation(() => 0);
  });

  it('reports whether this build allows local pages, only to the main renderer', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    expect(await handler(IPC.browserLocalPagesAllowed)({ sender: mainSender })).toBe(true);
    mocks.localPagesAllowed.mockResolvedValueOnce(false);
    expect(await handler(IPC.browserLocalPagesAllowed)({ sender: mainSender })).toBe(false);
    expect(() => handler(IPC.browserLocalPagesAllowed)({ sender: {} })).toThrow('unknown sender');
  });

  it('falls back to the source preview when this build cannot keep local pages from reading other files', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'index.html');
    writeFileSync(page, '<title>Local</title>');
    mocks.localPagesAllowed.mockResolvedValueOnce(false);
    await expect(handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-1', address: page })).rejects.toThrow('file:// privileges');
    expect(mocks.openBrowserLocalFile).not.toHaveBeenCalled();
    expect(mocks.takeOverBrowser).not.toHaveBeenCalled();
    await handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-1', address: page });
    expect(mocks.openBrowserLocalFile).toHaveBeenCalledWith('browser-1', pathToFileURL(page).href);
  });

  it('keeps the query and fragment of a local file URL', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'report.html');
    writeFileSync(page, '<h1 id="intro">Intro</h1>');
    await handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-1', address: `${pathToFileURL(page).href}?tab=2#intro` });
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-1', `${pathToFileURL(page).href}?tab=2#intro`);
  });

  it('appends the URL suffix of a workspace file link after validating its path', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const dir = mkdtempSync(join(tmpdir(), 'kimi-local-html-'));
    const page = join(dir, 'report.html');
    writeFileSync(page, '<h1 id="intro">Intro</h1>');
    await handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-1', address: page, urlSuffix: '?tab=2#intro' });
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-1', `${pathToFileURL(page).href}?tab=2#intro`);
    await handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-2', address: page, urlSuffix: '#intro' });
    expect(mocks.openBrowserLocalFile).toHaveBeenLastCalledWith('browser-2', `${pathToFileURL(page).href}#intro`);
    await expect(handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-3', address: page, urlSuffix: 'tab=2' })).rejects.toThrow('invalid URL suffix');
    await expect(handler(IPC.browserOpenLocalFile)({ sender: mainSender }, { browserId: 'browser-3', address: page, urlSuffix: `?${'a'.repeat(5000)}` })).rejects.toThrow('invalid payload');
    expect(mocks.openBrowserLocalFile).toHaveBeenCalledTimes(2);
  });

  it('keeps local file tabs in the persisted browser layout', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const sessions = [
      {
        sessionId: 'session-1',
        tabs: [{ browserId: 'browser-http', title: 'Example' }, { browserId: 'browser-local', title: 'Local Report' }],
        activeBrowserId: 'browser-local',
        visible: true,
      },
    ];
    await handler(IPC.browserSaveSessions)({ sender: mainSender }, sessions);
    expect(await handler(IPC.browserGetSessions)({ sender: mainSender })).toEqual(sessions);
  });

  it('rejects preview/unknown senders and malformed payloads', async () => {
    const mainSender = {};
    const otherSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });

    expect(() => handler(IPC.browserNavigate)({ sender: otherSender }, { browserId: 'browser-1', address: 'example.com' })).toThrow(
      'unknown sender',
    );
    expect(() => handler(IPC.browserNavigate)({ sender: mainSender }, 42)).toThrow(
      'invalid payload',
    );
    expect(() =>
      handler(IPC.browserSetDeviceMode)({ sender: mainSender }, {
        browserId: 'browser-1',
        request: {
          enabled: true,
          profileId: 'responsive',
          orientation: 'portrait',
          width: 20,
          height: 852,
          scaleMode: 'fit',
        },
      }),
    ).toThrow('invalid payload');
    expect(() => handler(IPC.browserZoom)({ sender: mainSender }, { browserId: 'browser-1', action: 'fit' })).toThrow('invalid payload');
    expect(() => handler(IPC.browserZoom)({ sender: mainSender }, ['browser-1', 'in'])).toThrow('invalid payload');
    expect(() => handler(IPC.browserPickAnnotation)({ sender: mainSender }, { browserId: 'browser-1', options: { borderColor: 'red' } })).toThrow('Invalid annotation request');
    expect(() => handler(IPC.browserSetSitePermission)({ sender: mainSender }, { origin: 'file:///tmp', permission: 'camera', setting: 'allow' })).toThrow('Invalid site permission');
    expect(() => handler(IPC.browserSetSitePermission)({ sender: mainSender }, { origin: 'https://example.test', permission: 'storage', setting: 'allow' })).toThrow('Invalid site permission');
    expect(mocks.takeOverBrowser).not.toHaveBeenCalled();
    listener(IPC.browserSetBounds)({ sender: mainSender }, { browserId: 'browser-1', bounds: { x: -1, y: 0, width: 10, height: 10 } });
    listener(IPC.browserSetBounds)({ sender: mainSender }, { browserId: 'browser-1' });
    listener(IPC.browserSetBounds)({ sender: otherSender }, { browserId: 'browser-1', bounds: { x: 0, y: 0, width: 10, height: 10 } });
    listener(IPC.browserSetVisible)({ sender: mainSender }, 'yes');
    listener(IPC.browserSetVisible)({ sender: mainSender }, { browserId: 'browser-1', visible: 'yes' });
    listener(IPC.browserSetVisible)({ sender: otherSender }, true);
    expect(mocks.browserSetBounds).not.toHaveBeenCalled();
    expect(mocks.browserSetVisible).not.toHaveBeenCalled();
  });

  it('opens only recorded downloads by id for the main renderer', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    await expect(handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-1', action: 'show' })).resolves.toBe(true);
    expect(mocks.browserOpenDownload).toHaveBeenCalledExactlyOnceWith({ id: 'download-1', action: 'show' }, expect.objectContaining({
      shell: expect.objectContaining({ openExternal: expect.any(Function) }),
    }));
    expect(() => handler(IPC.browserOpenDownload)({ sender: {} }, { id: 'download-1', action: 'open' })).toThrow('invalid request');
    expect(() => handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-1', action: 'run' })).toThrow('invalid request');
    expect(() => handler(IPC.browserOpenDownload)({ sender: mainSender }, { path: '/etc/passwd', action: 'open' })).toThrow('invalid request');
    expect(() => handler(IPC.browserOpenDownload)({ sender: mainSender }, '/etc/passwd')).toThrow('invalid request');
    expect(() => handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-1', action: 'open', path: '/etc/passwd' })).toThrow('invalid request');
    expect(mocks.browserOpenDownload).toHaveBeenCalledOnce();
  });

  it('pauses, resumes and cancels downloads by id only for the main renderer', () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    for (const action of ['pause', 'resume', 'cancel'] as const) {
      expect(handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-1', action })).toBe(true);
      expect(mocks.browserControlDownload).toHaveBeenLastCalledWith({ id: 'download-1', action });
      expect(() => handler(IPC.browserOpenDownload)({ sender: {} }, { id: 'download-1', action })).toThrow('invalid request');
      expect(() => handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: '', action })).toThrow('invalid request');
      expect(() => handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-1', action, extra: true })).toThrow('invalid request');
    }
    mocks.browserControlDownload.mockReturnValueOnce(false);
    expect(handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-unknown', action: 'cancel' })).toBe(false);
    expect(() => handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-1', action: 'stop' })).toThrow('invalid request');
    expect(mocks.browserControlDownload).toHaveBeenCalledTimes(4);
    expect(mocks.browserOpenDownload).not.toHaveBeenCalled();
  });

  it('retries downloads by id only for the main renderer', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    await expect(handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-1', action: 'retry' })).resolves.toBe(true);
    expect(mocks.browserRetryDownload).toHaveBeenCalledExactlyOnceWith('download-1');
    expect(() => handler(IPC.browserOpenDownload)({ sender: {} }, { id: 'download-1', action: 'retry' })).toThrow('invalid request');
    expect(() => handler(IPC.browserOpenDownload)({ sender: mainSender }, { id: 'download-1', action: 'retry', url: 'https://evil.test/' })).toThrow('invalid request');
    expect(mocks.browserRetryDownload).toHaveBeenCalledOnce();
    expect(mocks.browserControlDownload).not.toHaveBeenCalled();
    expect(mocks.browserOpenDownload).not.toHaveBeenCalled();
  });

  it('parents download dialogs to the main window and localizes them', async () => {
    const host = { isDestroyed: () => false, webContents: {} };
    mocks.getMainWindow.mockReturnValue(host);
    await handler(IPC.browserOpenDownload)({ sender: host.webContents }, { id: 'download-1', action: 'open' });
    const deps = (mocks.browserOpenDownload.mock.calls[0] as unknown[])[1] as {
      showMessageBox: (options: { cancelId?: number }) => Promise<number>;
      strings: () => { openDialog: { open: string } };
    };
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
    await expect(deps.showMessageBox({ cancelId: 1 })).resolves.toBe(1);
    expect(mocks.showMessageBox).toHaveBeenCalledExactlyOnceWith(host, { cancelId: 1 });
    expect(deps.strings().openDialog.open).toBe('Open');
    mocks.contextMenuLocale = 'zh';
    expect(deps.strings().openDialog.open).toBe('打开');
    mocks.contextMenuLocale = 'en';
    mocks.getMainWindow.mockReturnValue(null);
    await expect(deps.showMessageBox({ cancelId: 1 })).resolves.toBe(1);
    expect(mocks.showMessageBox).toHaveBeenCalledOnce();
  });

  it('removes downloads from the list only by a valid id from the main renderer', () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    expect(handler(IPC.browserRemoveDownload)({ sender: mainSender }, 'download-1')).toBe(true);
    expect(mocks.browserRemoveDownload).toHaveBeenCalledExactlyOnceWith('download-1');
    expect(() => handler(IPC.browserRemoveDownload)({ sender: {} }, 'download-1')).toThrow('invalid request');
    for (const payload of ['', 'x'.repeat(129), 42, { id: 'download-1' }, null]) {
      expect(() => handler(IPC.browserRemoveDownload)({ sender: mainSender }, payload)).toThrow('invalid request');
    }
    expect(mocks.browserRemoveDownload).toHaveBeenCalledOnce();
  });

  it('pushes download changes only while the main renderer watches the downloads section', async () => {
    const { EventEmitter } = await import('node:events');
    const mainSender = new EventEmitter();
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const items = [{ id: 'download-1', url: 'https://example.com/a.zip', filename: 'a.zip', state: 'progressing', startedAt: 1, receivedBytes: 1, totalBytes: 2 }];
    mocks.browserDownloadItems.mockReturnValue(items);
    expect(mocks.browserDownloadsListeners).toHaveLength(1);
    const notify = mocks.browserDownloadsListeners[0]!;
    notify();
    listener(IPC.browserWatchDownloads)({ sender: {} }, true);
    notify();
    listener(IPC.browserWatchDownloads)({ sender: mainSender }, 'yes');
    notify();
    expect(sendToRenderer).not.toHaveBeenCalled();
    expect(mocks.browserDownloadItems).not.toHaveBeenCalled();
    listener(IPC.browserWatchDownloads)({ sender: mainSender }, true);
    notify();
    expect(sendToRenderer).toHaveBeenCalledExactlyOnceWith(IPC.browserDownloads, items);
    listener(IPC.browserWatchDownloads)({ sender: mainSender }, false);
    notify();
    expect(sendToRenderer).toHaveBeenCalledOnce();
    expect(mocks.browserRefreshDownloadFiles).not.toHaveBeenCalled();
  });

  it('stops pushing downloads when the watching page reloads or is destroyed', async () => {
    const { EventEmitter } = await import('node:events');
    const mainSender = new EventEmitter();
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    mocks.browserDownloadItems.mockReturnValue([]);
    const notify = mocks.browserDownloadsListeners[0]!;
    for (const event of ['did-start-loading', 'destroyed']) {
      vi.mocked(sendToRenderer).mockClear();
      listener(IPC.browserWatchDownloads)({ sender: mainSender }, true);
      listener(IPC.browserWatchDownloads)({ sender: mainSender }, false);
      listener(IPC.browserWatchDownloads)({ sender: mainSender }, true);
      notify();
      expect(sendToRenderer).toHaveBeenCalledOnce();
      expect(mainSender.listenerCount('did-start-loading')).toBe(1);
      mainSender.emit(event);
      notify();
      expect(sendToRenderer).toHaveBeenCalledOnce();
      expect(mainSender.listenerCount('did-start-loading')).toBe(0);
      expect(mainSender.listenerCount('destroyed')).toBe(0);
    }
  });

  it('checks download files only when the downloads section asks for them', async () => {
    const mainSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const items = [{ id: 'download-1', fileMissing: true }];
    mocks.browserReadDownloads.mockReturnValue(items);
    await handler(IPC.browserGetData)({ sender: mainSender });
    expect(mocks.browserReadDownloads).not.toHaveBeenCalled();
    expect(mocks.browserRefreshDownloadFiles).not.toHaveBeenCalled();
    expect(handler(IPC.browserGetDownloads)({ sender: mainSender })).toBe(items);
    expect(mocks.browserReadDownloads).toHaveBeenCalledOnce();
    expect(() => handler(IPC.browserGetDownloads)({ sender: {} })).toThrow('unknown sender');
    expect(mocks.browserReadDownloads).toHaveBeenCalledOnce();
  });

  it('serves, copies and deletes before-action receipts only for the main renderer and valid ids', async () => {
    const mainSender = {};
    const otherSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const read = { sessionId: 'session_1', receiptId: 'r-0123456789ab' };
    await handler(IPC.browserReadReceipt)({ sender: mainSender }, { ...read, extra: true });
    expect(mocks.readBrowserReceipt).toHaveBeenCalledExactlyOnceWith('session_1', 'r-0123456789ab');
    expect(() => handler(IPC.browserReadReceipt)({ sender: otherSender }, read)).toThrow('Invalid receipt request');
    expect(() => handler(IPC.browserReadReceipt)({ sender: mainSender }, { ...read, receiptId: '../r-0123456789ab' })).toThrow('Invalid receipt request');
    expect(() => handler(IPC.browserReadReceipt)({ sender: mainSender }, { ...read, sessionId: '../session_1' })).toThrow('Invalid receipt request');

    await handler(IPC.browserDeleteReceipts)({ sender: mainSender }, 'session_1');
    expect(mocks.deleteBrowserReceipts).toHaveBeenCalledExactlyOnceWith('session_1');
    expect(() => handler(IPC.browserDeleteReceipts)({ sender: otherSender }, 'session_1')).toThrow('Invalid receipt request');
    expect(() => handler(IPC.browserDeleteReceipts)({ sender: mainSender }, '../x')).toThrow('Invalid receipt request');

    await handler(IPC.browserCopyReceipts)({ sender: mainSender }, { sourceId: 'session_1', targetId: 'session_2' });
    expect(mocks.copyBrowserReceipts).toHaveBeenCalledExactlyOnceWith('session_1', 'session_2');
    expect(() => handler(IPC.browserCopyReceipts)({ sender: otherSender }, { sourceId: 'session_1', targetId: 'session_2' })).toThrow('Invalid receipt request');
    expect(() => handler(IPC.browserCopyReceipts)({ sender: mainSender }, { sourceId: 'session_1', targetId: 'a/b' })).toThrow('Invalid receipt request');
  });

  it('separates trusted host overlay requests from isolated overlay renderer events', () => {
    const mainSender = {};
    const otherSender = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainSender });
    const request = {
      menuId: 'panel-tabs.add',
      anchor: { x: 10, y: 20, width: 28, height: 28 },
      placement: 'bottom-end',
      width: 220,
      items: [{ kind: 'item', id: 'browser', label: 'Browser' }],
    };

    listener(IPC.browserOverlayOpen)({ sender: mainSender }, request);
    expect(mocks.browserOverlayOpen).toHaveBeenCalledWith(
      expect.objectContaining({ menuId: 'panel-tabs.add', width: 220 }),
    );
    listener(IPC.browserOverlayOpen)({ sender: otherSender }, request);
    listener(IPC.browserOverlayOpen)({ sender: mainSender }, { ...request, items: [] });
    expect(mocks.browserOverlayOpen).toHaveBeenCalledOnce();

    const dialog = {
      dialogId: 'global-confirm',
      title: 'Clear browsing data',
      message: 'Cookies will be deleted.',
      confirmLabel: 'Clear',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
      variant: 'danger',
      viewport: { width: 1200, height: 800 },
    };
    listener(IPC.browserOverlayDialogOpen)({ sender: mainSender }, dialog);
    expect(mocks.browserOverlayDialogOpen).toHaveBeenCalledWith(dialog);
    listener(IPC.browserOverlayDialogOpen)({ sender: otherSender }, dialog);
    listener(IPC.browserOverlayDialogOpen)({ sender: mainSender }, { ...dialog, action: 'bad' });
    expect(mocks.browserOverlayDialogOpen).toHaveBeenCalledOnce();
    listener(IPC.browserOverlayDialogClose)({ sender: mainSender }, 'global-confirm');
    expect(mocks.browserOverlayDialogClose).toHaveBeenCalledWith('global-confirm', 'programmatic');

    listener(IPC.browserOverlayReady)({ sender: mocks.overlaySender });
    expect(mocks.browserOverlayReady).toHaveBeenCalledWith(mocks.overlaySender);
    listener(IPC.browserOverlayRendered)({ sender: mocks.overlaySender }, {
      requestId: 1,
      width: 220,
      height: 160,
    });
    expect(mocks.browserOverlayRendered).toHaveBeenCalledWith(mocks.overlaySender, {
      requestId: 1,
      width: 220,
      height: 160,
    });
    listener(IPC.browserOverlayHidden)({ sender: mocks.overlaySender }, { requestId: 1 });
    expect(mocks.browserOverlayHidden).toHaveBeenCalledWith(mocks.overlaySender, {
      requestId: 1,
    });
    listener(IPC.browserOverlayHidden)({ sender: otherSender }, { requestId: 1 });
    listener(IPC.browserOverlayHidden)({ sender: mocks.overlaySender }, { requestId: 0 });
    expect(mocks.browserOverlayHidden).toHaveBeenCalledOnce();
    listener(IPC.browserOverlayActivate)({ sender: mocks.overlaySender }, { requestId: 1, itemId: 'browser' });
    expect(mocks.browserOverlayActivate).toHaveBeenCalledWith(mocks.overlaySender, { requestId: 1, itemId: 'browser' });
    listener(IPC.browserOverlayActivate)({ sender: otherSender }, { requestId: 1, itemId: 'browser' });
    listener(IPC.browserOverlayActivate)({ sender: mocks.overlaySender }, 'browser');
    expect(mocks.browserOverlayActivate).toHaveBeenCalledOnce();
    listener(IPC.browserOverlayDismiss)({ sender: mocks.overlaySender }, { requestId: 1, reason: 'escape' });
    expect(mocks.browserOverlayDismiss).toHaveBeenCalledWith(mocks.overlaySender, { requestId: 1, reason: 'escape' });
    listener(IPC.browserOverlayDismiss)({ sender: otherSender }, { requestId: 1, reason: 'escape' });
    listener(IPC.browserOverlayDismiss)({ sender: mocks.overlaySender }, 'escape');
    expect(mocks.browserOverlayDismiss).toHaveBeenCalledOnce();
    listener(IPC.browserOverlayReady)({ sender: otherSender });
    expect(mocks.browserOverlayReady).toHaveBeenCalledOnce();
  });
});

it.each([true, false])('browser chrome focus respects foreground=%s without raising the window', (foreground) => {
  const mainSender = { focus: vi.fn() };
  mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, isFocused: () => foreground, webContents: mainSender });
  handler(IPC.browserFocusChrome)({ sender: mainSender });
  expect(mainSender.focus).toHaveBeenCalledTimes(foreground ? 1 : 0);
  expect(mocks.showMainWindow).not.toHaveBeenCalled();
});
describe('canaryImportStableSettings quit guard', () => {
  it('relaunches after writing the import marker when no busy session blocks', async () => {
    await expect(handler(IPC.canaryImportStableSettings)({})).resolves.toEqual({
      status: 'relaunching',
    });
    expect(mocks.writeImportMarker).toHaveBeenCalledWith('/tmp/userData', '/tmp/stable-user-data');
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.appRelaunch).toHaveBeenCalledOnce();
    expect(mocks.appExit).toHaveBeenCalledWith(0);
  });

  it('cancels the relaunch when the busy-session confirmation is declined', async () => {
    mocks.shouldBlockQuit.mockResolvedValueOnce(true);
    await expect(handler(IPC.canaryImportStableSettings)({})).resolves.toEqual({
      status: 'cancelled',
    });
    expect(mocks.writeImportMarker).not.toHaveBeenCalled();
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.appRelaunch).not.toHaveBeenCalled();
    expect(mocks.appExit).not.toHaveBeenCalled();
  });

  it('skips the busy-session check when the precheck fails', async () => {
    mocks.stableSettingsPrecheck.mockReturnValueOnce('stable-running');
    await expect(handler(IPC.canaryImportStableSettings)({})).resolves.toEqual({
      status: 'stable-running',
    });
    expect(mocks.shouldBlockQuit).not.toHaveBeenCalled();
    expect(mocks.writeImportMarker).not.toHaveBeenCalled();
  });
});

describe('quitConfirmResponse', () => {
  it('forwards a valid choice from the main renderer', () => {
    const mainWebContents = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainWebContents });
    handler(IPC.quitConfirmResponse)({ sender: mainWebContents }, { choice: 'quit', requestId: 1 });
    expect(mocks.resolveQuitConfirmResponse).toHaveBeenCalledWith('quit', 1, false);
    handler(IPC.quitConfirmResponse)({ sender: mainWebContents }, { choice: 'cancel', requestId: 2 });
    expect(mocks.resolveQuitConfirmResponse).toHaveBeenCalledWith('cancel', 2, false);
    handler(IPC.quitConfirmResponse)({ sender: mainWebContents }, { choice: 'unavailable', requestId: 3 });
    expect(mocks.resolveQuitConfirmResponse).toHaveBeenCalledWith('unavailable', 3, false);
  });

  it('forwards the continue choice only when it is exactly true', () => {
    const mainWebContents = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainWebContents });
    handler(IPC.quitConfirmResponse)({ sender: mainWebContents }, { choice: 'quit', requestId: 4, continueSessions: true });
    expect(mocks.resolveQuitConfirmResponse).toHaveBeenLastCalledWith('quit', 4, true);
    handler(IPC.quitConfirmResponse)({ sender: mainWebContents }, { choice: 'quit', requestId: 5, continueSessions: 'yes' });
    expect(mocks.resolveQuitConfirmResponse).toHaveBeenLastCalledWith('quit', 5, false);
  });

  it('ignores invalid payloads and foreign senders', () => {
    const mainWebContents = {};
    mocks.getMainWindow.mockReturnValue({ isDestroyed: () => false, webContents: mainWebContents });
    handler(IPC.quitConfirmResponse)({ sender: mainWebContents }, { choice: 'nope', requestId: 1 });
    handler(IPC.quitConfirmResponse)({ sender: mainWebContents }, { choice: 'quit' });
    handler(IPC.quitConfirmResponse)({ sender: mainWebContents }, 'quit');
    handler(IPC.quitConfirmResponse)({ sender: {} }, { choice: 'quit', requestId: 1 });
    expect(mocks.resolveQuitConfirmResponse).not.toHaveBeenCalled();
  });
});
