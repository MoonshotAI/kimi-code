import { app, Menu, shell } from 'electron';
import type { MenuItem, MenuItemConstructorOptions } from 'electron';

import { getMainWindow, createWindow, sendToRenderer } from './window';
import { connect, serverLogPath } from './connect';
import { togglePetVisibility } from './pet';
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

// Pure template builder, so tests can cover it without Electron. macOS spells
// the Window submenu out: the `windowMenu` role expands to Minimize / Zoom /
// Bring All to Front with NO Close item, leaving Cmd+W bound to nothing — the
// explicit submenu adds Close (role default accelerator Cmd+W; closing the
// window leaves the app resident, recreated via Dock `activate` / the tray).
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
          { role: 'close', label: strings.closeWindow },
          { type: 'separator' },
          { role: 'front' },
        ],
      }
    : { role: 'windowMenu' };

  return [appMenu, { role: 'editMenu' }, viewMenu, windowMenu];
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
