import { app } from 'electron';

import { registerRendererScheme, registerRendererProtocol } from './protocol';
import { rendererDistRoot, closeServerHandle } from './connect';
import { createWindow, selectSessionInRenderer, showMainWindow } from './window';
import { createTray, destroyTray } from './tray';
import { initDockIcon } from './dock-icon';
import { buildMenu } from './menu';
import { unregisterGlobalShortcuts } from './shortcuts';
import { registerIpcHandlers } from './ipc';
import { initAutoUpdater } from './updater';

// --- app lifecycle ------------------------------------------------------------

export function main(): void {
  registerRendererScheme();
  registerIpcHandlers();

  app.on('before-quit', () => {
    destroyTray();
    unregisterGlobalShortcuts();
    closeServerHandle();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    // Dock icon follows the effective appearance (dark/light tile swap);
    // packaged builds additionally keep the static .icns for Finder etc.
    initDockIcon();
    registerRendererProtocol(rendererDistRoot);
    // No startup global-shortcut registration: the renderer replays the saved
    // binding over IPC on boot (shortcuts.ts is push-driven), so nothing is
    // grabbed before the user's setting is known.
    buildMenu();
    createWindow();
    createTray({
      showMainWindow,
      // Tray attention item click: surface the window, then hand the session
      // id to the renderer (queued while the window bootstraps, window.ts).
      openSession: (sessionId) => {
        showMainWindow();
        selectSessionInRenderer(sessionId);
      },
      quit: () => app.quit(),
    });
    // After the window exists: update statuses push to the renderer. No-op in
    // dev (unpackaged); the packaged app checks on a delay + 4h cadence.
    initAutoUpdater();
    app.on('activate', () => {
      // macOS Dock click: un-hide the window (hide-on-close leaves it alive
      // but hidden), or recreate it after a real destroy.
      showMainWindow();
    });
  });
}
