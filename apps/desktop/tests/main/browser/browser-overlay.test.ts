import { asBrowserOverlayRendered } from '../../../src/shared/browser-overlay';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeWebContents {
    handlers = new Map<string, Array<(...args: unknown[]) => void>>();
    destroyed = false;
    send = vi.fn();
    focused = false;
    focus = vi.fn(() => { this.focused = true; });
    isFocused(): boolean { return this.focused; }
    close = vi.fn(() => {
      this.destroyed = true;
      this.emit('destroyed');
    });
    loadURL = vi.fn(async () => undefined);
    setWindowOpenHandler = vi.fn();
    setZoomFactor = vi.fn();
    on(event: string, cb: (...args: unknown[]) => void): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    }
    once(event: string, cb: (...args: unknown[]) => void): void {
      this.on(event, cb);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = [];
    webContents = new FakeWebContents();
    options: unknown;
    visible = false;
    background = '';
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    constructor(options: unknown) {
      this.options = options;
      FakeWebContentsView.instances.push(this);
    }
    setVisible(value: boolean): void {
      this.visible = value;
    }
    setBackgroundColor(value: string): void {
      this.background = value;
    }
    setBounds(value: { x: number; y: number; width: number; height: number }): void {
      this.bounds = value;
    }
  }

  return { FakeWebContents, FakeWebContentsView, logError: vi.fn(), packaged: false, devBase: vi.fn<() => string | undefined>(() => undefined) };
});

vi.mock('electron', () => ({ app: { get isPackaged() { return mocks.packaged; } }, WebContentsView: mocks.FakeWebContentsView }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { error: mocks.logError } }));
vi.mock('../../../src/main/app/protocol', () => ({ rendererDevBase: mocks.devBase }));
vi.mock('@moonshot-ai/app-ui', async () => {
  const { ref } = await import('vue');
  return { openDialogCount: ref(0), registerExternalMenuSurface: () => () => {} };
});

import { effectScope, nextTick, ref, watchEffect, type Ref } from 'vue';
import {
  activateBrowserOverlayItem,
  dismissBrowserOverlay,
  attachBrowserOverlayWindow,
  browserOverlayBounds,
  closeBrowserOverlayDialog,
  closeBrowserOverlayMenu,
  destroyBrowserOverlay,
  isBrowserOverlaySender,
  markBrowserOverlayHidden,
  markBrowserOverlayReady,
  openBrowserOverlayMenu,
  openBrowserOverlayDialog,
  submitBrowserOverlayForm,
  observeBrowserOverlayOutsidePointer,
  showBrowserOverlayRendered,
} from '../../../src/main/browser/browser-overlay';
import { IPC } from '../../../src/main/ipc/ipc-channels';
import {
  asBrowserOverlayMenuRequest,
  asBrowserOverlayDialogRequest,
  isBrowserOverlayConfig,
  type BrowserOverlayAction,
  type BrowserOverlayAnchor,
  type BrowserOverlayClosed,
  type BrowserOverlayMenuConfig,
  type BrowserOverlayMenuItem,
} from '../../../src/shared/browser-overlay';

interface RendererOverlayMenus {
  registerBrowserOverlayMenu: (registration: { id: string; items: () => BrowserOverlayMenuItem[]; onSelect: (itemId: string) => void }) => {
    open: Readonly<Ref<boolean>>;
    showAt: (anchor: BrowserOverlayAnchor) => void;
    refresh: () => void;
  };
}

function createHost(width = 1200, height = 800, reportedWidth = width, reportedHeight = height) {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const children: unknown[] = [];
  const webContentsHandlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const webContents = {
    destroyed: false,
    getZoomFactor: vi.fn(() => 1),
    send: vi.fn(),
    focus: vi.fn(),
    on(event: string, cb: (...args: unknown[]) => void): void {
      webContentsHandlers.set(event, [...(webContentsHandlers.get(event) ?? []), cb]);
    },
    emit(event: string, ...args: unknown[]): void {
      for (const cb of webContentsHandlers.get(event) ?? []) cb(...args);
    },
    isDestroyed(): boolean {
      return this.destroyed;
    },
  };
  return {
    destroyed: false,
    focused: true,
    isFocused(): boolean { return this.focused; },
    webContents,
    contentView: {
      children,
      getBounds: vi.fn(() => ({ x: 0, y: 0, width, height })),
      addChildView: vi.fn((view: unknown) => {
        const existing = children.indexOf(view);
        if (existing !== -1) children.splice(existing, 1);
        children.push(view);
      }),
      removeChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index !== -1) children.splice(index, 1);
      }),
    },
    getContentSize: vi.fn(() => [reportedWidth, reportedHeight]),
    getContentBounds: vi.fn(() => ({ x: 0, y: 0, width, height })),
    getBounds: vi.fn(() => ({ x: 0, y: 0, width, height })),
    on(event: string, cb: (...args: unknown[]) => void): void {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
    },
    once(event: string, cb: (...args: unknown[]) => void): void {
      this.on(event, cb);
    },
    emit(event: string, ...args: unknown[]): void {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    isDestroyed(): boolean {
      return this.destroyed;
    },
  };
}

const request = {
  menuId: 'panel-tabs.add',
  anchor: { x: 1000, y: 20, width: 28, height: 28 },
  placement: 'bottom-end' as const,
  offset: 4,
  width: 220,
  items: [
    { kind: 'item' as const, id: 'browser', label: 'Browser', icon: 'browser' },
    { kind: 'item' as const, id: 'term', label: 'Terminal', disabled: true },
  ],
};

describe('browser overlay placement', () => {
  it('end-aligns below the trigger and includes the transparent shadow gutter', () => {
    const config = { ...request, kind: 'menu' as const, requestId: 1 } satisfies BrowserOverlayMenuConfig;
    expect(
      browserOverlayBounds({
        contentWidth: 1200,
        contentHeight: 800,
        config,
        cardWidth: 220,
        cardHeight: 160,
      }),
    ).toEqual({ x: 796, y: 40, width: 244, height: 184 });
  });

  it('flips above and clamps horizontally near window edges', () => {
    const config = {
      ...request,
      kind: 'menu' as const,
      requestId: 1,
      anchor: { x: 2, y: 740, width: 20, height: 20 },
      placement: 'bottom-start' as const,
    } satisfies BrowserOverlayMenuConfig;
    expect(
      browserOverlayBounds({
        contentWidth: 900,
        contentHeight: 780,
        config,
        cardWidth: 220,
        cardHeight: 180,
      }),
    ).toEqual({ x: 0, y: 544, width: 244, height: 204 });
  });
});

describe('browser overlay menu protocol', () => {
  it('projects row actions and progress and rejects invalid or duplicate action ids', () => {
    const row = {
      kind: 'item' as const, id: 'row:a', label: 'a.zip', icon: 'file',
      progress: { label: 'Downloading a.zip', value: 0.5, paused: false, extra: 1 },
      actions: [{ id: 'pause:a', label: 'Pause', icon: 'pause', keepOpen: true, extra: 1 }, { id: 'show:a', label: 'Show', icon: 'folder', keepOpen: false }],
    };
    expect(asBrowserOverlayMenuRequest({ ...request, items: [row] })?.items[0]).toEqual({
      kind: 'item', id: 'row:a', label: 'a.zip', icon: 'file',
      progress: { label: 'Downloading a.zip', value: 0.5 },
      actions: [{ id: 'pause:a', label: 'Pause', icon: 'pause', keepOpen: true }, { id: 'show:a', label: 'Show', icon: 'folder' }],
    });
    expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...row, progress: { label: 'x', value: 2 } }] })).toBeNull();
    expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...row, actions: [{ id: 'row:a', label: 'Dup', icon: 'pause' }] }] })).toBeNull();
    expect(asBrowserOverlayMenuRequest({ ...request, items: [row, { kind: 'item', id: 'show:a', label: 'Other' }] })).toBeNull();
    expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...row, actions: [{ id: 'x', label: 'X', icon: 'bad icon' }] }] })).toBeNull();
    expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...row, actions: Array.from({ length: 5 }, (_, i) => ({ id: `a${i}`, label: 'A', icon: 'pause' })) }] })).toBeNull();
  });

  it('keeps only a true refresh marker on menu requests', () => {
    expect(asBrowserOverlayMenuRequest({ ...request, refresh: true })).toMatchObject({ menuId: request.menuId, refresh: true });
    expect(asBrowserOverlayMenuRequest({ ...request, refresh: false })).not.toHaveProperty('refresh');
    expect(asBrowserOverlayMenuRequest({ ...request, refresh: 'yes' })).toBeNull();
  });

  it('preserves a bounded icon on composite Zoom rows', () => {
    const parsed = asBrowserOverlayMenuRequest({
      ...request,
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
    });
    expect(parsed).not.toBeNull();
    expect(parsed?.items[0]).toMatchObject({ kind: 'zoom', icon: 'zoom-scan' });
    expect(
      asBrowserOverlayMenuRequest({
        ...request,
        items: [{ ...parsed!.items[0]!, icon: 'bad icon' }],
      }),
    ).toBeNull();
  });
});

describe('browser overlay lifecycle', () => {
  beforeEach(() => {
    mocks.packaged = false;
    mocks.devBase.mockReset().mockReturnValue(undefined);
    destroyBrowserOverlay();
    mocks.FakeWebContentsView.instances = [];
    vi.clearAllMocks();
  });

  it('prewarms a transparent isolated view, then shows it topmost after paint', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    expect(view.options).toMatchObject({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });
    expect(view.background).toBe('#00000000');
    expect(view.visible).toBe(false);
    expect(view.webContents.loadURL).toHaveBeenCalledWith('app://renderer/browser-overlay.html');
    expect(isBrowserOverlaySender(view.webContents as never)).toBe(true);

    openBrowserOverlayMenu(request);
    markBrowserOverlayReady(view.webContents as never);
    expect(view.webContents.send).toHaveBeenCalledWith(
      IPC.browserOverlayConfig,
      expect.objectContaining({ menuId: 'panel-tabs.add', requestId: 1 }),
    );
    showBrowserOverlayRendered(view.webContents as never, {
      requestId: 1,
      width: 220,
      height: 160,
    });
    expect(view.visible).toBe(true);
    expect(host.contentView.children.at(-1)).toBe(view);
    expect(view.webContents.focus).toHaveBeenCalledOnce();
    expect(view.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayShown, {
      requestId: 1,
      placement: 'bottom-end',
    });
  });

  it('ignores an activation from a replaced native menu', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu({ ...request, menuId: 'site-a' });
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 160 });
    openBrowserOverlayMenu({ ...request, menuId: 'site-b' });
    showBrowserOverlayRendered(view.webContents as never, { requestId: 2, width: 220, height: 160 });
    host.webContents.send.mockClear();
    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'browser' });
    dismissBrowserOverlay(view.webContents as never, { requestId: 1, reason: 'escape' });
    expect(host.webContents.send).not.toHaveBeenCalled();
    expect(view.visible).toBe(true);
    activateBrowserOverlayItem(view.webContents as never, { requestId: 2, itemId: 'browser' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayAction, { menuId: 'site-b', itemId: 'browser' });
  });

  it('[L0:desktop.overlay-menu-stays-closed] keeps a menu closed by Escape when the renderer refreshes it before the close reaches the renderer', async () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    const toRenderer: Array<[string, unknown]> = [];
    host.webContents.send.mockImplementation((channel: string, payload: unknown) => { toRenderer.push([channel, payload]); });
    const requests: unknown[] = [];
    let onAction: ((payload: BrowserOverlayAction) => void) | undefined;
    let onClosed: ((payload: BrowserOverlayClosed) => void) | undefined;
    vi.stubGlobal('document', { hasFocus: () => true, activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
    vi.stubGlobal('window', {
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      requestAnimationFrame: (callback: (time: number) => void) => { callback(0); return 1; },
      kimiDesktop: {
        browserOverlaySupported: true,
        browserOverlayOpenMenu: (request: unknown) => {
          requests.push(request);
          const sanitized = asBrowserOverlayMenuRequest(request);
          if (sanitized !== null) openBrowserOverlayMenu(sanitized);
        },
        browserOverlayCloseMenu: (menuId: string) => closeBrowserOverlayMenu(menuId),
        onBrowserOverlayAction: (callback: (payload: BrowserOverlayAction) => void) => { onAction = callback; return () => {}; },
        onBrowserOverlayClosed: (callback: (payload: BrowserOverlayClosed) => void) => { onClosed = callback; return () => {}; },
      },
    });
    const rendererCatchesUp = async (): Promise<void> => {
      for (const [channel, payload] of toRenderer.splice(0)) {
        if (channel === IPC.browserOverlayAction) onAction?.(payload as BrowserOverlayAction);
        if (channel === IPC.browserOverlayClosed) onClosed?.(payload as BrowserOverlayClosed);
        await nextTick();
      }
    };
    let renderedConfigs = 0;
    const overlayRendersNewConfigs = (): void => {
      const configs = view.webContents.send.mock.calls.filter(([channel]) => channel === IPC.browserOverlayConfig);
      for (const [, config] of configs.slice(renderedConfigs)) {
        showBrowserOverlayRendered(view.webContents as never, { requestId: (config as BrowserOverlayMenuConfig).requestId, width: 220, height: 160 });
      }
      renderedConfigs = configs.length;
    };
    const { registerBrowserOverlayMenu } = await vi.importActual<RendererOverlayMenus>('../../../src/renderer/lib/browserOverlayMenu');
    const thinking = ref('high');
    const scope = effectScope();
    try {
      const menu = scope.run(() => {
        const registered = registerBrowserOverlayMenu({
          id: 'composer-models',
          items: () => [
            { kind: 'item', id: 'model', label: 'Thinking Stub', selected: true },
            { kind: 'choices', id: 'thinking', label: 'Thinking', value: `thinking-${thinking.value}`, options: [{ id: 'thinking-off', label: 'Off' }, { id: 'thinking-high', label: 'High' }] },
          ],
          onSelect: (itemId) => { thinking.value = itemId.slice('thinking-'.length); },
        });
        watchEffect(() => { if (registered.open.value) registered.refresh(); });
        return registered;
      })!;
      menu.showAt({ x: 900, y: 845, width: 120, height: 32 });
      await nextTick();
      overlayRendersNewConfigs();
      expect(view.visible).toBe(true);
      const { menuId } = requests[0] as { menuId: string };

      activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'thinking-off' });
      dismissBrowserOverlay(view.webContents as never, { requestId: 1, reason: 'escape' });
      expect(toRenderer.map(([channel]) => channel)).toEqual([IPC.browserOverlayAction, IPC.browserOverlayClosed]);
      const sentBeforeCatchingUp = requests.length;
      await rendererCatchesUp();
      markBrowserOverlayHidden(view.webContents as never, { requestId: 1 });
      overlayRendersNewConfigs();

      expect(menu.open.value, 'the renderer treats the menu as closed').toBe(false);
      expect(view.visible, 'the overlay stays hidden after Escape').toBe(false);
      expect(
        view.webContents.send.mock.calls.filter(([channel, config]) => channel === IPC.browserOverlayConfig && (config as BrowserOverlayMenuConfig).requestId !== 1),
        'no new menu is presented after Escape',
      ).toEqual([]);
      expect(requests.slice(sentBeforeCatchingUp), 'the renderer refreshed the menu after the main process had closed it').toEqual([
        expect.objectContaining({ menuId, items: [expect.anything(), expect.objectContaining({ value: 'thinking-off' })] }),
      ]);
    } finally {
      scope.stop();
      vi.unstubAllGlobals();
    }
  });

  type OverlayView = InstanceType<typeof mocks.FakeWebContentsView>;
  type Host = ReturnType<typeof createHost>;
  it.each<[string, (view: OverlayView, host: Host) => void]>([
    ['Escape', (view) => dismissBrowserOverlay(view.webContents as never, { requestId: 1, reason: 'escape' })],
    ['a click on another page', () => {
      const page = new mocks.FakeWebContents();
      observeBrowserOverlayOutsidePointer(page as never);
      page.emit('before-mouse-event', {}, { type: 'mouseDown' });
    }],
    ['window blur', (_view, host) => host.emit('blur')],
    ['a closing action', (view) => activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'browser' })],
  ])('does not reopen a menu closed by %s when a refresh the host sent before hearing about it arrives', (_trigger, close) => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu(request);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 160 });
    openBrowserOverlayMenu({ ...request, refresh: true, items: [request.items[0]!] });
    expect(view.webContents.send).toHaveBeenLastCalledWith(IPC.browserOverlayConfig, expect.objectContaining({ requestId: 1, items: [request.items[0]] }));
    expect(view.webContents.send.mock.lastCall?.[1]).not.toHaveProperty('refresh');

    close(view, host);
    view.webContents.send.mockClear();
    openBrowserOverlayMenu({ ...request, refresh: true });
    expect(view.webContents.send).not.toHaveBeenCalled();
    markBrowserOverlayHidden(view.webContents as never, { requestId: 1 });
    expect(view.visible).toBe(false);
    expect(host.webContents.send.mock.calls.filter(([channel]) => channel === IPC.browserOverlayClosed)).toEqual([
      [IPC.browserOverlayClosed, expect.objectContaining({ menuId: request.menuId })],
    ]);

    openBrowserOverlayMenu({ ...request, menuId: 'panel-tabs.add.reopened' });
    expect(view.webContents.send).toHaveBeenLastCalledWith(IPC.browserOverlayConfig, expect.objectContaining({ menuId: 'panel-tabs.add.reopened', requestId: 2 }));
  });

  it.each([
    ['menu', () => openBrowserOverlayMenu({ ...request, menuId: 'menu-b' })],
    ['dialog', () => openBrowserOverlayDialog({ dialogId: 'confirm', title: 'Confirm', confirmLabel: 'OK', cancelLabel: 'Cancel', closeLabel: 'Close' })],
  ])('keeps a %s that replaced a menu when a late refresh of the replaced menu arrives', (_kind, replace) => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu({ ...request, menuId: 'menu-a' });
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 160 });
    replace();
    showBrowserOverlayRendered(view.webContents as never, { requestId: 2, width: 220, height: 160 });
    host.webContents.send.mockClear();
    view.webContents.send.mockClear();

    openBrowserOverlayMenu({ ...request, menuId: 'menu-a', refresh: true });
    expect(view.webContents.send).not.toHaveBeenCalled();
    expect(host.webContents.send).not.toHaveBeenCalled();
    expect(view.visible).toBe(true);
    dismissBrowserOverlay(view.webContents as never, { requestId: 2, reason: 'escape' });
    expect(host.webContents.send).toHaveBeenCalledOnce();
    expect(host.webContents.send.mock.lastCall?.[1]).toMatchObject({ reason: 'escape' });
  });

  it('dismisses only the current native overlay presentation', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu(request);
    const view = mocks.FakeWebContentsView.instances[0]!;
    dismissBrowserOverlay(view.webContents as never, { requestId: 1, reason: 'escape' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayClosed, { menuId: request.menuId, reason: 'escape' });
  });

  it('animates out, routes enabled actions, rejects disabled actions and restores host focus', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu(request);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, {
      requestId: 1,
      width: 220,
      height: 160,
    });

    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'term' });
    expect(host.webContents.send).not.toHaveBeenCalled();
    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'browser' });
    expect(host.webContents.focus).toHaveBeenCalledOnce();
    const actionIndex = host.webContents.send.mock.calls.findIndex(([channel]) => channel === IPC.browserOverlayAction);
    expect(host.webContents.focus.mock.invocationCallOrder[0]).toBeLessThan(host.webContents.send.mock.invocationCallOrder[actionIndex]!);
    expect(view.visible).toBe(true);
    expect(view.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayHide, {
      requestId: 1,
    });
    markBrowserOverlayHidden(view.webContents as never, { requestId: 1 });
    expect(view.visible).toBe(false);
    expect(host.webContents.focus).toHaveBeenCalledOnce();
    expect(host.webContents.send.mock.calls).toEqual([
      [IPC.browserOverlayClosed, { menuId: 'panel-tabs.add', reason: 'action' }],
      [IPC.browserOverlayAction, { menuId: 'panel-tabs.add', itemId: 'browser' }],
    ]);
  });

  it('leaves address autocomplete focus untouched when dismissed', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu({ ...request, preserveFocus: true });
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 360, height: 120 });
    expect(view.webContents.focus).not.toHaveBeenCalled();
    const page = new mocks.FakeWebContents();
    observeBrowserOverlayOutsidePointer(page as never);
    page.emit('before-mouse-event', {}, { type: 'mouseDown' });
    markBrowserOverlayHidden(view.webContents as never, { requestId: 1 });
    expect(view.visible).toBe(false);
    expect(host.webContents.focus).not.toHaveBeenCalled();
  });

  it.each(['page', 'window'] as const)('does not reclaim focus moved to another %s during the closing animation', (destination) => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu(request);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 160 });
    closeBrowserOverlayMenu(request.menuId, 'escape');
    if (destination === 'page') view.webContents.focused = false;
    else host.focused = false;
    markBrowserOverlayHidden(view.webContents as never, { requestId: 1 });
    expect(host.webContents.focus).not.toHaveBeenCalled();
  });

  it('returns focus on Escape when the menu still owns it', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu(request);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 160 });
    closeBrowserOverlayMenu(request.menuId, 'escape');
    markBrowserOverlayHidden(view.webContents as never, { requestId: 1 });
    expect(host.webContents.focus).toHaveBeenCalledOnce();
  });

  it('closes on host resize and ignores a close for another menu id', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu(request);
    const view = mocks.FakeWebContentsView.instances[0]!;
    closeBrowserOverlayMenu('other');
    host.emit('resize');
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayClosed, {
      menuId: 'panel-tabs.add',
      reason: 'window-resize',
    });
    expect(view.visible).toBe(false);
  });

  it('leaves host pointer events to DOM toggle handlers and dismisses on sibling page input', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    const pageContents = new mocks.FakeWebContents();
    observeBrowserOverlayOutsidePointer(pageContents as never);

    openBrowserOverlayMenu(request);
    host.webContents.emit('before-mouse-event', {}, { type: 'mouseMove', x: 10, y: 10 });
    expect(host.webContents.send).not.toHaveBeenCalledWith(
      IPC.browserOverlayClosed,
      expect.anything(),
    );
    host.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 10, y: 10 });
    expect(host.webContents.send).not.toHaveBeenCalledWith(IPC.browserOverlayClosed, expect.anything());

    host.webContents.send.mockClear();
    openBrowserOverlayMenu(request);
    pageContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 20, y: 30 });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayClosed, {
      menuId: 'panel-tabs.add',
      reason: 'dismiss',
    });
  });

  it('keeps composite Zoom actions open and updates the same menu in place', () => {
    const host = createHost();
    const zoomItem = {
      kind: 'zoom' as const,
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
    };
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu({ ...request, menuId: 'browser.toolbar.browser-1', items: [zoomItem] });
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, {
      requestId: 1,
      width: 220,
      height: 60,
    });
    view.webContents.send.mockClear();
    host.webContents.send.mockClear();

    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'zoom-in' });
    expect(view.visible).toBe(true);
    expect(view.webContents.send).not.toHaveBeenCalledWith(
      IPC.browserOverlayHide,
      expect.anything(),
    );
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayAction, {
      menuId: 'browser.toolbar.browser-1',
      itemId: 'zoom-in',
      keepOpen: true,
    });

    openBrowserOverlayMenu({
      ...request,
      menuId: 'browser.toolbar.browser-1',
      items: [{ ...zoomItem, value: '110%' }],
    });
    expect(view.webContents.send).toHaveBeenCalledWith(
      IPC.browserOverlayConfig,
      expect.objectContaining({ requestId: 1, menuId: 'browser.toolbar.browser-1' }),
    );
    expect(host.webContents.send).not.toHaveBeenCalledWith(
      IPC.browserOverlayClosed,
      expect.anything(),
    );
  });

  it('keeps marked items open and leaves the same menu visible', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu({
      ...request,
      menuId: 'session.header.copy',
      items: [
        { kind: 'item' as const, id: 'copy-all', label: 'Copy all', icon: 'copy', keepOpen: true },
        { kind: 'item' as const, id: 'rename', label: 'Rename', icon: 'pencil' },
      ],
    });
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, {
      requestId: 1,
      width: 220,
      height: 80,
    });
    view.webContents.send.mockClear();
    host.webContents.send.mockClear();

    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'copy-all' });
    expect(view.visible).toBe(true);
    expect(view.webContents.send).not.toHaveBeenCalledWith(
      IPC.browserOverlayHide,
      expect.anything(),
    );
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayAction, {
      menuId: 'session.header.copy',
      itemId: 'copy-all',
      keepOpen: true,
    });
    expect(host.webContents.send).not.toHaveBeenCalledWith(
      IPC.browserOverlayClosed,
      expect.anything(),
    );
  });

  it('routes row actions, keeping marked ones open and closing the rest', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    openBrowserOverlayMenu({
      ...request,
      menuId: 'browser.downloads',
      items: [
        { kind: 'item' as const, id: 'row:a', label: 'a.zip', icon: 'file', keepOpen: true, actions: [
          { id: 'pause:a', label: 'Pause', icon: 'pause', keepOpen: true },
          { id: 'show:a', label: 'Show in folder', icon: 'folder' },
        ] },
        { kind: 'item' as const, id: 'row:b', label: 'b.zip', disabled: true, actions: [{ id: 'cancel:b', label: 'Cancel', icon: 'close', keepOpen: true }] },
      ],
    });
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 80 });
    view.webContents.send.mockClear();
    host.webContents.send.mockClear();

    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'pause:a' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayAction, { menuId: 'browser.downloads', itemId: 'pause:a', keepOpen: true });
    expect(view.webContents.send).not.toHaveBeenCalledWith(IPC.browserOverlayHide, expect.anything());

    host.webContents.send.mockClear();
    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'cancel:b' });
    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'missing:a' });
    expect(host.webContents.send).not.toHaveBeenCalled();

    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'show:a' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayAction, { menuId: 'browser.downloads', itemId: 'show:a' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayClosed, { menuId: 'browser.downloads', reason: 'action' });
  });

  it('confines permission dialogs to browser bounds and never focuses on presentation', () => {
    const host = createHost(1200, 800);
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    const boundary = { x: 600, y: 100, width: 600, height: 600 };
    openBrowserOverlayDialog({ dialogId: 'permission', title: 'Permission', confirmLabel: 'Once', cancelLabel: 'Block', closeLabel: 'Close', auxiliary: { label: 'Always' }, boundary, preserveFocus: true, dismissible: false });
    expect(view.bounds).toEqual(boundary);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 440, height: 240 });
    expect(view.bounds).toEqual(boundary);
    expect(view.webContents.focus).not.toHaveBeenCalled();
    dismissBrowserOverlay(view.webContents as never, { requestId: 1, reason: 'escape' });
    expect(view.visible).toBe(true);
    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'auxiliary' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayDialogAction, { dialogId: 'permission', action: 'auxiliary' });
  });

  it('leaves focus alone for page dialogs shown without focus and returns it once a clicked-in card closes', () => {
    const host = createHost(1200, 800);
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    const boundary = { x: 600, y: 100, width: 600, height: 600 };
    const dialog = { dialogId: 'confirm', title: 'Confirm', confirmLabel: 'OK', cancelLabel: 'Cancel', closeLabel: 'Close', boundary };
    host.focused = false;
    openBrowserOverlayDialog(dialog);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 440, height: 240 });
    expect(view.webContents.focus).not.toHaveBeenCalled();
    host.focused = true;
    openBrowserOverlayDialog({ ...dialog, dialogId: 'agent', preserveFocus: true });
    showBrowserOverlayRendered(view.webContents as never, { requestId: 2, width: 440, height: 240 });
    expect(view.webContents.focus).not.toHaveBeenCalled();
    view.webContents.focused = true;
    closeBrowserOverlayDialog('agent');
    markBrowserOverlayHidden(view.webContents as never, { requestId: 2 });
    expect(host.webContents.focus).toHaveBeenCalledOnce();
  });

  it('renders dialogs over the full content view, updates loading in place and routes actions', () => {
    const host = createHost(1200, 800);
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    const dialog = {
      dialogId: 'global-confirm',
      title: 'Clear browsing data',
      message: 'Cookies and cached browser data will be deleted.',
      confirmLabel: 'Clear',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
      variant: 'danger' as const,
    };

    openBrowserOverlayDialog(dialog);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
    expect(view.visible).toBe(true);
    expect(view.webContents.send).toHaveBeenCalledWith(
      IPC.browserOverlayConfig,
      expect.objectContaining({ kind: 'dialog', dialogId: 'global-confirm', requestId: 1 }),
    );
    showBrowserOverlayRendered(view.webContents as never, {
      requestId: 1,
      width: 440,
      height: 240,
    });
    expect(view.visible).toBe(true);
    expect(view.webContents.focus).toHaveBeenCalled();
    expect(view.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayShown, {
      requestId: 1,
    });

    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'cancel' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayDialogAction, {
      dialogId: 'global-confirm',
      action: 'cancel',
    });
    expect(view.visible).toBe(true);

    openBrowserOverlayDialog({ ...dialog, loading: true });
    expect(view.webContents.send).toHaveBeenLastCalledWith(
      IPC.browserOverlayConfig,
      expect.objectContaining({ requestId: 1, loading: true }),
    );
    host.webContents.send.mockClear();
    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'cancel' });
    expect(host.webContents.send).not.toHaveBeenCalled();
    activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'confirm' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayDialogAction, {
      dialogId: 'global-confirm',
      action: 'confirm',
    });

    host.emit('resize');
    expect(view.visible).toBe(true);
    closeBrowserOverlayDialog('global-confirm', 'action');
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayDialogClosed, {
      dialogId: 'global-confirm',
      reason: 'action',
    });
  });

  it('blocks user dismissals of a loading dialog but honors a programmatic close', () => {
    const host = createHost(1200, 800);
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    openBrowserOverlayDialog({
      dialogId: 'global-confirm',
      title: 'Delete session',
      confirmLabel: 'Delete',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
      variant: 'danger',
      loading: true,
    });
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 440, height: 240 });
    host.webContents.send.mockClear();

    closeBrowserOverlayDialog('global-confirm', 'dismiss');
    closeBrowserOverlayDialog('global-confirm', 'escape');
    expect(view.visible).toBe(true);
    expect(host.webContents.send).not.toHaveBeenCalled();

    closeBrowserOverlayDialog('global-confirm', 'programmatic');
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayDialogClosed, {
      dialogId: 'global-confirm',
      reason: 'programmatic',
    });
    markBrowserOverlayHidden(view.webContents as never, { requestId: 1 });
    expect(view.visible).toBe(false);
  });

  it('routes bounded annotation form values only to the matching dialog request', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    const form = {
      dialogId: 'annotation', title: 'Button: Save', confirmLabel: 'Add', cancelLabel: 'Cancel', closeLabel: 'Close', variant: 'primary' as const,
      input: { label: 'Comment', value: 'Original' },
      checkbox: { label: 'Include screenshot', checked: true },
    };
    expect(asBrowserOverlayDialogRequest({ ...form, preview: { src: 'https://example.test/tracker', alt: 'Image' } })).toBeNull();
    expect(asBrowserOverlayDialogRequest({ ...form, input: { label: 'Comment', value: 'x'.repeat(10_001) } })).toBeNull();
    expect(asBrowserOverlayDialogRequest({ ...form, checkbox: { label: 'Include screenshot', checked: 'false' } })).toBeNull();
    openBrowserOverlayDialog(form);
    host.webContents.send.mockClear();
    submitBrowserOverlayForm(view.webContents as never, { requestId: 999, action: 'confirm', value: 'Wrong request' });
    expect(host.webContents.send).not.toHaveBeenCalled();
    submitBrowserOverlayForm(view.webContents as never, { requestId: 1, action: 'confirm', value: 'New comment', checked: false });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayDialogAction, { dialogId: 'annotation', action: 'confirm', value: 'New comment', checked: false });
    openBrowserOverlayDialog({ ...form, input: { ...form.input, readOnly: true } });
    submitBrowserOverlayForm(view.webContents as never, { requestId: 1, action: 'confirm', value: 'Cannot edit', checked: false });
    expect(host.webContents.send).toHaveBeenLastCalledWith(IPC.browserOverlayDialogAction, { dialogId: 'annotation', action: 'confirm', value: 'Original', checked: true });
  });

  it('keeps annotation native bounds stable across animated content sizes', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    openBrowserOverlayDialog({ dialogId: 'annotation-growth', title: 'Annotation', confirmLabel: 'Add', cancelLabel: 'Cancel', closeLabel: 'Close', anchor: { x: 600, y: 100, width: 80, height: 30 }, annotation: { capture: { id: 'test-capture' } } as never });
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 416, height: 300 });
    const initialBounds = { ...view.bounds };
    const setBounds = vi.spyOn(view, 'setBounds');
    host.contentView.removeChildView.mockClear();
    host.contentView.addChildView.mockClear();
    view.webContents.focus.mockClear();
    for (const height of [320, 350, 500, 700, 550, 300]) showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 416, height });
    expect(host.contentView.removeChildView).not.toHaveBeenCalled();
    expect(host.contentView.addChildView).not.toHaveBeenCalled();
    expect(view.webContents.focus).not.toHaveBeenCalled();
    expect(view.bounds).toEqual(initialBounds);
    expect(setBounds).not.toHaveBeenCalled();
  });

  it('updates address completion selection without detaching its native view or changing focus', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    openBrowserOverlayMenu({ ...request, preserveFocus: true });
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 400, height: 160 });
    host.contentView.removeChildView.mockClear();
    host.contentView.addChildView.mockClear();
    view.webContents.focus.mockClear();
    openBrowserOverlayMenu({ ...request, preserveFocus: true, items: [{ kind: 'item', id: 'browser', label: 'Browser', selected: true }] });
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 400, height: 80 });
    expect(host.contentView.removeChildView).not.toHaveBeenCalled();
    expect(host.contentView.addChildView).not.toHaveBeenCalled();
    expect(view.webContents.focus).not.toHaveBeenCalled();
  });

  it('resizes address suggestions beyond 720px and can reopen them at the same width', () => {
    const host = createHost(1400, 900);
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    const initial = { ...request, menuId: 'address', preserveFocus: true, placement: 'bottom-start' as const, width: 600, anchor: { x: 400, y: 40, width: 600, height: 32 } };
    openBrowserOverlayMenu(initial);
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 600, height: 160 });
    const wider = asBrowserOverlayMenuRequest({ ...initial, width: 1000, anchor: { x: 100, y: 40, width: 1000, height: 32 } });
    expect(wider).not.toBeNull();
    openBrowserOverlayMenu(wider!);
    const measured = asBrowserOverlayRendered({ requestId: 1, width: 1000, height: 160 });
    expect(measured).not.toBeNull();
    showBrowserOverlayRendered(view.webContents as never, measured!);
    expect(view.bounds).toMatchObject({ x: 88, width: 1024 });
    closeBrowserOverlayMenu('address');
    markBrowserOverlayHidden(view.webContents as never, { requestId: 1 });
    openBrowserOverlayMenu(wider!);
    const reopened = asBrowserOverlayRendered({ requestId: 2, width: 1000, height: 160 });
    expect(reopened).not.toBeNull();
    showBrowserOverlayRendered(view.webContents as never, reopened!);
    expect(view.visible).toBe(true);
    expect(view.bounds).toMatchObject({ x: 88, width: 1024 });
  });

  it('keeps an anchored form within its own view and dismisses it on a page click', () => {
    const host = createHost();
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    openBrowserOverlayDialog({ dialogId: 'annotation-popover', title: 'Save', confirmLabel: 'Add', cancelLabel: 'Cancel', closeLabel: 'Close', input: { label: 'Comment', value: '' }, anchor: { x: 600, y: 100, width: 80, height: 30 } });
    showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 360, height: 400 });
    expect(view.bounds.x).toBeGreaterThan(0);
    expect(view.bounds.y).toBeGreaterThan(100);
    expect(view.bounds.width).toBeLessThan(500);
    expect(view.bounds.height).toBeLessThan(500);
    observeBrowserOverlayOutsidePointer(host.webContents as never);
    host.webContents.emit('before-mouse-event', {}, { type: 'mouseDown' });
    expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayDialogClosed, { dialogId: 'annotation-popover', reason: 'dismiss' });
  });

  it('uses the root content view bounds when Electron temporarily reports a zero content size', () => {
    const host = createHost(1200, 800, 0, 0);
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    openBrowserOverlayDialog({
      dialogId: 'global-confirm',
      title: 'Confirm',
      message: 'Continue?',
      confirmLabel: 'Continue',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
      variant: 'primary',
      loading: false,
    });

    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });

  it('falls back to the window bounds when Electron reports zero content bounds', () => {
    const host = createHost(1200, 800, 0, 0);
    host.contentView.getBounds.mockReturnValue({ x: 0, y: 0, width: 0, height: 0 });
    host.getContentBounds.mockReturnValue({ x: 0, y: 0, width: 0, height: 0 });
    attachBrowserOverlayWindow(host as never);
    const view = mocks.FakeWebContentsView.instances[0]!;
    markBrowserOverlayReady(view.webContents as never);
    openBrowserOverlayDialog({
      dialogId: 'global-confirm',
      title: 'Confirm',
      message: 'Continue?',
      confirmLabel: 'Continue',
      cancelLabel: 'Cancel',
      closeLabel: 'Close',
      variant: 'primary',
      loading: false,
    });

    expect(view.bounds).toEqual({ x: 0, y: 0, width: 1200, height: 800 });
  });
});

it('preserves permission descriptions and model controls while rejecting invalid action identities', () => {
  const items = [
    { kind: 'item', id: 'manual', label: 'Manual', description: 'Ask before making changes', selected: false, tone: 'warning' },
    { kind: 'section', id: 'provider', label: 'Provider' },
    { kind: 'choices', id: 'thinking', label: 'Thinking', value: 'effort-high', options: [{ id: 'effort-low', label: 'Low' }, { id: 'effort-high', label: 'High' }] },
    { kind: 'note', id: 'cache', label: 'Switching models can change cached context.', size: 'xs' },
  ];
  const parsed = asBrowserOverlayMenuRequest({ ...request, width: 520, items, footerStart: 2, submitOnCtrlEnter: true });
  expect(parsed).toMatchObject({ width: 520, items, footerStart: 2, submitOnCtrlEnter: true });
  expect(asBrowserOverlayMenuRequest({ ...request, width: 641, items })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items, footerStart: 5 })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items: [...items, { kind: 'item', id: 'effort-low', label: 'Duplicate' }] })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...items[0], description: 'x'.repeat(1025) }] })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items: [{ kind: 'note', id: 'note', label: 'Note', size: 'large' }] })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items, submitOnCtrlEnter: 'yes' })).toBeNull();
});

it('carries a bounded highlight query without per-item ranges', () => {
  const item = { kind: 'item' as const, id: 'history-0', label: 'University of Oregon', description: 'https://www.google.com/…/@40.9,-106.2' };
  const parsed = asBrowserOverlayMenuRequest({ ...request, items: [item], query: 'oregon louis' });
  expect(parsed).toMatchObject({ query: 'oregon louis', items: [item] });
  expect(isBrowserOverlayConfig({ ...parsed, kind: 'menu', requestId: 1 })).toBe(true);
  expect(asBrowserOverlayMenuRequest({ ...request, items: [item] })).not.toHaveProperty('query');
  expect(asBrowserOverlayMenuRequest({ ...request, items: [item], query: '' })).not.toHaveProperty('query');
  expect(asBrowserOverlayMenuRequest({ ...request, items: [item], query: 'x'.repeat(1024) })?.query).toHaveLength(1024);
  expect(asBrowserOverlayMenuRequest({ ...request, items: [item], query: 'x'.repeat(1025) })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items: [item], query: 1 })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...item, labelHighlights: [{ start: 14, end: 20 }] }] })?.items[0]).not.toHaveProperty('labelHighlights');
  expect(isBrowserOverlayConfig({ ...parsed, kind: 'menu', requestId: 1, query: 'x'.repeat(1025) })).toBe(false);
});

it('carries per-item label and description ranges', () => {
  const item = { kind: 'item' as const, id: 'history-0', label: 'University of Oregon', description: 'https://www.google.com/…', labelRanges: [{ start: 14, end: 20 }], descriptionRanges: [{ start: 0, end: 4 }] };
  expect(asBrowserOverlayMenuRequest({ ...request, items: [item] })).toMatchObject({ items: [item] });
  expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...item, labelRanges: [{ start: -1, end: 2 }] }] })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...item, labelRanges: Array.from({ length: 65 }, () => ({ start: 0, end: 1 })) }] })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...item, labelRanges: [{ start: 0, end: 1.5 }] }] })).toBeNull();
});

it('round-trips choices disabled and notice while enforcing action identity', () => {
  const choices = {
    kind: 'choices' as const,
    id: 'camera',
    label: 'Camera',
    value: 'camera.ask',
    disabled: true,
    options: [{ id: 'camera.ask', label: 'Ask' }, { id: 'camera.allow', label: 'Allow' }],
    notice: { message: 'System permission not granted', linkLabel: 'Open System Settings', action: 'camera.system-settings' },
  };
  const parsed = asBrowserOverlayMenuRequest({ ...request, items: [choices] });
  expect(parsed).toMatchObject({ items: [choices] });
  const enabled = asBrowserOverlayMenuRequest({ ...request, items: [{ ...choices, disabled: false }] });
  expect(enabled?.items[0]).not.toHaveProperty('disabled');
  expect(asBrowserOverlayMenuRequest({ ...request, items: [{ ...choices, notice: { ...choices.notice, action: 'camera.allow' } }] })).toBeNull();
  expect(asBrowserOverlayMenuRequest({ ...request, items: [choices, { kind: 'item', id: 'camera.system-settings', label: 'Duplicate' }] })).toBeNull();
});

it('keeps thinking controls open and constrains wide menus to the host viewport', () => {
  destroyBrowserOverlay();
  mocks.FakeWebContentsView.instances = [];
  const host = createHost(480, 400);
  attachBrowserOverlayWindow(host as never);
  const choices = { kind: 'choices' as const, id: 'thinking', label: 'Thinking', value: 'high', options: [{ id: 'low', label: 'Low' }, { id: 'high', label: 'High' }] };
  openBrowserOverlayMenu({ ...request, width: 520, anchor: { x: 200, y: 350, width: 40, height: 24 }, items: [choices] });
  const view = mocks.FakeWebContentsView.instances[0]!;
  markBrowserOverlayReady(view.webContents as never);
  expect(view.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayConfig, expect.objectContaining({ width: 456, maxHeight: 376 }));
  showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 456, height: 80 });
  host.webContents.send.mockClear();
  activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'low' });
  expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayAction, { menuId: request.menuId, itemId: 'low', keepOpen: true });
  expect(view.visible).toBe(true);
  host.webContents.send.mockClear();
  activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'not-an-option' });
  expect(host.webContents.send).not.toHaveBeenCalled();
  destroyBrowserOverlay();
});

it('keeps the menu open when a choices notice action fires', () => {
  destroyBrowserOverlay();
  mocks.FakeWebContentsView.instances = [];
  const host = createHost(480, 400);
  attachBrowserOverlayWindow(host as never);
  const choices = {
    kind: 'choices' as const,
    id: 'camera',
    label: 'Camera',
    value: 'camera.ask',
    disabled: true,
    options: [{ id: 'camera.ask', label: 'Ask' }],
    notice: { message: 'System permission not granted', linkLabel: 'Open System Settings', action: 'camera.system-settings' },
  };
  openBrowserOverlayMenu({ ...request, anchor: { x: 200, y: 350, width: 40, height: 24 }, items: [choices] });
  const view = mocks.FakeWebContentsView.instances[0]!;
  markBrowserOverlayReady(view.webContents as never);
  showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 80 });
  host.webContents.send.mockClear();
  activateBrowserOverlayItem(view.webContents as never, { requestId: 1, itemId: 'camera.system-settings' });
  expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayAction, { menuId: request.menuId, itemId: 'camera.system-settings', keepOpen: true });
  expect(view.visible).toBe(true);
  destroyBrowserOverlay();
});


it('measures content-sized menus against the window without moving an open menu to the measuring origin', () => {
  destroyBrowserOverlay();
  mocks.FakeWebContentsView.instances = [];
  const host = createHost(700, 600);
  attachBrowserOverlayWindow(host as never);
  const menu = { ...request, width: 220, autoWidth: true };
  expect(asBrowserOverlayMenuRequest(menu)?.autoWidth).toBe(true);
  expect(asBrowserOverlayMenuRequest({ ...menu, autoWidth: 'yes' })).toBeNull();
  openBrowserOverlayMenu(menu);
  const view = mocks.FakeWebContentsView.instances[0]!;
  markBrowserOverlayReady(view.webContents as never);
  expect(view.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayConfig, expect.objectContaining({ width: 676, minWidth: 220, autoWidth: true }));
  showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 300, height: 120 });
  const visibleBounds = { ...view.bounds };
  openBrowserOverlayMenu(menu);
  expect(view.bounds).toEqual(visibleBounds);
  destroyBrowserOverlay();
});

it('retains the complete shadow gutter when a menu fills the available width', () => {
  const bounds = browserOverlayBounds({ contentWidth: 700, contentHeight: 600, config: { ...request, kind: 'menu', requestId: 1, anchor: { x: 0, y: 500, width: 20, height: 20 } }, cardWidth: 676, cardHeight: 120 });
  expect(bounds.x).toBe(0);
  expect(bounds.width).toBe(700);
  expect(bounds.height).toBe(144);
});

it('closes orphaned overlays before a host renderer reload removes its DOM dismissal handlers', () => {
  destroyBrowserOverlay();
  mocks.FakeWebContentsView.instances = [];
  const host = createHost();
  attachBrowserOverlayWindow(host as never);
  openBrowserOverlayMenu(request);
  const view = mocks.FakeWebContentsView.instances[0]!;
  markBrowserOverlayReady(view.webContents as never);
  showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 120 });
  host.webContents.emit('did-start-navigation', { isMainFrame: false, isSameDocument: false });
  host.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: true });
  expect(view.visible).toBe(true);
  host.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
  expect(view.visible).toBe(false);
  expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayClosed, { menuId: request.menuId, reason: 'host-closed' });
  destroyBrowserOverlay();
});

it('clamps non-flipping popovers inside the available browser height', () => {
  const config = { anchor: { x: 40, y: 350, width: 100, height: 30 }, placement: 'bottom-start' as const };
  const small = browserOverlayBounds({ contentWidth: 460, contentHeight: 600, config, cardWidth: 416, cardHeight: 200, allowFlip: false });
  const large = browserOverlayBounds({ contentWidth: 460, contentHeight: 600, config, cardWidth: 416, cardHeight: 576, allowFlip: false });
  expect(large.y).toBeLessThan(small.y);
  expect(large.y).toBeGreaterThanOrEqual(0);
  expect(large.y + large.height).toBeLessThanOrEqual(600);
  expect(large.x + large.width).toBeLessThanOrEqual(460);
});

it.each([0, -1, NaN, Infinity, 16385])('rejects invalid measured overlay width %s', width => {
  expect(asBrowserOverlayRendered({ requestId: 1, width, height: 160 })).toBeNull();
});

it('retains valid suggestion favicons and rejects non-image URL schemes', () => {
  const withIcon = (favicon: string) => asBrowserOverlayMenuRequest({ ...request, items: [{ kind: 'item', id: 'history', label: 'Example', favicon }] });
  expect(withIcon('https://example.com/favicon.ico')?.items[0]).toMatchObject({ favicon: 'https://example.com/favicon.ico' });
  expect(withIcon('data:image/png;base64,aGVsbG8=')?.items[0]).toMatchObject({ favicon: 'data:image/png;base64,aGVsbG8=' });
  expect(withIcon('javascript:alert(1)')).toBeNull();
  expect(withIcon('file:///private/favicon.png')).toBeNull();
});

it('keeps keepOpen only when an item explicitly requests it', () => {
  expect(asBrowserOverlayMenuRequest({
    ...request,
    items: [{ kind: 'item', id: 'copy-all', label: 'Copy all', keepOpen: true }],
  })?.items[0]).toMatchObject({ keepOpen: true });
  expect(asBrowserOverlayMenuRequest({
    ...request,
    items: [{ kind: 'item', id: 'rename', label: 'Rename', keepOpen: false }],
  })?.items[0]).not.toHaveProperty('keepOpen');
});

it('recreates a crashed native overlay on the next open', () => {
  const host = createHost();
  attachBrowserOverlayWindow(host as never);
  const previous = mocks.FakeWebContentsView.instances.at(-1)!;
  previous.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  openBrowserOverlayMenu(request);
  expect(previous.webContents.destroyed).toBe(true);
  expect(mocks.FakeWebContentsView.instances.at(-1)).not.toBe(previous);
  destroyBrowserOverlay();
});


it('uses only packaged overlay assets even if a renderer development URL is configured', () => {
  destroyBrowserOverlay();
  mocks.packaged = true;
  mocks.devBase.mockReturnValue('http://127.0.0.1:9999/');
  try {
    attachBrowserOverlayWindow(createHost() as never);
    expect(mocks.FakeWebContentsView.instances.at(-1)!.webContents.loadURL).toHaveBeenCalledWith('app://renderer/browser-overlay.html');
  } finally {
    destroyBrowserOverlay();
    mocks.packaged = false;
    mocks.devBase.mockReturnValue(undefined);
  }
});


it.each(['render-process-gone', 'destroyed'])('clears a failed overlay on %s and recreates it on the next open', event => {
  destroyBrowserOverlay();
  const host = createHost();
  attachBrowserOverlayWindow(host as never);
  const first = mocks.FakeWebContentsView.instances.at(-1)!;
  markBrowserOverlayReady(first.webContents as never);
  openBrowserOverlayMenu(request);
  first.webContents.emit(event);
  expect(host.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayClosed, { menuId: request.menuId, reason: 'replaced' });
  expect(host.contentView.children).not.toContain(first);
  expect(isBrowserOverlaySender(first.webContents as never)).toBe(false);
  openBrowserOverlayMenu({ ...request, menuId: 'next-opening' });
  const next = mocks.FakeWebContentsView.instances.at(-1)!;
  expect(next).not.toBe(first);
  markBrowserOverlayReady(next.webContents as never);
  expect(next.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayConfig, expect.objectContaining({ menuId: 'next-opening' }));
  first.webContents.emit(event);
  expect(isBrowserOverlaySender(next.webContents as never)).toBe(true);
  destroyBrowserOverlay();
});

it.each([0.8, 1.25, 1.5])('scales menu geometry with host zoom %s', zoom => {
  const host = createHost();
  host.webContents.getZoomFactor.mockReturnValue(zoom);
  attachBrowserOverlayWindow(host as never);
  const view = mocks.FakeWebContentsView.instances.at(-1)!;
  const config = { menuId: 'zoom', anchor: { x: 400, y: 200, width: 40, height: 20 }, width: 220, items: [], requestId: 1, kind: 'menu' } satisfies BrowserOverlayMenuConfig;
  openBrowserOverlayMenu(config);
  markBrowserOverlayReady(view.webContents as never);
  expect(view.webContents.setZoomFactor).toHaveBeenCalledWith(zoom);
  showBrowserOverlayRendered(view.webContents as never, { requestId: 1, width: 220, height: 100 });
  const css = browserOverlayBounds({ contentWidth: 1200 / zoom, contentHeight: 800 / zoom, config, cardWidth: 220, cardHeight: 100 });
  expect(view.bounds).toEqual({ x: Math.floor(css.x * zoom), y: Math.floor(css.y * zoom), width: Math.ceil((css.x + css.width) * zoom) - Math.floor(css.x * zoom), height: Math.ceil((css.y + css.height) * zoom) - Math.floor(css.y * zoom) });
  expect(view.bounds.x + 12 * zoom).toBeCloseTo(220 * zoom, 0);
  openBrowserOverlayMenu({ ...config, menuId: 'zoom-edge', anchor: { x: 1200 / zoom - 40, y: 800 / zoom - 40, width: 20, height: 20 } });
  showBrowserOverlayRendered(view.webContents as never, { requestId: 2, width: 220, height: 100 });
  expect(view.webContents.send).toHaveBeenCalledWith(IPC.browserOverlayShown, { requestId: 2, placement: 'top-end' });
  expect(view.bounds.x + view.bounds.width).toBeLessThanOrEqual(1200);
  expect(view.bounds.y + view.bounds.height).toBeLessThanOrEqual(800);
 });
