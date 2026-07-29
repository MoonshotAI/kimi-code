import { describe, it, expect, vi, beforeEach } from 'vitest';

const expose = vi.fn();
const send = vi.fn();
const removeListener = vi.fn();
const invoke = vi.fn().mockResolvedValue(undefined);
const getPathForFile = vi.fn<(file: File) => string>();

// `ipcRenderer.on` records the listener so a test can fire it and assert the
// renderer callback receives the forwarded payload (not just the channel name).
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
  'checkForUpdates',
  'closeNativeTerminal',
  'createNativeTerminal',
  'downloadUpdate',
  'getPathForFile',
  'getUpdateAutoDownload',
  'getUpdateStatus',
  'getVibrancy',
  'installUpdate',
  'isFullscreen',
  'listOpenInApps',
  'log',
  'nativeTerminalInput',
  'nativeTerminalResize',
  'onFullscreenChanged',
  'onLaunchAction',
  'onMenu',
  'onMenuAction',
  'onNativeTerminalExit',
  'onNativeTerminalOutput',
  'popupWindowsMenu',
  'onShortcut',
  'onTraySelectSession',
  'onUpdateStatus',
  'openExternal',
  'openInApp',
  'getOsAppearance',
  'onOsAppearanceChanged',
  'setDockIconChoice',
  'setGlobalShortcut',
  'setGlobalShortcutSuspended',
  'setJumpList',
  'setLocale',
  'setMenuShortcuts',
  'setMenuSuspended',
  'setOnboarded',
  'setTerminalMenuFocus',
  'setTheme',
  'setTrayAttention',
  'setUpdateAutoDownload',
  'setVibrancy',
  'showOpenDialog',
  'showSaveDialog',
  'showWindow',
  'track',
];

beforeEach(() => {
  // `preload.ts` runs `contextBridge.exposeInMainWorld` at import time, so each
  // test needs a fresh module execution to observe its own `expose` call.
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
  it('exposes only the whitelisted API via contextBridge (no ipcRenderer/node/require)', async () => {
    await import('../../src/main/preload');
    expect(expose).toHaveBeenCalledOnce();
    const [name, exposed] = expose.mock.calls[0]!;

    expect(name).toBe('kimiDesktop');
    expect(Object.keys(exposed).sort()).toEqual([...WHITELIST].sort());

    // Sandbox boundary: the raw escape hatches must never reach the renderer.
    expect(Object.keys(exposed)).not.toContain('ipcRenderer');
    expect(Object.keys(exposed)).not.toContain('node');
    expect(Object.keys(exposed)).not.toContain('require');
    for (const key of Object.keys(exposed)) {
      expect(typeof exposed[key]).toBe('function');
    }
  });

  it('wires each whitelisted method to the correct ipcRenderer channel', async () => {
    await import('../../src/main/preload');
    const [, exposed] = expose.mock.calls[0]!;

    exposed.setTheme('dark');
    expect(send).toHaveBeenCalledWith('kimi:theme', 'dark');
    exposed.setTheme('bogus');
    expect(send).toHaveBeenCalledTimes(1); // invalid scheme ignored
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
    // Malformed attention payloads never reach the main process.
    exposed.setTrayAttention({ unread: -1, approvals: 0, questions: 0, items: [] });
    exposed.setTrayAttention({ unread: 1, approvals: 0, questions: 0 }); // no items
    exposed.setTrayAttention({ unread: 1, approvals: 0, questions: 0, items: [{ sessionId: '' }] });
    exposed.setTrayAttention('3');
    expect(send).toHaveBeenCalledTimes(2);

    exposed.setLocale('zh');
    expect(send).toHaveBeenCalledWith('kimi:locale', 'zh');
    exposed.setLocale('fr'); // unsupported locale ignored
    expect(send).toHaveBeenCalledTimes(3);

    // Menu shortcuts: the action→binding map forwards; junk is ignored.
    exposed.setMenuShortcuts({ openSettings: 'mod+,', newSession: null });
    expect(send).toHaveBeenCalledWith('kimi:menu-shortcut', { openSettings: 'mod+,', newSession: null });
    exposed.setMenuShortcuts('mod+,'); // junk ignored
    exposed.setMenuShortcuts(null);
    expect(send).toHaveBeenCalledTimes(4);

    // Menu suspend: booleans forward; junk is ignored.
    exposed.setMenuSuspended(true);
    expect(send).toHaveBeenCalledWith('kimi:menu-suspend', true);
    exposed.setMenuSuspended('yes'); // junk ignored
    expect(send).toHaveBeenCalledTimes(5);

    // Terminal menu focus: booleans forward; junk is ignored.
    exposed.setTerminalMenuFocus(true);
    expect(send).toHaveBeenCalledWith('kimi:menu-terminal-focus', true);
    exposed.setTerminalMenuFocus('yes');
    expect(send).toHaveBeenCalledTimes(6);

    // Global shortcut: action + nullable binding invoke; the boolean result
    // is validated (non-true resolves false); junk never reaches the channel.
    invoke.mockResolvedValueOnce(true);
    await expect(exposed.setGlobalShortcut('summonApp', 'mod+space')).resolves.toBe(true);
    expect(invoke).toHaveBeenCalledWith('kimi:global-shortcut', { action: 'summonApp', binding: 'mod+space' });
    invoke.mockResolvedValueOnce(true);
    await expect(exposed.setGlobalShortcut('summonApp', null)).resolves.toBe(true);
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.setGlobalShortcut('summonApp', 'mod+space')).resolves.toBe(false);
    await expect(exposed.setGlobalShortcut('summonApp', 42)).resolves.toBe(false);
    await expect(exposed.setGlobalShortcut(42, 'mod+space')).resolves.toBe(false);

    // Global-shortcut suspend: booleans invoke and the boolean result is
    // validated (non-true resolves false); junk never reaches the channel.
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

    exposed.setDockIconChoice('dark');
    expect(send).toHaveBeenCalledWith('kimi:dock-icon-choice', 'dark');
    exposed.setDockIconChoice('bogus');
    expect(send).toHaveBeenCalledTimes(9); // invalid choice ignored

    invoke.mockResolvedValueOnce('dark');
    await expect(exposed.getOsAppearance()).resolves.toBe('dark');
    expect(invoke).toHaveBeenCalledWith('kimi:os-appearance');
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.getOsAppearance()).resolves.toBe('light'); // malformed → light

    const offOs = exposed.onOsAppearanceChanged(() => {});
    expect(on).toHaveBeenCalledWith('kimi:os-appearance-changed', expect.any(Function));
    offOs();
    expect(removeListener).toHaveBeenCalledWith('kimi:os-appearance-changed', expect.any(Function));

    // Jump List: validated workspace lists forward; junk is ignored.
    const workspaces = [{ name: 'kimi', root: '/work/kimi' }];
    exposed.setJumpList(workspaces);
    expect(send).toHaveBeenCalledWith('kimi:jump-list', workspaces);
    exposed.setJumpList([{ name: 'x', root: '' }]); // empty root ignored
    exposed.setJumpList('nope'); // junk ignored
    expect(send).toHaveBeenCalledTimes(10);

    const offMenu = exposed.onMenu(() => {});
    expect(on).toHaveBeenCalledWith('kimi:menu', expect.any(Function));
    offMenu();
    expect(removeListener).toHaveBeenCalledWith('kimi:menu', expect.any(Function));

    const offAction = exposed.onMenuAction(() => {});
    expect(on).toHaveBeenCalledWith('kimi:menu-action', expect.any(Function));
    offAction();
    expect(removeListener).toHaveBeenCalledWith('kimi:menu-action', expect.any(Function));

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

    await exposed.openExternal('https://example.com');
    expect(invoke).toHaveBeenCalledWith('kimi:open-external', 'https://example.com');

    const openOpts = { properties: ['openDirectory'] };
    await exposed.showOpenDialog(openOpts);
    expect(invoke).toHaveBeenCalledWith('kimi:dialog-open', openOpts);

    const saveOpts = { defaultPath: 'untitled.txt' };
    await exposed.showSaveDialog(saveOpts);
    expect(invoke).toHaveBeenCalledWith('kimi:dialog-save', saveOpts);

    await exposed.listOpenInApps();
    expect(invoke).toHaveBeenCalledWith('kimi:open-in-list');

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

    // Vibrancy toggle: booleans forward; junk is ignored.
    exposed.setVibrancy(false);
    expect(send).toHaveBeenCalledWith('kimi:vibrancy', false);
    exposed.setVibrancy('yes'); // junk ignored
    expect(send).toHaveBeenCalledTimes(11);

    // getVibrancy: only an explicit false from the main process disables.
    invoke.mockResolvedValueOnce(false);
    await expect(exposed.getVibrancy()).resolves.toBe(false);
    expect(invoke).toHaveBeenCalledWith('kimi:get-vibrancy');
    invoke.mockResolvedValueOnce(true);
    await expect(exposed.getVibrancy()).resolves.toBe(true);
    invoke.mockResolvedValueOnce('junk');
    await expect(exposed.getVibrancy()).resolves.toBe(true);

    await exposed.getUpdateAutoDownload();
    expect(invoke).toHaveBeenCalledWith('kimi:update-get-auto-download');

    await exposed.setUpdateAutoDownload(false);
    expect(invoke).toHaveBeenCalledWith('kimi:update-set-auto-download', false);

    // A non-boolean set payload is dropped before reaching IPC.
    await exposed.setUpdateAutoDownload('yes' as unknown as boolean);
    expect(invoke).not.toHaveBeenCalledWith('kimi:update-set-auto-download', 'yes');

    // Renderer log forwarding: whitelisted levels + non-empty string messages
    // send; junk never reaches the main process.
    exposed.log('warn', 'something', { code: 1 });
    expect(send).toHaveBeenCalledWith('kimi:renderer-log', {
      level: 'warn',
      message: 'something',
      detail: { code: 1 },
    });
    exposed.log('debug' as 'warn', 'x');
    exposed.log('info', '');
    exposed.log('info', 42 as unknown as string);
    expect(send).toHaveBeenCalledTimes(12);

    // Telemetry: non-empty event names forward; empty ones are dropped.
    exposed.track('action_invoked', { action: 'newSession', source: 'shortcut' });
    expect(send).toHaveBeenCalledWith('kimi:track', 'action_invoked', {
      action: 'newSession',
      source: 'shortcut',
    });
    exposed.track('');
    expect(send).toHaveBeenCalledTimes(13);
  });

  it('coerces the auto-download preference response to a boolean default', async () => {
    await import('../../src/main/preload');
    const [, exposed] = expose.mock.calls[0]!;

    invoke.mockResolvedValueOnce(false);
    await expect(exposed.getUpdateAutoDownload()).resolves.toBe(false);

    invoke.mockResolvedValueOnce(true);
    await expect(exposed.getUpdateAutoDownload()).resolves.toBe(true);

    // Junk responses fall back to the main-side default (disabled).
    invoke.mockResolvedValueOnce(undefined);
    await expect(exposed.getUpdateAutoDownload()).resolves.toBe(false);
  });

  it('forwards menu-action and shortcut payloads to the renderer callback', async () => {
    await import('../../src/main/preload');
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
    // Anything that isn't a strict boolean true is coerced to false (no
    // accidental truthy strings leaking into the renderer state).
    listeners.get('kimi:fullscreen-changed')?.({}, 'yes');
    expect(fullscreenCb).toHaveBeenLastCalledWith(false);

    // Tray session-select: non-empty session ids forward; junk is dropped.
    const traySelectCb = vi.fn();
    exposed.onTraySelectSession(traySelectCb);
    listeners.get('kimi:tray-select-session')?.({}, 'session-123');
    expect(traySelectCb).toHaveBeenCalledWith('session-123');
    listeners.get('kimi:tray-select-session')?.({}, '');
    listeners.get('kimi:tray-select-session')?.({}, 42);
    expect(traySelectCb).toHaveBeenCalledTimes(1);

    // Update statuses pass through after structural validation; malformed
    // payloads (wrong state, non-object) are dropped.
    const updateCb = vi.fn();
    exposed.onUpdateStatus(updateCb);
    listeners.get('kimi:update-status')?.({}, { state: 'downloading', version: '1.2.3', percent: 42, releaseDate: '2026-07-18' });
    expect(updateCb).toHaveBeenCalledWith({ state: 'downloading', version: '1.2.3', percent: 42, releaseDate: '2026-07-18' });
    listeners.get('kimi:update-status')?.({}, { state: 'bogus' });
    listeners.get('kimi:update-status')?.({}, 'available');
    expect(updateCb).toHaveBeenCalledTimes(1);

    // Launch actions forward after structural validation; junk is dropped.
    const launchCb = vi.fn();
    exposed.onLaunchAction(launchCb);
    listeners.get('kimi:launch-action')?.({}, { action: 'new-chat' });
    expect(launchCb).toHaveBeenCalledWith({ action: 'new-chat' });
    listeners.get('kimi:launch-action')?.({}, { action: 'open-workspace', root: '/work/kimi' });
    expect(launchCb).toHaveBeenCalledWith({ action: 'open-workspace', root: '/work/kimi' });
    listeners.get('kimi:launch-action')?.({}, { action: 'open-workspace' }); // no root
    listeners.get('kimi:launch-action')?.({}, { action: 'bogus' });
    listeners.get('kimi:launch-action')?.({}, 'new-chat');
    expect(launchCb).toHaveBeenCalledTimes(2);
  });

  it('passes release notes through field-wise validation, dropping junk note fields only', async () => {
    await import('../../src/main/preload');
    const [, exposed] = expose.mock.calls[0]!;

    const cb = vi.fn();
    exposed.onUpdateStatus(cb);
    listeners.get('kimi:update-status')?.({}, { state: 'available', version: '1.2.3', releaseNotes: { zh: '- 修复', en: '- Fixed' } });
    expect(cb).toHaveBeenCalledWith({ state: 'available', version: '1.2.3', releaseNotes: { zh: '- 修复', en: '- Fixed' } });

    // A non-object notes payload is stripped; the status itself survives.
    listeners.get('kimi:update-status')?.({}, { state: 'available', version: '1.2.3', releaseNotes: 'not-an-object' });
    expect(cb).toHaveBeenLastCalledWith({ state: 'available', version: '1.2.3' });
    // Non-string fields fall away one by one.
    listeners.get('kimi:update-status')?.({}, { state: 'available', version: '1.2.3', releaseNotes: { zh: 42, en: true } });
    expect(cb).toHaveBeenLastCalledWith({ state: 'available', version: '1.2.3', releaseNotes: {} });
  });

  it('validates update-check responses and falls back to an error outcome', async () => {
    await import('../../src/main/preload');
    const [, exposed] = expose.mock.calls[0]!;

    invoke.mockResolvedValueOnce({ outcome: 'available', version: '1.2.3' });
    await expect(exposed.checkForUpdates()).resolves.toEqual({ outcome: 'available', version: '1.2.3' });

    invoke.mockResolvedValueOnce({ outcome: 'latest' });
    await expect(exposed.checkForUpdates()).resolves.toEqual({ outcome: 'latest' });

    // An error outcome without a message gets a placeholder; junk falls back.
    invoke.mockResolvedValueOnce({ outcome: 'error' });
    await expect(exposed.checkForUpdates()).resolves.toEqual({ outcome: 'error', message: 'unknown error' });
    invoke.mockResolvedValueOnce({ outcome: 'bogus' });
    await expect(exposed.checkForUpdates()).resolves.toEqual({
      outcome: 'error',
      message: 'invalid update-check response',
    });
  });

  it('resolves dropped-file paths via webUtils, mapping failures to null', async () => {
    await import('../../src/main/preload');
    const [, exposed] = expose.mock.calls[0]!;
    const file = new File(['x'], 'folder');

    getPathForFile.mockReturnValueOnce('/work/dir');
    expect(exposed.getPathForFile(file)).toBe('/work/dir');
    expect(getPathForFile).toHaveBeenCalledWith(file);

    // No file backing (dragged out of a web page) → empty string → null.
    getPathForFile.mockReturnValueOnce('');
    expect(exposed.getPathForFile(file)).toBeNull();

    // A webUtils throw must never cross the bridge.
    getPathForFile.mockImplementationOnce(() => {
      throw new Error('bad file');
    });
    expect(exposed.getPathForFile(file)).toBeNull();
  });

  it('wires the native terminal methods and validates both directions', async () => {
    await import('../../src/main/preload');
    const [, exposed] = expose.mock.calls[0]!;

    // create: valid options pass through; junk fields are stripped.
    invoke.mockResolvedValueOnce({ id: 't1', shell: 'zsh', cwd: '/work' });
    await expect(
      exposed.createNativeTerminal({ cwd: '/work', cols: 120, rows: 30 }),
    ).resolves.toEqual({ id: 't1', shell: 'zsh', cwd: '/work' });
    expect(invoke).toHaveBeenCalledWith('kimi:terminal-create', { cwd: '/work', cols: 120, rows: 30 });
    invoke.mockResolvedValueOnce({ id: 't2', shell: 'zsh', cwd: '/' });
    await exposed.createNativeTerminal({ cwd: '', cols: Number.NaN });
    expect(invoke).toHaveBeenLastCalledWith('kimi:terminal-create', {});
    // A malformed main-process response rejects instead of leaking junk.
    invoke.mockResolvedValueOnce({ shell: 'zsh' });
    await expect(exposed.createNativeTerminal()).rejects.toThrow('terminal-create');

    // input/resize/close: valid payloads forward; malformed ones never send.
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

    // output/exit events forward after structural validation.
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
    // Missing/invalid exitCode maps to null (signal kills carry none).
    listeners.get('kimi:terminal-exit')?.({}, { id: 't1' });
    expect(exitCb).toHaveBeenCalledWith('t1', null);
    listeners.get('kimi:terminal-exit')?.({}, { exitCode: 1 });
    expect(exitCb).toHaveBeenCalledTimes(2);
  });
});
