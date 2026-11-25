import { BROWSER_DEVICE_PROFILES } from '../../../src/shared/browser-device';
import { describe, it, expect, vi, beforeEach } from 'vitest';

const expose = vi.fn();
const send = vi.fn();
const removeListener = vi.fn();
const invoke = vi.fn().mockResolvedValue(undefined);
const getPathForFile = vi.fn<(file: File) => string>();

const listeners = new Map<string, (...args: unknown[]) => void>();
const on = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
  listeners.set(channel, listener);
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { send, on, removeListener, invoke },
  webUtils: { getPathForFile },
}));

const WHITELIST = [
  'browserOverlaySupported',
  'sessionLinksSupported',
  'inspectNativeTerminals',
  'browserOverlayCloseMenu',
  'browserOverlayOpenMenu',
  'onBrowserOverlayAction',
  'onBrowserOverlayClosed',
  'canaryImportStableSettings',
  'browserAutomationUiRespond',
  'browserBack',
  'browserClearData',
  'browserSetOccluded',
  'browserCaptureScreenshot',
  'browserPickAnnotation',
  'browserCancelAnnotationPick',
  'browserReadAnnotationAsset',
  'browserReadReceipt',
  'browserDeleteReceipts',
  'browserCopyReceipts',
  'browserCollectAnnotationAssets',
  'browserCompleteAnnotationCapture',
  'browserShowAnnotation',
  'browserHideAnnotation',
  'browserClearDownloads',
  'browserOpenDownload',
  'browserGetDownloads',
  'browserRemoveDownload',
  'browserWatchDownloads',
  'onBrowserDownloads',
  'browserClearHistory',
  'browserClose',
  'browserClone',
  'browserTabCommand',
  'browserGetSessions',
  'browserSaveSessions',
  'browserSuspend',
  'browserFind',
  'browserForward',
  'browserGetData',
  'browserFocusChrome',
  'browserGetSites',
  'browserGetPermissionRequests',
  'browserResolvePermissionRequest',
  'onBrowserPermissionRequests',
  'browserGetSite',
  'browserSetSitePermission',
  'browserSetSiteAutoplay',
  'browserSetSiteSound',
  'browserClearSiteData',
  'browserGetSystemPermissionStates',
  'browserOpenSystemPermissionSettings',
  'browserNavigate',
  'browserOpenLocalFile',
  'browserLocalPagesAllowed',
  'browserOverlayCloseDialog',
  'browserOverlayOpenDialog',
  'browserReload',
  'browserPrint',
  'browserSetBounds',
  'browserSetControls',
  'onBrowserControlOwnership',
  'browserSetDeviceMode',
  'browserSetFocusEmulation',
  'browserSetVisible',
  'browserStopFind',
  'browserToggleDeviceMode',
  'browserUpdatePreferences',
  'browserChooseAgentDownloadDirectory',
  'browserCheckDownloadsAccess',
  'browserAnswerPageDialog',
  'browserGetPageDialogs',
  'onBrowserPageDialogs',
  'browserZoom',
  'cancelScreenshotCapture',
  'captureScreenshot',
  'checkForUpdates',
  'closeNativeTerminal',
  'collectFeedbackDiagnostics',
  'createNativeTerminal',
  'downloadUpdate',
  'fetchProviderModels',
  'getCanaryInfo',
  'getBrowserState',
  'getPathForFile',
  'getScreenshotGuidance',
  'getUpdateAutoDownload',
  'getUpdateStatus',
  'getVibrancy',
  'getPreventSystemSleep',
  'getPreventSleepState',
  'getRuntimeEnvironmentOverrides',
  'getRemoteControlRestoreState',
  'setRemoteControlRestoreState',
  'getHostName',
  'onRemoteControlRestoreFinished',
  'saveRuntimeEnvironmentOverrides',
  'resetRuntimeEnvironmentOverrides',
  'hideWindow',
  'installUpdate',
  'isFullscreen',
  'isScreenshotSupported',
  'listOpenInApps',
  'log',
  'reportStartupMilestone',
  'nativeTerminalInput',
  'nativeTerminalResize',
  'onDeepLinkAuth',
  'onBrowserAutomationUiRequest',
  'onBrowserState',
  'onBrowserAnnotationRequested',
  'onBrowserOpenLinkRequested',
  'onBrowserCloseRequested',
  'onBrowserOverlayDialogAction',
  'onBrowserOverlayDialogClosed',
  'onFullscreenChanged',
  'onFailureToast',
  'onLaunchAction',
  'onMenuAction',
  'onNativeTerminalExit',
  'onNativeTerminalOutput',
  'onQuitConfirm',
  'onQuitConfirmCancel',
  'onScreenshotHotkey',
  'onScreenshotHotkeyResult',
  'onScreenshotGuidance',
  'respondQuitConfirm',
  'screenshotGuidanceAction',
  'popupWindowsMenu',
  'onShortcut',
  'onTraySelectSession',
  'onUpdateStatus',
  'openExternal',
  'openInApp',
  'setDockIconChoice',
  'setGlobalShortcut',
  'setGlobalShortcutSuspended',
  'setJumpList',
  'setLinuxNativeTitleBar',
  'setLocale',
  'setMenuShortcuts',
  'setMenuSuspended',
  'setOnboarded',
  'setTerminalMenuFocus',
  'setTheme',
  'setTrayAttention',
  'setUpdateAutoDownload',
  'setVibrancy',
  'setPreventLidSleep',
  'setPreventSystemSleep',
  'showOpenDialog',
  'showSaveDialog',
  'showSelectionContextMenu',
  'showWindow',
  'track',
  'updateServerCredential',
  'writeClipboardText',
];

beforeEach(() => {
  vi.resetModules();
  expose.mockClear();
  send.mockClear();
  on.mockClear();
  removeListener.mockClear();
  invoke.mockClear();
  getPathForFile.mockReset();
  listeners.clear();
});

describe('kimiDesktop preload bridge', () => {
  it('forwards only known startup milestones and boot stages', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;
    exposed.reportStartupMilestone('ui-mounted');
    exposed.reportStartupMilestone('ui-ready', 'ignored');
    exposed.reportStartupMilestone('boot-stage', 'sessions');
    exposed.reportStartupMilestone('boot-stage');
    exposed.reportStartupMilestone('unknown' as 'ui-ready');
    expect(send.mock.calls).toEqual([
      ['kimi:startup-milestone', { milestone: 'ui-mounted' }],
      ['kimi:startup-milestone', { milestone: 'ui-ready' }],
      ['kimi:startup-milestone', { milestone: 'boot-stage', stage: 'sessions' }],
    ]);
  });

  it('validates download actions and live download updates', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;
    invoke.mockResolvedValueOnce(true);
    await expect(exposed.browserOpenDownload('download-1', 'show')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-open-download', { id: 'download-1', action: 'show' });
    invoke.mockResolvedValueOnce('yes');
    await expect(exposed.browserOpenDownload('download-1', 'open')).resolves.toBe(false);
    for (const action of ['pause', 'resume', 'cancel', 'retry']) {
      invoke.mockResolvedValueOnce(true);
      await expect(exposed.browserOpenDownload('download-1', action)).resolves.toBe(true);
      expect(invoke).toHaveBeenLastCalledWith('kimi:browser-open-download', { id: 'download-1', action });
    }
    invoke.mockClear();
    await expect(exposed.browserOpenDownload('download-1', 'stop')).rejects.toThrow('invalid request');
    await expect(exposed.browserOpenDownload('download-1', 'run')).rejects.toThrow('invalid request');
    await expect(exposed.browserOpenDownload('', 'open')).rejects.toThrow('invalid request');
    await expect(exposed.browserOpenDownload('/etc/passwd' as never, { path: '/etc/passwd' } as never)).rejects.toThrow('invalid request');
    expect(invoke).not.toHaveBeenCalled();

    invoke.mockResolvedValueOnce(true);
    await expect(exposed.browserRemoveDownload('download-1')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-remove-download', 'download-1');
    invoke.mockClear();
    await expect(exposed.browserRemoveDownload('')).rejects.toThrow('invalid request');
    await expect(exposed.browserRemoveDownload({ id: 'download-1' })).rejects.toThrow('invalid request');
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce([{ id: 'x' }]);
    await expect(exposed.browserGetDownloads()).rejects.toThrow('invalid response');
    invoke.mockResolvedValueOnce([]);
    await expect(exposed.browserGetDownloads()).resolves.toEqual([]);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-get-downloads');
    exposed.browserWatchDownloads(true);
    exposed.browserWatchDownloads('yes');
    exposed.browserWatchDownloads(false);
    expect(send.mock.calls).toEqual([['kimi:browser-watch-downloads', true], ['kimi:browser-watch-downloads', false]]);

    const cb = vi.fn();
    const off = exposed.onBrowserDownloads(cb);
    const listener = listeners.get('kimi:browser-downloads')!;
    const entry = {
      id: 'download-1', url: 'https://example.com/file.zip', filename: 'file.zip', savePath: '/tmp/file.zip',
      state: 'completed', startedAt: 1_700_000_000_000, receivedBytes: 100, totalBytes: 100, fileMissing: true,
    };
    const live = { ...entry, state: 'progressing', receivedBytes: 40, fileMissing: undefined, active: true, speed: 1_024 };
    const paused = { ...live, speed: undefined, resumable: true };
    listener({}, [entry]);
    listener({}, [live, paused]);
    listener({}, [{ ...entry, state: 'unknown' }]);
    listener({}, [{ ...entry, fileMissing: 'yes' }]);
    listener({}, [{ ...live, speed: '1 MB/s' }]);
    listener({}, [{ ...live, speed: Number.POSITIVE_INFINITY }]);
    listener({}, [{ ...paused, resumable: 'yes' }]);
    listener({}, null);
    expect(cb.mock.calls).toEqual([[[entry]], [[live, paused]]]);
    off();
    expect(removeListener).toHaveBeenCalledWith('kimi:browser-downloads', listener);
  });

  it('exposes only the whitelisted API via contextBridge (no ipcRenderer/node/require)', async () => {
    await import('../../../src/main/ipc/preload');
    expect(expose).toHaveBeenCalledOnce();
    const [name, exposed] = expose.mock.calls[0]!;

    expect(name).toBe('kimiDesktop');
    expect(Object.keys(exposed).sort()).toEqual([...WHITELIST].sort());

    expect(Object.keys(exposed)).not.toContain('ipcRenderer');
    expect(Object.keys(exposed)).not.toContain('node');
    expect(Object.keys(exposed)).not.toContain('require');
    for (const key of Object.keys(exposed)) {
      expect(typeof exposed[key]).toBe(key === 'browserOverlaySupported' || key === 'sessionLinksSupported' ? 'boolean' : 'function');
    }
  });

  it('wires prevent system sleep methods to their IPC channels', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    invoke.mockResolvedValueOnce({ system: 'prevent-app-suspension', lid: true, lidSupported: true, lidNeedsRepair: true });
    await expect(exposed.setPreventSystemSleep('prevent-app-suspension')).resolves.toEqual({ system: 'prevent-app-suspension', lid: true, lidSupported: true, lidNeedsRepair: true });
    expect(invoke).toHaveBeenCalledWith('kimi:prevent-system-sleep', 'prevent-app-suspension');
    invoke.mockResolvedValueOnce({ system: 'prevent-display-sleep', lid: false, lidSupported: true });
    await expect(exposed.setPreventSystemSleep('prevent-display-sleep')).resolves.toEqual({ system: 'prevent-display-sleep', lid: false, lidSupported: true });
    expect(invoke).toHaveBeenCalledWith('kimi:prevent-system-sleep', 'prevent-display-sleep');
    invoke.mockClear();
    await exposed.setPreventSystemSleep(true);
    expect(invoke).not.toHaveBeenCalled();
    await expect(exposed.setPreventSystemSleep('yes')).resolves.toEqual({ system: 'allow-sleep', lid: false, lidSupported: false });

    invoke.mockResolvedValueOnce(true);
    await expect(exposed.getPreventSystemSleep()).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('kimi:get-prevent-system-sleep');
    invoke.mockResolvedValueOnce(false);
    await expect(exposed.getPreventSystemSleep()).resolves.toBe(false);
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.getPreventSystemSleep()).resolves.toBe(false);

    invoke.mockResolvedValueOnce({ system: 'allow-sleep', lid: false, lidSupported: true });
    await expect(exposed.getPreventSleepState()).resolves.toEqual({ system: 'allow-sleep', lid: false, lidSupported: true });
    expect(invoke).toHaveBeenCalledWith('kimi:prevent-sleep-state');
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.getPreventSleepState()).resolves.toEqual({ system: 'allow-sleep', lid: false, lidSupported: false });

    invoke.mockResolvedValueOnce({ system: 'prevent-app-suspension', lid: true, lidSupported: true });
    await expect(exposed.setPreventLidSleep(true)).resolves.toEqual({ system: 'prevent-app-suspension', lid: true, lidSupported: true });
    expect(invoke).toHaveBeenCalledWith('kimi:set-prevent-lid-sleep', true);
    await expect(exposed.setPreventLidSleep('yes')).resolves.toEqual({ system: 'allow-sleep', lid: false, lidSupported: false });
  });

  it('wires each whitelisted method to the correct ipcRenderer channel', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    exposed.setTheme('dark');
    expect(send).toHaveBeenCalledWith('kimi:theme', 'dark');
    exposed.setTheme('bogus');
    expect(send).toHaveBeenCalledTimes(1);
    await exposed.popupWindowsMenu({ id: 'file', x: 12, y: 40 });
    expect(invoke).toHaveBeenCalledWith('kimi:menu-popup', { id: 'file', x: 12, y: 40 });

    const attention = {
      unread: 3,
      approvals: 2,
      questions: 1,
      items: [{ sessionId: 's1', title: 't', unread: true, approvals: 0, questions: 0 }],
    };
    exposed.setTrayAttention(attention);
    expect(send).toHaveBeenCalledWith('kimi:tray-attention', attention);
    exposed.setTrayAttention({ unread: -1, approvals: 0, questions: 0, items: [] });
    exposed.setTrayAttention({ unread: 1, approvals: 0, questions: 0 });
    exposed.setTrayAttention({ unread: 1, approvals: 0, questions: 0, items: [{ sessionId: '' }] });
    exposed.setTrayAttention('3');
    expect(send).toHaveBeenCalledTimes(2);

    exposed.setLocale('zh');
    expect(send).toHaveBeenCalledWith('kimi:locale', 'zh');
    exposed.setLocale('fr');
    expect(send).toHaveBeenCalledTimes(3);

    invoke.mockResolvedValueOnce({ status: 'relaunching' });
    await expect(exposed.setLinuxNativeTitleBar(true)).resolves.toEqual({ status: 'relaunching' });
    expect(invoke).toHaveBeenCalledWith('kimi:linux-native-titlebar', true);
    await expect(exposed.setLinuxNativeTitleBar('yes')).resolves.toEqual({ status: 'unavailable' });

    exposed.setMenuShortcuts({ openSettings: 'mod+,', newSession: null });
    expect(send).toHaveBeenCalledWith('kimi:menu-shortcut', { openSettings: 'mod+,', newSession: null });
    exposed.setMenuShortcuts('mod+,');
    exposed.setMenuShortcuts(null);
    expect(send).toHaveBeenCalledTimes(4);

    exposed.setMenuSuspended(true);
    expect(send).toHaveBeenCalledWith('kimi:menu-suspend', true);
    exposed.setMenuSuspended('yes');
    expect(send).toHaveBeenCalledTimes(5);

    exposed.setTerminalMenuFocus(true);
    expect(send).toHaveBeenCalledWith('kimi:menu-terminal-focus', true);
    exposed.setTerminalMenuFocus('yes');
    expect(send).toHaveBeenCalledTimes(6);

    invoke.mockResolvedValueOnce({ ok: true });
    await expect(exposed.setGlobalShortcut('summonApp', 'mod+space')).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith('kimi:global-shortcut', { action: 'summonApp', binding: 'mod+space' });
    invoke.mockResolvedValueOnce({ ok: false, reason: 'channel-disabled' });
    await expect(exposed.setGlobalShortcut('summonApp', null)).resolves.toEqual({ ok: false, reason: 'channel-disabled' });
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.setGlobalShortcut('summonApp', 'mod+space')).resolves.toEqual({ ok: false, reason: 'conflicted' });
    invoke.mockResolvedValueOnce({ ok: false, reason: 'nope' });
    await expect(exposed.setGlobalShortcut('summonApp', 'mod+space')).resolves.toEqual({ ok: false, reason: 'conflicted' });
    await expect(exposed.setGlobalShortcut('summonApp', 42)).resolves.toEqual({ ok: false, reason: 'invalid' });
    await expect(exposed.setGlobalShortcut(42, 'mod+space')).resolves.toEqual({ ok: false, reason: 'invalid' });

    invoke.mockResolvedValueOnce(true);
    await expect(exposed.setGlobalShortcutSuspended(true)).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('kimi:global-shortcut-suspend', true);
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.setGlobalShortcutSuspended(false)).resolves.toBe(false);
    await expect(exposed.setGlobalShortcutSuspended('yes')).resolves.toBe(false);

    exposed.setOnboarded();
    expect(send).toHaveBeenCalledWith('kimi:set-onboarded');

    exposed.showWindow();
    expect(send).toHaveBeenCalledWith('kimi:show-window');

    exposed.hideWindow();
    expect(send).toHaveBeenCalledWith('kimi:hide-window');

    exposed.setDockIconChoice('dark');
    expect(send).toHaveBeenCalledWith('kimi:dock-icon-choice', 'dark');
    exposed.setDockIconChoice('bogus');
    expect(send).toHaveBeenCalledTimes(10);

    const workspaces = [{ name: 'kimi', root: '/work/kimi' }];
    exposed.setJumpList(workspaces);
    expect(send).toHaveBeenCalledWith('kimi:jump-list', workspaces);
    exposed.setJumpList([{ name: 'x', root: '' }]);
    exposed.setJumpList('nope');
    expect(send).toHaveBeenCalledTimes(11);

    const offAction = exposed.onMenuAction(() => {});
    expect(on).toHaveBeenCalledWith('kimi:menu-action', expect.any(Function));
    offAction();
    expect(removeListener).toHaveBeenCalledWith('kimi:menu-action', expect.any(Function));

    const failureCb = vi.fn();
    const offFailure = exposed.onFailureToast(failureCb);
    const failureListener = listeners.get('kimi:failure-toast')!;
    failureListener({}, 'external-link', 'https://example.com/docs?token=secret');
    failureListener({}, 'external-link', 'javascript:alert(1)');
    failureListener({}, 'screenshot-save');
    failureListener({}, 'unknown');
    expect(failureCb.mock.calls).toEqual([
      ['external-link', 'https://example.com/docs?token=secret'],
      ['external-link', undefined],
      ['screenshot-save', undefined],
    ]);
    offFailure();
    expect(removeListener).toHaveBeenCalledWith('kimi:failure-toast', failureListener);

    const offShortcut = exposed.onShortcut(() => {});
    expect(on).toHaveBeenCalledWith('kimi:shortcut', expect.any(Function));
    offShortcut();
    expect(removeListener).toHaveBeenCalledWith('kimi:shortcut', expect.any(Function));

    const offFullscreen = exposed.onFullscreenChanged(() => {});
    expect(on).toHaveBeenCalledWith('kimi:fullscreen-changed', expect.any(Function));
    offFullscreen();
    expect(removeListener).toHaveBeenCalledWith('kimi:fullscreen-changed', expect.any(Function));

    const offUpdate = exposed.onUpdateStatus(() => {});
    expect(on).toHaveBeenCalledWith('kimi:update-status', expect.any(Function));
    offUpdate();
    expect(removeListener).toHaveBeenCalledWith('kimi:update-status', expect.any(Function));

    const offTraySelect = exposed.onTraySelectSession(() => {});
    expect(on).toHaveBeenCalledWith('kimi:tray-select-session', expect.any(Function));
    offTraySelect();
    expect(removeListener).toHaveBeenCalledWith('kimi:tray-select-session', expect.any(Function));

    const offLaunchAction = exposed.onLaunchAction(() => {});
    expect(on).toHaveBeenCalledWith('kimi:launch-action', expect.any(Function));
    offLaunchAction();
    expect(removeListener).toHaveBeenCalledWith('kimi:launch-action', expect.any(Function));

    const offDeepLinkAuth = exposed.onDeepLinkAuth(() => {});
    expect(on).toHaveBeenCalledWith('kimi:deep-link-auth', expect.any(Function));
    offDeepLinkAuth();
    expect(removeListener).toHaveBeenCalledWith('kimi:deep-link-auth', expect.any(Function));

    const offHotkeyResult = exposed.onScreenshotHotkeyResult(() => {});
    expect(on).toHaveBeenCalledWith('kimi:screenshot-hotkey-result', expect.any(Function));
    offHotkeyResult();
    expect(removeListener).toHaveBeenCalledWith('kimi:screenshot-hotkey-result', expect.any(Function));

    await exposed.openExternal('https://example.com');
    expect(invoke).toHaveBeenCalledWith('kimi:open-external', 'https://example.com');

    await exposed.writeClipboardText('session-1');
    expect(invoke).toHaveBeenCalledWith('kimi:write-clipboard-text', 'session-1');

    const openOpts = { properties: ['openDirectory'] };
    await exposed.showOpenDialog(openOpts);
    expect(invoke).toHaveBeenCalledWith('kimi:dialog-open', openOpts);

    const saveOpts = { defaultPath: 'untitled.txt' };
    await exposed.showSaveDialog(saveOpts);
    expect(invoke).toHaveBeenCalledWith('kimi:dialog-save', saveOpts);

    await exposed.listOpenInApps();
    expect(invoke).toHaveBeenCalledWith('kimi:open-in-list', undefined);

    await exposed.listOpenInApps('/work/index.html');
    expect(invoke).toHaveBeenCalledWith('kimi:open-in-list', '/work/index.html');

    await exposed.openInApp('ghostty', '/work/dir');
    expect(invoke).toHaveBeenCalledWith('kimi:open-in', 'ghostty', '/work/dir');

    await exposed.isFullscreen();
    expect(invoke).toHaveBeenCalledWith('kimi:is-fullscreen');

    await exposed.getUpdateStatus();
    expect(invoke).toHaveBeenCalledWith('kimi:update-get-status');

    await exposed.checkForUpdates();
    expect(invoke).toHaveBeenCalledWith('kimi:update-check');

    await exposed.downloadUpdate();
    expect(invoke).toHaveBeenCalledWith('kimi:update-download');

    await exposed.installUpdate();
    expect(invoke).toHaveBeenCalledWith('kimi:update-install');

    const modelsReq = { url: 'https://api.example.com/v1/models', headers: { a: 'b' }, timeoutMs: 15000 };
    invoke.mockResolvedValueOnce({ ok: true, status: 200, body: '{}' });
    await expect(exposed.fetchProviderModels(modelsReq)).resolves.toEqual({ ok: true, status: 200, body: '{}' });
    expect(invoke).toHaveBeenCalledWith('kimi:provider-models-fetch', modelsReq);
    invoke.mockResolvedValueOnce({ ok: false, kind: 'timeout' });
    await expect(exposed.fetchProviderModels(modelsReq)).resolves.toEqual({ ok: false, kind: 'timeout' });
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.fetchProviderModels(modelsReq)).resolves.toBeNull();

    exposed.setVibrancy(false);
    expect(send).toHaveBeenCalledWith('kimi:vibrancy', false);
    exposed.setVibrancy('yes');
    expect(send).toHaveBeenCalledTimes(12);

    invoke.mockResolvedValueOnce(false);
    await expect(exposed.getVibrancy()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith('kimi:get-vibrancy');
    invoke.mockResolvedValueOnce(true);
    await expect(exposed.getVibrancy()).resolves.toBe(true);
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.getVibrancy()).resolves.toBe(true);

    await exposed.getUpdateAutoDownload();
    expect(invoke).toHaveBeenCalledWith('kimi:update-get-auto-download');

    await exposed.getCanaryInfo();
    expect(invoke).toHaveBeenCalledWith('kimi:canary-get-info');

    await exposed.canaryImportStableSettings?.();
    expect(invoke).toHaveBeenCalledWith('kimi:canary-import-stable-settings');

    await exposed.setUpdateAutoDownload(false);
    expect(invoke).toHaveBeenCalledWith('kimi:update-set-auto-download', false);

    await exposed.setUpdateAutoDownload('yes' as unknown as boolean);
    expect(invoke).not.toHaveBeenCalledWith('kimi:update-set-auto-download', 'yes');

    exposed.log('warn', 'something', { code: 1 });
    expect(send).toHaveBeenCalledWith('kimi:renderer-log', {
      level: 'warn',
      message: 'something',
      detail: { code: 1 },
    });
    exposed.log('debug' as 'warn', 'x');
    exposed.log('info', '');
    exposed.log('info', 42 as unknown as string);
    expect(send).toHaveBeenCalledTimes(13);

    exposed.track('action_invoked', { action: 'newSession', source: 'shortcut' });
    expect(send).toHaveBeenCalledWith('kimi:track', 'action_invoked', {
      action: 'newSession',
      source: 'shortcut',
    });
    exposed.track('');
    expect(send).toHaveBeenCalledTimes(14);

    const browserState = {
      url: 'https://example.com/',
      title: 'Example',
      favicon: 'https://example.com/favicon.ico',
      zoomFactor: 1.25,
      device: {
        profileId: 'responsive',
        orientation: 'portrait',
        width: 393,
        height: 852,
        deviceScaleFactor: 2,
        mobile: true,
        touch: true,
        scaleMode: 'fit',
        requestedScale: 1,
        displayScale: 0.75,
        maxDisplayScale: 0.75,
      },
      loading: false,
      canGoBack: true,
      canGoForward: false,
    };
    const sessions = [{ sessionId: 'session-1', tabs: [{ browserId: 'browser-1' }], activeBrowserId: 'browser-1', visible: true }];
    invoke.mockResolvedValueOnce(sessions);
    await expect(exposed.browserGetSessions()).resolves.toEqual(sessions);
    invoke.mockResolvedValueOnce(undefined);
    await exposed.browserSaveSessions(sessions);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-save-sessions', sessions);
    await expect(exposed.browserSaveSessions([{ ...sessions[0], activeBrowserId: 'missing' }])).rejects.toThrow('invalid state');
    exposed.browserSuspend('browser-1');
    expect(send).toHaveBeenCalledWith('kimi:browser-suspend', 'browser-1');
    invoke.mockResolvedValueOnce(browserState);
    await expect(exposed.getBrowserState('browser-1')).resolves.toEqual(browserState);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-get-state', 'browser-1');
    invoke.mockResolvedValueOnce(browserState);
    await expect(exposed.browserClone('browser-1', 'browser-copy')).resolves.toEqual(browserState);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-clone', { sourceId: 'browser-1', targetId: 'browser-copy' });
    await expect(exposed.browserClone('browser-1', 'browser-1')).rejects.toThrow('browser-clone');
    invoke.mockResolvedValueOnce({ ...browserState, muted: true });
    await expect(exposed.browserTabCommand({ browserId: 'browser-1', action: 'mute' })).resolves.toMatchObject({ muted: true });
    expect(invoke).toHaveBeenLastCalledWith('kimi:browser-tab-command', { browserId: 'browser-1', action: 'mute' });
    await expect(exposed.browserTabCommand({ browserId: 'browser-1', action: 'unknown' })).rejects.toThrow('invalid request');
    invoke.mockResolvedValueOnce({ invalid: true });
    await expect(exposed.browserClone('browser-1', 'browser-copy')).rejects.toThrow('invalid response');
    invoke.mockResolvedValueOnce(browserState);
    await expect(exposed.browserNavigate('browser-1', 'example.com')).resolves.toEqual(browserState);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-navigate', {
      browserId: 'browser-1',
      address: 'example.com',
    });
    await expect(exposed.browserNavigate('browser-1', '   ')).rejects.toThrow('browser-navigate');
    invoke.mockResolvedValueOnce(undefined);
    await expect(exposed.browserOpenLocalFile('browser-1', '/tmp/site/index.html')).resolves.toBeUndefined();
    expect(invoke).toHaveBeenLastCalledWith('kimi:browser-open-local-file', { browserId: 'browser-1', address: '/tmp/site/index.html' });
    await exposed.browserOpenLocalFile('browser-1', '/tmp/site/index.html', '?tab=2#intro');
    expect(invoke).toHaveBeenLastCalledWith('kimi:browser-open-local-file', { browserId: 'browser-1', address: '/tmp/site/index.html', urlSuffix: '?tab=2#intro' });
    invoke.mockClear();
    await expect(exposed.browserOpenLocalFile('browser-1', '')).rejects.toThrow('browser-open-local-file');
    await expect(exposed.browserOpenLocalFile('not a browser id', '/tmp/site/index.html')).rejects.toThrow('browser-open-local-file');
    expect(invoke).not.toHaveBeenCalled();
    invoke.mockResolvedValueOnce(true);
    await expect(exposed.browserLocalPagesAllowed()).resolves.toBe(true);
    expect(invoke).toHaveBeenLastCalledWith('kimi:browser-local-pages-allowed');
    invoke.mockResolvedValueOnce(false);
    await expect(exposed.browserLocalPagesAllowed()).resolves.toBe(false);
    invoke.mockResolvedValueOnce(undefined);
    await expect(exposed.browserLocalPagesAllowed()).resolves.toBe(false);
    invoke.mockResolvedValueOnce(browserState);
    await exposed.browserBack('browser-1');
    expect(invoke).toHaveBeenCalledWith('kimi:browser-back', 'browser-1');
    invoke.mockResolvedValueOnce(browserState);
    await exposed.browserForward('browser-1');
    expect(invoke).toHaveBeenCalledWith('kimi:browser-forward', 'browser-1');
    invoke.mockResolvedValueOnce(browserState);
    await exposed.browserReload('browser-1');
    expect(invoke).toHaveBeenCalledWith('kimi:browser-reload', 'browser-1');
    invoke.mockResolvedValueOnce(undefined);
    await exposed.browserFind('browser-1', 'Example', { forward: true, findNext: false });
    expect(invoke).toHaveBeenCalledWith('kimi:browser-find', {
      browserId: 'browser-1',
      text: 'Example',
      forward: true,
      findNext: false,
    });
    await exposed.browserStopFind('browser-1');
    expect(invoke).toHaveBeenCalledWith('kimi:browser-stop-find', 'browser-1');
    invoke.mockResolvedValueOnce(true);
    await expect(exposed.browserPrint('browser-1')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-print', 'browser-1');
    invoke.mockResolvedValueOnce(browserState);
    await expect(exposed.browserZoom('browser-1', 'in')).resolves.toEqual(browserState);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-zoom', {
      browserId: 'browser-1',
      action: 'in',
    });
    invoke.mockResolvedValueOnce(browserState);
    await expect(exposed.browserToggleDeviceMode('browser-1')).resolves.toEqual(browserState);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-toggle-device-mode', 'browser-1');
    invoke.mockResolvedValueOnce(browserState);
    await expect(
      exposed.browserSetDeviceMode('browser-1', {
        enabled: true,
        profileId: 'ipad-mini',
        orientation: 'portrait',
        scaleMode: 'fit',
      }),
    ).resolves.toEqual(browserState);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-set-device-mode', {
      browserId: 'browser-1',
      request: {
        enabled: true,
        profileId: 'ipad-mini',
        orientation: 'portrait',
        scaleMode: 'fit',
      },
    });
    for (const profile of BROWSER_DEVICE_PROFILES) {
      const request = {
        enabled: true,
        profileId: profile.id,
        orientation: 'portrait',
        scaleMode: 'fit',
        ...(profile.id === 'responsive' ? { width: 393, height: 852 } : {}),
      };
      const state = { ...browserState, device: { ...browserState.device, profileId: profile.id } };
      invoke.mockResolvedValueOnce(state);
      await expect(exposed.browserSetDeviceMode('browser-1', request)).resolves.toEqual(state);
      expect(invoke).toHaveBeenLastCalledWith('kimi:browser-set-device-mode', { browserId: 'browser-1', request });
    }
    invoke.mockResolvedValueOnce(true);
    await expect(exposed.browserCaptureScreenshot('browser-1')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-capture-screenshot', 'browser-1');
    const browserData = {
      history: [
        {
          id: 'history-1',
          url: 'https://example.com/',
          title: 'Example',
          visitedAt: 1_700_000_000_000,
        },
      ],
      preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: 'block', sound: 'muted', defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
      defaultUserAgent: 'Mozilla/5.0',
    };
    invoke.mockResolvedValueOnce(browserData);
    await expect(exposed.browserGetData()).resolves.toEqual(browserData);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-get-data');
    invoke.mockResolvedValueOnce(browserData);
    await expect(
      exposed.browserUpdatePreferences({ askWhereToSave: false }),
    ).resolves.toEqual(browserData);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-update-preferences', {
      askWhereToSave: false,
    });
    invoke.mockResolvedValueOnce(browserData);
    await expect(exposed.browserUpdatePreferences({ subagentControl: true })).resolves.toEqual(browserData);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-update-preferences', { subagentControl: true });
    invoke.mockResolvedValueOnce(browserData);
    await expect(exposed.browserClearHistory()).resolves.toEqual(browserData);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-clear-history');
    invoke.mockResolvedValueOnce(browserData);
    await expect(exposed.browserClearDownloads()).resolves.toEqual(browserData);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-clear-downloads');
    invoke.mockResolvedValueOnce(browserState);
    await exposed.browserClearData('browser-1');
    expect(invoke).toHaveBeenCalledWith('kimi:browser-clear-data', 'browser-1');
    exposed.browserSetBounds('browser-1', { x: 12.4, y: 48.2, width: 600.8, height: 400.1 });
    expect(send).toHaveBeenCalledWith('kimi:browser-set-bounds', {
      browserId: 'browser-1',
      bounds: { x: 12, y: 48, width: 601, height: 400 },
    });
    exposed.browserSetBounds('browser-1', { x: -1, y: 0, width: 10, height: 10 });
    exposed.browserSetVisible('browser-1', true);
    expect(send).toHaveBeenCalledWith('kimi:browser-set-visible', {
      browserId: 'browser-1',
      visible: true,
    });
    exposed.browserSetVisible('', true);
    exposed.browserClose('browser-1');
    expect(send).toHaveBeenCalledWith('kimi:browser-close', 'browser-1');
    const overlayRequest = {
      menuId: 'panel-tabs.add',
      anchor: { x: 10, y: 20, width: 28, height: 28 },
      items: [{ kind: 'item', id: 'browser', label: 'Browser' }],
    };
    exposed.browserOverlayOpenMenu(overlayRequest);
    expect(send).toHaveBeenCalledWith('kimi:browser-overlay-open', overlayRequest);
    const zoomOverlayRequest = {
      ...overlayRequest,
      items: [
        {
          kind: 'zoom',
          id: 'zoom',
          label: 'Zoom',
          icon: 'zoom-scan',
          value: '100%',
          decreaseAction: 'zoom-out',
          decreaseLabel: 'Zoom out',
          increaseAction: 'zoom-in',
          increaseLabel: 'Zoom in',
          resetAction: 'zoom-reset',
          resetLabel: 'Reset zoom',
        },
      ],
    };
    exposed.browserOverlayOpenMenu(zoomOverlayRequest);
    expect(send).toHaveBeenCalledWith('kimi:browser-overlay-open', zoomOverlayRequest);
    exposed.browserOverlayOpenMenu({ ...overlayRequest, items: [] });
    exposed.browserOverlayCloseMenu('panel-tabs.add');
    expect(send).toHaveBeenCalledWith('kimi:browser-overlay-close', 'panel-tabs.add');
    exposed.browserOverlayCloseMenu('bad id');
    expect(send).toHaveBeenCalledTimes(21);
  });

  it('coerces the auto-download preference response to a boolean default', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    invoke.mockResolvedValueOnce(false);
    await expect(exposed.getUpdateAutoDownload()).resolves.toBe(false);

    invoke.mockResolvedValueOnce(true);
    await expect(exposed.getUpdateAutoDownload()).resolves.toBe(true);

    invoke.mockResolvedValueOnce(undefined);
    await expect(exposed.getUpdateAutoDownload()).resolves.toBe(false);
  });

  it('reads the host name of this computer and drops anything that is not a string', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    invoke.mockResolvedValueOnce('studio-mac.local');
    await expect(exposed.getHostName()).resolves.toBe('studio-mac.local');
    expect(invoke).toHaveBeenCalledWith('kimi:host-name');

    invoke.mockResolvedValueOnce({ name: 'studio-mac.local' });
    await expect(exposed.getHostName()).resolves.toBe('');
  });

  it('validates before-action receipt requests in both directions', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;
    const image = { id: 'r-0123456789ab', mimeType: 'image/jpeg', data: 'AAAA', width: 480, height: 300, point: { x: 0.5, y: 0.5 } };
    invoke.mockResolvedValueOnce(image);
    await expect(exposed.browserReadReceipt('session_1', 'r-0123456789ab')).resolves.toEqual(image);
    expect(invoke).toHaveBeenCalledWith('kimi:browser-read-receipt', { sessionId: 'session_1', receiptId: 'r-0123456789ab' });
    invoke.mockResolvedValueOnce({ ...image, mimeType: 'text/html' });
    await expect(exposed.browserReadReceipt('session_1', 'r-0123456789ab')).resolves.toBeNull();
    invoke.mockResolvedValueOnce(null);
    await expect(exposed.browserReadReceipt('session_1', 'r-0123456789ab')).resolves.toBeNull();
    invoke.mockClear();
    await expect(exposed.browserReadReceipt('session_1', '../../secret')).resolves.toBeNull();
    await expect(exposed.browserReadReceipt('../session_1', 'r-0123456789ab')).resolves.toBeNull();
    await exposed.browserDeleteReceipts('a/b');
    await exposed.browserCopyReceipts('session_1', '..');
    expect(invoke).not.toHaveBeenCalled();
    await exposed.browserDeleteReceipts('session_1');
    expect(invoke).toHaveBeenCalledWith('kimi:browser-delete-receipts', 'session_1');
    await exposed.browserCopyReceipts('session_1', 'session_2');
    expect(invoke).toHaveBeenCalledWith('kimi:browser-copy-receipts', { sourceId: 'session_1', targetId: 'session_2' });
  });

  it('validates the Browser automation UI request/response bridge', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;
    const callback = vi.fn();
    exposed.onBrowserAutomationUiRequest(callback);

    const request = {
      requestId: 4,
      sessionId: 'session-1',
      controller: { run: { agentId: 'agent-1', generation: 2, turnId: 7 }, profile: 'coder', description: 'Inspect docs' },
      command: { action: 'activate_tab', tabId: 'panel-1' },
    };
    listeners.get('kimi:browser-automation-ui-request')?.({}, request);
    expect(callback).toHaveBeenCalledWith(request);
    listeners.get('kimi:browser-automation-ui-request')?.({}, {
      requestId: 0,
      command: { action: 'activate_tab', tabId: 'panel-1' },
    });
    expect(callback).toHaveBeenCalledOnce();

    const releaseRequest = { requestId: 6, command: { action: 'release_tab', tabId: 'panel-1', expectedLeaseId: 'lease-1' } };
    listeners.get('kimi:browser-automation-ui-request')?.({}, releaseRequest);
    listeners.get('kimi:browser-automation-ui-request')?.({}, { requestId: 7, command: { action: 'release_tab', tabId: 'panel-1' } });
    expect(callback).toHaveBeenCalledTimes(2);
    expect(callback).toHaveBeenLastCalledWith(releaseRequest);

    const switchRequest = { requestId: 5, command: { action: 'switch_tab', tabId: 'panel-2' } };
    listeners.get('kimi:browser-automation-ui-request')?.({}, switchRequest);
    expect(callback).toHaveBeenLastCalledWith(switchRequest);

    const response = {
      requestId: 4,
      ok: true,
      state: {
        panelVisible: true,
        activeTabId: 'panel-1',
        controlledTabId: 'panel-1',
        controlledLeaseId: 'lease-1',
        turnId: 'turn-1',
        tabs: [{ tabId: 'panel-1', browserId: 'browser-1' }],
      },
    };
    exposed.browserAutomationUiRespond(response);
    expect(send).toHaveBeenCalledWith('kimi:browser-automation-ui-response', response);
    exposed.browserAutomationUiRespond({ ...response, requestId: 0 });
    for (const state of [
      { ...response.state, controlledLeaseId: undefined },
      { ...response.state, controlledLeaseId: null },
      { ...response.state, controlledTabId: null },
    ]) exposed.browserAutomationUiRespond({ ...response, state });
    expect(send).toHaveBeenCalledOnce();
  });

  it('validates the declarative Browser overlay dialog bridge', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;
    const request = {
      dialogId: 'global-confirm',
      title: 'Clear browsing data',
      message: 'Cookies will be deleted.',
      checkbox: { label: 'Include screenshot', checked: false },
      confirmLabel: 'Clear',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
      variant: 'danger',
      viewport: { width: 1200, height: 800 },
    };
    exposed.browserOverlayOpenDialog(request);
    expect(send).toHaveBeenCalledWith('kimi:browser-overlay-dialog-open', request);
    exposed.browserOverlayOpenDialog({ ...request, action: 'bad' });
    exposed.browserOverlayOpenDialog({ ...request, checkbox: { label: 'Include screenshot', checked: 'false' } });
    exposed.browserOverlayCloseDialog('global-confirm');
    expect(send).toHaveBeenCalledWith('kimi:browser-overlay-dialog-close', 'global-confirm');
    exposed.browserOverlayCloseDialog('bad id');
    expect(send).toHaveBeenCalledTimes(2);

    const action = vi.fn();
    const closed = vi.fn();
    exposed.onBrowserOverlayDialogAction(action);
    exposed.onBrowserOverlayDialogClosed(closed);
    listeners.get('kimi:browser-overlay-dialog-action')?.({}, {
      dialogId: 'global-confirm',
      action: 'confirm',
    });
    listeners.get('kimi:browser-overlay-dialog-closed')?.({}, {
      dialogId: 'global-confirm',
      reason: 'escape',
    });
    listeners.get('kimi:browser-overlay-dialog-action')?.({}, {
      dialogId: 'global-confirm',
      action: 'execute',
    });
    expect(action).toHaveBeenCalledOnce();
    expect(closed).toHaveBeenCalledOnce();
  });

  it('sanitizes quit confirmation prompts and forwards the continue choice only when it is exactly true', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    const promptCb = vi.fn();
    exposed.onQuitConfirm(promptCb);
    const prompt = listeners.get('kimi:quit-confirm')!;
    prompt({}, 3, ['busy', 'bogus', 'remote-control'], { purpose: 'update', sessionTitles: ['Fix login bug', 42] });
    prompt({}, 4, 'busy', { purpose: 'bogus', sessionTitles: 'Fix login bug' });
    prompt({}, 4.5, ['busy'], undefined);
    expect(promptCb.mock.calls).toEqual([
      [3, ['busy', 'remote-control'], { purpose: 'update', sessionTitles: ['Fix login bug'] }],
      [4, [], { purpose: 'quit', sessionTitles: [] }],
    ]);

    await exposed.respondQuitConfirm('quit', 3, true);
    await exposed.respondQuitConfirm('quit', 4, 'yes' as unknown as boolean);
    await exposed.respondQuitConfirm('bogus' as 'quit', 5, true);
    expect(invoke.mock.calls.filter(([channel]) => channel === 'kimi:quit-confirm-response')).toEqual([
      ['kimi:quit-confirm-response', { choice: 'quit', requestId: 3, continueSessions: true }],
      ['kimi:quit-confirm-response', { choice: 'quit', requestId: 4, continueSessions: false }],
    ]);
  });

  it('forwards menu-action and shortcut payloads to the renderer callback', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    const actionCb = vi.fn();
    exposed.onMenuAction(actionCb);
    listeners.get('kimi:menu-action')?.({}, 'new-conversation');
    expect(actionCb).toHaveBeenCalledWith('new-conversation');

    const shortcutCb = vi.fn();
    exposed.onShortcut(shortcutCb);
    listeners.get('kimi:shortcut')?.({}, 'CommandOrControl+Alt+K');
    expect(shortcutCb).toHaveBeenCalledWith('CommandOrControl+Alt+K');

    const fullscreenCb = vi.fn();
    exposed.onFullscreenChanged(fullscreenCb);
    listeners.get('kimi:fullscreen-changed')?.({}, true);
    expect(fullscreenCb).toHaveBeenCalledWith(true);
    listeners.get('kimi:fullscreen-changed')?.({}, 'yes');
    expect(fullscreenCb).toHaveBeenLastCalledWith(false);

    const traySelectCb = vi.fn();
    exposed.onTraySelectSession(traySelectCb);
    listeners.get('kimi:tray-select-session')?.({}, 'session-123');
    expect(traySelectCb).toHaveBeenCalledWith('session-123');
    listeners.get('kimi:tray-select-session')?.({}, '');
    listeners.get('kimi:tray-select-session')?.({}, 42);
    expect(traySelectCb).toHaveBeenCalledTimes(1);

    const updateCb = vi.fn();
    exposed.onUpdateStatus(updateCb);
    listeners.get('kimi:update-status')?.({}, { state: 'downloading', version: '1.2.3', percent: 42, releaseDate: '2026-07-18' });
    expect(updateCb).toHaveBeenCalledWith({ state: 'downloading', version: '1.2.3', percent: 42, releaseDate: '2026-07-18' });
    listeners.get('kimi:update-status')?.({}, { state: 'bogus' });
    listeners.get('kimi:update-status')?.({}, 'available');
    expect(updateCb).toHaveBeenCalledTimes(1);

    const launchCb = vi.fn();
    exposed.onLaunchAction(launchCb);
    listeners.get('kimi:launch-action')?.({}, { action: 'new-chat' });
    expect(launchCb).toHaveBeenCalledWith({ action: 'new-chat' });
    listeners.get('kimi:launch-action')?.({}, { action: 'open-workspace', root: '/work/kimi' });
    expect(launchCb).toHaveBeenCalledWith({ action: 'open-workspace', root: '/work/kimi' });
    listeners.get('kimi:launch-action')?.({}, { action: 'open-workspace' });
    listeners.get('kimi:launch-action')?.({}, { action: 'bogus' });
    listeners.get('kimi:launch-action')?.({}, 'new-chat');
    listeners.get('kimi:launch-action')?.({}, { action: 'open-workspace', root: '/work/project', newChat: true });
    expect(launchCb).toHaveBeenLastCalledWith({ action: 'open-workspace', root: '/work/project', newChat: true });
    listeners.get('kimi:launch-action')?.({}, { action: 'open-workspace', root: '/work/project', newChat: 'yes' });
    expect(launchCb).toHaveBeenCalledTimes(3);
    listeners.get('kimi:launch-action')?.({}, { action: 'open-session', sessionId: 'session_1', extra: true });
    expect(launchCb).toHaveBeenLastCalledWith({ action: 'open-session', sessionId: 'session_1' });
    listeners.get('kimi:launch-action')?.({}, { action: 'open-session', sessionId: '' });
    listeners.get('kimi:launch-action')?.({}, { action: 'open-session', sessionId: 42 });
    expect(launchCb).toHaveBeenCalledTimes(4);

    const deepLinkAuthCb = vi.fn();
    exposed.onDeepLinkAuth(deepLinkAuthCb);
    listeners.get('kimi:deep-link-auth')?.({});
    expect(deepLinkAuthCb).toHaveBeenCalledTimes(1);

    const annotationCb = vi.fn();
    const offAnnotation = exposed.onBrowserAnnotationRequested(annotationCb);
    const annotationListener = listeners.get('kimi:browser-annotation-requested')!;
    annotationListener({}, { browserId: 'browser-1', targetId: 'target-example' });
    annotationListener({}, null);
    annotationListener({}, { browserId: '', targetId: 'target-example' });
    annotationListener({}, { browserId: 'browser-1', targetId: 'bad target' });
    expect(annotationCb).toHaveBeenCalledExactlyOnceWith({ browserId: 'browser-1', targetId: 'target-example' });
    offAnnotation();
    expect(removeListener).toHaveBeenCalledWith('kimi:browser-annotation-requested', annotationListener);

    const linkCb = vi.fn();
    exposed.onBrowserOpenLinkRequested(linkCb);
    const linkListener = listeners.get('kimi:browser-open-link-requested')!;
    linkListener({}, { browserId: 'browser-1', url: 'https://example.com/next', background: true });
    linkListener({}, { browserId: 'browser-1', url: 'file:///Users/me/site/next.html', background: true });
    linkListener({}, { browserId: 'browser-1', url: 'javascript:alert(1)' });
    linkListener({}, { browserId: 'bad id', url: 'file:///Users/me/site/next.html' });
    expect(linkCb.mock.calls).toEqual([
      [{ browserId: 'browser-1', url: 'https://example.com/next', background: true }],
      [{ browserId: 'browser-1', url: 'file:///Users/me/site/next.html', background: true }],
    ]);

    const closeCb = vi.fn();
    const offClose = exposed.onBrowserCloseRequested(closeCb);
    const closeListener = listeners.get('kimi:browser-close-requested')!;
    closeListener({}, { browserId: 'browser-1' });
    closeListener({}, { browserId: 'bad id' });
    closeListener({}, null);
    expect(closeCb).toHaveBeenCalledExactlyOnceWith('browser-1');
    offClose();
    expect(removeListener).toHaveBeenCalledWith('kimi:browser-close-requested', closeListener);

    const browserCb = vi.fn();
    exposed.onBrowserState(browserCb);
    listeners.get('kimi:browser-state')?.({}, {
      browserId: 'browser-1',
      state: {
        url: 'https://example.com/',
        title: 'Example',
        favicon: 'data:image/png;base64,AA==',
        zoomFactor: 1.1,
        device: {
          profileId: 'responsive',
          orientation: 'portrait',
          width: 393,
          height: 852,
          deviceScaleFactor: 2,
          mobile: true,
          touch: true,
          scaleMode: 'fit',
          requestedScale: 1,
          displayScale: 0.5,
          maxDisplayScale: 0.5,
        },
        loading: false,
        canGoBack: false,
        canGoForward: false,
      },
    });
    expect(browserCb).toHaveBeenCalledWith('browser-1', {
      url: 'https://example.com/',
      title: 'Example',
      favicon: 'data:image/png;base64,AA==',
      zoomFactor: 1.1,
      device: {
        profileId: 'responsive',
        orientation: 'portrait',
        width: 393,
        height: 852,
        deviceScaleFactor: 2,
        mobile: true,
        touch: true,
        scaleMode: 'fit',
        requestedScale: 1,
        displayScale: 0.5,
        maxDisplayScale: 0.5,
      },
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    listeners.get('kimi:browser-state')?.({}, { url: 'https://example.com/' });
    expect(browserCb).toHaveBeenCalledTimes(1);

    const overlayActionCb = vi.fn();
    const overlayClosedCb = vi.fn();
    exposed.onBrowserOverlayAction(overlayActionCb);
    exposed.onBrowserOverlayClosed(overlayClosedCb);
    listeners.get('kimi:browser-overlay-action')?.({}, {
      menuId: 'panel-tabs.add',
      itemId: 'browser',
    });
    listeners.get('kimi:browser-overlay-closed')?.({}, {
      menuId: 'panel-tabs.add',
      reason: 'escape',
    });
    expect(overlayActionCb).toHaveBeenCalledWith({
      menuId: 'panel-tabs.add',
      itemId: 'browser',
    });
    expect(overlayClosedCb).toHaveBeenCalledWith({
      menuId: 'panel-tabs.add',
      reason: 'escape',
    });
    listeners.get('kimi:browser-overlay-closed')?.({}, {
      menuId: 'panel-tabs.add',
      reason: 'bogus',
    });
    expect(overlayClosedCb).toHaveBeenCalledOnce();
  });

  it('passes release notes through field-wise validation, dropping junk note fields only', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    const cb = vi.fn();
    exposed.onUpdateStatus(cb);
    listeners.get('kimi:update-status')?.({}, { state: 'available', version: '1.2.3', releaseNotes: { zh: '- 修复', en: '- Fixed' } });
    expect(cb).toHaveBeenCalledWith({ state: 'available', version: '1.2.3', releaseNotes: { zh: '- 修复', en: '- Fixed' } });

    listeners.get('kimi:update-status')?.({}, { state: 'available', version: '1.2.3', releaseNotes: 'not-an-object' });
    expect(cb).toHaveBeenLastCalledWith({ state: 'available', version: '1.2.3' });
    listeners.get('kimi:update-status')?.({}, { state: 'available', version: '1.2.3', releaseNotes: { zh: 42, en: true } });
    expect(cb).toHaveBeenLastCalledWith({ state: 'available', version: '1.2.3', releaseNotes: {} });
  });

  it('validates update-check responses and falls back to an error outcome', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    invoke.mockResolvedValueOnce({ outcome: 'available', version: '1.2.3' });
    await expect(exposed.checkForUpdates()).resolves.toEqual({ outcome: 'available', version: '1.2.3' });

    invoke.mockResolvedValueOnce({ outcome: 'latest' });
    await expect(exposed.checkForUpdates()).resolves.toEqual({ outcome: 'latest' });

    invoke.mockResolvedValueOnce({ outcome: 'error' });
    await expect(exposed.checkForUpdates()).resolves.toEqual({ outcome: 'error', message: 'unknown error' });
    invoke.mockResolvedValueOnce({ outcome: 'bogus' });
    await expect(exposed.checkForUpdates()).resolves.toEqual({
      outcome: 'error',
      message: 'invalid update-check response',
    });
  });

  it('validates canary info / trigger payloads and falls back safely', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    invoke.mockResolvedValueOnce(undefined);
    await expect(exposed.getCanaryInfo()).resolves.toEqual({ enabled: false, isCanaryBuild: false, isRealCanaryBuild: false });

    invoke.mockResolvedValueOnce({ status: 'stable-running' });
    await expect(exposed.canaryImportStableSettings?.()).resolves.toEqual({ status: 'stable-running' });
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.canaryImportStableSettings?.()).resolves.toEqual({
      status: 'error',
      error: 'invalid canary-import-stable-settings response',
    });
  });

  it('resolves dropped-file paths via webUtils, mapping failures to null', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;
    const file = new File(['x'], 'folder');

    getPathForFile.mockReturnValueOnce('/work/dir');
    expect(exposed.getPathForFile(file)).toBe('/work/dir');
    expect(getPathForFile).toHaveBeenCalledWith(file);

    getPathForFile.mockReturnValueOnce('');
    expect(exposed.getPathForFile(file)).toBeNull();

    getPathForFile.mockImplementationOnce(() => {
      throw new Error('bad file');
    });
    expect(exposed.getPathForFile(file)).toBeNull();
  });

  it('wires the native terminal methods and validates both directions', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;

    invoke.mockResolvedValueOnce({ id: 't1', shell: 'zsh', cwd: '/work' });
    await expect(
      exposed.createNativeTerminal({ cwd: '/work', cols: 120, rows: 30 }),
    ).resolves.toEqual({ id: 't1', shell: 'zsh', cwd: '/work' });
    expect(invoke).toHaveBeenCalledWith('kimi:terminal-create', { cwd: '/work', cols: 120, rows: 30 });
    invoke.mockResolvedValueOnce({ id: 't-ssh', shell: 'ssh', cwd: '/remote/work' });
    await expect(
      exposed.createNativeTerminal({
        cwd: '/remote/work',
        ssh: { host: 'dev', identityFile: '/home/u/.ssh/id_ed25519' },
      }),
    ).resolves.toEqual({ id: 't-ssh', shell: 'ssh', cwd: '/remote/work' });
    expect(invoke).toHaveBeenLastCalledWith('kimi:terminal-create', {
      cwd: '/remote/work',
      ssh: { host: 'dev', identityFile: '/home/u/.ssh/id_ed25519' },
    });
    invoke.mockResolvedValueOnce({ id: 't2', shell: 'zsh', cwd: '/' });
    await exposed.createNativeTerminal({ cwd: '', cols: Number.NaN, ssh: { host: '-oProxyCommand=bad' } });
    expect(invoke).toHaveBeenLastCalledWith('kimi:terminal-create', {});
    invoke.mockResolvedValueOnce({ shell: 'zsh' });
    await expect(exposed.createNativeTerminal()).rejects.toThrow('terminal-create');

    exposed.nativeTerminalInput('t1', 'ls\n');
    expect(send).toHaveBeenCalledWith('kimi:terminal-input', { id: 't1', data: 'ls\n' });
    exposed.nativeTerminalInput('', 'x');
    exposed.nativeTerminalInput('t1', '');
    exposed.nativeTerminalResize('t1', 80, 24);
    expect(send).toHaveBeenCalledWith('kimi:terminal-resize', { id: 't1', cols: 80, rows: 24 });
    exposed.nativeTerminalResize('t1', Number.NaN, 24);
    exposed.closeNativeTerminal('t1');
    expect(send).toHaveBeenCalledWith('kimi:terminal-close', { id: 't1' });
    exposed.closeNativeTerminal('');
    expect(send).toHaveBeenCalledTimes(3);

    const outputCb = vi.fn();
    exposed.onNativeTerminalOutput(outputCb);
    listeners.get('kimi:terminal-output')?.({}, { id: 't1', data: 'hello' });
    expect(outputCb).toHaveBeenCalledWith('t1', 'hello');
    listeners.get('kimi:terminal-output')?.({}, { id: 't1' });
    listeners.get('kimi:terminal-output')?.({}, 'hello');
    expect(outputCb).toHaveBeenCalledTimes(1);

    const exitCb = vi.fn();
    exposed.onNativeTerminalExit(exitCb);
    listeners.get('kimi:terminal-exit')?.({}, { id: 't1', exitCode: 0 });
    expect(exitCb).toHaveBeenCalledWith('t1', 0);
    listeners.get('kimi:terminal-exit')?.({}, { id: 't1' });
    expect(exitCb).toHaveBeenCalledWith('t1', null);
    listeners.get('kimi:terminal-exit')?.({}, { exitCode: 1 });
    expect(exitCb).toHaveBeenCalledTimes(2);
  });


  it('validates screenshot results before exposing them to the renderer', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;
    const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

    invoke.mockResolvedValueOnce({ status: 'ok', pngBytes, comment: 'look here', captureId: 'capture-token' });
    await expect(exposed.captureScreenshot()).resolves.toEqual({ status: 'ok', pngBytes, comment: 'look here', captureId: 'capture-token' });
    expect(invoke).toHaveBeenLastCalledWith('kimi:screenshot-capture');

    invoke.mockResolvedValueOnce({ status: 'completed' });
    await expect(exposed.captureScreenshot()).resolves.toEqual({ status: 'completed' });

    invoke.mockResolvedValueOnce({ status: 'ok', pngBytes: 'not-bytes', comment: '' });
    await expect(exposed.captureScreenshot()).resolves.toEqual({ status: 'error', reason: 'invalid screenshot-capture response' });
  });

  it('exposes screenshot guidance state, scoped actions, and removable subscriptions', async () => {
    await import('../../../src/main/ipc/preload');
    const [, exposed] = expose.mock.calls[0]!;
    invoke.mockResolvedValueOnce(null);
    await expect(exposed.getScreenshotGuidance()).resolves.toBeNull();
    expect(invoke).toHaveBeenLastCalledWith('kimi:screenshot-guide-get');
    await exposed.screenshotGuidanceAction('capture-token', 'settings');
    expect(invoke).toHaveBeenLastCalledWith('kimi:screenshot-guide-action', 'capture-token', 'settings');
    const callback = vi.fn();
    const unsubscribe = exposed.onScreenshotGuidance(callback);
    const guide = { captureId: 'capture-token' };
    listeners.get('kimi:screenshot-guide-changed')?.({}, guide);
    expect(callback).toHaveBeenCalledWith(guide);
    unsubscribe();
    expect(removeListener).toHaveBeenCalledWith('kimi:screenshot-guide-changed', expect.any(Function));
  });
});


it('advertises native overlays only for a window explicitly created as an overlay host', async () => {
  const previous = [...process.argv];
  try {
    process.argv = previous.filter(value => value !== '--kimi-native-overlay-host');
    const preview = await import('../../../src/main/ipc/preload');
    expect(preview.api.browserOverlaySupported).toBe(false);
    vi.resetModules();
    process.argv.push('--kimi-native-overlay-host');
    const host = await import('../../../src/main/ipc/preload');
    expect(host.api.browserOverlaySupported).toBe(true);
  } finally { process.argv = previous; }
});

it('advertises session links only when the main process passes the session link flag', async () => {
  const previous = [...process.argv];
  try {
    process.argv = previous.filter(value => value !== '--kimi-session-links');
    vi.resetModules();
    const unregistered = await import('../../../src/main/ipc/preload');
    expect(unregistered.api.sessionLinksSupported).toBe(false);
    vi.resetModules();
    process.argv.push('--kimi-session-links');
    const registered = await import('../../../src/main/ipc/preload');
    expect(registered.api.sessionLinksSupported).toBe(true);
  } finally { process.argv = previous; }
});
