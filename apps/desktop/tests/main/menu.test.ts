import { describe, it, expect } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

import { menuTemplate } from '../../src/main/menu';

function submenuItems(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return (item.submenu ?? []) as MenuItemConstructorOptions[];
}

describe('menuTemplate', () => {
  it('macOS File menu carries the Close item (macOS convention; role default accelerator Cmd+W)', () => {
    const template = menuTemplate(true, 'zh');
    const fileMenu = template.find((item) => item.label === '文件');
    expect(fileMenu).toBeDefined();
    const closeItem = submenuItems(fileMenu as MenuItemConstructorOptions).find(
      (item) => item.role === 'close',
    );
    // Role default accelerator is CmdOrCtrl+W; the label override keeps it bilingual.
    expect(closeItem).toMatchObject({ role: 'close', label: '关闭窗口' });
  });

  it('keeps Close out of the macOS Window menu (two Cmd+W items would conflict)', () => {
    const template = menuTemplate(true, 'zh');
    const windowMenu = template.find((item) => item.label === '窗口');
    expect(windowMenu).toBeDefined();
    const closeItem = submenuItems(windowMenu as MenuItemConstructorOptions).find(
      (item) => item.role === 'close',
    );
    expect(closeItem).toBeUndefined();
  });

  it('localizes the File menu into English', () => {
    const template = menuTemplate(true, 'en');
    const fileMenu = template.find((item) => item.label === 'File');
    expect(fileMenu).toBeDefined();
    const items = submenuItems(fileMenu as MenuItemConstructorOptions);
    expect(items.find((item) => item.role === 'close')).toMatchObject({ label: 'Close Window' });
    expect(items.find((item) => item.id === 'new-window')).toMatchObject({
      label: 'New Window',
      accelerator: 'Shift+CmdOrCtrl+N',
    });
    expect(items.find((item) => item.id === 'new-chat')).toMatchObject({
      label: 'New Chat',
      accelerator: 'CmdOrCtrl+N',
    });
    expect(items.find((item) => item.id === 'open-folder')).toMatchObject({
      label: 'Open Folder…',
      accelerator: 'CmdOrCtrl+O',
    });
  });

  it('wires New Chat (an unwired accelerator would shadow the renderer Cmd/Ctrl+N keydown)', () => {
    const items = submenuItems(
      menuTemplate(true, 'zh').find((item) => item.label === '文件') as MenuItemConstructorOptions,
    );
    expect(typeof items.find((entry) => entry.id === 'new-chat')?.click).toBe('function');
  });

  it('keeps New Window / Open Folder display-only (no click handlers wired yet)', () => {
    const items = submenuItems(
      menuTemplate(true, 'zh').find((item) => item.label === '文件') as MenuItemConstructorOptions,
    );
    for (const id of ['new-window', 'open-folder']) {
      const item = items.find((entry) => entry.id === id);
      expect(item).toBeDefined();
      expect(item?.click).toBeUndefined();
    }
  });

  it('labels the about/quit roles bilingually (role defaults would show the package name)', () => {
    const zhItems = submenuItems(menuTemplate(true, 'zh')[0] as MenuItemConstructorOptions);
    expect(zhItems.find((item) => item.role === 'about')).toMatchObject({ label: '关于 Kimi Code' });
    expect(zhItems.find((item) => item.role === 'quit')).toMatchObject({ label: '退出 Kimi Code' });

    const enItems = submenuItems(menuTemplate(true, 'en')[0] as MenuItemConstructorOptions);
    expect(enItems.find((item) => item.role === 'about')).toMatchObject({ label: 'About Kimi Code' });
    expect(enItems.find((item) => item.role === 'quit')).toMatchObject({ label: 'Quit Kimi Code' });
  });

  it('keeps the windowMenu role on other platforms (its expansion already ends with Close)', () => {
    const template = menuTemplate(false, 'zh');
    expect(template.some((item) => item.role === 'windowMenu')).toBe(true);
  });

  it('mirrors the pet visibility flag into the View-menu checkbox on macOS', () => {
    const viewMenu = menuTemplate(true, 'en', true).find((item) => item.label === 'View');
    const petItem = submenuItems(viewMenu as MenuItemConstructorOptions).find(
      (item) => item.label === 'Kimi Pet',
    );
    expect(petItem).toMatchObject({ type: 'checkbox', checked: true });

    const unchecked = menuTemplate(true, 'en', false).find((item) => item.label === 'View');
    const petItemOff = submenuItems(unchecked as MenuItemConstructorOptions).find(
      (item) => item.label === 'Kimi Pet',
    );
    expect(petItemOff).toMatchObject({ type: 'checkbox', checked: false });
  });

  it('omits the pet checkbox on other platforms', () => {
    const viewMenu = menuTemplate(false, 'en', true).find((item) => item.label === 'View');
    const petItem = submenuItems(viewMenu as MenuItemConstructorOptions).find(
      (item) => item.label === 'Kimi Pet',
    );
    expect(petItem).toBeUndefined();
  });

  it('app menu carries Settings (Cmd+,) and Check for Updates, bilingually', () => {
    const zhAppMenu = menuTemplate(true, 'zh')[0] as MenuItemConstructorOptions;
    const zhItems = submenuItems(zhAppMenu);
    expect(zhItems.find((item) => item.id === 'open-settings')).toMatchObject({
      label: '设置…',
      accelerator: 'CmdOrCtrl+,',
    });
    expect(zhItems.find((item) => item.id === 'check-for-updates')).toMatchObject({
      label: '检查更新…',
    });

    const enItems = submenuItems(menuTemplate(true, 'en')[0] as MenuItemConstructorOptions);
    expect(enItems.find((item) => item.id === 'open-settings')).toMatchObject({
      label: 'Settings…',
    });
    expect(enItems.find((item) => item.id === 'check-for-updates')).toMatchObject({
      label: 'Check for Updates…',
    });
  });

  it('keeps Settings / Check for Updates on non-mac platforms too', () => {
    const items = submenuItems(menuTemplate(false, 'zh')[0] as MenuItemConstructorOptions);
    expect(items.some((item) => item.id === 'open-settings')).toBe(true);
    expect(items.some((item) => item.id === 'check-for-updates')).toBe(true);
  });

  it('Help menu carries working Documentation / Console links, bilingually', () => {
    const zhTemplate = menuTemplate(true, 'zh');
    const helpMenu = zhTemplate[zhTemplate.length - 1] as MenuItemConstructorOptions;
    expect(helpMenu.label).toBe('帮助');
    const zhItems = submenuItems(helpMenu);
    const docs = zhItems.find((item) => item.id === 'help-docs');
    const consoleItem = zhItems.find((item) => item.id === 'help-console');
    expect(docs?.label).toBe('文档');
    expect(consoleItem?.label).toBe('控制台');
    // Unlike the display-only File items, these are wired (openExternal).
    expect(typeof docs?.click).toBe('function');
    expect(typeof consoleItem?.click).toBe('function');

    const enTemplate = menuTemplate(true, 'en');
    const enHelp = enTemplate[enTemplate.length - 1] as MenuItemConstructorOptions;
    expect(enHelp.label).toBe('Help');
    const enItems = submenuItems(enHelp);
    expect(enItems.find((item) => item.id === 'help-docs')?.label).toBe('Documentation');
    expect(enItems.find((item) => item.id === 'help-console')?.label).toBe('Console');
  });
});
