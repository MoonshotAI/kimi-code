// @vitest-environment jsdom
import { createApp, h, type App } from 'vue';
import { afterEach, expect, it, vi } from 'vitest';
import { MenuItem } from '@moonshot-ai/app-ui';

let app: App | undefined;
let host: HTMLDivElement;

function mount(render: () => ReturnType<typeof h>): HTMLDivElement {
  host = document.createElement('div');
  document.body.append(host);
  app = createApp({ render });
  app.mount(host);
  return host;
}

afterEach(() => {
  app?.unmount();
  app = undefined;
  host.remove();
});

it('renders a plain menu item button without an action slot', () => {
  const root = mount(() => h(MenuItem, { class: 'extra', 'aria-checked': 'true' }, () => 'Plain'));
  const item = root.firstElementChild as HTMLButtonElement;
  expect(item.tagName).toBe('BUTTON');
  expect(item.className).toBe('ui-menu-item ui-menu-item--md extra');
  expect(item.getAttribute('role')).toBe('menuitem');
  expect(item.getAttribute('aria-checked')).toBe('true');
  expect(root.querySelector('.ui-menu-item-row, .ui-menu-item__action')).toBeNull();
});

it('renders a trailing action beside the item without nesting buttons', () => {
  const onClick = vi.fn();
  const onAction = vi.fn();
  const root = mount(() => h(MenuItem, { active: true, onClick }, {
    default: () => 'Preset',
    action: () => h('button', { class: 'trailing', onClick: onAction }, 'Delete'),
  }));
  const row = root.firstElementChild as HTMLElement;
  expect(row.className).toBe('ui-menu-item-row is-active');
  expect(row.getAttribute('role')).toBe('none');
  const item = row.querySelector<HTMLButtonElement>(':scope > .ui-menu-item')!;
  expect(item.textContent).toBe('Preset');
  expect(item.getAttribute('role')).toBe('menuitem');
  expect(row.querySelectorAll('button button')).toHaveLength(0);
  row.querySelector<HTMLButtonElement>('.ui-menu-item__action .trailing')!.click();
  expect(onAction).toHaveBeenCalledTimes(1);
  expect(onClick).not.toHaveBeenCalled();
  item.click();
  expect(onClick).toHaveBeenCalledTimes(1);
});
