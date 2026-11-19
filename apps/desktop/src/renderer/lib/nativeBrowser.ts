import type { BrowserTabCommand } from '../../shared/browser';
import type { BrowserSiteInfo, BrowserSitePermission, BrowserSitePermissionSetting } from '../../shared/browser-sites';
import type { BrowserSiteAutoplay } from '../../shared/browser-autoplay';
import type { BrowserSiteSound } from '../../shared/browser-sound';
import type { BrowserPanelSession } from '@moonshot-ai/app-core/browser-panel-state';
import type { BrowserBounds, BrowserId, BrowserState } from '../../shared/browser';
import type { BrowserDeviceModeRequest } from '../../shared/browser-device';
import type { BrowserDataSnapshot, BrowserDownloadAction, BrowserDownloadItem, BrowserPreferencesPatch } from '../../shared/browser-data';
import type { BrowserUiRequest, BrowserUiResponse } from '../../shared/browser-automation';

export interface NativeBrowserBridge {
  browserGetSessions: () => Promise<BrowserPanelSession[]>;
  browserSaveSessions: (sessions: BrowserPanelSession[]) => Promise<void>;
  browserSuspend: (browserId: BrowserId) => void;
  getBrowserState: (browserId: BrowserId) => Promise<BrowserState>;
  browserNavigate: (browserId: BrowserId, address: string) => Promise<BrowserState>;
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
  browserZoom: (browserId: BrowserId, action: 'in' | 'out' | 'reset') => Promise<BrowserState>;
  browserToggleDeviceMode: (browserId: BrowserId) => Promise<BrowserState>;
  browserSetDeviceMode: (
    browserId: BrowserId,
    request: BrowserDeviceModeRequest,
  ) => Promise<BrowserState>;
  browserCaptureScreenshot: (browserId: BrowserId) => Promise<boolean>;
  browserFocusChrome: () => Promise<void>;
  browserGetSites: () => Promise<BrowserSiteInfo[]>;
  browserGetSite: (url: string) => Promise<BrowserSiteInfo>;
  browserSetSitePermission: (origin: string, permission: BrowserSitePermission, setting: BrowserSitePermissionSetting) => Promise<BrowserSiteInfo>;
  browserSetSiteAutoplay: (origin: string, setting: BrowserSiteAutoplay) => Promise<BrowserSiteInfo>;
  browserSetSiteSound: (origin: string, setting: BrowserSiteSound) => Promise<BrowserSiteInfo>;
  browserClearSiteData: (origin: string) => Promise<BrowserSiteInfo>;
  browserGetSystemPermissionStates: () => Promise<BrowserSitePermission[]>;
  browserOpenSystemPermissionSettings: (permission: BrowserSitePermission) => Promise<void>;
  browserGetData: () => Promise<BrowserDataSnapshot>;
  browserUpdatePreferences: (patch: BrowserPreferencesPatch) => Promise<BrowserDataSnapshot>;
  browserChooseAgentDownloadDirectory?: () => Promise<BrowserDataSnapshot>;
  browserCheckDownloadsAccess?: () => Promise<BrowserDataSnapshot>;
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
  browserSetVisible: (browserId: BrowserId, visible: boolean) => void;
  browserClose: (browserId: BrowserId) => void;
  browserClone: (sourceId: BrowserId, targetId: BrowserId) => Promise<BrowserState>;
  browserTabCommand: (request: BrowserTabCommand) => Promise<BrowserState>;
  onBrowserState: (cb: (browserId: BrowserId, state: BrowserState) => void) => () => void;
}

export interface NativeBrowserAutomationBridge {
  onBrowserAutomationUiRequest: (cb: (request: BrowserUiRequest) => void) => () => void;
  browserAutomationUiRespond: (response: BrowserUiResponse) => void;
}

function bridgeCandidate(): Partial<NativeBrowserBridge> | undefined {
  return (window as { kimiDesktop?: Partial<NativeBrowserBridge> }).kimiDesktop;
}

export function getNativeBrowserBridge(): NativeBrowserBridge | null {
  const bridge = bridgeCandidate();
  if (
    typeof bridge?.getBrowserState !== 'function' ||
    typeof bridge.browserNavigate !== 'function' ||
    typeof bridge.browserBack !== 'function' ||
    typeof bridge.browserForward !== 'function' ||
    typeof bridge.browserReload !== 'function' ||
    typeof bridge.browserFind !== 'function' ||
    typeof bridge.browserStopFind !== 'function' ||
    typeof bridge.browserPrint !== 'function' ||
    typeof bridge.browserZoom !== 'function' ||
    typeof bridge.browserToggleDeviceMode !== 'function' ||
    typeof bridge.browserSetDeviceMode !== 'function' ||
    typeof bridge.browserCaptureScreenshot !== 'function' ||
    typeof bridge.browserSetOccluded !== 'function' ||
    typeof bridge.browserSetFocusEmulation !== 'function' ||
    typeof bridge.browserFocusChrome !== 'function' ||
    typeof bridge.browserGetSites !== 'function' ||
    typeof bridge.browserGetSite !== 'function' ||
    typeof bridge.browserSetSitePermission !== 'function' ||
    typeof bridge.browserSetSiteAutoplay !== 'function' ||
    typeof bridge.browserSetSiteSound !== 'function' ||
    typeof bridge.browserClearSiteData !== 'function' ||
    typeof bridge.browserGetSystemPermissionStates !== 'function' ||
    typeof bridge.browserOpenSystemPermissionSettings !== 'function' ||
    typeof bridge.browserGetData !== 'function' ||
    typeof bridge.browserUpdatePreferences !== 'function' ||
    typeof bridge.browserClearHistory !== 'function' ||
    typeof bridge.browserClearDownloads !== 'function' ||
    typeof bridge.browserOpenDownload !== 'function' ||
    typeof bridge.browserGetDownloads !== 'function' ||
    typeof bridge.browserRemoveDownload !== 'function' ||
    typeof bridge.browserWatchDownloads !== 'function' ||
    typeof bridge.onBrowserDownloads !== 'function' ||
    typeof bridge.browserClearData !== 'function' ||
    typeof bridge.browserSetBounds !== 'function' ||
    typeof bridge.browserSetVisible !== 'function' ||
    typeof bridge.browserClose !== 'function' ||
    typeof bridge.browserClone !== 'function' ||
    typeof bridge.browserTabCommand !== 'function' ||
    typeof bridge.browserGetSessions !== 'function' ||
    typeof bridge.browserSaveSessions !== 'function' ||
    typeof bridge.browserSuspend !== 'function' ||
    typeof bridge.onBrowserState !== 'function'
  ) {
    return null;
  }
  return bridge as NativeBrowserBridge;
}

export function canUseNativeBrowser(): boolean {
  return getNativeBrowserBridge() !== null;
}

export interface LocalFileBrowserBridge {
  browserOpenLocalFile: (browserId: BrowserId, target: string, urlSuffix?: string) => Promise<void>;
  browserLocalPagesAllowed: () => Promise<boolean>;
}

export function getLocalFileBrowserBridge(): LocalFileBrowserBridge | null {
  const bridge = (window as { kimiDesktop?: Partial<LocalFileBrowserBridge> }).kimiDesktop;
  return typeof bridge?.browserOpenLocalFile === 'function' ? bridge as LocalFileBrowserBridge : null;
}

export function getNativeBrowserAutomationBridge(): NativeBrowserAutomationBridge | null {
  const bridge = (window as { kimiDesktop?: Partial<NativeBrowserAutomationBridge> }).kimiDesktop;
  if (
    typeof bridge?.onBrowserAutomationUiRequest !== 'function' ||
    typeof bridge.browserAutomationUiRespond !== 'function'
  ) {
    return null;
  }
  return bridge as NativeBrowserAutomationBridge;
}
