import { flushBrowserRecords } from '../browser/browser-data';
import { app, nativeTheme } from 'electron';

import { log, logStartup } from '../diagnostics/log';
import { installAppDiagnostics } from '../diagnostics/collector';
import { exportDiagnostics, openLogsFolder } from '../diagnostics/diagnostics-export';
import { markQuitStarted, startLaunchTracking } from './launch-state';
import { installUncaughtErrorNotice } from './uncaught-error-notice';
import { IPC } from '../ipc/ipc-channels';
import { registerRendererProtocol } from './protocol';
import { connect, rendererDistRoot, closeServerHandle, shutdownServerTelemetry } from '../server/connect';
import { prepareSessionContinue } from '../server/session-continue';
import { screenLocale, type ScreenAction } from './screens';
import { getColorScheme } from './ui-state';
import { stopShellEnvProbe } from '../system/shell-env';
import { createWindow, reportIfStillRunning, selectSessionInRenderer, sendLaunchAction, setScreenActionHandler, showMainWindow, showStartupScreen } from '../window/main-window';
import { cancelQuitting, getMainWindow, isQuitConfirmSkipped, markQuitting, sendToRenderer, type MainWindow } from '../window/window-registry';
import { createTray, destroyTray } from '../shell/tray';
import { initDockIcon } from '../shell/dock-icon';
import { e2eWindowMode } from './e2e-mode';
import { buildMenu } from '../shell/menu';
import { unregisterGlobalShortcuts } from '../shell/shortcuts';
import { registerIpcHandlers } from '../ipc/register';
import { destroyBrowserView } from '../browser/browser-view';
import { killAllTerminals, waitForTerminalExits } from '../terminal/manager';
import { scheduleBrowserReceiptPruning } from '../browser/browser-receipts';
import { initScreenshot, shutdownScreenshot } from '../screenshot/controller';
import { initAutoUpdater } from '../release/updater';
import { isCanaryVersion, isPreviewVersion, windowsAppId } from '../release/release-channel';
import { parseLaunchArgs } from '../shell/jump-list';
import { handleDeepLink, extractDeepLink, registerDeepLinkScheme } from './deep-link';
import { trackDesktopEvent } from '../diagnostics/track';
import { finalizeWindowLifecycle } from '../window/window-lifecycle';
import { confirmUpdateRestart, shouldBlockQuit } from './quit-confirm';
import { applyPreventSleepOnLaunch, restorePreventSleepBeforeQuit } from '../system/prevent-lid-sleep';

const TERMINAL_EXIT_WAIT_MS = 5_000;

function forwardLaunchArgs(argv: readonly string[]): void {
  const launch = parseLaunchArgs(argv);
  if (launch.newChat) {
    sendLaunchAction({ action: 'new-chat' });
  }
  if (launch.workspace !== undefined) {
    sendLaunchAction({ action: 'open-workspace', root: launch.workspace });
  }
}

function notifyDeepLinkAuth(): void {
  sendToRenderer(IPC.deepLinkAuth, undefined);
}

function openDeepLinkWorkspace(root: string): void {
  sendLaunchAction({ action: 'open-workspace', root, newChat: true });
}

function openDeepLinkSession(sessionId: string): void {
  sendLaunchAction({ action: 'open-session', sessionId });
}

function routeDeepLink(url: string): void {
  handleDeepLink(url, showMainWindow, notifyDeepLinkAuth, openDeepLinkWorkspace, openDeepLinkSession);
}

function handleSecondInstanceArgv(argv: readonly string[]): void {
  const deepLink = extractDeepLink(argv);
  if (deepLink !== undefined) {
    routeDeepLink(deepLink);
    return;
  }
  showMainWindow();
  forwardLaunchArgs(argv);
}

let retryingConnection = false;

export function runScreenAction(action: ScreenAction, win: MainWindow): void {
  switch (action) {
    case 'retry-connection':
      if (retryingConnection) return;
      retryingConnection = true;
      showStartupScreen(win);
      void connect(win).finally(() => {
        retryingConnection = false;
      });
      return;
    case 'export-diagnostics':
      void exportDiagnostics(screenLocale());
      return;
    case 'open-logs-folder':
      void openLogsFolder();
      return;
    case 'restart-app':
      markQuitting();
      app.relaunch();
      app.quit();
      return;
  }
}

export function main(): void {
  if (process.platform === 'win32') {
    app.setAppUserModelId(
      windowsAppId(app.isPackaged, app.getVersion()),
    );
  }

  if (app.isPackaged && !app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }

  startLaunchTracking();
  installUncaughtErrorNotice();
  setScreenActionHandler(runScreenAction);

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

  app.on('open-url', (event, url) => {
    event.preventDefault();
    if (!launchRoutingReady) {
      pendingDeepLinks.push(url);
      return;
    }
    routeDeepLink(url);
  });

  registerIpcHandlers();

  let telemetryFlushArmed = true;
  let terminalExitWaitArmed = true;
  let quitConfirmState: 'idle' | 'checking' | 'confirmed' = 'idle';
  app.on('before-quit', (event) => {
    if (quitConfirmState !== 'confirmed' && !isQuitConfirmSkipped()) {
      event.preventDefault();
      if (quitConfirmState === 'checking') {
        return;
      }
      quitConfirmState = 'checking';
      void shouldBlockQuit(getMainWindow()).then(
        (blocked) => {
          if (quitConfirmState !== 'checking') return;
          if (blocked) {
            quitConfirmState = 'idle';
            cancelQuitting();
            showMainWindow();
          } else {
            quitConfirmState = 'confirmed';
            markQuitting();
            app.quit();
          }
        },
        (error: unknown) => {
          log.warn(`[kimi-desktop] quit confirmation skipped: busy session check failed (${error instanceof Error ? error.message : String(error)})`);
          if (quitConfirmState !== 'checking') return;
          quitConfirmState = 'confirmed';
          markQuitting();
          app.quit();
        },
      );
      return;
    }
    quitConfirmState = 'confirmed';
    log.info('[kimi-desktop] quitting');
    markQuitStarted();
    for (const cleanup of [
      destroyBrowserView,
      flushBrowserRecords,
      finalizeWindowLifecycle,
      shutdownScreenshot,
      stopShellEnvProbe,
      killAllTerminals,
      destroyTray,
      unregisterGlobalShortcuts,
      restorePreventSleepBeforeQuit,
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
    const pendingShutdown: Promise<unknown>[] = [];
    if (telemetryFlushArmed) {
      const flush = shutdownServerTelemetry();
      if (flush !== null) {
        telemetryFlushArmed = false;
        pendingShutdown.push(flush);
      }
    }
    if (terminalExitWaitArmed) {
      const exits = waitForTerminalExits(TERMINAL_EXIT_WAIT_MS);
      if (exits !== null) {
        terminalExitWaitArmed = false;
        pendingShutdown.push(exits.then((drained) => {
          if (!drained) log.warn(`[kimi-desktop] quitting with terminals still running after ${TERMINAL_EXIT_WAIT_MS} ms`);
        }));
      }
    }
    if (pendingShutdown.length > 0) {
      event.preventDefault();
      void Promise.allSettled(pendingShutdown).then(() => app.quit());
    }
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  void app.whenReady().then(() => {
    logStartup('app-ready');
    nativeTheme.themeSource = getColorScheme();
    installAppDiagnostics();
    const launch = parseLaunchArgs(process.argv);
    trackDesktopEvent('app_launched', {
      launch_intent: launch.newChat || launch.workspace !== undefined ? 'jump_list' : 'normal',
    });
    trackDesktopEvent('startup_timing', {
      phase: 'main_ready',
      duration_ms: Math.round(process.uptime() * 1000),
    });
    app.on('child-process-gone', (_event, details) => {
      if (details.type !== 'GPU' || details.reason === 'clean-exit') return;
      const appUptimeMs = Math.round(process.uptime() * 1000);
      reportIfStillRunning(() => {
        trackDesktopEvent('app_crashed', { process: 'gpu', kind: details.reason, app_uptime_ms: appUptimeMs });
      });
    });
    initDockIcon();
    void applyPreventSleepOnLaunch();
    registerRendererProtocol(rendererDistRoot);
    initScreenshot();
    scheduleBrowserReceiptPruning();
    buildMenu();
    createWindow();
    if (e2eWindowMode() !== 'quiet') {
      createTray({
        showMainWindow,
        openSession: (sessionId) => {
          showMainWindow();
          selectSessionInRenderer(sessionId);
        },
        exportDiagnostics: (locale) => {
          void exportDiagnostics(locale);
        },
        openLogsFolder: () => {
          void openLogsFolder();
        },
        quit: () => app.quit(),
      });
    }
    if (!isPreviewVersion(app.getVersion())) {
      initAutoUpdater({
        confirmRestart: () => confirmUpdateRestart(getMainWindow()),
        prepareSessionContinue,
      });
    }
    const startupDeepLink = process.platform === 'darwin' ? undefined : extractDeepLink(process.argv);
    if (startupDeepLink !== undefined) {
      routeDeepLink(startupDeepLink);
    } else {
      forwardLaunchArgs(process.argv);
    }
    for (const argv of pendingSecondInstanceArgv.splice(0)) {
      handleSecondInstanceArgv(argv);
    }
    const deepLinks = pendingDeepLinks.splice(0);
    launchRoutingReady = true;
    for (const url of deepLinks) {
      routeDeepLink(url);
    }
    app.on('activate', () => {
      showMainWindow();
    });
  });
}
