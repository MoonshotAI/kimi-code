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
import { killAllTerminals } from './terminal';
import { initAutoUpdater } from './updater';
import { parseLaunchArgs } from './jump-list';
import { handleDeepLink, extractDeepLink, registerDeepLinkScheme } from './deep-link';
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

/** Route a second-instance argv (Windows/Linux): a plain relaunch (taskbar
    icon, Jump List) always surfaces the window, but a deep-link launch only
    surfaces it when the URL passes the whitelist — any webpage can fire the
    scheme, so an unknown URL must not steal focus. */
function handleSecondInstanceArgv(argv: readonly string[]): void {
  const deepLink = extractDeepLink(argv);
  if (deepLink !== undefined) {
    handleDeepLink(deepLink, showMainWindow);
    return;
  }
  showMainWindow();
  forwardLaunchArgs(argv);
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

  // OS-level `kimi-code://` deep links (OAuth device-flow completion page).
  // Packaged builds are registered by electron-builder `protocols`; dev needs
  // the explicit call. Delivery: macOS `open-url` below, Windows/Linux argv
  // (second-instance / cold-start routing below).
  registerDeepLinkScheme();

  const pendingSecondInstanceArgv: string[][] = [];
  const pendingDeepLinks: string[] = [];
  let launchRoutingReady = false;
  app.on('second-instance', (_event, argv) => {
    if (!launchRoutingReady) {
      pendingSecondInstanceArgv.push(argv);
      return;
    }
    handleSecondInstanceArgv(argv);
  });

  // macOS fires `open-url` for deep links — including cold starts, where it
  // can arrive before the window exists, so queue until launch routing is up
  // (same pattern as pendingSecondInstanceArgv).
  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!launchRoutingReady) {
      pendingDeepLinks.push(url);
      return;
    }
    handleDeepLink(url, showMainWindow);
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
      killAllTerminals,
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
        // Quit either way: a rejected flush (failed startup, telemetry
        // internals) must not become an unhandled rejection on the quit path.
        void flush.then(
          () => app.quit(),
          () => app.quit(),
        );
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
    for (const argv of pendingSecondInstanceArgv.splice(0)) {
      handleSecondInstanceArgv(argv);
    }
    const deepLinks = pendingDeepLinks.splice(0);
    launchRoutingReady = true;
    for (const url of deepLinks) {
      handleDeepLink(url, showMainWindow);
    }
    app.on('activate', () => {
      // macOS Dock click: un-hide the window (hide-on-close leaves it alive
      // but hidden), or recreate it after a real destroy.
      showMainWindow();
    });
  });
}
