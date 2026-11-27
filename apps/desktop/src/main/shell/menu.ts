import { app, dialog, Menu, shell, webContents } from 'electron';
import type { BrowserWindow, MenuItemConstructorOptions } from 'electron';

import { createWindow, showMainWindow, usesCustomTitleBar, devToolsMode } from '../window/main-window';
import { getMainWindow, sendToRenderer } from '../window/window-registry';
import { getTerminalMenuFocus, onTerminalMenuFocus } from './terminal-menu-focus';
import { connect } from '../server/connect';
import { getTraceRecorder } from '../diagnostics/trace';
import { exportDiagnostics, openLogsFolder } from '../diagnostics/diagnostics-export';
import { reportExternalLinkFailure } from './external-links';
import { refreshServerRegion, serverRegionProfile, whenServerRegionSource } from '../server/region';
import { getUpdateAutoDownload, getUpdateStatus, requestUpdateCheck, requestUpdateDownload, requestUpdateInstall, UPDATE_CHECK_TIMED_OUT } from '../release/updater';
import { trackDesktopEvent } from '../diagnostics/track';
import { isLinuxNativeTitleBar } from '../app/ui-state';
import { IPC } from '../ipc/ipc-channels';
import type { TrayLocale } from './tray';
import type { WindowsMenuId } from '../ipc/ipc-channels';

function dispatchEditingCommand(command: 'undo' | 'redo' | 'select-all'): void {
  const focused = webContents.getFocusedWebContents();
  if (focused !== null && !focused.isDestroyed() && focused !== getMainWindow()?.webContents) {
    if (command === 'select-all') focused.selectAll();
    else if (command === 'undo') focused.undo();
    else focused.redo();
    return;
  }
  sendToRenderer(IPC.menuAction, command);
}

interface MenuStrings {
  window: string;
  closeWindow: string;
  closeTab: string;
  file: string;
  edit: string;
  undo: string;
  redo: string;
  cut: string;
  copy: string;
  paste: string;
  pasteAndMatchStyle: string;
  delete: string;
  selectAll: string;
  substitutions: string;
  speech: string;
  view: string;
  newChat: string;
  newBrowserTab: string;
  browserAddress: string;
  reloadPage: string;
  forceReload: string;
  toggleDevTools: string;
  resetZoom: string;
  zoomIn: string;
  zoomOut: string;
  togglefullscreen: string;
  openFolder: string;
  toggleTerminal: string;
  newTerminalTab: string;
  aboutApp: string;
  services: string;
  hideApp: string;
  hideOthers: string;
  showAll: string;
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
  feedback: string;
  console: string;
  performanceTrace: string;
  stopPerformanceTrace: string;
  traceFailed: string;
  traceKeptAt: string;
  exportDiagnostics: string;
  openLogsFolder: string;
}

const MENU_STRINGS: Record<TrayLocale, MenuStrings> = {
  zh: {
    window: '窗口',
    closeWindow: '关闭窗口',
    closeTab: '关闭标签页',
    file: '文件',
    edit: '编辑',
    undo: '撤销',
    redo: '重做',
    cut: '剪切',
    copy: '拷贝',
    paste: '粘贴',
    pasteAndMatchStyle: '粘贴并匹配样式',
    delete: '删除',
    selectAll: '全选',
    substitutions: '替换',
    speech: '语音',
    view: '视图',
    newChat: '新建会话',

    newBrowserTab: '新建网页标签页',
    browserAddress: '转到地址栏',
    reloadPage: '刷新',
    forceReload: '强制刷新',
    toggleDevTools: '开发者工具',
    resetZoom: '实际大小',
    zoomIn: '放大',
    zoomOut: '缩小',
    togglefullscreen: '切换全屏',
    openFolder: '打开文件夹…',
    toggleTerminal: '切换终端',
    newTerminalTab: '新建终端',
    aboutApp: '关于 Kimi Code',
    services: '服务',
    hideApp: '隐藏 Kimi Code',
    hideOthers: '隐藏其他',
    showAll: '全部显示',
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
    documentation: '使用文档',
    feedback: '反馈',
    console: '控制台',
    performanceTrace: '性能录制',
    stopPerformanceTrace: '停止性能录制',
    traceFailed: '性能录制失败:{message}',
    traceKeptAt: '录制文件已保留在 {path}',
    exportDiagnostics: '导出诊断信息…',
    openLogsFolder: '打开日志文件夹',
  },
  en: {
    window: 'Window',
    closeWindow: 'Close Window',
    closeTab: 'Close Tab',
    file: 'File',
    edit: 'Edit',
    undo: 'Undo',
    redo: 'Redo',
    cut: 'Cut',
    copy: 'Copy',
    paste: 'Paste',
    pasteAndMatchStyle: 'Paste and Match Style',
    delete: 'Delete',
    selectAll: 'Select All',
    substitutions: 'Substitutions',
    speech: 'Speech',
    view: 'View',
    newChat: 'New Session',

    newBrowserTab: 'New Browser Tab',
    browserAddress: 'Focus Browser Address',
    reloadPage: 'Reload Page',
    forceReload: 'Force Reload',
    toggleDevTools: 'Toggle Developer Tools',
    resetZoom: 'Actual Size',
    zoomIn: 'Zoom In',
    zoomOut: 'Zoom Out',
    togglefullscreen: 'Toggle Full Screen',
    openFolder: 'Open Folder…',
    toggleTerminal: 'Toggle Terminal',
    newTerminalTab: 'New Terminal Tab',
    aboutApp: 'About Kimi Code',
    services: 'Services',
    hideApp: 'Hide Kimi Code',
    hideOthers: 'Hide Others',
    showAll: 'Show All',
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
    feedback: 'Feedback',
    console: 'Console',
    performanceTrace: 'Performance Trace',
    stopPerformanceTrace: 'Stop Performance Trace',
    traceFailed: 'Performance trace failed: {message}',
    traceKeptAt: 'Trace file kept at {path}',
    exportDiagnostics: 'Export Diagnostics…',
    openLogsFolder: 'Open Logs Folder',
  },
};

function helpLinks(): { docs: string; console: string } {
  const { siteBase } = serverRegionProfile();
  return {
    docs: `${siteBase}/code/docs/`,
    console: `${siteBase}/code/console?from=kimi_code_desktop`,
  };
}

const HELP_MENU_REGION_BUDGET_MS = 2_000;

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

const MENU_SHORTCUT_DEFAULTS: Record<string, string | null> = {
  openSettings: 'mod+,',
  newSession: 'mod+n',
  closeSessionView: 'mod+w',
  openFolder: 'mod+o',
  toggleTerminal: 'ctrl+`',
};

let menuShortcutOverrides: Record<string, string | null> = {};

function menuBinding(overrides: Record<string, string | null>, id: string): string | null {
  if (id in overrides) return overrides[id] ?? null;
  return MENU_SHORTCUT_DEFAULTS[id] ?? null;
}

export function setMenuShortcuts(bindings: Record<string, string | null>): void {
  menuShortcutOverrides = { ...bindings };
  buildMenu();
}

let recordingSuspended = false;

export type MenuSuspension = 'recording' | 'terminal' | false;

function currentSuspension(): MenuSuspension {
  if (recordingSuspended) return 'recording';
  if (getTerminalMenuFocus()) return 'terminal';
  return false;
}

export function setMenuSuspended(suspended: boolean): void {
  if (suspended === recordingSuspended) {
    return;
  }
  recordingSuspended = suspended;
  buildMenu();
}

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

const ACCELERATOR_PUNCT = new Set([',', '.', '/', '\\', ';', '[', ']', '-', '=', '`']);

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

async function runMenuUpdateCheck(): Promise<void> {
  trackDesktopEvent('menu_action', { action: 'check-for-updates' });
  const strings = MENU_STRINGS[effectiveMenuLocale()];
  showMainWindow();
  const result = await requestUpdateCheck();
  const win = getMainWindow();
  const show = (opts: Electron.MessageBoxOptions): Promise<Electron.MessageBoxReturnValue> =>
    win === null || win.isDestroyed() ? dialog.showMessageBox(opts) : dialog.showMessageBox(win, opts);
  if (result.outcome === 'available') {
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

async function runTraceToggle(): Promise<void> {
  const result = await getTraceRecorder().toggle();
  buildMenu();
  if (result.status !== 'error') {
    return;
  }
  const strings = MENU_STRINGS[effectiveMenuLocale()];
  showMainWindow();
  const win = getMainWindow();
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
      ...(isMac
        ? [
            { role: 'services' as const, label: strings.services },
            { type: 'separator' as const },
            { role: 'hide' as const, label: strings.hideApp },
            { role: 'hideOthers' as const, label: strings.hideOthers },
            { role: 'unhide' as const, label: strings.showAll },
            { type: 'separator' as const },
          ]
        : []),
      { role: 'quit', label: strings.quitApp },
    ],
  };

  const fileMenu: MenuItemConstructorOptions = {
    label: strings.file,
    submenu: [
      { id: 'new-terminal-tab', label: strings.newTerminalTab, click: () => sendToRenderer(IPC.menuAction, 'new-terminal-tab') },
      { id: 'browser-new-tab', label: strings.newBrowserTab, accelerator: 'CommandOrControl+T', click: () => sendToRenderer(IPC.menuAction, 'browser-new-tab') },
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
      {
        id: 'close-session-view',
        label: strings.closeWindow,
        accelerator: bindingToAccelerator(menuBinding(shortcutOverrides, 'closeSessionView')),
        click: (_item, focusedWindow) => {
          if (focusedWindow == null) {
            if (process.platform === 'darwin') Menu.sendActionToFirstResponder('performClose:');
            return;
          }
          if (focusedWindow !== getMainWindow()) {
            focusedWindow.close();
            return;
          }
          sendToRenderer(IPC.menuAction, 'close-session-view');
        },
      },
    ],
  };

  const viewMenu: MenuItemConstructorOptions = {
    label: strings.view,
    submenu: [
      { id: 'browser-reload', label: strings.reloadPage, accelerator: 'CommandOrControl+R', click: (_item, focused) => {
        if (focused && focused !== getMainWindow() && 'webContents' in focused) (focused as BrowserWindow).webContents.reload();
        else sendToRenderer(IPC.menuAction, 'browser-reload');
      } },
      { id: 'browser-focus-address', label: strings.browserAddress, accelerator: 'CommandOrControl+L', click: () => sendToRenderer(IPC.menuAction, 'browser-focus-address') },
      { role: 'forceReload', label: strings.forceReload },
      {
        id: 'toggle-dev-tools',
        label: strings.toggleDevTools,
        accelerator: isMac ? 'Alt+Command+I' : 'Ctrl+Shift+I',
        click: () => {
          const win = getMainWindow();
          if (win === null || win.isDestroyed()) return;
          const host = win.webContents;
          if (host.isDevToolsOpened()) host.closeDevTools();
          else host.openDevTools({ mode: devToolsMode() });
        },
      },
      { type: 'separator' },
      { role: 'resetZoom', label: strings.resetZoom },
      { role: 'zoomIn', label: strings.zoomIn },
      { role: 'zoomOut', label: strings.zoomOut },
      { type: 'separator' },
      {
        id: 'toggle-terminal',
        label: strings.toggleTerminal,
        accelerator: bindingToAccelerator(menuBinding(shortcutOverrides, 'toggleTerminal')),
        click: () => {
          showMainWindow();
          sendToRenderer(IPC.menuAction, 'toggle-terminal');
        },
      },
      { type: 'separator' },
      { role: 'togglefullscreen', label: strings.togglefullscreen },
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
    : {
        label: strings.window,
        submenu: [{ role: 'minimize' }, { role: 'zoom' }],
      };

  const editMenu: MenuItemConstructorOptions = {
    id: 'edit-menu',
    label: strings.edit,
    submenu: [
      {
        id: 'undo',
        label: strings.undo,
        accelerator: 'CommandOrControl+Z',
        click: () => {
          dispatchEditingCommand('undo');
        },
      },
      {
        id: 'redo',
        label: strings.redo,
        accelerator: isMac ? 'Shift+CommandOrControl+Z' : 'Control+Y',
        click: () => {
          dispatchEditingCommand('redo');
        },
      },
      { type: 'separator' },
      { role: 'cut', label: strings.cut },
      { role: 'copy', label: strings.copy },
      { role: 'paste', label: strings.paste },
      ...(isMac ? [{ role: 'pasteAndMatchStyle' as const, label: strings.pasteAndMatchStyle }] : []),
      { role: 'delete', label: strings.delete },
      ...(isMac ? [] : [{ type: 'separator' as const }]),
      {
        id: 'select-all',
        label: strings.selectAll,
        accelerator: 'CommandOrControl+A',
        click: () => {
          dispatchEditingCommand('select-all');
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

  const helpMenu: MenuItemConstructorOptions = {
    label: strings.help,
    submenu: [
      {
        id: 'help-docs',
        label: strings.documentation,
        click: () => {
          trackDesktopEvent('menu_action', { action: 'help-docs' });
          let url = helpLinks().docs;
          void whenServerRegionSource(HELP_MENU_REGION_BUDGET_MS)
            .then(() => refreshServerRegion(HELP_MENU_REGION_BUDGET_MS))
            .then(() => {
              url = helpLinks().docs;
              return shell.openExternal(url);
            })
            .catch((error: unknown) => reportExternalLinkFailure(url, error));
        },
      },
      {
        id: 'open-feedback',
        label: strings.feedback,
        click: () => {
          showMainWindow();
          sendToRenderer(IPC.menuAction, 'open-feedback');
        },
      },
      {
        id: 'help-console',
        label: strings.console,
        click: () => {
          trackDesktopEvent('menu_action', { action: 'help-console' });
          let url = helpLinks().console;
          void whenServerRegionSource(HELP_MENU_REGION_BUDGET_MS)
            .then(() => refreshServerRegion(HELP_MENU_REGION_BUDGET_MS))
            .then(() => {
              url = helpLinks().console;
              return shell.openExternal(url);
            })
            .catch((error: unknown) => reportExternalLinkFailure(url, error));
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
      { type: 'separator' },
      {
        id: 'export-diagnostics',
        label: strings.exportDiagnostics,
        click: () => {
          trackDesktopEvent('menu_action', { action: 'export-diagnostics' });
          void exportDiagnostics(locale);
        },
      },
      {
        id: 'open-logs-folder',
        label: strings.openLogsFolder,
        click: () => {
          trackDesktopEvent('menu_action', { action: 'open-logs-folder' });
          void openLogsFolder();
        },
      },
    ],
  };

  const template: MenuItemConstructorOptions[] = [appMenu, fileMenu, editMenu, viewMenu, windowMenu, helpMenu];
  if (!suspension) return template;
  if (suspension === 'recording') {
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
  const trimSeparators = (items: MenuItemConstructorOptions[]) => {
    const result = [...items];
    while (result[0]?.type === 'separator') result.shift();
    while (result.at(-1)?.type === 'separator') result.pop();
    return result;
  };
  const strings = MENU_STRINGS[locale];
  const viewItems = ((view.submenu ?? []) as MenuItemConstructorOptions[]).filter(
    (item) => isDev || (item.role !== 'forceReload' && item.id !== 'toggle-dev-tools'),
  );
  const fileSubmenu = trimSeparators([
    ...fileItems,
    { type: 'separator' },
    byId(appItems, 'open-settings') as MenuItemConstructorOptions,
    { type: 'separator' },
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
  if (!usesCustomTitleBar(process.platform, isLinuxNativeTitleBar())) {
    return Promise.resolve({ opened: false });
  }
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
  const customTitleBar = usesCustomTitleBar(process.platform, isLinuxNativeTitleBar());
  applicationMenu = Menu.buildFromTemplate(
    customTitleBar
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
  if (customTitleBar) {
    getMainWindow()?.setMenuBarVisibility(false);
  }
}

onTerminalMenuFocus(() => buildMenu());

export function setMenuLocale(locale: TrayLocale): void {
  if (locale === menuLocale) {
    return;
  }
  menuLocale = locale;
  buildMenu();
}
