import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { MenuItemConstructorOptions } from 'electron';

import {
  bindingToAccelerator,
  menuTemplate,
  normalizeMenuPopupPoint,
  windowsMenuTemplate,
} from '../../src/main/menu';
import {
  isReservedBinding,
  parseBinding,
  serializeBinding,
} from '../../src/renderer/lib/keymap';

const mocks = vi.hoisted(() => ({
  trackDesktopEvent: vi.fn(),
  showMainWindow: vi.fn(),
  createWindow: vi.fn(),
  sendToRenderer: vi.fn(),
  getMainWindow: vi.fn((): null => null),
  connect: vi.fn(),
  requestUpdateCheck: vi.fn(),
  requestUpdateDownload: vi.fn(),
  requestUpdateInstall: vi.fn(),
  getUpdateStatus: vi.fn(() => ({ state: 'idle' as const })),
  getUpdateAutoDownload: vi.fn(() => false),
  openExternal: vi.fn(),
}));

// Telemetry clicks invoke Electron + neighboring main modules; mock them so
// the click handlers can run in the node test environment.
vi.mock('electron', () => ({
  app: { getLocale: () => 'en-US', isPackaged: true },
  dialog: { showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })) },
  Menu: { buildFromTemplate: vi.fn((template: unknown) => template), setApplicationMenu: vi.fn() },
  // menu.ts → region.ts imports `net` for the region refresh (never fired in
  // these tests; the unrefreshed cache keeps the .com links).
  net: { fetch: vi.fn() },
  shell: { openExternal: mocks.openExternal },
}));
vi.mock('../../src/main/track', () => ({ trackDesktopEvent: mocks.trackDesktopEvent }));
vi.mock('../../src/main/window', () => ({
  getMainWindow: mocks.getMainWindow,
  createWindow: mocks.createWindow,
  sendToRenderer: mocks.sendToRenderer,
  showMainWindow: mocks.showMainWindow,
}));
vi.mock('../../src/main/connect', () => ({ connect: mocks.connect }));
vi.mock('../../src/main/updater', () => ({
  getUpdateAutoDownload: mocks.getUpdateAutoDownload,
  getUpdateStatus: mocks.getUpdateStatus,
  requestUpdateCheck: mocks.requestUpdateCheck,
  requestUpdateDownload: mocks.requestUpdateDownload,
  requestUpdateInstall: mocks.requestUpdateInstall,
}));

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
  delete: {},
  showSubstitutions: {},
  toggleSmartQuotes: {},
  toggleSmartDashes: {},
  toggleTextReplacement: {},
  startSpeaking: {},
  stopSpeaking: {},
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

/** Roles a menu installs, with menu-role submenus expanded per platform. */
function installedRoles(template: MenuItemConstructorOptions[]): string[] {
  const roles = new Set<string>();
  for (const item of walkItems(template)) {
    if (typeof item.role === 'string') roles.add(item.role);
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
    for (const [surface, template] of [
      ['macOS', menuTemplate(true, 'en')],
      ['Linux', menuTemplate(false, 'en')],
      ['Windows', windowsMenuTemplate('en', {}, false, false)],
    ] as const) {
      for (const role of installedRoles(template)) {
        expect(
          ELECTRON_ROLE_ACCELERATORS[role],
          `role '${role}' (${surface}) is installed but missing from the role table`,
        ).toBeDefined();
      }
    }
  });

  it('every installed accelerator is reserved on each platform menu', () => {
    for (const [template, platform, bucket] of [
      [menuTemplate(true, 'en'), 'MacIntel', 'apple'],
      [menuTemplate(false, 'en'), 'Linux x86_64', 'other'],
      [windowsMenuTemplate('en', {}, false, false), 'Win32', 'other'],
    ] as const) {
      stubPlatform(platform);
      for (const role of installedRoles(template)) {
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

  it('shows the PR-preview exit entry only while a preview is active (it must survive the renderer swap)', () => {
    // No preview → no entry, in either menu template.
    for (const template of [menuTemplate(true, 'en'), windowsMenuTemplate('en', {}, false, true)]) {
      const view = template.find((item) => item.label === 'View');
      expect(submenuItems(view as MenuItemConstructorOptions).some((item) => item.id === 'exit-pr-preview')).toBe(
        false,
      );
    }
    // Active preview → bilingual entry with the PR number, wired click.
    const zhView = menuTemplate(true, 'zh', {}, false, false, '#306').find((item) => item.label === '视图');
    const zhEntry = submenuItems(zhView as MenuItemConstructorOptions).find(
      (item) => item.id === 'exit-pr-preview',
    );
    expect(zhEntry).toMatchObject({ label: '退出 PR 预览（#306）', accelerator: 'CommandOrControl+Alt+Shift+P' });
    expect(typeof zhEntry?.click).toBe('function');

    const enView = windowsMenuTemplate('en', {}, false, true, false, '#306').find((item) => item.id === 'view-menu');
    const enEntry = submenuItems(enView as MenuItemConstructorOptions).find(
      (item) => item.id === 'exit-pr-preview',
    );
    expect(enEntry).toMatchObject({ label: 'Exit PR Preview (#306)' });
    expect(typeof enEntry?.click).toBe('function');
  });

  it('keeps the PR-preview exit accelerator armed under terminal suspension (it is the escape hatch)', () => {
    // Every other non-role accelerator goes silent under terminal focus; the
    // exit entry is exempt in both template paths.
    for (const template of [
      menuTemplate(false, 'en', {}, 'terminal', false, '#306'),
      windowsMenuTemplate('en', {}, 'terminal', true, false, '#306'),
    ]) {
      const view = template.find((item) => item.id === 'view-menu' || item.label === 'View');
      const entry = submenuItems(view as MenuItemConstructorOptions).find(
        (item) => item.id === 'exit-pr-preview',
      );
      expect(entry).toMatchObject({ accelerator: 'CommandOrControl+Alt+Shift+P' });
    }
  });

  it('keeps the PR-preview exit fully wired under recording suspension', () => {
    for (const template of [
      menuTemplate(false, 'en', {}, 'recording', false, '#306'),
      windowsMenuTemplate('en', {}, 'recording', true, false, '#306'),
    ]) {
      const view = template.find((item) => item.id === 'view-menu' || item.label === 'View');
      const entry = submenuItems(view as MenuItemConstructorOptions).find(
        (item) => item.id === 'exit-pr-preview',
      );
      expect(entry).toMatchObject({ accelerator: 'CommandOrControl+Alt+Shift+P' });
      expect(typeof entry?.click).toBe('function');
    }
  });

  it('localizes the File menu into English', () => {
    const template = menuTemplate(true, 'en');
    const fileMenu = template.find((item) => item.label === 'File');
    expect(fileMenu).toBeDefined();
    const items = submenuItems(fileMenu as MenuItemConstructorOptions);
    expect(items.find((item) => item.role === 'close')).toMatchObject({ label: 'Close Window' });
    expect(items.some((item) => item.id === 'new-window')).toBe(false);
    expect(items.find((item) => item.id === 'new-chat')).toMatchObject({
      label: 'New Session',
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
    const template = menuTemplate(true, 'en', {
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

  it('View menu carries Toggle Terminal, wired, with the accelerator following the binding', () => {
    const zhView = submenuItems(menuTemplate(true, 'zh').find((item) => item.label === '视图') as MenuItemConstructorOptions);
    const zhItem = zhView.find((item) => item.id === 'toggle-terminal');
    expect(zhItem).toMatchObject({ label: '切换终端', accelerator: 'Control+`' });
    // Same rule as New Chat: a handler-less accelerator would shadow the keydown.
    expect(typeof zhItem?.click).toBe('function');

    const enView = submenuItems(menuTemplate(true, 'en').find((item) => item.label === 'View') as MenuItemConstructorOptions);
    expect(enView.find((item) => item.id === 'toggle-terminal')).toMatchObject({ label: 'Toggle Terminal' });

    const rebound = submenuItems(
      menuTemplate(true, 'en', { toggleTerminal: 'shift+mod+t' }).find((item) => item.label === 'View') as MenuItemConstructorOptions,
    );
    expect(rebound.find((item) => item.id === 'toggle-terminal')).toMatchObject({
      accelerator: 'Shift+CommandOrControl+T',
    });
    const unassigned = submenuItems(
      menuTemplate(true, 'en', { toggleTerminal: null }).find((item) => item.label === 'View') as MenuItemConstructorOptions,
    );
    expect(unassigned.find((item) => item.id === 'toggle-terminal')?.accelerator).toBeUndefined();
  });

  it('strips every accelerator outside the edit menu while suspended (shortcut recording)', () => {
    // A DISABLED item's accelerator can still fire on macOS, so the suspended
    // template removes key equivalents outright: no accelerator, no role. The
    // edit menu keeps both so copy/paste stays functional (its accelerators
    // are reserved anyway).
    const template = menuTemplate(true, 'en', {}, 'recording');
    const edit = template.find((item) => item.id === 'edit-menu');
    expect(edit).toBeDefined();
    const editItems = new Set(walkItems(submenuItems(edit as MenuItemConstructorOptions)));
    for (const item of walkItems(template)) {
      if (item === edit || editItems.has(item)) continue;
      expect(item.role, item.label).toBeUndefined();
      expect(item.accelerator, item.label).toBeUndefined();
    }
    // …the edit menu keeps its roles and accelerators (copy/paste, Select All)…
    expect([...editItems].some((item) => item.role !== undefined)).toBe(true);
    expect([...editItems].some((item) => item.accelerator !== undefined)).toBe(true);
    // …and the default (unsuspended) template keeps roles and accelerators.
    const normal = menuTemplate(true, 'en');
    expect(walkItems(normal).some((item) => item.accelerator !== undefined)).toBe(true);
  });

  it('terminal suspension on macOS deregisters only custom Ctrl-only accelerators', () => {
    // A user-bound Ctrl chord on a menu-synced action would fire natively
    // before the PTY — it goes silent; ⌘-based defaults stay armed.
    const template = menuTemplate(true, 'en', { openSettings: 'ctrl+c' }, 'terminal');
    const appItems = submenuItems(template[0] as MenuItemConstructorOptions);
    const settings = appItems.find((item) => item.id === 'open-settings');
    expect(settings?.accelerator).toBeUndefined();
    expect(settings?.registerAccelerator).toBe(false);
    // The default terminal binding is itself Ctrl-only (ctrl+`) — stripped too.
    const viewItems = submenuItems(template.find((item) => item.label === 'View') as MenuItemConstructorOptions);
    const toggle = viewItems.find((item) => item.id === 'toggle-terminal');
    expect(toggle?.accelerator).toBeUndefined();
    expect(toggle?.registerAccelerator).toBe(false);
    // ⌘-based items keep their accelerators; roles stay untouched.
    const fileItems = submenuItems(template.find((item) => item.label === 'File') as MenuItemConstructorOptions);
    expect(fileItems.find((item) => item.id === 'new-chat')?.accelerator).toBe('CommandOrControl+N');
    expect(walkItems(template).some((item) => item.role !== undefined)).toBe(true);
  });

  it('terminal suspension deregisters accelerators but keeps roles/clicks; macOS stays fully armed', () => {
    // macOS: every accelerator is ⌘-based (no collision with the PTY's
    // Ctrl-chords), so the menu keeps roles, accelerators, and clicks.
    const macTemplate = menuTemplate(true, 'en', {}, 'terminal');
    const macNormal = menuTemplate(true, 'en');
    expect(walkItems(macTemplate).some((item) => item.accelerator !== undefined)).toBe(true);
    expect(walkItems(macTemplate).some((item) => item.role !== undefined)).toBe(true);
    expect(walkItems(macTemplate).length).toBe(walkItems(macNormal).length);

    // Windows/Linux: every accelerator is deregistered — role items keep
    // their native behavior (role + registerAccelerator:false), custom items
    // keep their clicks and lose the dead accelerator display.
    for (const template of [menuTemplate(false, 'en', {}, 'terminal'), windowsMenuTemplate('en', {}, 'terminal', false)]) {
      for (const item of walkItems(template)) {
        expect(item.accelerator, item.label).toBeUndefined();
        if (item.role === undefined && item.type !== 'separator') {
          expect(item.registerAccelerator, item.label).toBe(false);
        }
      }
      // Role-backed items survive (reload / zoom / copy-paste …).
      expect(walkItems(template).some((item) => item.role !== undefined)).toBe(true);
      // Click-wired items survive too.
      expect(walkItems(template).some((item) => typeof item.click === 'function')).toBe(true);
    }
  });

  it('replaces the selectAll role with a wired custom item (the role accelerator would shadow the renderer keydown)', () => {
    for (const [locale, menuLabel, itemLabel] of [
      ['zh', '编辑', '全选'],
      ['en', 'Edit', 'Select All'],
    ] as const) {
      const edit = menuTemplate(true, locale).find((item) => item.id === 'edit-menu');
      expect(edit).toMatchObject({ label: menuLabel });
      const items = submenuItems(edit as MenuItemConstructorOptions);
      // The role must not come back — its native accelerator selects the
      // whole document before the renderer sees the key.
      expect(items.some((item) => item.role === 'selectAll')).toBe(false);
      const selectAll = items.find((item) => item.id === 'select-all');
      expect(selectAll).toMatchObject({ label: itemLabel, accelerator: 'CommandOrControl+A' });
      expect(typeof selectAll?.click).toBe('function');
    }
    // The chord stays reserved on both platforms, so no custom keymap binding
    // can silently lose to the menu.
    for (const platform of ['MacIntel', 'Win32']) {
      stubPlatform(platform);
      expect(isReservedBinding(canonicalFromAccelerator('CommandOrControl+A'))).toBe(true);
    }
  });

  it('replaces the undo/redo roles with wired custom items (the roles would run Chromium-native contenteditable undo behind ProseMirror’s back)', () => {
    for (const [locale, menuLabel, undoLabel, redoLabel] of [
      ['zh', '编辑', '撤销', '重做'],
      ['en', 'Edit', 'Undo', 'Redo'],
    ] as const) {
      for (const isMac of [true, false]) {
        const edit = menuTemplate(isMac, locale).find((item) => item.id === 'edit-menu');
        expect(edit).toMatchObject({ label: menuLabel });
        const items = submenuItems(edit as MenuItemConstructorOptions);
        // The roles must not come back — their native undo mutates the
        // contenteditable DOM outside the composer's ProseMirror history.
        expect(items.some((item) => item.role === 'undo')).toBe(false);
        expect(items.some((item) => item.role === 'redo')).toBe(false);
        const undo = items.find((item) => item.id === 'undo');
        expect(undo).toMatchObject({ label: undoLabel, accelerator: 'CommandOrControl+Z' });
        expect(typeof undo?.click).toBe('function');
        const redo = items.find((item) => item.id === 'redo');
        expect(redo).toMatchObject({
          label: redoLabel,
          accelerator: isMac ? 'Shift+CommandOrControl+Z' : 'Control+Y',
        });
        expect(typeof redo?.click).toBe('function');
      }
    }
  });

  it('keeps the remaining editMenu items (delete on both platforms; mac Substitutions/Speech)', () => {
    // Mirrors Electron v43's editmenu expansion: Select All and Undo/Redo are
    // replaced (see the dedicated tests above).
    for (const isMac of [true, false]) {
      const edit = menuTemplate(isMac, 'en').find((item) => item.id === 'edit-menu');
      const items = walkItems(submenuItems(edit as MenuItemConstructorOptions));
      expect(items.some((item) => item.role === 'delete')).toBe(true);
      for (const role of ['cut', 'copy', 'paste']) {
        expect(items.some((item) => item.role === role)).toBe(true);
      }
      const macOnly = ['pasteAndMatchStyle', 'showSubstitutions', 'startSpeaking', 'stopSpeaking'];
      for (const role of macOnly) {
        expect(items.some((item) => item.role === role), `${role} (isMac=${isMac})`).toBe(isMac);
      }
      expect(items.some((item) => item.label === 'Substitutions')).toBe(isMac);
      expect(items.some((item) => item.label === 'Speech')).toBe(isMac);
    }
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

  it('Help menu relabels Performance Trace to Stop while recording, bilingually', () => {
    const zhItems = submenuItems(menuTemplate(true, 'zh').find((item) => item.label === '帮助') as MenuItemConstructorOptions);
    const zhTrace = zhItems.find((item) => item.id === 'performance-trace');
    expect(zhTrace).toMatchObject({ label: '性能录制' });
    expect(typeof zhTrace?.click).toBe('function');
    const zhRecording = submenuItems(menuTemplate(true, 'zh', {}, false, true).find((item) => item.label === '帮助') as MenuItemConstructorOptions);
    expect(zhRecording.find((item) => item.id === 'performance-trace')?.label).toBe('停止性能录制');

    const enItems = submenuItems(menuTemplate(true, 'en', {}, false, true).find((item) => item.label === 'Help') as MenuItemConstructorOptions);
    expect(enItems.find((item) => item.id === 'performance-trace')?.label).toBe('Stop Performance Trace');
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

describe('menu telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Our click handlers ignore the Electron callback args.
  function clickItem(item: MenuItemConstructorOptions | undefined): void {
    expect(item, 'menu item exists').toBeDefined();
    (item?.click as (() => void) | undefined)?.();
  }

  it('tracks the main-only Check for Updates item (runMenuUpdateCheck entry)', async () => {
    mocks.requestUpdateCheck.mockResolvedValue({ outcome: 'latest' });
    clickItem(appMenuItems(menuTemplate(true, 'en')).find((item) => item.id === 'check-for-updates'));
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('menu_action', { action: 'check-for-updates' });
    // Let the fire-and-forget update check settle (dialog mocks resolve cleanly).
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('tracks the Help menu Documentation / Console links', async () => {
    // The handlers now wait for the region source before refreshing — record
    // one up front (its refresh fails harmlessly, keeping the cached default).
    const { setServerRegionSource } = await import('../../src/main/region');
    setServerRegionSource('http://127.0.0.1:12345');
    const template = menuTemplate(true, 'en');
    const helpItems = submenuItems(template[template.length - 1] as MenuItemConstructorOptions);
    clickItem(helpItems.find((item) => item.id === 'help-docs'));
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('menu_action', { action: 'help-docs' });
    clickItem(helpItems.find((item) => item.id === 'help-console'));
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('menu_action', { action: 'help-console' });
    // The links open after the region refresh settles (its fetch mock resolves
    // to undefined, which the probe treats as a failed refresh keeping the cache).
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
  });

  it('does not track renderer-forwarded items (renderer-side action_invoked covers them)', () => {
    const all = walkItems(menuTemplate(true, 'en'));
    for (const id of ['open-settings', 'new-chat', 'open-folder', 'select-all', 'retry-connection']) {
      clickItem(all.find((item) => item.id === id));
    }
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalled();
  });
});

describe('windowsMenuTemplate', () => {
  it('exposes the four approved top-level menus', () => {
    const template = windowsMenuTemplate('zh', {}, false, false);
    expect(template.map((item) => [item.id, item.label])).toEqual([
      ['file-menu', '文件'],
      ['edit-menu', '编辑'],
      ['view-menu', '视图'],
      ['help-menu', '帮助'],
    ]);
    expect(walkItems(template).filter((item) => item.role === 'close')).toHaveLength(1);
    expect(walkItems(template).some((item) => item.role === 'toggleDevTools')).toBe(false);
  });

  it('keeps development-only view actions in development', () => {
    const items = walkItems(windowsMenuTemplate('en', {}, false, true));
    expect(items.some((item) => item.role === 'forceReload')).toBe(true);
    expect(items.some((item) => item.role === 'toggleDevTools')).toBe(true);
  });

  it('reflects the performance trace state in Help', () => {
    const items = walkItems(windowsMenuTemplate('en', {}, false, true, true));
    expect(items.find((item) => item.id === 'performance-trace')?.label).toBe('Stop Performance Trace');
  });

  it('normalizes popup coordinates for zoom and rejects invalid input', () => {
    expect(normalizeMenuPopupPoint(12.4, 40, 1.25)).toEqual({ x: 16, y: 50 });
    expect(normalizeMenuPopupPoint(-2, -3, 1)).toEqual({ x: 0, y: 0 });
    expect(normalizeMenuPopupPoint(Number.NaN, 1, 1)).toBeNull();
    expect(normalizeMenuPopupPoint(1, 1, 0)).toBeNull();
  });
});
