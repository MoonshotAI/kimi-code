import { browserIdsForSite, clearBrowserSiteData } from '../browser/browser-view';
import { browserValidators as annotationValidators } from '../../shared/browser-annotation';
import { isBrowserTabCommand } from '../../shared/browser';
import { isBrowserControlConfig } from '../../shared/browser-control';
import { handleBrowserControlDownload, handleBrowserControlTakeover, markBrowserControlReady, setBrowserControls, takeOverAllBrowsers, takeOverBrowser, takeOverClosedBrowser } from '../browser/browser-control';
import { forgetBrowserSiteVisits, getBrowserPermissionRequests, resolveBrowserPermissionRequest, getBrowserSite, getBrowserSites, updateBrowserSiteAutoplay, updateBrowserSitePermission, updateBrowserSiteSound } from '../browser/browser-sites';
import { listBrowserDialogs, respondBrowserDialog } from '../browser/browser-dialogs';
import { browserValidators as dialogValidators } from '../../shared/browser-dialogs';
import { getBrowserSystemPermissionDenials, openBrowserSystemPermissionSettings } from '../browser/browser-system-permissions';
import { browserValidators as siteValidators, asBrowserSiteAutoplayUpdate, asBrowserSitePermissionUpdate, asBrowserSiteSoundUpdate, browserSiteOrigin, isBrowserSitePermission } from '../../shared/browser-sites';
import { asBrowserDownloadAction, isBrowserDownloadId, isBrowserDownloadsWatch, isBrowserPreferencesPatch } from '../../shared/browser-data';
import { app, clipboard, dialog, ipcMain, nativeTheme, shell } from 'electron';
import type { OpenDialogOptions, SaveDialogOptions, WebContents } from 'electron';

import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { asBrowserPanelSessions } from '../../shared/browser-panel-state';
import { BrowserSessionStore } from '../browser/browser-session-store';
import { localFileAddressUrl, resolveLocalHtmlFileUrl } from '../browser/browser-local-file';
import { createLocalPagesPolicy } from '../browser/local-pages-policy';
import { asBrowserAnnotationPickRequest } from '../../shared/browser-annotation';
import { collectBrowserAnnotationAssets, completeBrowserAnnotationCapture, cancelBrowserAnnotationPick, hideBrowserAnnotation, pickBrowserAnnotation, readBrowserAnnotationAsset, showBrowserAnnotation } from '../browser/browser-annotations';

import { getMainWindow, showMainWindow, applyWindowVibrancy, markQuitting, sendToRenderer, windowForWebContents } from '../window/main-window';
import { listAvailableOpenInApps, openInApp } from '../system/open-in';
import { getTerminalManager, initTerminalManager, type NativeTerminalCreateOptions } from '../terminal/manager';
import { normalizeTerminalSshTarget } from '../../shared/terminal-activity';
import { startShellEnvProbe } from '../system/shell-env';
import {
  getUpdateAutoDownload,
  getUpdateStatus,
  requestUpdateCheck,
  requestUpdateDownload,
  requestUpdateInstall,
  setUpdateAutoDownload,
} from '../release/updater';
import { getCanaryInfo } from '../release/canary';
import { asTrayAttention, setTrayAttention, setTrayLocale } from '../shell/tray';
import { effectiveContextMenuLocale, setContextMenuLocale, showSelectionContextMenu } from '../shell/context-menu';
import { browserEn, browserZh } from '@moonshot-ai/app-i18n/browser';
import { resolveQuitConfirmResponse, setQuitConfirmLocale, shouldBlockQuit } from '../app/quit-confirm';
import { asJumpListWorkspaces, setJumpListLocale, updateJumpList } from '../shell/jump-list';
import { popupWindowsMenu, setMenuLocale, setMenuShortcuts, setMenuSuspended, setTerminalMenuFocus, onTerminalMenuFocus } from '../shell/menu';
import { setGlobalShortcutForAction, setGlobalShortcutSuspended, setGlobalShortcutTerminalFocus } from '../shell/shortcuts';
import { getRemoteControlRestoreState, isLinuxNativeTitleBar, isVibrancyEnabled, markOnboarded, setColorScheme, setLinuxNativeTitleBar, setRemoteControlPreviousEnabled, setRemoteControlRestoreEnabled, setVibrancyEnabled } from '../app/ui-state';
import { isPowerSaveBlockerEnabled } from '../system/power-save-blocker';
import { getPreventSleepState, setLidSleepPreventionEnabled, setSystemSleepPreventionEnabled } from '../system/prevent-lid-sleep';
import { isSleepPreventionMode } from '../../shared/prevent-sleep';
import { setBrowserAgentControl, setBrowserSubagentControl } from '../browser/browser-agent-control';
import { isDockIconChoice, setDockIconChoice } from '../shell/dock-icon';
import { isHttpUrl } from '../shell/external-links';
import { cancelScreenshotCapture, captureScreenshot, setScreenshotLocale } from '../screenshot/controller';
import { stableSettingsPrecheck, stableUserDataDir, writeImportMarker } from '../release/stable-settings-import';
import { log, redactUrlForLog } from '../diagnostics/log';
import { updateServerRegionToken } from '../server/region';
import { asProviderModelsFetchRequest, fetchProviderModelsViaNet } from '../system/provider-models-fetch';
import { createRendererLogWriter } from '../diagnostics/renderer-log';
import { collectFeedbackDiagnosticsArchive } from '../diagnostics/diagnostics-export';
import { recordRendererMilestone } from '../diagnostics/startup-milestones';
import { markCleanExit } from '../app/launch-state';
import {
  readRuntimeEnvironmentOverrides,
  restoreRuntimeEnvironmentForRelaunch,
  runtimeEnvironmentCustomizationEnabled,
  RuntimeEnvironmentFieldError,
  writeRuntimeEnvironmentOverrides,
} from '../app/runtime-environment';
import {
  rendererTrackEventSchema,
  type RendererTrackEvent,
} from '../../shared/track-events';
import { trackDesktopEvent } from '../diagnostics/track';
import { IPC, type ColorScheme, type WindowsMenuId } from './ipc-channels';
import { browserValidators as pageValidators, asBrowserCloneRequest, asBrowserNavigateRequest, asBrowserFocusEmulationRequest, asBrowserBoundsRequest, asBrowserId, asBrowserOcclusionRequest, asBrowserVisibilityRequest, asBrowserZoomRequest } from '../../shared/browser';
import { asBrowserDeviceModeUpdate } from '../../shared/browser-device';
import {
  asBrowserOverlayFormAction,
  asBrowserOverlayMenuId,
  asBrowserOverlayActivateRequest,
  asBrowserOverlayDismissRequest,
  asBrowserOverlayDialogRequest,
  asBrowserOverlayMenuRequest,
  asBrowserOverlayRendered,
  asBrowserOverlayVisibilityRequest,
} from '../../shared/browser-overlay';
import {
  browserGoBack,
  browserGoForward,
  browserFind,
  browserPrint,
  browserReload,
  browserTabCommand,
  browserStopFind,
  browserZoom,
  updateBrowserFocusEmulation,
  captureBrowserScreenshot,
  closeBrowser,
  cloneBrowser,
  clearBrowserData,
  restoreBrowser,
  suspendBrowser,
  setBrowserPagePersistence,
  setLocalPagesExtraPrivileges,
  setLocalPagesPolicy,
  navigateBrowser,
  openBrowserLocalFile,
  isLocalFileUrl,
  getBrowserGeneration,
  getBrowserState,
  takeLocalLinkGrant,
  setBrowserBounds,
  setBrowserVisible,
  setBrowserOccluded,
  toggleBrowserDeviceMode,
  updateBrowserDeviceMode,
  applyDefaultBrowserZoom,
  applyBrowserUserAgentPreference,
  applyBrowserAutoplayPolicy,
  applyBrowserSound,
  retryBrowserViewDownload,
} from '../browser/browser-view';
import {
  clearBrowserDownloads,
  controlBrowserDownload,
  checkBrowserDownloadsAccess,
  clearBrowserHistory,
  getBrowserData,
  getBrowserDownloadItems,
  onBrowserDownloadsChanged,
  openBrowserDownload,
  readBrowserDownloads,
  removeBrowserDownload,
  setBrowserAgentDownloadDirectory,
  updateBrowserPreferences,
} from '../browser/browser-data';
import {
  activateBrowserOverlayItem,
  dismissBrowserOverlay,
  submitBrowserOverlayForm,
  closeBrowserOverlayMenu,
  closeBrowserOverlayDialog,
  isBrowserOverlaySender,
  markBrowserOverlayReady,
  markBrowserOverlayHidden,
  openBrowserOverlayMenu,
  openBrowserOverlayDialog,
  showBrowserOverlayRendered,
} from '../browser/browser-overlay';
import { handleBrowserUiResponse } from '../browser/browser-automation';
import { browserValidators as receiptValidators } from '../../shared/browser-receipt';
import { copyBrowserReceipts, deleteBrowserReceipts, readBrowserReceipt } from '../browser/browser-receipts';

function isColorScheme(value: unknown): value is ColorScheme {
  return value === 'light' || value === 'dark' || value === 'system';
}

function isWindowsMenuId(value: unknown): value is WindowsMenuId {
  return value === 'file' || value === 'edit' || value === 'view' || value === 'help';
}

function isMainRendererSender(sender: WebContents): boolean {
  const win = getMainWindow();
  return win !== null && !win.isDestroyed() && sender === win.webContents;
}

function asTerminalCreateOptions(value: unknown): NativeTerminalCreateOptions {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
  const raw = value as Record<string, unknown>;
  const options: NativeTerminalCreateOptions = {};
  if (typeof raw['cwd'] === 'string' && raw['cwd'] !== '') options.cwd = raw['cwd'];
  if (typeof raw['cols'] === 'number' && Number.isFinite(raw['cols'])) options.cols = raw['cols'];
  if (typeof raw['rows'] === 'number' && Number.isFinite(raw['rows'])) options.rows = raw['rows'];
  const ssh = normalizeTerminalSshTarget(raw['ssh']);
  if (ssh !== undefined) options.ssh = ssh;
  return options;
}

function asRendererTrackEvent(
  event: unknown,
  payload: unknown,
): RendererTrackEvent | null {
  const result = rendererTrackEventSchema.safeParse({ event, properties: payload });
  return result.success ? result.data : null;
}


const rendererLogWriter = createRendererLogWriter();

function rendererLogSource(sender: WebContents): string | undefined {
  try {
    return `r${sender.getOSProcessId()}`;
  } catch {
    return undefined;
  }
}

export function registerIpcHandlers(): void {
  const localPagesAllowed = createLocalPagesPolicy({
    isPackaged: app.isPackaged,
    env: process.env,
    execPath: process.execPath,
    platform: process.platform,
    warn: (message) => log.warn(message),
  });
  setLocalPagesExtraPrivileges(localPagesAllowed.extraPrivileges);
  setLocalPagesPolicy(localPagesAllowed);
  let browserSessions: BrowserSessionStore | null = null;
  const getBrowserSessions = (): BrowserSessionStore => {
    if (browserSessions === null) {
      browserSessions = new BrowserSessionStore(join(app.getPath('userData'), 'browser-tabs.json'));
      setBrowserPagePersistence(browserSessions);
    }
    return browserSessions;
  };
  ipcMain.on(IPC.theme, (_event, scheme: unknown) => {
    if (isColorScheme(scheme)) {
      nativeTheme.themeSource = scheme;
      setColorScheme(scheme);
    }
  });
  ipcMain.on(IPC.dockIconChoice, (_event, choice: unknown) => {
    if (isDockIconChoice(choice)) setDockIconChoice(choice);
  });
  ipcMain.handle(IPC.openExternal, (_event, url: string) => {
    if (!isHttpUrl(url)) {
      log.error(`[kimi-desktop] openExternal rejected non-http(s) url: ${redactUrlForLog(url)}`);
      throw new Error('openExternal only allows http(s) URLs');
    }
    return shell.openExternal(url).catch((error: unknown) => {
      log.error(`[kimi-desktop] openExternal failed: ${redactUrlForLog(url)}`, error);
      throw error;
    });
  });
  ipcMain.handle(IPC.writeClipboardText, (_event, text: unknown) => {
    if (typeof text !== 'string') return false;
    clipboard.writeText(text);
    return true;
  });
  ipcMain.handle(IPC.collectFeedbackDiagnostics, (event) => {
    if (!isMainRendererSender(event.sender) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error('Feedback diagnostics are only available to the main window');
    }
    return collectFeedbackDiagnosticsArchive();
  });
  ipcMain.handle(IPC.serverCredential, (_event, token: unknown) => {
    if (typeof token === 'string' && token.length > 0) {
      updateServerRegionToken(token);
    }
  });
  ipcMain.handle(IPC.dialogOpen, async (_event, opts: OpenDialogOptions = {}) => {
    const win = getMainWindow();
    const result = await (win === null || win.isDestroyed()
      ? dialog.showOpenDialog(opts)
      : dialog.showOpenDialog(win, opts));
    trackDesktopEvent('native_ipc_used', { channel: 'dialog-open' });
    return result;
  });
  ipcMain.handle(IPC.dialogSave, async (_event, opts: SaveDialogOptions = {}) => {
    const win = getMainWindow();
    const result = await (win === null || win.isDestroyed()
      ? dialog.showSaveDialog(opts)
      : dialog.showSaveDialog(win, opts));
    trackDesktopEvent('native_ipc_used', { channel: 'dialog-save' });
    return result;
  });
  ipcMain.handle(IPC.openInList, (_event, filePath: unknown) =>
    listAvailableOpenInApps({
      filePath: typeof filePath === 'string' && filePath.trim() !== '' ? filePath : undefined,
    }),
  );
  ipcMain.handle(IPC.openInApp, async (_event, appId: unknown, path: unknown) => {
    if (typeof appId !== 'string' || typeof path !== 'string' || path.trim() === '') {
      return { ok: false as const, error: 'invalid open-in arguments' };
    }
    const result = await openInApp(appId, path);
    if (result.ok) {
      trackDesktopEvent('native_ipc_used', { channel: 'open-in' });
    }
    return result;
  });
  ipcMain.handle(IPC.isFullscreen, () => {
    const win = getMainWindow();
    return win !== null && !win.isDestroyed() && win.isFullScreen();
  });
  ipcMain.handle(IPC.menuPopup, (event, request: unknown) => {
    const win = getMainWindow();
    if (
      win === null ||
      win.isDestroyed() ||
      event.sender !== win.webContents ||
      request === null ||
      typeof request !== 'object'
    ) {
      return { opened: false };
    }
    const { id, x, y } = request as Record<string, unknown>;
    if (!isWindowsMenuId(id) || typeof x !== 'number' || typeof y !== 'number') {
      return { opened: false };
    }
    return popupWindowsMenu(id, x, y);
  });
  ipcMain.handle(IPC.quitConfirmResponse, (event, payload: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return;
    if (payload === null || typeof payload !== 'object') return;
    const { choice, requestId } = payload as { choice?: unknown; requestId?: unknown };
    if (
      (choice === 'quit' || choice === 'cancel' || choice === 'unavailable') &&
      typeof requestId === 'number'
    ) {
      resolveQuitConfirmResponse(choice, requestId);
    }
  });
  ipcMain.handle(IPC.updateGetStatus, () => getUpdateStatus());
  ipcMain.handle(IPC.updateCheck, () => requestUpdateCheck());
  ipcMain.handle(IPC.providerModelsFetch, async (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('provider-models-fetch: unknown sender');
    const request = asProviderModelsFetchRequest(payload);
    if (request === null) throw new Error('provider-models-fetch: invalid request');
    return await fetchProviderModelsViaNet(request);
  });
  ipcMain.handle(IPC.updateDownload, () => requestUpdateDownload());
  ipcMain.handle(IPC.updateInstall, () => requestUpdateInstall());
  ipcMain.handle(IPC.updateGetAutoDownload, () => getUpdateAutoDownload());
  ipcMain.handle(IPC.updateSetAutoDownload, (_event, enabled: unknown) => {
    if (typeof enabled === 'boolean') {
      setUpdateAutoDownload(enabled);
    }
  });
  ipcMain.handle(IPC.remoteControlRestoreStateGet, () => getRemoteControlRestoreState());
  ipcMain.handle(IPC.remoteControlRestoreStateSet, (_event, patch: unknown) => {
    if (typeof patch !== 'object' || patch === null) return;
    const value = patch as { restoreEnabled?: unknown; previousEnabled?: unknown };
    if (typeof value.restoreEnabled === 'boolean') setRemoteControlRestoreEnabled(value.restoreEnabled);
    if (typeof value.previousEnabled === 'boolean') setRemoteControlPreviousEnabled(value.previousEnabled);
  });
  const runtimeEnvironmentAllowed = (event: { sender: WebContents }): boolean =>
    runtimeEnvironmentCustomizationEnabled(app.getVersion(), app.isPackaged) && event.sender === getMainWindow()?.webContents;
  const saveRuntimeEnvironment = async (event: { sender: WebContents }, value: unknown, requireEndpoints = true) => {
    if (!runtimeEnvironmentAllowed(event)) return { status: 'unavailable' as const };
    try {
      if (await shouldBlockQuit(getMainWindow(), { interceptWindowClose: false })) {
        return { status: 'cancelled' as const };
      }
      writeRuntimeEnvironmentOverrides(value, undefined, requireEndpoints);
      restoreRuntimeEnvironmentForRelaunch();
    } catch (error) {
      if (error instanceof RuntimeEnvironmentFieldError) return { status: 'invalid' as const, field: error.field };
      log.error('[kimi-desktop] failed to save runtime environment', error);
      return { status: 'error' as const, error: error instanceof Error ? error.message : String(error) };
    }
    setImmediate(() => {
      markCleanExit();
      app.relaunch();
      app.exit(0);
    });
    return { status: 'relaunching' as const };
  };
  ipcMain.handle(IPC.runtimeEnvironmentGet, (event) => {
    if (!runtimeEnvironmentAllowed(event)) return { status: 'unavailable' as const };
    try {
      return { status: 'ok' as const, overrides: readRuntimeEnvironmentOverrides() };
    } catch (error) {
      return { status: 'error' as const, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(IPC.runtimeEnvironmentSave, (event, value: unknown) => saveRuntimeEnvironment(event, value));
  ipcMain.handle(IPC.runtimeEnvironmentReset, (event) => saveRuntimeEnvironment(event, {}, false));
  ipcMain.handle(IPC.canaryGetInfo, () => getCanaryInfo());
  ipcMain.handle(IPC.canaryImportStableSettings, async () => {
    const precheck = stableSettingsPrecheck(app.getVersion(), process.platform, app.getPath('appData'));
    if (precheck !== 'ok') return { status: precheck };
    if (await shouldBlockQuit(getMainWindow(), { interceptWindowClose: false })) {
      return { status: 'cancelled' };
    }
    try {
      writeImportMarker(app.getPath('userData'), stableUserDataDir(app.getPath('appData')));
    } catch (error) {
      return { status: 'error', error: error instanceof Error ? error.message : String(error) };
    }
    setImmediate(() => {
      markCleanExit();
      app.relaunch();
      app.exit(0);
    });
    return { status: 'relaunching' };
  });
  ipcMain.on(IPC.trayAttention, (_event, payload: unknown) => {
    const attention = asTrayAttention(payload);
    if (attention !== null) {
      setTrayAttention(attention);
    }
  });
  ipcMain.on(IPC.locale, (_event, locale: unknown) => {
    if (locale === 'en' || locale === 'zh') {
      setTrayLocale(locale);
      setMenuLocale(locale);
      setContextMenuLocale(locale);
      setJumpListLocale(locale);
      setScreenshotLocale(locale);
      setQuitConfirmLocale(locale);
    }
  });
  ipcMain.on(IPC.jumpList, (_event, payload: unknown) => {
    const workspaces = asJumpListWorkspaces(payload);
    if (workspaces !== null) {
      updateJumpList(workspaces);
    }
  });
  ipcMain.on(IPC.menuShortcut, (event, payload: unknown) => {
    if (event.sender !== getMainWindow()?.webContents) return;
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return;
    }
    const bindings: Record<string, string | null> = {};
    for (const [id, value] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof value === 'string' || value === null) {
        bindings[id] = value;
      }
    }
    setMenuShortcuts(bindings);
  });
  ipcMain.on(IPC.menuSuspend, (_event, suspended: unknown) => {
    if (typeof suspended === 'boolean') {
      setMenuSuspended(suspended);
    }
  });
  ipcMain.on(IPC.menuTerminalFocus, (_event, focused: unknown) => {
    if (typeof focused === 'boolean') {
      setTerminalMenuFocus(focused);
    }
  });
  onTerminalMenuFocus(setGlobalShortcutTerminalFocus);
  ipcMain.handle(IPC.globalShortcut, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, reason: 'invalid' };
    }
    const { action, binding } = payload as Record<string, unknown>;
    if ((action !== 'summonApp' && action !== 'captureScreenshot') || (binding !== null && typeof binding !== 'string')) {
      return { ok: false, reason: 'invalid' };
    }
    return setGlobalShortcutForAction(action, binding as string | null);
  });
  ipcMain.handle(IPC.globalShortcutSuspend, (_event, suspended: unknown) => {
    if (typeof suspended !== 'boolean') {
      return false;
    }
    return setGlobalShortcutSuspended(suspended);
  });
  ipcMain.handle(IPC.screenshotCapture, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('screenshot-capture: unknown sender');
    return captureScreenshot();
  });
  ipcMain.on(IPC.screenshotCancel, (event) => {
    if (!isMainRendererSender(event.sender)) return;
    cancelScreenshotCapture();
  });
  ipcMain.on(IPC.showWindow, () => {
    showMainWindow();
    trackDesktopEvent('native_ipc_used', { channel: 'show-window' });
  });
  ipcMain.on(IPC.hideWindow, (event) => {
    windowForWebContents(event.sender)?.close();
    trackDesktopEvent('native_ipc_used', { channel: 'hide-window' });
  });
  ipcMain.on(IPC.selectionContextMenu, (event, selectionText: unknown) => {
    showSelectionContextMenu(event.sender, selectionText);
  });
  ipcMain.on(IPC.setOnboarded, () => {
    markOnboarded();
  });
  ipcMain.on(IPC.vibrancy, (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return;
    setVibrancyEnabled(enabled);
    applyWindowVibrancy(enabled);
    trackDesktopEvent('native_ipc_used', { channel: 'vibrancy' });
  });
  ipcMain.handle(IPC.getVibrancy, () => isVibrancyEnabled());
  ipcMain.handle(IPC.preventSystemSleep, async (_event, mode: unknown) => {
    if (!isSleepPreventionMode(mode)) return getPreventSleepState();
    const state = await setSystemSleepPreventionEnabled(mode);
    trackDesktopEvent('native_ipc_used', { channel: 'prevent-system-sleep' });
    return state;
  });
  ipcMain.handle(IPC.getPreventSystemSleep, () => isPowerSaveBlockerEnabled());
  ipcMain.handle(IPC.preventSleepState, () => getPreventSleepState());
  ipcMain.handle(IPC.setPreventLidSleep, async (_event, enabled: unknown) => {
    if (typeof enabled !== 'boolean') return getPreventSleepState();
    const state = await setLidSleepPreventionEnabled(enabled);
    trackDesktopEvent('native_ipc_used', { channel: 'prevent-lid-sleep' });
    return state;
  });
  ipcMain.handle(IPC.linuxNativeTitleBar, async (event, enabled: unknown) => {
    if (process.platform !== 'linux' || typeof enabled !== 'boolean') return { status: 'unavailable' };
    if (event.sender !== getMainWindow()?.webContents) return { status: 'unavailable' };
    if (await shouldBlockQuit(getMainWindow(), { interceptWindowClose: false })) {
      return { status: 'cancelled' };
    }
    setLinuxNativeTitleBar(enabled);
    if (isLinuxNativeTitleBar() !== enabled) return { status: 'error' };
    trackDesktopEvent('native_ipc_used', { channel: 'linux-native-titlebar' });
    setImmediate(() => {
      markQuitting();
      app.relaunch();
      app.quit();
    });
    return { status: 'relaunching' };
  });
  ipcMain.on(IPC.rendererLog, (event, payload: unknown) => {
    rendererLogWriter(payload, rendererLogSource(event.sender));
  });
  ipcMain.on(IPC.startupMilestone, (event, payload: unknown) => {
    if (isMainRendererSender(event.sender)) recordRendererMilestone(payload);
  });
  ipcMain.on(IPC.track, (_event, eventName: unknown, payload: unknown) => {
    const parsed = asRendererTrackEvent(eventName, payload);
    if (parsed !== null) {
      trackDesktopEvent(parsed.event, parsed.properties);
    }
  });
  initTerminalManager({
    locale: () => {
      try {
        return app.getLocale();
      } catch {
        return 'en';
      }
    },
    homeDir: homedir(),
    pathExists: (path) => existsSync(path),
    isDirectory: (path) => {
      try {
        return statSync(path).isDirectory();
      } catch {
        return false;
      }
    },
    pushOutput: (id, data) => sendToRenderer(IPC.terminalOutput, { id, data }),
    pushExit: (id, exitCode) => sendToRenderer(IPC.terminalExit, { id, exitCode }),
  });
  ipcMain.handle(IPC.terminalInspect, (event, ids: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('terminal-inspect: unknown sender');
    if (!Array.isArray(ids) || ids.length > 512 || !ids.every(id => typeof id === 'string' && id.length > 0 && id.length <= 128)) {
      throw new Error('terminal-inspect: invalid terminal ids');
    }
    return getTerminalManager().inspect([...new Set(ids)]);
  });
  ipcMain.handle(IPC.terminalCreate, async (event, payload: unknown) => {
    const win = getMainWindow();
    if (win === null || win.isDestroyed() || event.sender !== win.webContents) {
      throw new Error('terminal-create: unknown sender');
    }
    const manager = getTerminalManager();
    const gen = manager.generation();
    await startShellEnvProbe();
    const winAfter = getMainWindow();
    if (
      manager.generation() !== gen ||
      winAfter === null ||
      winAfter.isDestroyed() ||
      event.sender !== winAfter.webContents
    ) {
      throw new Error('terminal-create superseded by a renderer navigation');
    }
    return manager.create(asTerminalCreateOptions(payload));
  });
  ipcMain.on(IPC.terminalInput, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { id, data } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || id === '' || typeof data !== 'string') return;
    getTerminalManager().write(id, data);
  });
  ipcMain.on(IPC.terminalResize, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { id, cols, rows } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') return;
    if (typeof cols !== 'number' || !Number.isFinite(cols)) return;
    if (typeof rows !== 'number' || !Number.isFinite(rows)) return;
    getTerminalManager().resize(id, cols, rows);
  });
  ipcMain.on(IPC.terminalClose, (_event, payload: unknown) => {
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return;
    const { id } = payload as Record<string, unknown>;
    if (typeof id !== 'string' || id === '') return;
    getTerminalManager().close(id);
  });
  ipcMain.handle(IPC.browserGetSessions, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-get-sessions: unknown sender');
    return getBrowserSessions().getSessions();
  });
  ipcMain.handle(IPC.browserSaveSessions, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-save-sessions: unknown sender');
    const sessions = asBrowserPanelSessions(value);
    if (sessions === null) throw new Error('browser-save-sessions: invalid state');
    getBrowserSessions().saveSessions(sessions);
  });
  ipcMain.on(IPC.browserSuspend, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const id = asBrowserId(browserId);
    if (id !== null) suspendBrowser(id);
  });
  ipcMain.handle(IPC.browserGetState, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-get-state: unknown sender');
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-get-state: invalid browser id');
    return restoreBrowser(id);
  });
  ipcMain.handle(IPC.browserTabCommand, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-tab-command: unknown sender');
    if (!isBrowserTabCommand(payload)) throw new Error('browser-tab-command: invalid request');
    return browserTabCommand(payload);
  });
  ipcMain.handle(IPC.browserClone, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-clone: unknown sender');
    const request = asBrowserCloneRequest(payload);
    if (request === null) throw new Error('browser-clone: invalid browser ids');
    return cloneBrowser(request.sourceId, request.targetId);
  });
  ipcMain.handle(IPC.browserNavigate, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-navigate: unknown sender');
    const request = asBrowserNavigateRequest(payload);
    if (request === null) throw new Error('browser-navigate: invalid payload');
    takeOverBrowser(request.browserId);
    if (isLocalFileUrl(request.address) && takeLocalLinkGrant(request.address)) return openBrowserLocalFile(request.browserId, request.address);
    if (localFileAddressUrl(request.address) !== null) {
      const generation = getTerminalManager().generation();
      const tabGeneration = getBrowserGeneration(request.browserId);
      return localPagesAllowed().then((allowed) => {
        if (!allowed) throw new Error('browser-navigate: local pages need a build with file:// privileges turned off');
        if (getTerminalManager().generation() !== generation) return getBrowserState(request.browserId);
        if (getBrowserGeneration(request.browserId) !== tabGeneration) return getBrowserState(request.browserId);
        return navigateBrowser(request.browserId, request.address, { localFile: true });
      });
    }
    return navigateBrowser(request.browserId, request.address);
  });
  ipcMain.handle(IPC.browserLocalPagesAllowed, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-local-pages-allowed: unknown sender');
    return localPagesAllowed();
  });
  ipcMain.handle(IPC.browserOpenLocalFile, async (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-open-local-file: unknown sender');
    const request = asBrowserNavigateRequest(payload);
    if (request === null) throw new Error('browser-open-local-file: invalid payload');
    const generation = getTerminalManager().generation();
    if (!(await localPagesAllowed())) throw new Error('browser-open-local-file: local pages need a build with file:// privileges turned off');
    const url = await resolveLocalHtmlFileUrl(request.address, request.urlSuffix);
    if (!isMainRendererSender(event.sender)) throw new Error('browser-open-local-file: unknown sender');
    if (getTerminalManager().generation() !== generation) return;
    takeOverBrowser(request.browserId);
    let failure: string | undefined;
    try {
      failure = (await openBrowserLocalFile(request.browserId, url)).error;
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error);
    }
    if (getTerminalManager().generation() !== generation) {
      closeBrowser(request.browserId);
      return;
    }
    if (failure === undefined) return;
    closeBrowser(request.browserId);
    throw new Error(`browser-open-local-file: ${failure}`);
  });
  ipcMain.handle(IPC.browserBack, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-back: unknown sender');
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-back: invalid browser id');
    takeOverBrowser(id);
    return browserGoBack(id);
  });
  ipcMain.handle(IPC.browserForward, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-forward: unknown sender');
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-forward: invalid browser id');
    takeOverBrowser(id);
    return browserGoForward(id);
  });
  ipcMain.handle(IPC.browserReload, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-reload: unknown sender');
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-reload: invalid browser id');
    takeOverBrowser(id);
    return browserReload(id);
  });
  ipcMain.handle(IPC.browserFind, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-find: unknown sender');
    const request = pageValidators.find.Parse(payload);
    if (request === null) throw new Error('browser-find: invalid payload');
    takeOverBrowser(request.browserId);
    browserFind(request.browserId, request.text, { forward: request.forward, findNext: request.findNext });
  });
  ipcMain.handle(IPC.browserStopFind, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-stop-find: unknown sender');
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-stop-find: invalid browser id');
    browserStopFind(id);
  });
  ipcMain.handle(IPC.browserPrint, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-print: unknown sender');
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-print: invalid browser id');
    takeOverBrowser(id);
    return browserPrint(id);
  });
  ipcMain.handle(IPC.browserSetFocusEmulation, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown browser focus sender');
    const request = asBrowserFocusEmulationRequest(payload);
    if (request === null) throw new Error('Invalid focus emulation request');
    takeOverBrowser(request.browserId);
    return updateBrowserFocusEmulation(request.browserId, request.enabled);
  });
  ipcMain.handle(IPC.browserZoom, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-zoom: unknown sender');
    const request = asBrowserZoomRequest(payload);
    if (request === null) throw new Error('browser-zoom: invalid payload');
    takeOverBrowser(request.browserId);
    return browserZoom(request.browserId, request.action);
  });
  ipcMain.handle(IPC.browserToggleDeviceMode, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error('browser-toggle-device-mode: unknown sender');
    }
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-toggle-device-mode: invalid browser id');
    takeOverBrowser(id);
    return toggleBrowserDeviceMode(id);
  });
  ipcMain.handle(IPC.browserSetDeviceMode, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error('browser-set-device-mode: unknown sender');
    }
    const update = asBrowserDeviceModeUpdate(payload);
    if (update === null) throw new Error('browser-set-device-mode: invalid payload');
    takeOverBrowser(update.browserId);
    return updateBrowserDeviceMode(update.browserId, update.request);
  });
  ipcMain.handle(IPC.browserSetOccluded, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-set-occluded: unknown sender');
    const request = asBrowserOcclusionRequest(payload);
    if (request === null) throw new Error('browser-set-occluded: invalid request');
    setBrowserOccluded(request.browserId, request.occluded);
  });
  ipcMain.handle(IPC.browserCaptureScreenshot, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error('browser-capture-screenshot: unknown sender');
    }
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-capture-screenshot: invalid browser id');
    takeOverBrowser(id);
    return captureBrowserScreenshot(id);
  });
  ipcMain.handle(IPC.browserFocusChrome, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown browser focus sender');
    const host = getMainWindow();
    if (host?.isFocused()) host.webContents.focus();
  });
  ipcMain.handle(IPC.browserGetPermissionRequests, event => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown browser permission sender');
    return getBrowserPermissionRequests();
  });
  ipcMain.handle(IPC.browserResolvePermissionRequest, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender) || !siteValidators.BrowserPermissionDecisionSchema.Check(value)) throw new Error('Invalid browser permission decision');
    return resolveBrowserPermissionRequest(value);
  });
  ipcMain.handle(IPC.browserGetPageDialogs, event => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown browser dialog sender');
    return listBrowserDialogs();
  });
  ipcMain.handle(IPC.browserAnswerPageDialog, async (event, value: unknown) => {
    if (!isMainRendererSender(event.sender) || !dialogValidators.BrowserPageDialogAnswerSchema.Check(value)) throw new Error('Invalid browser dialog answer');
    return await respondBrowserDialog(value.dialogId, { accept: value.accept, ...(value.text === undefined || !value.accept ? {} : { text: value.text }) }, 'user') === 'answered';
  });
  ipcMain.handle(IPC.browserGetSites, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown site settings sender');
    return getBrowserSites();
  });
  ipcMain.handle(IPC.browserGetSite, (event, value: unknown) => {
    const origin = browserSiteOrigin(value);
    if (!isMainRendererSender(event.sender) || origin === null) throw new Error('Invalid site');
    return getBrowserSite(origin);
  });
  ipcMain.handle(IPC.browserSetSitePermission, (event, value: unknown) => {
    const update = asBrowserSitePermissionUpdate(value);
    if (!isMainRendererSender(event.sender) || update === null) throw new Error('Invalid site permission');
    return updateBrowserSitePermission(update.origin, update.permission, update.setting);
  });
  ipcMain.handle(IPC.browserSetSiteAutoplay, (event, value: unknown) => {
    const update = asBrowserSiteAutoplayUpdate(value);
    if (!isMainRendererSender(event.sender) || update === null) throw new Error('Invalid site autoplay setting');
    return updateBrowserSiteAutoplay(update.origin, update.setting).then(site => {
      applyBrowserAutoplayPolicy();
      return site;
    });
  });
  ipcMain.handle(IPC.browserSetSiteSound, (event, value: unknown) => {
    const update = asBrowserSiteSoundUpdate(value);
    if (!isMainRendererSender(event.sender) || update === null) throw new Error('Invalid site sound setting');
    return updateBrowserSiteSound(update.origin, update.setting).then(site => {
      applyBrowserSound();
      return site;
    });
  });
  ipcMain.handle(IPC.browserClearSiteData, (event, value: unknown) => {
    const origin = browserSiteOrigin(value);
    if (!isMainRendererSender(event.sender) || origin === null) throw new Error('Invalid site');
    for (const browserId of browserIdsForSite(origin)) takeOverBrowser(browserId);
    return clearBrowserSiteData(origin);
  });
  ipcMain.handle(IPC.browserGetSystemPermissionStates, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown system permission sender');
    return getBrowserSystemPermissionDenials();
  });
  ipcMain.handle(IPC.browserOpenSystemPermissionSettings, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender) || !isBrowserSitePermission(value)) throw new Error('Invalid system permission settings request');
    return openBrowserSystemPermissionSettings(value);
  });
  ipcMain.handle(IPC.browserGetData, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-get-data: unknown sender');
    return getBrowserData();
  });
  ipcMain.handle(IPC.browserUpdatePreferences, (event, patch: unknown) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error('browser-update-preferences: unknown sender');
    }
    if (!isBrowserPreferencesPatch(patch)) {
      throw new Error('browser-update-preferences: invalid payload');
    }
    const raw = patch;
    const next = updateBrowserPreferences(raw);
    if (raw.agentControl !== undefined) setBrowserAgentControl(next.preferences.agentControl);
    if (raw.subagentControl !== undefined) setBrowserSubagentControl(next.preferences.subagentControl);
    if (raw['defaultZoomFactor'] !== undefined) {
      takeOverAllBrowsers();
      applyDefaultBrowserZoom(next.preferences.defaultZoomFactor);
    }
    if (raw['customUserAgent'] !== undefined) applyBrowserUserAgentPreference();
    if (raw.autoplay !== undefined) {
      applyBrowserAutoplayPolicy();
      trackDesktopEvent('settings_changed', { key: 'browser-autoplay', value: next.preferences.autoplay, source_panel: 'settings' });
    }
    if (raw.sound !== undefined) {
      applyBrowserSound();
      trackDesktopEvent('settings_changed', { key: 'browser-sound', value: next.preferences.sound, source_panel: 'settings' });
    }
    return next;
  });
  ipcMain.handle(IPC.browserChooseAgentDownloadDirectory, async (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-choose-agent-download-directory: unknown sender');
    const win = getMainWindow();
    const options: OpenDialogOptions = { properties: ['openDirectory', 'createDirectory'], defaultPath: getBrowserData().agentDownloads?.path };
    const result = await (win === null || win.isDestroyed() ? dialog.showOpenDialog(options) : dialog.showOpenDialog(win, options));
    const directory = result.filePaths[0];
    return result.canceled || directory === undefined || directory.length > 4096 ? getBrowserData() : setBrowserAgentDownloadDirectory(directory);
  });
  ipcMain.handle(IPC.browserCheckDownloadsAccess, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-check-downloads-access: unknown sender');
    return checkBrowserDownloadsAccess();
  });
  ipcMain.handle(IPC.browserClearHistory, (event) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error('browser-clear-history: unknown sender');
    }
    forgetBrowserSiteVisits();
    return clearBrowserHistory();
  });
  ipcMain.handle(IPC.browserClearDownloads, (event) => {
    if (!isMainRendererSender(event.sender)) {
      throw new Error('browser-clear-downloads: unknown sender');
    }
    return clearBrowserDownloads();
  });
  ipcMain.handle(IPC.browserOpenDownload, (event, payload: unknown) => {
    const request = isMainRendererSender(event.sender) ? asBrowserDownloadAction(payload) : null;
    if (request === null) throw new Error('browser-open-download: invalid request');
    if (request.action === 'retry') return retryBrowserViewDownload(request.id);
    if (request.action !== 'open' && request.action !== 'show') return controlBrowserDownload({ id: request.id, action: request.action });
    return openBrowserDownload({ id: request.id, action: request.action }, {
      shell,
      showMessageBox: async (options) => {
        const host = getMainWindow();
        if (host === null || host.isDestroyed()) return options.cancelId ?? -1;
        return (await dialog.showMessageBox(host, options)).response;
      },
      strings: () => (effectiveContextMenuLocale() === 'zh' ? browserZh : browserEn).downloads,
    });
  });
  ipcMain.handle(IPC.browserRemoveDownload, (event, id: unknown) => {
    if (!isMainRendererSender(event.sender) || !isBrowserDownloadId(id)) throw new Error('browser-remove-download: invalid request');
    return removeBrowserDownload(id);
  });
  ipcMain.handle(IPC.browserGetDownloads, (event) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-get-downloads: unknown sender');
    return readBrowserDownloads();
  });
  let downloadsWatched = false;
  let downloadsWatcher: WebContents | null = null;
  ipcMain.on(IPC.browserWatchDownloads, (event, watch: unknown) => {
    if (!isMainRendererSender(event.sender) || !isBrowserDownloadsWatch(watch)) return;
    downloadsWatched = watch;
    if (!watch || downloadsWatcher === event.sender) return;
    const contents = event.sender;
    downloadsWatcher = contents;
    const reset = (): void => {
      contents.removeListener('did-start-loading', reset);
      contents.removeListener('destroyed', reset);
      if (downloadsWatcher !== contents) return;
      downloadsWatcher = null;
      downloadsWatched = false;
    };
    contents.on('did-start-loading', reset);
    contents.on('destroyed', reset);
  });
  onBrowserDownloadsChanged(() => {
    if (downloadsWatched) sendToRenderer(IPC.browserDownloads, getBrowserDownloadItems());
  });
  ipcMain.handle(IPC.browserClearData, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('browser-clear-data: unknown sender');
    const id = asBrowserId(browserId);
    if (id === null) throw new Error('browser-clear-data: invalid browser id');
    takeOverAllBrowsers();
    return clearBrowserData(id);
  });
  ipcMain.handle(IPC.browserPickAnnotation, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown annotation sender');
    const request = asBrowserAnnotationPickRequest(payload);
    if (request === null) throw new Error('Invalid annotation request');
    takeOverBrowser(request.browserId);
    return pickBrowserAnnotation(request.browserId, request.options);
  });
  ipcMain.on(IPC.browserCancelAnnotationPick, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const id = asBrowserId(value);
    if (id !== null) cancelBrowserAnnotationPick(id);
  });
  ipcMain.handle(IPC.browserCompleteAnnotationCapture, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown annotation sender');
    const raw = annotationValidators.completion.Parse(payload);
    if (raw === null) throw new Error('Invalid annotation completion request');
    return completeBrowserAnnotationCapture(raw.id, raw.action);
  });
  ipcMain.handle(IPC.browserCollectAnnotationAssets, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown annotation sender');
    const retained = annotationValidators.retainedAssets.Parse(value);
    if (retained === null) throw new Error('Invalid annotation collection request');
    return collectBrowserAnnotationAssets(retained);
  });
  ipcMain.handle(IPC.browserReadAnnotationAsset, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender) || !annotationValidators.referenceId.Check(value)) throw new Error('Invalid annotation asset request');
    return readBrowserAnnotationAsset(value);
  });
  ipcMain.handle(IPC.browserReadReceipt, (event, payload: unknown) => {
    const request = isMainRendererSender(event.sender) ? receiptValidators.read.Parse(payload) : null;
    if (request === null) throw new Error('Invalid receipt request');
    return readBrowserReceipt(request.sessionId, request.receiptId);
  });
  ipcMain.handle(IPC.browserDeleteReceipts, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender) || !receiptValidators.sessionId.Check(value)) throw new Error('Invalid receipt request');
    return deleteBrowserReceipts(value);
  });
  ipcMain.handle(IPC.browserCopyReceipts, (event, payload: unknown) => {
    const request = isMainRendererSender(event.sender) ? receiptValidators.copy.Parse(payload) : null;
    if (request === null) throw new Error('Invalid receipt request');
    return copyBrowserReceipts(request.sourceId, request.targetId);
  });
  ipcMain.handle(IPC.browserShowAnnotation, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) throw new Error('Unknown annotation sender');
    const raw = annotationValidators.marker.Parse(payload);
    if (raw === null) throw new Error('Invalid annotation marker request');
    return showBrowserAnnotation(raw.id, raw.ordinal, raw.locate);
  });
  ipcMain.on(IPC.browserHideAnnotation, (event, value: unknown) => {
    if (!isMainRendererSender(event.sender) || !annotationValidators.referenceId.Check(value)) return;
    void hideBrowserAnnotation(value);
  });
  ipcMain.on(IPC.browserSetBounds, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const request = asBrowserBoundsRequest(payload);
    if (request !== null) setBrowserBounds(request.browserId, request.bounds);
  });
  ipcMain.on(IPC.browserControlReady, event => markBrowserControlReady(event.sender));
  ipcMain.on(IPC.browserControlTakeover, (event, payload: unknown) => handleBrowserControlTakeover(event.sender, payload));
  ipcMain.on(IPC.browserControlDownload, (event, payload: unknown) => handleBrowserControlDownload(event.sender, payload));
  ipcMain.on(IPC.browserSetControls, (event, payload: unknown) => {
    if (isMainRendererSender(event.sender) && isBrowserControlConfig(payload)) setBrowserControls(payload);
  });
  ipcMain.on(IPC.browserSetVisible, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const request = asBrowserVisibilityRequest(payload);
    if (request !== null) setBrowserVisible(request.browserId, request.visible);
  });
  ipcMain.on(IPC.browserClose, (event, browserId: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const id = asBrowserId(browserId);
    if (id === null) return;
    takeOverClosedBrowser(id);
    closeBrowser(id);
  });
  ipcMain.on(IPC.browserAutomationUiResponse, (event, payload: unknown) => {
    handleBrowserUiResponse(event.sender, payload);
  });
  ipcMain.on(IPC.browserOverlayOpen, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const request = asBrowserOverlayMenuRequest(payload);
    if (request !== null) openBrowserOverlayMenu(request);
  });
  ipcMain.on(IPC.browserOverlayClose, (event, menuId: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const id = asBrowserOverlayMenuId(menuId);
    if (id !== null) closeBrowserOverlayMenu(id);
  });
  ipcMain.on(IPC.browserOverlayDialogOpen, (event, payload: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const request = asBrowserOverlayDialogRequest(payload);
    if (request !== null) openBrowserOverlayDialog(request);
  });
  ipcMain.on(IPC.browserOverlayDialogClose, (event, dialogId: unknown) => {
    if (!isMainRendererSender(event.sender)) return;
    const id = asBrowserOverlayMenuId(dialogId);
    if (id !== null) closeBrowserOverlayDialog(id, 'programmatic');
  });
  ipcMain.on(IPC.browserOverlayReady, (event) => {
    if (isBrowserOverlaySender(event.sender)) markBrowserOverlayReady(event.sender);
  });
  ipcMain.on(IPC.browserOverlayRendered, (event, payload: unknown) => {
    if (!isBrowserOverlaySender(event.sender)) return;
    const rendered = asBrowserOverlayRendered(payload);
    if (rendered !== null) showBrowserOverlayRendered(event.sender, rendered);
  });
  ipcMain.on(IPC.browserOverlayHidden, (event, payload: unknown) => {
    if (!isBrowserOverlaySender(event.sender)) return;
    const hidden = asBrowserOverlayVisibilityRequest(payload);
    if (hidden !== null) markBrowserOverlayHidden(event.sender, hidden);
  });
  ipcMain.on(IPC.browserOverlayActivate, (event, payload: unknown) => {
    if (!isBrowserOverlaySender(event.sender)) return;
    const request = asBrowserOverlayActivateRequest(payload);
    if (request !== null) activateBrowserOverlayItem(event.sender, request);
  });
  ipcMain.on(IPC.browserOverlayFormAction, (event, raw: unknown) => {
    if (!isBrowserOverlaySender(event.sender)) return;
    const action = asBrowserOverlayFormAction(raw);
    if (action !== null) submitBrowserOverlayForm(event.sender, action);
  });
  ipcMain.on(IPC.browserOverlayDismiss, (event, payload: unknown) => {
    if (!isBrowserOverlaySender(event.sender)) return;
    const request = asBrowserOverlayDismissRequest(payload);
    if (request !== null) dismissBrowserOverlay(event.sender, request);
  });
}
