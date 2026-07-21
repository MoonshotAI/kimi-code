import { describe, it, expect, vi, beforeEach } from 'vitest';

const expose = vi.fn();
const send = vi.fn();
const removeListener = vi.fn();
const invoke = vi.fn().mockResolvedValue(undefined);

// `ipcRenderer.on` records the listener so a test can fire it and assert the
// renderer callback receives the forwarded payload (not just the channel name).
const listeners = new Map<string, (...args: unknown[]) => void>();
const on = vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
  listeners.set(channel, listener);
});

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: expose },
  ipcRenderer: { send, on, removeListener, invoke },
}));

const WHITELIST = [
  'checkForUpdates',
  'downloadUpdate',
  'getServerToken',
  'getUpdateStatus',
  'installUpdate',
  'isFullscreen',
  'listOpenInApps',
  'onFullscreenChanged',
  'onMenu',
  'onMenuAction',
  'onShortcut',
  'onTraySelectSession',
  'onUpdateStatus',
  'openExternal',
  'openInApp',
  'petDragEnd',
  'petDragMove',
  'petDragStart',
  'setLocale',
  'setTheme',
  'setTrayAttention',
  'showOpenDialog',
  'showSaveDialog',
  'showWindow',
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

    // Pet drag: validated screen points forward; junk never reaches main.
    exposed.petDragStart({ screenX: 100, screenY: 200 });
    expect(send).toHaveBeenCalledWith('kimi:pet-drag-start', { screenX: 100, screenY: 200 });
    exposed.petDragMove({ screenX: 120, screenY: 220 });
    expect(send).toHaveBeenCalledWith('kimi:pet-drag-move', { screenX: 120, screenY: 220 });
    exposed.petDragStart({ screenX: '100', screenY: 200 });
    exposed.petDragMove({ screenX: Number.NaN, screenY: 0 });
    expect(send).toHaveBeenCalledTimes(5);
    exposed.petDragEnd();
    expect(send).toHaveBeenCalledWith('kimi:pet-drag-end');
    expect(send).toHaveBeenCalledTimes(6);

    exposed.showWindow();
    expect(send).toHaveBeenCalledWith('kimi:show-window');

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

    await exposed.getServerToken();
    expect(invoke).toHaveBeenCalledWith('kimi:get-server-token');

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
});
