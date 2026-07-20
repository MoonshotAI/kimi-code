import { dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';

import { getMainWindow, showMainWindow } from './window';
import { readServerToken } from './connect';
import { listAvailableOpenInApps, openInApp } from './open-in';
import { getUpdateStatus, requestUpdateCheck, requestUpdateDownload, requestUpdateInstall } from './updater';
import { asTrayAttention, setTrayAttention, setTrayLocale } from './tray';
import { setMenuLocale } from './menu';
import { IPC, type ColorScheme } from './ipc-channels';

function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

export function registerIpcHandlers(): void {
  ipcMain.on(IPC.theme, (_event, scheme: unknown) => {
    if (isColorScheme(scheme)) {
      nativeTheme.themeSource = scheme;
    }
  });
  ipcMain.handle(IPC.openExternal, (_event, url: string) => shell.openExternal(url));
  // File dialogs: the renderer asks (whitelisted `showOpenDialog`/`showSaveDialog`),
  // the main process opens the native dialog and returns the user's selection.
  ipcMain.handle(IPC.dialogOpen, (_event, opts: OpenDialogOptions = {}) => {
    const win = getMainWindow();
    return win === null || win.isDestroyed()
      ? dialog.showOpenDialog(opts)
      : dialog.showOpenDialog(win, opts);
  });
  ipcMain.handle(IPC.dialogSave, (_event, opts: SaveDialogOptions = {}) => {
    const win = getMainWindow();
    return win === null || win.isDestroyed()
      ? dialog.showSaveDialog(opts)
      : dialog.showSaveDialog(win, opts);
  });
  // "Open workspace in <app>": the main process owns both the installed-app
  // catalog and the actual launch (open-in.ts); results are forwarded verbatim.
  ipcMain.handle(IPC.openInList, () => listAvailableOpenInApps());
  ipcMain.handle(IPC.openInApp, (_event, appId: unknown, path: unknown) => {
    if (typeof appId !== 'string' || typeof path !== 'string' || path.trim() === '') {
      return { ok: false as const, error: 'invalid open-in arguments' };
    }
    return openInApp(appId, path);
  });
  // Token for the renderer's credentialStore (Task 4.5); read in main, never fs in renderer.
  ipcMain.handle(IPC.getServerToken, () => readServerToken());
  // Initial fullscreen state for the renderer (transitions are pushed over
  // `IPC.fullscreenChanged` by window.ts); needed when the page (re)loads while
  // the window is already full-screen.
  ipcMain.handle(IPC.isFullscreen, () => {
    const win = getMainWindow();
    return win !== null && !win.isDestroyed() && win.isFullScreen();
  });
  // Auto-update: the sidebar banner reads the current status once (reload
  // recovery — transitions stream over IPC.updateStatus) and fires the two
  // user actions. No-ops in dev (see updater.ts).
  ipcMain.handle(IPC.updateGetStatus, () => getUpdateStatus());
  // Manual "check for updates" (settings → advanced): resolves with the
  // outcome so the renderer can show inline feedback; 'unsupported' in dev.
  ipcMain.handle(IPC.updateCheck, () => requestUpdateCheck());
  ipcMain.handle(IPC.updateDownload, () => requestUpdateDownload());
  ipcMain.handle(IPC.updateInstall, () => requestUpdateInstall());
  // Tray attention badge: the renderer pushes {unread, approvals, questions}
  // totals whenever they change (useTrayAttention.ts); tray.ts renders them as
  // the macOS menu-bar count + tooltip/menu breakdown. Malformed payloads drop.
  ipcMain.on(IPC.trayAttention, (_event, payload: unknown) => {
    const attention = asTrayAttention(payload);
    if (attention !== null) {
      setTrayAttention(attention);
    }
  });
  // The renderer's in-app language drives the main-process strings (tray
  // labels/tooltip, application menu). Until the first push the OS language
  // is the fallback.
  ipcMain.on(IPC.locale, (_event, locale: unknown) => {
    if (locale === 'en' || locale === 'zh') {
      setTrayLocale(locale);
      setMenuLocale(locale);
    }
  });
  // Renderer-initiated "bring the window back" (notification clicks): with
  // macOS hide-on-close the window may be alive but hidden, and the web
  // window.focus() can't un-hide it — only the main process can.
  ipcMain.on(IPC.showWindow, () => {
    showMainWindow();
  });
}
