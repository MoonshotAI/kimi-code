import { isSleepPreventionMode, type PreventSleepState, type SleepPreventionMode } from '../../shared/prevent-sleep';
import { isDesktopFailureKind, type DesktopFailureKind } from '../../shared/failure-feedback';
import { asQuitConfirmDetails, type QuitBlockReason, type QuitConfirmDetails } from '../../shared/quit-confirm';
import { asBrowserAnnotationPickOptions, asBrowserAnnotationPickRequest, browserValidators as annotationValidators, type BrowserAnnotationCaptureAction } from '../../shared/browser-annotation';
import { browserValidators as receiptValidators, type BrowserReceiptImage } from '../../shared/browser-receipt';
import { isBrowserTabCommand, type BrowserTabCommand } from '../../shared/browser';
import { browserValidators as siteValidators, type BrowserPermissionRequest, type BrowserPermissionDecision } from '../../shared/browser-sites';
import { browserValidators as dialogValidators, type BrowserPageDialog, type BrowserPageDialogAnswer } from '../../shared/browser-dialogs';
import { isBrowserControlConfig, isBrowserControlOwnership, type BrowserControlOwnership, type BrowserControlConfig } from '../../shared/browser-control';
import { asBrowserOverlayMenuId, asBrowserOverlayDialogRequest, asBrowserOverlayMenuRequest, isBrowserOverlayAction, isBrowserOverlayClosed, isBrowserOverlayDialogAction, isBrowserOverlayDialogClosed } from '../../shared/browser-overlay';
import { asBrowserDeviceModeRequest, asBrowserDeviceModeUpdate, type BrowserDeviceModeRequest } from '../../shared/browser-device';
import { browserValidators as pageValidators, asBrowserCloneRequest, asBrowserNavigateRequest, asBrowserFocusEmulationRequest, EMPTY_BROWSER_STATE, isBrowserState, asBrowserId, asBrowserBoundsRequest, asBrowserOcclusionRequest, asBrowserVisibilityRequest, asBrowserZoomRequest, isBrowserStateEvent } from '../../shared/browser';
import { asBrowserSiteAutoplayUpdate, asBrowserSiteInfo, asBrowserSiteSoundUpdate, asBrowserSitePermissionUpdate, asBrowserSystemPermissionStates, browserSiteOrigin, isBrowserSitePermission, type BrowserSiteInfo, type BrowserSitePermission, type BrowserSitePermissionSetting } from '../../shared/browser-sites';
import type { BrowserSiteAutoplay } from '../../shared/browser-autoplay';
import type { BrowserSiteSound } from '../../shared/browser-sound';
import { asBrowserDownloadAction, isBrowserDataSnapshot, isBrowserDownloadId, isBrowserDownloadItems, isBrowserDownloadsWatch, isBrowserPreferencesPatch } from '../../shared/browser-data';
import type { BrowserPanelSession } from '@moonshot-ai/app-core/browser-panel-state';
import { asBrowserPanelSessions } from '../../shared/browser-panel-state';
import {
  isTerminalActivityList,
  normalizeTerminalSshTarget,
  type NativeTerminalCreateOptions,
  type NativeTerminalSshTarget,
  type TerminalActivity,
} from '../../shared/terminal-activity';
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { ScreenshotGuidance, ScreenshotGuidanceAction } from '../../shared/screenshot-guidance';
import { asGlobalShortcutResult, type GlobalShortcutResult } from '../../shared/global-shortcut';
import type { ProviderModelsFetchResult } from '../system/provider-models-fetch';
import {
  asRuntimeEnvironmentGetResult,
  asRuntimeEnvironmentOverrides,
  asRuntimeEnvironmentSaveResult,
  type RuntimeEnvironmentGetResult,
  type RuntimeEnvironmentOverrides,
  type RuntimeEnvironmentSaveResult,
} from '../../shared/runtime-environment';

import type { BrowserBounds, BrowserId, BrowserState } from '../../shared/browser';
import type { BrowserAnnotationAsset, BrowserAnnotationContextRequest, BrowserAnnotationLocation, BrowserAnnotationPickOptions, BrowserAnnotationPickResult } from '../../shared/browser-annotation';
import type {
  BrowserDataSnapshot,
  BrowserDownloadAction,
  BrowserDownloadItem,
  BrowserPreferencesPatch,
} from '../../shared/browser-data';
import type {
  BrowserOverlayAction,
  BrowserOverlayClosed,
  BrowserOverlayDialogAction,
  BrowserOverlayDialogClosed,
  BrowserOverlayDialogRequest,
  BrowserOverlayMenuRequest,
} from '../../shared/browser-overlay';
import { isBrowserUiRequest, isBrowserUiResponse, type BrowserUiRequest, type BrowserUiResponse } from '../../shared/browser-automation-ui';
import type { FeedbackDiagnosticsArchive } from '../../shared/feedback-diagnostics';

export type DialogOptions = Record<string, unknown>;

export type OpenInApp = { id: string; label: string; preferred?: boolean };
export type OpenInResult = { ok: boolean; error?: string };

export type UpdateStatus = {
  state: 'idle' | 'available' | 'downloading' | 'downloaded' | 'error';
  version?: string;
  percent?: number;
  message?: string;
  releaseDate?: string;
  releaseNotes?: { zh?: string; en?: string };
};

const UPDATE_STATES = new Set(['idle', 'available', 'downloading', 'downloaded', 'error']);

export type UpdateCheckResult =
  | { outcome: 'available'; version?: string }
  | { outcome: 'latest' }
  | { outcome: 'unsupported' }
  | { outcome: 'error'; message: string };

const UPDATE_CHECK_OUTCOMES = new Set(['available', 'latest', 'unsupported', 'error']);

export type CanaryInfo = { enabled: boolean; isCanaryBuild: boolean; isRealCanaryBuild: boolean };

export type CanaryStableImportResult = {
  status: 'relaunching' | 'unavailable' | 'no-stable-data' | 'stable-running' | 'error' | 'cancelled';
  error?: string;
};

const CANARY_STABLE_IMPORT_STATUSES = new Set(['relaunching', 'unavailable', 'no-stable-data', 'stable-running', 'error', 'cancelled']);

function asCanaryStableImportResult(value: unknown): CanaryStableImportResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { status?: unknown; error?: unknown };
  if (typeof candidate.status !== 'string' || !CANARY_STABLE_IMPORT_STATUSES.has(candidate.status)) {
    return null;
  }
  return {
    status: candidate.status as CanaryStableImportResult['status'],
    ...(typeof candidate.error === 'string' ? { error: candidate.error } : {}),
  };
}

export type LinuxNativeTitleBarResult = { status: 'relaunching' | 'cancelled' | 'unavailable' | 'error' };

const LINUX_NATIVE_TITLEBAR_STATUSES = new Set(['relaunching', 'cancelled', 'unavailable', 'error']);

function asLinuxNativeTitleBarResult(value: unknown): LinuxNativeTitleBarResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { status?: unknown };
  if (typeof candidate.status !== 'string' || !LINUX_NATIVE_TITLEBAR_STATUSES.has(candidate.status)) {
    return null;
  }
  return { status: candidate.status as LinuxNativeTitleBarResult['status'] };
}


function asPreventSleepState(value: unknown): PreventSleepState {
  if (typeof value !== 'object' || value === null) {
    return { system: 'allow-sleep', lid: false, lidSupported: false };
  }
  const candidate = value as { system?: unknown; lid?: unknown; lidSupported?: unknown; lidNeedsRepair?: unknown };
  return {
    system: isSleepPreventionMode(candidate.system) ? candidate.system : 'allow-sleep',
    lid: candidate.lid === true,
    lidSupported: candidate.lidSupported === true,
    ...(candidate.lidNeedsRepair === true ? { lidNeedsRepair: true } : {}),
  };
}

function asCanaryInfo(value: unknown): CanaryInfo | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as {
    enabled?: unknown;
    isCanaryBuild?: unknown;
    isRealCanaryBuild?: unknown;
  };
  if (typeof candidate.enabled !== 'boolean' || typeof candidate.isCanaryBuild !== 'boolean') {
    return null;
  }
  return {
    enabled: candidate.enabled,
    isCanaryBuild: candidate.isCanaryBuild,
    isRealCanaryBuild: candidate.isRealCanaryBuild === true,
  };
}

export type TrayAttentionItem = {
  sessionId: string;
  title: string;
  unread: boolean;
  approvals: number;
  questions: number;
};
export type TrayAttention = {
  unread: number;
  approvals: number;
  questions: number;
  items: TrayAttentionItem[];
};

function asCount(value: unknown): boolean {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function asTrayAttentionItem(value: unknown): value is TrayAttentionItem {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    sessionId?: unknown;
    title?: unknown;
    unread?: unknown;
    approvals?: unknown;
    questions?: unknown;
  };
  return (
    typeof candidate.sessionId === 'string' &&
    candidate.sessionId !== '' &&
    typeof candidate.title === 'string' &&
    typeof candidate.unread === 'boolean' &&
    asCount(candidate.approvals) &&
    asCount(candidate.questions)
  );
}

function asTrayAttention(value: unknown): value is TrayAttention {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  const candidate = value as {
    unread?: unknown;
    approvals?: unknown;
    questions?: unknown;
    items?: unknown;
  };
  return (
    asCount(candidate.unread) &&
    asCount(candidate.approvals) &&
    asCount(candidate.questions) &&
    Array.isArray(candidate.items) &&
    candidate.items.every(asTrayAttentionItem)
  );
}

function asUpdateStatus(value: unknown): UpdateStatus | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as {
    state?: unknown;
    version?: unknown;
    percent?: unknown;
    message?: unknown;
    releaseDate?: unknown;
    releaseNotes?: unknown;
  };
  if (typeof candidate.state !== 'string' || !UPDATE_STATES.has(candidate.state)) {
    return null;
  }
  const status: UpdateStatus = { state: candidate.state as UpdateStatus['state'] };
  if (typeof candidate.version === 'string') {
    status.version = candidate.version;
  }
  if (typeof candidate.percent === 'number') {
    status.percent = candidate.percent;
  }
  if (typeof candidate.message === 'string') {
    status.message = candidate.message;
  }
  if (typeof candidate.releaseDate === 'string') {
    status.releaseDate = candidate.releaseDate;
  }
  if (typeof candidate.releaseNotes === 'object' && candidate.releaseNotes !== null && !Array.isArray(candidate.releaseNotes)) {
    const notes = candidate.releaseNotes as { zh?: unknown; en?: unknown };
    status.releaseNotes = {};
    if (typeof notes.zh === 'string') {
      status.releaseNotes.zh = notes.zh;
    }
    if (typeof notes.en === 'string') {
      status.releaseNotes.en = notes.en;
    }
  }
  return status;
}

function asUpdateCheckResult(value: unknown): UpdateCheckResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { outcome?: unknown; version?: unknown; message?: unknown };
  if (typeof candidate.outcome !== 'string' || !UPDATE_CHECK_OUTCOMES.has(candidate.outcome)) {
    return null;
  }
  switch (candidate.outcome) {
    case 'available':
      return typeof candidate.version === 'string'
        ? { outcome: 'available', version: candidate.version }
        : { outcome: 'available' };
    case 'error':
      return {
        outcome: 'error',
        message: typeof candidate.message === 'string' ? candidate.message : 'unknown error',
      };
    default:
      return { outcome: candidate.outcome as 'latest' | 'unsupported' };
  }
}

function asProviderModelsFetchResult(value: unknown): ProviderModelsFetchResult | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { ok?: unknown; status?: unknown; body?: unknown; kind?: unknown };
  if (candidate.ok === true) {
    if (typeof candidate.status !== 'number' || !Number.isInteger(candidate.status)) {
      return null;
    }
    if (typeof candidate.body !== 'string') {
      return null;
    }
    return { ok: true, status: candidate.status, body: candidate.body };
  }
  if (candidate.ok === false && (candidate.kind === 'timeout' || candidate.kind === 'network')) {
    return { ok: false, kind: candidate.kind };
  }
  return null;
}

export type JumpListWorkspace = { name: string; root: string };

function asJumpListWorkspaces(value: unknown): value is JumpListWorkspace[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { name?: unknown }).name === 'string' &&
        typeof (item as { root?: unknown }).root === 'string' &&
        (item as { root: string }).root !== '',
    )
  );
}

export type LaunchActionPayload = { action: 'new-chat' } | { action: 'open-workspace'; root: string; newChat?: boolean };

function asLaunchActionPayload(value: unknown): LaunchActionPayload | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { action?: unknown; root?: unknown; newChat?: unknown };
  if (candidate.action === 'new-chat') {
    return { action: 'new-chat' };
  }
  if (candidate.action === 'open-workspace' && typeof candidate.root === 'string' && candidate.root !== '') {
    if (candidate.newChat !== undefined && typeof candidate.newChat !== 'boolean') return null;
    return { action: 'open-workspace', root: candidate.root, newChat: candidate.newChat };
  }
  return null;
}

export type NativeTerminalInfo = { id: string; shell: string; cwd: string };
export type { NativeTerminalCreateOptions, NativeTerminalSshTarget };

export type ScreenshotCaptureResult =
  | { status: 'ok'; pngBytes: Uint8Array; comment: string; captureId: string }
  | { status: 'completed' }
  | { status: 'cancelled' }
  | { status: 'denied' }
  | { status: 'error'; reason: string; captureId?: string };

function asScreenshotCaptureResult(value: unknown): ScreenshotCaptureResult | null {
  if (typeof value !== 'object' || value === null) return null;
  const candidate = value as { status?: unknown; pngBytes?: unknown; comment?: unknown; reason?: unknown; captureId?: unknown };
  switch (candidate.status) {
    case 'ok':
      if (!(candidate.pngBytes instanceof Uint8Array) || typeof candidate.comment !== 'string') return null;
      return {
        status: 'ok',
        pngBytes: candidate.pngBytes,
        comment: candidate.comment,
        captureId: typeof candidate.captureId === 'string' ? candidate.captureId : '',
      };
    case 'completed':
    case 'cancelled':
    case 'denied':
      return { status: candidate.status };
    case 'error':
      return {
        status: 'error',
        reason: typeof candidate.reason === 'string' ? candidate.reason : 'unknown',
        captureId: typeof candidate.captureId === 'string' ? candidate.captureId : undefined,
      };
    default:
      return null;
  }
}

function asNativeTerminalInfo(value: unknown): NativeTerminalInfo | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const candidate = value as { id?: unknown; shell?: unknown; cwd?: unknown };
  if (
    typeof candidate.id === 'string' &&
    candidate.id !== '' &&
    typeof candidate.shell === 'string' &&
    typeof candidate.cwd === 'string'
  ) {
    return { id: candidate.id, shell: candidate.shell, cwd: candidate.cwd };
  }
  return null;
}




export type KimiDesktopApi = {
  browserOverlaySupported: boolean;
  inspectNativeTerminals: (ids: string[]) => Promise<TerminalActivity[]>;
  setTheme: (scheme: 'light' | 'dark' | 'system') => void;
  popupWindowsMenu: (request: {
    id: 'file' | 'edit' | 'view' | 'help';
    x: number;
    y: number;
  }) => Promise<{ opened: boolean }>;
  setDockIconChoice: (choice: 'light' | 'dark') => void;
  onMenuAction: (cb: (id: string) => void) => () => void;
  onShortcut: (cb: (accel: string) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  writeClipboardText: (text: string) => Promise<boolean>;
  collectFeedbackDiagnostics: () => Promise<FeedbackDiagnosticsArchive>;
  onFailureToast: (cb: (kind: DesktopFailureKind, url?: string) => void) => () => void;
  updateServerCredential: (token: string) => Promise<void>;
  showOpenDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePaths: string[] }>;
  showSaveDialog: (opts: DialogOptions) => Promise<{ canceled: boolean; filePath?: string }>;
  getPathForFile: (file: File) => string | null;
  listOpenInApps: (filePath?: string) => Promise<OpenInApp[]>;
  openInApp: (appId: string, path: string) => Promise<OpenInResult>;
  setOnboarded: () => void;
  isFullscreen: () => Promise<boolean>;
  onFullscreenChanged: (cb: (fullscreen: boolean) => void) => () => void;
  getUpdateStatus: () => Promise<UpdateStatus>;
  checkForUpdates: () => Promise<UpdateCheckResult>;
  onUpdateStatus: (cb: (status: UpdateStatus) => void) => () => void;
  downloadUpdate: () => Promise<void>;
  installUpdate: () => Promise<void>;
  getUpdateAutoDownload: () => Promise<boolean>;
  setUpdateAutoDownload: (enabled: boolean) => Promise<void>;
  getRemoteControlRestoreState: () => Promise<{ restoreEnabled: boolean; previousEnabled: boolean }>;
  setRemoteControlRestoreState: (patch: { restoreEnabled?: boolean; previousEnabled?: boolean }) => Promise<void>;
  onRemoteControlRestoreFinished: (cb: () => void) => () => void;
  getCanaryInfo: () => Promise<CanaryInfo>;
  canaryImportStableSettings?: () => Promise<CanaryStableImportResult>;
  getRuntimeEnvironmentOverrides: () => Promise<RuntimeEnvironmentGetResult>;
  saveRuntimeEnvironmentOverrides: (overrides: RuntimeEnvironmentOverrides) => Promise<RuntimeEnvironmentSaveResult>;
  resetRuntimeEnvironmentOverrides: () => Promise<RuntimeEnvironmentSaveResult>;
  setTrayAttention: (attention: TrayAttention) => void;
  onTraySelectSession: (cb: (sessionId: string) => void) => () => void;
  setLocale: (locale: 'en' | 'zh') => void;
  setMenuShortcuts: (bindings: Record<string, string | null>) => void;
  setMenuSuspended: (suspended: boolean) => void;
  setTerminalMenuFocus: (focused: boolean) => void;
  setGlobalShortcut: (action: string, binding: string | null) => Promise<GlobalShortcutResult>;
  setGlobalShortcutSuspended: (suspended: boolean) => Promise<boolean>;
  showWindow: () => void;
  hideWindow: () => void;
  showSelectionContextMenu: (selectionText: string) => void;
  setJumpList: (workspaces: JumpListWorkspace[]) => void;
  onLaunchAction: (cb: (payload: LaunchActionPayload) => void) => () => void;
  onQuitConfirm: (
    cb: (requestId: number, reasons: QuitBlockReason[], details: QuitConfirmDetails) => void,
  ) => () => void;
  onQuitConfirmCancel: (cb: (requestId: number) => void) => () => void;
  respondQuitConfirm: (
    choice: 'quit' | 'cancel' | 'unavailable',
    requestId: number,
    continueSessions?: boolean,
  ) => Promise<void>;
  onDeepLinkAuth: (cb: () => void) => () => void;
  setVibrancy: (enabled: boolean) => void;
  getVibrancy: () => Promise<boolean>;
  setPreventSystemSleep: (mode: SleepPreventionMode) => Promise<PreventSleepState>;
  getPreventSystemSleep: () => Promise<boolean>;
  getPreventSleepState: () => Promise<PreventSleepState>;
  setPreventLidSleep: (enabled: boolean) => Promise<PreventSleepState>;
  setLinuxNativeTitleBar: (enabled: boolean) => Promise<LinuxNativeTitleBarResult>;
  log: (level: 'info' | 'warn' | 'error', message: string, detail?: unknown) => void;
  reportStartupMilestone: (milestone: 'ui-mounted' | 'ui-ready' | 'boot-stage', stage?: string) => void;
  track: (event: string, properties?: Record<string, unknown>) => void;
  createNativeTerminal: (opts?: NativeTerminalCreateOptions) => Promise<NativeTerminalInfo>;
  isScreenshotSupported: () => boolean;
  captureScreenshot: () => Promise<ScreenshotCaptureResult>;
  getScreenshotGuidance: () => Promise<ScreenshotGuidance | null>;
  onScreenshotGuidance: (cb: (guide: ScreenshotGuidance | null) => void) => () => void;
  screenshotGuidanceAction: (captureId: string, action: ScreenshotGuidanceAction) => Promise<void>;
  cancelScreenshotCapture: () => void;
  onScreenshotHotkey: (cb: () => void) => () => void;
  onScreenshotHotkeyResult: (cb: (result: ScreenshotCaptureResult) => void) => () => void;
  nativeTerminalInput: (id: string, data: string) => void;
  nativeTerminalResize: (id: string, cols: number, rows: number) => void;
  closeNativeTerminal: (id: string) => void;
  onNativeTerminalOutput: (cb: (id: string, data: string) => void) => () => void;
  onNativeTerminalExit: (cb: (id: string, exitCode: number | null) => void) => () => void;
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
  fetchProviderModels: (request: {
    url: string;
    headers: Record<string, string>;
    timeoutMs: number;
  }) => Promise<ProviderModelsFetchResult | null>;
};

export const api: KimiDesktopApi = {
  browserOverlaySupported: process.argv.includes('--kimi-native-overlay-host'),
  inspectNativeTerminals: async ids => {
    const result: unknown = await ipcRenderer.invoke('kimi:terminal-inspect', ids);
    if (!isTerminalActivityList(result)) throw new Error('Invalid terminal activity response');
    return result;
  },
  setTheme: (scheme) => {
    if (scheme === 'light' || scheme === 'dark' || scheme === 'system') {
      ipcRenderer.send('kimi:theme', scheme);
    }
  },
  popupWindowsMenu: (request) => ipcRenderer.invoke('kimi:menu-popup', request),
  setDockIconChoice: (choice) => {
    if (choice === 'light' || choice === 'dark') {
      ipcRenderer.send('kimi:dock-icon-choice', choice);
    }
  },
  onMenuAction: (cb) => {
    const listener = (_event: unknown, id: string) => cb(id);
    ipcRenderer.on('kimi:menu-action', listener);
    return () => ipcRenderer.removeListener('kimi:menu-action', listener);
  },
  onShortcut: (cb) => {
    const listener = (_event: unknown, accel: string) => cb(accel);
    ipcRenderer.on('kimi:shortcut', listener);
    return () => ipcRenderer.removeListener('kimi:shortcut', listener);
  },
  openExternal: (url) => ipcRenderer.invoke('kimi:open-external', url),
  writeClipboardText: (text) => ipcRenderer.invoke('kimi:write-clipboard-text', text),
  collectFeedbackDiagnostics: () => ipcRenderer.invoke('kimi:feedback-diagnostics-collect'),
  onFailureToast: (cb) => {
    const listener = (_event: unknown, kind: unknown, url: unknown) => {
      if (!isDesktopFailureKind(kind)) return;
      const copyUrl = typeof url === 'string' && (url.startsWith('http://') || url.startsWith('https://')) ? url : undefined;
      cb(kind, copyUrl);
    };
    ipcRenderer.on('kimi:failure-toast', listener);
    return () => ipcRenderer.removeListener('kimi:failure-toast', listener);
  },
  updateServerCredential: (token) => ipcRenderer.invoke('kimi:server-credential', token),
  showOpenDialog: (opts) => ipcRenderer.invoke('kimi:dialog-open', opts),
  showSaveDialog: (opts) => ipcRenderer.invoke('kimi:dialog-save', opts),
  getPathForFile: (file) => {
    try {
      const path = webUtils.getPathForFile(file);
      return path === '' ? null : path;
    } catch {
      return null;
    }
  },
  listOpenInApps: (filePath) => ipcRenderer.invoke('kimi:open-in-list', filePath),
  openInApp: (appId, path) => ipcRenderer.invoke('kimi:open-in', appId, path),
  setOnboarded: () => ipcRenderer.send('kimi:set-onboarded'),
  isFullscreen: () => ipcRenderer.invoke('kimi:is-fullscreen'),
  onFullscreenChanged: (cb) => {
    const listener = (_event: unknown, flag: unknown) => cb(flag === true);
    ipcRenderer.on('kimi:fullscreen-changed', listener);
    return () => ipcRenderer.removeListener('kimi:fullscreen-changed', listener);
  },
  getUpdateStatus: async () => {
    const status = asUpdateStatus(await ipcRenderer.invoke('kimi:update-get-status'));
    return status ?? { state: 'idle' };
  },
  checkForUpdates: async () => {
    const result = asUpdateCheckResult(await ipcRenderer.invoke('kimi:update-check'));
    return result ?? { outcome: 'error', message: 'invalid update-check response' };
  },
  onUpdateStatus: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const status = asUpdateStatus(payload);
      if (status !== null) {
        cb(status);
      }
    };
    ipcRenderer.on('kimi:update-status', listener);
    return () => ipcRenderer.removeListener('kimi:update-status', listener);
  },
  downloadUpdate: () => ipcRenderer.invoke('kimi:update-download'),
  installUpdate: () => ipcRenderer.invoke('kimi:update-install'),
  getUpdateAutoDownload: async () => {
    const enabled: unknown = await ipcRenderer.invoke('kimi:update-get-auto-download');
    return enabled === true;
  },
  setUpdateAutoDownload: async (enabled) => {
    if (typeof enabled !== 'boolean') {
      return;
    }
    await ipcRenderer.invoke('kimi:update-set-auto-download', enabled);
  },
  getRemoteControlRestoreState: async () => {
    const state = (await ipcRenderer.invoke('kimi:remote-control-restore-state-get')) as {
      restoreEnabled?: unknown;
      previousEnabled?: unknown;
    } | null;
    return {
      restoreEnabled: state?.restoreEnabled === true,
      previousEnabled: state?.previousEnabled === true,
    };
  },
  setRemoteControlRestoreState: async (patch) => {
    const value: Record<string, boolean> = {};
    if (typeof patch.restoreEnabled === 'boolean') value['restoreEnabled'] = patch.restoreEnabled;
    if (typeof patch.previousEnabled === 'boolean') value['previousEnabled'] = patch.previousEnabled;
    await ipcRenderer.invoke('kimi:remote-control-restore-state-set', value);
  },
  onRemoteControlRestoreFinished: (cb) => {
    const listener = (): void => cb();
    ipcRenderer.on('kimi:remote-control-restore-finished', listener);
    return () => ipcRenderer.removeListener('kimi:remote-control-restore-finished', listener);
  },
  getCanaryInfo: async () => {
    const info = asCanaryInfo(await ipcRenderer.invoke('kimi:canary-get-info'));
    return info ?? { enabled: false, isCanaryBuild: false, isRealCanaryBuild: false };
  },
  canaryImportStableSettings: async () => {
    const result = asCanaryStableImportResult(await ipcRenderer.invoke('kimi:canary-import-stable-settings'));
    return result ?? { status: 'error', error: 'invalid canary-import-stable-settings response' };
  },
  getRuntimeEnvironmentOverrides: async () => {
    const result = asRuntimeEnvironmentGetResult(await ipcRenderer.invoke('kimi:runtime-environment-get'));
    return result ?? { status: 'error', error: 'invalid runtime-environment-get response' };
  },
  saveRuntimeEnvironmentOverrides: async (overrides) => {
    const request = asRuntimeEnvironmentOverrides(overrides);
    if (request === null) return { status: 'error', error: 'invalid runtime environment overrides' };
    const result = asRuntimeEnvironmentSaveResult(await ipcRenderer.invoke('kimi:runtime-environment-save', request));
    return result ?? { status: 'error', error: 'invalid runtime-environment-save response' };
  },
  resetRuntimeEnvironmentOverrides: async () => {
    const result = asRuntimeEnvironmentSaveResult(await ipcRenderer.invoke('kimi:runtime-environment-reset'));
    return result ?? { status: 'error', error: 'invalid runtime-environment-reset response' };
  },
  setTrayAttention: (attention) => {
    if (asTrayAttention(attention)) {
      ipcRenderer.send('kimi:tray-attention', attention);
    }
  },
  onTraySelectSession: (cb) => {
    const listener = (_event: unknown, sessionId: unknown) => {
      if (typeof sessionId === 'string' && sessionId !== '') {
        cb(sessionId);
      }
    };
    ipcRenderer.on('kimi:tray-select-session', listener);
    return () => ipcRenderer.removeListener('kimi:tray-select-session', listener);
  },
  setLocale: (locale) => {
    if (locale === 'en' || locale === 'zh') {
      ipcRenderer.send('kimi:locale', locale);
    }
  },
  setMenuShortcuts: (bindings) => {
    if (bindings !== null && typeof bindings === 'object' && !Array.isArray(bindings)) {
      ipcRenderer.send('kimi:menu-shortcut', bindings);
    }
  },
  setMenuSuspended: (suspended) => {
    if (typeof suspended === 'boolean') {
      ipcRenderer.send('kimi:menu-suspend', suspended);
    }
  },
  setTerminalMenuFocus: (focused) => {
    if (typeof focused === 'boolean') {
      ipcRenderer.send('kimi:menu-terminal-focus', focused);
    }
  },
  setGlobalShortcut: async (action, binding) => {
    if (typeof action !== 'string' || (binding !== null && typeof binding !== 'string')) {
      return { ok: false, reason: 'invalid' };
    }
    const result: unknown = await ipcRenderer.invoke('kimi:global-shortcut', { action, binding });
    return asGlobalShortcutResult(result) ?? { ok: false, reason: 'conflicted' };
  },
  setGlobalShortcutSuspended: async (suspended) => {
    if (typeof suspended !== 'boolean') {
      return false;
    }
    const result: unknown = await ipcRenderer.invoke('kimi:global-shortcut-suspend', suspended);
    return result === true;
  },
  showWindow: () => {
    ipcRenderer.send('kimi:show-window');
  },
  hideWindow: () => {
    ipcRenderer.send('kimi:hide-window');
  },
  showSelectionContextMenu: (selectionText) => {
    ipcRenderer.send('kimi:selection-context-menu', selectionText);
  },
  setJumpList: (workspaces) => {
    if (asJumpListWorkspaces(workspaces)) {
      ipcRenderer.send('kimi:jump-list', workspaces);
    }
  },
  onLaunchAction: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      const action = asLaunchActionPayload(payload);
      if (action !== null) {
        cb(action);
      }
    };
    ipcRenderer.on('kimi:launch-action', listener);
    return () => ipcRenderer.removeListener('kimi:launch-action', listener);
  },
  onQuitConfirm: (cb) => {
    const listener = (_event: unknown, requestId: unknown, reasons: unknown, details: unknown) => {
      if (typeof requestId !== 'number' || !Number.isInteger(requestId)) return;
      const list = Array.isArray(reasons)
        ? reasons.filter((r): r is QuitBlockReason => r === 'busy' || r === 'remote-control')
        : [];
      cb(requestId, list, asQuitConfirmDetails(details));
    };
    ipcRenderer.on('kimi:quit-confirm', listener);
    return () => ipcRenderer.removeListener('kimi:quit-confirm', listener);
  },
  onQuitConfirmCancel: (cb) => {
    const listener = (_event: unknown, requestId: unknown) => {
      if (typeof requestId === 'number' && Number.isInteger(requestId)) {
        cb(requestId);
      }
    };
    ipcRenderer.on('kimi:quit-confirm-cancel', listener);
    return () => ipcRenderer.removeListener('kimi:quit-confirm-cancel', listener);
  },
  respondQuitConfirm: (choice, requestId, continueSessions) => {
    if (choice !== 'quit' && choice !== 'cancel' && choice !== 'unavailable') return Promise.resolve();
    if (typeof requestId !== 'number' || !Number.isInteger(requestId)) return Promise.resolve();
    return ipcRenderer.invoke('kimi:quit-confirm-response', {
      choice,
      requestId,
      continueSessions: continueSessions === true,
    });
  },
  onDeepLinkAuth: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('kimi:deep-link-auth', listener);
    return () => ipcRenderer.removeListener('kimi:deep-link-auth', listener);
  },
  setVibrancy: (enabled) => {
    if (typeof enabled === 'boolean') {
      ipcRenderer.send('kimi:vibrancy', enabled);
    }
  },
  getVibrancy: async () => (await ipcRenderer.invoke('kimi:get-vibrancy')) !== false,
  setPreventSystemSleep: async (mode) => {
    if (!isSleepPreventionMode(mode)) return { system: 'allow-sleep', lid: false, lidSupported: false };
    return ipcRenderer.invoke('kimi:prevent-system-sleep', mode).then(asPreventSleepState);
  },
  getPreventSystemSleep: async () => (await ipcRenderer.invoke('kimi:get-prevent-system-sleep')) === true,
  getPreventSleepState: async () => asPreventSleepState(await ipcRenderer.invoke('kimi:prevent-sleep-state')),
  setPreventLidSleep: async (enabled) => {
    if (typeof enabled !== 'boolean') return { system: 'allow-sleep', lid: false, lidSupported: false };
    return ipcRenderer.invoke('kimi:set-prevent-lid-sleep', enabled).then(asPreventSleepState);
  },
  setLinuxNativeTitleBar: (enabled) => {
    if (typeof enabled !== 'boolean') return Promise.resolve({ status: 'unavailable' as const });
    return ipcRenderer
      .invoke('kimi:linux-native-titlebar', enabled)
      .then((result) => asLinuxNativeTitleBarResult(result) ?? { status: 'unavailable' as const });
  },
  log: (level, message, detail) => {
    if (level !== 'info' && level !== 'warn' && level !== 'error') return;
    if (typeof message !== 'string' || message === '') return;
    ipcRenderer.send('kimi:renderer-log', { level, message, detail });
  },
  reportStartupMilestone: (milestone, stage) => {
    if (milestone !== 'ui-mounted' && milestone !== 'ui-ready' && milestone !== 'boot-stage') return;
    if (milestone === 'boot-stage') {
      if (typeof stage === 'string' && stage !== '') ipcRenderer.send('kimi:startup-milestone', { milestone, stage });
      return;
    }
    ipcRenderer.send('kimi:startup-milestone', { milestone });
  },
  track: (event, properties) => {
    if (typeof event === 'string' && event !== '') {
      ipcRenderer.send('kimi:track', event, properties);
    }
  },
  createNativeTerminal: async (opts) => {
    const options: Record<string, unknown> = {};
    if (typeof opts?.cwd === 'string' && opts.cwd !== '') options['cwd'] = opts.cwd;
    if (typeof opts?.cols === 'number' && Number.isFinite(opts.cols)) options['cols'] = opts.cols;
    if (typeof opts?.rows === 'number' && Number.isFinite(opts.rows)) options['rows'] = opts.rows;
    const ssh = normalizeTerminalSshTarget(opts?.ssh);
    if (ssh !== undefined) options['ssh'] = ssh;
    const info = asNativeTerminalInfo(await ipcRenderer.invoke('kimi:terminal-create', options));
    if (info === null) {
      throw new Error('terminal-create: invalid response from main process');
    }
    return info;
  },
  isScreenshotSupported: () => process.platform !== 'linux'
    || process.env['XDG_SESSION_TYPE']?.toLowerCase() === 'x11'
    || process.env['WAYLAND_DISPLAY'] === undefined,
  captureScreenshot: async () => {
    const result = asScreenshotCaptureResult(await ipcRenderer.invoke('kimi:screenshot-capture'));
    return result ?? { status: 'error', reason: 'invalid screenshot-capture response' };
  },
  cancelScreenshotCapture: () => {
    ipcRenderer.send('kimi:screenshot-cancel');
  },
  getScreenshotGuidance: () => ipcRenderer.invoke('kimi:screenshot-guide-get'),
  onScreenshotGuidance: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, guide: ScreenshotGuidance | null) => cb(guide);
    ipcRenderer.on('kimi:screenshot-guide-changed', listener);
    return () => ipcRenderer.removeListener('kimi:screenshot-guide-changed', listener);
  },
  screenshotGuidanceAction: (captureId, action) => ipcRenderer.invoke('kimi:screenshot-guide-action', captureId, action),
  onScreenshotHotkey: (cb) => {
    const listener = () => cb();
    ipcRenderer.on('kimi:screenshot-hotkey', listener);
    return () => ipcRenderer.removeListener('kimi:screenshot-hotkey', listener);
  },
  onScreenshotHotkeyResult: (cb) => {
    const listener = (_event: Electron.IpcRendererEvent, result: ScreenshotCaptureResult) => cb(result);
    ipcRenderer.on('kimi:screenshot-hotkey-result', listener);
    return () => ipcRenderer.removeListener('kimi:screenshot-hotkey-result', listener);
  },
  nativeTerminalInput: (id, data) => {
    if (typeof id === 'string' && id !== '' && typeof data === 'string' && data !== '') {
      ipcRenderer.send('kimi:terminal-input', { id, data });
    }
  },
  nativeTerminalResize: (id, cols, rows) => {
    if (
      typeof id === 'string' &&
      id !== '' &&
      typeof cols === 'number' &&
      Number.isFinite(cols) &&
      typeof rows === 'number' &&
      Number.isFinite(rows)
    ) {
      ipcRenderer.send('kimi:terminal-resize', { id, cols, rows });
    }
  },
  closeNativeTerminal: (id) => {
    if (typeof id === 'string' && id !== '') {
      ipcRenderer.send('kimi:terminal-close', { id });
    }
  },
  onNativeTerminalOutput: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return;
      const { id, data } = payload as { id?: unknown; data?: unknown };
      if (typeof id === 'string' && id !== '' && typeof data === 'string') {
        cb(id, data);
      }
    };
    ipcRenderer.on('kimi:terminal-output', listener);
    return () => ipcRenderer.removeListener('kimi:terminal-output', listener);
  },
  onNativeTerminalExit: (cb) => {
    const listener = (_event: unknown, payload: unknown) => {
      if (typeof payload !== 'object' || payload === null) return;
      const { id, exitCode } = payload as { id?: unknown; exitCode?: unknown };
      if (typeof id === 'string' && id !== '') {
        cb(id, typeof exitCode === 'number' ? exitCode : null);
      }
    };
    ipcRenderer.on('kimi:terminal-exit', listener);
    return () => ipcRenderer.removeListener('kimi:terminal-exit', listener);
  },
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
    if (asBrowserOverlayMenuRequest(request) !== null) {
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
  fetchProviderModels: async (request) => {
    const result = asProviderModelsFetchResult(
      await ipcRenderer.invoke('kimi:provider-models-fetch', request),
    );
    return result;
  },
};

contextBridge.exposeInMainWorld('kimiDesktop', api);
