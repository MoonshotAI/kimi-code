// @vitest-environment jsdom
import { createApp, h, nextTick, type App } from 'vue';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type {
  BrowserOverlayActivateRequest,
  BrowserOverlayConfig,
  BrowserOverlayDismissRequest,
  BrowserOverlayRendered,
  BrowserOverlayShown,
} from '../../src/shared/browser-overlay';
import BrowserOverlayMenu from '../../src/renderer/components/browser-overlay/BrowserOverlayMenu.vue';

let app: App | null = null;
const listeners = new Map<string, (payload: never) => void>();
const rendered = vi.fn<(payload: BrowserOverlayRendered) => void>();
const activate = vi.fn<(payload: BrowserOverlayActivateRequest) => void>();
const dismiss = vi.fn<(payload: BrowserOverlayDismissRequest) => void>();

function domRect(x: number, y: number, width: number, height: number): DOMRect {
  return { x, y, width, height, top: y, left: x, right: x + width, bottom: y + height, toJSON: () => ({}) } as DOMRect;
}

async function flush(): Promise<void> {
  await nextTick();
  await nextTick();
  await nextTick();
  await nextTick();
}

function key(target: Element | Document, keyName: string): void {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true }));
}

function parentMenu(): HTMLElement {
  return document.querySelector<HTMLElement>('.browser-overlay-menu:not(.browser-overlay-submenu)')!;
}

function submenu(): HTMLElement | null {
  return document.querySelector<HTMLElement>('.browser-overlay-submenu');
}

function itemByText(container: HTMLElement, label: string): HTMLElement {
  const found = [...container.querySelectorAll<HTMLElement>('.ui-menu-item')].find(el => el.textContent?.trim() === label);
  if (!found) throw new Error(`missing item ${label}`);
  return found;
}

beforeEach(() => {
  rendered.mockReset();
  activate.mockReset();
  dismiss.mockReset();
  listeners.clear();
  document.body.innerHTML = '';
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    if (this.classList.contains('browser-overlay-submenu')) return domRect(0, 0, 120, 112);
    if (this.classList.contains('browser-overlay-menu')) return domRect(12, 12, 160, 140);
    if (this.dataset['submenuAnchor'] !== undefined) return domRect(16, 44, 152, 28);
    return domRect(0, 0, 10, 10);
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getBoundingClientRect().width;
  });
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (this: HTMLElement) {
    return this.getBoundingClientRect().height;
  });
  window.requestAnimationFrame = (cb: FrameRequestCallback) => {
    cb(0);
    return 1;
  };
  (window as unknown as { kimiBrowserOverlay: unknown }).kimiBrowserOverlay = {
    ready: vi.fn(),
    rendered,
    hidden: vi.fn(),
    activate,
    submitForm: vi.fn(),
    dismiss,
    onConfig: (cb: (config: BrowserOverlayConfig) => void) => { listeners.set('config', cb); return () => {}; },
    onShown: (cb: (payload: BrowserOverlayShown) => void) => { listeners.set('shown', cb); return () => {}; },
    onHide: () => () => {},
  };
  vi.stubGlobal('ResizeObserver', class {
    observe(): void {}
    disconnect(): void {}
  });
  app = createApp({ render: () => h(BrowserOverlayMenu) });
  const host = document.createElement('div');
  document.body.appendChild(host);
  app.mount(host);
  (listeners.get('config') as ((config: BrowserOverlayConfig) => void) | undefined)?.({
    kind: 'menu',
    requestId: 1,
    menuId: 'table-selection',
    anchor: { x: 500, y: 200, width: 0, height: 0 },
    placement: 'bottom-start',
    offset: 0,
    autoWidth: true,
    viewportWidth: 700,
    viewportHeight: 600,
    items: [
      { kind: 'item', id: 'copy', label: 'Copy', icon: 'copy' },
      {
        kind: 'item',
        id: 'copy-as',
        label: 'Copy as',
        icon: 'copy',
        keepOpen: true,
        submenu: [{ id: 'copy-as-tsv', label: 'TSV' }, { id: 'copy-as-markdown', label: 'Markdown' }],
      },
      { kind: 'item', id: 'select-all', label: 'Select entire table', icon: 'grid-dots' },
    ],
  });
  (listeners.get('shown') as ((payload: BrowserOverlayShown) => void) | undefined)?.({ requestId: 1, placement: 'bottom-start', x: 500, y: 200 });
});

afterEach(() => {
  app?.unmount();
  app = null;
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('opens the nested menu on hover, aligns it with the anchor row, moves DOM focus, and closes it on sibling hover', async () => {
  await flush();
  const copyButton = itemByText(parentMenu(), 'Copy');
  copyButton.focus();
  expect(document.activeElement).toBe(copyButton);
  const anchor = parentMenu().querySelector<HTMLElement>('[data-submenu-anchor="copy-as"]')!;
  expect(anchor.querySelector('[aria-haspopup="menu"]')).not.toBeNull();
  anchor.dispatchEvent(new MouseEvent('mouseenter'));
  await flush();
  expect(document.activeElement?.textContent?.trim()).toBe('Copy as');
  expect(submenu()).not.toBeNull();
  expect(submenu()!.textContent).toContain('TSV');
  expect(submenu()!.textContent).toContain('Markdown');
  expect(rendered).toHaveBeenLastCalledWith({
    requestId: 1,
    width: 280,
    height: 144,
    anchorWidth: 160,
    anchorHeight: 140,
    offsetX: 120,
    offsetY: 0,
    placement: 'left',
  });

  itemByText(submenu()!, 'Markdown').click();
  expect(activate).toHaveBeenCalledWith({ requestId: 1, itemId: 'copy-as-markdown' });

  const selectAll = itemByText(parentMenu(), 'Select entire table').parentElement!;
  selectAll.dispatchEvent(new MouseEvent('mouseenter'));
  await flush();
  expect(submenu()).toBeNull();
  expect(document.activeElement?.textContent?.trim()).toBe('Select entire table');
});

it('does not move DOM focus on hover when the menu preserves host focus', async () => {
  await flush();
  (listeners.get('config') as (config: BrowserOverlayConfig) => void)({
    kind: 'menu',
    requestId: 2,
    menuId: 'address-bar',
    anchor: { x: 100, y: 40, width: 400, height: 32 },
    preserveFocus: true,
    items: [{ kind: 'item', id: 'one', label: 'First suggestion' }, { kind: 'item', id: 'two', label: 'Second suggestion' }],
  });
  await flush();
  expect(document.hasFocus()).toBe(false);
  const second = itemByText(parentMenu(), 'Second suggestion').parentElement!;
  second.dispatchEvent(new MouseEvent('mouseenter'));
  await flush();
  expect(document.activeElement).toBe(document.body);
});

it('supports ArrowRight, ArrowLeft and stepped Escape between submenu and parent menu', async () => {
  await flush();
  itemByText(parentMenu(), 'Copy').focus();
  key(parentMenu(), 'ArrowDown');
  expect(document.activeElement?.textContent?.trim()).toBe('Copy as');
  key(document.activeElement!, 'ArrowRight');
  await flush();
  expect(submenu()).not.toBeNull();
  expect(document.activeElement?.textContent?.trim()).toBe('TSV');

  key(document.activeElement!, 'ArrowLeft');
  await flush();
  expect(submenu()).toBeNull();
  expect(document.activeElement?.textContent?.trim()).toBe('Copy as');

  key(document.activeElement!, 'ArrowRight');
  await flush();
  expect(document.activeElement?.textContent?.trim()).toBe('TSV');
  key(document.activeElement!, 'Escape');
  await flush();
  expect(dismiss).not.toHaveBeenCalled();
  expect(submenu()).toBeNull();
  expect(document.activeElement?.textContent?.trim()).toBe('Copy as');

  key(document.activeElement!, 'Escape');
  expect(dismiss).toHaveBeenCalledWith({ requestId: 1, reason: 'escape' });
});
