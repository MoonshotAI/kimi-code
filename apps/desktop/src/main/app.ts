import { app } from 'electron';

import { DESKTOP_WINDOWS_APP_ID, DESKTOP_WINDOWS_DEV_APP_ID } from '../shared/identity';
import { log } from './log';
import { registerRendererProtocol } from './protocol';
import { rendererDistRoot, closeServerHandle, shutdownServerTelemetry } from './connect';
import { stopShellEnvProbe } from './shell-env';
import { createWindow, selectSessionInRenderer, sendLaunchAction, showMainWindow } from './window';
import { createTray, destroyTray } from './tray';
import { initDockIcon } from './dock-icon';
import { buildMenu } from './menu';
import { unregisterGlobalShortcuts } from './shortcuts';
import { registerIpcHandlers } from './ipc';
import { initAutoUpdater } from './updater';
import { parseLaunchArgs } from './jump-list';
import { trackDesktopEvent } from './track';
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

  // Quit barrier: the fire-and-forget cleanup above lets the process die
  // before the telemetry flush finishes, losing `exit` and the buffered tail
  // (the disk fallback only engages after a *completed* flush attempt fails).
  // Hold quit only for telemetry.shutdown — it caps itself at 3s, and the
  // full server close is exactly the hang source this ordering avoids.
  let telemetryFlushArmed = true;
  app.on('before-quit', (event) => {
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
    if (telemetryFlushArmed) {
      const flush = shutdownServerTelemetry();
      if (flush !== null) {
        telemetryFlushArmed = false;
        event.preventDefault();
        void flush.finally(() => {
          app.quit();
        });
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
    const launch = parseLaunchArgs(process.argv);
    trackDesktopEvent('app_launched', {
      launch_intent: launch.newChat || launch.workspace !== undefined ? 'jump_list' : 'normal',
    });
    trackDesktopEvent('startup_timing', {
      phase: 'main_ready',
      duration_ms: Math.round(process.uptime() * 1000),
    });
    app.on('child-process-gone', (_event, details) => {
      // Chromium recycles the GPU process in normal operation (clean-exit) —
      // that is not a crash.
      if (details.type === 'GPU' && details.reason !== 'clean-exit') {
        trackDesktopEvent('app_crashed', {
          process: 'gpu',
          kind: details.reason,
          app_uptime_ms: Math.round(process.uptime() * 1000),
        });
      }
    });
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
