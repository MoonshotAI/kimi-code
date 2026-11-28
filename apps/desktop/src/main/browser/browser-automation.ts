import { waitForBrowserCondition, BrowserWaitError } from './browser-wait';
import { cropBrowserScreenshot } from './browser-crop';
import { readBrowserText } from './browser-text-read';
import { readBrowserElements } from './browser-elements-read';
import { browserActivityFor, browserOperationActs } from './browser-activity';
import { beginBrowserActivity, notifyBrowserAgentAction, type BrowserActivityHandle } from './browser-control';
import { withBrowserReceipt } from './browser-receipts';
import { BrowserReadError } from './browser-read-cache';
import { getBrowserPermissionRequests } from './browser-sites';
import {
  blockingBrowserDialogs,
  getBrowserDialog,
  answeringBrowserDialog,
  hasBlockingBrowserDialog,
  onBrowserDialogOpened,
  hasPendingBrowserEvents,
  listPendingBrowserDialogs,
  openBrowserDialog,
  respondBrowserDialog,
  takeBrowserDialogRecords,
  takeBrowserNotices,
  hasQueuedBrowserEvents,
  hasBrowserDialogReminder,
  takeBrowserDialogReminder,
  forgetBrowserDialogSession,
} from './browser-dialogs';
import { fileUploadNeedsApproval, type BrowserUploadPermissionMode } from './browser-upload-policy';
import type { BrowserDialogRecord, BrowserPageDialog, BrowserPendingDialog } from '../../shared/browser-dialogs';
import { formatBrowserToolResult } from './browser-tool-output';
import { getBrowserData, getBrowserDownloads } from './browser-data';
import { localFileAddressUrl } from './browser-local-file';
import { browserControlOwnership, BrowserControlError, browserUserTakeoverError } from './browser-control-ownership';
import type { DesktopBrowserSubagentRun } from './browser-subagent-control';
import { sameBrowserSubagentRun, type BrowserSubagentRun } from '../../shared/browser-run';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { WebContents } from 'electron';
import type { MainWindow } from '../window/main-window';

import { BrowserInputError } from './browser-input';
import { browserPageDialogControlReady } from './browser-page-dialogs';
import { isBrowserAnnotationPicking } from './browser-annotations';
import {
  BROWSER_AUTOMATION_PROTOCOL,
  BROWSER_LOCAL_FILE_REFUSAL,
  type BrowserErrorCode,
  type BrowserOperation,
  type BrowserRunRequest,
  type BrowserRunResult,
  type BrowserSnapshot,
  type BrowserTabSnapshot,
  type BrowserUiCommand,
  type BrowserUiResponse,
  type BrowserUiState,
  isBrowserUiResponse,
} from '../../shared/browser-automation';
import { BROWSER_DEVICE_PROFILES } from '../../shared/browser-device';
import { BROWSER_SEARCH_ENGINES, browserSearchUrl, type BrowserSearchEngine } from '../../shared/browser-search';
import { BROWSER_STATE_URL_MAX } from '../../shared/browser';
import {
  restoreBrowser,
  updateBrowserDeviceMode,
  agentLocalFilesEnabled,
  browserHistoryTargetIsLocalFile,
  browserLocalPagesAllowed,
  runBrowserHistoryNavigation,
  browserDownloadsDirectory,
  browserStopLoading,
  getBrowserGeneration,
  getBrowserPage,
  getBrowserState,
  listBrowserStates,
  navigateBrowser,
  waitForBrowserLoad,
} from './browser-view';
import { IPC } from '../ipc/ipc-channels';
import {
  BrowserPageError,
  captureBrowserVisual,
  clickBrowserVisual,
  clickBrowserVisualIfInteractive,
  dragBrowserVisual,
  dragPathBrowserVisual,
  hoverBrowserVisual,
  pressBrowserVisual,
  runBrowserElementAction,
  scrollBrowserVisual,
  typeBrowserVisual,
} from './browser-page';

const UI_REQUEST_TIMEOUT_MS = 5_000;
const EVENT_OUTPUT_MIN = 2048;
const EVENT_OUTPUT_MAX = 8000;

interface PendingUiRequest {
  resolve: (response: BrowserUiResponse) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class BrowserAutomationError extends Error {
  constructor(
    readonly code: BrowserErrorCode,
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = 'BrowserAutomationError';
  }
}

interface RequestContext {
  sessionId?: string;
  run?: DesktopBrowserSubagentRun;
  revision?: number;
  workspaceRoot?: string | null;
  permissionMode?: BrowserUploadPermissionMode;
}

const requestSession = new AsyncLocalStorage<RequestContext>();
const UPLOAD_APPROVAL_TIMEOUT_MS = 10 * 60_000;

let hostWindow: MainWindow | null = null;
let uiRequestSequence = 0;
const pendingUiRequests = new Map<number, PendingUiRequest>();

const LEAVE_PENDING_MESSAGE = 'The page asked to confirm leaving, so the navigation did not happen yet and the current page is unchanged. A beforeunload dialog is pending: page.dialog.respond with accept:true leaves and repeats the navigation, accept:false stays. The page may have unsaved changes; ask the user if unsure.';

const NAVIGATION_UNDETERMINED_MESSAGE = 'The navigation did not start or get refused in time, so it is unknown whether the page changed; the page may still be running a slow beforeunload handler. Check the tab with tab.get_state or tab.wait_for_load before acting on the page.';

async function historyNavigation(browserId: string, action: 'back' | 'forward' | 'reload', signal?: AbortSignal): Promise<void> {
  let outcome: 'cancelled' | 'undetermined' | undefined;
  await runBrowserHistoryNavigation(browserId, action, { signal, onCancelled: () => { outcome = 'cancelled'; }, onUndetermined: () => { outcome = 'undetermined'; } });
  if (outcome === 'cancelled') throw new BrowserAutomationError('NAVIGATION_FAILED', LEAVE_PENDING_MESSAGE);
  if (outcome === 'undetermined') throw new BrowserAutomationError('NAVIGATION_FAILED', NAVIGATION_UNDETERMINED_MESSAGE);
}

function liveHost(): MainWindow | null {
  return hostWindow !== null && !hostWindow.isDestroyed() ? hostWindow : null;
}

function rejectPendingUiRequests(message: string): void {
  for (const [requestId, pending] of pendingUiRequests) {
    pendingUiRequests.delete(requestId);
    clearTimeout(pending.timer);
    pending.reject(new BrowserAutomationError('BROWSER_UNAVAILABLE', message));
  }
}

export function attachBrowserAutomationWindow(win: MainWindow): void {
  if (hostWindow !== win) rejectPendingUiRequests('Browser renderer was replaced.');
  hostWindow = win;
  win.once('closed', () => {
    if (hostWindow !== win) return;
    hostWindow = null;
    rejectPendingUiRequests('Browser renderer is unavailable.');
  });
}

export function isBrowserAutomationRenderer(sender: WebContents): boolean {
  return liveHost()?.webContents === sender;
}

export function handleBrowserUiResponse(sender: WebContents, value: unknown): void {
  if (!isBrowserAutomationRenderer(sender) || !isBrowserUiResponse(value)) return;
  const pending = pendingUiRequests.get(value.requestId);
  if (pending === undefined) return;
  pendingUiRequests.delete(value.requestId);
  clearTimeout(pending.timer);
  pending.resolve(value);
}

function requestBrowserUi(command: BrowserUiCommand, signal?: AbortSignal, refreshing = false): Promise<BrowserUiState> {
  const context = requestSession.getStore();
  try { context?.run?.assertActive(); }
  catch (error) { return Promise.reject(error); }
  const host = liveHost();
  if (host === null) {
    return Promise.reject(new BrowserAutomationError('BROWSER_UNAVAILABLE', 'Browser renderer is unavailable.'));
  }
  if (signal?.aborted) {
    return Promise.reject(new BrowserAutomationError('OPERATION_ABORTED', 'Browser operation was aborted.'));
  }
  uiRequestSequence += 1;
  const requestId = uiRequestSequence;
  const cancel = (): void => {
    const live = liveHost();
    if (live !== null) live.webContents.send(IPC.browserAutomationUiRequest, { requestId, cancel: true });
  };
  return new Promise<BrowserUiState>((resolve, reject) => {
    const onAbort = (): void => {
      const pending = pendingUiRequests.get(requestId);
      if (pending === undefined) return;
      pendingUiRequests.delete(requestId);
      clearTimeout(pending.timer);
      cancel();
      reject(new BrowserAutomationError('OPERATION_ABORTED', 'Browser operation was aborted.'));
    };
    const timer = setTimeout(() => {
      pendingUiRequests.delete(requestId);
      signal?.removeEventListener('abort', onAbort);
      cancel();
      reject(new BrowserAutomationError('BROWSER_UNAVAILABLE', 'Browser renderer did not answer in time.', true));
    }, UI_REQUEST_TIMEOUT_MS);
    timer.unref?.();
    pendingUiRequests.set(requestId, {
      timer,
      reject: (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      },
      resolve: (response) => {
        signal?.removeEventListener('abort', onAbort);
        try { context?.run?.assertActive(); }
        catch (error) { reject(error); return; }
        if (context?.sessionId) {
          if (response.state !== undefined && context.run === undefined) browserControlOwnership.observeTurn(context.sessionId, response.state.turnId);
          if (!refreshing) {
            const allowRelease = context.run !== undefined && (command.action === 'release_tab' || command.action === 'close_tab');
            try { browserControlOwnership.assertAllowed(context.sessionId, context.revision, context.run?.run, allowRelease); }
            catch (error) { reject(error); return; }
          }
        }
        if (!response.ok || response.state === undefined) {
          const code = command.action === 'release_tab' || command.action === 'close_tab' ? 'TAB_NOT_ACTIVE' : 'BROWSER_UNAVAILABLE';
          reject(new BrowserAutomationError(code, response.error ?? 'Browser renderer rejected the operation.'));
          return;
        }
        resolve(response.state);
      },
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    const controller = context?.run;
    host.webContents.send(IPC.browserAutomationUiRequest, {
      requestId,
      command,
      sessionId: context?.sessionId,
      ...(controller === undefined ? {} : { controller: {
        run: controller.run,
        ...(controller.profile === undefined ? {} : { profile: controller.profile }),
        ...(controller.description === undefined ? {} : { description: controller.description }),
      } }),
    });
  });
}

const controlLeases = new WeakMap<BrowserTabSnapshot, string>();

function joinBrowserSnapshot(ui: BrowserUiState): BrowserSnapshot {
  const states = new Map(listBrowserStates().map((entry) => [entry.browserId, entry]));
  const requested = requestSession.getStore()?.run;
  const controller = ui.controlledController;
  const ownsControl = requested === undefined ? controller === undefined : controller !== undefined && sameBrowserSubagentRun(requested.run, controller.run);
  const controlledTabId = ownsControl ? ui.controlledTabId : null;
  return {
    available: liveHost() !== null,
    panelVisible: ui.panelVisible,
    activeTabId: controlledTabId,
    visibleTabId: ui.panelVisible ? ui.activeTabId : null,
    tabs: ui.tabs.map((tab) => {
      const native = states.get(tab.browserId);
      const { favicon: _favicon, renderable: _renderable, ...state } = native?.state ?? getBrowserState(tab.browserId);
      const joined: BrowserTabSnapshot = {
        tabId: tab.tabId,
        browserId: tab.browserId,
        active: controlledTabId === tab.tabId,
        visible: ui.panelVisible && ui.activeTabId === tab.tabId,
        generation: native?.generation ?? 0,
        ...state,
      };
      if (joined.active && ui.controlledLeaseId !== null) controlLeases.set(joined, ui.controlledLeaseId);
      return joined;
    }),
  };
}

async function browserSnapshot(signal?: AbortSignal): Promise<BrowserSnapshot> {
  return joinBrowserSnapshot(await requestBrowserUi({ action: 'get_state' }, signal));
}

async function requireTab(tabId: string, signal?: AbortSignal): Promise<BrowserTabSnapshot> {
  const snapshot = await browserSnapshot(signal);
  const tab = snapshot.tabs.find((candidate) => candidate.tabId === tabId);
  if (tab === undefined) {
    throw new BrowserAutomationError('TAB_NOT_FOUND', `Browser tab "${tabId}" does not exist.`);
  }
  return tab;
}

async function updatedTab(tabId: string, signal?: AbortSignal): Promise<BrowserTabSnapshot> {
  return requireTab(tabId, signal);
}

function refuseWaitingPage(tab: BrowserTabSnapshot): void {
  refuseBlockedPage(tab);
  const answering = answeringBrowserDialog(tab.browserId);
  if (answering?.by === 'user') {
    throw new BrowserAutomationError('WAITING_FOR_USER', `The user is answering the ${answering.kind} dialog ${answering.dialogId} (choosing or approving files for the page). Other page operations wait until it finishes; ask the user, then retry.`, true);
  }
  if (answering !== undefined) {
    throw new BrowserAutomationError('DIALOG_OPEN', `Files are still being attached for the ${answering.kind} dialog ${answering.dialogId}. Retry after it finishes.`, true);
  }
  const permissions = getBrowserPermissionRequests().filter(request => request.browserId === tab.browserId).flatMap(request => request.permissions);
  if (permissions.length > 0) {
    throw new BrowserAutomationError('WAITING_FOR_USER', `The page is waiting for the user to answer a site permission prompt (${[...new Set(permissions)].join(', ')}). Only the user can answer it; ask the user, then retry.`, true);
  }
}

function refuseBlockedPage(tab: BrowserTabSnapshot): void {
  const [blocking] = blockingBrowserDialogs(tab.browserId);
  if (blocking !== undefined) {
    throw new BrowserAutomationError('DIALOG_OPEN', `The page is showing ${blocking.kind === 'alert' ? 'an' : 'a'} ${blocking.kind} dialog (dialogId ${blocking.dialogId}) and cannot run other operations until it is answered. Read it with page.dialog.get and answer it with page.dialog.respond.`, true);
  }
}

async function requireControlledTab(tabId: string, signal?: AbortSignal, allowWaitingPage = false): Promise<BrowserTabSnapshot> {
  const tab = refuseLocalFilePage(await requireTab(tabId, signal));
  if (!allowWaitingPage) refuseWaitingPage(tab);
  if (isBrowserAnnotationPicking(tab.browserId)) throw new BrowserAutomationError('PAGE_NOT_READY', 'The user is selecting a browser annotation. Retry after selection finishes.');
  if (!tab.active || controlLeases.get(tab) === undefined) {
    throw new BrowserAutomationError('TAB_NOT_ACTIVE', 'Select this tab for control with browser.activate_tab first. This does not change the visible tab.');
  }
  return tab;
}

function isLocalFileTab(tab: BrowserTabSnapshot): boolean {
  if (agentLocalFilesEnabled()) return false;
  return /^file:/i.test(tab.url) || getBrowserPage(tab.browserId)?.localFile === true;
}

function refuseLocalFilePage(tab: BrowserTabSnapshot): BrowserTabSnapshot {
  if (isLocalFileTab(tab)) {
    throw new BrowserAutomationError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
  }
  return tab;
}

function redactLocalFileTab<T extends BrowserTabSnapshot | undefined>(tab: T): T {
  if (tab === undefined || !isLocalFileTab(tab)) return tab;
  return { ...tab, url: '', urlTruncated: undefined, title: '', ...(tab.error === undefined ? {} : { error: 'Navigation failed.' }) };
}

async function requirePageTab(tabId: string, signal?: AbortSignal): Promise<BrowserTabSnapshot> {
  return refuseLocalFilePage(await requireTab(tabId, signal));
}

async function requireReadablePageTab(tabId: string, signal?: AbortSignal): Promise<BrowserTabSnapshot> {
  const tab = await requirePageTab(tabId, signal);
  if (hasBlockingBrowserDialog(tab.browserId)) refuseBlockedPage(tab);
  if (isBrowserAnnotationPicking(tab.browserId)) throw new BrowserAutomationError('PAGE_NOT_READY', 'The user is selecting a browser annotation. Retry after selection finishes.');
  if (tab.url === '' || tab.error !== undefined) throw new BrowserAutomationError('PAGE_NOT_READY', tab.error ?? 'Browser tab has no loaded page.');
  return tab;
}

async function requireActivePageTab(tabId: string, signal?: AbortSignal): Promise<BrowserTabSnapshot> {
  const tab = await requireControlledTab(tabId, signal);
  if (tab.url === '' || tab.error !== undefined) {
    throw new BrowserAutomationError('PAGE_NOT_READY', tab.error ?? 'Browser tab has no loaded page.');
  }
  await browserPageDialogControlReady(tab.browserId).catch((error: unknown) => {
    throw new BrowserAutomationError('BROWSER_UNAVAILABLE', `The browser could not take over the page's file chooser, so the input was not sent (a click could otherwise open a system file picker outside the browser tool). Retry the action; if it keeps failing, reload the tab. ${error instanceof Error ? error.message : String(error)}`);
  });
  return tab;
}

function validateControl(
  tab: BrowserTabSnapshot,
  signal: AbortSignal | undefined,
  require: (tabId: string, signal?: AbortSignal) => Promise<BrowserTabSnapshot>,
): () => Promise<void> {
  const lease = controlLeases.get(tab);
  return async () => {
    const current = await require(tab.tabId, signal);
    if (current.browserId !== tab.browserId || controlLeases.get(current) !== lease) {
      throw new BrowserAutomationError('TAB_NOT_ACTIVE', 'Browser control changed; request a new operation under the current control.');
    }
  };
}

function validateInputControl(tab: BrowserTabSnapshot, signal?: AbortSignal): () => Promise<void> {
  return validateControl(tab, signal, requireActivePageTab);
}

function validateNavigationControl(tab: BrowserTabSnapshot, signal?: AbortSignal): () => Promise<void> {
  return validateControl(tab, signal, requireControlledTab);
}

interface NavigationTarget {
  url: string;
  search?: { engine: BrowserSearchEngine };
}

export function isAgentLocalFileAddress(url: string): boolean {
  return agentLocalFilesEnabled() && localFileAddressUrl(url) !== null;
}

async function opensLocalFile(url: string, validate: () => Promise<void>): Promise<boolean> {
  if (!isAgentLocalFileAddress(url)) return false;
  if (!(await browserLocalPagesAllowed())) throw new Error('browser-navigate: local pages need a build with file:// privileges turned off');
  await validate();
  return true;
}

function searchTarget(query: string): NavigationTarget {
  const engine = getBrowserData().preferences.searchEngine;
  const url = browserSearchUrl(query.trim(), engine);
  if (url.length > BROWSER_STATE_URL_MAX) {
    throw new BrowserAutomationError('INVALID_REQUEST', `query is too long for a ${BROWSER_SEARCH_ENGINES[engine].name} results URL; shorten it.`);
  }
  return { url, search: { engine } };
}

function success(operation: BrowserOperation, fields: Omit<BrowserRunResult, 'ok' | 'operation'> = {}): BrowserRunResult {
  const browser = fields.browser === undefined ? undefined : { ...fields.browser, tabs: fields.browser.tabs.map((tab) => redactLocalFileTab(tab)) };
  const tab = redactLocalFileTab(fields.tab);
  return { ok: true, operation, ...fields, ...(browser === undefined ? {} : { browser }), ...(tab === undefined ? {} : { tab }) };
}

function failure(operation: BrowserOperation, error: unknown): BrowserRunResult {
  if (error instanceof BrowserWaitError) return { ok: false, operation, error: { code: error.code, message: error.message, lastObserved: error.lastObserved } };
  if (error instanceof BrowserAutomationError || error instanceof BrowserControlError || error instanceof BrowserReadError) {
    return { ok: false, operation, error: { code: error.code, message: error.message } };
  }
  if (error instanceof BrowserPageError || error instanceof BrowserInputError) {
    return { ok: false, operation, error: { code: error.code, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  const code: BrowserErrorCode =
    /timed out/i.test(message) ? 'WAIT_TIMEOUT' :
    /aborted/i.test(message) ? 'OPERATION_ABORTED' :
    /failed to load|navigation/i.test(message) ? 'NAVIGATION_FAILED' :
    'INTERNAL_ERROR';
  return { ok: false, operation, error: { code, message } };
}

export function runBrowserAutomation(
  request: BrowserRunRequest,
  signal?: AbortSignal,
  sessionId?: string,
  run?: DesktopBrowserSubagentRun,
): Promise<BrowserRunResult> {
  return requestSession.run({ sessionId, run }, () => executeBrowserAutomation(request, signal));
}

export async function browserTakeoverRefusal(
  request: BrowserRunRequest,
  sessionId: string,
  run?: BrowserSubagentRun,
  signal?: AbortSignal,
): Promise<BrowserRunResult | undefined> {
  if (!browserControlOwnership.isTakenOver(sessionId, run)) return undefined;
  if (run === undefined) {
    try {
      await requestSession.run({ sessionId }, () => requestBrowserUi({ action: 'get_state' }, signal, true));
    } catch {
      return undefined;
    }
    if (!browserControlOwnership.isTakenOver(sessionId)) return undefined;
  }
  return failure(request.operation, browserUserTakeoverError());
}

export function fitPendingDialog(dialog: BrowserPendingDialog, room: number): BrowserPendingDialog | null {
  const size = (item: BrowserPendingDialog) => JSON.stringify(item).length + 1;
  if (size(dialog) <= room) return dialog;
  const shown: BrowserPendingDialog = { ...dialog };
  const longest = Math.max(dialog.accept?.length ?? 0, dialog.files?.length ?? 0);
  for (let keep = longest - 1; keep >= 0 && size(shown) > room; keep--) {
    for (const field of ['accept', 'files'] as const) {
      const list = dialog[field];
      if (list !== undefined && list.length > keep) shown[field] = [...list.slice(0, keep), `…${list.length - keep} more`];
    }
  }
  for (const field of ['message', 'target', 'origin'] as const) {
    let value = shown[field];
    while (value !== undefined && value.length > 0 && size(shown) > room) {
      const text = value.endsWith('…') ? value.slice(0, -1) : value;
      value = text.slice(0, Math.max(0, text.length - (size(shown) - room) - 1));
      value = value.length > 0 ? `${value}…` : '';
      shown[field] = value;
    }
  }
  return size(shown) <= room ? shown : null;
}

async function withBrowserEvents(result: BrowserRunResult, browserId: string | undefined): Promise<BrowserRunResult> {
  const listing = result.operation === 'page.dialog.get';
  if (!listing && !hasPendingBrowserEvents()) return result;
  const tabs = new Map<string, string>();
  try {
    const ui = await requestBrowserUi({ action: 'get_state' }, undefined, true);
    for (const tab of ui.tabs) tabs.set(tab.browserId, tab.tabId);
  } catch {}
  for (const tab of result.browser?.tabs ?? []) tabs.set(tab.browserId, tab.tabId);
  if (result.tab !== undefined) tabs.set(result.tab.browserId, result.tab.tabId);
  const browserIds = new Set([...tabs.keys(), ...(browserId === undefined ? [] : [browserId])]);
  const limit = result.text?.maxChars ?? result.elements?.maxChars;
  let room = limit === undefined ? EVENT_OUTPUT_MAX : Math.min(EVENT_OUTPUT_MAX, Math.max(EVENT_OUTPUT_MIN, limit - formatBrowserToolResult(result).length));
  const fits = (item: unknown, force = false): boolean => {
    const size = JSON.stringify(item).length + 1;
    if (!force && size > room) return false;
    room -= size;
    return true;
  };
  const allPending = listPendingBrowserDialogs(tabs);
  const pendingDialogs: BrowserPendingDialog[] = [];
  const reserved = Math.floor(room / 2);
  room -= reserved;
  for (const dialog of allPending) {
    const shown = pendingDialogs.length === 0 ? fitPendingDialog(dialog, room) : dialog;
    if (shown === null || !fits(shown)) break;
    pendingDialogs.push(shown);
  }
  room = Math.max(0, room) + reserved;
  const notices = [...(result.notices ?? []), ...[...browserIds].flatMap(id => takeBrowserNotices(id, fits))];
  const handledDialogs = [...browserIds].flatMap(id => takeBrowserDialogRecords(id, fits)).sort((a, b) => a.settledAt - b.settledAt);
  if (pendingDialogs.length < allPending.length) notices.push(`${allPending.length - pendingDialogs.length} more pending dialogs are not shown; answer the listed ones first or call page.dialog.get.`);
  if ([...browserIds].some(hasQueuedBrowserEvents)) notices.push('More browser events are queued and will be reported with the next browser result.');
  return {
    ...result,
    ...(pendingDialogs.length > 0 || listing ? { pendingDialogs } : {}),
    ...(handledDialogs.length > 0 ? { handledDialogs } : {}),
    ...(notices.length > 0 ? { notices } : {}),
  };
}

export interface BrowserDialogReminder {
  tabs: { tabId: string; title: string; url: string }[];
  pendingDialogs: BrowserPendingDialog[];
  handledDialogs: (BrowserDialogRecord & { tabId: string })[];
  more: boolean;
}

export async function collectBrowserDialogReminder(sessionId: string): Promise<BrowserDialogReminder | undefined> {
  if (!hasBrowserDialogReminder()) return undefined;
  let ui: BrowserUiState;
  try {
    ui = await requestSession.run({ sessionId }, () => requestBrowserUi({ action: 'get_state' }, undefined, true));
  } catch {
    return undefined;
  }
  const tabs = new Map(ui.tabs.map(tab => [tab.browserId, tab.tabId]));
  if (tabs.size === 0) return undefined;
  let used = 0;
  let pendingRoom = Math.floor(EVENT_OUTPUT_MAX / 2);
  let handledRoom: number | undefined;
  const taken = takeBrowserDialogReminder(tabs, {
    pending: (dialog) => {
      const shown = used === 0 ? fitPendingDialog(dialog, pendingRoom) : dialog;
      const size = shown === null ? Infinity : JSON.stringify(shown).length + 1;
      if (size > pendingRoom) return null;
      pendingRoom -= size;
      used += size;
      return shown;
    },
    handled: (record) => {
      handledRoom ??= EVENT_OUTPUT_MAX - used;
      const size = JSON.stringify(record).length + 1;
      if (size > handledRoom) return false;
      handledRoom -= size;
      return true;
    },
  });
  if (taken.pendingDialogs.length === 0 && taken.handledDialogs.length === 0) return undefined;
  const states = new Map(listBrowserStates().map(entry => [entry.browserId, entry.state]));
  const shown = new Set([...taken.pendingDialogs, ...taken.handledDialogs].map(item => item.tabId));
  return {
    ...taken,
    tabs: [...tabs].filter(([, tabId]) => shown.has(tabId)).map(([browserId, tabId]) => {
      const state = states.get(browserId);
      return { tabId, title: (state?.title ?? '').slice(0, 200), url: (state?.url ?? '').slice(0, 512) };
    }),
  };
}

export function forgetSessionBrowserDialogs(sessionId: string): void {
  forgetBrowserDialogSession(listBrowserStates().map(entry => entry.browserId).filter(browserId => browserControlOwnership.sessionFor(browserId) === sessionId));
}

function interruptedByDialog(operation: BrowserOperation, dialog: BrowserPageDialog): BrowserRunResult {
  return {
    ok: true, operation,
    notices: [`The page opened ${dialog.kind === 'alert' ? 'an' : 'a'} ${dialog.kind} dialog (dialogId ${dialog.dialogId}) during this operation and is waiting for an answer. Answer it with page.dialog.respond before other page operations. This operation may still be applied, fully or partly, once the dialog is answered; read the page state again before retrying it.`],
  };
}

async function executeBrowserAutomation(request: BrowserRunRequest, signal?: AbortSignal): Promise<BrowserRunResult> {
  let activity: BrowserActivityHandle | undefined;
  let browserId: string | undefined;
  let offDialog: (() => void) | undefined;
  let interrupt: ((dialog: BrowserPageDialog) => void) | undefined;
  const interrupted = new Promise<BrowserPageDialog>(resolve => { interrupt = resolve; });
  const stop = new AbortController();
  const operationSignal = signal === undefined ? stop.signal : AbortSignal.any([signal, stop.signal]);
  try {
    const work = withBrowserReceipt(requestSession.getStore()?.sessionId, () => dispatchBrowserAutomation(request, operationSignal, (id) => {
      browserId = id;
      if (offDialog === undefined && !request.operation.startsWith('page.dialog.')) {
        offDialog = onBrowserDialogOpened(id, dialog => { if (blockingBrowserDialogs(id).some(item => item.dialogId === dialog.dialogId)) interrupt?.(dialog); });
      }
      if (browserOperationActs(request.operation)) notifyBrowserAgentAction(id);
      const kind = browserActivityFor(request.operation);
      if (kind !== undefined && activity === undefined) activity = beginBrowserActivity(id, kind);
      return activity;
    }));
    const outcome = await Promise.race([work.then(done => ({ done })), interrupted.then(dialog => ({ dialog }))]);
    if ('dialog' in outcome) {
      stop.abort();
      work.catch(() => {});
      return await withBrowserEvents(interruptedByDialog(request.operation, outcome.dialog), browserId);
    }
    const { value, receiptId } = outcome.done;
    return await withBrowserEvents(receiptId === undefined ? value : { ...value, receipt: receiptId }, browserId);
  } finally {
    offDialog?.();
    activity?.end();
  }
}

async function respondPageDialog(request: Extract<BrowserRunRequest, { operation: 'page.dialog.respond' }>, tab: BrowserTabSnapshot, signal?: AbortSignal): Promise<BrowserPageDialog> {
  const dialog = getBrowserDialog(request.dialogId);
  if (dialog === undefined || dialog.browserId !== tab.browserId || dialog.kind === 'download') {
    throw new BrowserAutomationError('DIALOG_NOT_FOUND', `Dialog "${request.dialogId}" is not pending in this tab. Call page.dialog.get for the current dialogs.`);
  }
  if (dialog.kind === 'upload') {
    throw new BrowserAutomationError('WAITING_FOR_USER', 'Only the user can approve an upload. It is shown to the user; check page.dialog.get later.', true);
  }
  if (request.text !== undefined && dialog.kind !== 'prompt') throw new BrowserAutomationError('INVALID_REQUEST', 'text only applies to prompt dialogs.');
  let files: string[] | undefined;
  if (dialog.kind === 'file' && request.accept) {
    if (request.files === undefined) throw new BrowserAutomationError('INVALID_REQUEST', 'files is required to accept a file dialog.');
    if (dialog.multiple !== true && request.files.length > 1) throw new BrowserAutomationError('INVALID_REQUEST', 'This file input accepts one file; send a single path in files.');
    const context = requestSession.getStore();
    const validate = validateControl(tab, signal, requirePageTab);
    const decisions = await Promise.all(request.files.map(path => fileUploadNeedsApproval(path, {
      workspaceRoot: context?.workspaceRoot, downloadsDirectory: browserDownloadsDirectory(), permissionMode: context?.permissionMode,
    })));
    const paths: string[] = [];
    for (const decision of decisions) {
      if (!decision.ok) throw new BrowserAutomationError('INVALID_REQUEST', `Cannot upload: ${decision.reason}`);
      paths.push(decision.path);
    }
    await validate();
    if (decisions.some(decision => decision.ok && decision.needsApproval)) {
      const approvalId = openBrowserDialog({
        browserId: tab.browserId, kind: 'upload', origin: dialog.origin, files: paths, parentDialogId: dialog.dialogId, userOnly: true, timeoutMs: UPLOAD_APPROVAL_TIMEOUT_MS,
        onAnswer: async (answer) => {
          if (answer?.accept === true) {
            if (await respondBrowserDialog(dialog.dialogId, { accept: true, files: paths }, 'agent') !== 'answered') throw new Error('the file dialog closed before the approved files could be attached');
          } else if (answer?.accept === false) await respondBrowserDialog(dialog.dialogId, { accept: false }, 'user');
        },
      });
      if (approvalId === null) throw new BrowserAutomationError('DIALOG_NOT_FOUND', `Dialog "${request.dialogId}" is no longer pending, so the upload was not requested. Call page.dialog.get for the current dialogs.`);
      throw new BrowserAutomationError('WAITING_FOR_USER', `Uploading ${summarizeUploadPaths(paths)} to ${dialog.origin || 'this page'} needs the user's approval because the files are outside the workspace and Downloads. The request is shown to the user; the files are attached automatically if they allow it. Check page.dialog.get or the page later instead of retrying.`, true);
    }
    files = paths;
  }
  const outcome = await respondBrowserDialog(dialog.dialogId, { accept: request.accept, ...(files === undefined ? {} : { files }), ...(request.text === undefined || !request.accept ? {} : { text: request.text }) }, 'agent');
  if (outcome !== 'answered') throw new BrowserAutomationError('DIALOG_NOT_FOUND', `Dialog "${request.dialogId}" is no longer pending. Call page.dialog.get for the current dialogs.`);
  return dialog;
}

function summarizeUploadPaths(paths: readonly string[]): string {
  const shown = paths.slice(0, 3).map(path => path.length > 200 ? `${path.slice(0, 199)}…` : path).map(path => JSON.stringify(path)).join(', ');
  return paths.length > 3 ? `${paths.length} files (${shown}, and ${paths.length - 3} more)` : shown;
}

async function dispatchBrowserAutomation(
  request: BrowserRunRequest,
  signal: AbortSignal | undefined,
  announce: (browserId: string) => BrowserActivityHandle | undefined,
): Promise<BrowserRunResult> {
  const operation = request.operation;
  try {
    if (request.protocol !== BROWSER_AUTOMATION_PROTOCOL) {
      throw new BrowserAutomationError('INVALID_REQUEST', 'Unsupported Browser protocol version.');
    }
    const context = requestSession.getStore();
    if (context?.sessionId) {
      const ui = await requestBrowserUi({ action: 'get_state' }, signal, true);
      context.workspaceRoot = ui.workspaceRoot;
      context.permissionMode = ui.permissionMode;
      context.revision = browserControlOwnership.revision(context.sessionId, context.run?.run);
      browserControlOwnership.assertAllowed(context.sessionId, context.revision, context.run?.run);
    }
    switch (operation) {
      case 'browser.get_history':
        return success(operation, { history: getBrowserData().history.filter(entry => agentLocalFilesEnabled() || !/^file:/i.test(entry.url)).map(({ favicon: _favicon, ...entry }) => entry) });
      case 'browser.get_downloads':
        return success(operation, { downloads: getBrowserDownloads() });
      case 'browser.get_device_profiles':
        return success(operation, {
          deviceProfiles: BROWSER_DEVICE_PROFILES.map(profile => ({
            profileId: profile.id,
            width: profile.mobile ? profile.width : profile.height,
            height: profile.mobile ? profile.height : profile.width,
            deviceScaleFactor: profile.deviceScaleFactor,
            mobile: profile.mobile,
            touch: profile.touch,
            orientation: profile.mobile ? 'portrait' : 'landscape',
          })),
        });
      case 'tab.set_device_mode': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        restoreBrowser(tab.browserId);
        await updateBrowserDeviceMode(tab.browserId, request.device, { signal, validate: validateInputControl(tab, signal) });
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'browser.get_state':
        return success(operation, { browser: await browserSnapshot(signal) });
      case 'browser.activate_panel': {
        const ui = await requestBrowserUi({ action: 'get_state' }, signal);
        const snapshot = joinBrowserSnapshot(ui);
        const shown = snapshot.tabs.find(tab => tab.tabId === ui.activeTabId) ?? snapshot.tabs.at(-1);
        if (shown !== undefined && isLocalFileTab(shown)) throw new BrowserAutomationError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
        const next = await requestBrowserUi({ action: 'activate_panel' }, signal);
        return success(operation, { browser: joinBrowserSnapshot(next) });
      }
      case 'browser.create_tab': {
        const target: NavigationTarget | undefined = request.query !== undefined ? searchTarget(request.query) : request.url === undefined ? undefined : { url: request.url };
        const ui = await requestBrowserUi({ action: 'create_tab' }, signal);
        const tabId = ui.controlledTabId;
        if (tabId === null) throw new BrowserAutomationError('INTERNAL_ERROR', 'Browser tab was not created.');
        let tab = joinBrowserSnapshot(ui).tabs.find((candidate) => candidate.tabId === tabId);
        if (tab === undefined) throw new BrowserAutomationError('INTERNAL_ERROR', 'Created Browser tab is missing.');
        if (target !== undefined) {
          announce(tab.browserId);
          const validate = validateNavigationControl(tab, signal);
          const state = await navigateBrowser(tab.browserId, target.url, { validate, localFile: await opensLocalFile(target.url, validate) });
          if (state.error !== undefined) throw new BrowserAutomationError('NAVIGATION_FAILED', state.error);
          tab = await updatedTab(tabId, signal);
        }
        const browser = await browserSnapshot(signal);
        return success(operation, {
          tab,
          browser,
          notices: [
            '<system-reminder>You can later use browser.close_tab to close unused browser tabs that you created yourself. Do not close tabs created by the user or any other source.</system-reminder>',
            ...(browser.tabs.length > 5 ? [`<system-reminder>There are ${browser.tabs.length} open browser tabs. Consider closing unused tabs that you created yourself with browser.close_tab. Do not close tabs created by the user or any other source.</system-reminder>`] : []),
            ...(browser.tabs.length > 10 ? [`<system-reminder>There are ${browser.tabs.length} open browser tabs. Inform the user that more than ten tabs make the right sidebar crowded. Consider closing unused tabs that you created yourself with browser.close_tab. Do not close tabs created by the user or any other source.</system-reminder>`] : []),
          ],
          ...(target?.search && { search: target.search }),
        });
      }
      case 'browser.release_tab': {
        const tab = await requireControlledTab(request.tabId, signal, true);
        const ui = await requestBrowserUi({ action: 'release_tab', tabId: request.tabId, expectedLeaseId: controlLeases.get(tab)! }, signal);
        return success(operation, { browser: joinBrowserSnapshot(ui) });
      }
      case 'browser.activate_tab':
      case 'browser.switch_tab': {
        await requirePageTab(request.tabId, signal);
        const ui = await requestBrowserUi({ action: operation === 'browser.switch_tab' ? 'switch_tab' : 'activate_tab', tabId: request.tabId }, signal);
        const browser = joinBrowserSnapshot(ui);
        const tab = browser.tabs.find((candidate) => candidate.tabId === request.tabId);
        if (tab === undefined) throw new BrowserAutomationError('TAB_NOT_FOUND', `Browser tab "${request.tabId}" does not exist.`);
        return success(operation, { browser, tab });
      }
      case 'browser.close_tab': {
        const tab = await requireControlledTab(request.tabId, signal, true);
        announce(tab.browserId);
        const release = browserControlOwnership.expectAgentClose(tab.browserId);
        try {
          const ui = await requestBrowserUi({ action: 'close_tab', tabId: request.tabId, expectedLeaseId: controlLeases.get(tab)! }, signal);
          return success(operation, { browser: joinBrowserSnapshot(ui) });
        } finally {
          release();
        }
      }
      case 'tab.get_state':
        return success(operation, { tab: await requireTab(request.tabId, signal) });
      case 'tab.navigate':
      case 'tab.search': {
        const tab = await requireControlledTab(request.tabId, signal);
        const target: NavigationTarget = request.operation === 'tab.search' ? searchTarget(request.query) : { url: request.url };
        announce(tab.browserId);
        let cancelled = false;
        const validate = validateNavigationControl(tab, signal);
        await navigateBrowser(tab.browserId, target.url, {
          validate,
          localFile: await opensLocalFile(target.url, validate),
          onCancelled: () => { cancelled = true; },
        });
        if (cancelled) {
          throw new BrowserAutomationError('NAVIGATION_FAILED', LEAVE_PENDING_MESSAGE);
        }
        const updated = await updatedTab(request.tabId, signal);
        if (updated.error !== undefined) {
          throw new BrowserAutomationError('NAVIGATION_FAILED', updated.error);
        }
        return success(operation, { tab: updated, ...(target.search && { search: target.search }) });
      }
      case 'tab.go_back': {
        const tab = await requireControlledTab(request.tabId, signal);
        announce(tab.browserId);
        if (!tab.canGoBack) throw new BrowserAutomationError('CANNOT_GO_BACK', 'Browser tab has no previous history entry.');
        if (!agentLocalFilesEnabled() && browserHistoryTargetIsLocalFile(tab.browserId, -1)) throw new BrowserAutomationError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
        await historyNavigation(tab.browserId, 'back', signal);
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'tab.go_forward': {
        const tab = await requireControlledTab(request.tabId, signal);
        announce(tab.browserId);
        if (!tab.canGoForward) throw new BrowserAutomationError('CANNOT_GO_FORWARD', 'Browser tab has no next history entry.');
        if (!agentLocalFilesEnabled() && browserHistoryTargetIsLocalFile(tab.browserId, 1)) throw new BrowserAutomationError('LOCAL_FILE_PAGE', BROWSER_LOCAL_FILE_REFUSAL);
        await historyNavigation(tab.browserId, 'forward', signal);
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'tab.reload': {
        const tab = await requireControlledTab(request.tabId, signal);
        announce(tab.browserId);
        if (tab.url === '') throw new BrowserAutomationError('PAGE_NOT_READY', 'Browser tab has no page to reload.');
        await historyNavigation(tab.browserId, 'reload', signal);
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'tab.stop_loading': {
        const tab = await requireControlledTab(request.tabId, signal);
        announce(tab.browserId);
        browserStopLoading(tab.browserId);
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'tab.wait_for_load': {
        const tab = await requirePageTab(request.tabId, signal);
        refuseBlockedPage(tab);
        announce(tab.browserId);
        try {
          await waitForBrowserLoad(tab.browserId, request.state, request.timeoutMs ?? 15_000, signal);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          if (/timed out/i.test(message)) throw new BrowserAutomationError('WAIT_TIMEOUT', message);
          if (/aborted/i.test(message)) throw new BrowserAutomationError('OPERATION_ABORTED', message);
          throw new BrowserAutomationError('NAVIGATION_FAILED', message);
        }
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.visual.crop': {
        const tab = await requirePageTab(request.tabId, signal);
        announce(tab.browserId);
        return success(operation, { crop: cropBrowserScreenshot(tab.browserId, request) });
      }
      case 'page.visual.snapshot': {
        const tab = await requireReadablePageTab(request.tabId, signal);
        announce(tab.browserId);
        return success(operation, { tab, visual: await captureBrowserVisual(tab.browserId, signal) });
      }
      case 'page.visual.click_if_interactive': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        const click = await clickBrowserVisualIfInteractive(tab.browserId, request, signal, validateInputControl(tab, signal));
        return success(operation, { tab: await updatedTab(request.tabId, signal), click });
      }
      case 'page.visual.click': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        await clickBrowserVisual(tab.browserId, request, signal, validateInputControl(tab, signal));
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.visual.hover': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        await hoverBrowserVisual(tab.browserId, request, signal, validateInputControl(tab, signal));
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.visual.scroll': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        await scrollBrowserVisual(tab.browserId, request, signal, validateInputControl(tab, signal));
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.visual.drag': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        await dragBrowserVisual(tab.browserId, request, signal, validateInputControl(tab, signal));
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.visual.drag_path': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        await dragPathBrowserVisual(tab.browserId, request, signal, validateInputControl(tab, signal));
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.visual.type_text': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        await typeBrowserVisual(tab.browserId, request, signal, validateInputControl(tab, signal));
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.visual.press_key': {
        const tab = await requireActivePageTab(request.tabId, signal);
        announce(tab.browserId);
        await pressBrowserVisual(tab.browserId, request, signal, validateInputControl(tab, signal));
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.wait_for': {
        const tab = await requirePageTab(request.tabId, signal);
        refuseBlockedPage(tab);
        announce(tab.browserId);
        const wait = await waitForBrowserCondition(tab.browserId, request, signal, async waitSignal => {
          const current = await requirePageTab(request.tabId, waitSignal);
          if (current.browserId !== tab.browserId) throw new BrowserAutomationError('TAB_NOT_FOUND', 'Browser tab was replaced while waiting.');
        });
        return success(operation, { wait });
      }
      case 'page.text.snapshot': {
        const tab = await requireReadablePageTab(request.tabId, signal);
        announce(tab.browserId);
        return success(operation, { text: await readBrowserText(tab.browserId, request) });
      }
      case 'page.elements.snapshot': {
        const tab = await requireReadablePageTab(request.tabId, signal);
        announce(tab.browserId);
        return success(operation, { elements: await readBrowserElements(tab.browserId, request) });
      }
      case 'page.element.click':
      case 'page.element.hover':
      case 'page.element.fill':
      case 'page.element.type_text':
      case 'page.element.press_key':
      case 'page.element.select_option':
      case 'page.element.set_checked':
      case 'page.element.scroll_into_view': {
        const tab = await requireActivePageTab(request.tabId, signal);
        const activity = announce(tab.browserId);
        await runBrowserElementAction(tab.browserId, request, signal, validateInputControl(tab, signal), activity?.target);
        return success(operation, { tab: await updatedTab(request.tabId, signal) });
      }
      case 'page.dialog.get': {
        const tab = await requirePageTab(request.tabId, signal);
        announce(tab.browserId);
        return success(operation, { tab });
      }
      case 'page.dialog.respond': {
        const tab = await requirePageTab(request.tabId, signal);
        if (!tab.active || controlLeases.get(tab) === undefined) {
          throw new BrowserAutomationError('TAB_NOT_ACTIVE', 'Select this tab for control with browser.activate_tab first. This does not change the visible tab.');
        }
        announce(tab.browserId);
        const dialog = await respondPageDialog(request, tab, signal);
        return success(operation, { dialog: { dialogId: dialog.dialogId, kind: dialog.kind, outcome: request.accept || dialog.kind === 'alert' ? 'accepted' : 'dismissed' }, tab: await updatedTab(request.tabId, signal) });
      }
    }
  } catch (error) {
    return failure(operation, error);
  }
}

export function browserAutomationGeneration(browserId: string): number | null {
  return getBrowserGeneration(browserId);
}

export function browserAutomationState(browserId: string) {
  return getBrowserState(browserId);
}
