import { ipcRenderer } from 'electron';
import {
  asBrowserAnnotationPickOptions,
  asBrowserAnnotationPickRequest,
  browserValidators as annotationValidators,
  type BrowserAnnotationAsset,
  type BrowserAnnotationCaptureAction,
  type BrowserAnnotationContextRequest,
  type BrowserAnnotationLocation,
  type BrowserAnnotationPickOptions,
  type BrowserAnnotationPickResult,
} from '../../../shared/browser-annotation';
import { browserValidators as receiptValidators, type BrowserReceiptImage } from '../../../shared/browser-receipt';
import {
  browserValidators as pageValidators,
  asBrowserCloneRequest,
  asBrowserNavigateRequest,
  asBrowserFocusEmulationRequest,
  EMPTY_BROWSER_STATE,
  isBrowserState,
  asBrowserId,
  asBrowserBoundsRequest,
  asBrowserOcclusionRequest,
  asBrowserVisibilityRequest,
  asBrowserZoomRequest,
  isBrowserStateEvent,
  isBrowserTabCommand,
  type BrowserBounds,
  type BrowserId,
  type BrowserState,
  type BrowserTabCommand,
} from '../../../shared/browser';
import {
  browserValidators as siteValidators,
  asBrowserSiteAutoplayUpdate,
  asBrowserSiteInfo,
  asBrowserSiteSoundUpdate,
  asBrowserSitePermissionUpdate,
  asBrowserSystemPermissionStates,
  browserSiteOrigin,
  isBrowserSitePermission,
  type BrowserPermissionRequest,
  type BrowserPermissionDecision,
  type BrowserSiteInfo,
  type BrowserSitePermission,
  type BrowserSitePermissionSetting,
} from '../../../shared/browser-sites';
import {
  browserValidators as dialogValidators,
  type BrowserPageDialog,
  type BrowserPageDialogAnswer,
} from '../../../shared/browser-dialogs';
import {
  isBrowserControlConfig,
  isBrowserControlOwnership,
  type BrowserControlOwnership,
  type BrowserControlConfig,
} from '../../../shared/browser-control';
import {
  asBrowserOverlayMenuId,
  asBrowserOverlayDialogRequest,
  isBrowserOverlayMenuOpenInput,
  isBrowserOverlayAction,
  isBrowserOverlayClosed,
  isBrowserOverlayDialogAction,
  isBrowserOverlayDialogClosed,
  type BrowserOverlayAction,
  type BrowserOverlayClosed,
  type BrowserOverlayDialogAction,
  type BrowserOverlayDialogClosed,
  type BrowserOverlayDialogRequest,
  type BrowserOverlayMenuRequest,
} from '../../../shared/browser-overlay';
import {
  asBrowserDeviceModeRequest,
  asBrowserDeviceModeUpdate,
  type BrowserDeviceModeRequest,
} from '../../../shared/browser-device';
import type { BrowserSiteAutoplay } from '../../../shared/browser-autoplay';
import type { BrowserSiteSound } from '../../../shared/browser-sound';
import {
  asBrowserDownloadAction,
  isBrowserDataSnapshot,
  isBrowserDownloadId,
  isBrowserDownloadItems,
  isBrowserDownloadsWatch,
  isBrowserPreferencesPatch,
  type BrowserDataSnapshot,
  type BrowserDownloadAction,
  type BrowserDownloadItem,
  type BrowserPreferencesPatch,
} from '../../../shared/browser-data';
import type { BrowserPanelSession } from '@moonshot-ai/app-core/browser-panel-state';
import { asBrowserPanelSessions } from '../../../shared/browser-panel-state';
import {
  isBrowserUiRequest,
  isBrowserUiResponse,
  type BrowserUiRequest,
  type BrowserUiResponse,
} from '../../../shared/browser-automation-ui';

export type BrowserBridge = {
  browserOverlaySupported: boolean;
  getBrowserState: (browserId: BrowserId) => Promise<BrowserState>;
  browserNavigate: (browserId: BrowserId, address: string) => Promise<BrowserState>;
  browserOpenLocalFile: (browserId: BrowserId, target: string, urlSuffix?: string) => Promise<void>;
  browserLocalPagesAllowed: () => Promise<boolean>;
  browserBack: (browserId: BrowserId) => Promise<BrowserState>;
  browserForward: (browserId: BrowserId) => Promise<BrowserState>;
  browserReload: (browserId: BrowserId) => Promise<BrowserState>;
  browserFind: (
    browserId: BrowserId,
    text: string,
    options: { forward: boolean; findNext: boolean },
  ) => Promise<void>;
  browserStopFind: (browserId: BrowserId) => Promise<void>;
  browserPrint: (browserId: BrowserId) => Promise<boolean>;
  browserZoom: (
    browserId: BrowserId,
    action: 'in' | 'out' | 'reset',
  ) => Promise<BrowserState>;
  browserToggleDeviceMode: (browserId: BrowserId) => Promise<BrowserState>;
  browserSetDeviceMode: (
    browserId: BrowserId,
    request: BrowserDeviceModeRequest,
  ) => Promise<BrowserState>;
  browserCaptureScreenshot: (browserId: BrowserId) => Promise<boolean>;
  browserPickAnnotation: (browserId: BrowserId, options: BrowserAnnotationPickOptions) => Promise<BrowserAnnotationPickResult | null>;
  browserCancelAnnotationPick: (browserId: BrowserId) => void;
  browserCompleteAnnotationCapture: (id: string, action: BrowserAnnotationCaptureAction) => Promise<void>;
  browserCollectAnnotationAssets: (retained: string[]) => Promise<void>;
  browserReadAnnotationAsset: (assetId: string) => Promise<BrowserAnnotationAsset>;
  browserReadReceipt: (sessionId: string, receiptId: string) => Promise<BrowserReceiptImage | null>;
  browserDeleteReceipts: (sessionId: string) => Promise<void>;
  browserCopyReceipts: (sourceId: string, targetId: string) => Promise<void>;
  browserShowAnnotation: (id: string, ordinal: number, locate: boolean) => Promise<BrowserAnnotationLocation>;
  browserHideAnnotation: (id: string) => void;
  browserFocusChrome: () => Promise<void>;
  browserGetSites: () => Promise<BrowserSiteInfo[]>;
  browserGetSite: (url: string) => Promise<BrowserSiteInfo>;
  browserGetPermissionRequests: () => Promise<BrowserPermissionRequest[]>;
  browserResolvePermissionRequest: (decision: BrowserPermissionDecision) => Promise<boolean>;
  onBrowserPermissionRequests: (cb: (requests: BrowserPermissionRequest[]) => void) => () => void;
  browserGetPageDialogs: () => Promise<BrowserPageDialog[]>;
  browserAnswerPageDialog: (answer: BrowserPageDialogAnswer) => Promise<boolean>;
  onBrowserPageDialogs: (cb: (dialogs: BrowserPageDialog[]) => void) => () => void;
  browserSetSitePermission: (origin: string, permission: BrowserSitePermission, setting: BrowserSitePermissionSetting) => Promise<BrowserSiteInfo>;
  browserSetSiteAutoplay: (origin: string, setting: BrowserSiteAutoplay) => Promise<BrowserSiteInfo>;
  browserSetSiteSound: (origin: string, setting: BrowserSiteSound) => Promise<BrowserSiteInfo>;
  browserClearSiteData: (origin: string) => Promise<BrowserSiteInfo>;
  browserGetSystemPermissionStates: () => Promise<BrowserSitePermission[]>;
  browserOpenSystemPermissionSettings: (permission: BrowserSitePermission) => Promise<void>;
  browserGetData: () => Promise<BrowserDataSnapshot>;
  browserUpdatePreferences: (patch: BrowserPreferencesPatch) => Promise<BrowserDataSnapshot>;
  browserChooseAgentDownloadDirectory: () => Promise<BrowserDataSnapshot>;
  browserCheckDownloadsAccess: () => Promise<BrowserDataSnapshot>;
  browserClearHistory: () => Promise<BrowserDataSnapshot>;
  browserClearDownloads: () => Promise<BrowserDataSnapshot>;
  browserOpenDownload: (id: string, action: BrowserDownloadAction['action']) => Promise<boolean>;
  browserGetDownloads: () => Promise<BrowserDownloadItem[]>;
  browserRemoveDownload: (id: string) => Promise<boolean>;
  browserWatchDownloads: (watch: boolean) => void;
  onBrowserDownloads: (cb: (downloads: BrowserDownloadItem[]) => void) => () => void;
  browserClearData: (browserId: BrowserId) => Promise<BrowserState>;
  browserSetBounds: (browserId: BrowserId, bounds: BrowserBounds) => void;
  browserSetOccluded: (browserId: BrowserId, occluded: boolean) => Promise<void>;
  browserSetFocusEmulation: (browserId: BrowserId, enabled: boolean) => Promise<BrowserState>;
  browserSetControls: (config: BrowserControlConfig) => void;
  onBrowserControlOwnership: (cb: (state: BrowserControlOwnership) => void) => () => void;
  browserSetVisible: (browserId: BrowserId, visible: boolean) => void;
  browserGetSessions: () => Promise<BrowserPanelSession[]>;
  browserSaveSessions: (sessions: BrowserPanelSession[]) => Promise<void>;
  browserSuspend: (browserId: BrowserId) => void;
  browserClose: (browserId: BrowserId) => void;
  browserClone: (sourceId: BrowserId, targetId: BrowserId) => Promise<BrowserState>;
  browserTabCommand: (request: BrowserTabCommand) => Promise<BrowserState>;
  onBrowserOpenLinkRequested: (cb: (request: { browserId: BrowserId; url: string; background?: boolean }) => void) => () => void;
  onBrowserCloseRequested: (cb: (browserId: BrowserId) => void) => () => void;
  onBrowserAnnotationRequested: (cb: (request: BrowserAnnotationContextRequest) => void) => () => void;
  onBrowserState: (cb: (browserId: BrowserId, state: BrowserState) => void) => () => void;
  onBrowserAutomationUiRequest: (cb: (request: BrowserUiRequest) => void) => () => void;
  browserAutomationUiRespond: (response: BrowserUiResponse) => void;
  browserOverlayOpenMenu: (request: BrowserOverlayMenuRequest) => void;
  browserOverlayCloseMenu: (menuId: string) => void;
  onBrowserOverlayAction: (cb: (payload: BrowserOverlayAction) => void) => () => void;
  onBrowserOverlayClosed: (cb: (payload: BrowserOverlayClosed) => void) => () => void;
  browserOverlayOpenDialog: (request: BrowserOverlayDialogRequest) => void;
  browserOverlayCloseDialog: (dialogId: string) => void;
  onBrowserOverlayDialogAction: (cb: (payload: BrowserOverlayDialogAction) => void) => () => void;
  onBrowserOverlayDialogClosed: (cb: (payload: BrowserOverlayDialogClosed) => void) => () => void;
};

export const browserBridge: BrowserBridge = {
  browserOverlaySupported: process.argv.includes('--kimi-native-overlay-host'),
  browserGetSessions: async () => {
    const sessions = asBrowserPanelSessions(await ipcRenderer.invoke('kimi:browser-get-sessions'));
    if (sessions === null) throw new Error('browser-get-sessions: invalid response');
    return sessions;
  },
  browserSaveSessions: async (value) => {
    const sessions = asBrowserPanelSessions(value);
    if (sessions === null) throw new Error('browser-save-sessions: invalid state');
    await ipcRenderer.invoke('kimi:browser-save-sessions', sessions);
  },
  browserSuspend: (browserId) => {
    const id = asBrowserId(browserId);
    if (id !== null) ipcRenderer.send('kimi:browser-suspend', id);
  },
  getBrowserState: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id === null) return { ...EMPTY_BROWSER_STATE };
    const next: unknown = await ipcRenderer.invoke('kimi:browser-get-state', id);
    return isBrowserState(next) ? next : { ...EMPTY_BROWSER_STATE };
  },
  browserNavigate: async (browserId, address) => {
    const request = asBrowserNavigateRequest({ browserId, address });
    if (request === null) throw new Error('browser-navigate: invalid address');
    const next: unknown = await ipcRenderer.invoke('kimi:browser-navigate', request);
    if (!isBrowserState(next)) throw new Error('browser-navigate: invalid response');
    return next;
  },
  browserOpenLocalFile: async (browserId, target, urlSuffix) => {
    const request = asBrowserNavigateRequest({ browserId, address: target, ...(typeof urlSuffix === 'string' && urlSuffix !== '' ? { urlSuffix } : {}) });
    if (request === null) throw new Error('browser-open-local-file: invalid request');
    await ipcRenderer.invoke('kimi:browser-open-local-file', request);
  },
  browserLocalPagesAllowed: async () => (await ipcRenderer.invoke('kimi:browser-local-pages-allowed')) === true,
  browserTabCommand: async (request) => {
    if (!isBrowserTabCommand(request)) throw new Error('browser-tab-command: invalid request');
    const next: unknown = await ipcRenderer.invoke('kimi:browser-tab-command', request);
    if (!isBrowserState(next)) throw new Error('browser-tab-command: invalid response');
    return next;
  },
  browserClone: async (sourceId, targetId) => {
    const request = asBrowserCloneRequest({ sourceId, targetId });
    if (request === null) throw new Error('browser-clone: invalid browser ids');
    const next: unknown = await ipcRenderer.invoke('kimi:browser-clone', request);
    if (!isBrowserState(next)) throw new Error('browser-clone: invalid response');
    return next;
  },
  browserBack: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id === null) return { ...EMPTY_BROWSER_STATE };
    const next: unknown = await ipcRenderer.invoke('kimi:browser-back', id);
    return isBrowserState(next) ? next : { ...EMPTY_BROWSER_STATE };
  },
  browserForward: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id === null) return { ...EMPTY_BROWSER_STATE };
    const next: unknown = await ipcRenderer.invoke('kimi:browser-forward', id);
    return isBrowserState(next) ? next : { ...EMPTY_BROWSER_STATE };
  },
  browserReload: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id === null) return { ...EMPTY_BROWSER_STATE };
    const next: unknown = await ipcRenderer.invoke('kimi:browser-reload', id);
    return isBrowserState(next) ? next : { ...EMPTY_BROWSER_STATE };
  },
  browserFind: async (browserId, text, options) => {
    const request = pageValidators.find.Parse({ browserId, text, forward: options?.forward, findNext: options?.findNext });
    if (request === null) throw new Error('browser-find: invalid request');
    await ipcRenderer.invoke('kimi:browser-find', request);
  },
  browserStopFind: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id !== null) await ipcRenderer.invoke('kimi:browser-stop-find', id);
  },
  browserPrint: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id === null) return false;
    return (await ipcRenderer.invoke('kimi:browser-print', id)) === true;
  },
  browserZoom: async (browserId, action) => {
    const request = asBrowserZoomRequest({ browserId, action });
    if (request === null) return { ...EMPTY_BROWSER_STATE };
    const next: unknown = await ipcRenderer.invoke('kimi:browser-zoom', request);
    return isBrowserState(next) ? next : { ...EMPTY_BROWSER_STATE };
  },
  browserToggleDeviceMode: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id === null) return { ...EMPTY_BROWSER_STATE };
    const next: unknown = await ipcRenderer.invoke('kimi:browser-toggle-device-mode', id);
    return isBrowserState(next) ? next : { ...EMPTY_BROWSER_STATE };
  },
  browserSetDeviceMode: async (browserId, request) => {
    const update = asBrowserDeviceModeUpdate({ browserId, request: asBrowserDeviceModeRequest(request) });
    if (update === null) return { ...EMPTY_BROWSER_STATE };
    const next: unknown = await ipcRenderer.invoke('kimi:browser-set-device-mode', update);
    return isBrowserState(next) ? next : { ...EMPTY_BROWSER_STATE };
  },
  browserPickAnnotation: async (browserId, options) => {
    const request = asBrowserAnnotationPickRequest({ browserId, options: asBrowserAnnotationPickOptions(options) });
    if (request === null) throw new Error('Invalid annotation request');
    return ipcRenderer.invoke('kimi:browser-pick-annotation', request) as Promise<BrowserAnnotationPickResult | null>;
  },
  browserCancelAnnotationPick: (browserId) => {
    const id = asBrowserId(browserId);
    if (id !== null) ipcRenderer.send('kimi:browser-cancel-annotation-pick', id);
  },
  browserCompleteAnnotationCapture: async (id, action) => {
    if (!annotationValidators.completion.Check({ id, action })) throw new Error('Invalid annotation completion request');
    await ipcRenderer.invoke('kimi:browser-complete-annotation-capture', { id, action });
  },
  browserCollectAnnotationAssets: async (retained) => {
    const ids = annotationValidators.retainedAssets.Parse(retained);
    if (ids === null) throw new Error('Invalid annotation collection request');
    await ipcRenderer.invoke('kimi:browser-collect-annotation-assets', ids);
  },
  browserReadAnnotationAsset: async (id) => {
    if (!annotationValidators.referenceId.Check(id)) throw new Error('Invalid annotation asset id');
    return ipcRenderer.invoke('kimi:browser-read-annotation-asset', id) as Promise<BrowserAnnotationAsset>;
  },
  browserReadReceipt: async (sessionId, receiptId) => {
    if (!receiptValidators.read.Check({ sessionId, receiptId })) return null;
    const image: unknown = await ipcRenderer.invoke('kimi:browser-read-receipt', { sessionId, receiptId });
    return receiptValidators.image.Check(image) ? image : null;
  },
  browserDeleteReceipts: async (sessionId) => {
    if (receiptValidators.sessionId.Check(sessionId)) await ipcRenderer.invoke('kimi:browser-delete-receipts', sessionId);
  },
  browserCopyReceipts: async (sourceId, targetId) => {
    if (receiptValidators.copy.Check({ sourceId, targetId })) await ipcRenderer.invoke('kimi:browser-copy-receipts', { sourceId, targetId });
  },
  browserShowAnnotation: async (id, ordinal, locate) => {
    if (!annotationValidators.marker.Check({ id, ordinal, locate })) throw new Error('Invalid annotation marker request');
    return ipcRenderer.invoke('kimi:browser-show-annotation', { id, ordinal, locate }) as Promise<BrowserAnnotationLocation>;
  },
  browserHideAnnotation: (id) => {
    if (annotationValidators.referenceId.Check(id)) ipcRenderer.send('kimi:browser-hide-annotation', id);
  },
  browserCaptureScreenshot: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id === null) return false;
    return (await ipcRenderer.invoke('kimi:browser-capture-screenshot', id)) === true;
  },
  browserFocusChrome: async () => { await ipcRenderer.invoke('kimi:browser-focus-chrome'); },
  browserGetSites: async () => {
    const raw: unknown = await ipcRenderer.invoke('kimi:browser-get-sites');
    if (!Array.isArray(raw) || raw.length > 4000) throw new Error('Invalid site settings response');
    return raw.map((value) => { const site = asBrowserSiteInfo(value); if (site === null) throw new Error('Invalid site settings response'); return site; });
  },
  browserGetSite: async (url) => {
    const origin = browserSiteOrigin(url);
    if (origin === null) throw new Error('Invalid site');
    const site = asBrowserSiteInfo(await ipcRenderer.invoke('kimi:browser-get-site', origin));
    if (site === null) throw new Error('Invalid site settings response');
    return site;
  },
  browserGetPermissionRequests: async () => {
    const value: unknown = await ipcRenderer.invoke('kimi:browser-get-permission-requests');
    if (!siteValidators.BrowserPermissionRequestsSchema.Check(value)) throw new Error('Invalid browser permission requests');
    return value;
  },
  browserResolvePermissionRequest: async decision => {
    if (!siteValidators.BrowserPermissionDecisionSchema.Check(decision)) throw new Error('Invalid browser permission decision');
    return await ipcRenderer.invoke('kimi:browser-resolve-permission-request', decision) === true;
  },
  onBrowserPermissionRequests: cb => {
    const listener = (_event: unknown, value: unknown) => { if (siteValidators.BrowserPermissionRequestsSchema.Check(value)) cb(value); };
    ipcRenderer.on('kimi:browser-permission-requests', listener);
    return () => ipcRenderer.removeListener('kimi:browser-permission-requests', listener);
  },
  browserGetPageDialogs: async () => {
    const value: unknown = await ipcRenderer.invoke('kimi:browser-get-page-dialogs');
    if (!dialogValidators.BrowserPageDialogsSchema.Check(value)) throw new Error('Invalid browser dialogs');
    return value;
  },
  browserAnswerPageDialog: async answer => {
    if (!dialogValidators.BrowserPageDialogAnswerSchema.Check(answer)) throw new Error('Invalid browser dialog answer');
    return await ipcRenderer.invoke('kimi:browser-answer-page-dialog', answer) === true;
  },
  onBrowserPageDialogs: cb => {
    const listener = (_event: unknown, value: unknown) => { if (dialogValidators.BrowserPageDialogsSchema.Check(value)) cb(value); };
    ipcRenderer.on('kimi:browser-page-dialogs', listener);
    return () => ipcRenderer.removeListener('kimi:browser-page-dialogs', listener);
  },
  browserSetSitePermission: async (url, permission, setting) => {
    const update = asBrowserSitePermissionUpdate({ origin: url, permission, setting });
    if (update === null) throw new Error('Invalid site permission');
    const site = asBrowserSiteInfo(await ipcRenderer.invoke('kimi:browser-set-site-permission', update));
    if (site === null) throw new Error('Invalid site settings response');
    return site;
  },
  browserSetSiteAutoplay: async (url, setting) => {
    const update = asBrowserSiteAutoplayUpdate({ origin: url, setting });
    if (update === null) throw new Error('Invalid site autoplay setting');
    const site = asBrowserSiteInfo(await ipcRenderer.invoke('kimi:browser-set-site-autoplay', update));
    if (site === null) throw new Error('Invalid site settings response');
    return site;
  },
  browserSetSiteSound: async (url, setting) => {
    const update = asBrowserSiteSoundUpdate({ origin: url, setting });
    if (update === null) throw new Error('Invalid site sound setting');
    const site = asBrowserSiteInfo(await ipcRenderer.invoke('kimi:browser-set-site-sound', update));
    if (site === null) throw new Error('Invalid site settings response');
    return site;
  },
  browserClearSiteData: async (url) => {
    const origin = browserSiteOrigin(url);
    if (origin === null) throw new Error('Invalid site');
    const site = asBrowserSiteInfo(await ipcRenderer.invoke('kimi:browser-clear-site-data', origin));
    if (site === null) throw new Error('Invalid site settings response');
    return site;
  },
  browserGetSystemPermissionStates: async () => {
    const states = asBrowserSystemPermissionStates(await ipcRenderer.invoke('kimi:browser-get-system-permission-states'));
    if (states === null) throw new Error('Invalid system permission states response');
    return states;
  },
  browserOpenSystemPermissionSettings: async (permission) => {
    if (!isBrowserSitePermission(permission)) throw new Error('Invalid system permission settings request');
    await ipcRenderer.invoke('kimi:browser-open-system-permission-settings', permission);
  },
  browserGetData: async () => {
    const next: unknown = await ipcRenderer.invoke('kimi:browser-get-data');
    if (!isBrowserDataSnapshot(next)) throw new Error('browser-get-data: invalid response');
    return next;
  },
  browserUpdatePreferences: async (patch) => {
    if (!isBrowserPreferencesPatch(patch)) {
      throw new Error('browser-update-preferences: invalid request');
    }
    const next: unknown = await ipcRenderer.invoke('kimi:browser-update-preferences', patch);
    if (!isBrowserDataSnapshot(next)) {
      throw new Error('browser-update-preferences: invalid response');
    }
    return next;
  },
  browserChooseAgentDownloadDirectory: async () => {
    const next: unknown = await ipcRenderer.invoke('kimi:browser-choose-agent-download-directory');
    if (!isBrowserDataSnapshot(next)) throw new Error('browser-choose-agent-download-directory: invalid response');
    return next;
  },
  browserCheckDownloadsAccess: async () => {
    const next: unknown = await ipcRenderer.invoke('kimi:browser-check-downloads-access');
    if (!isBrowserDataSnapshot(next)) throw new Error('browser-check-downloads-access: invalid response');
    return next;
  },
  browserClearHistory: async () => {
    const next: unknown = await ipcRenderer.invoke('kimi:browser-clear-history');
    if (!isBrowserDataSnapshot(next)) throw new Error('browser-clear-history: invalid response');
    return next;
  },
  browserClearDownloads: async () => {
    const next: unknown = await ipcRenderer.invoke('kimi:browser-clear-downloads');
    if (!isBrowserDataSnapshot(next)) throw new Error('browser-clear-downloads: invalid response');
    return next;
  },
  browserOpenDownload: async (id, action) => {
    const request = asBrowserDownloadAction({ id, action });
    if (request === null) throw new Error('browser-open-download: invalid request');
    return await ipcRenderer.invoke('kimi:browser-open-download', request) === true;
  },
  browserGetDownloads: async () => {
    const next: unknown = await ipcRenderer.invoke('kimi:browser-get-downloads');
    if (!isBrowserDownloadItems(next)) throw new Error('browser-get-downloads: invalid response');
    return next;
  },
  browserRemoveDownload: async (id) => {
    if (!isBrowserDownloadId(id)) throw new Error('browser-remove-download: invalid request');
    return await ipcRenderer.invoke('kimi:browser-remove-download', id) === true;
  },
  browserWatchDownloads: (watch) => {
    if (isBrowserDownloadsWatch(watch)) ipcRenderer.send('kimi:browser-watch-downloads', watch);
  },
  onBrowserDownloads: (cb) => {
    const listener = (_event: unknown, value: unknown) => { if (isBrowserDownloadItems(value)) cb(value); };
    ipcRenderer.on('kimi:browser-downloads', listener);
    return () => ipcRenderer.removeListener('kimi:browser-downloads', listener);
  },
  browserClearData: async (browserId) => {
    const id = asBrowserId(browserId);
    if (id === null) return { ...EMPTY_BROWSER_STATE };
    const next: unknown = await ipcRenderer.invoke('kimi:browser-clear-data', id);
    return isBrowserState(next) ? next : { ...EMPTY_BROWSER_STATE };
  },
  browserSetBounds: (browserId, bounds) => {
    const request = asBrowserBoundsRequest({ browserId, bounds });
    if (request !== null) ipcRenderer.send('kimi:browser-set-bounds', request);
  },
  browserSetOccluded: async (browserId, occluded) => {
    const request = asBrowserOcclusionRequest({ browserId, occluded });
    if (request === null) throw new Error('Invalid browser occlusion request');
    await ipcRenderer.invoke('kimi:browser-set-occluded', request);
  },
  browserSetFocusEmulation: async (browserId, enabled) => {
    const request = asBrowserFocusEmulationRequest({ browserId, enabled });
    if (request === null) throw new Error('Invalid focus emulation request');
    const next: unknown = await ipcRenderer.invoke('kimi:browser-set-focus-emulation', request);
    if (!isBrowserState(next)) throw new Error('Invalid browser state');
    return next;
  },
  onBrowserControlOwnership: (cb) => {
    const listener = (_event: unknown, state: unknown) => { if (isBrowserControlOwnership(state)) cb(state); };
    ipcRenderer.on('kimi:browser-control-ownership', listener);
    return () => ipcRenderer.removeListener('kimi:browser-control-ownership', listener);
  },
  browserSetControls: (config) => {
    if (isBrowserControlConfig(config)) ipcRenderer.send('kimi:browser-set-controls', config);
  },
  browserSetVisible: (browserId, visible) => {
    const request = asBrowserVisibilityRequest({ browserId, visible });
    if (request !== null) ipcRenderer.send('kimi:browser-set-visible', request);
  },
  browserClose: (browserId) => {
    const id = asBrowserId(browserId);
    if (id !== null) ipcRenderer.send('kimi:browser-close', id);
  },
  onBrowserOpenLinkRequested: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const request = pageValidators.openLink.Parse(payload);
      if (request !== null && /^(?:https?|file):\/\//i.test(request.url)) cb(request);
    };
    ipcRenderer.on('kimi:browser-open-link-requested', listener);
    return () => ipcRenderer.removeListener('kimi:browser-open-link-requested', listener);
  },
  onBrowserCloseRequested: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const browserId = asBrowserId((payload as { browserId?: unknown } | null)?.browserId);
      if (browserId !== null) cb(browserId);
    };
    ipcRenderer.on('kimi:browser-close-requested', listener);
    return () => ipcRenderer.removeListener('kimi:browser-close-requested', listener);
  },
  onBrowserAnnotationRequested: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const request = annotationValidators.context.Parse(payload);
      if (request !== null) cb(request);
    };
    ipcRenderer.on('kimi:browser-annotation-requested', listener);
    return () => ipcRenderer.removeListener('kimi:browser-annotation-requested', listener);
  },
  onBrowserState: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (isBrowserStateEvent(payload)) cb(payload.browserId, payload.state);
    };
    ipcRenderer.on('kimi:browser-state', listener);
    return () => ipcRenderer.removeListener('kimi:browser-state', listener);
  },
  onBrowserAutomationUiRequest: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (isBrowserUiRequest(payload)) cb(payload);
    };
    ipcRenderer.on('kimi:browser-automation-ui-request', listener);
    return () => ipcRenderer.removeListener('kimi:browser-automation-ui-request', listener);
  },
  browserAutomationUiRespond: (response) => {
    if (isBrowserUiResponse(response)) {
      ipcRenderer.send('kimi:browser-automation-ui-response', response);
    }
  },
  browserOverlayOpenMenu: (request) => {
    if (isBrowserOverlayMenuOpenInput(request)) {
      ipcRenderer.send('kimi:browser-overlay-open', request);
    }
  },
  browserOverlayCloseMenu: (menuId) => {
    if (asBrowserOverlayMenuId(menuId) !== null) {
      ipcRenderer.send('kimi:browser-overlay-close', menuId);
    }
  },
  onBrowserOverlayAction: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (isBrowserOverlayAction(payload)) cb(payload);
    };
    ipcRenderer.on('kimi:browser-overlay-action', listener);
    return () => ipcRenderer.removeListener('kimi:browser-overlay-action', listener);
  },
  onBrowserOverlayClosed: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (isBrowserOverlayClosed(payload)) cb(payload);
    };
    ipcRenderer.on('kimi:browser-overlay-closed', listener);
    return () => ipcRenderer.removeListener('kimi:browser-overlay-closed', listener);
  },
  browserOverlayOpenDialog: (request) => {
    if (asBrowserOverlayDialogRequest(request) !== null) {
      ipcRenderer.send('kimi:browser-overlay-dialog-open', request);
    }
  },
  browserOverlayCloseDialog: (dialogId) => {
    if (asBrowserOverlayMenuId(dialogId) !== null) {
      ipcRenderer.send('kimi:browser-overlay-dialog-close', dialogId);
    }
  },
  onBrowserOverlayDialogAction: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (isBrowserOverlayDialogAction(payload)) cb(payload);
    };
    ipcRenderer.on('kimi:browser-overlay-dialog-action', listener);
    return () => ipcRenderer.removeListener('kimi:browser-overlay-dialog-action', listener);
  },
  onBrowserOverlayDialogClosed: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (isBrowserOverlayDialogClosed(payload)) cb(payload);
    };
    ipcRenderer.on('kimi:browser-overlay-dialog-closed', listener);
    return () => ipcRenderer.removeListener('kimi:browser-overlay-dialog-closed', listener);
  },
};
