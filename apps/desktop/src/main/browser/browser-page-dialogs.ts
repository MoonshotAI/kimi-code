import { dialog, type BaseWindow, type OpenDialogOptions, type WebContents } from 'electron';
import { randomUUID } from 'node:crypto';
import { BROWSER_ANNOTATION_WORLD } from './browser-annotation-script';
import { ensureBrowserDebugger } from './browser-debugger';
import { discardBrowserDialogs, openBrowserDialog, pushAgentBrowserNotice } from './browser-dialogs';
import { log } from '../diagnostics/log';

interface RunDialogInfo {
  frame?: { origin?: string; url?: string } | null;
  dialogType?: string;
  messageText?: string;
  defaultPromptText?: string;
}

type RunDialogCallback = (accept: boolean, text: string) => void;

export interface BrowserNavigationPostData {
  bytes: Buffer;
  contentType?: string;
}

export interface BrowserPageDialogOptions {
  browserId: string;
  isAgentControlled: () => boolean;
  host: () => BaseWindow | null;
  onNavigationRequested?: (url: string, reason: string, postData?: BrowserNavigationPostData) => void;
  interceptPost?: (url: string, post: boolean) => boolean;
}

const PAUSED_DOCUMENTS = { patterns: [{ resourceType: 'Document', requestStage: 'Request' }] };

interface PageHooks {
  options: BrowserPageDialogOptions;
  applied: boolean;
  syncing: Promise<void>;
  mainFrameId: string | undefined;
  initialized: boolean;
  initializing: Promise<void> | undefined;
  generation: number;
  pending: number;
  enabling: boolean;
  holdUntil: number;
}

const FILE_DIALOG_TIMEOUT_MS = 10 * 60_000;
const USER_INPUT_HOLD_MS = 2_000;
const PRINT_MARKER = `kimi-print-blocked-${randomUUID()}`;
const PRINT_GUARD = `(() => { const debug = console.debug.bind(console); const print = function print() { debug(${JSON.stringify(PRINT_MARKER)}); }; for (const target of [window, Window.prototype]) { try { Object.defineProperty(target, 'print', { value: print, writable: false, configurable: false, enumerable: true }); } catch {} } })()`;
const PROMPT_RESTORE = `(() => { if (typeof window.prompt === 'function' && window.prompt.name === 'prompt') return; try { const frame = document.createElement('iframe'); (document.documentElement || document).appendChild(frame); const native = frame.contentWindow.prompt; frame.remove(); if (typeof native !== 'function') return; const prompt = native.bind(window); Object.defineProperty(prompt, 'name', { value: 'prompt' }); Object.defineProperty(window, 'prompt', { value: prompt, writable: true, configurable: true, enumerable: true }); } catch {} })()`;
const PAGE_GUARDS = `${PRINT_GUARD};${PROMPT_RESTORE}`;
const installed = new Map<WebContents, PageHooks>();

export function browserPageOrigin(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin === 'null' ? `${parsed.protocol}//` : parsed.origin;
  } catch {
    return '';
  }
}

function send(contents: WebContents, method: string, params?: Record<string, unknown>): Promise<unknown> {
  if (contents.isDestroyed() || !contents.debugger.isAttached()) return Promise.reject(new Error('Browser debugger is not attached'));
  return contents.debugger.sendCommand(method, params);
}

function handleRunDialog(contents: WebContents, state: PageHooks, info: RunDialogInfo, callback: RunDialogCallback): void {
  const kind = info.dialogType;
  const origin = info.frame?.origin || browserPageOrigin(info.frame?.url ?? contents.getURL());
  if (kind !== 'alert' && kind !== 'confirm' && kind !== 'prompt') {
    callback(false, '');
    return;
  }
  const defaultValue = kind === 'prompt' ? info.defaultPromptText ?? '' : undefined;
  const id = openBrowserDialog({
    browserId: state.options.browserId, kind, origin, owner: contents, message: info.messageText ?? '', defaultValue,
    onAnswer: (answer) => {
      if (answer === null || contents.isDestroyed()) return;
      if (kind !== 'prompt') {
        callback(kind === 'confirm' ? answer.accept : true, '');
        return;
      }
      const text = answer.accept ? answer.text ?? defaultValue ?? '' : undefined;
      callback(answer.accept, text ?? '');
      return text === undefined ? answer : { ...answer, text };
    },
  });
  if (id === null) callback(false, '');
}

async function callOnFileInput(contents: WebContents, backendNodeId: number, functionDeclaration: string, userGesture = false): Promise<unknown> {
  const resolved = await send(contents, 'DOM.resolveNode', { backendNodeId }) as { object?: { objectId?: string } };
  const objectId = resolved.object?.objectId;
  if (objectId === undefined) return undefined;
  try {
    const result = await send(contents, 'Runtime.callFunctionOn', { objectId, returnByValue: true, functionDeclaration, ...(userGesture ? { userGesture } : {}) }) as { result?: { value?: unknown } };
    return result.result?.value;
  } finally {
    void send(contents, 'Runtime.releaseObject', { objectId }).catch(() => {});
  }
}

const FILE_ACCEPT_CHARS_MAX = 4096;
const FILE_ACCEPT_ITEMS_MAX = 64;

async function describeFileInput(contents: WebContents, backendNodeId: number): Promise<{ accept: string[]; directory: boolean } | null> {
  const value = await callOnFileInput(contents, backendNodeId, `function () { return { accept: String(this.accept || "").slice(0, ${FILE_ACCEPT_CHARS_MAX}), directory: this.webkitdirectory === true }; }`) as { accept?: unknown; directory?: unknown } | undefined;
  if (typeof value !== 'object' || value === null) return null;
  const accept = typeof value?.accept === 'string' ? value.accept.slice(0, FILE_ACCEPT_CHARS_MAX).split(',', FILE_ACCEPT_ITEMS_MAX).map(item => item.trim()).filter(Boolean) : [];
  return { accept, directory: value?.directory === true };
}

function cancelFileInput(contents: WebContents, backendNodeId: number): void {
  if (contents.isDestroyed()) return;
  void callOnFileInput(contents, backendNodeId, 'function () { this.dispatchEvent(new Event("cancel", { bubbles: true })); }').catch(() => {});
}

export function browserFileFilters(accept: readonly string[]): OpenDialogOptions['filters'] {
  const extensions = [...new Set(accept.filter(item => /^\.[A-Za-z0-9_+-]{1,32}$/.test(item)).map(item => item.slice(1).toLowerCase()))];
  return extensions.length === 0 ? undefined : [{ name: extensions.join(', '), extensions }, { name: '*', extensions: ['*'] }];
}

const SHOW_NATIVE_PICKER = 'function () { try { this.showPicker(); return true; } catch { return false; } }';

async function reopenForUser(contents: WebContents, backendNodeId: number): Promise<void> {
  const opened = await callOnFileInput(contents, backendNodeId, SHOW_NATIVE_PICKER, true).catch(() => false);
  if (opened !== true) cancelFileInput(contents, backendNodeId);
}

const STALE_FILE_INPUT = 'The page changed before the files could be attached, so nothing was uploaded.';

async function chooseFilesForUser(state: PageHooks, accept: readonly string[], multiple: boolean): Promise<string[]> {
  const host = state.options.host();
  const options: OpenDialogOptions = { properties: multiple ? ['openFile', 'multiSelections'] : ['openFile'], filters: browserFileFilters(accept) };
  const result = host !== null && !host.isDestroyed() && host.isVisible() ? await dialog.showOpenDialog(host, options) : await dialog.showOpenDialog(options);
  return result.canceled ? [] : result.filePaths;
}

const HANDBACK_PICKER_CANCELLED = 'The file picker this page opened was cancelled because the built-in browser was still handing control back to you. Try again.';
const HANDBACK_RETRY_MS = [100, 500];

async function chooseInterceptedForUser(contents: WebContents, state: PageHooks, backendNodeId: number, multiple: boolean, stale: () => boolean, origin: string): Promise<void> {
  const input = await describeFileInput(contents, backendNodeId).catch(() => null);
  if (input === null || input.directory || stale()) {
    cancelFileInput(contents, backendNodeId);
    if (!stale()) openBrowserDialog({ browserId: state.options.browserId, kind: 'alert', origin, owner: contents, userOnly: true, message: HANDBACK_PICKER_CANCELLED, onAnswer: () => {} });
    return;
  }
  const files = await chooseFilesForUser(state, input.accept, multiple);
  if (stale() || files.length === 0) {
    cancelFileInput(contents, backendNodeId);
    return;
  }
  await send(contents, 'DOM.setFileInputFiles', { files: multiple ? files : files.slice(0, 1), backendNodeId }).catch(() => cancelFileInput(contents, backendNodeId));
}

interface FrameTreeNode {
  frame?: { id?: unknown; url?: unknown; securityOrigin?: unknown };
  childFrames?: FrameTreeNode[];
}

function findFrame(node: FrameTreeNode | undefined, frameId: string): FrameTreeNode['frame'] | undefined {
  if (node === undefined) return undefined;
  if (node.frame?.id === frameId) return node.frame;
  for (const child of node.childFrames ?? []) {
    const found = findFrame(child, frameId);
    if (found !== undefined) return found;
  }
  return undefined;
}

async function frameOrigin(contents: WebContents, frameId: unknown): Promise<string | null> {
  if (typeof frameId !== 'string') return null;
  const tree = await send(contents, 'Page.getFrameTree') as { frameTree?: FrameTreeNode };
  const frame = findFrame(tree.frameTree, frameId);
  if (frame === undefined) return null;
  const security = typeof frame.securityOrigin === 'string' && frame.securityOrigin !== 'null' ? frame.securityOrigin : '';
  return security || browserPageOrigin(typeof frame.url === 'string' ? frame.url : '');
}

async function handleFileChooser(contents: WebContents, state: PageHooks, params: { frameId?: unknown; mode?: string; backendNodeId?: number }): Promise<void> {
  const browserId = state.options.browserId;
  const pageOrigin = browserPageOrigin(contents.getURL());
  if (params.backendNodeId === undefined) {
    if (!state.options.isAgentControlled()) {
      await syncAgentMode(contents, state);
      if (!state.options.isAgentControlled()) {
        if (!contents.isDestroyed() && installed.get(contents) === state) {
          openBrowserDialog({ browserId, kind: 'alert', origin: pageOrigin, owner: contents, userOnly: true, message: HANDBACK_PICKER_CANCELLED, onAnswer: () => {} });
        }
        return;
      }
    }
    pushAgentBrowserNotice(browserId, `${pageOrigin || 'The page'} tried to open a file system picker (File System Access API). It was cancelled because such pickers cannot be answered from the browser tool; ask the user to do this step.`, { kind: 'file-picker', origin: pageOrigin });
    return;
  }
  const generation = state.generation;
  const mainFrameId = state.mainFrameId;
  const stale = () => contents.isDestroyed() || installed.get(contents) !== state || state.generation !== generation || state.mainFrameId !== mainFrameId;
  if (!state.options.isAgentControlled()) {
    await syncAgentMode(contents, state);
    if (!state.options.isAgentControlled()) {
      for (const delay of HANDBACK_RETRY_MS) {
        if (stale() || !state.applied || state.options.isAgentControlled()) break;
        await new Promise(resolve => setTimeout(resolve, delay));
        await syncAgentMode(contents, state);
      }
      if (state.options.isAgentControlled()) {
        cancelFileInput(contents, params.backendNodeId);
        return;
      }
      if (stale()) cancelFileInput(contents, params.backendNodeId);
      else if (state.applied) await chooseInterceptedForUser(contents, state, params.backendNodeId, params.mode === 'selectMultiple', stale, pageOrigin);
      else await reopenForUser(contents, params.backendNodeId);
      return;
    }
  }
  const origin = await frameOrigin(contents, params.frameId).catch(() => null);
  if (stale()) {
    cancelFileInput(contents, params.backendNodeId);
    return;
  }
  if (origin === null) {
    cancelFileInput(contents, params.backendNodeId);
    pushAgentBrowserNotice(browserId, `A frame in ${pageOrigin || 'the page'} asked for a file upload, which the browser tool cannot answer; ask the user to do this step.`, { kind: 'file-picker', origin: pageOrigin });
    return;
  }
  const backendNodeId = params.backendNodeId;
  const input = await describeFileInput(contents, backendNodeId).catch(() => null);
  if (input === null || stale()) {
    cancelFileInput(contents, backendNodeId);
    return;
  }
  if (input.directory) {
    cancelFileInput(contents, backendNodeId);
    pushAgentBrowserNotice(browserId, `${origin || 'The page'} asked for a folder upload, which the browser tool cannot answer; ask the user to do this step.`, { kind: 'file-picker', origin });
    return;
  }
  const multiple = params.mode === 'selectMultiple';
  openBrowserDialog({
    browserId, kind: 'file', origin, owner: contents, accept: input.accept, multiple, timeoutMs: FILE_DIALOG_TIMEOUT_MS,
    onAnswer: async (answer) => {
      if (answer === null || !answer.accept) {
        cancelFileInput(contents, backendNodeId);
        return;
      }
      if (stale()) throw new Error(STALE_FILE_INPUT);
      const files = answer.files ?? (answer.by === 'user' ? await chooseFilesForUser(state, input.accept, multiple) : []);
      if (stale()) throw new Error(STALE_FILE_INPUT);
      if (files.length === 0) {
        cancelFileInput(contents, backendNodeId);
        return { ...answer, accept: false, files: [] };
      }
      const chosen = multiple ? files : files.slice(0, 1);
      try {
        await send(contents, 'DOM.setFileInputFiles', { files: chosen, backendNodeId });
      } catch {
        throw new Error(STALE_FILE_INPUT);
      }
      return { ...answer, files: chosen };
    },
  });
}

function handleDebuggerMessage(contents: WebContents, state: PageHooks, method: string, params: Record<string, unknown>): void {
  if (method === 'Page.fileChooserOpened') {
    void handleFileChooser(contents, state, params as { frameId?: unknown; mode?: string; backendNodeId?: number }).catch(error => log.warn(`[kimi-desktop] browser file chooser failed: ${String(error)}`));
    return;
  }
  if (method === 'Fetch.requestPaused') {
    handlePausedDocument(contents, state.mainFrameId, params, state.options.interceptPost, state.options.onNavigationRequested);
    return;
  }
  const request = mainFrameNavigationRequest(state.mainFrameId, method, params);
  if (request !== null) state.options.onNavigationRequested?.(request.url, request.reason);
  const post = method === 'Network.requestWillBeSent' && params['type'] === 'Document' ? mainFramePostRequest(state.mainFrameId, params) : null;
  if (post !== null) state.options.onNavigationRequested?.(post.url, 'formSubmissionPost');
}

function handlePausedDocument(contents: WebContents, mainFrameId: string | undefined, params: Record<string, unknown>, interceptPost: ((url: string, post: boolean) => boolean) | undefined, onRequested: ((url: string, reason: string, postData?: BrowserNavigationPostData) => void) | undefined): void {
  const requestId = params['requestId'];
  const post = mainFrameId === undefined ? null : mainFramePostRequest(mainFrameId, params);
  if (post?.data !== undefined && interceptPost?.(post.url, true) === true) {
    void send(contents, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(error => log.warn(`[kimi-desktop] browser POST interception failed: ${String(error)}`));
    onRequested?.(post.url, 'formSubmissionPost', post.data);
    return;
  }
  const url = (params['request'] as { url?: unknown } | undefined)?.url;
  if (post === null && mainFrameId !== undefined && params['frameId'] === mainFrameId && typeof url === 'string' && interceptPost?.(url, false) === true) {
    void send(contents, 'Fetch.failRequest', { requestId, errorReason: 'Aborted' }).catch(error => log.warn(`[kimi-desktop] browser redirect interception failed: ${String(error)}`));
    onRequested?.(url, 'redirect');
    return;
  }
  void send(contents, 'Fetch.continueRequest', { requestId }).catch(error => log.warn(`[kimi-desktop] browser document request could not continue: ${String(error)}`));
}

function mainFramePostRequest(mainFrameId: string | undefined, params: Record<string, unknown>): { url: string; data?: BrowserNavigationPostData } | null {
  if (mainFrameId !== undefined && params['frameId'] !== mainFrameId) return null;
  const request = params['request'] as { url?: unknown; method?: unknown; headers?: unknown; postData?: unknown; postDataEntries?: unknown } | undefined;
  if (request?.method !== 'POST' || typeof request.url !== 'string') return null;
  const headers = request.headers as Record<string, unknown> | undefined;
  const contentType = Object.entries(headers ?? {}).find(([name]) => name.toLowerCase() === 'content-type')?.[1];
  let bytes: Buffer | undefined;
  const entries = Array.isArray(request.postDataEntries) ? request.postDataEntries.map(entry => (entry as { bytes?: unknown }).bytes) : undefined;
  const complete = entries?.every((value): value is string => typeof value === 'string') ?? true;
  if (complete && typeof request.postData === 'string') bytes = Buffer.from(request.postData);
  else if (complete && entries !== undefined && entries.length > 0) bytes = Buffer.concat((entries as string[]).map(value => Buffer.from(value, 'base64')));
  return { url: request.url, ...(bytes === undefined ? {} : { data: { bytes, ...(typeof contentType === 'string' ? { contentType } : {}) } }) };
}

function mainFrameNavigationRequest(mainFrameId: string | undefined, method: string, params: Record<string, unknown>): { url: string; reason: string } | null {
  if (method !== 'Page.frameRequestedNavigation') return null;
  const url = params['url'];
  const reason = params['reason'];
  if (params['disposition'] !== 'currentTab' || typeof url !== 'string' || typeof reason !== 'string') return null;
  if (mainFrameId !== undefined && params['frameId'] !== mainFrameId) return null;
  return { url, reason };
}

function mainFrameIdOf(tree: unknown): string | undefined {
  const id = (tree as { frameTree?: { frame?: { id?: unknown } } }).frameTree?.frame?.id;
  return typeof id === 'string' ? id : undefined;
}

async function applyAgentMode(contents: WebContents, enabled: boolean): Promise<void> {
  await send(contents, 'Page.setInterceptFileChooserDialog', { enabled });
}

function syncAgentMode(contents: WebContents, state: PageHooks): Promise<void> {
  if (!state.options.isAgentControlled()) state.holdUntil = Date.now() + USER_INPUT_HOLD_MS;
  state.pending += 1;
  state.syncing = state.syncing.catch(() => undefined).then(async () => {
    if (contents.isDestroyed() || !contents.debugger.isAttached()) return;
    const enabled = state.options.isAgentControlled();
    if (enabled === state.applied) return;
    state.enabling = enabled;
    try {
      await applyAgentMode(contents, enabled);
    } finally {
      state.enabling = false;
    }
    state.applied = enabled;
  }).catch(error => log.warn(`[kimi-desktop] browser dialog interception failed: ${String(error)}`)).finally(() => { state.pending -= 1; });
  return state.syncing;
}

function holdsUserInput(state: PageHooks): boolean {
  return !state.options.isAgentControlled() && state.pending > 0 && (state.applied || state.enabling) && Date.now() < state.holdUntil;
}

function attach(contents: WebContents, state: PageHooks): Promise<void> {
  if (contents.isDestroyed() || contents.debugger.isAttached() && state.initialized) return Promise.resolve();
  if (state.initializing !== undefined) return state.initializing;
  try {
    ensureBrowserDebugger(contents, 'dialogs');
  } catch (error) {
    log.warn(`[kimi-desktop] browser dialog debugger could not attach: ${String(error)}`);
    return Promise.resolve();
  }
  state.applied = false;
  state.mainFrameId = undefined;
  const initializing: Promise<void> = Promise.all([
    send(contents, 'Page.enable'),
    send(contents, 'Network.enable'),
    send(contents, 'Page.addScriptToEvaluateOnNewDocument', { source: PAGE_GUARDS, runImmediately: true }),
    ...(state.options.interceptPost === undefined ? [] : [send(contents, 'Fetch.enable', PAUSED_DOCUMENTS)]),
  ])
    .then(() => send(contents, 'Page.getFrameTree'))
    .then((tree) => {
      state.mainFrameId = mainFrameIdOf(tree);
      state.initialized = true;
      return syncAgentMode(contents, state);
    })
    .catch(error => log.warn(`[kimi-desktop] browser dialog debugger setup failed: ${String(error)}`))
    .finally(() => { if (state.initializing === initializing) state.initializing = undefined; });
  state.initializing = initializing;
  return initializing;
}

export function installBrowserPageDialogs(contents: WebContents, options: BrowserPageDialogOptions): void {
  const state: PageHooks = { options, applied: false, syncing: Promise.resolve(), mainFrameId: undefined, initialized: false, initializing: undefined, generation: 0, pending: 0, enabling: false, holdUntil: 0 };
  installed.set(contents, state);
  const internal = contents as unknown as NodeJS.EventEmitter;
  internal.removeAllListeners('-run-dialog');
  internal.on('-run-dialog', (info: RunDialogInfo, callback: RunDialogCallback) => handleRunDialog(contents, state, info, callback));
  internal.on('-cancel-dialogs', () => discardBrowserDialogs({ owner: contents, kinds: ['alert', 'confirm', 'prompt'] }));
  const holdInput = (event: { preventDefault: () => void }): void => {
    if (holdsUserInput(state)) event.preventDefault();
  };
  contents.on('before-input-event', holdInput);
  contents.on('before-mouse-event', holdInput);
  contents.on('did-navigate', () => {
    state.generation += 1;
    discardBrowserDialogs({ owner: contents, kinds: ['file', 'beforeunload'] });
  });
  contents.on('render-process-gone', () => {
    state.generation += 1;
    discardBrowserDialogs({ owner: contents });
  });
  contents.once('destroyed', () => {
    installed.delete(contents);
    discardBrowserDialogs({ owner: contents });
  });
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) void attach(contents, state);
  });
  contents.on('console-message', (event) => {
    if ((event as { message?: unknown }).message !== PRINT_MARKER) return;
    if (!options.isAgentControlled()) {
      void contents.executeJavaScriptInIsolatedWorld(BROWSER_ANNOTATION_WORLD, [{ code: 'window.print()' }], true).catch(error => log.warn(`[kimi-desktop] browser print failed: ${String(error)}`));
      return;
    }
    pushAgentBrowserNotice(options.browserId, 'The page tried to open the print dialog. Printing is blocked while the browser tool controls the tab; ask the user to print if needed.', { kind: 'print', origin: browserPageOrigin(contents.getURL()) });
  });
  contents.on('select-bluetooth-device', (event, _devices, callback) => {
    event.preventDefault();
    callback('');
    pushAgentBrowserNotice(options.browserId, 'The page asked to pair a Bluetooth device. Bluetooth pickers are not supported in the built-in browser, so the request was cancelled.', { kind: 'bluetooth', origin: browserPageOrigin(contents.getURL()) });
  });
  contents.on('login', (_event, details, authInfo) => {
    const site = authInfo.isProxy ? `the proxy ${authInfo.host}` : browserPageOrigin(details.url) || authInfo.host;
    pushAgentBrowserNotice(options.browserId, `${site} asked for a username and password (HTTP authentication). HTTP authentication is not supported in the built-in browser, so the request was cancelled and neither the agent nor the user can sign in here; tell the user to open the page in their default browser if they need it.`);
  });
  contents.on('select-client-certificate', (event, url, _certificates, callback) => {
    if (!options.isAgentControlled()) return;
    event.preventDefault();
    (callback as () => void)();
    pushAgentBrowserNotice(options.browserId, `${browserPageOrigin(url) || 'The site'} asked for a client certificate. Client certificates are not sent while the browser tool controls the tab, so the request was cancelled and the page may fail to load; tell the user to open the page in their default browser if they need it.`);
  });
  contents.debugger.on('detach', () => { state.initialized = false; });
  contents.debugger.on('message', (_event, method, params) => handleDebuggerMessage(contents, state, method, params as Record<string, unknown>));
  void attach(contents, state);
}

export function watchBrowserNavigationRequests(contents: WebContents, onRequested: (url: string, reason: string, postData?: BrowserNavigationPostData) => void, interceptPost?: (url: string, post: boolean) => boolean): void {
  let mainFrameId: string | undefined;
  let initialized = false;
  let initializing = false;
  const watch = (): void => {
    if (contents.isDestroyed() || initializing || contents.debugger.isAttached() && initialized) return;
    try {
      ensureBrowserDebugger(contents, 'dialogs');
    } catch (error) {
      log.warn(`[kimi-desktop] browser navigation debugger could not attach: ${String(error)}`);
      return;
    }
    mainFrameId = undefined;
    initializing = true;
    void Promise.all([send(contents, 'Page.enable'), send(contents, 'Network.enable'), ...(interceptPost === undefined ? [] : [send(contents, 'Fetch.enable', PAUSED_DOCUMENTS)])])
      .then(() => send(contents, 'Page.getFrameTree'))
      .then((tree) => {
        mainFrameId = mainFrameIdOf(tree);
        initialized = mainFrameId !== undefined;
      })
      .catch(error => log.warn(`[kimi-desktop] browser navigation debugger setup failed: ${String(error)}`))
      .finally(() => { initializing = false; });
  };
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) watch();
  });
  contents.debugger.on('detach', () => { initialized = false; });
  contents.debugger.on('message', (_event, method, params) => {
    if (method === 'Fetch.requestPaused') {
      handlePausedDocument(contents, initialized ? mainFrameId : undefined, params as Record<string, unknown>, interceptPost, onRequested);
      return;
    }
    if (!initialized) return;
    const request = mainFrameNavigationRequest(mainFrameId, method, params as Record<string, unknown>);
    if (request !== null) onRequested(request.url, request.reason);
    const post = method === 'Network.requestWillBeSent' && (params as Record<string, unknown>)['type'] === 'Document' ? mainFramePostRequest(mainFrameId, params as Record<string, unknown>) : null;
    if (post !== null) onRequested(post.url, 'formSubmissionPost');
  });
  watch();
}

export function refreshBrowserPageDialogControl(): void {
  for (const [contents, state] of installed) {
    if (!contents.isDestroyed()) void syncAgentMode(contents, state);
  }
}

async function agentModeReady(contents: WebContents, state: PageHooks): Promise<void> {
  const missing = (): boolean => !contents.isDestroyed() && state.options.isAgentControlled() && (!state.initialized || !state.applied);
  await attach(contents, state);
  await syncAgentMode(contents, state);
  if (missing()) {
    await attach(contents, state);
    await syncAgentMode(contents, state);
  }
  if (missing()) throw new Error(state.initialized ? 'File chooser interception is not active for this tab.' : 'Page dialog guards could not be installed in this tab.');
}

export function browserPageDialogControlReady(browserId: string): Promise<void> {
  const pending: Promise<void>[] = [];
  for (const [contents, state] of installed) {
    if (state.options.browserId === browserId && !contents.isDestroyed()) pending.push(agentModeReady(contents, state));
  }
  return Promise.all(pending).then(() => undefined);
}

export function browserPageDialogMarkersForTest(): { printMarker: string; printGuard: string; promptRestore: string; pageGuards: string } {
  return { printMarker: PRINT_MARKER, printGuard: PRINT_GUARD, promptRestore: PROMPT_RESTORE, pageGuards: PAGE_GUARDS };
}
