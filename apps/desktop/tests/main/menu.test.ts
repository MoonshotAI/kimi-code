import { describe, it, expect, vi, afterEach } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

import { bindingToAccelerator, menuTemplate } from '../../src/main/menu';
import {
  isReservedBinding,
  parseBinding,
  serializeBinding,
} from '../../src/renderer/lib/keymap';

function submenuItems(item: MenuItemConstructorOptions): MenuItemConstructorOptions[] {
  return (item.submenu ?? []) as MenuItemConstructorOptions[];
}

function appMenuItems(template: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  const appMenu = template.find((item) => item.label === 'Kimi Code');
  expect(appMenu).toBeDefined();
  return submenuItems(appMenu as MenuItemConstructorOptions);
}

function walkItems(items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] {
  return items.flatMap((item) => [
    item,
    ...(Array.isArray(item.submenu) ? walkItems(item.submenu as MenuItemConstructorOptions[]) : []),
  ]);
}

// ---------------------------------------------------------------------------
// Native-accelerator completeness.
//
// Every accelerator our menu installs — custom items and Electron role
// defaults alike — must be RESERVED in keymap.ts, so a custom shortcut can
// never silently lose to the native menu. The role defaults below mirror
// Electron v43's menu-item-roles.ts (platform conditionals included,
// verified against the tagged source). A menu edit or an Electron upgrade
// that changes any of them turns this test red instead of shipping a dead
// binding.
// ---------------------------------------------------------------------------

const ELECTRON_ROLE_ACCELERATORS: Record<string, { apple?: string; other?: string }> = {
  // editmenu children
  undo: { apple: 'CommandOrControl+Z', other: 'CommandOrControl+Z' },
  redo: { apple: 'Shift+CommandOrControl+Z', other: 'Control+Y' },
  cut: { apple: 'CommandOrControl+X', other: 'CommandOrControl+X' },
  copy: { apple: 'CommandOrControl+C', other: 'CommandOrControl+C' },
  paste: { apple: 'CommandOrControl+V', other: 'CommandOrControl+V' },
  pasteAndMatchStyle: { apple: 'Cmd+Option+Shift+V', other: 'Shift+CommandOrControl+V' },
  selectAll: { apple: 'CommandOrControl+A', other: 'CommandOrControl+A' },
  // viewmenu / windowmenu children and direct roles
  reload: { apple: 'CmdOrCtrl+R', other: 'CmdOrCtrl+R' },
  forceReload: { apple: 'Shift+CmdOrCtrl+R', other: 'Shift+CmdOrCtrl+R' },
  toggleDevTools: { apple: 'Alt+Command+I', other: 'Ctrl+Shift+I' },
  resetZoom: { apple: 'CommandOrControl+0', other: 'CommandOrControl+0' },
  zoomIn: { apple: 'CommandOrControl+Plus', other: 'CommandOrControl+Plus' },
  zoomOut: { apple: 'CommandOrControl+-', other: 'CommandOrControl+-' },
  togglefullscreen: { apple: 'Control+Command+F', other: 'F11' },
  minimize: { apple: 'CommandOrControl+M', other: 'CommandOrControl+M' },
  close: { apple: 'CommandOrControl+W', other: 'CommandOrControl+W' },
  quit: { apple: 'CommandOrControl+Q' }, // Windows: no accelerator; our non-mac app menu uses `close`
  // Installed roles without an accelerator (nothing to reserve; listed so the
  // completeness check knows them instead of failing).
  about: {},
  zoom: {},
  front: {},
};

/** Electron accelerator string → our canonical keymap binding. */
function canonicalFromAccelerator(accelerator: string): string {
  const mods = { mod: false, ctrl: false, alt: false, shift: false };
  let key = '';
  for (const token of accelerator.split('+')) {
    const t = token.toLowerCase();
    if (t === 'commandorcontrol' || t === 'cmdorctrl' || t === 'command' || t === 'cmd' || t === 'super' || t === 'meta') mods.mod = true;
    else if (t === 'control' || t === 'ctrl') mods.ctrl = true;
    else if (t === 'alt' || t === 'option') mods.alt = true;
    else if (t === 'shift') mods.shift = true;
    else if (t === 'plus') key = 'plus';
    else key = t;
  }
  return serializeBinding({ ...mods, key });
}

/** Roles our menu installs, with menu-role submenus expanded per platform. */
function installedRoles(isMac: boolean): string[] {
  const roles = new Set<string>();
  for (const item of walkItems(menuTemplate(isMac, 'en'))) {
    if (typeof item.role === 'string') roles.add(item.role);
  }
  // editmenu children (Electron's editmenu submenu; mac adds pasteAndMatchStyle)
  if (roles.delete('editMenu')) {
    for (const r of ['undo', 'redo', 'cut', 'copy', 'paste', 'selectAll']) roles.add(r);
    if (isMac) roles.add('pasteAndMatchStyle');
  }
  // windowmenu children (non-mac expansion: minimize / zoom / close)
  if (roles.delete('windowMenu')) {
    for (const r of ['minimize', 'zoom', 'close']) roles.add(r);
  }
  return [...roles];
}

function stubPlatform(platform: string): void {
  vi.stubGlobal('navigator', { platform });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('native accelerator completeness', () => {
  it('every role the menu installs is in the Electron role table (update both on menu/Electron changes)', () => {
    for (const isMac of [true, false]) {
      for (const role of installedRoles(isMac)) {
        expect(
          ELECTRON_ROLE_ACCELERATORS[role],
          `role '${role}' (isMac=${isMac}) is installed but missing from the role table`,
        ).toBeDefined();
      }
    }
  });

  it('every installed accelerator is reserved, on both platforms', () => {
    for (const [isMac, platform, bucket] of [
      [true, 'MacIntel', 'apple'],
      [false, 'Win32', 'other'],
    ] as const) {
      stubPlatform(platform);
      for (const role of installedRoles(isMac)) {
        const accelerator = ELECTRON_ROLE_ACCELERATORS[role]?.[bucket];
        if (accelerator === undefined) continue; // no accelerator on this platform
        const canonical = canonicalFromAccelerator(accelerator);
        expect(parseBinding(canonical), `${role}: ${canonical}`).not.toBeNull();
        expect(
          isReservedBinding(canonical),
          `role '${role}' accelerator '${accelerator}' (${bucket}) is not reserved`,
        ).toBe(true);
      }
    }
  });
});

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
    expect(items.some((item) => item.id === 'new-window')).toBe(false);
    expect(items.find((item) => item.id === 'new-chat')).toMatchObject({
      label: 'New Chat',
      accelerator: 'CommandOrControl+N',
    });
    expect(items.find((item) => item.id === 'open-folder')).toMatchObject({
      label: 'Open Folder…',
      accelerator: 'CommandOrControl+O',
    });
  });

  it('wires New Chat / Open Folder (an unwired accelerator would shadow the renderer keydown)', () => {
    const items = submenuItems(
      menuTemplate(true, 'zh').find((item) => item.label === '文件') as MenuItemConstructorOptions,
    );
    for (const id of ['new-chat', 'open-folder']) {
      expect(typeof items.find((entry) => entry.id === id)?.click).toBe('function');
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

  it('app menu carries Settings (⌘,) and Check for Updates, bilingually', () => {
    const zhAppMenu = menuTemplate(true, 'zh')[0] as MenuItemConstructorOptions;
    const zhItems = submenuItems(zhAppMenu);
    expect(zhItems.find((item) => item.id === 'open-settings')).toMatchObject({
      label: '设置…',
      accelerator: 'CommandOrControl+,',
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

  it('menu accelerators follow the pushed renderer bindings; null hides them', () => {
    const template = menuTemplate(true, 'en', false, {
      openSettings: 'shift+mod+p',
      newSession: 'alt+mod+n',
      openFolder: null,
    });
    expect(appMenuItems(template).find((item) => item.id === 'open-settings')).toMatchObject({
      accelerator: 'Shift+CommandOrControl+P',
    });
    const fileItems = submenuItems(template.find((item) => item.label === 'File') as MenuItemConstructorOptions);
    expect(fileItems.find((item) => item.id === 'new-chat')).toMatchObject({
      accelerator: 'Alt+CommandOrControl+N',
    });
    expect(fileItems.find((item) => item.id === 'open-folder')?.accelerator).toBeUndefined();
  });

  it('strips every accelerator except editMenu while suspended (shortcut recording)', () => {
    // A DISABLED item's accelerator can still fire on macOS, so the suspended
    // template removes key equivalents outright: no accelerator, no role
    // (editMenu keeps both so copy/paste stays functional).
    const template = menuTemplate(true, 'en', false, {}, true);
    const walk = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.flatMap((item) => [
        item,
        ...(Array.isArray(item.submenu) ? walk(item.submenu as MenuItemConstructorOptions[]) : []),
      ]);
    for (const item of walk(template)) {
      if (item.role === 'editMenu') continue;
      expect(item.role, item.label).toBeUndefined();
      expect(item.accelerator, item.label).toBeUndefined();
    }
    // …and the default (unsuspended) template keeps roles and accelerators.
    const normal = menuTemplate(true, 'en');
    expect(walk(normal).some((item) => item.accelerator !== undefined)).toBe(true);
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

describe('bindingToAccelerator', () => {
  it('converts canonical bindings to Electron accelerators', () => {
    expect(bindingToAccelerator('mod+,')).toBe('CommandOrControl+,');
    expect(bindingToAccelerator('shift+mod+a')).toBe('Shift+CommandOrControl+A');
    expect(bindingToAccelerator('alt+mod+s')).toBe('Alt+CommandOrControl+S');
    expect(bindingToAccelerator('ctrl+shift+f5')).toBe('Control+Shift+F5');
    expect(bindingToAccelerator('mod+arrowup')).toBe('CommandOrControl+Up');
    expect(bindingToAccelerator('ctrl+plus')).toBe('Control+Plus');
    expect(bindingToAccelerator("mod+;")).toBe('CommandOrControl+;');
    expect(bindingToAccelerator('escape')).toBe('Esc');
  });

  it('returns undefined for null and inexpressible bindings', () => {
    expect(bindingToAccelerator(null)).toBeUndefined();
    expect(bindingToAccelerator('')).toBeUndefined();
    expect(bindingToAccelerator('mod')).toBeUndefined();
    expect(bindingToAccelerator('mod+unknownkey')).toBeUndefined();
    expect(bindingToAccelerator('hyper+k')).toBeUndefined();
    // The single quote is NOT in Electron's documented key-code set.
    expect(bindingToAccelerator("mod+'")).toBeUndefined();
  });
});
