import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  expose: vi.fn(),
  send: vi.fn(),
  on: vi.fn(),
  removeListener: vi.fn(),
  listeners: new Map<string, (...args: unknown[]) => void>(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: mocks.expose },
  ipcRenderer: {
    send: mocks.send,
    on: vi.fn((channel: string, listener: (...args: unknown[]) => void) => {
      mocks.listeners.set(channel, listener);
      mocks.on(channel, listener);
    }),
    removeListener: mocks.removeListener,
  },
}));

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.listeners.clear();
});

describe('browser overlay preload', () => {
  it('exposes only the bounded overlay renderer bridge', async () => {
    await import('../../../src/main/browser/browser-overlay-preload');
    expect(mocks.expose).toHaveBeenCalledOnce();
    const [name, bridge] = mocks.expose.mock.calls[0]!;
    expect(name).toBe('kimiBrowserOverlay');
    expect(Object.keys(bridge).sort()).toEqual(
      ['activate', 'dismiss', 'hidden', 'onConfig', 'onHide', 'onShown', 'ready', 'rendered', 'submitForm'].sort(),
    );

    bridge.ready();
    bridge.rendered({ requestId: 1, width: 220, height: 160 });
    bridge.rendered({ requestId: 0, width: 220, height: 160 });
    bridge.hidden({ requestId: 1 });
    bridge.hidden({ requestId: 0 });
    bridge.activate({ requestId: 1, itemId: 'browser' });
    bridge.activate({ requestId: 1, itemId: 'bad id' });
    bridge.activate({ requestId: 0, itemId: 'browser' });
    bridge.activate('browser');
    bridge.dismiss({ requestId: 1, reason: 'escape' });
    bridge.dismiss({ requestId: 1, reason: 'bogus' });
    bridge.dismiss({ requestId: 0, reason: 'escape' });
    bridge.dismiss('escape');
    expect(mocks.send.mock.calls).toEqual([
      ['kimi:browser-overlay-ready'],
      ['kimi:browser-overlay-rendered', { requestId: 1, width: 220, height: 160 }],
      ['kimi:browser-overlay-hidden', { requestId: 1 }],
      ['kimi:browser-overlay-activate', { requestId: 1, itemId: 'browser' }],
      ['kimi:browser-overlay-dismiss', { requestId: 1, reason: 'escape' }],
    ]);
  });

  it('forwards browser-scoped no-focus permission dialogs through preload', async () => {
    await import('../../../src/main/browser/browser-overlay-preload');
    const bridge = mocks.expose.mock.calls[0]![1];
    const cb = vi.fn();
    bridge.onConfig(cb);
    const config = { kind: 'dialog', requestId: 1, dialogId: 'permission', title: 'Permission', confirmLabel: 'Once', cancelLabel: 'Block', closeLabel: 'Close', variant: 'primary', auxiliary: { label: 'Always' }, preserveFocus: true, dismissible: false, boundary: { x: 600, y: 100, width: 400, height: 600 } };
    mocks.listeners.get('kimi:browser-overlay-config')!({}, config);
    expect(cb).toHaveBeenCalledWith(config);
  });

  it('sends bounded form actions and rejects malformed values', async () => {
    await import('../../../src/main/browser/browser-overlay-preload');
    const bridge = mocks.expose.mock.calls[0]![1];
    for (const action of ['confirm', 'cancel', 'auxiliary']) bridge.submitForm({ requestId: 2, action, value: 'Comment' });
    for (const invalid of [null, undefined, {}, { requestId: 0, action: 'confirm', value: '' }, { requestId: 2, action: 'execute', value: '' }, { requestId: 2, action: 'confirm', value: 3 }, { requestId: 2, action: 'confirm', value: 'x'.repeat(10_001) }]) bridge.submitForm(invalid);
    expect(mocks.send.mock.calls).toEqual(['confirm', 'cancel', 'auxiliary'].map((action) => ['kimi:browser-overlay-form-action', { requestId: 2, action, value: 'Comment' }]));
  });

  it('passes structurally valid menu configs and drops malformed pushes', async () => {
    await import('../../../src/main/browser/browser-overlay-preload');
    const bridge = mocks.expose.mock.calls[0]![1];
    const cb = vi.fn();
    const off = bridge.onConfig(cb);
    const listener = mocks.listeners.get('kimi:browser-overlay-config')!;
    const config = {
      kind: 'menu',
      requestId: 1,
      menuId: 'panel-tabs.add',
      anchor: { x: 10, y: 20, width: 28, height: 28 },
      items: [
        { kind: 'item', id: 'browser', label: 'Browser', description: 'Full description', tone: 'warning' },
        { kind: 'section', id: 'provider', label: 'Provider' },
        { kind: 'note', id: 'cache', label: 'Cache note' },
        { kind: 'choices', id: 'thinking', label: 'Thinking', value: 'high', options: [{ id: 'high', label: 'High' }] },
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
    listener({}, config);
    listener({}, { ...config, items: [] });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(config);
    off();
    expect(mocks.removeListener).toHaveBeenCalledWith(
      'kimi:browser-overlay-config',
      listener,
    );
  });

  it('preserves host layout dimensions while validating menu fields', async () => {
    await import('../../../src/main/browser/browser-overlay-preload');
    const bridge = mocks.expose.mock.calls[0]![1];
    const cb = vi.fn();
    bridge.onConfig(cb);
    const listener = mocks.listeners.get('kimi:browser-overlay-config')!;
    const config = {
      kind: 'menu', requestId: 1, menuId: 'layout',
      anchor: { x: 0, y: 0, width: 28, height: 28 },
      items: [{ kind: 'item', id: 'open', label: 'Open', disabled: false }],
    };
    for (const width of [1, 1200]) {
      const layout = { ...config, width, minWidth: 1, maxHeight: 300, autoWidth: true };
      listener({}, layout);
      expect(cb).toHaveBeenLastCalledWith(layout);
    }
    for (const invalid of [
      { ...config, kind: 'unknown' },
      { ...config, width: NaN },
      { ...config, maxHeight: -1 },
      { ...config, items: [{ ...config.items[0], disabled: 'false' }] },
      { ...config, items: [{ ...config.items[0], label: 'x'.repeat(257) }] },
    ]) listener({}, invalid);
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it('normalizes geometry and strips unrelated form fields before sending', async () => {
    await import('../../../src/main/browser/browser-overlay-preload');
    const bridge = mocks.expose.mock.calls[0]![1];
    bridge.rendered({ requestId: 3, width: 220.2, height: 160.1, extra: true });
    bridge.rendered({ requestId: 3, width: -1, height: 160 });
    bridge.rendered(null);
    bridge.rendered({ requestId: 3, width: 284.2, height: 140, anchorWidth: 160, anchorHeight: 140, offsetX: 124.1, offsetY: 0, placement: 'left', extra: true });
    bridge.rendered({ requestId: 3, width: 200, height: 140, anchorWidth: 240 });
    bridge.rendered({ requestId: 3, width: 200, height: 140, anchorWidth: 160, offsetX: 100 });
    bridge.rendered({ requestId: 3, width: 200, height: 140, placement: 'up' });
    bridge.submitForm({ requestId: 3, action: 'confirm', value: '', checked: false, extra: true });
    expect(mocks.send.mock.calls).toEqual([
      ['kimi:browser-overlay-rendered', { requestId: 3, width: 221, height: 161 }],
      ['kimi:browser-overlay-rendered', { requestId: 3, width: 285, height: 140, anchorWidth: 160, anchorHeight: 140, offsetX: 124, offsetY: 0, placement: 'left' }],
      ['kimi:browser-overlay-form-action', { requestId: 3, action: 'confirm', value: '', checked: false }],
    ]);
  });

  it('accepts bounded dialog configs and drops executable or malformed payloads', async () => {
    await import('../../../src/main/browser/browser-overlay-preload');
    const bridge = mocks.expose.mock.calls[0]![1];
    const cb = vi.fn();
    bridge.onConfig(cb);
    const listener = mocks.listeners.get('kimi:browser-overlay-config')!;
    const dialog = {
      kind: 'dialog',
      requestId: 2,
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
    listener({}, dialog);
    listener({}, { ...dialog, action: 'rm -rf' });
    listener({}, { ...dialog, variant: 'unknown' });
    listener({}, { ...dialog, checkbox: { label: 'Include screenshot', checked: 'false' } });
    listener({}, { ...dialog, viewport: undefined, checkbox: { label: 'Include screenshot', checked: 'false' } });
    expect(cb).toHaveBeenCalledOnce();
    expect(cb).toHaveBeenCalledWith(dialog);
  });

  it('validates shown and hide lifecycle pushes', async () => {
    await import('../../../src/main/browser/browser-overlay-preload');
    const bridge = mocks.expose.mock.calls[0]![1];
    const shown = vi.fn();
    const hide = vi.fn();
    const offShown = bridge.onShown(shown);
    const offHide = bridge.onHide(hide);
    const shownListener = mocks.listeners.get('kimi:browser-overlay-shown')!;
    const hideListener = mocks.listeners.get('kimi:browser-overlay-hide')!;

    shownListener({}, { requestId: 1, placement: 'bottom-end' });
    shownListener({}, { requestId: 2 });
    shownListener({}, { requestId: 1, placement: 'sideways' });
    hideListener({}, { requestId: 1 });
    hideListener({}, { requestId: 0 });

    expect(shown).toHaveBeenCalledTimes(2);
    expect(hide).toHaveBeenCalledOnce();
    offShown();
    offHide();
    expect(mocks.removeListener).toHaveBeenCalledWith(
      'kimi:browser-overlay-shown',
      shownListener,
    );
    expect(mocks.removeListener).toHaveBeenCalledWith(
      'kimi:browser-overlay-hide',
      hideListener,
    );
  });
});
