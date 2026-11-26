// @vitest-environment jsdom
import { createApp, h, ref, type App } from 'vue';
import { afterEach, assert, beforeEach, expect, it, vi } from 'vitest';

const lib = vi.hoisted(() => ({
  copy: vi.fn<(text: string) => Promise<boolean>>(),
  warning: vi.fn(),
}));

vi.mock('@moonshot-ai/app-core/lib', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  copyTextToClipboard: (text: string) => lib.copy(text),
}));
vi.mock('@moonshot-ai/app-client/stores', () => ({
  useWarningsStore: () => ({ pushWarning: lib.warning }),
}));
vi.mock('@moonshot-ai/app-markdown', async () => await import('../../app-markdown/src/lib/tableSelection'));

import { createKimiI18n } from '@moonshot-ai/app-i18n';
import type { NativeMenuItem } from '@moonshot-ai/app-core/native-menu';
import { destroyTableSelections, ensureTableSelection } from '../../app-markdown/src/lib/tableSelection';
import TableSelectionContextMenu from '../src/chat/TableSelectionContextMenu.vue';
import { NativeMenuHostKey, type NativeMenuAnchor, type NativeMenuShowOptions } from '../src/composer/nativeMenus';

let app: App | null = null;
let vm: { $refs: { menu: { show: (wrapper: HTMLElement, x: number, y: number, keyboard?: boolean) => Promise<void> } } } | null = null;
let wrapper: HTMLElement;
let table: HTMLTableElement;
const quote = vi.fn<(markdown: string) => void>();

function pointer(target: Element, type: string, options: MouseEventInit = {}): void {
  target.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...options }));
}

function cells(): HTMLTableCellElement[][] {
  return [...table.querySelectorAll<HTMLTableRowElement>('thead > tr, tbody > tr')].map(row =>
    [...row.querySelectorAll<HTMLTableCellElement>(':scope > [data-md-table-cell]')],
  );
}

function selectedCount(): number {
  return wrapper.querySelectorAll('.md-table-cell-selected').length;
}

function menuEl(): HTMLElement | null {
  return document.body.querySelector('.table-selection-context-menu');
}

function submenuEl(): HTMLElement | null {
  return document.body.querySelector('.table-selection-copy-submenu');
}

function menuItem(container: HTMLElement, label: string): HTMLElement {
  const item = [...container.querySelectorAll<HTMLElement>('*')].find(el => (el.textContent ?? '').trim() === label);
  if (!item) throw new Error(`menu item not found: ${label}`);
  return item;
}

function activate(element: HTMLElement): void {
  element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
  element.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }));
  element.dispatchEvent(new MouseEvent('pointerup', { bubbles: true, button: 0 }));
  element.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }));
  element.click();
}

async function flush(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0));
  await new Promise(resolve => setTimeout(resolve, 0));
}

async function openMenu(): Promise<void> {
  await vm!.$refs.menu.show(wrapper, 120, 160);
  await flush();
}

beforeEach(() => {
  lib.copy.mockReset().mockResolvedValue(true);
  lib.warning.mockReset();
  quote.mockReset();
  document.body.innerHTML = '';
  wrapper = document.createElement('div');
  wrapper.className = 'table-node-wrapper';
  wrapper.innerHTML = '<table><thead><tr><th>Name</th><th>Department</th><th>Note</th></tr></thead><tbody><tr><td>Alice</td><td>Product</td><td>a,b</td></tr><tr><td>Bob</td><td>R&amp;D</td><td>x|y</td></tr><tr><td>Carol</td><td>Design</td><td>plain</td></tr></tbody></table>';
  document.body.appendChild(wrapper);
  table = wrapper.querySelector('table')!;
  ensureTableSelection(wrapper, { selectColumn: 'Select column' });
  const grid = cells();
  pointer(grid[1]![0]!, 'pointerdown', { clientX: 10, clientY: 10 });
  pointer(grid[2]![1]!, 'pointermove', { clientX: 80, clientY: 50 });
  pointer(grid[2]![1]!, 'pointerup', { clientX: 80, clientY: 50 });
  assert.equal(selectedCount(), 4);
  app = createApp({ render: () => h(TableSelectionContextMenu, { ref: 'menu', onQuote: quote }) });
  app.use(createKimiI18n({ locale: 'en' }));
  vm = app.mount(document.createElement('div')) as unknown as NonNullable<typeof vm>;
});

afterEach(() => {
  app?.unmount();
  app = null;
  vm = null;
  destroyTableSelections(wrapper);
  document.body.innerHTML = '';
  vi.restoreAllMocks();
  window.innerWidth = 1024;
  window.innerHeight = 768;
});

it('copies TSV by default, closes the menu and preserves the selection', async () => {
  await openMenu();
  menuItem(menuEl()!, 'Copy').click();
  await flush();
  expect(lib.copy).toHaveBeenCalledWith('Alice\tProduct\nBob\tR&D');
  expect(selectedCount()).toBe(4);
  expect(menuEl()).toBeNull();
});

it('copies Markdown, CSV and JSON from the nested format submenu', async () => {
  const expected = [
    ['Markdown', '| Name | Department |\n| --- | --- |\n| Alice | Product |\n| Bob | R&amp;D |'],
    ['CSV', 'Alice,Product\nBob,R&D'],
    ['JSON', JSON.stringify([{ Name: 'Alice', Department: 'Product' }, { Name: 'Bob', Department: 'R&D' }], null, 2)],
  ] as const;
  for (const [label, text] of expected) {
    lib.copy.mockClear();
    await openMenu();
    menuItem(menuEl()!, 'Copy as').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    await flush();
    expect(submenuEl()).not.toBeNull();
    activate(menuItem(submenuEl()!, label));
    await flush();
    expect(lib.copy).toHaveBeenCalledWith(text);
    expect(selectedCount()).toBe(4);
    expect(menuEl()).toBeNull();
  }
});

it('selects the entire table from the menu', async () => {
  await openMenu();
  menuItem(menuEl()!, 'Select entire table').click();
  await flush();
  expect(selectedCount()).toBe(12);
  expect(menuEl()).toBeNull();
  expect(document.activeElement).toBe(wrapper);
});

it('quotes the selection as Markdown through the existing quote action', async () => {
  const editor = document.createElement('input');
  document.body.appendChild(editor);
  quote.mockImplementation(() => editor.focus());
  await openMenu();
  menuItem(menuEl()!, 'Add to chat').click();
  await flush();
  expect(quote).toHaveBeenCalledWith('| Name | Department |\n| --- | --- |\n| Alice | Product |\n| Bob | R&amp;D |');
  expect(selectedCount()).toBe(4);
  expect(menuEl()).toBeNull();
  expect(document.activeElement).toBe(editor);
});

it('supports pointer and keyboard open, keyboard navigation, and closes the submenu before the parent', async () => {
  await openMenu();
  const parent = menuEl()!;
  expect(parent.contains(document.activeElement)).toBe(false);
  parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement?.textContent?.trim()).toBe('Copy');
  parent.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  expect(document.activeElement?.textContent?.trim()).toBe('Copy as');
  expect(selectedCount()).toBe(4);
  menuItem(parent, 'Copy as').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await flush();
  expect(submenuEl()).not.toBeNull();
  expect(document.activeElement?.textContent?.trim()).toBe('TSV');
  submenuEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  expect(submenuEl()).toBeNull();
  expect(menuEl()).not.toBeNull();
  menuEl()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await flush();
  expect(menuEl()).toBeNull();
  expect(document.activeElement).toBe(wrapper);

  await vm!.$refs.menu.show(wrapper, 120, 160, true);
  await flush();
  expect(document.activeElement?.textContent?.trim()).toBe('Copy');
});

it('keeps the format submenu within the viewport', async () => {
  window.innerWidth = 400;
  window.innerHeight = 300;
  await openMenu();
  menuItem(menuEl()!, 'Copy as').dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
  await flush();
  const submenu = submenuEl()!;
  const left = Number.parseFloat(submenu.style.left);
  const top = Number.parseFloat(submenu.style.top);
  expect(left).toBeGreaterThanOrEqual(8);
  expect(left + submenu.offsetWidth).toBeLessThanOrEqual(392);
  expect(top).toBeGreaterThanOrEqual(8);
  expect(top + submenu.offsetHeight).toBeLessThanOrEqual(292);
});

it('reports clipboard failures through the existing warnings store', async () => {
  lib.copy.mockResolvedValue(false);
  await openMenu();
  menuItem(menuEl()!, 'Copy').click();
  await flush();
  expect(lib.warning).toHaveBeenCalledOnce();
});

it('hides quote action when selection actions are unavailable but keeps copy and select all', async () => {
  app?.unmount();
  app = createApp({ render: () => h(TableSelectionContextMenu, { ref: 'menu', allowQuote: false, onQuote: quote }) });
  app.use(createKimiI18n({ locale: 'en' }));
  vm = app.mount(document.createElement('div')) as unknown as NonNullable<typeof vm>;
  await openMenu();
  expect([...menuEl()!.querySelectorAll<HTMLElement>('.ui-menu-item')].map(el => el.textContent?.trim())).toEqual(['Copy', 'Copy as', 'Select entire table']);
  expect(quote).not.toHaveBeenCalled();
  menuItem(menuEl()!, 'Select entire table').click();
  await flush();
  expect(selectedCount()).toBe(12);
  await openMenu();
  menuItem(menuEl()!, 'Copy').click();
  await flush();
  expect(lib.copy).toHaveBeenCalledWith('Name\tDepartment\tNote\nAlice\tProduct\ta,b\nBob\tR&D\tx|y\nCarol\tDesign\tplain');
});

interface NativeRegistration {
  id: string;
  width?: number;
  autoWidth?: boolean;
  placement?: string;
  items(): NativeMenuItem[];
  onSelect(id: string): void;
  onClose?(payload: { menuId: string; reason: string }): void;
}

function mountWithNativeHost(allowQuote = true) {
  app?.unmount();
  let registration: NativeRegistration | undefined;
  const showAt = vi.fn<(anchor: NativeMenuAnchor, options?: NativeMenuShowOptions & { focusReturn?: HTMLElement }) => void>();
  const close = vi.fn();
  app = createApp({ render: () => h(TableSelectionContextMenu, { ref: 'menu', allowQuote, onQuote: quote }) });
  app.use(createKimiI18n({ locale: 'en' }));
  app.provide(NativeMenuHostKey, {
    register(options) {
      registration = options;
      return { available: true, open: ref(false), showAt, toggle: vi.fn(), close, refresh: vi.fn() };
    },
  });
  vm = app.mount(document.createElement('div')) as unknown as NonNullable<typeof vm>;
  return { registration: () => registration!, showAt, close };
}

it('opens the native overlay menu with content width, pointer/keyboard focus, and nested copy formats', async () => {
  const { registration, showAt } = mountWithNativeHost();
  await openMenu();
  expect(menuEl()).toBeNull();
  expect(registration().autoWidth).toBe(true);
  expect(registration().width).toBeUndefined();
  expect(showAt).toHaveBeenLastCalledWith(
    { x: 120, y: 160, width: 0, height: 0 },
    { placement: 'bottom-start', offset: 0, initialFocus: 'none', focusReturn: wrapper },
  );
  await vm!.$refs.menu.show(wrapper, 120, 160, true);
  expect(showAt).toHaveBeenLastCalledWith(
    { x: 120, y: 160, width: 0, height: 0 },
    { placement: 'bottom-start', offset: 0, initialFocus: 'first-item', focusReturn: wrapper },
  );
  expect(registration().items()).toEqual([
    { kind: 'item', id: 'copy', label: 'Copy', icon: 'copy' },
    {
      kind: 'item',
      id: 'copy-as',
      label: 'Copy as',
      icon: 'copy',
      keepOpen: true,
      submenu: [
        { id: 'copy-as-tsv', label: 'TSV' },
        { id: 'copy-as-markdown', label: 'Markdown' },
        { id: 'copy-as-csv', label: 'CSV' },
        { id: 'copy-as-json', label: 'JSON' },
      ],
    },
    { kind: 'item', id: 'select-all', label: 'Select entire table', icon: 'grid-dots' },
    { kind: 'item', id: 'add-to-chat', label: 'Add to chat', icon: 'plus' },
  ]);

  const { registration: withoutQuote } = mountWithNativeHost(false);
  expect(withoutQuote().items().map(item => item.kind === 'separator' ? 'separator' : item.id)).toEqual(['copy', 'copy-as', 'select-all']);
});

it('routes native format and quote actions without stealing editor focus', async () => {
  const { registration, close } = mountWithNativeHost();
  await openMenu();
  registration().onSelect('copy-as-csv');
  await flush();
  expect(lib.copy).toHaveBeenCalledWith('Alice,Product\nBob,R&D');
  expect(close).toHaveBeenCalled();
  expect(selectedCount()).toBe(4);

  const editor = document.createElement('input');
  document.body.appendChild(editor);
  quote.mockImplementation(() => editor.focus());
  await openMenu();
  registration().onSelect('add-to-chat');
  await flush();
  expect(quote).toHaveBeenCalledWith('| Name | Department |\n| --- | --- |\n| Alice | Product |\n| Bob | R&amp;D |');
  expect(document.activeElement).toBe(editor);
});
