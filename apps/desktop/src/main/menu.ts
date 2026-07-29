import { app, dialog, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { getMainWindow, createWindow, sendToRenderer, showMainWindow } from './window';
import { connect } from './connect';
import { getTraceRecorder } from './trace';
import { getUpdateAutoDownload, getUpdateStatus, requestUpdateCheck, requestUpdateDownload, requestUpdateInstall, UPDATE_CHECK_TIMED_OUT } from './updater';
import { trackDesktopEvent } from './track';
import { IPC } from './ipc-channels';
import type { TrayLocale } from './tray';
import type { WindowsMenuId } from './ipc-channels';

// --- localization -------------------------------------------------------------
//
// Same pattern as tray.ts: the main process has no i18n runtime, so the menu
// keeps its own tiny string table. The renderer pushes its effective locale
// over `IPC.locale` (ipc.ts → setMenuLocale rebuilds the menu); until then
// the OS language is the fallback. `{version}` / `{message}` placeholders are
// filled with .replace() — wording stays count-independent (no plural rules).
interface MenuStrings {
  window: string;
  closeWindow: string;
  file: string;
  edit: string;
  selectAll: string;
  substitutions: string;
  speech: string;
  view: string;
  newChat: string;
  openFolder: string;
  toggleTerminal: string;
  aboutApp: string;
  quitApp: string;
  settings: string;
  checkForUpdates: string;
  retryConnection: string;
  updateCheckTitle: string;
  updateAvailable: string;
  updateAutoDownloading: string;
  updateReadyToInstall: string;
  updateLatest: string;
  updateUnsupported: string;
  updateFailed: string;
  updateCheckTimedOut: string;
  downloadNow: string;
  restartNow: string;
  later: string;
  ok: string;
  help: string;
  documentation: string;
  console: string;
  performanceTrace: string;
  stopPerformanceTrace: string;
  traceFailed: string;
  traceKeptAt: string;
}

const MENU_STRINGS: Record<TrayLocale, MenuStrings> = {
  zh: {
    window: '窗口',
    closeWindow: '关闭窗口',
    file: '文件',
    edit: '编辑',
    selectAll: '全选',
    substitutions: '替换',
    speech: '语音',
    view: '视图',
    newChat: '新建会话',
    openFolder: '打开文件夹…',
    toggleTerminal: '切换终端',
    aboutApp: '关于 Kimi Code',
    quitApp: '退出 Kimi Code',
    settings: '设置…',
    checkForUpdates: '检查更新…',
    retryConnection: '重试连接',
    updateCheckTitle: '检查更新',
    updateAvailable: '发现新版本 {version},可立即下载更新。',
    updateAutoDownloading: '发现新版本 {version},正在后台下载,完成后重启即可更新。',
    updateReadyToInstall: '新版本 {version} 已下载完成,重启即可更新。',
    updateLatest: '当前已是最新版本。',
    updateUnsupported: '开发版本不支持检查更新。',
    updateFailed: '检查更新失败:{message}',
    updateCheckTimedOut: '检查更新超时,请检查网络后重试。',
    downloadNow: '立即下载',
    restartNow: '立即重启',
    later: '稍后',
    ok: '好',
    help: '帮助',
    documentation: '文档',
    console: '控制台',
    performanceTrace: '性能录制',
    stopPerformanceTrace: '停止性能录制',
    traceFailed: '性能录制失败:{message}',
    traceKeptAt: '录制文件已保留在 {path}',
  },
  en: {
    window: 'Window',
    closeWindow: 'Close Window',
    file: 'File',
    edit: 'Edit',
    selectAll: 'Select All',
    substitutions: 'Substitutions',
    speech: 'Speech',
    view: 'View',
    newChat: 'New Session',
    openFolder: 'Open Folder…',
    toggleTerminal: 'Toggle Terminal',
    aboutApp: 'About Kimi Code',
    quitApp: 'Quit Kimi Code',
    settings: 'Settings…',
    checkForUpdates: 'Check for Updates…',
    retryConnection: 'Retry Connection',
    updateCheckTitle: 'Check for Updates',
    updateAvailable: 'Version {version} is available.',
    updateAutoDownloading: 'Version {version} is downloading in the background; restart to update once it finishes.',
    updateReadyToInstall: 'Version {version} has been downloaded; restart to finish updating.',
    updateLatest: "You're on the latest version.",
    updateUnsupported: 'Update checks are unavailable in development builds.',
    updateFailed: 'Update check failed: {message}',
    updateCheckTimedOut: 'The update check timed out. Check your network and try again.',
    downloadNow: 'Download Now',
    restartNow: 'Restart Now',
    later: 'Later',
    ok: 'OK',
    help: 'Help',
    documentation: 'Documentation',
    console: 'Console',
    performanceTrace: 'Performance Trace',
    stopPerformanceTrace: 'Stop Performance Trace',
    traceFailed: 'Performance trace failed: {message}',
    traceKeptAt: 'Trace file kept at {path}',
  },
};

// Help-menu links (opened in the system browser). The console URL carries the
// desktop attribution param.
const HELP_LINKS = {
  docs: 'https://www.kimi.com/code/docs/',
  console: 'https://www.kimi.com/code/console?from=kimi_code_desktop',
} as const;

/** Renderer-pushed locale; null = follow the OS language until a push lands. */
let menuLocale: TrayLocale | null = null;

function effectiveMenuLocale(): TrayLocale {
  if (menuLocale !== null) {
    return menuLocale;
  }
  try {
    return app.getLocale().toLowerCase().startsWith('zh') ? 'zh' : 'en';
  } catch {
    return 'en';
  }
}

// Menu items whose accelerators mirror the renderer's customizable bindings
// (renderer/lib/keymap.ts canonical format), pushed over IPC.menuShortcut on
// startup and on every rebind. Null/unconvertible = no accelerator shown; the
// renderer's own key handling is always the fallback.
const MENU_SHORTCUT_DEFAULTS: Record<string, string | null> = {
  openSettings: 'mod+,',
  newSession: 'mod+n',
  openFolder: 'mod+o',
  toggleTerminal: 'ctrl+`',
};

let menuShortcutOverrides: Record<string, string | null> = {};

/** Effective menu binding for an action: the renderer override when pushed
 *  (null stays unassigned), otherwise the default above. */
function menuBinding(overrides: Record<string, string | null>, id: string): string | null {
  if (id in overrides) return overrides[id] ?? null;
  return MENU_SHORTCUT_DEFAULTS[id] ?? null;
}

/** Follow the renderer's keymap: rebuild the menu so the Settings / New Chat /
 *  Open Folder items show (and trigger) the user's own bindings. */
export function setMenuShortcuts(bindings: Record<string, string | null>): void {
  menuShortcutOverrides = { ...bindings };
  buildMenu();
}

// Two independent suspension sources — neither clobbers the other:
// - recording: the settings panel's shortcut recorder (seconds at a time).
//   Menu accelerators intercept keys BEFORE the renderer, so recording ⌘R
//   would reload the app instead of showing the reserved hint.
// - terminal: xterm focus in the native terminal (potentially hours). On
//   Windows/Linux the edit menu's Ctrl+C/V/A/Z accelerators fire before the
//   renderer, so the PTY would never see SIGINT & friends (macOS uses ⌘-based
//   roles and is unaffected — its edit menu stays armed for copy/paste).
let recordingSuspended = false;
let terminalFocused = false;

export type MenuSuspension = 'recording' | 'terminal' | false;

function currentSuspension(): MenuSuspension {
  if (recordingSuspended) return 'recording';
  if (terminalFocused) return 'terminal';
  return false;
}

/** Silence (or restore) all menu accelerators during shortcut recording. */
export function setMenuSuspended(suspended: boolean): void {
  if (suspended === recordingSuspended) {
    return;
  }
  recordingSuspended = suspended;
  buildMenu();
}

let terminalFocusListener: ((focused: boolean) => void) | null = null;

/** Single wiring point for state that must follow the terminal-focus
 *  suspension (ipc.ts registers the OS global-shortcut suspension here). */
export function onTerminalMenuFocus(listener: (focused: boolean) => void): void {
  terminalFocusListener = listener;
}

/** xterm focus in the native terminal: strip every accelerator (Windows also
 *  strips the edit menu's Ctrl-chords) so control keys reach the PTY. Click
 *  handlers stay live — the menus keep working when clicked. */
export function setTerminalMenuFocus(focused: boolean): void {
  if (focused === terminalFocused) {
    return;
  }
  terminalFocused = focused;
  buildMenu();
  terminalFocusListener?.(focused);
}

/** Current terminal-focus state — window.ts snapshots it at navigation start
 *  so an aborted reload can restore it for the surviving old document. */
export function getTerminalMenuFocus(): boolean {
  return terminalFocused;
}

// Accelerator key names for the non-printable canonical keys; single
// printable chars upper-case themselves (Electron takes 'A', digits, and
// punctuation like ',' verbatim).
const ACCELERATOR_KEYS: Record<string, string> = {
  enter: 'Enter',
  escape: 'Esc',
  tab: 'Tab',
  space: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'Up',
  arrowdown: 'Down',
  arrowleft: 'Left',
  arrowright: 'Right',
  plus: 'Plus',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`f${i + 1}`, `F${i + 1}`])),
};

const ACCELERATOR_MODS: Record<string, string> = {
  mod: 'CommandOrControl',
  ctrl: 'Control',
  alt: 'Alt',
  shift: 'Shift',
};

// Single printable chars Electron accepts as accelerator key codes: letters,
// digits, and the documented punctuation set — which notably does NOT
// include the single quote (see the Electron accelerator key-code list).
const ACCELERATOR_PUNCT = new Set([',', '.', '/', '\\', ';', '[', ']', '-', '=', '`']);

/** Canonical renderer binding ('shift+mod+a') → Electron accelerator
 *  ('Shift+CommandOrControl+A'); undefined when the combo can't be expressed
 *  (the menu then shows no accelerator and the renderer binding still works). */
export function bindingToAccelerator(binding: string | null): string | undefined {
  if (binding === null) return undefined;
  const tokens = binding.split('+').filter((token) => token !== '');
  if (tokens.length === 0) return undefined;
  const key = tokens[tokens.length - 1] as string;
  const mods: string[] = [];
  for (const token of tokens.slice(0, -1)) {
    const mod = ACCELERATOR_MODS[token];
    if (mod === undefined) return undefined;
    mods.push(mod);
  }
  const accelKey =
    ACCELERATOR_KEYS[key] ??
    (/^[a-z0-9]$/.test(key) || ACCELERATOR_PUNCT.has(key) ? key.toUpperCase() : undefined);
  if (accelKey === undefined) return undefined;
  return [...mods, accelKey].join('+');
}

// Menu-triggered update check: unlike the silent scheduled checks (updater.ts
// swallows their failures), a menu click deserves explicit feedback — a native
// dialog for every outcome. An already-downloaded update always offers the
// restart (a Download button would no-op against the controller's
// downloaded-state guard, in either mode); otherwise a found update offers a
// Download button in manual mode, and a progress note in auto-download mode
// (the check already kicked the download off). Download/progress/install ride
// the usual `kimi:update-status` pushes (sidebar indicator), which show
// through even for a version the user skipped in the renderer (the skip only
// hides the `available` state).
async function runMenuUpdateCheck(): Promise<void> {
  trackDesktopEvent('menu_action', { action: 'check-for-updates' });
  const strings = MENU_STRINGS[effectiveMenuLocale()];
  // Parent the dialog to a visible window (hide-on-close may leave it
  // hidden, and a sheet on a hidden window never appears).
  showMainWindow();
  const result = await requestUpdateCheck();
  const win = getMainWindow();
  const show = (opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    win === null || win.isDestroyed() ? dialog.showMessageBox(opts) : dialog.showMessageBox(win, opts);
  if (result.outcome === 'available') {
    // Mode-independent: the update has already landed — offer the restart.
    if (getUpdateStatus().state === 'downloaded') {
      const { response } = await show({
        type: 'info',
        message: strings.updateCheckTitle,
        detail: strings.updateReadyToInstall.replace('{version}', result.version ?? ''),
        buttons: [strings.restartNow, strings.later],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        requestUpdateInstall();
      }
      return;
    }
    if (getUpdateAutoDownload()) {
      // Auto mode: the check already kicked the download off — report
      // progress instead of offering a no-op Download button.
      await show({
        type: 'info',
        message: strings.updateCheckTitle,
        detail: strings.updateAutoDownloading.replace('{version}', result.version ?? ''),
        buttons: [strings.ok],
      });
      return;
    }
    const { response } = await show({
      type: 'info',
      message: strings.updateCheckTitle,
      detail: strings.updateAvailable.replace('{version}', result.version ?? ''),
      buttons: [strings.downloadNow, strings.later],
      defaultId: 0,
      cancelId: 1,
    });
    if (response === 0) {
      requestUpdateDownload();
    }
    return;
  }
  await show({
    type: result.outcome === 'error' ? 'error' : 'info',
    message: strings.updateCheckTitle,
    detail:
      result.outcome === 'latest'
        ? strings.updateLatest
        : result.outcome === 'unsupported'
          ? strings.updateUnsupported
          : result.message === UPDATE_CHECK_TIMED_OUT
            ? strings.updateCheckTimedOut
            : strings.updateFailed.replace('{message}', result.message),
    buttons: [strings.ok],
  });
}

// Help-menu performance trace toggle (trace.ts holds the recorder). The menu
// rebuild after every toggle refreshes the label with the authoritative
// state — an error mid-stop may have flipped it back. A trace menu click is
// explicit user intent, so failures get a native dialog, same policy as the
// menu update check.
async function runTraceToggle(): Promise<void> {
  const result = await getTraceRecorder().toggle();
  buildMenu();
  if (result.status !== 'error') {
    return;
  }
  const strings = MENU_STRINGS[effectiveMenuLocale()];
  showMainWindow();
  const win = getMainWindow();
  // A save failure keeps the temp trace (trace.ts); keptAt carries its path
  // so the dialog can offer manual retrieval, localized like everything else.
  const message = strings.traceFailed.replace('{message}', result.message);
  const options: Electron.MessageBoxOptions = {
    type: 'error',
    message:
      result.keptAt === undefined
        ? message
        : `${message}\n${strings.traceKeptAt.replace('{path}', result.keptAt)}`,
    buttons: [strings.ok],
  };
  if (win === null || win.isDestroyed()) {
    await dialog.showMessageBox(options);
  } else {
    await dialog.showMessageBox(win, options);
  }
}

// Pure template builder, so tests can cover it without Electron. macOS spells
// the Window submenu out: the `windowMenu` role expands to Minimize / Zoom /
// Bring All to Front with NO Close item — Close lives in the File menu
// instead (macOS convention; putting it in both would bind Cmd+W twice).
// Other platforms keep the role, whose expansion already ends with Close.
// `shortcutOverrides` carries the renderer's customizable bindings (canonical
// keymap format, keyed by action id); convertible ones show as accelerators
// on the matching menu items.
export function menuTemplate(
  isMac: boolean,
  locale: TrayLocale,
  shortcutOverrides: Record<string, string | null> = {},
  suspension: MenuSuspension = false,
  tracing = false,
): MenuItemConstructorOptions[] {
  const strings = MENU_STRINGS[locale];
  const appMenu: MenuItemConstructorOptions = {
    label: 'Kimi Code',
    submenu: [
      // Explicit labels on the about/quit roles: the role defaults embed
      // `app.getName()`, which is the package name (kimi-code-app — the
      // no-rename hard rule) in dev AND packaged builds. Overriding the label
      // (instead of app.setName) fixes the display without moving the
      // name-derived userData profile dir out from under upgrading users.
      ...(isMac
        ? [
            { role: 'about' as const, label: strings.aboutApp },
            { type: 'separator' as const },
          ]
        : []),
      {
        id: 'open-settings',
        label: strings.settings,
        accelerator: bindingToAccelerator(menuBinding(shortcutOverrides, 'openSettings')),
        click: () => {
          // The dialog lives in the renderer; the window may be hidden
          // (hide-on-close), so surface it before forwarding.
          showMainWindow();
          sendToRenderer(IPC.menuAction, 'open-settings');
        },
      },
      {
        id: 'check-for-updates',
        label: strings.checkForUpdates,
        click: () => {
          void runMenuUpdateCheck();
        },
      },
      { type: 'separator' },
      {
        id: 'retry-connection',
        label: strings.retryConnection,
        click: () => {
          // Forward to the renderer (4.5) in addition to the main-process retry.
          sendToRenderer(IPC.menuAction, 'retry-connection');
          const win = getMainWindow();
          if (win !== null) {
            void connect(win);
          } else {
            createWindow();
          }
        },
      },
      { type: 'separator' },
      isMac ? { role: 'quit', label: strings.quitApp } : { role: 'close' },
    ],
  };

  // New Chat / Open Folder are wired: the click MUST exist whenever the
  // accelerator does — a handler-less accelerator would shadow the renderer's
  // own keydown with a no-op. Their accelerators follow the renderer's
  // customizable bindings (menuShortcut overrides). Close is role-driven, so
  // it works out of the box (role default accelerator Cmd+W; closing the
  // window leaves the app resident, recreated via Dock `activate` / the
  // tray).
  const fileMenu: MenuItemConstructorOptions = {
    label: strings.file,
    submenu: [
      {
        id: 'new-chat',
        label: strings.newChat,
        accelerator: bindingToAccelerator(menuBinding(shortcutOverrides, 'newSession')),
        click: () => {
          showMainWindow();
          sendToRenderer(IPC.menuAction, 'new-chat');
        },
      },
      { type: 'separator' },
      {
        id: 'open-folder',
        label: strings.openFolder,
        accelerator: bindingToAccelerator(menuBinding(shortcutOverrides, 'openFolder')),
        click: () => {
          showMainWindow();
          sendToRenderer(IPC.menuAction, 'open-folder');
        },
      },
      { type: 'separator' },
      { role: 'close', label: strings.closeWindow },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: strings.view,
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      {
        id: 'toggle-terminal',
        label: strings.toggleTerminal,
        accelerator: bindingToAccelerator(menuBinding(shortcutOverrides, 'toggleTerminal')),
        click: () => {
          // Same wiring rule as New Chat: the accelerator would shadow the
          // renderer's keydown, so the click must forward the same action.
          showMainWindow();
          sendToRenderer(IPC.menuAction, 'toggle-terminal');
        },
      },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = isMac
    ? {
        label: strings.window,
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { type: 'separator' },
          { role: 'front' },
        ],
      }
    : { role: 'windowMenu' };

  // The edit menu is built item-by-item instead of the editMenu role because
  // of Select All: the role's native CmdOrCtrl+A accelerator intercepts the
  // key BEFORE the renderer (selecting the whole document, sidebar included),
  // so a custom item keeps the chord but forwards to the renderer's scoped
  // select-all — same wiring pattern as New Chat / Open Folder. Everything
  // else mirrors Electron's editMenu expansion verbatim (editing roles stay
  // native; mac keeps its pasteAndMatchStyle / Substitutions / Speech items).
  const editMenu: MenuItemConstructorOptions = {
    id: 'edit-menu',
    label: strings.edit,
    submenu: [
      { role: 'undo' },
      { role: 'redo' },
      { type: 'separator' },
      { role: 'cut' },
      { role: 'copy' },
      { role: 'paste' },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' as const }] : []),
      { role: 'delete' },
      ...(isMac ? [] : [{ type: 'separator' as const }]),
      {
        id: 'select-all',
        label: strings.selectAll,
        accelerator: 'CommandOrControl+A',
        click: () => {
          sendToRenderer(IPC.menuAction, 'select-all');
        },
      },
      ...(isMac
        ? [
            { type: 'separator' as const },
            {
              label: strings.substitutions,
              submenu: [
                { role: 'showSubstitutions' as const },
                { type: 'separator' as const },
                { role: 'toggleSmartQuotes' as const },
                { role: 'toggleSmartDashes' as const },
                { role: 'toggleTextReplacement' as const },
              ],
            },
            {
              label: strings.speech,
              submenu: [{ role: 'startSpeaking' as const }, { role: 'stopSpeaking' as const }],
            },
          ]
        : []),
    ],
  };

  // TODO(help-menu): add What's New (changelog) and Send Feedback items —
  // tracked in docs/native-todos.md.
  const helpMenu: MenuItemConstructorOptions = {
    label: strings.help,
    submenu: [
      {
        id: 'help-docs',
        label: strings.documentation,
        click: () => {
          trackDesktopEvent('menu_action', { action: 'help-docs' });
          void shell.openExternal(HELP_LINKS.docs);
        },
      },
      {
        id: 'help-console',
        label: strings.console,
        click: () => {
          trackDesktopEvent('menu_action', { action: 'help-console' });
          void shell.openExternal(HELP_LINKS.console);
        },
      },
      { type: 'separator' },
      {
        id: 'performance-trace',
        label: tracing ? strings.stopPerformanceTrace : strings.performanceTrace,
        click: () => {
          void runTraceToggle();
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
  if (!suspension) return template;
  if (suspension === 'recording') {
    // Shortcut recording: strip every key equivalent outright. On macOS a
    // DISABLED item's accelerator can still fire while the menu is closed
    // (menuNeedsUpdate refreshes state on the key press), so silencing must
    // remove the accelerators, not the items: every non-edit-menu item becomes
    // a plain label — no role, no accelerator, no click — which has no key
    // equivalent at all. The edit menu stays functional (copy/paste); its
    // accelerators are harmless during recording and already reserved.
    const silence = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.map((item) => {
        if (item.type === 'separator') return item;
        if (item.id === 'edit-menu') return item;
        return {
          label: item.label,
          submenu: Array.isArray(item.submenu) ? silence(item.submenu as MenuItemConstructorOptions[]) : undefined,
        };
      });
    return silence(template);
  }
  // Terminal focus on macOS: role accelerators are all ⌘-based (the PTY's
  // Ctrl chords don't collide) and stay armed. The exception: menu-synced
  // items mirror USER bindings, and the recorder allows Ctrl chords on macOS
  // — a custom Ctrl+C would still fire natively before the PTY. Deregister
  // just those custom Ctrl-only accelerators.
  if (isMac) {
    const deregisterCtrlOnly = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.map((item) => {
        const accel = typeof item.accelerator === 'string' ? item.accelerator : '';
        const next: MenuItemConstructorOptions = {
          ...item,
          submenu: Array.isArray(item.submenu)
            ? deregisterCtrlOnly(item.submenu as MenuItemConstructorOptions[])
            : undefined,
        };
        if (
          item.role === undefined &&
          accel.includes('Control') &&
          !accel.includes('CommandOrControl')
        ) {
          next.registerAccelerator = false;
          delete next.accelerator;
        }
        return next;
      });
    return deregisterCtrlOnly(template);
  }
  // Terminal focus on Windows/Linux: deregister every accelerator so control
  // keys reach the PTY — INCLUDING the edit menu's Ctrl-chords — while the
  // items themselves stay fully functional: roles keep their native click
  // behavior, explicit clicks keep theirs. (registerAccelerator:false leaves
  // the shortcut text displayed but unregistered; our custom items instead
  // drop the dead display.)
  const deregister = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.map((item) => {
      if (item.type === 'separator') return item;
      const next: MenuItemConstructorOptions = {
        ...item,
        registerAccelerator: false,
        submenu: Array.isArray(item.submenu)
          ? deregister(item.submenu as MenuItemConstructorOptions[])
          : undefined,
      };
      if (item.role === undefined) delete next.accelerator;
      return next;
    });
  return deregister(template);
}

export function windowsMenuTemplate(
  locale: TrayLocale,
  shortcutOverrides: Record<string, string | null> = {},
  suspension: MenuSuspension = false,
  isDev = !app.isPackaged,
  tracing = false,
): MenuItemConstructorOptions[] {
  const base = menuTemplate(false, locale, shortcutOverrides, false, tracing);
  const appItems = (base[0]?.submenu ?? []) as MenuItemConstructorOptions[];
  const fileItems = (base[1]?.submenu ?? []) as MenuItemConstructorOptions[];
  const edit = base[2] as MenuItemConstructorOptions;
  const view = base[3] as MenuItemConstructorOptions;
  const help = base[5] as MenuItemConstructorOptions;
  const byId = (items: MenuItemConstructorOptions[], id: string) =>
    items.find((item) => item.id === id);
  const withoutClose = (items: MenuItemConstructorOptions[]) =>
    items.filter((item) => item.role !== 'close');
  const trimSeparators = (items: MenuItemConstructorOptions[]) => {
    const result = [...items];
    while (result[0]?.type === 'separator') result.shift();
    while (result.at(-1)?.type === 'separator') result.pop();
    return result;
  };
  const strings = MENU_STRINGS[locale];
  const viewItems = ((view.submenu ?? []) as MenuItemConstructorOptions[]).filter(
    (item) => isDev || (item.role !== 'forceReload' && item.role !== 'toggleDevTools'),
  );
  const fileSubmenu = trimSeparators([
    ...withoutClose(fileItems),
    { type: 'separator' },
    byId(appItems, 'open-settings') as MenuItemConstructorOptions,
    { type: 'separator' },
    { role: 'close', label: strings.closeWindow },
    { role: 'quit', label: strings.quitApp },
  ]);
  const helpSubmenu = trimSeparators([
    byId(appItems, 'check-for-updates') as MenuItemConstructorOptions,
    byId(appItems, 'retry-connection') as MenuItemConstructorOptions,
    { type: 'separator' },
    ...((help.submenu ?? []) as MenuItemConstructorOptions[]),
    { type: 'separator' },
    { role: 'about', label: strings.aboutApp },
  ]);
  const template: MenuItemConstructorOptions[] = [
    { id: 'file-menu', label: strings.file, submenu: fileSubmenu },
    { ...edit, id: 'edit-menu' },
    { ...view, id: 'view-menu', label: strings.view, submenu: viewItems },
    { id: 'help-menu', label: strings.help, submenu: helpSubmenu },
  ];
  if (!suspension) return template;
  if (suspension === 'recording') {
    const silence = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
      items.map((item) => {
        if (item.type === 'separator' || item.id === 'edit-menu') return item;
        return {
          id: item.id,
          label: item.label,
          submenu: Array.isArray(item.submenu)
            ? silence(item.submenu as MenuItemConstructorOptions[])
            : undefined,
        };
      });
    return silence(template);
  }
  // Terminal focus on Windows: deregister every accelerator INCLUDING the
  // edit menu's Ctrl-chords (they would otherwise shadow the PTY's control
  // keys). Roles keep their native click behavior, explicit clicks keep
  // theirs — only the key equivalents go silent.
  const deregister = (items: MenuItemConstructorOptions[]): MenuItemConstructorOptions[] =>
    items.map((item) => {
      if (item.type === 'separator') return item;
      const next: MenuItemConstructorOptions = {
        ...item,
        registerAccelerator: false,
        submenu: Array.isArray(item.submenu)
          ? deregister(item.submenu as MenuItemConstructorOptions[])
          : undefined,
      };
      if (item.role === undefined) delete next.accelerator;
      return next;
    });
  return deregister(template);
}

let applicationMenu: Menu | null = null;
let activeWindowsMenu: Menu | null = null;
let activeWindowsMenuId: WindowsMenuId | null = null;
let windowsMenuRequest = 0;

export function normalizeMenuPopupPoint(
  x: number,
  y: number,
  zoomFactor: number,
): { x: number; y: number } | null {
  if (![x, y, zoomFactor].every(Number.isFinite) || zoomFactor <= 0) return null;
  return {
    x: Math.max(0, Math.round(x * zoomFactor)),
    y: Math.max(0, Math.round(y * zoomFactor)),
  };
}

export function popupWindowsMenu(
  id: WindowsMenuId,
  x: number,
  y: number,
): Promise<{ opened: boolean }> {
  if (process.platform !== 'win32') return Promise.resolve({ opened: false });
  const win = getMainWindow();
  const item = applicationMenu?.getMenuItemById(`${id}-menu`);
  if (win === null || win.isDestroyed() || item?.submenu === undefined) {
    return Promise.resolve({ opened: false });
  }
  const point = normalizeMenuPopupPoint(x, y, win.webContents.getZoomFactor());
  if (point === null) return Promise.resolve({ opened: false });
  const submenu = item.submenu;
  const request = ++windowsMenuRequest;
  const previousMenu = activeWindowsMenu;
  const previousId = activeWindowsMenuId;
  if (previousMenu !== null) {
    previousMenu.closePopup(win);
    activeWindowsMenu = null;
    activeWindowsMenuId = null;
    if (previousId === id) {
      return Promise.resolve({ opened: false });
    }
  }
  return new Promise((resolve) => {
    const open = () => {
      if (request !== windowsMenuRequest) {
        resolve({ opened: false });
        return;
      }
      activeWindowsMenu = submenu;
      activeWindowsMenuId = id;
      submenu.popup({
        window: win,
        x: point.x,
        y: point.y,
        callback: () => {
          if (request === windowsMenuRequest) {
            activeWindowsMenu = null;
            activeWindowsMenuId = null;
          }
          resolve({ opened: true });
        },
      });
    };
    if (previousMenu === null) {
      open();
    } else {
      setImmediate(open);
    }
  });
}

export function buildMenu(): void {
  const suspension = currentSuspension();
  applicationMenu = Menu.buildFromTemplate(
    process.platform === 'win32'
      ? windowsMenuTemplate(
          effectiveMenuLocale(),
          menuShortcutOverrides,
          suspension,
          !app.isPackaged,
          getTraceRecorder().isRecording(),
        )
      : menuTemplate(
          process.platform === 'darwin',
          effectiveMenuLocale(),
          menuShortcutOverrides,
          suspension,
          getTraceRecorder().isRecording(),
        ),
  );
  Menu.setApplicationMenu(applicationMenu);
  if (process.platform === 'win32') {
    getMainWindow()?.setMenuBarVisibility(false);
  }
}

/** Follow the renderer's in-app language (IPC.locale): rebuild the menu with
    the same structure in the new language. */
export function setMenuLocale(locale: TrayLocale): void {
  if (locale === menuLocale) {
    return;
  }
  menuLocale = locale;
  buildMenu();
}
