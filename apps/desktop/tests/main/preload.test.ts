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
  'getServerToken',
  'isFullscreen',
  'listOpenInApps',
  'onFullscreenChanged',
  'onMenu',
  'onMenuAction',
  'onShortcut',
  'openExternal',
  'openInApp',
  'setTheme',
  'showOpenDialog',
  'showSaveDialog',
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
  });
});
