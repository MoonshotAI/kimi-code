import { app, BrowserWindow } from 'electron';

import { registerRendererScheme, registerRendererProtocol } from './protocol';
import { rendererDistRoot, closeServerHandle } from './connect';
import { createWindow } from './window';
import { buildMenu } from './menu';
import { registerGlobalShortcuts, unregisterGlobalShortcuts } from './shortcuts';
import { registerIpcHandlers } from './ipc';

// --- app lifecycle ------------------------------------------------------------

function main(): void {
  registerRendererScheme();
  registerIpcHandlers();

  app.on('before-quit', () => {
    unregisterGlobalShortcuts();
    closeServerHandle();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    registerRendererProtocol(rendererDistRoot);
    registerGlobalShortcuts();
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });
}

main();
