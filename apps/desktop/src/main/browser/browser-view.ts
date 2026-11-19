import { browserSiteOrigin, type BrowserSiteInfo } from '../../shared/browser-sites';
import { clearBrowserSiteStorage } from './browser-sites';
import { loadBrowserFavicon } from './browser-favicon';
import type { BrowserTabCommand } from '../../shared/browser';
import { attachBrowserControlPage, attachBrowserControlWindow, attachBrowserUserInput, browserControlSessionKey, isBrowserAgentControlled, observeBrowserControls, onBrowserAgentAction, onBrowserControlDownloadAction, onBrowserUserAction, refreshBrowserControlSurface, setBrowserControls } from './browser-control';
import { cancelBrowserDialogs, configureBrowserDialogs, forgetBrowserEvents, openBrowserDialog, publishBrowserDialogs, pushAgentBrowserNotice, pushBrowserNotice, recordBrowserDialogEvent, syncBrowserDialogControl, updateBrowserDownloadRecord } from './browser-dialogs';
import { agentDownloadLimit, agentDownloadLimitMessage, agentDownloadOverLimit } from './browser-agent-downloads';
import { browserPageOrigin, installBrowserPageDialogs, refreshBrowserPageDialogControl, watchBrowserNavigationRequests, type BrowserNavigationPostData } from './browser-page-dialogs';
import { setAutomaticDownloadPath } from './downloads';
import { BROWSER_ZOOM_STEPS } from '../../shared/browser-zoom';
import { BROWSER_PARTITION, browserAutoplayPolicy, browserSoundMuted, configureBrowserSitePermissions, onBrowserPermissionUserAnswer, recordBrowserSiteVisit } from './browser-sites';
import type { BrowserAutoplayPolicy } from '../../shared/browser-autoplay';
import { browserAddressKind, browserSearchUrl } from '../../shared/browser-search';
import { installFileReadFallbackGuard } from './browser-file-read-guard';
import { app, BaseWindow, BrowserWindow, clipboard, shell, dialog, nativeTheme, session, webContents, WebContentsView } from 'electron';
import type { MainWindow } from '../window/main-window';
import type { DownloadItem, NavigationEntry, Rectangle, Session, View, WebContents } from 'electron';
import { existsSync } from 'node:fs';
import { copyFile, rename, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join } from 'node:path';

import {
  EMPTY_BROWSER_STATE,
  BROWSER_STATE_TITLE_MAX,
  BROWSER_STATE_URL_MAX,
  type BrowserBounds,
  type BrowserId,
  type BrowserState,
  type BrowserStateEvent,
} from '../../shared/browser';
import {
  browserDeviceViewBounds,
  getBrowserDeviceProfile,
  type BrowserDeviceModeRequest,
  type BrowserDeviceProfile,
  type BrowserDeviceState,
} from '../../shared/browser-device';
import { browserEn, browserZh } from '@moonshot-ai/app-i18n/browser';
import { effectiveContextMenuLocale, installBrowserContextMenu } from '../shell/context-menu';
import { BROWSER_ANNOTATION_WORLD, browserAnnotationContextTargetScript, browserAnnotationContextTrackingScript } from './browser-annotation-script';
import { BROWSER_LINK_CLICK_QUERY_TIMEOUT_MS, browserLinkClickedScript, browserLinkClickTrackingScript } from './browser-link-click-script';
import { isBrowserOverlayView, observeBrowserOverlayOutsidePointer, refreshBrowserAnnotationOverlay } from './browser-overlay';
import { IPC } from '../ipc/ipc-channels';
import { isRestorableBrowserUrl, type BrowserPagePersistence } from './browser-session-store';
import { browserDebuggerGeneration, browserFocusEmulationEnabled, setBrowserFocusEmulation, isBrowserInputActive, ensureBrowserDebugger, releaseBrowserDebugger, setBrowserMouseTouchEmulation } from './browser-debugger';
import { activeBrowserUserAgent, customBrowserUserAgent, electronUserAgent, resetCustomBrowserUserAgentCache } from './browser-user-agent';
import { baseBrowserUserAgent, createBrowserUserAgentSync, syncContentsUserAgent, type BrowserUserAgentSync } from './browser-user-agent-sync';
import { rewriteBrowserRequestHeaders, strippedBrowserUserAgent } from '../../shared/browser-user-agent';
import { log, redactUrlForLog } from '../diagnostics/log';
import { localFileAddressUrl } from './browser-local-file';
import {
  claimBrowserDownloadRetry,
  configureBrowserDownloadsDirectory,
  ensureBrowserDownloadsAccess,
  noteBrowserDownloadsFailure,
  getBrowserData,
  recordBrowserHistory,
  relocateBrowserDownload,
  retryBrowserDownload,
  updateBrowserHistoryFavicon,
  trackBrowserDownload,
} from './browser-data';

const configuredSessions = new WeakSet<object>();

interface BrowserEntry {
  browserId: BrowserId;
  restoreUrl: string;
  restoring: Promise<BrowserState> | null;
  view: WebContentsView | null;
  autoplayPolicy: BrowserAutoplayPolicy;
  soundOverride: boolean | undefined;
  bounds: BrowserBounds;
  hasVisibleBounds: boolean;
  displayed: boolean | null;
  requestedVisible: boolean;
  pageRenderable: boolean;
  state: BrowserState;
  generation: number;
  committedGeneration: number;
  domReadyGeneration: number;
  completeGeneration: number;
  waiters: Set<BrowserLoadWaiter>;
  deviceApplyRevision: number;
  deviceSyncPending: boolean;
  deviceSyncInFlight: number;
  deviceSyncFailedGeneration: number | null;
  deviceEmulationBlocked: boolean;
  deviceReloadAwaitingUnload: boolean;
  appliedDeviceProfile: BrowserDeviceState['profileId'] | null;
  pageDeviceProfile: BrowserDeviceState['profileId'] | null;
  userAgentSync: BrowserUserAgentSync | null;
  deferredNavigation: BrowserDeferredNavigation | null;
  deviceUpdateChain: Promise<void>;
  keepPageOnRefusedUnload: (() => void) | null;
  addressLoad: { generation: number; url: string } | null;
  downloadGeneration: number;
  downloadHandoff: { generation: number; started: () => void } | null;
  unloadTarget: UnloadTarget | null;
}

interface UnloadTarget {
  kind: 'url' | 'back' | 'forward' | 'reload' | 'close';
  url?: string;
  post?: boolean;
  postData?: BrowserNavigationPostData;
  at: number;
}

function observedNavigationTarget(current: UnloadTarget | null, url: string, reason: string, postData?: BrowserNavigationPostData): UnloadTarget {
  const post = reason === 'formSubmissionPost';
  const previous = current?.url === url && current.post === true ? current.postData : undefined;
  return { kind: 'url', url, post, ...(post && (postData !== undefined || previous !== undefined) ? { postData: postData ?? previous } : {}), at: Date.now() };
}

interface BrowserDeferredNavigation {
  generation: number;
  favicon: string | undefined;
}

interface BrowserLoadWaiter {
  state: 'committed' | 'dom_ready' | 'complete';
  generation: number;
  resolve: (state: BrowserState) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  disposeAbort: () => void;
}

export interface BrowserEntrySnapshot {
  browserId: BrowserId;
  state: BrowserState;
  generation: number;
}

let hostWindow: MainWindow | null = null;
let backgroundWindow: BaseWindow | null = null;
const browserWindows = new Set<BrowserWindow>();
const browserWindowOwners = new WeakMap<BrowserWindow, BrowserId>();
const browserEntries = new Map<BrowserId, BrowserEntry>();
const appClosedViews = new WeakSet<WebContentsView>();
const autoplayRebuilds = new WeakMap<WebContents, symbol>();
const autoplayRestores = new WeakSet<WebContents>();
const pendingAutoplayNavigations = new WeakMap<WebContents, string>();
let pagePersistence: BrowserPagePersistence | null = null;
let clearingBrowserData: Promise<void> | null = null;
let lastDownloadDirectory: string | null = null;

export function setBrowserPagePersistence(persistence: BrowserPagePersistence | null): void {
  pagePersistence = persistence;
}

let localPagesExtraPrivileges: () => boolean = () => true;
let localPagesAllowed: () => Promise<boolean> = () => Promise.resolve(false);

export function setLocalPagesExtraPrivileges(read: () => boolean): void {
  localPagesExtraPrivileges = read;
}

export function setLocalPagesPolicy(policy: () => Promise<boolean>): void {
  localPagesAllowed = policy;
}

export function browserLocalPagesAllowed(): Promise<boolean> {
  return localPagesAllowed();
}

export function agentLocalFilesEnabled(): boolean {
  return getBrowserData().preferences.agentLocalFiles === true;
}

function createEntry(browserId: BrowserId): BrowserEntry {
  const saved = pagePersistence?.getPage(browserId);
  return {
    browserId,
    restoreUrl: saved?.url ?? '',
    restoring: null,
    view: null,
    autoplayPolicy: browserAutoplayPolicy(saved?.url ?? ''),
    soundOverride: saved?.muted,
    bounds: { x: 0, y: 0, width: 1280, height: 720 },
    hasVisibleBounds: false,
    displayed: null,
    requestedVisible: false,
    pageRenderable: false,
    state: { ...EMPTY_BROWSER_STATE, ...(saved === undefined ? {} : { ...browserStateUrl(saved.url), title: saved.title, zoomFactor: saved.zoomFactor, favicon: saved.favicon }), muted: saved?.muted ?? browserSoundMuted(saved?.url ?? '') },
    generation: 0,
    committedGeneration: -1,
    domReadyGeneration: -1,
    completeGeneration: -1,
    waiters: new Set(),
    deviceApplyRevision: 0,
    deviceSyncPending: false,
    deviceSyncInFlight: 0,
    deviceSyncFailedGeneration: null,
    deviceEmulationBlocked: false,
    deviceReloadAwaitingUnload: false,
    appliedDeviceProfile: null,
    pageDeviceProfile: null,
    userAgentSync: null,
    deferredNavigation: null,
    deviceUpdateChain: Promise.resolve(),
    keepPageOnRefusedUnload: null,
    addressLoad: null,
    downloadGeneration: -1,
    downloadHandoff: null,
    unloadTarget: null,
  };
}

function ensureEntry(browserId: BrowserId): BrowserEntry {
  const existing = browserEntries.get(browserId);
  if (existing !== undefined) return existing;
  const entry = createEntry(browserId);
  browserEntries.set(browserId, entry);
  return entry;
}

function copyState(entry: BrowserEntry | undefined): BrowserState {
  return entry === undefined ? { ...EMPTY_BROWSER_STATE } : { ...entry.state, ...(entry.pageRenderable ? { renderable: true } : {}) };
}

function liveHost(): MainWindow | null {
  return hostWindow !== null && !hostWindow.isDestroyed() ? hostWindow : null;
}

function liveView(entry: BrowserEntry): WebContentsView | null {
  const view = entry.view;
  if (view === null) return null;
  const contents = view.webContents as WebContents | undefined;
  if (contents !== undefined && !contents.isDestroyed()) return view;
  entry.view = null;
  entry.userAgentSync?.dispose();
  entry.userAgentSync = null;
  liveHost()?.contentView.removeChildView(view);
  if (backgroundWindow !== null && !backgroundWindow.isDestroyed()) backgroundWindow.contentView.removeChildView(view);
  return null;
}

function publishState(entry: BrowserEntry): void {
  try {
    const restorable = isRestorableBrowserUrl(entry.restoreUrl);
    pagePersistence?.savePage(entry.browserId, { url: restorable ? entry.restoreUrl : '', title: restorable ? entry.state.title : '', favicon: restorable ? entry.state.favicon : undefined, zoomFactor: entry.state.zoomFactor ?? 1, ...(entry.soundOverride === undefined ? {} : { muted: entry.soundOverride }) });
  } catch (error) {
    log.error('[kimi-desktop] failed to persist browser page', error);
  }
  const payload: BrowserStateEvent = {
    browserId: entry.browserId,
    state: copyState(entry),
  };
  liveHost()?.webContents.send(IPC.browserState, payload);
}

const faviconLoads = new WeakMap<BrowserEntry, AbortController>();

async function refreshFavicon(entry: BrowserEntry, view: WebContentsView, urls: string[]): Promise<void> {
  faviconLoads.get(entry)?.abort();
  const controller = new AbortController();
  faviconLoads.set(entry, controller);
  const generation = entry.generation;
  try {
    const favicon = await loadBrowserFavicon(urls, (url, init) => view.webContents.session.fetch(url, init), controller.signal);
    if (controller.signal.aborted || entry.generation !== generation || liveView(entry) !== view || !favicon) return;
    if (entry.state.favicon === favicon) return;
    entry.state = { ...entry.state, favicon };
    const url = view.webContents.getURL();
    if (isAllowedBrowserUrl(url) || isLocalFileUrl(url)) updateBrowserHistoryFavicon(url, favicon);
    publishState(entry);
  } finally { if (faviconLoads.get(entry) === controller) faviconLoads.delete(entry); }
}

function deferNavigation(entry: BrowserEntry, favicon: string | undefined): BrowserDeferredNavigation {
  const deferred = { generation: entry.generation, favicon };
  entry.deferredNavigation = deferred;
  return deferred;
}

function takeDeferredNavigation(entry: BrowserEntry, deferred: BrowserDeferredNavigation): boolean {
  if (entry.deferredNavigation !== deferred) return false;
  entry.deferredNavigation = null;
  return deferred.generation === entry.generation;
}

function cancelDeferredNavigation(entry: BrowserEntry, view: WebContentsView): void {
  const deferred = entry.deferredNavigation;
  if (deferred === null) return;
  entry.deferredNavigation = null;
  if (deferred.generation !== entry.generation || keepPage(entry, view, deferred.generation, deferred.favicon)) return;
  entry.state = { ...entry.state, loading: false };
  rejectLoadWaiters(entry, 'Navigation stopped.');
  publishState(entry);
}

function beginNavigation(entry: BrowserEntry): void {
  entry.keepPageOnRefusedUnload = null;
  entry.deviceReloadAwaitingUnload = false;
  entry.deferredNavigation = null;
  faviconLoads.get(entry)?.abort();
  faviconLoads.delete(entry);
  entry.generation += 1;
  entry.committedGeneration = -1;
  entry.domReadyGeneration = -1;
  entry.completeGeneration = -1;
  entry.state = { ...entry.state, favicon: undefined, loading: true, error: undefined };
  settleLoadWaiters(entry);
}

function loadStateReached(entry: BrowserEntry, state: BrowserLoadWaiter['state'], generation: number): boolean {
  if (generation !== entry.generation) return false;
  if (state === 'committed') {
    return (
      entry.committedGeneration === generation ||
      entry.domReadyGeneration === generation ||
      entry.completeGeneration === generation
    );
  }
  if (state === 'dom_ready') {
    return entry.domReadyGeneration === generation || entry.completeGeneration === generation;
  }
  return entry.completeGeneration === generation;
}

function deviceSyncOutcome(entry: BrowserEntry): 'hold' | 'failed' | 'ready' {
  if (entry.deviceSyncInFlight > 0 || entry.deviceReloadAwaitingUnload) return 'hold';
  if (!entry.deviceSyncPending) return 'ready';
  if (!entry.state.loading) return 'failed';
  return (entry.state.device?.profileId ?? null) !== entry.pageDeviceProfile ? 'hold' : 'ready';
}

function settleLoadWaiters(entry: BrowserEntry, error?: Error): void {
  for (const waiter of entry.waiters) {
    const navigationChanged = waiter.generation !== entry.generation;
    const reached = error === undefined && !navigationChanged && loadStateReached(entry, waiter.state, waiter.generation);
    const outcome = reached ? deviceSyncOutcome(entry) : 'ready';
    if (error === undefined && !navigationChanged && (!reached || outcome === 'hold')) continue;
    entry.waiters.delete(waiter);
    clearTimeout(waiter.timer);
    waiter.disposeAbort();
    if (error !== undefined) waiter.reject(error);
    else if (navigationChanged) waiter.reject(new Error('Browser navigation changed while waiting.'));
    else if (outcome === 'failed') waiter.reject(new Error(DEVICE_SYNC_FAILED));
    else waiter.resolve(copyState(entry));
  }
}

function rejectLoadWaiters(entry: BrowserEntry, message: string): void {
  settleLoadWaiters(entry, new Error(message));
}

function navigationState(entry: BrowserEntry): Pick<BrowserState, 'canGoBack' | 'canGoForward'> {
  const view = liveView(entry);
  if (view === null) return { canGoBack: false, canGoForward: false };
  return {
    canGoBack: view.webContents.navigationHistory.canGoBack(),
    canGoForward: view.webContents.navigationHistory.canGoForward(),
  };
}

function syncCommittedState(entry: BrowserEntry): void {
  const view = liveView(entry);
  if (view === null) return;
  const committedUrl = view.webContents.getURL();
  if (isRestorableBrowserUrl(committedUrl)) entry.restoreUrl = committedUrl;
  const visibleUrl = browserStateUrl(committedUrl);
  entry.state = {
    ...entry.state,
    ...(visibleUrl === null ? {} : visibleUrl),
    title: view.webContents.getTitle().slice(0, BROWSER_STATE_TITLE_MAX),
    loading: view.webContents.isLoading(),
    zoomFactor: view.webContents.getZoomFactor(),
    ...navigationState(entry),
  };
  publishState(entry);
}

function recordPageVisit(entry: BrowserEntry): void {
  if ((isAllowedBrowserUrl(entry.state.url) || isLocalFileUrl(entry.state.url)) && entry.state.urlTruncated !== true) {
    recordBrowserHistory({ url: entry.state.url, title: entry.state.title || entry.state.url, favicon: entry.state.favicon });
  }
}

function browserStateUrl(value: string): Pick<BrowserState, 'url' | 'urlTruncated'> | null {
  if (value === '' || value === 'about:blank') return null;
  try {
    const protocol = new URL(value).protocol;
    if (protocol !== 'http:' && protocol !== 'https:' && protocol !== 'file:') return null;
  } catch {
    return null;
  }
  if (value.length <= BROWSER_STATE_URL_MAX) {
    return { url: value, urlTruncated: undefined };
  }
  return {
    url: `${value.slice(0, BROWSER_STATE_URL_MAX - 1)}…`,
    urlTruncated: true,
  };
}

function roundDeviceScale(value: number): number {
  return Math.max(0.01, Math.min(1, Math.floor(value * 100) / 100));
}

function deviceDisplayScale(
  bounds: BrowserBounds,
  width: number,
  height: number,
  scaleMode: BrowserDeviceState['scaleMode'],
  requestedScale: number,
): { displayScale: number; maxDisplayScale: number } {
  const maxDisplayScale =
    bounds.width <= 0 || bounds.height <= 0
      ? 1
      : roundDeviceScale(Math.min(bounds.width / width, bounds.height / height));
  return {
    maxDisplayScale,
    displayScale:
      scaleMode === 'fit' ? maxDisplayScale : roundDeviceScale(Math.min(requestedScale, maxDisplayScale)),
  };
}

function syncDeviceGeometry(entry: BrowserEntry): boolean {
  const device = entry.state.device;
  if (device === undefined) return false;
  const scales = deviceDisplayScale(
    entry.bounds,
    device.width,
    device.height,
    device.scaleMode,
    device.requestedScale,
  );
  if (
    scales.displayScale === device.displayScale &&
    scales.maxDisplayScale === device.maxDisplayScale
  ) {
    return false;
  }
  entry.state = { ...entry.state, device: { ...device, ...scales } };
  return true;
}

function deviceViewBounds(entry: BrowserEntry): BrowserBounds {
  return browserDeviceViewBounds(entry.bounds, entry.state.device);
}

function hostWindowZoomFactor(): number {
  const host = liveHost();
  if (host === null) return 1;
  try {
    const factor = host.webContents.getZoomFactor();
    return typeof factor === 'number' && Number.isFinite(factor) && factor > 0 ? factor : 1;
  } catch {
    return 1;
  }
}

function browserViewDeviceBounds(entry: BrowserEntry): BrowserBounds {
  const bounds = deviceViewBounds(entry);
  const zoom = hostWindowZoomFactor();
  if (Math.abs(zoom - 1) < 0.001) return bounds;
  const left = Math.floor(bounds.x * zoom);
  const top = Math.floor(bounds.y * zoom);
  return {
    x: left,
    y: top,
    width: Math.ceil((bounds.x + bounds.width) * zoom) - left,
    height: Math.ceil((bounds.y + bounds.height) * zoom) - top,
  };
}

function parkView(view: WebContentsView): void {
  if (backgroundWindow === null || backgroundWindow.isDestroyed()) backgroundWindow = new BaseWindow({ show: false, focusable: false, skipTaskbar: true, frame: false, width: 1280, height: 720 });
  backgroundWindow.contentView.addChildView(view);
  view.setVisible(true);
}

const frameHolds = new WeakMap<WebContents, number>();

function holdFrames(contents: WebContents): () => void {
  const holds = frameHolds.get(contents) ?? 0;
  frameHolds.set(contents, holds + 1);
  if (holds === 0) contents.beginFrameSubscription(false, () => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const remaining = (frameHolds.get(contents) ?? 1) - 1;
    if (remaining > 0) {
      frameHolds.set(contents, remaining);
      return;
    }
    frameHolds.delete(contents);
    if (!contents.isDestroyed()) contents.endFrameSubscription();
  };
}

function attachToHost(host: MainWindow, view: WebContentsView): void {
  backgroundWindow?.contentView.removeChildView(view);
  const children = host.contentView.children;
  const hostIndex = children.indexOf(host.hostView);
  const lowest = children.findIndex(child => child !== host.hostView);
  let index = lowest < 0 ? children.length : lowest;
  if (hostIndex >= 0) index = occludedBrowsers.size > 0 ? Math.min(index, hostIndex) : Math.max(index, hostIndex + 1);
  host.contentView.addChildView(view, index);
}

const occludedBrowsers = new Set<BrowserId>();
let occlusionFocusTarget: WebContents | null = null;

export function isBrowserOccluded(): boolean {
  return occludedBrowsers.size > 0;
}

export function browserHostLayerOrder(host: MainWindow, occluded: boolean): View[] {
  const others = host.contentView.children.filter(child => child !== host.hostView);
  if (!occluded) return [host.hostView, ...others];
  const top = others.findIndex(child => isBrowserOverlayView(child));
  const split = top < 0 ? others.length : top;
  return [...others.slice(0, split), host.hostView, ...others.slice(split)];
}

function placeHostView(host: MainWindow): void {
  const occluded = occludedBrowsers.size > 0;
  const index = browserHostLayerOrder(host, occluded).indexOf(host.hostView);
  if (host.contentView.children.indexOf(host.hostView) !== index) host.contentView.addChildView(host.hostView, index);
}

function showsWebContents(host: MainWindow, contents: WebContents): boolean {
  return host.contentView.children.some(child => child !== host.hostView && (child as WebContentsView).webContents === contents && child.getVisible());
}

function applyBrowserOcclusion(wasOccluded: boolean): void {
  const host = liveHost();
  const occluded = occludedBrowsers.size > 0;
  if (host === null || wasOccluded === occluded) return;
  placeHostView(host);
  const hostContents = host.webContents;
  if (hostContents.isDestroyed()) return;
  if (occluded) {
    const focused = webContents.getFocusedWebContents();
    occlusionFocusTarget = focused !== null && !focused.isDestroyed() && showsWebContents(host, focused) ? focused : null;
    if (occlusionFocusTarget !== null && host.isFocused()) hostContents.focus();
    return;
  }
  const target = occlusionFocusTarget;
  occlusionFocusTarget = null;
  if (target === null || target.isDestroyed() || !showsWebContents(host, target) || !host.isFocused()) return;
  const focused = webContents.getFocusedWebContents();
  if (focused === null || focused === hostContents) target.focus();
}

export function setBrowserOccluded(browserId: BrowserId, occluded: boolean): void {
  const wasOccluded = occludedBrowsers.size > 0;
  if (occluded) occludedBrowsers.add(browserId);
  else occludedBrowsers.delete(browserId);
  applyBrowserOcclusion(wasOccluded);
}

function clearBrowserOcclusion(): void {
  const wasOccluded = occludedBrowsers.size > 0;
  occludedBrowsers.clear();
  applyBrowserOcclusion(wasOccluded);
  occlusionFocusTarget = null;
}

const captures = new WeakMap<BrowserEntry, { active: number; lent: boolean }>();

export function keepBrowserPageRendering(contents: WebContents): () => void {
  const entry = [...browserEntries.values()].find(candidate => candidate.view?.webContents === contents);
  const view = entry === undefined ? null : liveView(entry);
  const host = liveHost();
  if (entry === undefined || view === null || host === null || entry.displayed === null) return () => {};
  const capture = captures.get(entry) ?? { active: 0, lent: false };
  captures.set(entry, capture);
  capture.active += 1;
  const moveOut = () => {
    if (liveView(entry) !== view || !host.contentView.children.includes(view)) return;
    host.contentView.removeChildView(view);
    parkView(view);
    if (entry.displayed === true) capture.lent = true;
    applyViewGeometry(entry);
  };
  const moveBack = () => {
    if (!capture.lent) return;
    capture.lent = false;
    if (host.isDestroyed() || liveView(entry) !== view || entry.displayed !== true || host.contentView.children.includes(view)) return;
    attachToHost(host, view);
    view.setVisible(true);
    applyViewGeometry(entry);
  };
  const releaseFrames = entry.displayed === false && host.isVisible() && host.contentView.children.includes(view) ? holdFrames(contents) : () => {};
  if (!host.isVisible()) moveOut();
  host.on('minimize', moveOut);
  host.on('hide', moveOut);
  host.on('restore', moveBack);
  host.on('show', moveBack);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    host.removeListener('minimize', moveOut);
    host.removeListener('hide', moveOut);
    host.removeListener('restore', moveBack);
    host.removeListener('show', moveBack);
    releaseFrames();
    capture.active -= 1;
    if (capture.active > 0) return;
    captures.delete(entry);
    moveBack();
  };
}

function applyViewGeometry(entry: BrowserEntry, refreshDeviceMetrics = false): void {
  const view = liveView(entry);
  if (view === null) return;
  if (backgroundWindow?.isDestroyed()) backgroundWindow = null;
  const deviceChanged = syncDeviceGeometry(entry);
  const visible = entry.requestedVisible && entry.hasVisibleBounds && entry.pageRenderable && liveHost() !== null;
  const bounds = browserViewDeviceBounds(entry);
  const host = liveHost();
  if (host !== null && entry.displayed !== visible) {
    entry.displayed = visible;
    if (visible) {
      view.setBounds(bounds as Rectangle);
      if (!host.contentView.children.includes(view)) attachToHost(host, view);
      view.setVisible(true);
    } else if (host.contentView.children.includes(view)) {
      const wasFocused = view.webContents.isFocused();
      view.setVisible(false);
      if (wasFocused && host.isFocused()) host.webContents.focus();
    } else {
      parkView(view);
    }
  }
  const parking = backgroundWindow !== null && backgroundWindow.contentView.children.includes(view) ? backgroundWindow : null;
  if (entry.displayed === false || parking !== null) {
    if (parking !== null) {
      const [width = 1280, height = 720] = parking.getContentSize();
      if (bounds.width > width || bounds.height > height) parking.setContentSize(Math.max(width, bounds.width), Math.max(height, bounds.height));
    }
    view.setBounds({ ...bounds, x: 0, y: 0 } as Rectangle);
  } else if (entry.displayed === true) {
    view.setBounds(bounds as Rectangle);
  }
  refreshBrowserControlSurface();
  if (deviceChanged) publishState(entry);
  if ((deviceChanged || refreshDeviceMetrics) && entry.state.device !== undefined) {
    void queueDeviceEmulation(entry, false).catch((error: unknown) => {
      log.warn(`[kimi-desktop] browser device metrics update failed: ${String(error)}`);
    });
  }
}

function reapplyBrowserViewGeometry(): void {
  for (const entry of browserEntries.values()) {
    applyViewGeometry(entry, true);
  }
}

export function isAllowedBrowserUrl(value: string): boolean {
  if (value.length > BROWSER_STATE_URL_MAX) return false;
  try {
    const protocol = new URL(value).protocol;
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

export function isLocalFileUrl(value: string): boolean {
  try {
    return new URL(value).protocol === 'file:';
  } catch {
    return false;
  }
}

function isVisibleBrowserUrl(value: string): boolean {
  return isAllowedBrowserUrl(value) || (value.length <= BROWSER_STATE_URL_MAX && isLocalFileUrl(value));
}

function showsLocalFile(entry: BrowserEntry): boolean {
  const view = liveView(entry);
  return (view !== null && isLocalFileUrl(view.webContents.getURL())) || isLocalFileUrl(entry.state.url);
}

export function browserDownloadsDirectory(): string {
  return app.getPath('downloads');
}

export function browserHistoryTargetIsLocalFile(browserId: BrowserId, delta: -1 | 1): boolean {
  const entry = browserEntries.get(browserId);
  const view = entry === undefined ? null : liveView(entry);
  if (view === null) return false;
  const history = view.webContents.navigationHistory;
  const target = history.getAllEntries()[history.getActiveIndex() + delta];
  return target !== undefined && isLocalFileUrl(target.url);
}

export function normalizeBrowserAddress(value: string): string {
  const input = value.trim();
  if (input === '') throw new Error('browser-navigate: empty address');
  if (input.length > BROWSER_STATE_URL_MAX) throw new Error('browser-navigate: address is too long');
  const kind = browserAddressKind(input);
  if (kind === 'search') {
    const search = browserSearchUrl(input, getBrowserData().preferences.searchEngine);
    if (search.length > BROWSER_STATE_URL_MAX) throw new Error('browser-navigate: address is too long');
    return search;
  }
  const candidate = kind === 'http' ? `http://${input}` : kind === 'url' ? input : `https://${input}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    throw new Error('browser-navigate: invalid address');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('browser-navigate: only http(s) URLs are allowed');
  }
  const normalized = parsed.toString();
  if (normalized.length > BROWSER_STATE_URL_MAX) {
    throw new Error('browser-navigate: address is too long');
  }
  return normalized;
}




export { strippedBrowserUserAgent as browserUserAgent };

function deviceModeContents(webContentsId: number | undefined): boolean {
  if (webContentsId === undefined) return false;
  for (const entry of browserEntries.values()) {
    if (entry.state.device === undefined) continue;
    if (liveView(entry)?.webContents.id === webContentsId) return true;
  }
  return false;
}

function applySessionUserAgent(browserSession: Session): void {
  browserSession.setUserAgent(baseBrowserUserAgent());
}

function enqueueDeviceTask(entry: BrowserEntry, run: () => Promise<void>): Promise<void> {
  return entry.userAgentSync === null ? Promise.resolve().then(run) : entry.userAgentSync.enqueue(run);
}

const popupUserAgentSyncs = new Map<BrowserWindow, BrowserUserAgentSync>();
const popupAutoplayPolicies = new WeakMap<BrowserWindow, BrowserAutoplayPolicy>();
const popupAutoplayUrls = new WeakMap<BrowserWindow, string>();

export function applyBrowserUserAgentPreference(): void {
  resetCustomBrowserUserAgentCache();
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  if (configuredSessions.has(browserSession)) applySessionUserAgent(browserSession);
  for (const entry of browserEntries.values()) entry.userAgentSync?.sync();
  for (const sync of popupUserAgentSyncs.values()) sync.sync();
}

function browserIdForContents(contents: WebContents): BrowserId | undefined {
  const tab = [...browserEntries.values()].find(entry => entry.view?.webContents === contents);
  if (tab !== undefined) return tab.browserId;
  const popup = [...browserWindows].find(window => !window.isDestroyed() && window.webContents === contents);
  return popup === undefined ? undefined : browserWindowOwners.get(popup);
}

configureBrowserDownloadsDirectory(() => app.getPath('downloads'));

function configureSession(browserSession: Session): void {
  if (configuredSessions.has(browserSession)) return;
  configuredSessions.add(browserSession);
  applySessionUserAgent(browserSession);
  browserSession.webRequest.onBeforeSendHeaders((details, callback) => {
    const requestHeaders = rewriteBrowserRequestHeaders({
      url: details.url,
      requestHeaders: details.requestHeaders,
      userAgent: activeBrowserUserAgent(),
      deviceMode: deviceModeContents(details.webContentsId),
      electronUserAgent: customBrowserUserAgent() === null ? electronUserAgent() : undefined,
    });
    callback(requestHeaders === null ? {} : { requestHeaders });
  });
  configureBrowserSitePermissions(browserSession, liveHost, browserIdForContents);
  installFileReadFallbackGuard(browserSession, () => localPagesExtraPrivileges());
  browserSession.on('will-download', (event, item, contents) => {
    const tab = contents == null ? undefined : [...browserEntries.values()].find(entry => entry.view?.webContents === contents);
    const addressLoad = tab?.addressLoad;
    if (tab !== undefined && addressLoad != null && addressLoad.generation === tab.generation && downloadStartedFromAddress(item, addressLoad.url)) {
      tab.downloadGeneration = tab.generation;
      if (tab.downloadHandoff?.generation === tab.generation) tab.downloadHandoff.started();
    }
    const retry = claimBrowserDownloadRetry(item, contents != null);
    if (contents != null) forgetDownloadRestoreUrl(contents, item);
    const browserId = contents == null ? undefined : browserIdForContents(contents);
    const agent = browserId !== undefined && agentAttributedDownload(browserId);
    const preferences = getBrowserData().preferences;
    const askWhereToSave = preferences.askWhereToSave;
    const limit = agent && retry === undefined ? agentDownloadLimit(preferences.agentDownloadLimitBytes) : null;
    if (limit !== null && agentDownloadOverLimit(item.getTotalBytes(), limit)) {
      event.preventDefault();
      blockAgentDownload(browserId!, item, undefined, item.getTotalBytes(), limit, false);
      return;
    }
    let automatic = false;
    if (retry?.savePath !== undefined) {
      if (item.getSavePath() !== retry.savePath) item.setSavePath(retry.savePath);
    } else if (askWhereToSave && !agent && userSeesDownload(contents)) {
      const directory = lastDownloadDirectory !== null && existsSync(lastDownloadDirectory) ? lastDownloadDirectory : app.getPath('downloads');
      item.setSaveDialogOptions({ title: browserStrings().saveDialog.download, defaultPath: join(directory, item.getFilename()) });
      item.once('done', () => { const savePath = item.getSavePath(); if (savePath !== '') lastDownloadDirectory = dirname(savePath); });
    } else {
      let directory: string | undefined;
      try { directory = agent ? ensureBrowserDownloadsAccess().path : app.getPath('downloads'); setAutomaticDownloadPath(item, directory); automatic = true; }
      catch (error) {
        log.warn(`[kimi-desktop] automatic download path could not be reserved: ${String(error)}`);
        if (agent) {
          noteBrowserDownloadsFailure(error);
          event.preventDefault();
          failAgentDownload(browserId!, item, directory, error);
          return;
        }
      }
    }
    const downloadId = trackBrowserDownload(item, retry?.id);
    const blocked = limit === null ? () => false : limitAgentDownload(browserId!, item, downloadId, limit);
    if (retry?.resume === true) item.resume();
    if (automatic && browserId !== undefined && (agent || askWhereToSave)) announceAutomaticDownload(browserId, item, downloadId, agent, blocked);
  });
}

const agentAttributedTabs = new Set<BrowserId>();
const USER_DOWNLOAD_WINDOW_MS = 30_000;
const userDownloadTabs = new Map<BrowserId, number>();

function attributeDownloadsToUser(browserId: BrowserId): void {
  agentAttributedTabs.delete(browserId);
  userDownloadTabs.set(browserId, Date.now() + USER_DOWNLOAD_WINDOW_MS);
}

function agentAttributedDownload(browserId: BrowserId): boolean {
  const until = userDownloadTabs.get(browserId);
  if (until !== undefined && Date.now() < until) return false;
  userDownloadTabs.delete(browserId);
  if (isBrowserAgentControlled(browserId)) agentAttributedTabs.add(browserId);
  return agentAttributedTabs.has(browserId);
}

function browserStrings() {
  return effectiveContextMenuLocale() === 'zh' ? browserZh : browserEn;
}

function userSeesDownload(initiator: WebContents | null | undefined): boolean {
  if (initiator == null) return false;
  const popup = [...browserWindows].find(window => !window.isDestroyed() && window.webContents === initiator);
  if (popup !== undefined) return popup.isVisible();
  const entry = [...browserEntries.values()].find(candidate => candidate.view?.webContents === initiator);
  const host = liveHost();
  return entry?.displayed === true && host !== null && host.isVisible();
}

function blockAgentDownload(browserId: BrowserId, item: DownloadItem, downloadId: string | undefined, bytes: number, limit: number, streaming: boolean): void {
  const name = item.getFilename() || 'download';
  pushBrowserNotice(browserId, agentDownloadLimitMessage(name, bytes, limit, streaming));
  if (downloadId !== undefined && updateBrowserDownloadRecord(downloadId, { path: null, outcome: 'too-large' })) return;
  recordBrowserDialogEvent(browserId, { kind: 'download', origin: browserPageOrigin(item.getURL()), message: name, outcome: 'too-large', ...(downloadId === undefined ? {} : { downloadId }) }, { deferred: true });
}

function failAgentDownload(browserId: BrowserId, item: DownloadItem, directory: string | undefined, error: unknown): void {
  const name = item.getFilename() || 'download';
  const code = (error as NodeJS.ErrnoException | null)?.code;
  pushBrowserNotice(browserId, `Download of ${JSON.stringify(name)} was cancelled: the agent download folder ${directory ?? ''} is not available${code ? ` (${code})` : ''}. Nothing was saved. Ask the user to check the agent download folder in Settings, then retry.`);
  recordBrowserDialogEvent(browserId, { kind: 'download', origin: browserPageOrigin(item.getURL()), message: name, outcome: 'cancelled' }, { deferred: true });
}

const PARTIAL_UNLINK_RETRY_MS = [100, 500];

async function removeBlockedPartial(browserId: BrowserId, item: DownloadItem, downloadId: string, partial: string): Promise<void> {
  let failure: unknown;
  for (const delay of [0, ...PARTIAL_UNLINK_RETRY_MS]) {
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    try {
      await unlink(partial);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return;
      failure = error;
    }
  }
  const code = (failure as NodeJS.ErrnoException | null)?.code;
  log.warn(`[kimi-desktop] blocked agent download partial file could not be removed: ${String(failure)}`);
  updateBrowserDownloadRecord(downloadId, { path: partial });
  pushBrowserNotice(browserId, `The partial file of the blocked download ${JSON.stringify(item.getFilename() || 'download')} could not be deleted${code ? ` (${code})` : ''} and remains at ${JSON.stringify(partial)}. Tell the user so they can delete it.`);
}

function limitAgentDownload(browserId: BrowserId, item: DownloadItem, downloadId: string, limit: number): () => boolean {
  let blocked = false;
  const check = (): void => {
    const received = item.getReceivedBytes();
    if (blocked || !agentDownloadOverLimit(received, limit)) return;
    blocked = true;
    item.removeListener('updated', check);
    const partial = item.getSavePath();
    item.once('done', () => { if (partial !== '') void removeBlockedPartial(browserId, item, downloadId, partial); });
    item.cancel();
    blockAgentDownload(browserId, item, downloadId, received, limit, true);
  };
  item.on('updated', check);
  item.once('done', () => item.removeListener('updated', check));
  return () => blocked;
}

function forgetDownloadRestoreUrl(contents: WebContents, item: DownloadItem): void {
  const entry = [...browserEntries.values()].find(candidate => candidate.view?.webContents === contents);
  if (entry === undefined || ![item.getURL(), ...item.getURLChain()].includes(entry.restoreUrl)) return;
  const committedUrl = contents.getURL();
  if (committedUrl === entry.restoreUrl) return;
  entry.restoreUrl = isRestorableBrowserUrl(committedUrl) ? committedUrl : '';
  publishState(entry);
}

const DOWNLOAD_NOTICE_MS = 60_000;
const AGENT_DOWNLOADS_MAX = 64;
const agentDownloads = new Map<string, DownloadItem>();

function recordAgentDownloadResult(browserId: BrowserId, item: DownloadItem, downloadId: string, blocked: () => boolean): void {
  if (blocked()) return;
  const completed = item.getState() === 'completed';
  const savePath = item.getSavePath();
  const patch = completed ? { path: savePath, outcome: 'saved' as const } : { path: null, outcome: 'cancelled' as const };
  if (updateBrowserDownloadRecord(downloadId, patch)) return;
  recordBrowserDialogEvent(browserId, { kind: 'download', origin: browserPageOrigin(item.getURL()), message: item.getFilename(), outcome: patch.outcome, ...(completed ? { files: [savePath] } : {}), downloadId }, { deferred: true });
}

function announceAutomaticDownload(browserId: BrowserId, item: DownloadItem, downloadId: string, agent: boolean, blocked: () => boolean): void {
  const savePath = item.getSavePath();
  if (agent) {
    pushBrowserNotice(browserId, `Download started: ${JSON.stringify(item.getFilename())} is saved to ${JSON.stringify(savePath)}. Use browser.get_downloads to check progress.`);
    agentDownloads.delete(downloadId);
    agentDownloads.set(downloadId, item);
    while (agentDownloads.size > AGENT_DOWNLOADS_MAX) agentDownloads.delete(agentDownloads.keys().next().value!);
    item.once('done', () => recordAgentDownloadResult(browserId, item, downloadId, blocked));
    return;
  }
  const done = item.getState() === 'progressing'
    ? new Promise<boolean>(resolve => item.once('done', () => resolve(item.getState() === 'completed')))
    : Promise.resolve(item.getState() === 'completed');
  openBrowserDialog({
    browserId, kind: 'download', origin: browserPageOrigin(item.getURL()), message: item.getFilename(), files: [savePath], userOnly: true, timeoutMs: DOWNLOAD_NOTICE_MS,
    download: { id: downloadId, done },
    onAnswer: async (answer) => {
      if (answer === null) return;
      const target = answer.accept ? await moveBrowserDownloadOrReport(item, downloadId) : undefined;
      return { accept: answer.accept, by: answer.by, ...(target === undefined ? {} : { files: [target] }) };
    },
  });
}

async function moveBrowserDownload(item: DownloadItem | undefined, downloadId: string, source = item?.getSavePath() ?? ''): Promise<string | undefined> {
  if (source === '') throw new Error('the download has no saved file');
  const directory = lastDownloadDirectory !== null && existsSync(lastDownloadDirectory) ? lastDownloadDirectory : dirname(source);
  const options = { title: browserStrings().saveDialog.download, defaultPath: join(directory, basename(source)) };
  const host = liveHost();
  const result = host !== null && host.isVisible() ? await dialog.showSaveDialog(host, options) : await dialog.showSaveDialog(options);
  const target = result.filePath;
  if (result.canceled || target === undefined || target === '' || target === source) return undefined;
  if (item?.getState() === 'progressing') await new Promise(resolve => item.once('done', resolve));
  if (item !== undefined && item.getState() !== 'completed') return undefined;
  try {
    await rename(source, target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
    await copyFile(source, target);
    try {
      await unlink(source);
    } catch (unlinkError) {
      await unlink(target).catch(() => {});
      throw unlinkError;
    }
  }
  lastDownloadDirectory = dirname(target);
  relocateBrowserDownload(downloadId, target);
  updateBrowserDownloadRecord(downloadId, { path: target });
  return target;
}

function handleControlDownloadAction(action: 'show' | 'move', downloadId: string, path: string | undefined): void {
  if (action === 'show') {
    if (path !== undefined && path !== '') shell.showItemInFolder(path);
    return;
  }
  void moveBrowserDownloadOrReport(agentDownloads.get(downloadId), downloadId, path || undefined);
}

function moveBrowserDownloadOrReport(item: DownloadItem | undefined, downloadId: string, source?: string): Promise<string | undefined> {
  return moveBrowserDownload(item, downloadId, source).catch((error: unknown) => {
    log.warn(`[kimi-desktop] browser download could not be moved: ${String(error)}`);
    dialog.showErrorBox(browserStrings().saveDialog.download, error instanceof Error ? error.message : String(error));
    return undefined;
  });
}

export function retryBrowserViewDownload(id: string): Promise<boolean> {
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  configureSession(browserSession);
  return retryBrowserDownload(id, { session: browserSession, isAllowedUrl: isAllowedBrowserUrl });
}

function handleNavigationTarget(entry: BrowserEntry, url: string): void {
  if (isLocalFileUrl(url) && showsLocalFile(entry) && url.length <= BROWSER_STATE_URL_MAX) {
    void loadBrowserUrl(entry, url);
    return;
  }
  if (!isAllowedBrowserUrl(url)) { noteBlockedBrowserUrl(entry.browserId, url); return; }
  void navigateBrowser(entry.browserId, url);
}

function noteBlockedBrowserUrl(browserId: BrowserId, url: string): void {
  let scheme: string;
  try { scheme = new URL(url).protocol; } catch { return; }
  if (scheme === 'http:' || scheme === 'https:') return;
  const shown = url.length > 200 ? `${url.slice(0, 199)}…` : url;
  pushAgentBrowserNotice(browserId, `The page tried to open ${JSON.stringify(shown)}. ${scheme} links are blocked in the built-in browser; ask the user to open it in another app if needed.`, { kind: 'external-app', origin: browserPageOrigin(browserPageUrl(browserId)), message: shown });
}

function browserPageUrl(browserId: BrowserId): string {
  const entry = browserEntries.get(browserId);
  return (entry === undefined ? null : liveView(entry))?.webContents.getURL() ?? '';
}

const UNLOAD_TARGET_TTL_MS = 10_000;
const UNLOAD_GRANT_MS = 30_000;
const UNLOAD_RETRY_DELAY_MS = 500;
const UNLOAD_DIALOG_TIMEOUT_MS = 5 * 60_000;
const unloadGrants = new WeakMap<WebContents, { expiry: number; target: UnloadTarget | null }>();

interface BeforeUnloadOptions {
  target: () => UnloadTarget | null;
  retry: (target: UnloadTarget) => void;
  prompt: (contents: WebContents, target: UnloadTarget | null, leave: () => Promise<boolean>, stay: () => void) => void;
  onLeave?: (target: UnloadTarget | null) => boolean;
  onStay?: () => void;
  onRefused?: () => void;
  onDecided?: () => void;
}

export function grantBrowserUnload(contents: WebContents, target: UnloadTarget | null, now = Date.now()): void {
  unloadGrants.set(contents, { expiry: now + UNLOAD_GRANT_MS, target });
}

export function takeBrowserUnloadGrant(contents: WebContents, target: UnloadTarget | null, now = Date.now()): boolean {
  const grant = unloadGrants.get(contents);
  if (grant === undefined) return false;
  if (grant.expiry < now) { unloadGrants.delete(contents); return false; }
  if (grant.target !== null && (target === null || grant.target.kind !== target.kind || grant.target.url !== target.url || (grant.target.post === true) !== (target.post === true))) return false;
  unloadGrants.delete(contents);
  return true;
}

function sameUnloadTarget(a: UnloadTarget | null, b: UnloadTarget): boolean {
  return a !== null && a.kind === b.kind && a.url === b.url && a.at === b.at;
}

function installBrowserBeforeUnload(contents: WebContents, options: BeforeUnloadOptions): void {
  let refused: UnloadTarget | null = null;
  contents.on('will-prevent-unload', (event) => {
    const candidate = options.target();
    const target = candidate !== null && Date.now() - candidate.at <= UNLOAD_TARGET_TTL_MS && !sameUnloadTarget(refused, candidate) ? candidate : null;
    if (takeBrowserUnloadGrant(contents, target)) {
      event.preventDefault();
      return;
    }
    options.onStay?.();
    if (contents.isDestroyed()) return;
    const openedAt = Date.now();
    const page = contents.getURL();
    options.prompt(contents, target, () => new Promise<boolean>((resolve) => {
      if (contents.isDestroyed()) { resolve(false); return; }
      grantBrowserUnload(contents, target);
      if (options.onLeave?.(target) === true) { options.onDecided?.(); resolve(true); return; }
      if (target === null || target.post === true) { options.onDecided?.(); resolve(false); return; }
      setTimeout(() => {
        try {
          if (!contents.isDestroyed() && contents.getURL() === page && sameUnloadTarget(options.target(), target)) options.retry(target);
        } finally { options.onDecided?.(); resolve(true); }
      }, Math.max(0, openedAt + UNLOAD_RETRY_DELAY_MS - Date.now()));
    }), () => { refused = target; options.onRefused?.(); options.onDecided?.(); });
  });
}

function promptTabUnload(browserId: BrowserId): BeforeUnloadOptions['prompt'] {
  return (contents, target, leave, stay) => {
    cancelBrowserDialogs({ owner: contents, kinds: ['beforeunload'] });
    openBrowserDialog({
      browserId, kind: 'beforeunload', origin: browserPageOrigin(contents.getURL()), owner: contents, timeoutMs: UNLOAD_DIALOG_TIMEOUT_MS,
      ...(target?.url === undefined ? {} : { target: target.url }),
      ...(target === null ? { repeat: 'action' as const } : target.post === true ? { repeat: 'form' as const } : {}),
      onAnswer: async (answer) => {
        if (answer === null || !answer.accept) { stay(); return; }
        const left = leave();
        if (target === null || target.post === true) {
          const repeated = await left;
          if (!repeated) pushAgentBrowserNotice(browserId, 'Leaving the page is allowed now; repeat the action that navigates away.');
          return;
        }
        await left;
      },
    });
  };
}

function promptWindowUnload(browserId: BrowserId, popup: BrowserWindow, keepOpen: () => void): BeforeUnloadOptions['prompt'] {
  return (contents, target, leave, refuse) => {
    const stay = () => { keepOpen(); refuse(); };
    if (popup.isDestroyed() || !popup.isVisible()) { stay(); return; }
    const { beforeUnload: strings, pageDialogs } = browserStrings();
    const repeat = target === null ? pageDialogs.leaveRepeatAction : target.post === true ? pageDialogs.leaveRepeatForm : null;
    void dialog.showMessageBox(popup, {
      type: 'question', title: strings.title, message: strings.title,
      detail: [browserPageOrigin(contents.getURL()), strings.message, ...(repeat === null ? [] : [repeat])].join('\n'), buttons: [strings.stay, strings.leave],
      defaultId: 0, cancelId: 0, noLink: true,
    }).then(({ response }) => { if (response === 1) { attributeDownloadsToUser(browserId); void leave(); } else stay(); }, (error: unknown) => { stay(); log.warn(`[kimi-desktop] browser unload confirmation failed: ${String(error)}`); });
  };
}

const LOCAL_LINK_GRANT_MS = 10_000;
const localLinkGrants = new Map<string, number[]>();

export function takeLocalLinkGrant(url: string): boolean {
  const now = Date.now();
  const live = (localLinkGrants.get(url) ?? []).filter(expiry => expiry >= now);
  const granted = live.shift() !== undefined;
  if (live.length === 0) localLinkGrants.delete(url);
  else localLinkGrants.set(url, live);
  return granted;
}

function openBrowserLink(entry: BrowserEntry, url: string, target: 'tab' | 'foreground-tab' | 'background-tab' | 'window'): void {
  const localLink = target !== 'window' && isLocalFileUrl(url) && showsLocalFile(entry) && url.length <= BROWSER_STATE_URL_MAX;
  if (!localLink && !isAllowedBrowserUrl(url)) { noteBlockedBrowserUrl(entry.browserId, url); return; }
  if (localLink) localLinkGrants.set(url, [...(localLinkGrants.get(url) ?? []).filter(expiry => expiry >= Date.now()), Date.now() + LOCAL_LINK_GRANT_MS]);
  if (target !== 'window') {
    liveHost()?.webContents.send(IPC.browserOpenLinkRequested, { browserId: entry.browserId, url, ...(target === 'background-tab' ? { background: true } : {}) });
    return;
  }
  openBrowserPopup(entry, url);
}

function rebuildBrowserPopupForAutoplay(entry: BrowserEntry, popup: BrowserWindow, url: string, append = false, navigation: UnloadTarget | null = null): void {
  const target = url || popupAutoplayUrls.get(popup) || '';
  const contents = popup.webContents;
  if (popup.isDestroyed() || target === '' || popupAutoplayPolicies.get(popup) === browserAutoplayPolicy(target) || autoplayRebuilds.has(contents)) return;
  const postData = autoplayPostData(navigation, target);
  if (navigation?.url === target && navigation.post === true && postData === undefined) return;
  const history = autoplayHistory(contents, target, append, postData);
  const rebuild = Symbol();
  autoplayRebuilds.set(contents, rebuild);
  contents.once('destroyed', () => {
    if (autoplayRebuilds.get(contents) !== rebuild) return;
    autoplayRebuilds.delete(contents);
    if (!browserWindows.has(popup)) return;
    if (!popup.isDestroyed()) popup.destroy();
    openBrowserPopup(entry, target, history);
  });
  contents.close({ waitForBeforeUnload: true });
}

function openBrowserPopup(entry: BrowserEntry, url: string, history?: BrowserHistorySnapshot): void {
  const browserSession = session.fromPartition(BROWSER_PARTITION);
  configureSession(browserSession);
  const autoplayPolicy = browserAutoplayPolicy(url);
  const popup = new BrowserWindow({ width: 1100, height: 800, title: url, webPreferences: { session: browserSession, contextIsolation: true, nodeIntegration: false, sandbox: true, autoplayPolicy } });
  popupAutoplayPolicies.set(popup, autoplayPolicy);
  popupAutoplayUrls.set(popup, url);
  popup.webContents.setAudioMuted(browserSoundMuted(url));
  browserWindows.add(popup);
  browserWindowOwners.set(popup, entry.browserId);
  const contents = popup.webContents;
  let closingAt: number | null = null;
  let navigation: UnloadTarget | null = null;
  popup.on('close', () => { closingAt = Date.now(); });
  watchBrowserNavigationRequests(contents, (destination, reason, postData) => {
    if (!isAllowedBrowserUrl(destination)) return;
    navigation = observedNavigationTarget(navigation, destination, reason, postData);
    if ((postData !== undefined || reason === 'redirect') && popupAutoplayPolicies.get(popup) !== browserAutoplayPolicy(destination)) {
      setImmediate(() => rebuildBrowserPopupForAutoplay(entry, popup, destination, true, navigation));
    }
  }, (destination, post) => !popup.isDestroyed() && isAllowedBrowserUrl(destination) && popupAutoplayPolicies.get(popup) !== browserAutoplayPolicy(destination) && (post || postRedirectHop(navigation, destination)));
  installBrowserBeforeUnload(contents, {
    target: () => closingAt === null ? navigation : { kind: 'close', at: closingAt },
    retry: (target) => {
      if (popup.isDestroyed()) return;
      if (target.kind === 'close') popup.close();
      else if (target.url !== undefined) void contents.loadURL(target.url).catch((error: unknown) => log.warn(`[kimi-desktop] browser window navigation failed: ${String(error)}`));
    },
    prompt: promptWindowUnload(entry.browserId, popup, () => { closingAt = null; }),
    onLeave: () => {
      if (!autoplayRebuilds.has(contents)) return false;
      contents.close({ waitForBeforeUnload: true });
      return true;
    },
    onRefused: () => { autoplayRebuilds.delete(contents); },
  });
  attachBrowserUserInput(entry.browserId, contents);
  const userAgentSync = createBrowserUserAgentSync(contents, { label: 'browser popup' });
  popupUserAgentSyncs.set(popup, userAgentSync);
  userAgentSync.sync();
  contents.on('did-start-navigation', (_event, destination, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    popupAutoplayUrls.set(popup, destination);
    if (!isInPlace && isAllowedBrowserUrl(destination) && !autoplayRestores.has(contents) && autoplayPolicy !== browserAutoplayPolicy(destination)) {
      pendingAutoplayNavigations.set(contents, destination);
      setImmediate(() => {
        if (popup.isDestroyed() || pendingAutoplayNavigations.get(contents) !== destination) return;
        pendingAutoplayNavigations.delete(contents);
        if (!autoplayRestores.has(contents) && popupAutoplayPolicies.get(popup) === autoplayPolicy) rebuildBrowserPopupForAutoplay(entry, popup, destination, true, navigation);
      });
    }
  });
  contents.on('did-navigate', (_event, destination) => {
    navigation = null;
    recordBrowserSiteVisit(destination);
    contents.setAudioMuted(browserSoundMuted(destination));
  });
  contents.on('did-stop-loading', () => {
    const destination = contents.getURL();
    if (isAllowedBrowserUrl(destination)) recordBrowserHistory({ url: destination, title: contents.getTitle() || destination });
  });
  contents.on('will-navigate', (event, destination) => {
    if (isAllowedBrowserUrl(destination)) {
      if (popupAutoplayPolicies.get(popup) !== browserAutoplayPolicy(destination)) {
        if (navigation?.url === destination && navigation.post === true) return;
        event.preventDefault();
        rebuildBrowserPopupForAutoplay(entry, popup, destination, true, navigation);
      }
      return;
    }
    if (pendingAutoplayNavigations.get(contents) === destination) pendingAutoplayNavigations.delete(contents);
    event.preventDefault();
    noteBlockedBrowserUrl(entry.browserId, destination);
  });
  contents.on('will-redirect', (event, destination, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    if (isAllowedBrowserUrl(destination)) {
      if (popupAutoplayPolicies.get(popup) !== browserAutoplayPolicy(destination)) {
        if (navigation?.post === true) return;
        event.preventDefault();
        rebuildBrowserPopupForAutoplay(entry, popup, destination, true, navigation);
      }
      return;
    }
    pendingAutoplayNavigations.delete(contents);
    event.preventDefault();
    noteBlockedBrowserUrl(entry.browserId, destination);
  });
  contents.on('page-title-updated', (event, title) => { event.preventDefault(); popup.setTitle(`${title} — ${contents.getURL()}`); });
  installBrowserWindowOpenHandler(entry, contents, destination => openBrowserLink(entry, destination, 'window'));
  installBrowserContextMenu(contents, () => popup.isVisible(), undefined, (destination, disposition) => openBrowserLink(entry, destination, disposition));
  popup.once('closed', () => {
    browserWindows.delete(popup);
    popupUserAgentSyncs.delete(popup);
    userAgentSync.dispose();
  });
  const load = (): void => {
    if (popup.isDestroyed()) return;
    const navigation = history === undefined ? popup.loadURL(url) : restoreAutoplayHistory(contents, url, history);
    void navigation.catch((error: unknown) => log.warn(`[kimi-desktop] browser window navigation failed: ${String(error)}`));
  };
  if (userAgentSync.pending === 0) load();
  else void userAgentSync.whenReadyToNavigate().then(load);
}

function browserLinkClicked(contents: WebContents, url: string): Promise<boolean> {
  if (contents.isDestroyed()) return Promise.resolve(false);
  return new Promise((resolve) => {
    const settle = (clicked: boolean): void => {
      clearTimeout(timeout);
      contents.removeListener('destroyed', onDestroyed);
      resolve(clicked);
    };
    const onDestroyed = (): void => settle(false);
    const timeout = setTimeout(onDestroyed, BROWSER_LINK_CLICK_QUERY_TIMEOUT_MS);
    contents.once('destroyed', onDestroyed);
    contents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code: browserLinkClickedScript(url) }])
      .then((clicked: unknown) => settle(clicked === true), () => settle(false));
  });
}

function installBrowserWindowOpenHandler(entry: BrowserEntry, contents: WebContents, openDefault: (url: string) => void): void {
  contents.on('dom-ready', () => {
    void contents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code: browserLinkClickTrackingScript() }]).catch(() => {});
  });
  contents.setWindowOpenHandler(({ url, disposition }) => {
    if (isBrowserInputActive(contents)) openDefault(url);
    else if (disposition === 'background-tab') openBrowserLink(entry, url, 'background-tab');
    else if (disposition !== 'foreground-tab') openDefault(url);
    else {
      void browserLinkClicked(contents, url).then((clicked) => {
        if (browserEntries.get(entry.browserId) !== entry) return;
        if (clicked) openBrowserLink(entry, url, 'foreground-tab');
        else openDefault(url);
      });
    }
    return { action: 'deny' };
  });
}

function ensureBrowserView(entry: BrowserEntry): WebContentsView {
  if (clearingBrowserData !== null) throw new Error('Browser data is being cleared.');
  const existing = liveView(entry);
  if (existing !== null) return existing;
  const host = liveHost();
  if (host === null) throw new Error('browser-view: main window is unavailable');

  const browserSession = session.fromPartition(BROWSER_PARTITION);
  configureSession(browserSession);
  entry.autoplayPolicy = browserAutoplayPolicy(entry.restoreUrl);
  const view = new WebContentsView({
    webPreferences: {
      session: browserSession,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: true,
      backgroundThrottling: false,
      autoplayPolicy: entry.autoplayPolicy,
    },
  });
  view.setBackgroundColor(nativeTheme.shouldUseDarkColors ? '#121212' : '#ffffff');
  attachBrowserControlPage(entry.browserId, view.webContents, () => ({ visible: entry.displayed === true && entry.pageRenderable, bounds: browserViewDeviceBounds(entry), feedbackScale: entry.state.device ? 1 : view.webContents.getZoomFactor(), focusScale: entry.state.device ? entry.state.device.displayScale * hostWindowZoomFactor() : view.webContents.getZoomFactor() }));
  view.webContents.setUserAgent(baseBrowserUserAgent());
  const defaultZoomFactor = entry.state.zoomFactor ?? getBrowserData().preferences.defaultZoomFactor;
  view.webContents.setZoomFactor(defaultZoomFactor);
  syncBrowserTabSound(entry, view.webContents, entry.restoreUrl);
  entry.state = { ...entry.state, zoomFactor: defaultZoomFactor };
  entry.view = view;
  entry.displayed = null;
  entry.userAgentSync = createBrowserUserAgentSync(view.webContents, {
    label: 'browser',
    canOverride: () => entry.state.device === undefined && liveView(entry) === view,
    onDebuggerDetach: () => {
      if (entry.view !== view) return;
      ++entry.deviceApplyRevision;
      entry.appliedDeviceProfile = null;
      const { device: _device, ...stateWithoutDevice } = entry.state;
      entry.state = { ...stateWithoutDevice, emulateFocus: false };
      applyViewGeometry(entry);
      publishState(entry);
    },
  });
  entry.userAgentSync.sync();

  installBrowserContextMenu(view.webContents, () => entry.displayed === true && !isBrowserInputActive(view.webContents), async () => {
    const generation = entry.generation;
    const targetId = `bct_${randomUUID()}`;
    const ready = await view.webContents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code: browserAnnotationContextTargetScript(targetId) }]);
    if (!ready || entry.generation !== generation) return null;
    return () => {
      if (liveView(entry) !== view || entry.generation !== generation || entry.displayed !== true) return;
      liveHost()?.webContents.send(IPC.browserAnnotationRequested, { browserId: entry.browserId, targetId });
    };
  }, (url, target) => openBrowserLink(entry, url, target));
  observeBrowserOverlayOutsidePointer(view.webContents, () => entry.displayed === true && !isBrowserInputActive(view.webContents));

  installBrowserWindowOpenHandler(entry, view.webContents, url => handleNavigationTarget(entry, url));
  let closingHistory: BrowserHistorySnapshot | null = null;
  (view.webContents as NodeJS.EventEmitter).once('close', () => {
    if (appClosedViews.has(view)) return;
    closingHistory = { entries: view.webContents.navigationHistory.getAllEntries(), index: view.webContents.navigationHistory.getActiveIndex() };
  });
  view.webContents.once('destroyed', () => {
    if (appClosedViews.has(view) || browserEntries.get(entry.browserId) !== entry || liveView(entry) !== null) return;
    if (closingHistory !== null && closingHistory.index > 0) refusePageClose(entry, closingHistory);
    else liveHost()?.webContents.send(IPC.browserCloseRequested, { browserId: entry.browserId });
  });
  installBrowserBeforeUnload(view.webContents, {
    target: () => entry.unloadTarget,
    retry: (target) => retryBrowserUnload(entry, view, target),
    prompt: promptTabUnload(entry.browserId),
    onLeave: () => {
      if (!autoplayRebuilds.has(view.webContents)) return false;
      view.webContents.close({ waitForBeforeUnload: true });
      return true;
    },
    onStay: () => entry.keepPageOnRefusedUnload?.(),
    onRefused: () => {
      autoplayRebuilds.delete(view.webContents);
      appClosedViews.delete(view);
    },
    onDecided: () => {
      if (!entry.deviceReloadAwaitingUnload) return;
      entry.deviceReloadAwaitingUnload = false;
      settleLoadWaiters(entry);
    },
  });
  installBrowserPageDialogs(view.webContents, {
    browserId: entry.browserId,
    isAgentControlled: () => isBrowserAgentControlled(entry.browserId),
    host: liveHost,
    onNavigationRequested: (url, reason, postData) => {
      if (!isAllowedBrowserUrl(url)) return;
      entry.unloadTarget = observedNavigationTarget(entry.unloadTarget, url, reason, postData);
      if ((postData !== undefined || reason === 'redirect') && entry.autoplayPolicy !== browserAutoplayPolicy(url)) {
        setImmediate(() => { if (liveView(entry) === view) rebuildBrowserViewForAutoplay(entry, view, url, true); });
      }
    },
    interceptPost: (url, post) => liveView(entry) === view && isAllowedBrowserUrl(url) && entry.autoplayPolicy !== browserAutoplayPolicy(url) && (post || postRedirectHop(entry.unloadTarget, url)),
  });
  view.webContents.on('will-navigate', (event, url) => {
    if (isAllowedBrowserUrl(url)) {
      if (entry.autoplayPolicy !== browserAutoplayPolicy(url)) {
        if (entry.unloadTarget?.url === url && entry.unloadTarget.post === true) return;
        event.preventDefault();
        rebuildBrowserViewForAutoplay(entry, view, url, true);
      }
      return;
    }
    if (isLocalFileUrl(url) && isLocalFileUrl(view.webContents.getURL()) && url.length <= BROWSER_STATE_URL_MAX) return;
    if (pendingAutoplayNavigations.get(view.webContents) === url) pendingAutoplayNavigations.delete(view.webContents);
    event.preventDefault();
    noteBlockedBrowserUrl(entry.browserId, url);
  });
  view.webContents.on('will-redirect', (event, url, _isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    if (isAllowedBrowserUrl(url)) {
      if (entry.autoplayPolicy !== browserAutoplayPolicy(url)) {
        if (entry.unloadTarget?.post === true) return;
        event.preventDefault();
        rebuildBrowserViewForAutoplay(entry, view, url, true);
      }
      return;
    }
    pendingAutoplayNavigations.delete(view.webContents);
    event.preventDefault();
    noteBlockedBrowserUrl(entry.browserId, url);
  });
  view.webContents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
    if (!isMainFrame) return;
    if (!isInPlace && isVisibleBrowserUrl(url) && !autoplayRestores.has(view.webContents) && entry.autoplayPolicy !== browserAutoplayPolicy(url)) {
      pendingAutoplayNavigations.set(view.webContents, url);
      setImmediate(() => {
        if (pendingAutoplayNavigations.get(view.webContents) !== url) return;
        pendingAutoplayNavigations.delete(view.webContents);
        if (!autoplayRestores.has(view.webContents) && liveView(entry) === view && entry.autoplayPolicy !== browserAutoplayPolicy(url)) rebuildBrowserViewForAutoplay(entry, view, url, true);
      });
    }
    if (isRestorableBrowserUrl(url)) entry.restoreUrl = url;
    if (!isInPlace && (!entry.state.loading || entry.committedGeneration === entry.generation)) beginNavigation(entry);
    if (isVisibleBrowserUrl(url)) entry.state = { ...entry.state, url, ...(isLocalFileUrl(entry.state.url) ? { title: '' } : {}) };
    publishState(entry);
  });
  view.webContents.on('did-start-loading', () => {
    if (!entry.state.loading) beginNavigation(entry);
    entry.pageRenderable = true;
    entry.state = { ...entry.state, loading: true, error: undefined };
    applyViewGeometry(entry);
    publishState(entry);
  });
  view.webContents.on('did-stop-loading', () => {
    const error = entry.state.error;
    if (error !== undefined) {
      entry.pageRenderable = false;
      entry.state = { ...entry.state, loading: false };
      applyViewGeometry(entry);
      publishState(entry);
      rejectLoadWaiters(entry, error);
      return;
    }
    entry.pageRenderable = true;
    entry.committedGeneration = entry.generation;
    entry.domReadyGeneration = entry.generation;
    entry.completeGeneration = entry.generation;
    syncCommittedState(entry);
    if (browserStateUrl(view.webContents.getURL()) !== null) recordPageVisit(entry);
    applyViewGeometry(entry);
    if (!flushDeviceEmulation(entry, view)) settleLoadWaiters(entry);
  });
  view.webContents.on('did-navigate', () => {
    entry.deviceEmulationBlocked = false;
    entry.pageDeviceProfile = entry.appliedDeviceProfile;
    entry.unloadTarget = null;
    recordBrowserSiteVisit(view.webContents.getURL());
    syncBrowserTabSound(entry, view.webContents, view.webContents.getURL());
    entry.committedGeneration = entry.generation;
    syncCommittedState(entry);
    settleLoadWaiters(entry);
  });
  view.webContents.on('did-navigate-in-page', (_event, _url, isMainFrame) => {
    if (isMainFrame === false) return;
    entry.committedGeneration = entry.generation;
    entry.domReadyGeneration = entry.generation;
    entry.completeGeneration = entry.generation;
    syncCommittedState(entry);
    recordPageVisit(entry);
    settleLoadWaiters(entry);
  });
  view.webContents.on('dom-ready', () => {
    const generation = entry.generation;
    void view.webContents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code: `Array.from(document.querySelectorAll('link[rel~="icon"]'), link => link.href).slice(0, 3)` }]).then(urls => {
      if (entry.view !== view || generation !== entry.generation || faviconLoads.has(entry) || entry.state.favicon) return;
      const url = view.webContents.getURL();
      if (isAllowedBrowserUrl(url)) void refreshFavicon(entry, view, [...(Array.isArray(urls) ? urls.filter((item): item is string => typeof item === 'string') : []), new URL('/favicon.ico', url).href]);
    }).catch(() => {});
    void view.webContents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code: browserAnnotationContextTrackingScript() }]).catch(() => {});
    entry.domReadyGeneration = entry.generation;
    settleLoadWaiters(entry);
  });
  view.webContents.on('page-title-updated', () => syncCommittedState(entry));
  view.webContents.on('page-favicon-updated', (_event, favicons) => {
    void refreshFavicon(entry, view, favicons);
  });
  view.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    if (!isMainFrame || code === -3) return;
    entry.pageRenderable = false;
    entry.deviceEmulationBlocked = true;
    entry.state = {
      ...entry.state,
      url: isVisibleBrowserUrl(url) ? url : entry.state.url,
      title: '',
      favicon: undefined,
      loading: false,
      error: description || `Page failed to load (${code})`,
      ...navigationState(entry),
    };
    applyViewGeometry(entry);
    publishState(entry);
    rejectLoadWaiters(entry, description || `Page failed to load (${code})`);
    log.warn(`[kimi-desktop] browser navigation failed: ${redactUrlForLog(url)} (${code})`);
  });
  view.webContents.on('render-process-gone', (_event, details) => {
    entry.deviceEmulationBlocked = true;
    if (details.reason === 'clean-exit') return;
    entry.pageRenderable = false;
    entry.state = {
      ...entry.state,
      loading: false,
      error: 'The page process stopped unexpectedly.',
    };
    applyViewGeometry(entry);
    publishState(entry);
    rejectLoadWaiters(entry, 'The page process stopped unexpectedly.');
    log.error(`[kimi-desktop] browser renderer gone (reason=${details.reason})`);
  });

  applyViewGeometry(entry);
  return view;
}

function retryBrowserUnload(entry: BrowserEntry, view: WebContentsView, target: UnloadTarget): void {
  if (browserEntries.get(entry.browserId) !== entry || entry.view !== view) return;
  if (target.kind === 'back') browserGoBack(entry.browserId);
  else if (target.kind === 'forward') browserGoForward(entry.browserId);
  else if (target.kind === 'reload') {
    if (entry.deviceReloadAwaitingUnload) for (const waiter of entry.waiters) waiter.generation = entry.generation + 1;
    browserReload(entry.browserId);
  }
  else if (target.url !== undefined) handleNavigationTarget(entry, target.url);
}

function disposeView(entry: BrowserEntry, preserveRequestedVisible = false): void {
  const requestedVisible = entry.requestedVisible;
  const view = entry.view;
  entry.view = null;
  entry.userAgentSync?.dispose();
  entry.userAgentSync = null;
  if (view !== null) {
    view.setVisible(false);
    liveHost()?.contentView.removeChildView(view);
    if (backgroundWindow !== null && !backgroundWindow.isDestroyed()) backgroundWindow.contentView.removeChildView(view);
    appClosedViews.add(view);
    const contents = view.webContents as WebContents | undefined;
    if (contents !== undefined && !contents.isDestroyed()) contents.close();
  }
  entry.restoring = null;
  entry.requestedVisible = preserveRequestedVisible ? requestedVisible : false;
  entry.pageRenderable = false;
  entry.deviceSyncPending = false;
  entry.deviceEmulationBlocked = false;
  entry.appliedDeviceProfile = null;
  entry.pageDeviceProfile = null;
  rejectLoadWaiters(entry, 'Browser tab was closed.');
}


let dialogsConfigured = false;

function configurePageDialogs(): void {
  if (dialogsConfigured) return;
  dialogsConfigured = true;
  configureBrowserDialogs({
    isAgentControlled: isBrowserAgentControlled,
    controlSession: browserControlSessionKey,
    isBrowserOpen: browserId => browserEntries.has(browserId),
    publish: (dialogs) => liveHost()?.webContents.send(IPC.browserPageDialogs, dialogs),
    onUserAnswer: attributeDownloadsToUser,
  });
  onBrowserControlDownloadAction(handleControlDownloadAction);
  onBrowserUserAction(browserId => agentAttributedTabs.delete(browserId));
  onBrowserPermissionUserAnswer(attributeDownloadsToUser);
  onBrowserAgentAction(browserId => userDownloadTabs.delete(browserId));
  observeBrowserControls(() => {
    for (const browserId of browserEntries.keys()) if (isBrowserAgentControlled(browserId)) agentAttributedTabs.add(browserId);
    syncBrowserDialogControl();
    refreshBrowserPageDialogControl();
    publishBrowserDialogs();
  });
}

export function attachBrowserWindow(win: MainWindow): void {
  if (hostWindow !== win) {
    occludedBrowsers.clear();
    occlusionFocusTarget = null;
  }
  hostWindow = win;
  configurePageDialogs();
  attachBrowserControlWindow(win);
  for (const entry of browserEntries.values()) {
    entry.displayed = null;
    applyViewGeometry(entry);
  }
  win.webContents.on('zoom-changed', () => {
    reapplyBrowserViewGeometry();
    setImmediate(() => {
      if (hostWindow !== win) return;
      reapplyBrowserViewGeometry();
    });
  });
  win.webContents.on('did-start-navigation', (details) => {
    if (!details.isMainFrame || details.isSameDocument) return;
    clearBrowserOcclusion();
    setBrowserControls(null);
    for (const entry of browserEntries.values()) {
      entry.requestedVisible = false;
      applyViewGeometry(entry);
    }
  });
  win.once('closed', () => {
    if (hostWindow !== win) return;
    occludedBrowsers.clear();
    occlusionFocusTarget = null;
    destroyBrowserView();
    hostWindow = null;
  });
}

export function getBrowserState(browserId: BrowserId): BrowserState {
  return copyState(browserEntries.get(browserId) ?? (pagePersistence?.getPage(browserId) === undefined ? undefined : ensureEntry(browserId)));
}

async function navigatePreparedBrowserView(entry: BrowserEntry, view: WebContentsView, navigate: () => Promise<void>, favicon?: string): Promise<void> {
  if (entry.state.emulateFocus) await setBrowserFocusEmulation(view.webContents, true);
  const userAgentSync = entry.userAgentSync;
  if (entry.state.device === undefined && (userAgentSync === null || userAgentSync.pending === 0)) return navigate();
  const deferred = deferNavigation(entry, favicon);
  let proceed = false;
  try {
    if (entry.state.device === undefined) await userAgentSync!.whenReadyToNavigate();
    else await queueDeviceEmulation(entry, true);
  } finally {
    proceed = takeDeferredNavigation(entry, deferred);
  }
  if (liveView(entry) !== view) throw new Error('Browser view changed before navigation');
  if (proceed) return navigate();
}

interface BrowserHistorySnapshot {
  entries: NavigationEntry[];
  index: number;
  postData?: BrowserNavigationPostData;
}

function postRedirectHop(target: UnloadTarget | null, url: string): boolean {
  return target?.post === true && target.url !== url;
}

function autoplayPostData(target: UnloadTarget | null, url: string): BrowserNavigationPostData | undefined {
  return target?.url === url && target.post === true ? target.postData : undefined;
}

function autoplayHistory(contents: WebContents, url: string, append = false, postData?: BrowserNavigationPostData, traversal?: UnloadTarget['kind']): BrowserHistorySnapshot {
  const entries = contents.navigationHistory.getAllEntries().map(entry => ({ ...entry }));
  let index = Math.max(0, Math.min(contents.navigationHistory.getActiveIndex(), entries.length - 1));
  if (append && postData === undefined && (traversal === 'back' || traversal === 'forward')) {
    const step = traversal === 'back' ? -1 : 1;
    for (let target = index + step; target >= 0 && target < entries.length; target += step) {
      if (entries[target]!.url === url) return { entries, index: target };
    }
  }
  if (postData === undefined) {
    if (append && entries[index] !== undefined && entries[index]!.url !== url) {
      entries.splice(index + 1);
      entries.push({ url, title: '' });
      index = entries.length - 1;
    } else if (entries[index] !== undefined) {
      if (entries[index]!.url !== url) entries[index] = { url, title: entries[index]!.title };
    } else if (url !== '') entries.push({ url, title: contents.getTitle() } as NavigationEntry);
  }
  return { entries, index, ...(postData === undefined ? {} : { postData }) };
}

function resumeLoadWaiters(entry: BrowserEntry, waiters: BrowserLoadWaiter[]): void {
  for (const waiter of waiters) {
    waiter.generation = entry.generation;
    entry.waiters.add(waiter);
  }
}

async function restoreAutoplayHistory(contents: WebContents, url: string, history: BrowserHistorySnapshot, held?: { entry: BrowserEntry; waiters: BrowserLoadWaiter[] }): Promise<void> {
  autoplayRestores.add(contents);
  try {
    if (history.postData === undefined) { await contents.navigationHistory.restore(history); return; }
    const postData = history.postData;
    if (history.entries.length > 0) {
      try {
        await contents.navigationHistory.restore({ entries: history.entries, index: history.index });
      } catch (error) {
        if (held !== undefined) resumeLoadWaiters(held.entry, held.waiters);
        throw error;
      }
      if (held !== undefined) {
        beginNavigation(held.entry);
        resumeLoadWaiters(held.entry, held.waiters);
      }
    }
    await contents.loadURL(url, {
      postData: [{ type: 'rawData', bytes: postData.bytes }],
      ...(postData.contentType === undefined ? {} : { extraHeaders: `Content-Type: ${postData.contentType}` }),
    });
  } finally {
    autoplayRestores.delete(contents);
  }
}

function rebuildBrowserViewForAutoplay(entry: BrowserEntry, view: WebContentsView, url: string, append = false): void {
  const contents = view.webContents;
  if (liveView(entry) !== view || entry.autoplayPolicy === browserAutoplayPolicy(url) || autoplayRebuilds.has(contents)) return;
  const postData = autoplayPostData(entry.unloadTarget, url);
  if (entry.unloadTarget?.url === url && entry.unloadTarget.post === true && postData === undefined) return;
  const history = autoplayHistory(contents, url, append, postData, entry.unloadTarget?.kind);
  const zoomFactor = contents.getZoomFactor();
  const rebuild = Symbol();
  autoplayRebuilds.set(contents, rebuild);
  appClosedViews.add(view);
  contents.once('destroyed', () => {
    if (autoplayRebuilds.get(contents) !== rebuild) return;
    autoplayRebuilds.delete(contents);
    if (entry.view !== view) return;
    entry.state = { ...entry.state, zoomFactor };
    entry.restoreUrl = isRestorableBrowserUrl(url) ? url : '';
    const reopen = history.entries.length > 0 || history.postData !== undefined;
    const waiters = reopen ? [...entry.waiters] : [];
    for (const waiter of waiters) entry.waiters.delete(waiter);
    disposeView(entry, true);
    if (!reopen) {
      ensureBrowserView(entry);
      applyViewGeometry(entry);
      return;
    }
    const hold = history.postData !== undefined && history.entries.length > 0;
    reopenBrowserView(entry, rebuilt => restoreAutoplayHistory(rebuilt.webContents, url, history, hold ? { entry, waiters } : undefined));
    if (!hold) resumeLoadWaiters(entry, waiters);
  });
  contents.close({ waitForBeforeUnload: true });
}

export function applyBrowserAutoplayPolicy(): void {
  for (const entry of browserEntries.values()) {
    const view = liveView(entry);
    if (view !== null) rebuildBrowserViewForAutoplay(entry, view, view.webContents.getURL());
  }
  for (const popup of [...browserWindows]) {
    if (popup.isDestroyed()) continue;
    const browserId = browserWindowOwners.get(popup);
    const entry = browserId === undefined ? undefined : browserEntries.get(browserId);
    if (entry !== undefined) rebuildBrowserPopupForAutoplay(entry, popup, popup.webContents.getURL());
  }
}

function syncBrowserTabSound(entry: BrowserEntry, contents: WebContents | undefined, url: string): void {
  const muted = entry.soundOverride ?? browserSoundMuted(url);
  if (contents !== undefined && !contents.isDestroyed()) contents.setAudioMuted(muted);
  if (entry.state.muted !== muted) entry.state = { ...entry.state, muted };
}

export function applyBrowserSound(): void {
  for (const entry of browserEntries.values()) {
    const contents = liveView(entry)?.webContents;
    const muted = entry.state.muted;
    syncBrowserTabSound(entry, contents, contents?.getURL() || entry.restoreUrl);
    if (entry.state.muted !== muted) publishState(entry);
  }
  for (const popup of browserWindows) {
    if (!popup.isDestroyed()) popup.webContents.setAudioMuted(browserSoundMuted(popup.webContents.getURL()));
  }
}

function refusePageClose(entry: BrowserEntry, history: BrowserHistorySnapshot): void {
  setImmediate(() => {
    if (browserEntries.get(entry.browserId) !== entry || entry.view !== null || clearingBrowserData !== null || liveHost() === null) return;
    reopenBrowserView(entry, view => view.webContents.navigationHistory.restore(history));
  });
}

function loadReopenedBrowserView(entry: BrowserEntry, load: (view: WebContentsView) => Promise<void>): Promise<BrowserState> {
  const view = ensureBrowserView(entry);
  beginNavigation(entry);
  const generation = entry.generation;
  publishState(entry);
  return navigatePreparedBrowserView(entry, view, () => load(view)).catch((error: unknown) => {
    failBrowserNavigation(entry, view, generation, error);
  }).then(() => copyState(entry));
}

function reopenBrowserView(entry: BrowserEntry, load: (view: WebContentsView) => Promise<void>): BrowserState {
  const restoration = loadReopenedBrowserView(entry, load);
  entry.restoring = restoration;
  void restoration.finally(() => { if (entry.restoring === restoration) entry.restoring = null; });
  return copyState(entry);
}

export function restoreBrowser(browserId: BrowserId): BrowserState {
  if (clearingBrowserData !== null) return getBrowserState(browserId);
  const entry = ensureEntry(browserId);
  if (entry.restoring !== null) return copyState(entry);
  if (liveView(entry) !== null || entry.restoreUrl === '') return copyState(entry);
  const url = entry.restoreUrl;
  const load = (view: WebContentsView): Promise<void> => view.webContents.loadURL(url);
  if (!isLocalFileUrl(url)) return reopenBrowserView(entry, load);
  const restoration = localPagesAllowed().then((allowed) => {
    if (browserEntries.get(browserId) !== entry || liveView(entry) !== null || entry.restoreUrl !== url) return copyState(entry);
    if (allowed) return loadReopenedBrowserView(entry, load);
    entry.state = { ...entry.state, loading: false, error: LOCAL_PAGES_UNAVAILABLE };
    publishState(entry);
    return copyState(entry);
  });
  entry.restoring = restoration;
  void restoration.finally(() => { if (entry.restoring === restoration) entry.restoring = null; });
  return copyState(entry);
}

const LOCAL_PAGES_UNAVAILABLE = 'Local pages need a build with file:// privileges turned off.';

export function suspendBrowser(browserId: BrowserId): void {
  const entry = browserEntries.get(browserId);
  if (entry === undefined || entry.requestedVisible) return;
  disposeView(entry);
}

export function cloneBrowser(sourceId: BrowserId, targetId: BrowserId): BrowserState {
  const source = browserEntries.get(sourceId) ?? (pagePersistence?.getPage(sourceId) === undefined ? undefined : ensureEntry(sourceId));
  if (source === undefined) throw new Error('Source browser tab no longer exists');
  if (browserEntries.has(targetId)) throw new Error('Target browser tab already exists');
  const sourceView = liveView(source);
  const entries = sourceView?.webContents.navigationHistory.getAllEntries() ?? [];
  const index = sourceView?.webContents.navigationHistory.getActiveIndex() ?? 0;
  const url = sourceView?.webContents.getURL() || source.state.url;
  const target = createEntry(targetId);
  browserEntries.set(targetId, target);
  target.restoreUrl = source.restoreUrl;
  target.soundOverride = source.soundOverride;
  if (sourceView === null || url === '') {
    target.state = { ...source.state, loading: false };
    publishState(target);
    return copyState(target);
  }
  try {
    const view = ensureBrowserView(target);
    target.bounds = { ...source.bounds };
    target.state = {
      ...source.state,
      device: source.state.device === undefined ? undefined : { ...source.state.device },
    };
    view.webContents.setZoomFactor(sourceView.webContents.getZoomFactor());
    syncBrowserTabSound(target, view.webContents, url);
    beginNavigation(target);
    applyViewGeometry(target);
    const restore = () => entries.length > 0
      ? view.webContents.navigationHistory.restore({ entries, index })
      : view.webContents.loadURL(url);
    void navigatePreparedBrowserView(target, view, restore).catch((error: unknown) => {
      if (browserEntries.get(targetId) !== target || liveView(target) !== view) return;
      target.state = { ...target.state, loading: false, error: error instanceof Error ? error.message : String(error) };
      publishState(target);
      rejectLoadWaiters(target, target.state.error!);
    });
    return copyState(target);
  } catch (error) {
    closeBrowser(targetId);
    throw error;
  }
}

export function listBrowserStates(): BrowserEntrySnapshot[] {
  return [...browserEntries.values()].map((entry) => ({
    browserId: entry.browserId,
    state: copyState(entry),
    generation: entry.generation,
  }));
}

export function getBrowserGeneration(browserId: BrowserId): number | null {
  return browserEntries.get(browserId)?.generation ?? null;
}

export function getBrowserPage(browserId: BrowserId): {
  webContents: WebContents;
  bounds: BrowserBounds;
  generation: number;
  committed: boolean;
  visible: boolean;
  inputScale: number;
  localFile: boolean;
} | null {
  const entry = browserEntries.get(browserId);
  if (entry === undefined) return null;
  const view = liveView(entry);
  if (view === null || entry.state.url === '') return null;
  return {
    webContents: view.webContents,
    bounds: browserViewDeviceBounds(entry),
    generation: entry.generation,
    committed: entry.committedGeneration === entry.generation,
    visible: entry.requestedVisible && entry.pageRenderable && entry.hasVisibleBounds,
    inputScale: entry.state.device ? entry.state.device.displayScale * hostWindowZoomFactor() : 1,
    localFile: showsLocalFile(entry) && !agentLocalFilesEnabled(),
  };
}

export function setBrowserBounds(browserId: BrowserId, bounds: BrowserBounds): void {
  const entry = ensureEntry(browserId);
  const resized = entry.bounds.width !== bounds.width || entry.bounds.height !== bounds.height;
  entry.hasVisibleBounds = bounds.width > 0 && bounds.height > 0;
  if (entry.hasVisibleBounds) entry.bounds = bounds;
  applyViewGeometry(entry, resized);
  refreshBrowserAnnotationOverlay();
}

export function setBrowserVisible(browserId: BrowserId, visible: boolean): void {
  const existing = browserEntries.get(browserId);


  if (existing === undefined && !visible) return;
  const entry = existing ?? ensureEntry(browserId);
  if (visible) {
    for (const other of browserEntries.values()) {
      if (other === entry) continue;
      other.requestedVisible = false;
      applyViewGeometry(other);
    }
  }
  entry.requestedVisible = visible;
  applyViewGeometry(entry);
}

function failBrowserNavigation(entry: BrowserEntry, view: WebContentsView, generation: number, error: unknown): void {
  if (entry.view === view && entry.generation === generation && entry.state.error === undefined) {
    const committedUrl = liveView(entry)?.webContents.getURL() ?? '';
    entry.restoreUrl = isRestorableBrowserUrl(committedUrl) ? committedUrl : '';
    entry.state = { ...entry.state, url: entry.restoreUrl, urlTruncated: undefined, loading: false, error: error instanceof Error ? error.message : 'Navigation failed.' };
    syncCommittedState(entry);
    rejectLoadWaiters(entry, entry.state.error ?? 'Navigation failed.');
  }
}

export async function navigateBrowser(
  browserId: BrowserId,
  address: string,
  options: { validate?: () => Promise<void>; onCancelled?: () => void; localFile?: boolean } = {},
): Promise<BrowserState> {
  while (clearingBrowserData !== null) {
    while (clearingBrowserData !== null) await clearingBrowserData;
    await options.validate?.();
  }
  const entry = ensureEntry(browserId);
  const display = copyState(entry);
  const fullAddress = liveView(entry)?.webContents.getURL() || entry.restoreUrl;
  const localUrl = options.localFile === true ? localFileAddressUrl(address) : null;
  if (localUrl !== null && localUrl.length > BROWSER_STATE_URL_MAX) throw new Error('browser-navigate: address is too long');
  const reuseAddress = localUrl === null && display.urlTruncated && address.trim() === display.url;
  if (reuseAddress && (!fullAddress || !isRestorableBrowserUrl(fullAddress) || isLocalFileUrl(fullAddress))) throw new Error('browser-navigate: full address is unavailable');
  const url = localUrl ?? (reuseAddress ? fullAddress : normalizeBrowserAddress(address));
  return loadBrowserUrl(entry, url, options);
}

const LOCAL_FILE_COMMIT_TIMEOUT_MS = 10_000;

export async function openBrowserLocalFile(browserId: BrowserId, url: string): Promise<BrowserState> {
  if (!isLocalFileUrl(url) || url.length > BROWSER_STATE_URL_MAX) throw new Error('browser-open-local-file: not a file URL');
  while (clearingBrowserData !== null) await clearingBrowserData;
  const loaded = loadBrowserUrl(ensureEntry(browserId), url);
  const committed = waitForBrowserLoad(browserId, 'committed', LOCAL_FILE_COMMIT_TIMEOUT_MS);
  committed.catch(() => {});
  return Promise.race([committed, loaded]);
}

async function loadBrowserUrl(
  entry: BrowserEntry,
  url: string,
  options: { onCancelled?: () => void } = {},
): Promise<BrowserState> {
  entry.restoreUrl = url;
  const view = ensureBrowserView(entry);
  const previousFavicon = entry.state.favicon;
  entry.pageRenderable = true;
  beginNavigation(entry);
  const generation = entry.generation;
  entry.state = {
    ...entry.state,
    url,
    urlTruncated: undefined,
    title: '',
    favicon: undefined,
    loading: true,
    error: undefined,
  };
  applyViewGeometry(entry);
  publishState(entry);
  const addressLoad = { generation, url };
  entry.addressLoad = addressLoad;
  entry.unloadTarget = { kind: 'url', url, at: Date.now() };
  try {
    await navigatePreparedBrowserView(entry, view, () => view.webContents.loadURL(url), previousFavicon);
  } catch (error) {
    if (
      isUnreportedLoadFailure(entry, generation, error) &&
      (entry.downloadGeneration === generation || await waitForDownloadHandoff(entry, generation)) &&
      settleDownloadNavigation(entry, view, generation, previousFavicon)
    ) {
      return copyState(entry);
    }
    if (keepPageAfterRefusedUnload(entry, view, generation, error, previousFavicon)) {
      options.onCancelled?.();
    } else {
      log.warn(`[kimi-desktop] browser loadURL rejected: ${redactUrlForLog(url)}`);
      failBrowserNavigation(entry, view, generation, error);
    }
  } finally {
    if (entry.addressLoad === addressLoad) entry.addressLoad = null;
  }
  return copyState(entry);
}

function keepPageAfterRefusedUnload(
  entry: BrowserEntry,
  view: WebContentsView,
  generation: number,
  error: unknown,
  favicon: string | undefined,
): boolean {
  const failure = error as { code?: unknown; errno?: unknown } | null;
  if (failure?.code !== 'ERR_ABORTED' && failure?.errno !== -3) return false;
  return keepPage(entry, view, generation, favicon);
}

function keepPage(entry: BrowserEntry, view: WebContentsView, generation: number, favicon: string | undefined): boolean {
  if (entry.view !== view || entry.generation !== generation || entry.state.error !== undefined) return false;
  const committedUrl = liveView(entry)?.webContents.getURL() ?? '';
  if (committedUrl === '' || !isRestorableBrowserUrl(committedUrl)) return false;
  entry.restoreUrl = committedUrl;
  entry.committedGeneration = generation;
  entry.domReadyGeneration = generation;
  entry.completeGeneration = generation;
  entry.state = { ...entry.state, favicon };
  syncCommittedState(entry);
  settleLoadWaiters(entry);
  return true;
}

const DOWNLOAD_HANDOFF_WAIT_MS = 1_000;

function isUnreportedLoadFailure(entry: BrowserEntry, generation: number, error: unknown): boolean {
  const failure = error as { code?: unknown; errno?: unknown } | null;
  if (failure?.code !== 'ERR_FAILED' && failure?.errno !== -2) return false;
  return entry.generation === generation && entry.state.error === undefined;
}

function urlWithoutHash(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = '';
    return url.href;
  } catch {
    return null;
  }
}

function downloadStartedFromAddress(item: DownloadItem, address: string): boolean {
  const target = urlWithoutHash(address);
  return target !== null && [...item.getURLChain(), item.getURL()].some(url => urlWithoutHash(url) === target);
}

function waitForDownloadHandoff(entry: BrowserEntry, generation: number): Promise<boolean> {
  return new Promise((resolve) => {
    const handoff = {
      generation,
      started: () => {
        clearTimeout(timer);
        if (entry.downloadHandoff === handoff) entry.downloadHandoff = null;
        resolve(true);
      },
    };
    const timer = setTimeout(() => {
      if (entry.downloadHandoff === handoff) entry.downloadHandoff = null;
      resolve(false);
    }, DOWNLOAD_HANDOFF_WAIT_MS);
    entry.downloadHandoff = handoff;
  });
}

function settleDownloadNavigation(entry: BrowserEntry, view: WebContentsView, generation: number, favicon: string | undefined): boolean {
  if (keepPage(entry, view, generation, favicon)) return true;
  if (entry.view !== view || entry.generation !== generation || entry.state.error !== undefined) return false;
  entry.restoreUrl = '';
  entry.pageRenderable = false;
  entry.committedGeneration = generation;
  entry.domReadyGeneration = generation;
  entry.completeGeneration = generation;
  entry.state = { ...entry.state, url: '', urlTruncated: undefined, title: '', favicon: undefined, loading: false, ...navigationState(entry) };
  applyViewGeometry(entry);
  publishState(entry);
  settleLoadWaiters(entry);
  return true;
}

function beginHistoryNavigation(entry: BrowserEntry, view: WebContentsView, navigate: () => void): void {
  const favicon = entry.state.favicon;
  beginNavigation(entry);
  const generation = entry.generation;
  entry.keepPageOnRefusedUnload = () => {
    if (entry.committedGeneration !== generation && keepPage(entry, view, generation, favicon)) publishState(entry);
  };
  publishState(entry);
  if (entry.userAgentSync === null || entry.userAgentSync.pending === 0) {
    navigate();
    return;
  }
  const deferred = deferNavigation(entry, favicon);
  void entry.userAgentSync.whenSettled().then(() => {
    if (takeDeferredNavigation(entry, deferred) && liveView(entry) === view) navigate();
  });
}

export function browserGoBack(browserId: BrowserId): BrowserState {
  const entry = browserEntries.get(browserId);
  if (entry === undefined) return copyState(undefined);
  const view = liveView(entry);
  if (view !== null && view.webContents.navigationHistory.canGoBack()) {
    entry.unloadTarget = { kind: 'back', at: Date.now() };
    beginHistoryNavigation(entry, view, () => view.webContents.navigationHistory.goBack());
  }
  return copyState(entry);
}

export function browserGoForward(browserId: BrowserId): BrowserState {
  const entry = browserEntries.get(browserId);
  if (entry === undefined) return copyState(undefined);
  const view = liveView(entry);
  if (view !== null && view.webContents.navigationHistory.canGoForward()) {
    entry.unloadTarget = { kind: 'forward', at: Date.now() };
    beginHistoryNavigation(entry, view, () => view.webContents.navigationHistory.goForward());
  }
  return copyState(entry);
}

export function browserReload(browserId: BrowserId): BrowserState {
  const entry = browserEntries.get(browserId);
  if (entry === undefined) return copyState(undefined);
  const view = liveView(entry);
  if (entry.state.url === '') return copyState(entry);
  if (view === null) {
    restoreBrowser(browserId);
    return copyState(entry);
  }
  if (entry.state.error !== undefined) {
    if (isLocalFileUrl(entry.state.url)) {
      const url = entry.state.url;
      void localPagesAllowed().then((allowed) => {
        if (allowed && browserEntries.get(browserId) === entry && entry.state.url === url) void loadBrowserUrl(entry, url);
      });
    }
    else void navigateBrowser(browserId, entry.state.url);
  } else {
    entry.unloadTarget = { kind: 'reload', at: Date.now() };
    beginHistoryNavigation(entry, view, () => view.webContents.reload());
  }
  return copyState(entry);
}

const HISTORY_NAVIGATION_START_TIMEOUT_MS = 15_000;

export async function runBrowserHistoryNavigation(
  browserId: BrowserId,
  action: 'back' | 'forward' | 'reload',
  options: { onCancelled?: () => void; onUndetermined?: () => void; signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<BrowserState> {
  const run = action === 'back' ? browserGoBack : action === 'forward' ? browserGoForward : browserReload;
  const entry = browserEntries.get(browserId);
  const view = entry === undefined ? null : liveView(entry);
  if (entry === undefined || view === null) return run(browserId);
  const before = entry.generation;
  run(browserId);
  const generation = entry.generation;
  const keep = entry.keepPageOnRefusedUnload;
  if (generation === before || keep === null) return copyState(entry);
  const contents = view.webContents;
  const { signal } = options;
  const outcome = await new Promise<'started' | 'refused' | 'undetermined'>((resolve) => {
    const finish = (value: 'started' | 'refused' | 'undetermined'): void => {
      clearTimeout(timer);
      contents.removeListener('did-start-navigation', started);
      contents.removeListener('destroyed', gone);
      signal?.removeEventListener('abort', aborted);
      if (entry.keepPageOnRefusedUnload === stay) entry.keepPageOnRefusedUnload = keep;
      resolve(value);
    };
    const stay = (): void => {
      const refused = entry.generation === generation && entry.committedGeneration !== generation;
      keep();
      finish(refused ? 'refused' : 'started');
    };
    const started = (_event: unknown, _url: string, _isInPlace: boolean, isMainFrame: boolean): void => { if (isMainFrame) finish('started'); };
    const gone = (): void => finish('started');
    const aborted = (): void => finish('undetermined');
    const timer = setTimeout(() => finish('undetermined'), options.timeoutMs ?? HISTORY_NAVIGATION_START_TIMEOUT_MS);
    entry.keepPageOnRefusedUnload = stay;
    contents.on('did-start-navigation', started);
    contents.once('destroyed', gone);
    if (signal?.aborted) aborted();
    else signal?.addEventListener('abort', aborted, { once: true });
  });
  if (outcome === 'refused') options.onCancelled?.();
  if (outcome === 'undetermined') options.onUndetermined?.();
  return copyState(entry);
}

export type BrowserZoomAction = 'in' | 'out' | 'reset';

export function browserZoom(browserId: BrowserId, action: BrowserZoomAction): BrowserState {
  const entry = browserEntries.get(browserId);
  const view = entry === undefined ? null : liveView(entry);
  if (entry === undefined || view === null) return copyState(entry);
  const current = view.webContents.getZoomFactor();
  let next = 1;
  if (action === 'in') next = BROWSER_ZOOM_STEPS.find((step) => step > current + 0.001) ?? BROWSER_ZOOM_STEPS.at(-1)!;
  else if (action === 'out') next = [...BROWSER_ZOOM_STEPS].reverse().find((step) => step < current - 0.001) ?? BROWSER_ZOOM_STEPS[0];
  view.webContents.setZoomFactor(next);
  entry.state = { ...entry.state, zoomFactor: next };
  publishState(entry);
  return copyState(entry);
}

export function applyDefaultBrowserZoom(factor: number): void {
  pagePersistence?.setDefaultZoom(factor);
  for (const entry of browserEntries.values()) {
    const view = liveView(entry);
    view?.webContents.setZoomFactor(factor);
    entry.state = { ...entry.state, zoomFactor: factor };
    publishState(entry);
  }
}

export function browserFind(
  browserId: BrowserId,
  text: string,
  options: { forward: boolean; findNext: boolean },
): void {
  const entry = browserEntries.get(browserId);
  const view = entry === undefined ? null : liveView(entry);
  if (view === null || text === '') return;
  view.webContents.findInPage(text, options);
}

export function browserStopFind(browserId: BrowserId): void {
  const entry = browserEntries.get(browserId);
  const view = entry === undefined ? null : liveView(entry);
  view?.webContents.stopFindInPage('clearSelection');
}

export async function browserPrint(browserId: BrowserId): Promise<boolean> {
  const entry = browserEntries.get(browserId);
  const view = entry === undefined ? null : liveView(entry);
  if (view === null) return false;
  view.webContents.focus();
  await view.webContents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code: 'window.print()' }], true);
  return true;
}

export async function captureBrowserScreenshot(browserId: BrowserId): Promise<boolean> {
  const page = getBrowserPage(browserId);
  const host = liveHost();
  if (page === null || host === null) return false;
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const result = await dialog.showSaveDialog(host, {
    title: (effectiveContextMenuLocale() === 'zh' ? browserZh : browserEn).saveDialog.screenshot,
    defaultPath: join(app.getPath('pictures'), `Kimi Browser ${timestamp}.png`),
    filters: [{ name: 'PNG image', extensions: ['png'] }],
  });
  if (result.canceled || result.filePath === undefined) return false;
  const image = await page.webContents.capturePage();
  if (image.isEmpty()) return false;
  await writeFile(result.filePath, image.toPNG());
  return true;
}

function browserVersionForDeviceUserAgent(): string {
  const desktopUserAgent = electronUserAgent();
  return /Chrome\/([\d.]+)/.exec(desktopUserAgent)?.[1] ?? process.versions.chrome ?? '1.0.0.0';
}

function deviceUserAgent(profile: BrowserDeviceProfile): string {
  return profile.userAgentTemplate.replace('%c', browserVersionForDeviceUserAgent());
}

function deviceUserAgentMetadata(profile: BrowserDeviceProfile): Record<string, unknown> {
  const fullVersion = browserVersionForDeviceUserAgent();
  const majorVersion = fullVersion.split('.')[0] ?? fullVersion;
  return {
    brands: [
      { brand: 'Not_A Brand', version: '99' },
      { brand: 'Chromium', version: majorVersion },
    ],
    fullVersionList: [
      { brand: 'Not_A Brand', version: '99.0.0.0' },
      { brand: 'Chromium', version: fullVersion },
    ],
    fullVersion,
    ...profile.userAgentMetadata,
    bitness: profile.mobile ? '' : '64',
    wow64: false,
  };
}

function deviceNavigatorPlatform(profile: BrowserDeviceProfile): string {
  if (profile.userAgentMetadata.platform === 'Windows') return 'Win32';
  if (profile.userAgentMetadata.platform === 'Android') return 'Linux armv8l';
  return profile.userAgentMetadata.model === 'iPad' ? 'MacIntel' : 'iPhone';
}

type DeviceGuard = () => Promise<void>;

class DeviceEmulationDeferred extends Error {}

function deviceEmulationReady(entry: BrowserEntry, view: WebContentsView): boolean {
  const contents = view.webContents;
  if (contents.isDestroyed() || contents.isCrashed()) return false;
  if (entry.deviceEmulationBlocked || entry.state.error !== undefined) return false;
  return !contents.isLoadingMainFrame();
}

function requireDeviceEmulationReady(entry: BrowserEntry, view: WebContentsView): void {
  if (!deviceEmulationReady(entry, view)) throw new DeviceEmulationDeferred('Browser page is not ready for device emulation.');
}

async function deferUntilDeviceEmulationReady(entry: BrowserEntry, view: WebContentsView, run: () => Promise<void>): Promise<void> {
  if (!deviceEmulationReady(entry, view)) {
    entry.deviceSyncPending = true;
    return;
  }
  try {
    await run();
  } catch (error) {
    if (!(error instanceof DeviceEmulationDeferred)) throw error;
    entry.deviceSyncPending = true;
  }
}

const DEVICE_SYNC_FAILED = 'Browser device emulation failed to apply.';

function flushDeviceEmulation(entry: BrowserEntry, view: WebContentsView): boolean {
  if (!entry.deviceSyncPending) return false;
  entry.deviceSyncPending = false;
  entry.deviceSyncInFlight += 1;
  const generation = entry.generation;
  let failed = false;
  void enqueueDeviceTask(entry, async () => {
    if (entry.state.device === undefined) await resetDeviceEmulation(entry);
    else await applyDeviceEmulation(entry, true);
  }).catch((error: unknown) => {
    failed = true;
    if (liveView(entry) === view) entry.deviceSyncPending = true;
    log.warn(`[kimi-desktop] browser device emulation sync failed: ${String(error)}`);
  }).finally(() => {
    entry.deviceSyncInFlight -= 1;
    if (failed && entry.generation === generation) {
      entry.deviceSyncFailedGeneration = generation;
      rejectLoadWaiters(entry, DEVICE_SYNC_FAILED);
    }
    else if (failed) { if (entry.state.loading || !flushDeviceEmulation(entry, view)) settleLoadWaiters(entry); }
    else if (!reloadForDeviceProfile(entry, view)) settleLoadWaiters(entry);
  });
  return true;
}

function reloadForDeviceProfile(entry: BrowserEntry, view: WebContentsView): boolean {
  if (liveView(entry) !== view || entry.deviceSyncPending || entry.state.loading || entry.state.error !== undefined || entry.state.url === '') return false;
  if (entry.appliedDeviceProfile === entry.pageDeviceProfile) return false;
  for (const waiter of entry.waiters) waiter.generation = entry.generation + 1;
  entry.unloadTarget = { kind: 'reload', at: Date.now() };
  beginHistoryNavigation(entry, view, () => {
    const keep = entry.keepPageOnRefusedUnload;
    entry.keepPageOnRefusedUnload = () => {
      entry.deviceReloadAwaitingUnload = true;
      keep?.();
    };
    view.webContents.reload();
  });
  return true;
}

function deviceCommandSender(entry: BrowserEntry, view: WebContentsView, guard?: DeviceGuard) {
  const generation = browserDebuggerGeneration(view.webContents);
  const check = (): void => {
    if (liveView(entry) !== view || browserDebuggerGeneration(view.webContents) !== generation) {
      throw new Error('Browser debugger detached during device update.');
    }
  };
  return async (method: string, params?: Record<string, unknown>): Promise<void> => {
    check();
    if (guard !== undefined) {
      await guard();
      check();
    }
    requireDeviceEmulationReady(entry, view);
    if (params === undefined) await view.webContents.debugger.sendCommand(method);
    else await view.webContents.debugger.sendCommand(method, params);
    check();
  };
}

async function applyDeviceEmulation(entry: BrowserEntry, includeCapabilities: boolean, guard?: DeviceGuard): Promise<void> {
  const view = liveView(entry);
  const device = entry.state.device;
  if (view === null || device === undefined) return;
  await deferUntilDeviceEmulationReady(entry, view, () => sendDeviceEmulation(entry, view, device, includeCapabilities, guard));
}

async function sendDeviceEmulation(entry: BrowserEntry, view: WebContentsView, device: BrowserDeviceState, includeCapabilities: boolean, guard?: DeviceGuard): Promise<void> {
  ensureBrowserDebugger(view.webContents, 'device');
  const send = deviceCommandSender(entry, view, guard);
  const profile = getBrowserDeviceProfile(device.profileId);
  await send('Emulation.setDeviceMetricsOverride', {
    width: device.width,
    height: device.height,
    deviceScaleFactor: device.deviceScaleFactor,
    mobile: device.mobile,
    scale: device.displayScale * hostWindowZoomFactor(),
    screenWidth: device.width,
    screenHeight: device.height,
    positionX: 0,
    positionY: 0,
    screenOrientation: {
      type: device.orientation === 'portrait' ? 'portraitPrimary' : 'landscapePrimary',
      angle: device.orientation === 'portrait' ? 0 : 90,
    },
  });
  if (!includeCapabilities) return;
  await send('Emulation.setUserAgentOverride', {
    userAgent: deviceUserAgent(profile),
    platform: deviceNavigatorPlatform(profile),
    userAgentMetadata: deviceUserAgentMetadata(profile),
  });
  await send('Emulation.setTouchEmulationEnabled', {
    enabled: device.touch,
    maxTouchPoints: 5,
  });
  requireDeviceEmulationReady(entry, view);
  await setBrowserMouseTouchEmulation(view.webContents, device.touch);
  entry.appliedDeviceProfile = device.profileId;
  entry.deviceSyncPending = false;
}

function queueDeviceEmulation(entry: BrowserEntry, includeCapabilities: boolean, guard?: DeviceGuard): Promise<void> {
  const revision = ++entry.deviceApplyRevision;
  return enqueueDeviceTask(entry, async () => {
    if (!includeCapabilities && revision !== entry.deviceApplyRevision) return;
    await applyDeviceEmulation(entry, includeCapabilities, guard);
  });
}

function clearDeviceEmulation(entry: BrowserEntry, guard?: DeviceGuard): Promise<void> {
  ++entry.deviceApplyRevision;
  return enqueueDeviceTask(entry, async () => {
    await resetDeviceEmulation(entry, guard);
    const { device: _device, ...stateWithoutDevice } = entry.state;
    entry.state = stateWithoutDevice;
  });
}

async function resetDeviceEmulation(entry: BrowserEntry, guard?: DeviceGuard): Promise<void> {
  const view = liveView(entry);
  if (view === null) return;
  const pageDebugger = view.webContents.debugger;
  if (!pageDebugger.isAttached()) {
    releaseBrowserDebugger(view.webContents, 'device');
    await syncContentsUserAgent(view.webContents);
    entry.appliedDeviceProfile = null;
    return;
  }
  await deferUntilDeviceEmulationReady(entry, view, () => sendDeviceEmulationReset(entry, view, guard));
}

async function sendDeviceEmulationReset(entry: BrowserEntry, view: WebContentsView, guard?: DeviceGuard): Promise<void> {
  const send = deviceCommandSender(entry, view, guard);
  await send('Emulation.clearDeviceMetricsOverride');
  await send('Emulation.setTouchEmulationEnabled', { enabled: false });
  requireDeviceEmulationReady(entry, view);
  await setBrowserMouseTouchEmulation(view.webContents, false);
  const active = activeBrowserUserAgent();
  if (active.userAgentMetadata !== undefined) {
    ensureBrowserDebugger(view.webContents, 'user-agent');
    await send('Emulation.setUserAgentOverride', { ...active });
  } else {
    await send('Emulation.setUserAgentOverride', { userAgent: '' });
    releaseBrowserDebugger(view.webContents, 'user-agent');
  }
  await send('Emulation.resetPageScaleFactor');
  releaseBrowserDebugger(view.webContents, 'device');
  entry.appliedDeviceProfile = null;
  entry.deviceSyncPending = false;
}

function createDeviceState(
  entry: BrowserEntry,
  request: Extract<BrowserDeviceModeRequest, { enabled: true }>,
): BrowserDeviceState {
  const profile = getBrowserDeviceProfile(request.profileId);
  const profileWidth =
    request.profileId === 'responsive' ? request.width! : profile.width;
  const profileHeight =
    request.profileId === 'responsive' ? request.height! : profile.height;
  const width =
    request.profileId === 'responsive' || request.orientation === 'portrait'
      ? profileWidth
      : profileHeight;
  const height =
    request.profileId === 'responsive' || request.orientation === 'portrait'
      ? profileHeight
      : profileWidth;
  const orientation =
    request.profileId !== 'responsive' || width === height
      ? request.orientation
      : width < height
        ? 'portrait'
        : 'landscape';
  const requestedScale = request.scaleMode === 'fixed' ? request.scale! : 1;
  const scales = deviceDisplayScale(entry.bounds, width, height, request.scaleMode, requestedScale);
  return {
    profileId: request.profileId,
    orientation,
    width,
    height,
    deviceScaleFactor: profile.deviceScaleFactor,
    mobile: profile.mobile,
    touch: profile.touch,
    scaleMode: request.scaleMode,
    requestedScale,
    ...scales,
  };
}

export function updateBrowserDeviceMode(
  browserId: BrowserId,
  request: BrowserDeviceModeRequest,
  options: { signal?: AbortSignal; validate?: () => Promise<void> } = {},
): Promise<BrowserState> {
  const entry = browserEntries.get(browserId);
  if (entry === undefined) return Promise.resolve(copyState(entry));
  const guard = async (): Promise<void> => {
    if (options.signal?.aborted) throw new Error('Browser device update was aborted.');
    await options.validate?.();
    if (options.signal?.aborted) throw new Error('Browser device update was aborted.');
  };
  const update = entry.deviceUpdateChain.then(async () => {
    await guard();
    return applyBrowserDeviceMode(entry, request, guard);
  });
  entry.deviceUpdateChain = update.then(() => undefined, () => undefined);
  return update;
}

async function applyBrowserDeviceMode(
  entry: BrowserEntry,
  request: BrowserDeviceModeRequest,
  guard: DeviceGuard,
): Promise<BrowserState> {
  const view = liveView(entry);
  if (view === null) return copyState(entry);
  const previousDevice = entry.state.device;
  const debuggerGeneration = browserDebuggerGeneration(view.webContents);
  if (!request.enabled && previousDevice === undefined) return copyState(entry);
  const identityChanged =
    request.enabled === false ||
    previousDevice === undefined ||
    previousDevice.profileId !== request.profileId;
  try {
    if (request.enabled) {
      entry.state = { ...entry.state, device: createDeviceState(entry, request) };
      applyViewGeometry(entry);
      await queueDeviceEmulation(entry, true, guard);
    } else {
      await clearDeviceEmulation(entry, guard);
      applyViewGeometry(entry);
    }
    if (liveView(entry) !== view || browserDebuggerGeneration(view.webContents) !== debuggerGeneration) {
      throw new Error('Browser debugger detached during device update.');
    }
    await guard();
    if (liveView(entry) !== view || browserDebuggerGeneration(view.webContents) !== debuggerGeneration) {
      throw new Error('Browser debugger detached during device update.');
    }
  } catch (error) {
    if (liveView(entry) === view && browserDebuggerGeneration(view.webContents) === debuggerGeneration) {
      try {
        if (previousDevice === undefined) await clearDeviceEmulation(entry);
        else {
          entry.state = { ...entry.state, device: previousDevice };
          await queueDeviceEmulation(entry, true);
        }
      } catch {
        disposeView(entry);
        const { device: _device, ...state } = entry.state;
        entry.state = state;
      }
    }
    applyViewGeometry(entry);
    publishState(entry);
    throw error;
  }
  publishState(entry);
  if (identityChanged && entry.state.url !== '' && entry.appliedDeviceProfile !== entry.pageDeviceProfile) {
    entry.pageDeviceProfile = entry.appliedDeviceProfile;
    view.webContents.reload();
  }
  return copyState(entry);
}

export async function toggleBrowserDeviceMode(browserId: BrowserId): Promise<BrowserState> {
  const entry = browserEntries.get(browserId);
  if (entry?.state.device !== undefined) {
    return updateBrowserDeviceMode(browserId, { enabled: false });
  }
  return updateBrowserDeviceMode(browserId, {
    enabled: true,
    profileId: 'responsive',
    orientation: 'portrait',
    width: 393,
    height: 852,
    scaleMode: 'fit',
  });
}

export function browserStopLoading(browserId: BrowserId): BrowserState {
  const entry = browserEntries.get(browserId);
  if (entry === undefined) return copyState(undefined);
  const view = liveView(entry);
  if (view === null) return copyState(entry);
  cancelDeferredNavigation(entry, view);
  if (view.webContents.isLoading()) view.webContents.stop();
  return copyState(entry);
}

export function waitForBrowserLoad(
  browserId: BrowserId,
  state: BrowserLoadWaiter['state'],
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<BrowserState> {
  const entry = browserEntries.get(browserId);
  if (entry === undefined || liveView(entry) === null || entry.state.url === '') {
    return Promise.reject(new Error('Browser tab is not ready.'));
  }
  const generation = entry.generation;
  if (entry.deviceSyncPending && entry.deviceSyncFailedGeneration === generation) return Promise.reject(new Error(DEVICE_SYNC_FAILED));
  if (loadStateReached(entry, state, generation)) {
    const outcome = deviceSyncOutcome(entry);
    if (outcome === 'failed') return Promise.reject(new Error(DEVICE_SYNC_FAILED));
    if (outcome === 'ready') return Promise.resolve(copyState(entry));
  }
  if (signal?.aborted) return Promise.reject(new Error('Browser operation was aborted.'));

  return new Promise<BrowserState>((resolve, reject) => {
    const onAbort = (): void => {
      entry.waiters.delete(waiter);
      clearTimeout(waiter.timer);
      reject(new Error('Browser operation was aborted.'));
    };
    const waiter: BrowserLoadWaiter = {
      state,
      generation,
      resolve,
      reject,
      timer: setTimeout(() => {
        entry.waiters.delete(waiter);
        waiter.disposeAbort();
        reject(new Error(`Timed out waiting for browser ${state}.`));
      }, timeoutMs),
      disposeAbort: () => signal?.removeEventListener('abort', onAbort),
    };
    waiter.timer.unref?.();
    entry.waiters.add(waiter);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}



function cleanBrowserPages(origin: string | undefined, clear: (browserSession: Session) => Promise<void>): Promise<void> {
  const task = (clearingBrowserData ?? Promise.resolve()).catch(() => undefined).then(async () => {
    const browserSession = session.fromPartition(BROWSER_PARTITION);
    configureSession(browserSession);
    const matches = (url: string): boolean => origin === undefined || browserSiteOrigin(url) === origin;
    for (const popup of [...browserWindows]) {
      if (!matches(popup.webContents.getURL())) continue;
      popup.destroy();
      browserWindows.delete(popup);
    }
    for (const entry of browserEntries.values()) {
      if (!matches(liveView(entry)?.webContents.getURL() || entry.restoreUrl)) continue;
      disposeView(entry, true);
      if (origin === undefined) {
        entry.restoreUrl = '';
        entry.state = { ...EMPTY_BROWSER_STATE };
      } else entry.state = { ...entry.state, loading: false };
      publishState(entry);
    }
    await browserSession.clearStorageData({ origin, storages: ['serviceworkers'] });
    if (origin === undefined) await browserSession.closeAllConnections();
    await clear(browserSession);
  });
  const completion = task.finally(() => {
    if (clearingBrowserData !== completion) return;
    clearingBrowserData = null;
    for (const entry of browserEntries.values()) {
      if (entry.view === null && entry.requestedVisible && entry.restoreUrl) restoreBrowser(entry.browserId);
    }
  });
  clearingBrowserData = completion;
  return completion;
}

export function browserIdsForSite(origin: string): BrowserId[] {
  return [...browserEntries.values()]
    .filter((entry) => browserSiteOrigin(liveView(entry)?.webContents.getURL() || entry.restoreUrl) === origin)
    .map((entry) => entry.browserId);
}

export async function clearBrowserSiteData(origin: string): Promise<BrowserSiteInfo> {
  const canonical = browserSiteOrigin(origin);
  if (canonical === null) throw new Error('Invalid site');
  let result!: BrowserSiteInfo;
  await cleanBrowserPages(canonical, async () => { result = await clearBrowserSiteStorage(canonical); });
  return result;
}

export async function clearBrowserData(browserId: BrowserId): Promise<BrowserState> {
  await cleanBrowserPages(undefined, async browserSession => {
    const results = await Promise.allSettled([
      browserSession.clearStorageData(), browserSession.clearCache(), browserSession.clearAuthCache(),
    ]);
    const failures = results.filter(result => result.status === 'rejected');
    if (failures.length > 0) throw new AggregateError(failures.map(result => result.reason), 'Browser data cleanup failed');
  });
  return getBrowserState(browserId);
}

export function closeBrowser(browserId: BrowserId): void {
  for (const popup of browserWindows) {
    if (browserWindowOwners.get(popup) === browserId && !popup.isDestroyed()) popup.destroy();
  }
  try {
    pagePersistence?.deletePage(browserId);
  } catch (error) {
    log.error('[kimi-desktop] failed to remove persisted browser page', error);
  }
  agentAttributedTabs.delete(browserId);
  userDownloadTabs.delete(browserId);
  const entry = browserEntries.get(browserId);
  if (entry !== undefined) {
    disposeView(entry);
    browserEntries.delete(browserId);
  }
  forgetBrowserEvents(browserId);
}


export function destroyBrowserView(): void {
  try { pagePersistence?.flush(); } catch (error) { log.error('[kimi-desktop] failed to flush browser pages', error); }
  for (const popup of browserWindows) popup.destroy();
  browserWindows.clear();
  for (const entry of browserEntries.values()) {
    disposeView(entry);
    forgetBrowserEvents(entry.browserId);
  }
  browserEntries.clear();
  agentAttributedTabs.clear();
  userDownloadTabs.clear();
  if (backgroundWindow !== null && !backgroundWindow.isDestroyed()) backgroundWindow.destroy();
  backgroundWindow = null;
}

export async function updateBrowserFocusEmulation(browserId: BrowserId, enabled: boolean): Promise<BrowserState> {
  const entry = ensureEntry(browserId);
  const view = ensureBrowserView(entry);
  await setBrowserFocusEmulation(view.webContents, enabled);
  if (liveView(entry) !== view) throw new Error('Browser view changed while setting focus emulation.');
  entry.state = { ...entry.state, emulateFocus: browserFocusEmulationEnabled(view.webContents) };
  publishState(entry);
  return copyState(entry);
}

function knownBrowserEntry(browserId: BrowserId): BrowserEntry {
  const existing = browserEntries.get(browserId);
  if (existing !== undefined) return existing;
  if (pagePersistence?.getPage(browserId) === undefined) throw new Error('Unknown browser tab');
  return ensureEntry(browserId);
}

function browserTabWebUrl(entry: BrowserEntry, allowFile = false): string {
  const shown = entry.state.url;
  const url = entry.state.urlTruncated === true ? (browserStateUrl(entry.restoreUrl)?.url === shown ? entry.restoreUrl : '') : shown;
  let protocol = '';
  try { protocol = new URL(url).protocol; } catch {}
  if (protocol !== 'http:' && protocol !== 'https:' && !(allowFile && protocol === 'file:')) throw new Error('Browser tab has no web URL');
  return url;
}

export async function browserTabCommand(request: BrowserTabCommand): Promise<BrowserState> {
  if (request.action === 'mute' || request.action === 'unmute') {
    const entry = ensureEntry(request.browserId);
    const contents = liveView(entry)?.webContents;
    entry.soundOverride = request.action === 'mute';
    syncBrowserTabSound(entry, contents, contents?.getURL() || entry.restoreUrl);
    publishState(entry);
    return copyState(entry);
  }
  const entry = knownBrowserEntry(request.browserId);
  if (request.action === 'copy-url') await clipboard.writeText(browserTabWebUrl(entry, true));
  else await shell.openExternal(browserTabWebUrl(entry));
  return copyState(entry);
}
