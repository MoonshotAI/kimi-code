import { app } from 'electron';

import { DESKTOP_WINDOWS_APP_ID, DESKTOP_WINDOWS_DEV_APP_ID } from '../shared/identity';
import { log } from './log';
import { IPC } from './ipc-channels';
import { registerRendererProtocol } from './protocol';
import { rendererDistRoot, closeServerHandle, shutdownServerTelemetry } from './connect';
import { stopShellEnvProbe } from './shell-env';
import { createWindow, selectSessionInRenderer, sendLaunchAction, sendToRenderer, showMainWindow } from './window';
import { createTray, destroyTray } from './tray';
import { initDockIcon } from './dock-icon';
import { buildMenu } from './menu';
import { unregisterGlobalShortcuts } from './shortcuts';
import { registerIpcHandlers } from './ipc';
import { killAllTerminals } from './terminal';
import { killActiveBuild, sweepStalePreviews } from './pr-preview';
import { initAutoUpdater, setUpdateController } from './updater';
import { initCanaryGithubUpdater } from './canary-updater';
import { isCanaryVersion } from './release-channel';
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

/** Wake the renderer's OAuth login poll after a validated auth deep link: the
    authorization completion page re-opened the app, so the flow snapshot is
    very likely ready — poll now instead of waiting out the current interval.
    No payload; the event is a pure wake signal. A lost send is harmless: it
    only happens while no renderer exists (cold start), where no login flow
    can be waiting anyway. */
function notifyDeepLinkAuth(): void {
  sendToRenderer(IPC.deepLinkAuth, undefined);
}

/** Route a second-instance argv (Windows/Linux): a plain relaunch (taskbar
    icon, Jump List) always surfaces the window, but a deep-link launch only
    surfaces it when the URL passes the whitelist — any webpage can fire the
    scheme, so an unknown URL must not steal focus. */
function handleSecondInstanceArgv(argv: readonly string[]): void {
  const deepLink = extractDeepLink(argv);
  if (deepLink !== undefined) {
    handleDeepLink(deepLink, showMainWindow, notifyDeepLinkAuth);
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
    handleDeepLink(url, showMainWindow, notifyDeepLinkAuth);
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
      killActiveBuild,
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
    // Dock icon applies the user's tile preference (seeded from ui-state.json
    // so the first tile is right); packaged builds additionally keep the
    // static .icns for Finder etc.
    initDockIcon();
    registerRendererProtocol(rendererDistRoot);
    // Boot-time PR-preview hygiene: sweep worktrees previous runs left
    // behind (fire-and-forget; see pr-preview.ts sweepStalePreviews).
    try {
      sweepStalePreviews();
    } catch (error) {
      log.error('[kimi-desktop] PR preview boot sweep failed', error);
    }
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
    // After the window exists: update statuses push to the renderer（同一
    // `kimi:update-status` 通道）。分流：canary 构建走 GitHub 通道
    //（canary-updater.ts，controller 经 setUpdateController 注入 updater
    // 模块的共享实例），stable 走 CDN；dev/unpackaged 两边都是 no-op。
    if (isCanaryVersion(app.getVersion())) {
      initCanaryGithubUpdater(setUpdateController);
    } else {
      initAutoUpdater();
    }
    // Launch flags from the very first invocation (Jump List item click).
    forwardLaunchArgs(process.argv);
    for (const argv of pendingSecondInstanceArgv.splice(0)) {
      handleSecondInstanceArgv(argv);
    }
    const deepLinks = pendingDeepLinks.splice(0);
    launchRoutingReady = true;
    for (const url of deepLinks) {
      handleDeepLink(url, showMainWindow, notifyDeepLinkAuth);
    }
    app.on('activate', () => {
      // macOS Dock click: un-hide the window (hide-on-close leaves it alive
      // but hidden), or recreate it after a real destroy.
      showMainWindow();
    });
  });
}
