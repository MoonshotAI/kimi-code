import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, win32 as win32path } from 'node:path';

import { app, BaseWindow, dialog, nativeImage, nativeTheme, screen, shell, webContents as electronWebContents, WebContentsView } from 'electron';
import type { AppDetailsOptions, BaseWindowConstructorOptions, WebPreferences } from 'electron';

import { DESKTOP_DISPLAY_NAME } from '../../shared/identity';
import { connect } from '../server/connect';
import { e2eWindowMode } from '../app/e2e-mode';
import { deepLinkSchemeAvailable } from '../app/deep-link';
import { installEditableContextMenu } from '../shell/context-menu';
import { installDownloadHandler } from '../browser/downloads';
import { installExternalLinkGuard } from '../shell/external-links';
import { installPermissionHandler } from '../app/permissions';
import { setFailureToastSender } from '../app/failure-dialog';
import { serverRequestTarget } from '../server/region';
import { installEmbeddedServerAuthInjection, registerAppWebContents } from '../server/server-auth';
import { IPC, type LaunchActionPayload } from '../ipc/ipc-channels';
import { quoteWindowsCommandLineArg } from '../shell/jump-list';
import { log, logStartup, onStartupStep, redactUrlForLog } from '../diagnostics/log';
import { markCleanExit } from '../app/launch-state';
import { attachWindowDiagnostics } from './window-diagnostics';
import { RENDERER_GONE_GRACE_MS, STARTUP_STALL_MS, attachWhiteScreenWatchdog } from './white-screen-watchdog';
import { dockIconPath } from '../shell/dock-icon';
import {
  SCREEN_BACKGROUND,
  dataUrl,
  screenActionFromUrl,
  screenBackgroundColor,
  startupHtml,
  startupStageForStep,
  startupStageText,
  type ScreenAction,
  type StartupStage,
} from '../app/screens';
import { trackDesktopEvent } from '../diagnostics/track';
import { setTerminalMenuFocus, getTerminalMenuFocus } from '../shell/terminal-menu-focus';
import {
  getMainWindow,
  installQuitWatch,
  isMarkedQuitting,
  markQuitting,
  notifyMainWindowGone,
  sendToRenderer,
  setMainWindow,
  shouldInterceptMainWindowClose,
  type MainWindow,
} from './window-registry';
import { bumpTerminalGeneration, killAllTerminals, killStaleTerminals } from '../terminal/manager';
import { isVibrancyEnabled, isLinuxNativeTitleBar } from '../app/ui-state';
import { recordWindowLifecycle } from './window-lifecycle';
import { attachBrowserAnnotationWindow } from '../browser/browser-annotations';
import { attachBrowserWindow, isBrowserOccluded } from '../browser/browser-view';
import { attachBrowserAutomationWindow } from '../browser/browser-automation';
import { attachBrowserOverlayWindow } from '../browser/browser-overlay';
import { isPreviewVersion, windowsAppId } from '../release/release-channel';

export * from './window-registry';

const HOST_VIEW_RESIZE_EVENTS = ['resize', 'maximize', 'unmaximize', 'enter-full-screen', 'leave-full-screen', 'restore'] as const;

function fitHostView(win: MainWindow): void {
  if (win.isDestroyed()) return;
  const { width, height } = win.contentView.getBounds();
  win.hostView.setBounds({ x: 0, y: 0, width, height });
}

export function createMainWindow(options: BaseWindowConstructorOptions, webPreferences: WebPreferences): MainWindow {
  const hostView = new WebContentsView({ webPreferences });
  hostView.setBackgroundColor('#00000000');
  const win = Object.defineProperties(new BaseWindow(options), {
    hostView: { value: hostView },
    webContents: { get: () => hostView.webContents },
    loadURL: { value: (url: string) => hostView.webContents.loadURL(url) },
  }) as MainWindow;
  win.contentView.addChildView(hostView);
  const fit = (): void => fitHostView(win);
  fit();
  win.contentView.on('bounds-changed', fit);
  for (const event of HOST_VIEW_RESIZE_EVENTS) win.on(event as 'resize', fit);
  win.once('closed', () => {
    if (!hostView.webContents.isDestroyed()) hostView.webContents.close();
  });
  return win;
}

export function focusMainRendererOnWindowFocus(win: MainWindow, occluded: () => boolean): void {
  const focusRenderer = (): void => {
    const contents = win.webContents;
    if (contents.isDestroyed()) return;
    const focused = electronWebContents.getFocusedWebContents();
    const ownsFocus = focused !== null && focused !== contents && win.contentView.children.some(child => (child as WebContentsView).webContents === focused && child.getVisible());
    if (occluded() || !ownsFocus) contents.focus();
  };
  win.on('focus', focusRenderer);
  if (win.isFocused()) focusRenderer();
}

const startupPhaseSent = new Set<'window_shown' | 'renderer_loaded' | 'renderer_ready'>();

function reportStartupPhase(phase: 'window_shown' | 'renderer_loaded' | 'renderer_ready'): void {
  if (startupPhaseSent.has(phase)) return;
  startupPhaseSent.add(phase);
  trackDesktopEvent('startup_timing', {
    phase,
    duration_ms: Math.round(process.uptime() * 1000),
  });
}

function showQuietWindow(win: MainWindow): void {
  win.setOpacity(0);
  win.setIgnoreMouseEvents(true);
  win.setSkipTaskbar(true);
  win.showInactive();
  win.setPosition(process.platform === 'win32' ? 0 : -32000, process.platform === 'win32' ? 0 : -32000);
}

export function showMainWindow(): void {
  pendingFullscreenHide = false;
  pendingHideReason = undefined;
  const current = getMainWindow();
  if (current !== null && !current.isDestroyed()) {
    if (e2eWindowMode() === 'quiet') {
      showQuietWindow(current);
      return;
    }
    if (current.isMinimized()) current.restore();
    current.show();
    current.focus();
  } else {
    createWindow();
  }
}

export function reportIfStillRunning(report: () => void): void {
  const timer = setTimeout(() => {
    if (!isMarkedQuitting()) report();
  }, RENDERER_GONE_GRACE_MS);
  timer.unref?.();
}

let pendingFullscreenHide = false;

let pendingHideReason: 'close_to_tray' | undefined;

export function shouldHideOnClose(platform: NodeJS.Platform, quitting: boolean): boolean {
  return (platform === 'darwin' || platform === 'win32') && !quitting;
}

interface SessionEndWindowLike {
  on(event: 'session-end', listener: (event: { reasons: readonly string[] }) => void): unknown;
}

export function installWindowsSessionEndWatch(
  platform: NodeJS.Platform,
  win: SessionEndWindowLike,
  markEnding: (reasons: readonly string[]) => void,
): void {
  if (platform !== 'win32') return;
  win.on('session-end', (event) => markEnding(event.reasons));
}

let rendererReady = false;
let rendererLaunchActionsReady = false;
let pendingTraySessionSelect: string | null = null;

export function isRendererReady(): boolean {
  return rendererReady;
}

export function isAppRendererUrl(url: string): boolean {
  return url.startsWith('app://') || url.startsWith('http://') || url.startsWith('https://');
}

export function selectSessionInRenderer(sessionId: string): void {
  pendingTraySessionSelect = sessionId;
  flushRendererLaunchActions();
}

let pendingLaunchActions: LaunchActionPayload[] = [];

export function drainLaunchActions(actions: LaunchActionPayload[]): LaunchActionPayload[] {
  return actions.splice(0);
}

export function sendLaunchAction(action: LaunchActionPayload): void {
  pendingLaunchActions.push(action);
  flushRendererLaunchActions();
}

export function markRendererUiMounted(url: string): void {
  if (!isAppRendererUrl(url)) return;
  rendererLaunchActionsReady = true;
  flushRendererLaunchActions();
}

function flushRendererLaunchActions(): void {
  const current = getMainWindow();
  if (!rendererReady || !rendererLaunchActionsReady || current === null || current.isDestroyed()) return;
  const contents = current.webContents;
  if (contents.isDestroyed() || contents.isCrashed() || contents.isLoadingMainFrame()) return;
  if (pendingTraySessionSelect !== null) {
    sendToRenderer(IPC.traySelectSession, pendingTraySessionSelect);
    pendingTraySessionSelect = null;
  }
  for (const action of drainLaunchActions(pendingLaunchActions)) {
    sendToRenderer(IPC.launchAction, action);
  }
}

setFailureToastSender((kind, url) => {
  const current = getMainWindow();
  if (!rendererReady || current === null || current.isDestroyed() || !current.isVisible() || current.isMinimized()) return false;
  const contents = current.webContents;
  if (contents.isDestroyed() || contents.isCrashed()) return false;
  try {
    contents.send(IPC.failureToast, kind, url);
    return true;
  } catch {
    return false;
  }
});

interface WindowBounds {
  width: number;
  height: number;
  x?: number;
  y?: number;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1440, height: 900 };

export function looksMaximizedBounds(
  bounds: { width: number; height: number },
  workArea: { width: number; height: number },
): boolean {
  return bounds.width >= workArea.width * 0.95 && bounds.height >= workArea.height * 0.95;
}

const MIN_VISIBLE_PX = 100;

export function clampBoundsToWorkArea(
  bounds: WindowBounds,
  workArea: { x: number; y: number; width: number; height: number },
): WindowBounds {
  if (bounds.x === undefined || bounds.y === undefined) return bounds;
  const x = Math.min(
    Math.max(bounds.x, workArea.x - bounds.width + MIN_VISIBLE_PX),
    workArea.x + workArea.width - MIN_VISIBLE_PX,
  );
  const y = Math.min(
    Math.max(bounds.y, workArea.y),
    workArea.y + workArea.height - MIN_VISIBLE_PX,
  );
  return x === bounds.x && y === bounds.y ? bounds : { ...bounds, x, y };
}

function stateFile(): string {
  return join(app.getPath('userData'), 'window-state.json');
}

function loadBounds(): WindowBounds {
  try {
    const parsed = JSON.parse(readFileSync(stateFile(), 'utf-8')) as Partial<WindowBounds>;
    if (typeof parsed.width === 'number' && typeof parsed.height === 'number') {
      const bounds: WindowBounds = {
        width: parsed.width,
        height: parsed.height,
        x: typeof parsed.x === 'number' ? parsed.x : undefined,
        y: typeof parsed.y === 'number' ? parsed.y : undefined,
      };
      const workArea = (
        bounds.x === undefined
          ? screen.getPrimaryDisplay()
          : screen.getDisplayMatching({
              x: bounds.x,
              y: bounds.y ?? 0,
              width: bounds.width,
              height: bounds.height,
            })
      ).workArea;
      if (!looksMaximizedBounds(bounds, workArea)) return clampBoundsToWorkArea(bounds, workArea);
    }
  } catch {}
  return DEFAULT_BOUNDS;
}

export function shouldPersistBounds(maximized: boolean, fullscreen: boolean): boolean {
  return !maximized && !fullscreen;
}

function saveBounds(win: BaseWindow): void {
  try {
    const bounds = shouldPersistBounds(win.isMaximized(), win.isFullScreen())
      ? win.getBounds()
      : win.getNormalBounds();
    mkdirSync(dirname(stateFile()), { recursive: true });
    writeFileSync(
      stateFile(),
      JSON.stringify({ width: bounds.width, height: bounds.height, x: bounds.x, y: bounds.y }),
    );
  } catch {}
}

const TRAFFIC_LIGHT_POSITION = { x: 16, y: 17 } as const;
const WINDOWS_TITLEBAR_HEIGHT = 40;

export function usesCustomTitleBar(platform: NodeJS.Platform, linuxNativeTitleBar: boolean): boolean {
  return platform === 'win32' || (platform === 'linux' && !linuxNativeTitleBar);
}

export function titleBarWindowOptions(
  platform: NodeJS.Platform,
  dark = false,
  linuxNativeTitleBar = false,
): Partial<
  Pick<BaseWindowConstructorOptions, 'frame' | 'titleBarStyle' | 'titleBarOverlay' | 'trafficLightPosition'>
> {
  if (platform === 'darwin') {
    return { titleBarStyle: 'hidden', trafficLightPosition: TRAFFIC_LIGHT_POSITION };
  }
  if (platform === 'win32') {
    return {
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: dark ? '#f2f2f2' : '#202020',
        height: WINDOWS_TITLEBAR_HEIGHT,
      },
    };
  }
  if (platform === 'linux' && !linuxNativeTitleBar) {
    return {
      frame: false,
      titleBarStyle: 'hidden',
      titleBarOverlay: {
        color: '#00000000',
        symbolColor: dark ? '#f2f2f2' : '#202020',
        height: WINDOWS_TITLEBAR_HEIGHT,
      },
    };
  }
  return { titleBarStyle: 'default' };
}

export function applyTitleBarOverlay(win: BaseWindow): void {
  if (!usesCustomTitleBar(process.platform, isLinuxNativeTitleBar()) || win.isDestroyed()) return;
  win.setTitleBarOverlay({
    color: '#00000000',
    symbolColor: nativeTheme.shouldUseDarkColors ? '#f2f2f2' : '#202020',
    height: WINDOWS_TITLEBAR_HEIGHT,
  });
}

export function devToolsMode(): 'right' | 'detach' {
  return process.platform === 'linux' && usesCustomTitleBar(process.platform, isLinuxNativeTitleBar())
    ? 'right'
    : 'detach';
}

export function vibrancyWindowOptions(
  platform: NodeJS.Platform,
  dark: boolean,
): { vibrancy?: 'menu'; visualEffectState?: 'active'; backgroundColor: string } {
  if (platform === 'darwin') {
    return { vibrancy: 'menu', visualEffectState: 'active', backgroundColor: '#00000000' };
  }
  return { backgroundColor: dark ? SCREEN_BACKGROUND.dark : SCREEN_BACKGROUND.light };
}

export function windowsWindowOptions(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  bundleDir: string,
  resourcesPath: string,
): Pick<BaseWindowConstructorOptions, 'icon'> {
  if (platform !== 'win32') return {};
  return {
    icon: isPackaged
      ? win32path.join(resourcesPath, 'build', 'icon.ico')
      : win32path.join(bundleDir, '..', 'build', 'icon.ico'),
  };
}

export function windowsAppDetails(
  platform: NodeJS.Platform,
  isPackaged: boolean,
  iconPath: string | undefined,
  execPath: string,
  appPath: string,
  version: string = '',
): AppDetailsOptions | null {
  if (platform !== 'win32' || iconPath === undefined) return null;
  return {
    appId: windowsAppId(isPackaged, version),
    appIconPath: iconPath,
    appIconIndex: 0,
    relaunchCommand: [execPath, ...(isPackaged ? [] : [appPath])]
      .map(quoteWindowsCommandLineArg)
      .join(' '),
    relaunchDisplayName: isPackaged ? (isPreviewVersion(version) ? `${DESKTOP_DISPLAY_NAME} Preview` : DESKTOP_DISPLAY_NAME) : `${DESKTOP_DISPLAY_NAME} Dev`,
  };
}

export function applyWindowVibrancy(enabled: boolean): void {
  if (process.platform !== 'darwin') return;
  const current = getMainWindow();
  if (current === null || current.isDestroyed()) return;
  current.setVibrancy(enabled ? 'menu' : null);
  current.setBackgroundColor(enabled ? '#00000000' : screenBackgroundColor());
}

let screenActionHandler: ((action: ScreenAction, win: MainWindow) => void) | null = null;

export function setScreenActionHandler(handler: ((action: ScreenAction, win: MainWindow) => void) | null): void {
  screenActionHandler = handler;
}

function startupIcon(): string | null {
  try {
    const base = app.isPackaged ? process.resourcesPath : app.getAppPath();
    const candidates = [
      dockIconPath({
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        appPath: app.getAppPath(),
        isDark: nativeTheme.shouldUseDarkColors,
      }),
      join(base, 'build', 'icon.ico'),
    ];
    for (const path of candidates) {
      const image = nativeImage.createFromPath(path);
      if (!image.isEmpty()) return image.resize({ width: 128 }).toDataURL();
    }
  } catch {
    return null;
  }
  return null;
}

let stopStartupScreen: (() => void) | null = null;

export function showStartupScreen(win: MainWindow): void {
  stopStartupScreen?.();
  if (win.isDestroyed()) return;
  let stage: StartupStage = 'preparing';
  const url = dataUrl(startupHtml({ icon: startupIcon(), stage, slowAfterMs: STARTUP_STALL_MS }));
  const applyStage = (): void => {
    if (win.isDestroyed() || win.webContents.getURL() !== url) return;
    void win.webContents
      .executeJavaScript(`window.__kimiStartupStage?.(${JSON.stringify(startupStageText(stage))})`)
      .catch(() => undefined);
  };
  const unsubscribe = onStartupStep((entry) => {
    const next = startupStageForStep(entry.step);
    if (next === null || next === stage) return;
    stage = next;
    applyStage();
  });
  const stop = (): void => {
    unsubscribe();
    win.webContents.removeListener('did-finish-load', applyStage);
    win.removeListener('closed', stop);
    if (stopStartupScreen === stop) stopStartupScreen = null;
  };
  stopStartupScreen = stop;
  win.once('closed', stop);
  win.webContents.on('did-finish-load', applyStage);
  void win.loadURL(url).catch(() => undefined);
}

export function createWindow(): void {
  installQuitWatch();
  const windowsOptions = windowsWindowOptions(
    process.platform,
    app.isPackaged,
    __dirname,
    process.resourcesPath,
  );
  const quiet = e2eWindowMode() === 'quiet';
  const linuxNativeTitleBar = isLinuxNativeTitleBar();
  const customTitleBar = usesCustomTitleBar(process.platform, linuxNativeTitleBar);
  const win = createMainWindow({
    ...loadBounds(),
    ...(quiet ? { show: false, enableLargerThanScreen: true } : {}),
    minWidth: 900,
    minHeight: 480,
    ...vibrancyWindowOptions(process.platform, nativeTheme.shouldUseDarkColors),
    ...windowsOptions,
    title: 'Kimi Code',
    ...titleBarWindowOptions(process.platform, nativeTheme.shouldUseDarkColors, linuxNativeTitleBar),
  }, {
    preload: join(__dirname, 'preload.cjs'),
    additionalArguments: ['--kimi-native-overlay-host', ...(deepLinkSchemeAvailable() ? ['--kimi-session-links'] : [])],
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    ...(quiet ? { backgroundThrottling: false } : {}),
  });
  setMainWindow(win);
  logStartup('window-created');
  if (quiet) showQuietWindow(win);
  focusMainRendererOnWindowFocus(win, isBrowserOccluded);



  attachBrowserWindow(win);
  attachBrowserAnnotationWindow(win);
  attachBrowserAutomationWindow(win);
  attachBrowserOverlayWindow(win);
  if (process.platform === 'win32') {
    const details = windowsAppDetails(
      process.platform,
      app.isPackaged,
      typeof windowsOptions.icon === 'string' ? windowsOptions.icon : undefined,
      process.execPath,
      app.getAppPath(),
      app.getVersion(),
    );
    if (details !== null) win.setAppDetails(details);
  }
  if (customTitleBar) {
    win.setMenuBarVisibility(false);
    const syncTitleBar = (): void => applyTitleBarOverlay(win);
    nativeTheme.on('updated', syncTitleBar);
    win.once('closed', () => nativeTheme.removeListener('updated', syncTitleBar));
  }
  if (!isVibrancyEnabled()) applyWindowVibrancy(false);
  const syncBackground = (): void => {
    if (win.isDestroyed() || (process.platform === 'darwin' && isVibrancyEnabled())) return;
    win.setBackgroundColor(screenBackgroundColor());
  };
  nativeTheme.on('updated', syncBackground);
  win.once('closed', () => nativeTheme.removeListener('updated', syncBackground));
  rendererReady = false;
  rendererLaunchActionsReady = false;
  installEmbeddedServerAuthInjection(win.webContents.session);
  registerAppWebContents(win.webContents);
  attachWindowDiagnostics(win.webContents);
  attachWhiteScreenWatchdog(win.webContents, { isAppUrl: isAppRendererUrl, isQuitting: isMarkedQuitting });
  installExternalLinkGuard(win.webContents, (url) => shell.openExternal(url), serverRequestTarget);
  installPermissionHandler(win.webContents.session);
  win.webContents.on('will-navigate', (event, url) => {
    const action = screenActionFromUrl(url);
    if (action === null) return;
    event.preventDefault();
    if (!win.webContents.getURL().startsWith('data:')) return;
    screenActionHandler?.(action, win);
  });
  installEditableContextMenu(win.webContents);
  installDownloadHandler(win.webContents.session, {
    showSaveDialog: (opts) => {
      const current = getMainWindow();
      return current === null || current.isDestroyed()
        ? dialog.showSaveDialogSync(opts)
        : dialog.showSaveDialogSync(current, opts);
    },
    downloadsDir: app.getPath('downloads'),
  });
  win.webContents.on('page-title-updated', (event) => {
    event.preventDefault();
  });
  if (process.platform === 'darwin') {
    const showTrafficLights = (): void => {
      if (win.isDestroyed()) return;
      win.setWindowButtonPosition(TRAFFIC_LIGHT_POSITION);
      win.setWindowButtonVisibility(true);
    };
    win.on('enter-full-screen', showTrafficLights);
    win.on('leave-full-screen', showTrafficLights);
    win.on('focus', showTrafficLights);
  }
  win.on('enter-full-screen', () => sendToRenderer(IPC.fullscreenChanged, true));
  win.on('leave-full-screen', () => sendToRenderer(IPC.fullscreenChanged, false));
  installWindowsSessionEndWatch(process.platform, win, (reasons) => {
    log.info(`[power] session-end reasons=${reasons.join(',')}`);
    markQuitting();
    markCleanExit();
  });
  win.on('show', () => {
    reportStartupPhase('window_shown');
    recordWindowLifecycle('shown');
  });
  win.on('hide', () => {
    const reason = pendingHideReason;
    pendingHideReason = undefined;
    recordWindowLifecycle('hidden', reason === undefined ? {} : { reason });
  });
  win.on('minimize', () => {
    recordWindowLifecycle('hidden', { reason: 'deactivate' });
  });
  win.on('restore', () => {
    recordWindowLifecycle('shown');
  });
  win.on('close', (event) => {
    saveBounds(win);
    if (shouldInterceptMainWindowClose()) {
      event.preventDefault();
      return;
    }
    if (shouldHideOnClose(process.platform, isMarkedQuitting())) {
      event.preventDefault();
      if (win.webContents.isDevToolsOpened()) win.webContents.closeDevTools();
      pendingHideReason = 'close_to_tray';
      if (win.isFullScreen()) {
        pendingFullscreenHide = true;
        win.setFullScreen(false);
        win.once('leave-full-screen', () => {
          if (pendingFullscreenHide && !win.isDestroyed()) win.hide();
          pendingFullscreenHide = false;
        });
      } else {
        win.hide();
      }
    }
  });
  win.on('closed', () => {
    recordWindowLifecycle('closed');
    if (getMainWindow() === win) {
      setMainWindow(null);
      rendererLaunchActionsReady = false;
    }
    notifyMainWindowGone();
  });
  if (win.isVisible()) {
    reportStartupPhase('window_shown');
    recordWindowLifecycle('shown');
  }
  if (!app.isPackaged && e2eWindowMode() === null) {
    win.webContents.openDevTools({ mode: devToolsMode() });
  }
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    clearStartupHistoryAfterLoad = win.webContents.getURL().startsWith('data:') && isAppRendererUrl(details.url);
    rendererReady = false;
    notifyMainWindowGone();
    abortedNavTerminalFocus = getTerminalMenuFocus();
    bumpTerminalGeneration();
    setTerminalMenuFocus(false);
  });
  win.webContents.on('did-navigate', () => {
    rendererLaunchActionsReady = false;
  });
  win.webContents.on('did-stop-loading', flushRendererLaunchActions);
  let abortedNavTerminalFocus = false;
  let clearStartupHistoryAfterLoad = false;
  const settleRendererReady = (isMainFrame: boolean): void => {
    if (win.isDestroyed() || !isMainFrame || !isAppRendererUrl(win.webContents.getURL())) return;
    rendererReady = true;
    reportStartupPhase('renderer_ready');
    flushRendererLaunchActions();
  };
  const restoreTerminalFocusOnAbort = (isMainFrame: boolean): void => {
    if (win.isDestroyed() || !isMainFrame || !isAppRendererUrl(win.webContents.getURL())) return;
    setTerminalMenuFocus(abortedNavTerminalFocus);
  };
  win.webContents.on('did-fail-load', (_event, _code, _desc, _url, isMainFrame) => {
    settleRendererReady(isMainFrame);
    restoreTerminalFocusOnAbort(isMainFrame);
  });
  win.webContents.on('did-fail-provisional-load', (_event, _code, _desc, _url, isMainFrame, frameProcessId, frameRoutingId) => {
    if (isMainFrame && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      const frame = win.webContents.mainFrame;
      if (frame.processId === frameProcessId && frame.routingId === frameRoutingId) {
        rendererLaunchActionsReady = false;
      }
    }
    settleRendererReady(isMainFrame);
    restoreTerminalFocusOnAbort(isMainFrame);
  });
  const maxRendererRecoveryAttempts = 2;
  let rendererRecoveryAttempts = 0;
  let rendererRecoveryResetTimer: ReturnType<typeof setTimeout> | null = null;
  win.webContents.on('render-process-gone', (_event, details) => {
    if (rendererRecoveryResetTimer !== null) clearTimeout(rendererRecoveryResetTimer);
    rendererRecoveryResetTimer = null;
    rendererReady = false;
    rendererLaunchActionsReady = false;
    notifyMainWindowGone();
    bumpTerminalGeneration();
    killAllTerminals();
    setTerminalMenuFocus(false);
    if (details.reason === 'clean-exit') return;
    const crash = {
      reason: details.reason === 'memory-eviction' ? 'oom' : details.reason,
      exit_code: details.exitCode,
    };
    reportIfStillRunning(() => trackDesktopEvent('renderer_crashed', crash));
    if (rendererRecoveryAttempts >= maxRendererRecoveryAttempts) {
      log.error('[proc] renderer recovery attempts exhausted');
      return;
    }
    rendererRecoveryAttempts += 1;
    reportIfStillRunning(() => {
      if (win.isDestroyed() || win.webContents.isDestroyed()) return;
      log.warn(`[proc] reloading renderer after crash attempt=${rendererRecoveryAttempts}/${maxRendererRecoveryAttempts}`);
      try {
        win.webContents.reload();
      } catch (error) {
        log.error('[proc] renderer recovery reload failed', error);
      }
    });
  });
  win.webContents.on('did-finish-load', () => {
    const shouldClearStartupHistory = clearStartupHistoryAfterLoad;
    clearStartupHistoryAfterLoad = false;
    if (isAppRendererUrl(win.webContents.getURL())) {
      if (shouldClearStartupHistory) win.webContents.navigationHistory.clear();
      reportStartupPhase('renderer_loaded');
      if (rendererRecoveryAttempts > 0) {
        if (rendererRecoveryResetTimer !== null) clearTimeout(rendererRecoveryResetTimer);
        rendererRecoveryResetTimer = setTimeout(() => {
          rendererRecoveryAttempts = 0;
          rendererRecoveryResetTimer = null;
        }, 60_000);
        rendererRecoveryResetTimer.unref?.();
      }
    }
    settleRendererReady(true);
    if (win.isDestroyed()) return;
    killStaleTerminals();
    const factor = win.webContents.getZoomFactor();
    const level = win.webContents.getZoomLevel();
    void win.webContents
      .executeJavaScript('window.devicePixelRatio')
      .then((dpr) => {
        if (win.isDestroyed()) return;
        const url = redactUrlForLog(win.webContents.getURL());
        log.info(
          `[kimi-desktop diag] zoom factor=${factor} level=${level} devicePixelRatio=${dpr} url=${url}`,
        );
      })
      .catch(() => {});
  });
  showStartupScreen(win);
  void connect(win);
}
