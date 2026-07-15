import { dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions } from 'electron';

import { getMainWindow } from './window';
import { readServerToken } from './connect';
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
  // Token for the renderer's credentialStore (Task 4.5); read in main, never fs in renderer.
  ipcMain.handle(IPC.getServerToken, () => readServerToken());
}
