import { join } from 'node:path';

import { app, BrowserWindow, nativeImage } from 'electron';
import type { Tray } from 'electron';

import { registerRendererScheme, registerRendererProtocol } from './protocol';
import { rendererDistRoot, closeServerHandle } from './connect';
import { createWindow } from './window';
import { createTray } from './tray';
import { buildMenu } from './menu';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './shortcuts';
import { registerIpcHandlers } from './ipc';

// --- app lifecycle ------------------------------------------------------------

// A Tray with no live JS reference gets garbage-collected and its OS icon
// silently disappears — keep it module-scoped for the app's lifetime.
let tray: Tray | null = null;

function showMainWindow(): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win) {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  } else {
    createWindow();
  }
}

export function main(): void {
  registerRendererScheme();
  registerIpcHandlers();

  app.on('before-quit', () => {
    tray?.destroy();
    tray = null;
    unregisterGlobalShortcuts();
    closeServerHandle();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    // Dev-only: an unpackaged run shows Electron's default Dock icon. Point it
    // at the packaging icon so `pnpm dev:desktop` matches the shipped app;
    // packaged builds get the icon from electron-builder instead.
    if (!app.isPackaged && process.platform === 'darwin') {
      app.dock?.setIcon(nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png')));
    }
    registerRendererProtocol(rendererDistRoot);
    registerGlobalShortcuts();
    buildMenu();
    createWindow();
    tray = createTray({ showMainWindow, quit: () => app.quit() });
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}
