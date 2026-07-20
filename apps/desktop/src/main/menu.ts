import { app, Menu, shell } from 'electron';
import type { MenuItemConstructorOptions } from 'electron';

import { getMainWindow, createWindow, sendToRenderer } from './window';
import { connect, serverLogPath } from './connect';
import { IPC } from './ipc-channels';
import type { TrayLocale } from './tray';

// --- localization -------------------------------------------------------------
//
// Same pattern as tray.ts: the main process has no i18n runtime, so the menu
// keeps its own tiny string table. The renderer pushes its effective locale
// over `IPC.locale` (ipc.ts → setMenuLocale rebuilds the menu); until then
// the OS language is the fallback.
interface MenuStrings {
  window: string;
  closeWindow: string;
}

const MENU_STRINGS: Record<TrayLocale, MenuStrings> = {
  zh: { window: '窗口', closeWindow: '关闭窗口' },
  en: { window: 'Window', closeWindow: 'Close Window' },
};

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

// Pure template builder, so tests can cover it without Electron. macOS spells
// the Window submenu out: the `windowMenu` role expands to Minimize / Zoom /
// Bring All to Front with NO Close item, leaving Cmd+W bound to nothing — the
// explicit submenu adds Close (role default accelerator Cmd+W; closing the
// window leaves the app resident, recreated via Dock `activate` / the tray).
// Other platforms keep the role, whose expansion already ends with Close.
export function menuTemplate(isMac: boolean, locale: TrayLocale): MenuItemConstructorOptions[] {
  const strings = MENU_STRINGS[locale];
  const appMenu: MenuItemConstructorOptions = {
    label: 'Kimi Code',
    submenu: [
      ...(isMac ? [{ role: 'about' as const }, { type: 'separator' as const }] : []),
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
      isMac ? { role: 'quit' } : { role: 'close' },
    ],
  };

  const windowMenu: MenuItemConstructorOptions = isMac
    ? {
        label: strings.window,
        submenu: [
          { role: 'minimize' },
          { role: 'zoom' },
          { role: 'close', label: strings.closeWindow },
          { type: 'separator' },
          { role: 'front' },
        ],
      }
    : { role: 'windowMenu' };

  return [
    appMenu,
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
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
    },
    windowMenu,
  ];
}

export function buildMenu(): void {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate(menuTemplate(process.platform === 'darwin', effectiveMenuLocale())),
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
