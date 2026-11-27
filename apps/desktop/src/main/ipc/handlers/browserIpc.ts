import { browserIdsForSite, clearBrowserSiteData } from '../../browser/browser-view';
import { browserValidators as annotationValidators } from '../../../shared/browser-annotation';
import { isBrowserTabCommand } from '../../../shared/browser';
import { isBrowserControlConfig } from '../../../shared/browser-control';
import { handleBrowserControlDownload, handleBrowserControlTakeover, markBrowserControlReady, setBrowserControls, takeOverAllBrowsers, takeOverBrowser, takeOverClosedBrowser } from '../../browser/browser-control';
import { forgetBrowserSiteVisits, getBrowserPermissionRequests, resolveBrowserPermissionRequest, getBrowserSite, getBrowserSites, updateBrowserSiteAutoplay, updateBrowserSitePermission, updateBrowserSiteSound } from '../../browser/browser-sites';
import { listBrowserDialogs, respondBrowserDialog } from '../../browser/browser-dialogs';
import { browserValidators as dialogValidators } from '../../../shared/browser-dialogs';
import { getBrowserSystemPermissionDenials, openBrowserSystemPermissionSettings } from '../../browser/browser-system-permissions';
import { browserValidators as siteValidators, asBrowserSiteAutoplayUpdate, asBrowserSitePermissionUpdate, asBrowserSiteSoundUpdate, browserSiteOrigin, isBrowserSitePermission } from '../../../shared/browser-sites';
import { asBrowserDownloadAction, isBrowserDownloadId, isBrowserDownloadsWatch, isBrowserPreferencesPatch } from '../../../shared/browser-data';
import { app, dialog, ipcMain, shell } from 'electron';
import type { OpenDialogOptions, WebContents } from 'electron';
import { join } from 'node:path';
import { asBrowserPanelSessions } from '../../../shared/browser-panel-state';
import { BrowserSessionStore } from '../../browser/browser-session-store';
import { localFileAddressUrl, resolveLocalHtmlFileUrl } from '../../browser/browser-local-file';
import { createLocalPagesPolicy } from '../../browser/local-pages-policy';
import { asBrowserAnnotationPickRequest } from '../../../shared/browser-annotation';
import { collectBrowserAnnotationAssets, completeBrowserAnnotationCapture, cancelBrowserAnnotationPick, hideBrowserAnnotation, pickBrowserAnnotation, readBrowserAnnotationAsset, showBrowserAnnotation } from '../../browser/browser-annotations';
import { getMainWindow, sendToRenderer } from '../../window/main-window';
import { getTerminalManager } from '../../terminal/manager';
import { effectiveContextMenuLocale } from '../../shell/context-menu';
import { browserEn, browserZh } from '@moonshot-ai/app-i18n/browser';
import { setBrowserAgentControl, setBrowserSubagentControl } from '../../browser/browser-agent-control';
import { log } from '../../diagnostics/log';
import { trackDesktopEvent } from '../../diagnostics/track';
import { IPC } from '../ipc-channels';
import { isMainRendererSender } from '../sender';
import { browserValidators as pageValidators, asBrowserCloneRequest, asBrowserNavigateRequest, asBrowserFocusEmulationRequest, asBrowserBoundsRequest, asBrowserId, asBrowserOcclusionRequest, asBrowserVisibilityRequest, asBrowserZoomRequest } from '../../../shared/browser';
import { asBrowserDeviceModeUpdate } from '../../../shared/browser-device';
import {
  asBrowserOverlayFormAction,
  asBrowserOverlayMenuId,
  asBrowserOverlayActivateRequest,
  asBrowserOverlayDismissRequest,
  asBrowserOverlayDialogRequest,
  asBrowserOverlayMenuRequest,
  asBrowserOverlayRendered,
  asBrowserOverlayVisibilityRequest,
} from '../../../shared/browser-overlay';
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
} from '../../browser/browser-view';
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
} from '../../browser/browser-data';
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
} from '../../browser/browser-overlay';
import { handleBrowserUiResponse } from '../../browser/browser-automation';
import { browserValidators as receiptValidators } from '../../../shared/browser-receipt';
import { copyBrowserReceipts, deleteBrowserReceipts, readBrowserReceipt } from '../../browser/browser-receipts';

export function registerBrowserIpc(): void {
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
