import { app, dialog, Menu, shell } from 'electron';
import type { MenuItem, MenuItemConstructorOptions } from 'electron';

import { getMainWindow, createWindow, sendToRenderer, showMainWindow } from './window';
import { connect, serverLogPath } from './connect';
import { togglePetVisibility } from './pet';
import { requestUpdateCheck, requestUpdateDownload } from './updater';
import { IPC } from './ipc-channels';
import type { TrayLocale } from './tray';

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
  newWindow: string;
  newChat: string;
  openFolder: string;
  aboutApp: string;
  quitApp: string;
  settings: string;
  checkForUpdates: string;
  updateCheckTitle: string;
  updateAvailable: string;
  updateLatest: string;
  updateUnsupported: string;
  updateFailed: string;
  downloadNow: string;
  later: string;
  ok: string;
  help: string;
  documentation: string;
  console: string;
}

const MENU_STRINGS: Record<TrayLocale, MenuStrings> = {
  zh: {
    window: '窗口',
    closeWindow: '关闭窗口',
    file: '文件',
    newWindow: '新建窗口',
    newChat: '新建会话',
    openFolder: '打开文件夹…',
    aboutApp: '关于 Kimi Code',
    quitApp: '退出 Kimi Code',
    settings: '设置…',
    checkForUpdates: '检查更新…',
    updateCheckTitle: '检查更新',
    updateAvailable: '发现新版本 {version},可立即下载更新。',
    updateLatest: '当前已是最新版本。',
    updateUnsupported: '开发版本不支持检查更新。',
    updateFailed: '检查更新失败:{message}',
    downloadNow: '立即下载',
    later: '稍后',
    ok: '好',
    help: '帮助',
    documentation: '文档',
    console: '控制台',
  },
  en: {
    window: 'Window',
    closeWindow: 'Close Window',
    file: 'File',
    newWindow: 'New Window',
    newChat: 'New Chat',
    openFolder: 'Open Folder…',
    aboutApp: 'About Kimi Code',
    quitApp: 'Quit Kimi Code',
    settings: 'Settings…',
    checkForUpdates: 'Check for Updates…',
    updateCheckTitle: 'Check for Updates',
    updateAvailable: 'Version {version} is available.',
    updateLatest: "You're on the latest version.",
    updateUnsupported: 'Update checks are unavailable in development builds.',
    updateFailed: 'Update check failed: {message}',
    downloadNow: 'Download Now',
    later: 'Later',
    ok: 'OK',
    help: 'Help',
    documentation: 'Documentation',
    console: 'Console',
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

// Desktop-pet checkbox state lives here because buildMenu() runs before the
// pet window exists; app.ts seeds it right after createPetWindow(). Passed
// through menuTemplate (defaulted) so the builder stays pure/testable.
let petVisible = false;

/** Mirror the desktop pet's visibility into the View-menu checkbox. */
export function setMenuPetVisible(visible: boolean): void {
  if (visible === petVisible) {
    return;
  }
  petVisible = visible;
  buildMenu();
}

// Menu-triggered update check: unlike the silent scheduled checks (updater.ts
// swallows their failures), a menu click deserves explicit feedback — a native
// dialog for every outcome. A found update offers a Download button; the
// download/progress/install then rides the usual `kimi:update-status` pushes
// (sidebar indicator), which show through even for a version the user skipped
// in the renderer (the skip only hides the `available` state).
async function runMenuUpdateCheck(): Promise<void> {
  const strings = MENU_STRINGS[effectiveMenuLocale()];
  // Parent the dialog to a visible window (macOS hide-on-close may leave it
  // hidden, and a sheet on a hidden window never appears).
  showMainWindow();
  const result = await requestUpdateCheck();
  const win = getMainWindow();
  const show = (opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    win === null || win.isDestroyed() ? dialog.showMessageBox(opts) : dialog.showMessageBox(win, opts);
  if (result.outcome === 'available') {
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
          : strings.updateFailed.replace('{message}', result.message),
    buttons: [strings.ok],
  });
}

// Pure template builder, so tests can cover it without Electron. macOS spells
// the Window submenu out: the `windowMenu` role expands to Minimize / Zoom /
// Bring All to Front with NO Close item — Close lives in the File menu
// instead (macOS convention; putting it in both would bind Cmd+W twice).
// Other platforms keep the role, whose expansion already ends with Close.
export function menuTemplate(
  isMac: boolean,
  locale: TrayLocale,
  pet = false,
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
        accelerator: 'CmdOrCtrl+,',
        click: () => {
          // The dialog lives in the renderer; the window may be hidden
          // (macOS hide-on-close), so surface it before forwarding.
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
        label: '重试连接',
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
      {
        label: '打开服务日志',
        click: () => {
          void shell.openPath(serverLogPath());
        },
      },
      { type: 'separator' },
      isMac ? { role: 'quit', label: strings.quitApp } : { role: 'close' },
    ],
  };

  // New Window / Open Folder are display-only for now (structure first,
  // wiring later): labels + accelerators, no click handlers — activating
  // them is a no-op. New Chat is wired (menuAction → renderer's create
  // entry); its accelerator MUST be wired — a handler-less accelerator would
  // shadow the renderer's own Cmd/Ctrl+N keydown with a no-op. Close is
  // role-driven, so it works out of the box (role default accelerator Cmd+W;
  // closing the window leaves the app resident, recreated via Dock
  // `activate` / the tray).
  const fileMenu: MenuItemConstructorOptions = {
    label: strings.file,
    submenu: [
      { id: 'new-window', label: strings.newWindow, accelerator: 'Shift+CmdOrCtrl+N' },
      {
        id: 'new-chat',
        label: strings.newChat,
        accelerator: 'CmdOrCtrl+N',
        click: () => {
          showMainWindow();
          sendToRenderer(IPC.menuAction, 'new-chat');
        },
      },
      { type: 'separator' },
      { id: 'open-folder', label: strings.openFolder, accelerator: 'CmdOrCtrl+O' },
      { type: 'separator' },
      { role: 'close', label: strings.closeWindow },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: 'View',
    submenu: [
      // Desktop-pet visibility (macOS only — the pet window is darwin-gated).
      // en-only for now; bilingual comes back with the menu-l10n pass (the
      // infrastructure above landed after this label). Electron auto-toggles
      // the checkbox on click; snap it to the actual resulting visibility so
      // the two can never drift apart — and write the module state back too,
      // or the next locale-triggered buildMenu() would re-render the checkbox
      // from the stale value.
      ...(isMac
        ? [
            {
              label: 'Kimi Pet',
              type: 'checkbox' as const,
              checked: pet,
              click: (menuItem: MenuItem) => {
                menuItem.checked = togglePetVisibility();
                petVisible = menuItem.checked;
              },
            },
            { type: 'separator' as const },
          ]
        : []),
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
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

  // TODO(help-menu): add What's New (changelog), Send Feedback, and Start
  // Performance Trace items — tracked in docs/native-todos.md.
  const helpMenu: MenuItemConstructorOptions = {
    label: strings.help,
    submenu: [
      {
        id: 'help-docs',
        label: strings.documentation,
        click: () => {
          void shell.openExternal(HELP_LINKS.docs);
        },
      },
      {
        id: 'help-console',
        label: strings.console,
        click: () => {
          void shell.openExternal(HELP_LINKS.console);
        },
      },
    ],
  };

  return [appMenu, fileMenu, { role: 'editMenu' }, viewMenu, windowMenu, helpMenu];
}

export function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(
      menuTemplate(process.platform === 'darwin', effectiveMenuLocale(), petVisible),
    ),
  );
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
