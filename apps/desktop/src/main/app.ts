import { app } from 'electron';

import { DESKTOP_WINDOWS_APP_ID, DESKTOP_WINDOWS_DEV_APP_ID } from '../shared/identity';
import { log } from './log';
import { registerRendererProtocol } from './protocol';
import { rendererDistRoot, closeServerHandle } from './connect';
import { stopShellEnvProbe } from './shell-env';
import { createWindow, selectSessionInRenderer, sendLaunchAction, showMainWindow } from './window';
import { createTray, destroyTray } from './tray';
import { initDockIcon } from './dock-icon';
import { buildMenu } from './menu';
import { unregisterGlobalShortcuts } from './shortcuts';
import { registerIpcHandlers } from './ipc';
import { initAutoUpdater } from './updater';
import { parseLaunchArgs } from './jump-list';
import { finalizeWindowLifecycle } from './window-lifecycle';

// --- app lifecycle ------------------------------------------------------------

/** Route the launch flags (Jump List items, CLI relaunch) into the renderer:
    new-chat opens a draft, open-workspace selects (or registers) the root. */
function forwardLaunchArgs(argv: readonly string[]): void {
  const launch = parseLaunchArgs(argv);
  if (launch.newChat) {
    sendLaunchAction({ action: 'new-chat' });
  }
  if (launch.workspace !== undefined) {
    sendLaunchAction({ action: 'open-workspace', root: launch.workspace });
  }
}

export function main(): void {
  // Windows Toast notifications are grouped and activated by AppUserModelID.
  // Keep this exactly aligned with electron-builder.config.cjs `appId`, whose
  // NSIS shortcut supplies the matching Start Menu identity in packaged builds.
  // Dev needs its own identity so Windows never associates the installed window
  // with an Electron shortcut created by an unpackaged launch.
  if (process.platform === 'win32') {
    app.setAppUserModelId(
      app.isPackaged ? DESKTOP_WINDOWS_APP_ID : DESKTOP_WINDOWS_DEV_APP_ID,
    );
  }

  // Packaged launches stay single-instance. Dev intentionally skips this lock
  // because it shares userData with the installed app and must run alongside it.
  if (app.isPackaged && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  const pendingSecondInstanceArgv: string[][] = [];
  let launchRoutingReady = false;
  app.on('second-instance', (_event, argv) => {
    if (!launchRoutingReady) {
      pendingSecondInstanceArgv.push(argv);
      return;
    }
    showMainWindow();
    forwardLaunchArgs(argv);
  });

  registerIpcHandlers();

  app.on('before-quit', () => {
    log.info('[kimi-desktop] quitting');
    for (const cleanup of [
      finalizeWindowLifecycle,
      stopShellEnvProbe,
      destroyTray,
      unregisterGlobalShortcuts,
      closeServerHandle,
    ]) {
      try {
        void Promise.resolve(cleanup()).catch((error: unknown) => {
          log.error('[kimi-desktop] shutdown step failed', error);
        });
      } catch (error) {
        log.error('[kimi-desktop] shutdown step failed', error);
      }
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    log.info(
      `[kimi-desktop] app ready (version=${app.getVersion()} platform=${process.platform} arch=${process.arch} packaged=${app.isPackaged})`,
    );
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
    // Launch flags from the very first invocation (Jump List item click).
    forwardLaunchArgs(process.argv);
    const hadPendingSecondInstance = pendingSecondInstanceArgv.length > 0;
    for (const argv of pendingSecondInstanceArgv.splice(0)) {
      forwardLaunchArgs(argv);
    }
    launchRoutingReady = true;
    if (hadPendingSecondInstance) showMainWindow();
    app.on('activate', () => {
      // macOS Dock click: un-hide the window (hide-on-close leaves it alive
      // but hidden), or recreate it after a real destroy.
      showMainWindow();
    });
  });
}
