import { openMenuCount } from '@moonshot-ai/app-ui';
import type { BrowserOverlayAction, BrowserOverlayClosed, BrowserOverlayMenuRequest } from '../../src/shared/browser-overlay';
import { effectScope } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { registerBrowserOverlayMenu } from '../../src/renderer/lib/browserOverlayMenu';

afterEach(() => vi.unstubAllGlobals());

it.each([false, true])('requires an explicit host capability (%s)', supported => {
  const scope = effectScope();
  const open = vi.fn();
  vi.stubGlobal('window', { kimiDesktop: {
    browserOverlaySupported: supported,
    browserOverlayOpenMenu: open, browserOverlayCloseMenu: vi.fn(),
    onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
  } });
  try {
    const menu = scope.run(() => registerBrowserOverlayMenu({
      id: 'test-capability', items: () => [{ kind: 'item', id: 'close', label: 'Close' }], onSelect: vi.fn(),
    }))!;
    expect(menu.available).toBe(supported);
    if (!supported) {
      menu.showAt({ x: 0, y: 0, width: 0, height: 0 });
      expect(menu.open.value).toBe(false);
      expect(open).not.toHaveBeenCalled();
    }
  } finally { scope.stop(); }
});


it('ignores callbacks from a replaced opening and keeps the new outside-dismiss handler', () => {
  const scope = effectScope();
  const open = vi.fn<(request: BrowserOverlayMenuRequest) => void>();
  const close = vi.fn();
  const select = vi.fn();
  let onAction!: (payload: BrowserOverlayAction) => void;
  let onClosed!: (payload: BrowserOverlayClosed) => void;
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', Object.assign(new EventTarget(), { kimiDesktop: {
    browserOverlaySupported: true, browserOverlayOpenMenu: open, browserOverlayCloseMenu: close,
    onBrowserOverlayAction: (callback: typeof onAction) => { onAction = callback; return () => {}; },
    onBrowserOverlayClosed: (callback: typeof onClosed) => { onClosed = callback; return () => {}; },
  } }));
  const baseline = openMenuCount.value;
  try {
    const menu = scope.run(() => registerBrowserOverlayMenu({ id: 'replacement-test', items: () => [{ kind: 'item', id: 'close', label: 'Close' }], onSelect: select }))!;
    menu.showAt({ x: 0, y: 0, width: 0, height: 0 });
    const first = open.mock.calls[0]![0].menuId;
    menu.showAt({ x: 100, y: 0, width: 0, height: 0 });
    const second = open.mock.calls[1]![0].menuId;
    expect(second).not.toBe(first);
    onClosed({ menuId: first, reason: 'replaced' });
    onAction({ menuId: first, itemId: 'close' });
    expect(select).not.toHaveBeenCalled();
    expect(menu.open.value).toBe(true);
    expect(openMenuCount.value).toBe(baseline + 1);
    document.dispatchEvent(new Event('mousedown'));
    expect(close).toHaveBeenCalledWith(second);
    onClosed({ menuId: second, reason: 'action' });
    onAction({ menuId: second, itemId: 'close' });
    onAction({ menuId: second, itemId: 'close' });
    expect(select).toHaveBeenCalledExactlyOnceWith('close');
    expect(menu.open.value).toBe(false);
    expect(openMenuCount.value).toBe(baseline);
  } finally { scope.stop(); }
});

it('keeps the menu open when outside content scrolls', () => {
  const scope = effectScope();
  const close = vi.fn();
  vi.stubGlobal('document', new EventTarget());
  vi.stubGlobal('window', Object.assign(new EventTarget(), { kimiDesktop: {
    browserOverlaySupported: true, browserOverlayOpenMenu: vi.fn(), browserOverlayCloseMenu: close,
    onBrowserOverlayAction: () => () => {}, onBrowserOverlayClosed: () => () => {},
  } }));
  const baseline = openMenuCount.value;
  try {
    const menu = scope.run(() => registerBrowserOverlayMenu({
      id: 'outside-scroll-test', items: () => [{ kind: 'item', id: 'model', label: 'Model' }], onSelect: vi.fn(),
    }))!;
    menu.showAt({ x: 0, y: 0, width: 20, height: 20 });
    window.dispatchEvent(new Event('scroll'));
    expect(close).not.toHaveBeenCalled();
    expect(menu.open.value).toBe(true);
    expect(openMenuCount.value).toBe(baseline + 1);
  } finally { scope.stop(); }
});
