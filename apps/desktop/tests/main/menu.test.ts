import { describe, it, expect } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

import { menuTemplate } from '../../src/main/menu';

function submenuItems(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return (item.submenu ?? []) as MenuItemConstructorOptions[];
}

describe('menuTemplate', () => {
  it('macOS Window menu carries an explicit Close item (the windowMenu role has none, so Cmd+W needs it)', () => {
    const template = menuTemplate(true, 'zh');
    const windowMenu = template.find((item) => item.label === '窗口');
    expect(windowMenu).toBeDefined();
    const closeItem = submenuItems(windowMenu as MenuItemConstructorOptions).find(
      (item) => item.role === 'close',
    );
    // Role default accelerator is CmdOrCtrl+W; the label override keeps it bilingual.
    expect(closeItem).toMatchObject({ role: 'close', label: '关闭窗口' });
  });

  it('localizes the Window menu into English', () => {
    const template = menuTemplate(true, 'en');
    const windowMenu = template.find((item) => item.label === 'Window');
    expect(windowMenu).toBeDefined();
    const closeItem = submenuItems(windowMenu as MenuItemConstructorOptions).find(
      (item) => item.role === 'close',
    );
    expect(closeItem).toMatchObject({ role: 'close', label: 'Close Window' });
  });

  it('keeps the windowMenu role on other platforms (its expansion already ends with Close)', () => {
    const template = menuTemplate(false, 'zh');
    expect(template.some((item) => item.role === 'windowMenu')).toBe(true);
  });
});
