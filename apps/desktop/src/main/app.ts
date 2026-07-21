import { join } from 'node:path';

import { app, nativeImage } from 'electron';

import { registerRendererScheme, registerRendererProtocol } from './protocol';
import { rendererDistRoot, closeServerHandle } from './connect';
import { createWindow, selectSessionInRenderer, showMainWindow } from './window';
import { createPetWindow, isPetVisible } from './pet';
import { createTray, destroyTray } from './tray';
import { buildMenu, setMenuPetVisible } from './menu';
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
    // Dev-only: an unpackaged run shows Electron's default Dock icon. Point it
    // at the packaging icon so `pnpm dev:desktop` matches the shipped app;
    // packaged builds get the icon from electron-builder instead.
    if (!app.isPackaged && process.platform === 'darwin') {
      app.dock?.setIcon(nativeImage.createFromPath(join(app.getAppPath(), 'build', 'icon.png')));
    }
    registerRendererProtocol(rendererDistRoot);
    // No startup global-shortcut registration: the renderer replays the saved
    // binding over IPC on boot (shortcuts.ts is push-driven), so nothing is
    // grabbed before the user's setting is known.
    buildMenu();
    createWindow();
    // Desktop pet: macOS only for now. Lives independently of the main window
    // (keeps floating when the main window closes), dies with the app.
    if (process.platform === 'darwin') {
      createPetWindow();
      // Seed the View-menu pet checkbox with the persisted initial
      // visibility (buildMenu ran before the pet window existed).
      setMenuPetVisible(isPetVisible());
    }
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
