import type { BrowserOverlayClosed } from '../../src/shared/browser-overlay';
import { effectScope } from 'vue';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const openMenu = vi.fn();
const closeMenu = vi.fn();
const releaseSurface = vi.fn();
const addDocumentListener = vi.fn();
let actionListener:
  | ((payload: { menuId: string; itemId: string; keepOpen?: boolean }) => void)
  | undefined;
let closedListener: ((payload: BrowserOverlayClosed) => void) | undefined;

vi.mock('@moonshot-ai/app-ui', async () => {
  const { ref } = await import('vue');
  return {
    openDialogCount: ref(0),
    registerExternalMenuSurface: vi.fn(() => releaseSurface),
  };
});

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  actionListener = undefined;
  closedListener = undefined;
  vi.stubGlobal('document', {
    hasFocus: () => true,
    addEventListener: addDocumentListener,
    removeEventListener: vi.fn(),
  });
  vi.stubGlobal('window', {
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    requestAnimationFrame: (cb: FrameRequestCallback) => {
      cb(0);
      return 1;
    },
    kimiDesktop: {
      browserOverlaySupported: true,
      browserOverlayOpenMenu: openMenu,
      browserOverlayCloseMenu: closeMenu,
      onBrowserOverlayAction: (cb: typeof actionListener) => {
        actionListener = cb;
        return vi.fn();
      },
      onBrowserOverlayClosed: (cb: typeof closedListener) => {
        closedListener = cb;
        return vi.fn();
      },
    },
  });
});

describe('browser overlay menu renderer adapter', () => {
  it('opens at an explicit pointer anchor and routes the selected action', async () => {
    const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
    const onSelect = vi.fn();
    const onClose = vi.fn();
    const focus = vi.fn();
    const focusReturn = { focus, isConnected: true } as unknown as HTMLElement;
    const scope = effectScope();
    const menu = scope.run(() =>
      registerBrowserOverlayMenu({
        id: 'panel-tabs.browser-context',
        width: 220,
        items: () => [{ kind: 'item', id: 'reload', label: 'Reload' }],
        onSelect, onClose,
      }),
    )!;

    menu.showAt(
      { x: 320, y: 48, width: 0, height: 0 },
      { placement: 'bottom-start', offset: 0, focusReturn },
    );
    expect(openMenu).toHaveBeenCalledWith({
      menuId: expect.any(String),
      anchor: { x: 320, y: 48, width: 0, height: 0 },
      placement: 'bottom-start',
      offset: 0,
      width: 220,
      initialFocus: 'none',
      items: [{ kind: 'item', id: 'reload', label: 'Reload' }],
    });

    actionListener?.({ menuId: openMenu.mock.lastCall?.[0].menuId ?? closeMenu.mock.lastCall?.[0], itemId: 'reload' });
    expect(onSelect).toHaveBeenCalledWith('reload');
    closedListener?.({ menuId: openMenu.mock.lastCall![0].menuId, reason: 'action' });
    expect(onClose).toHaveBeenCalledWith(expect.objectContaining({ reason: 'action' }));
    expect(releaseSurface).toHaveBeenCalledOnce();

    menu.showAt(
      { x: 320, y: 48, width: 0, height: 0 },
      { focusReturn },
    );
    closedListener?.({ menuId: openMenu.mock.lastCall?.[0].menuId ?? closeMenu.mock.lastCall?.[0], reason: 'escape' });
    await vi.waitFor(() => expect(focus).toHaveBeenCalledOnce());
    scope.stop();
  });

  it('calls onDismiss only when the menu is dismissed outside', async () => {
    const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
    const onDismiss = vi.fn();
    const scope = effectScope();
    const menu = scope.run(() =>
      registerBrowserOverlayMenu({
        id: 'panel-tabs.dismiss-test',
        items: () => [{ kind: 'item', id: 'one', label: 'One' }],
        onSelect: vi.fn(),
        onDismiss,
        submitOnCtrlEnter: true,
      }),
    )!;

    for (const reason of ['escape', 'action', 'programmatic'] as const) {
      menu.showAt({ x: 100, y: 40, width: 20, height: 20 });
      closedListener?.({ menuId: openMenu.mock.lastCall![0].menuId, reason });
    }
    expect(onDismiss).not.toHaveBeenCalled();

    menu.showAt({ x: 100, y: 40, width: 20, height: 20 });
    closedListener?.({ menuId: openMenu.mock.lastCall![0].menuId, reason: 'dismiss' });
    expect(onDismiss).toHaveBeenCalledOnce();
    expect(openMenu).toHaveBeenLastCalledWith(expect.objectContaining({ submitOnCtrlEnter: true }));
    scope.stop();
  });

  it('keeps composite actions open and refreshes their declarative value', async () => {
    const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
    let value = '100%';
    const onSelect = vi.fn(() => {
      value = '110%';
    });
    const scope = effectScope();
    const menu = scope.run(() =>
      registerBrowserOverlayMenu({
        id: 'browser.toolbar.browser-1',
        items: () => [
          {
            kind: 'zoom',
            id: 'zoom',
            label: 'Zoom',
            icon: 'zoom-scan',
            value,
            decreaseAction: 'zoom-out',
            decreaseLabel: 'Zoom out',
            increaseAction: 'zoom-in',
            increaseLabel: 'Zoom in',
            resetAction: 'zoom-reset',
            resetLabel: 'Reset zoom',
          },
        ],
        onSelect,
      }),
    )!;

    menu.showAt({ x: 100, y: 40, width: 20, height: 20 });
    actionListener?.({
      menuId: openMenu.mock.lastCall?.[0].menuId ?? closeMenu.mock.lastCall?.[0],
      itemId: 'zoom-in',
      keepOpen: true,
    });
    expect(menu.open.value).toBe(true);
    expect(releaseSurface).not.toHaveBeenCalled();
    expect(onSelect).toHaveBeenCalledWith('zoom-in');

    menu.refresh();
    expect(openMenu).toHaveBeenCalledTimes(2);
    expect(openMenu).toHaveBeenLastCalledWith(
      expect.objectContaining({
        items: [
          expect.objectContaining({ kind: 'zoom', icon: 'zoom-scan', value: '110%' }),
        ],
      }),
    );
    scope.stop();
  });
});


it('keeps the menu open through trigger mousedown so the following click closes rather than reopens it', async () => {
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const scope = effectScope();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'toggle-test', items: () => [{ kind: 'item', id: 'one', label: 'One' }], onSelect: vi.fn() }))!;
  const trigger = { contains: (target: unknown) => target === trigger, getBoundingClientRect: () => ({ x: 10, y: 20, width: 24, height: 24 }) } as unknown as HTMLElement;
  menu.toggle(trigger);
  menu.refresh();
  openMenu.mockClear();
  const down = addDocumentListener.mock.calls.find(([name]) => name === 'mousedown')![1] as EventListener;
  down({ target: trigger } as unknown as Event);
  expect(menu.open.value).toBe(true);
  menu.toggle(trigger);
  expect(closeMenu).toHaveBeenCalledOnce();
  closedListener?.({ menuId: openMenu.mock.lastCall?.[0].menuId ?? closeMenu.mock.lastCall?.[0], reason: 'dismiss' });
  expect(menu.open.value).toBe(false);
  expect(openMenu).not.toHaveBeenCalled();
  menu.toggle(trigger);
  expect(openMenu).toHaveBeenCalledOnce();
  down({ target: {} } as unknown as Event);
  expect(closeMenu).toHaveBeenCalledTimes(2);
  closedListener?.({ menuId: openMenu.mock.lastCall?.[0].menuId ?? closeMenu.mock.lastCall?.[0], reason: 'dismiss' });
  menu.showAt({ x: 10, y: 20, width: 0, height: 0 }, { focusReturn: trigger });
  down({ target: trigger } as unknown as Event);
  expect(closeMenu).toHaveBeenCalledTimes(3);
  scope.stop();
});

it.each(['close', 'mousedown', 'blur', 'dispose', 'escape'] as const)('discards delayed menu data after %s', async (reason) => {
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const scope = effectScope();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: `pending-${reason}`, items: () => [], onSelect: vi.fn() }))!;
  let resolve!: (value: string) => void;
  const loaded = menu.request(() => new Promise<string>((done) => { resolve = done; }));
  if (reason === 'close') menu.close();
  else if (reason === 'dispose') menu.dispose();
  else if (reason === 'escape') (addDocumentListener.mock.calls.find(([name]) => name === 'keydown')![1] as (event: { key: string }) => void)({ key: 'Escape' });
  else if (reason === 'mousedown') (addDocumentListener.mock.calls.find(([name]) => name === reason)![1] as () => void)();
  else (vi.mocked(window.addEventListener).mock.calls.find(([name]) => name === reason)![1] as () => void)();
  resolve('history');
  expect(await loaded).toBeUndefined();
  expect(openMenu).not.toHaveBeenCalled();
  scope.stop();
});

it('accepts only the latest requested menu data', async () => {
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const scope = effectScope();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'latest-request', items: () => [], onSelect: vi.fn() }))!;
  let resolve!: (value: string) => void;
  const old = menu.request(() => new Promise<string>((done) => { resolve = done; }));
  expect(await menu.request(async () => 'current')).toBe('current');
  resolve('old');
  expect(await old).toBeUndefined();
  scope.stop();
});

it('discards pending menu data when keyboard focus moves to another control', async () => {
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const scope = effectScope();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'focus-request', items: () => [], onSelect: vi.fn() }))!;
  let resolve!: (value: string) => void;
  const loaded = menu.request(() => new Promise<string>((done) => { resolve = done; }));
  Object.defineProperty(document, 'activeElement', { value: {}, configurable: true });
  (addDocumentListener.mock.calls.find(([name]) => name === 'focusin')![1] as () => void)();
  resolve('site');
  expect(await loaded).toBeUndefined();
  scope.stop();
});

it('does not return menu focus over an intervening composer focus change', async () => {
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  let frame!: FrameRequestCallback;
  window.requestAnimationFrame = (callback) => { frame = callback; return 1; };
  const scope = effectScope();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'focus-return', items: () => [], onSelect: vi.fn() }))!;
  const trigger = { isConnected: true, focus: vi.fn() };
  menu.showAt({ x: 0, y: 0, width: 20, height: 20 }, { focusReturn: trigger as unknown as HTMLElement });
  closedListener?.({ menuId: openMenu.mock.lastCall?.[0].menuId ?? closeMenu.mock.lastCall?.[0], reason: 'escape' });
  Object.defineProperty(document, 'activeElement', { value: {}, configurable: true });
  frame(0);
  await Promise.resolve();
  expect(trigger.focus).not.toHaveBeenCalled();
  scope.stop();
});

it('ignores old close acknowledgements and actions after reopening a menu', async () => {
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const scope = effectScope();
  const onSelect = vi.fn();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'generation-test', items: () => [{ kind: 'item', id: 'one', label: 'One' }], onSelect }))!;
  menu.showAt({ x: 1, y: 1, width: 100, height: 20 });
  const oldId = openMenu.mock.lastCall![0].menuId;
  menu.close();
  menu.showAt({ x: 1, y: 1, width: 120, height: 20 });
  const newId = openMenu.mock.lastCall![0].menuId;
  closedListener?.({ menuId: oldId, reason: 'dismiss' });
  actionListener?.({ menuId: oldId, itemId: 'one' });
  expect(menu.open.value).toBe(true);
  expect(onSelect).not.toHaveBeenCalled();
  expect(releaseSurface).not.toHaveBeenCalled();
  menu.refresh();
  expect(openMenu.mock.lastCall![0].menuId).toBe(newId);
  menu.close();
  expect(closeMenu).toHaveBeenLastCalledWith(newId);
  closedListener?.({ menuId: newId, reason: 'dismiss' });
  expect(menu.open.value).toBe(false);
  scope.stop();
});

it('marks refreshes of the open menu so a late one cannot reopen it after the main process closed it', async () => {
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const scope = effectScope();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'refresh-marker', items: () => [{ kind: 'item', id: 'one', label: 'One' }], onSelect: vi.fn() }))!;
  menu.showAt({ x: 0, y: 0, width: 20, height: 20 });
  const opened = openMenu.mock.lastCall![0];
  expect(opened).not.toHaveProperty('refresh');
  menu.refresh();
  expect(openMenu.mock.lastCall![0]).toMatchObject({ menuId: opened.menuId, refresh: true });
  closedListener?.({ menuId: opened.menuId, reason: 'escape' });
  menu.refresh();
  expect(openMenu).toHaveBeenCalledTimes(2);
  menu.showAt({ x: 0, y: 0, width: 20, height: 20 });
  const reopened = openMenu.mock.lastCall![0];
  expect(reopened.menuId).not.toBe(opened.menuId);
  expect(reopened).not.toHaveProperty('refresh');
  scope.stop();
});

it('does not reopen a closing menu when an asynchronous action refreshes it', async () => {
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const scope = effectScope();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'closing-refresh', items: () => [], onSelect() {} }))!;
  menu.showAt({ x: 0, y: 0, width: 20, height: 20 });
  menu.close();
  menu.refresh();
  expect(openMenu).toHaveBeenCalledOnce();
  scope.stop();
});

it('closes an open menu when an app dialog opens', async () => {
  const { openDialogCount } = await import('@moonshot-ai/app-ui');
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const onClose = vi.fn();
  const scope = effectScope();
  const idle = scope.run(() => registerBrowserOverlayMenu({ id: 'dialog-dismiss-idle', items: () => [], onSelect() {} }))!;
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'dialog-dismiss', items: () => [], onSelect() {}, onClose }))!;
  menu.showAt({ x: 0, y: 0, width: 20, height: 20 });
  const menuId = openMenu.mock.calls[0]![0].menuId as string;

  openDialogCount.value += 1;
  expect(closeMenu.mock.calls.filter(([id]) => id === menuId)).toHaveLength(1);
  expect(menu.closing.value).toBe(true);
  expect(idle.open.value).toBe(false);
  closedListener?.({ menuId, reason: 'dismiss' });
  expect(menu.open.value).toBe(false);
  expect(onClose).toHaveBeenCalledWith({ menuId, reason: 'dismiss' });

  openDialogCount.value -= 1;
  menu.showAt({ x: 0, y: 0, width: 20, height: 20 });
  expect(menu.open.value).toBe(true);
  expect(menu.closing.value).toBe(false);
  scope.stop();
});

it('discards pending menu data when an app dialog opens', async () => {
  const { openDialogCount } = await import('@moonshot-ai/app-ui');
  const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
  const scope = effectScope();
  const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'dialog-dismiss-pending', items: () => [], onSelect() {} }))!;
  let resolve!: (value: string) => void;
  const pending = menu.request(() => new Promise<string>((done) => { resolve = done; }));
  openDialogCount.value += 1;
  resolve('data');
  await expect(pending).resolves.toBeUndefined();
  openDialogCount.value -= 1;
  scope.stop();
});


it('registers a menu when native randomUUID is unavailable', async () => {
  vi.stubGlobal('crypto', { getRandomValues: (bytes: Uint8Array) => bytes.fill(1) });
  try {
    const { registerBrowserOverlayMenu } = await import('../../src/renderer/lib/browserOverlayMenu');
    const scope = effectScope();
    const menu = scope.run(() => registerBrowserOverlayMenu({
      id: 'insecure-context',
      items: () => [{ kind: 'item', id: 'one', label: 'One' }],
      onSelect: vi.fn(),
    }))!;
    menu.showAt({ x: 0, y: 0, width: 20, height: 20 });
    expect(openMenu).toHaveBeenCalledWith(expect.objectContaining({
      menuId: '01010101-0101-4101-8101-010101010101',
    }));
    expect(menu.open.value).toBe(true);
    scope.stop();
  } finally {
    vi.unstubAllGlobals();
  }
});
