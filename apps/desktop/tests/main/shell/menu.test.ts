import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Menu } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';
import { IPC } from '../../../src/main/ipc/ipc-channels';

import {
  bindingToAccelerator,
  buildMenu,
  menuTemplate,
  normalizeMenuPopupPoint,
  popupWindowsMenu,
  windowsMenuTemplate,
} from '../../../src/main/shell/menu';
import {
  isReservedBinding,
  parseBinding,
  serializeBinding,
} from '../../../src/renderer/lib/keymap';

const mocks = vi.hoisted(() => ({
  trackDesktopEvent: vi.fn(),
  showMainWindow: vi.fn(),
  createWindow: vi.fn(),
  sendToRenderer: vi.fn(),
  sendMenuActionWhenReady: vi.fn(),
  getMainWindow: vi.fn((): { webContents: object } | null => null),
  focusedContents: vi.fn((): { isDestroyed: () => boolean; selectAll: () => void; undo: () => void; redo: () => void } | null => null),
  connect: vi.fn(),
  requestUpdateCheck: vi.fn(),
  requestUpdateDownload: vi.fn(),
  isLinuxNativeTitleBar: vi.fn(() => false),
  devToolsMode: vi.fn((): 'right' | 'detach' => 'detach'),
  openExternal: vi.fn(),
  sendActionToFirstResponder: vi.fn(),
  exportDiagnostics: vi.fn(async () => {}),
  openLogsFolder: vi.fn(async () => {}),
  showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
}));

vi.mock('electron', () => ({
  webContents: { getFocusedWebContents: mocks.focusedContents },
  app: { getLocale: () => 'en-US', isPackaged: true, getVersion: () => '1.0.1' },
  dialog: { showMessageBox: mocks.showMessageBox },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => template),
    setApplicationMenu: vi.fn(),
    sendActionToFirstResponder: mocks.sendActionToFirstResponder,
  },
  net: { fetch: vi.fn() },
  shell: { openExternal: mocks.openExternal },
}));
vi.mock('../../../src/main/diagnostics/track', () => ({ trackDesktopEvent: mocks.trackDesktopEvent, trySendDesktopEvent: vi.fn() }));
vi.mock('../../../src/main/window/window-registry', () => ({
  getMainWindow: mocks.getMainWindow,
  sendToRenderer: mocks.sendToRenderer,
}));
vi.mock('../../../src/main/window/main-window', () => ({
  createWindow: mocks.createWindow,
  sendMenuActionWhenReady: mocks.sendMenuActionWhenReady,
  showMainWindow: mocks.showMainWindow,
  devToolsMode: mocks.devToolsMode,
  usesCustomTitleBar: (platform: NodeJS.Platform, linuxNativeTitleBar: boolean) =>
    platform === 'win32' || (platform === 'linux' && !linuxNativeTitleBar),
}));
vi.mock('../../../src/main/app/ui-state', () => ({
  isLinuxNativeTitleBar: mocks.isLinuxNativeTitleBar,
}));
vi.mock('../../../src/main/server/connect', () => ({ connect: mocks.connect }));
vi.mock('../../../src/main/diagnostics/diagnostics-export', () => ({
  exportDiagnostics: mocks.exportDiagnostics,
  openLogsFolder: mocks.openLogsFolder,
}));
vi.mock('../../../src/main/release/updater', () => ({
  requestUpdateCheck: mocks.requestUpdateCheck,
  requestUpdateDownload: mocks.requestUpdateDownload,
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

const ELECTRON_ROLE_ACCELERATORS: Record<string, { apple?: string; other?: string }> = {
  undo: { apple: 'CommandOrControl+Z', other: 'CommandOrControl+Z' },
  redo: { apple: 'Shift+CommandOrControl+Z', other: 'Control+Y' },
  cut: { apple: 'CommandOrControl+X', other: 'CommandOrControl+X' },
  copy: { apple: 'CommandOrControl+C', other: 'CommandOrControl+C' },
  paste: { apple: 'CommandOrControl+V', other: 'CommandOrControl+V' },
  pasteAndMatchStyle: { apple: 'Cmd+Option+Shift+V', other: 'Shift+CommandOrControl+V' },
  selectAll: { apple: 'CommandOrControl+A', other: 'CommandOrControl+A' },
  reload: { apple: 'CmdOrCtrl+R', other: 'CmdOrCtrl+R' },
  forceReload: { apple: 'Shift+CmdOrCtrl+R', other: 'Shift+CmdOrCtrl+R' },
  toggleDevTools: { apple: 'Alt+Command+I', other: 'Ctrl+Shift+I' },
  resetZoom: { apple: 'CommandOrControl+0', other: 'CommandOrControl+0' },
  zoomIn: { apple: 'CommandOrControl+Plus', other: 'CommandOrControl+Plus' },
  zoomOut: { apple: 'CommandOrControl+-', other: 'CommandOrControl+-' },
  togglefullscreen: { apple: 'Control+Command+F', other: 'F11' },
  minimize: { apple: 'CommandOrControl+M', other: 'CommandOrControl+M' },
  close: { apple: 'CommandOrControl+W', other: 'CommandOrControl+W' },
  quit: { apple: 'CommandOrControl+Q' },
  hide: { apple: 'Command+H' },
  hideOthers: { apple: 'Command+Alt+H' },
  about: {},
  services: {},
  unhide: {},
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

function installedRoles(template: MenuItemConstructorOptions[]): string[] {
  const roles = new Set<string>();
  for (const item of walkItems(template)) {
    if (typeof item.role === 'string') roles.add(item.role);
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
        if (accelerator === undefined) continue;
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
  it('routes browser shortcuts through native accelerators instead of reloading the app', () => {
    const items = walkItems(menuTemplate(true, 'zh'));
    for (const [id, key] of [['browser-reload', 'R'], ['browser-new-tab', 'T'], ['browser-focus-address', 'L']]) {
      const item = items.find((candidate) => candidate.id === id)!;
      expect(item.accelerator).toBe(`CommandOrControl+${key}`);
      expect(item.role).toBeUndefined();
      (item.click as () => void)();
      expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC.menuAction, id);
    }
  });
  it('restores the standard macOS app-menu roles with bilingual labels', () => {
    for (const [locale, labels] of [
      ['zh', ['服务', '隐藏 Kimi Code', '隐藏其他', '全部显示']],
      ['en', ['Services', 'Hide Kimi Code', 'Hide Others', 'Show All']],
    ] as const) {
      const items = appMenuItems(menuTemplate(true, locale));
      for (const [index, role] of ['services', 'hide', 'hideOthers', 'unhide'].entries()) {
        expect(items.find((item) => item.role === role)).toMatchObject({ label: labels[index] });
      }
    }

    const nonMacRoles = appMenuItems(menuTemplate(false, 'en')).map((item) => item.role);
    for (const role of ['services', 'hide', 'hideOthers', 'unhide']) {
      expect(nonMacRoles).not.toContain(role);
    }
  });

  it('macOS File menu carries the Close item wired to the two-step close (Cmd+W, renderer-dispatched)', () => {
    const template = menuTemplate(true, 'zh');
    const fileMenu = template.find((item) => item.label === '文件');
    expect(fileMenu).toBeDefined();
    const closeItem = submenuItems(fileMenu as MenuItemConstructorOptions).find(
      (item) => item.id === 'close-session-view',
    );
    expect(closeItem).toMatchObject({ label: '关闭窗口', accelerator: 'CommandOrControl+W' });
    expect(closeItem?.role).toBeUndefined();
    expect(typeof closeItem?.click).toBe('function');
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
    expect(items.find((item) => item.id === 'close-session-view')).toMatchObject({
      label: 'Close Window',
      accelerator: 'CommandOrControl+W',
    });
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

  it('drops the windowMenu role on other platforms (its expanded Close item would conflict with Ctrl+W)', () => {
    const template = menuTemplate(false, 'zh');
    expect(template.some((item) => item.role === 'windowMenu')).toBe(false);
    const windowMenu = template.find((item) => item.label === '窗口');
    expect(windowMenu).toBeDefined();
    expect(
      submenuItems(windowMenu as MenuItemConstructorOptions).some((item) => item.role === 'close'),
    ).toBe(false);
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
      closeSessionView: 'alt+mod+w',
      openFolder: null,
    });
    expect(appMenuItems(template).find((item) => item.id === 'open-settings')).toMatchObject({
      accelerator: 'Shift+CommandOrControl+P',
    });
    const fileItems = submenuItems(template.find((item) => item.label === 'File') as MenuItemConstructorOptions);
    expect(fileItems.find((item) => item.id === 'new-chat')).toMatchObject({
      accelerator: 'Alt+CommandOrControl+N',
    });
    expect(fileItems.find((item) => item.id === 'close-session-view')).toMatchObject({
      accelerator: 'Alt+CommandOrControl+W',
    });
    expect(fileItems.find((item) => item.id === 'open-folder')?.accelerator).toBeUndefined();
  });

  it('View menu carries Toggle Terminal, wired, with the accelerator following the binding', () => {
    const zhView = submenuItems(menuTemplate(true, 'zh').find((item) => item.label === '视图') as MenuItemConstructorOptions);
    const zhItem = zhView.find((item) => item.id === 'toggle-terminal');
    expect(zhItem).toMatchObject({ label: '切换终端', accelerator: 'Control+`' });
    expect(typeof zhItem?.click).toBe('function');

    const enView = submenuItems(menuTemplate(true, 'en').find((item) => item.label === 'View') as MenuItemConstructorOptions);
    expect(enView.find((item) => item.id === 'toggle-terminal')).toMatchObject({ label: 'Toggle Terminal' });

    const zhFile = submenuItems(menuTemplate(true, 'zh').find((item) => item.label === '文件') as MenuItemConstructorOptions);
    const newTab = zhFile.find((item) => item.id === 'new-terminal-tab');
    expect(newTab).toMatchObject({ label: '新建终端' });
    expect(newTab?.accelerator).toBeUndefined();
    expect(typeof newTab?.click).toBe('function');

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
    const template = menuTemplate(true, 'en', {}, 'recording');
    const edit = template.find((item) => item.id === 'edit-menu');
    expect(edit).toBeDefined();
    const editItems = new Set(walkItems(submenuItems(edit as MenuItemConstructorOptions)));
    for (const item of walkItems(template)) {
      if (item === edit || editItems.has(item)) continue;
      expect(item.role, item.label).toBeUndefined();
      expect(item.accelerator, item.label).toBeUndefined();
    }
    expect([...editItems].some((item) => item.role !== undefined)).toBe(true);
    expect([...editItems].some((item) => item.accelerator !== undefined)).toBe(true);
    const normal = menuTemplate(true, 'en');
    expect(walkItems(normal).some((item) => item.accelerator !== undefined)).toBe(true);
  });

  it('terminal suspension on macOS deregisters only custom Ctrl-only accelerators', () => {
    const template = menuTemplate(true, 'en', { openSettings: 'ctrl+c' }, 'terminal');
    const appItems = submenuItems(template[0] as MenuItemConstructorOptions);
    const settings = appItems.find((item) => item.id === 'open-settings');
    expect(settings?.accelerator).toBeUndefined();
    expect(settings?.registerAccelerator).toBe(false);
    const viewItems = submenuItems(template.find((item) => item.label === 'View') as MenuItemConstructorOptions);
    const toggle = viewItems.find((item) => item.id === 'toggle-terminal');
    expect(toggle?.accelerator).toBeUndefined();
    expect(toggle?.registerAccelerator).toBe(false);
    const fileItems = submenuItems(template.find((item) => item.label === 'File') as MenuItemConstructorOptions);
    expect(fileItems.find((item) => item.id === 'new-chat')?.accelerator).toBe('CommandOrControl+N');
    expect(walkItems(template).some((item) => item.role !== undefined)).toBe(true);
  });

  it('terminal suspension deregisters accelerators but keeps roles/clicks; macOS stays fully armed', () => {
    const macTemplate = menuTemplate(true, 'en', {}, 'terminal');
    const macNormal = menuTemplate(true, 'en');
    expect(walkItems(macTemplate).some((item) => item.accelerator !== undefined)).toBe(true);
    expect(walkItems(macTemplate).some((item) => item.role !== undefined)).toBe(true);
    expect(walkItems(macTemplate).length).toBe(walkItems(macNormal).length);

    for (const template of [menuTemplate(false, 'en', {}, 'terminal'), windowsMenuTemplate('en', {}, 'terminal', false)]) {
      for (const item of walkItems(template)) {
        expect(item.accelerator, item.label).toBeUndefined();
        if (item.role === undefined && item.type !== 'separator') {
          expect(item.registerAccelerator, item.label).toBe(false);
        }
      }
      expect(walkItems(template).some((item) => item.role !== undefined)).toBe(true);
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
      expect(items.some((item) => item.role === 'selectAll')).toBe(false);
      const selectAll = items.find((item) => item.id === 'select-all');
      expect(selectAll).toMatchObject({ label: itemLabel, accelerator: 'CommandOrControl+A' });
      expect(typeof selectAll?.click).toBe('function');
    }
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

  it('Help menu carries working Documentation / Feedback / Console entries, bilingually', () => {
    const zhTemplate = menuTemplate(true, 'zh');
    const helpMenu = zhTemplate[zhTemplate.length - 1] as MenuItemConstructorOptions;
    expect(helpMenu.label).toBe('帮助');
    const zhItems = submenuItems(helpMenu);
    const docsIndex = zhItems.findIndex((item) => item.id === 'help-docs');
    const feedbackIndex = zhItems.findIndex((item) => item.id === 'open-feedback');
    const consoleIndex = zhItems.findIndex((item) => item.id === 'help-console');
    expect(feedbackIndex).toBe(docsIndex + 1);
    expect(consoleIndex).toBe(feedbackIndex + 1);
    const docs = zhItems[docsIndex];
    const feedback = zhItems[feedbackIndex];
    const consoleItem = zhItems[consoleIndex];
    expect(docs?.label).toBe('使用文档');
    expect(feedback?.label).toBe('反馈');
    expect(consoleItem?.label).toBe('控制台');
    expect(typeof docs?.click).toBe('function');
    expect(typeof feedback?.click).toBe('function');
    expect(typeof consoleItem?.click).toBe('function');

    mocks.showMainWindow.mockClear();
    mocks.sendToRenderer.mockClear();
    (feedback?.click as (() => void) | undefined)?.();
    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
    expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC.menuAction, 'open-feedback');

    const enTemplate = menuTemplate(true, 'en');
    const enHelp = enTemplate[enTemplate.length - 1] as MenuItemConstructorOptions;
    expect(enHelp.label).toBe('Help');
    const enItems = submenuItems(enHelp);
    expect(enItems.find((item) => item.id === 'help-docs')?.label).toBe('Documentation');
    expect(enItems.find((item) => item.id === 'open-feedback')?.label).toBe('Feedback');
    expect(enItems.find((item) => item.id === 'help-console')?.label).toBe('Console');
  });

  it('Help menu exports diagnostics in the menu locale and opens the logs folder', () => {
    const zhItems = submenuItems(menuTemplate(true, 'zh').find((item) => item.label === '帮助') as MenuItemConstructorOptions);
    const zhExport = zhItems.find((item) => item.id === 'export-diagnostics');
    expect(zhExport?.label).toBe('导出诊断信息…');
    expect(zhItems.find((item) => item.id === 'open-logs-folder')?.label).toBe('打开日志文件夹');
    (zhExport?.click as (() => void) | undefined)?.();
    expect(mocks.exportDiagnostics).toHaveBeenCalledWith('zh');
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('menu_action', { action: 'export-diagnostics' });

    const enItems = submenuItems(menuTemplate(false, 'en').find((item) => item.label === 'Help') as MenuItemConstructorOptions);
    expect(enItems.find((item) => item.id === 'export-diagnostics')?.label).toBe('Export Diagnostics…');
    const openFolder = enItems.find((item) => item.id === 'open-logs-folder');
    expect(openFolder?.label).toBe('Open Logs Folder');
    (openFolder?.click as (() => void) | undefined)?.();
    expect(mocks.openLogsFolder).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('menu_action', { action: 'open-logs-folder' });
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
    expect(bindingToAccelerator("mod+'")).toBeUndefined();
  });
});

describe('close-session-view click routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function closeItem(): MenuItemConstructorOptions {
    const fileMenu = menuTemplate(true, 'zh').find((item) => item.label === '文件');
    const item = submenuItems(fileMenu as MenuItemConstructorOptions).find(
      (entry) => entry.id === 'close-session-view',
    );
    expect(item, 'close item exists').toBeDefined();
    return item as MenuItemConstructorOptions;
  }

  function clickWithWindow(item: MenuItemConstructorOptions, win: unknown): void {
    (item.click as unknown as (menuItem: unknown, focusedWindow: unknown) => void)({}, win);
  }

  it('closes a focused non-main window natively (preview window keeps the pre-change behavior)', () => {
    const mainWin = { close: vi.fn() };
    const previewWin = { close: vi.fn() };
    mocks.getMainWindow.mockImplementationOnce(() => mainWin as unknown as null);
    clickWithWindow(closeItem(), previewWin);
    expect(previewWin.close).toHaveBeenCalledTimes(1);
    expect(mocks.sendToRenderer).not.toHaveBeenCalled();
  });

  it('closes the focused native panel when Electron reports no focused window on macOS', () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
    try {
      clickWithWindow(closeItem(), null);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
    }
    expect(mocks.sendActionToFirstResponder).toHaveBeenCalledWith('performClose:');
    expect(mocks.getMainWindow).not.toHaveBeenCalled();
    expect(mocks.sendToRenderer).not.toHaveBeenCalled();
  });

  it('does nothing when no window is focused on non-macOS platforms', () => {
    const realPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', enumerable: true, configurable: true });
    try {
      clickWithWindow(closeItem(), null);
    } finally {
      Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
    }
    expect(mocks.sendActionToFirstResponder).not.toHaveBeenCalled();
    expect(mocks.sendToRenderer).not.toHaveBeenCalled();
  });

  it('forwards to the renderer for the two-step close when the main window is focused', () => {
    const mainWin = { close: vi.fn() };
    mocks.getMainWindow.mockImplementationOnce(() => mainWin as unknown as null);
    clickWithWindow(closeItem(), mainWin);
    expect(mainWin.close).not.toHaveBeenCalled();
    expect(mocks.sendToRenderer).toHaveBeenCalledWith('kimi:menu-action', 'close-session-view');
  });
});

describe('menu telemetry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function clickItem(item: MenuItemConstructorOptions | undefined): void {
    expect(item, 'menu item exists').toBeDefined();
    (item?.click as (() => void) | undefined)?.();
  }

  it('tracks the main-only Check for Updates item (runMenuUpdateCheck entry)', async () => {
    mocks.requestUpdateCheck.mockResolvedValue({ outcome: 'latest' });
    clickItem(appMenuItems(menuTemplate(true, 'en')).find((item) => item.id === 'check-for-updates'));
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('menu_action', { action: 'check-for-updates' });
    await new Promise((resolve) => setImmediate(resolve));
  });

  it('opens the renderer update dialog without downloading when an update is available', async () => {
    mocks.requestUpdateCheck.mockResolvedValue({ outcome: 'available', version: '1.2.3' });
    clickItem(appMenuItems(menuTemplate(true, 'en')).find((item) => item.id === 'check-for-updates'));
    await vi.waitFor(() => {
      expect(mocks.sendMenuActionWhenReady).toHaveBeenCalledWith('open-update-dialog');
    });

    expect(mocks.showMainWindow).toHaveBeenCalledOnce();
    expect(mocks.requestUpdateDownload).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('tracks the Help menu Documentation / Console links', async () => {
    const { setServerRegionSource } = await import('../../../src/main/server/region');
    setServerRegionSource('http://127.0.0.1:12345');
    const template = menuTemplate(true, 'en');
    const helpItems = submenuItems(template[template.length - 1] as MenuItemConstructorOptions);
    clickItem(helpItems.find((item) => item.id === 'help-docs'));
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('menu_action', { action: 'help-docs' });
    clickItem(helpItems.find((item) => item.id === 'help-console'));
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('menu_action', { action: 'help-console' });
    await new Promise((resolve) => setImmediate(resolve));
    expect(mocks.openExternal).toHaveBeenCalledTimes(2);
  });

  it('does not track renderer-forwarded items (renderer-side action_invoked covers them)', () => {
    const all = walkItems(menuTemplate(true, 'en'));
    for (const id of ['open-settings', 'open-feedback', 'new-chat', 'open-folder', 'select-all', 'retry-connection']) {
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
    expect(walkItems(template).filter((item) => item.role === 'close')).toHaveLength(0);
    const fileItems = submenuItems(template.find((item) => item.id === 'file-menu') as MenuItemConstructorOptions);
    expect(fileItems.find((item) => item.id === 'close-session-view')).toMatchObject({
      label: '关闭窗口',
      accelerator: 'CommandOrControl+W',
    });
    expect(walkItems(template).some((item) => item.id === 'toggle-dev-tools')).toBe(false);
  });

  it('keeps development-only view actions in development', () => {
    const items = walkItems(windowsMenuTemplate('en', {}, false, true));
    expect(items.some((item) => item.role === 'forceReload')).toBe(true);
    expect(items.some((item) => item.id === 'toggle-dev-tools')).toBe(true);
  });

  it('keeps feedback and diagnostics export reachable from the custom title bar Help menu', () => {
    const help = submenuItems(
      windowsMenuTemplate('zh', {}, false, false).find((item) => item.id === 'help-menu') as MenuItemConstructorOptions,
    );
    const docsIndex = help.findIndex((item) => item.id === 'help-docs');
    const feedbackIndex = help.findIndex((item) => item.id === 'open-feedback');
    expect(feedbackIndex).toBe(docsIndex + 1);
    expect(help[feedbackIndex]?.label).toBe('反馈');
    expect(help.find((item) => item.id === 'export-diagnostics')?.label).toBe('导出诊断信息…');
    expect(help.find((item) => item.id === 'open-logs-folder')?.label).toBe('打开日志文件夹');
  });

  it('reflects the performance trace state in Help', () => {
    const items = walkItems(windowsMenuTemplate('en', {}, false, true, true));
    expect(items.find((item) => item.id === 'performance-trace')?.label).toBe('Stop Performance Trace');
  });

  it('opens devtools with the shared platform-resolved mode', () => {
    const openDevTools = vi.fn();
    mocks.getMainWindow.mockReturnValue({
      isDestroyed: () => false,
      webContents: { isDevToolsOpened: () => false, openDevTools },
    } as never);
    mocks.devToolsMode.mockReturnValueOnce('right');
    const item = walkItems(windowsMenuTemplate('en', {}, false, true)).find((entry) => entry.id === 'toggle-dev-tools')!;
    (item.click as () => void)();
    expect(openDevTools).toHaveBeenCalledWith({ mode: 'right' });
    mocks.getMainWindow.mockReturnValue(null);
  });

  it('normalizes popup coordinates for zoom and rejects invalid input', () => {
    expect(normalizeMenuPopupPoint(12.4, 40, 1.25)).toEqual({ x: 16, y: 50 });
    expect(normalizeMenuPopupPoint(-2, -3, 1)).toEqual({ x: 0, y: 0 });
    expect(normalizeMenuPopupPoint(Number.NaN, 1, 1)).toBeNull();
    expect(normalizeMenuPopupPoint(1, 1, 0)).toBeNull();
  });
});

describe('buildMenu platform selection', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLinuxNativeTitleBar.mockReturnValue(false);
    mocks.getMainWindow.mockReturnValue(null);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
  });

  function lastBuiltTemplate(): MenuItemConstructorOptions[] {
    const call = vi.mocked(Menu.buildFromTemplate).mock.calls.at(-1);
    expect(call, 'Menu.buildFromTemplate was called').toBeDefined();
    return call![0] as MenuItemConstructorOptions[];
  }

  it('builds the four-menu template and hides the menu bar for a Linux custom title bar', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
    const win = { webContents: {}, setMenuBarVisibility: vi.fn() };
    mocks.getMainWindow.mockReturnValue(win);
    buildMenu();
    expect(lastBuiltTemplate().map((item) => item.id)).toEqual(['file-menu', 'edit-menu', 'view-menu', 'help-menu']);
    expect(win.setMenuBarVisibility).toHaveBeenCalledWith(false);
  });

  it('keeps the legacy template and a visible menu bar for the Linux native title bar opt-out', () => {
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
    mocks.isLinuxNativeTitleBar.mockReturnValue(true);
    const win = { webContents: {}, setMenuBarVisibility: vi.fn() };
    mocks.getMainWindow.mockReturnValue(win);
    buildMenu();
    const template = lastBuiltTemplate();
    expect(template.some((item) => item.id === 'file-menu')).toBe(false);
    expect(win.setMenuBarVisibility).not.toHaveBeenCalled();
  });

  it('keeps the macOS template on darwin', () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
    buildMenu();
    expect(lastBuiltTemplate()[0]?.label).toBe('Kimi Code');
  });
});

describe('popupWindowsMenu platform guard', () => {
  const realPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isLinuxNativeTitleBar.mockReturnValue(false);
    mocks.getMainWindow.mockReturnValue(null);
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform, enumerable: true, configurable: true });
  });

  it('refuses to pop up outside the custom title bar platforms', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin', enumerable: true, configurable: true });
    await expect(popupWindowsMenu('file', 12, 40)).resolves.toEqual({ opened: false });
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
    mocks.isLinuxNativeTitleBar.mockReturnValue(true);
    await expect(popupWindowsMenu('file', 12, 40)).resolves.toEqual({ opened: false });
  });

  it('pops up the matching submenu on a Linux custom title bar', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', enumerable: true, configurable: true });
    const win = {
      isDestroyed: () => false,
      setMenuBarVisibility: vi.fn(),
      webContents: { getZoomFactor: () => 1 },
    };
    mocks.getMainWindow.mockReturnValue(win as never);
    const popup = vi.fn((opts: { callback: () => void }) => opts.callback());
    vi.mocked(Menu.buildFromTemplate).mockReturnValueOnce({
      getMenuItemById: () => ({ submenu: { popup } }),
    } as never);
    buildMenu();
    await expect(popupWindowsMenu('file', 12, 40)).resolves.toEqual({ opened: true });
    expect(popup).toHaveBeenCalledWith(expect.objectContaining({ window: win, x: 12, y: 40 }));
  });
});

it.each(['undo', 'redo', 'select-all'] as const)('routes %s to the actual focused native contents and preserves main composer routing', (command) => {
  const contents = { isDestroyed: () => false, selectAll: vi.fn(), undo: vi.fn(), redo: vi.fn() };
  const item = walkItems(menuTemplate(true, 'en')).find((entry) => entry.id === command)!;
  mocks.focusedContents.mockReturnValue(contents);
  mocks.getMainWindow.mockReturnValue({ webContents: {} });
  mocks.sendToRenderer.mockClear();
  (item.click as () => void)();
  expect(command === 'select-all' ? contents.selectAll : command === 'undo' ? contents.undo : contents.redo).toHaveBeenCalledOnce();
  expect(mocks.sendToRenderer).not.toHaveBeenCalled();
  mocks.getMainWindow.mockReturnValue({ webContents: contents });
  (item.click as () => void)();
  expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC.menuAction, command);
  mocks.focusedContents.mockReturnValue(null);
  mocks.getMainWindow.mockReturnValue(null);
});

it('routes Command W to the renderer while retaining native closing for other windows', () => {
  const item = walkItems(menuTemplate(true, 'en')).find(item => item.id === 'close-session-view')!;
  mocks.sendToRenderer.mockClear();
  const mainWindow = { webContents: {} };
  mocks.getMainWindow.mockReturnValue(mainWindow);
  item.click?.({} as never, mainWindow as never, {} as never);
  expect(mocks.sendToRenderer).toHaveBeenCalledWith(IPC.menuAction, 'close-session-view');
  const popup = { close: vi.fn() };
  item.click?.({} as never, popup as never, {} as never);
  expect(popup.close).toHaveBeenCalledOnce();
});

it('opens app renderer DevTools detached and closes it from the host even when a browser page or overlay view has focus', () => {
  const item = walkItems(menuTemplate(true, 'en')).find(entry => entry.id === 'toggle-dev-tools')!;
  let opened = false;
  const devToolsMock = () => ({ isDevToolsOpened: vi.fn(() => false), openDevTools: vi.fn(), closeDevTools: vi.fn(), toggleDevTools: vi.fn() });
  const host = {
    ...devToolsMock(),
    isDevToolsOpened: vi.fn(() => opened),
    openDevTools: vi.fn(() => { opened = true; }),
    closeDevTools: vi.fn(() => { opened = false; }),
  };
  const page = { isDestroyed: () => false, ...devToolsMock() };
  const overlay = { isDestroyed: () => false, ...devToolsMock() };
  const mainWindow = { isDestroyed: () => false, webContents: host, hostView: { webContents: host }, contentView: { children: [{ webContents: page }, { webContents: host }, { webContents: overlay }] } };
  mocks.getMainWindow.mockReturnValue(mainWindow as never);
  for (const focused of [page, overlay, host]) {
    mocks.focusedContents.mockReturnValue(focused as never);
    item.click?.({} as never, mainWindow as never, {} as never);
    expect(host.openDevTools).toHaveBeenCalledOnce();
    expect(host.openDevTools).toHaveBeenLastCalledWith({ mode: 'detach' });
    expect(host.closeDevTools).not.toHaveBeenCalled();
    item.click?.({} as never, mainWindow as never, {} as never);
    expect(host.openDevTools).toHaveBeenCalledOnce();
    expect(host.closeDevTools).toHaveBeenCalledOnce();
    host.openDevTools.mockClear();
    host.closeDevTools.mockClear();
  }
  expect(host.toggleDevTools).not.toHaveBeenCalled();
  for (const other of [page, overlay]) {
    expect(other.openDevTools).not.toHaveBeenCalled();
    expect(other.closeDevTools).not.toHaveBeenCalled();
    expect(other.toggleDevTools).not.toHaveBeenCalled();
  }
  mocks.focusedContents.mockReturnValue(null);
  mocks.getMainWindow.mockReturnValue(null);
});
