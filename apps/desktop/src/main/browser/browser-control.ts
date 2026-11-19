import { WebContentsView, type Rectangle, type WebContents } from 'electron';
import type { MainWindow } from '../window/main-window';
import { join } from 'node:path';
import { release } from 'node:os';
import { browserValidators, type BrowserControlActivity, type BrowserControlConfig, type BrowserControlDialogs, type BrowserControlPresentation, type BrowserControlPointer, type BrowserControlSurface } from '../../shared/browser-control';
import type { BrowserActivity } from './browser-activity';
import { browserControllerLabel, sameBrowserSubagentRun, type BrowserSubagentRun } from '../../shared/browser-run';
import { browserControlOwnership, BrowserControlError } from './browser-control-ownership';
import { getBrowserDialogRecord, listBrowserDialogHistory, onBrowserDialogHistory } from './browser-dialogs';
import { isBrowserInputActive } from './browser-debugger';
import { IPC } from '../ipc/ipc-channels';
import { rendererDevBase } from '../app/protocol';
import { log } from '../diagnostics/log';
import { windowBorderWidth, windowCornerRadius, windowEdgeGeometry } from '../window/window-corners';
import type { BrowserControlTrigger } from '../diagnostics/telemetry-events';
import { trySendDesktopEvent } from '../diagnostics/track';

interface ControlPage {
  browserId: string;
  contents: WebContents;
  geometry: () => { visible: boolean; bounds: Rectangle; feedbackScale: number; focusScale: number };
  pointer: { x: number; y: number } | null;
}

const pages = new Map<string, ControlPage>();
const contentsPages = new WeakMap<WebContents, ControlPage>();
let config: BrowserControlConfig | null = null;
let host: MainWindow | null = null;
let overlay: WebContentsView | null = null;
let ready = false;
let current: BrowserControlSurface | null = null;
let revision = 0;
let ownershipSnapshot = '';
let replayActivity = false;
export interface BrowserActivityTarget {
  label?: string;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface BrowserActivityHandle {
  target: (pending: Promise<BrowserActivityTarget | null>) => void;
  end: () => void;
}

interface ActiveBrowserActivity extends BrowserActivity {
  id: number;
  target?: string;
  rect?: BrowserActivityTarget['rect'];
  pending?: Promise<void>;
}

const TARGET_WAIT_MS = 250;
const activities = new Map<string, ActiveBrowserActivity[]>();
let activitySequence = 0;

const controlListeners = new Set<() => void>();
const userActionListeners = new Set<(browserId: string) => void>();
const agentActionListeners = new Set<(browserId: string) => void>();
let downloadAction: (action: 'show' | 'move', downloadId: string, path: string | undefined) => void = () => {};

export function onBrowserControlDownloadAction(handler: typeof downloadAction): void {
  downloadAction = handler;
}

export function browserControlSessionKey(browserId: string): string | undefined {
  return browserControlOwnership.controlKey(browserId);
}

function publishDialogHistory(): void {
  if (!current || !ready || !overlay || overlay.webContents.isDestroyed()) return;
  overlay.webContents.send(IPC.browserControlDialogs, { browserId: current.browserId, revision: current.revision, records: listBrowserDialogHistory(current.browserId) } satisfies BrowserControlDialogs);
}

onBrowserDialogHistory((browserId) => { if (current?.browserId === browserId) publishDialogHistory(); });

export function handleBrowserControlDownload(sender: WebContents, payload: unknown): void {
  if (sender !== overlay?.webContents || !current || !browserValidators.downloadAction.Check(payload)) return;
  if (payload.browserId !== current.browserId || payload.revision !== current.revision) return;
  performBrowserControlDownloadAction(payload.browserId, payload.recordId, payload.action);
}

export function performBrowserControlDownloadAction(browserId: string, recordId: string, action: 'show' | 'move'): boolean {
  const record = getBrowserDialogRecord(browserId, recordId);
  if (record?.downloadId === undefined || record.outcome !== 'saved') return false;
  downloadAction(action, record.downloadId, record.files?.[0]);
  return true;
}

export function observeBrowserControls(listener: () => void): () => void {
  controlListeners.add(listener);
  return () => controlListeners.delete(listener);
}

export function onBrowserUserAction(listener: (browserId: string) => void): () => void {
  userActionListeners.add(listener);
  return () => userActionListeners.delete(listener);
}

export function onBrowserAgentAction(listener: (browserId: string) => void): () => void {
  agentActionListeners.add(listener);
  return () => agentActionListeners.delete(listener);
}

export function notifyBrowserAgentAction(browserId: string): void {
  for (const listener of Array.from(agentActionListeners)) listener(browserId);
}

function notifyUserAction(browserId: string): void {
  for (const listener of Array.from(userActionListeners)) listener(browserId);
}

function notifyControls(): void {
  for (const listener of Array.from(controlListeners)) listener();
}

export function isBrowserAgentControlled(browserId: string): boolean {
  const control = config?.controls.find(candidate => candidate.browserId === browserId && candidate.status === 'running');
  return control !== undefined && !browserControlOwnership.isBlocked(control.sessionId, control.controller?.run);
}

function controlFor(page: ControlPage) {
  return config?.controls.find(control => control.browserId === page.browserId && control.status !== 'idle');
}

function publishOwnership(): void {
  if (!host || host.isDestroyed()) return;
  const snapshot = browserControlOwnership.snapshot();
  const key = JSON.stringify(snapshot);
  if (key === ownershipSnapshot) return;
  ownershipSnapshot = key;
  host.webContents.send(IPC.browserControlOwnership, snapshot);
}

function takeOverControls(controls: readonly BrowserControlPresentation[], trigger: BrowserControlTrigger): void {
  let changed = false;
  for (const control of controls) {
    if (control.status === 'idle' || !browserControlOwnership.takeOver(control.browserId)) continue;
    changed = true;
    const sessionId = browserControlOwnership.sessionFor(control.browserId);
    trySendDesktopEvent('browser_control_changed', { action: trigger === 'overlay_failure' ? 'auto_takeover' : 'user_takeover', trigger, ...(sessionId === undefined ? {} : { session_id: sessionId }) });
  }
  if (changed) {
    refreshBrowserControlSurface();
    publishOwnership();
    notifyControls();
  }
}

export function takeOverBrowser(browserId: string, trigger: BrowserControlTrigger = 'ipc'): void {
  notifyUserAction(browserId);
  takeOverControls(config?.controls.filter(control => control.browserId === browserId) ?? [], trigger);
}

export function takeOverClosedBrowser(browserId: string): void {
  if (!browserControlOwnership.isAgentClosing(browserId)) takeOverBrowser(browserId);
}

export function takeOverAllBrowsers(): void {
  takeOverControls(config?.controls ?? [], 'ipc');
}

export function revokeBrowserSubagentRun(sessionId: string, run: BrowserSubagentRun, trigger?: BrowserControlTrigger): void {
  if (!browserControlOwnership.revoke(sessionId, run)) return;
  if (trigger !== undefined) trySendDesktopEvent('browser_control_changed', { action: 'subagent_revoked', trigger, session_id: sessionId });
  refreshBrowserControlSurface();
  publishOwnership();
  notifyControls();
}

export function restoreBrowserSubagentRuns(): void {
  if (!browserControlOwnership.restoreRevokedRuns()) return;
  trySendDesktopEvent('browser_control_changed', { action: 'subagent_restored', trigger: 'ipc' });
  refreshBrowserControlSurface();
  publishOwnership();
  notifyControls();
}

export interface BrowserInputScope {
  run: BrowserSubagentRun | undefined;
  revision: number;
}

function sameInputController(a: BrowserSubagentRun | undefined, b: BrowserSubagentRun | undefined): boolean {
  return a === undefined || b === undefined ? a === b : sameBrowserSubagentRun(a, b);
}

export function assertBrowserInputAllowed(contents: WebContents, scope?: BrowserInputScope): void {
  const page = contentsPages.get(contents);
  if (!page) return;
  const sessionId = browserControlOwnership.sessionFor(page.browserId);
  const control = controlFor(page);
  const run = control?.controller?.run;
  browserControlOwnership.assertAllowed(sessionId, scope?.revision, scope === undefined ? run : scope.run);
  if (!control || control.status !== 'running') throw new BrowserControlError('PAGE_NOT_READY', 'Browser control is no longer running. Wait for the current interaction to finish before controlling the browser.');
  if (scope !== undefined && !sameInputController(run, scope.run)) throw new BrowserControlError('TAB_NOT_ACTIVE', 'Browser control changed; request a new operation under the current control.');
}

export function browserInputScope(contents: WebContents): BrowserInputScope | undefined {
  const page = contentsPages.get(contents);
  if (!page) return undefined;
  const run = controlFor(page)?.controller?.run;
  return { run, revision: browserControlOwnership.revision(browserControlOwnership.sessionFor(page.browserId), run) };
}

export function isBrowserInputScopeCurrent(contents: WebContents, scope: BrowserInputScope | undefined): boolean {
  const current = browserInputScope(contents);
  if (current === undefined || scope === undefined) return current === scope;
  return current.revision === scope.revision && sameInputController(current.run, scope.run);
}

function ensureOverlay(): WebContentsView | null {
  if (!host || host.isDestroyed()) return null;
  if (overlay && !overlay.webContents.isDestroyed()) return overlay;
  const view = new WebContentsView({ webPreferences: {
    preload: join(__dirname, 'browser-control-preload.cjs'), contextIsolation: true,
    nodeIntegration: false, sandbox: true,
  } });
  view.setBackgroundColor('#00000000');
  view.setBounds({ x: 0, y: 0, width: 1, height: 1 });
  view.setVisible(false);
  host.contentView.addChildView(view);
  overlay = view;
  ready = false;
  const base = rendererDevBase(process.env['KIMI_RENDERER_DEV_URL']);
  const url = base ? new URL('browser-control.html', base).toString() : 'app://renderer/browser-control.html';
  view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  view.webContents.on('will-navigate', (event, next) => { if (next !== url) event.preventDefault(); });
  view.webContents.on('render-process-gone', () => {
    if (overlay !== view) return;
    if (current) takeOverBrowser(current.browserId, 'overlay_failure');
    destroyOverlay();
  });
  void view.webContents.loadURL(url).catch(error => {
    if (overlay !== view) return;
    if (current) takeOverBrowser(current.browserId, 'overlay_failure');
    destroyOverlay();
    log.error('[kimi-desktop] browser control surface failed to load', error);
  });
  return view;
}

function destroyOverlay(): void {
  const view = overlay;
  overlay = null;
  current = null;
  ready = false;
  if (!view) return;
  if (host && !host.isDestroyed()) host.contentView.removeChildView(view);
  if (!view.webContents.isDestroyed()) view.webContents.close();
}

export function attachBrowserControlWindow(win: MainWindow): void {
  if (host === win) return;
  destroyOverlay();
  host = win;
  ownershipSnapshot = '';
  win.on('focus', () => {
    if (host !== win) return;
    const page = current && pages.get(current.browserId);
    if (page?.contents.isFocused() && ready) overlay?.webContents.focus();
  });
  const refreshCorners = (): void => { if (host === win) refreshBrowserControlSurface(); };
  win.on('maximize', refreshCorners);
  win.on('unmaximize', refreshCorners);
  win.on('enter-full-screen', refreshCorners);
  win.on('leave-full-screen', refreshCorners);
  win.on('resize', () => {
    if (host === win && current && ready && overlay && !overlay.webContents.isDestroyed()) overlay.webContents.send(IPC.browserControlResizing);
  });
  win.once('closed', () => {
    if (host !== win) return;
    destroyOverlay();
    host = null;
    config = null;
    browserControlOwnership.reset();
    notifyControls();
  });
}

export function setBrowserControls(next: BrowserControlConfig | null): void {
  config = next;
  browserControlOwnership.sync(next?.controls ?? []);
  if (next) publishOwnership();
  else ownershipSnapshot = '';
  refreshBrowserControlSurface();
  notifyControls();
}

export function refreshBrowserControlSurface(): void {
  const page = [...pages.values()].find(page => {
    const control = controlFor(page);
    return page.geometry().visible && control?.status === 'running' && !browserControlOwnership.isBlocked(control.sessionId, control.controller?.run);
  });
  if (!page || !config) {
    current = null;
    if (overlay && !overlay.webContents.isDestroyed()) {
      overlay.webContents.send(IPC.browserControlSurface, null);
      const wasFocused = overlay.webContents.isFocused();
      overlay.setVisible(false);
      if (wasFocused && host?.isFocused()) host.webContents.focus();
    }
    return;
  }
  const view = ensureOverlay();
  if (!view || !host) return;
  const control = controlFor(page)!;
  const run = control.controller?.run;
  const controller = control.controller === undefined ? undefined : browserControllerLabel(control.controller);
  const startedAt = browserControlOwnership.startedAt(control.sessionId, run);
  const changed = current?.browserId !== page.browserId || current.startedAt !== startedAt || current.controller !== controller;
  if (changed) {
    revision++;
    page.pointer = null;
    const index = host.contentView.children.findIndex(child => (child as WebContentsView).webContents === page.contents);
    host.contentView.addChildView(view, index < 0 ? undefined : index + 1);
  }
  const bounds = page.geometry().bounds;
  const [width = 0, height = 0] = host.getContentSize();
  const windowState = { fullScreen: host.isFullScreen(), maximized: host.isMaximized() };
  const edge = windowEdgeGeometry(bounds, { width, height }, windowCornerRadius(process.platform, release(), windowState), windowBorderWidth(process.platform, windowState));
  current = {
    browserId: page.browserId,
    revision,
    startedAt,
    labels: config.labels,
    ...(controller === undefined ? {} : { controller }),
    colorScheme: config.colorScheme,
    reducedMotion: config.reducedMotion,
    ...edge,
  };
  view.setBounds(bounds);
  view.setVisible(true);
  if (page.contents.isFocused() && host.isFocused()) view.webContents.focus();
  if (!ready) return;
  view.webContents.send(IPC.browserControlSurface, current);
  if (changed || replayActivity) publishDialogHistory();
  if ((changed || replayActivity) && activities.has(page.browserId)) publishBrowserActivity(page.browserId);
  replayActivity = false;
}

export function markBrowserControlReady(sender: WebContents): void {
  if (overlay?.webContents !== sender) return;
  ready = true;
  replayActivity = true;
  refreshBrowserControlSurface();
}

export function handleBrowserControlTakeover(sender: WebContents, payload: unknown): void {
  if (sender !== overlay?.webContents || !current || !browserValidators.takeover.Check(payload)) return;
  const request = payload;
  if (request['browserId'] === current.browserId && request['revision'] === current.revision) takeOverBrowser(current.browserId, 'control_ui');
}

export function attachBrowserUserInput(browserId: string, contents: WebContents): void {
  const userAct = (): void => {
    if (isBrowserAgentControlled(browserId)) takeOverBrowser(browserId, 'input');
    else notifyUserAction(browserId);
  };
  const act = (): void => {
    if (!isBrowserInputActive(contents)) userAct();
  };
  contents.on('before-input-event', (_event, input) => { if (input.type === 'keyDown') act(); });
  contents.on('before-mouse-event', (_event, mouse) => { if (mouse.type === 'mouseDown' || mouse.type === 'mouseWheel') act(); });
  const internal = contents as unknown as NodeJS.EventEmitter;
  const native = internal.listeners('-run-dialog') as ((info: unknown, callback: (...args: unknown[]) => void) => unknown)[];
  if (native.length === 0) return;
  internal.removeAllListeners('-run-dialog');
  internal.on('-run-dialog', (info: unknown, callback: (...args: unknown[]) => void) => {
    let shown = false;
    const settle = (...args: unknown[]): void => {
      if (shown) userAct();
      callback(...args);
    };
    for (const listener of native) listener.call(contents, info, settle);
    shown = true;
  });
}

export function attachBrowserControlPage(browserId: string, contents: WebContents, geometry: ControlPage['geometry']): void {
  const page: ControlPage = { browserId, contents, geometry, pointer: null };
  pages.set(browserId, page);
  contentsPages.set(contents, page);
  contents.on('dom-ready', () => {
    page.pointer = null;
    if (current?.browserId === browserId) overlay?.webContents.send(IPC.browserControlPointer, { browserId, revision: current.revision, kind: 'reset' } satisfies BrowserControlPointer);
    refreshBrowserControlSurface();
  });
  contents.on('before-input-event', (event, input) => {
    const status = controlFor(page)?.status;
    if (input.type === 'keyDown' && !isBrowserAgentControlled(browserId) && !isBrowserInputActive(contents)) notifyUserAction(browserId);
    if ((status === 'paused' || status === 'unknown') && input.type === 'keyDown' && !isBrowserInputActive(contents)) takeOverBrowser(browserId, 'input');
    if (status === 'running' && !browserControlOwnership.isBlocked(browserControlOwnership.sessionFor(browserId)) && !isBrowserInputActive(contents)) {
      event.preventDefault();
      if (input.type === 'keyDown' && current?.browserId === browserId) overlay?.webContents.send(IPC.browserControlPointer, { browserId, revision: current.revision, kind: 'blocked' } satisfies BrowserControlPointer);
    }
  });
  contents.on('before-mouse-event', (_event, mouse) => {
    const status = controlFor(page)?.status;
    if ((mouse.type === 'mouseDown' || mouse.type === 'mouseWheel') && !isBrowserAgentControlled(browserId) && !isBrowserInputActive(contents)) notifyUserAction(browserId);
    if ((mouse.type === 'mouseDown' || mouse.type === 'mouseWheel') && (status === 'paused' || status === 'unknown') && !isBrowserInputActive(contents)) takeOverBrowser(browserId, 'input');
  });
  contents.on('destroyed', () => {
    if (pages.get(browserId) === page) pages.delete(browserId);
    contentsPages.delete(contents);
    refreshBrowserControlSurface();
  });
}

function publishBrowserActivity(browserId: string): void {
  if (!current || current.browserId !== browserId || !ready || !overlay || overlay.webContents.isDestroyed()) return;
  if (browserControlOwnership.isBlocked(browserControlOwnership.sessionFor(browserId))) return;
  const top = activities.get(browserId)?.at(-1);
  const scale = pages.get(browserId)?.geometry().focusScale ?? 1;
  overlay.webContents.send(IPC.browserControlActivity, {
    browserId, revision: current.revision,
    ...(top === undefined ? { activity: null } : {
      id: top.id, activity: top.activity, scan: top.scan,
      ...(top.target ? { target: top.target } : {}),
      ...(top.rect ? { rect: { x: top.rect.x * scale, y: top.rect.y * scale, width: top.rect.width * scale, height: top.rect.height * scale } } : {}),
    }),
  } satisfies BrowserControlActivity);
}

export function beginBrowserActivity(browserId: string, next: BrowserActivity): BrowserActivityHandle {
  const entry: ActiveBrowserActivity = { ...next, id: ++activitySequence };
  activities.set(browserId, [...(activities.get(browserId) ?? []), entry]);
  publishBrowserActivity(browserId);
  let ended = false;
  const finish = (): void => {
    const running = activities.get(browserId);
    if (!running?.includes(entry)) return;
    const rest = running.filter(item => item !== entry);
    if (rest.length > 0) activities.set(browserId, rest);
    else activities.delete(browserId);
    publishBrowserActivity(browserId);
  };
  return {
    target: (pending) => {
      entry.pending = pending.then((found) => {
        if (!found || !activities.get(browserId)?.includes(entry)) return;
        entry.target = found.label?.slice(0, 80) || undefined;
        entry.rect = found.rect;
        if (activities.get(browserId)?.at(-1) === entry) publishBrowserActivity(browserId);
      }, () => undefined);
    },
    end: () => {
      if (ended) return;
      ended = true;
      if (entry.pending === undefined) {
        finish();
        return;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      void Promise.race([entry.pending, new Promise<void>(resolve => { timer = setTimeout(resolve, TARGET_WAIT_MS); })]).then(() => {
        clearTimeout(timer);
        finish();
      });
    },
  };
}

export async function showBrowserInputFeedback(contents: WebContents, method: string, params: Record<string, unknown> | undefined, before: boolean): Promise<void> {
  const page = contentsPages.get(contents);
  if (!page || !current || current.browserId !== page.browserId || !ready || !overlay || browserControlOwnership.isBlocked(browserControlOwnership.sessionFor(page.browserId))) return;
  const mouse = method === 'Input.dispatchMouseEvent';
  const down = mouse && params?.['type'] === 'mousePressed';
  if (before && !down) return;
  if (!mouse && method !== 'Input.insertText' && method !== 'Input.dispatchKeyEvent') return;
  if (method === 'Input.dispatchKeyEvent' && params?.['type'] === 'keyUp') return;
  const x = params?.['x'], y = params?.['y'];
  const scale = page.geometry().feedbackScale;
  let point = typeof x === 'number' && typeof y === 'number' ? { x: x * scale, y: y * scale } : undefined;
  const activeSurface = current;
  if (!mouse) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const focus = await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(() => {
        let element = document.activeElement;
        while (element?.shadowRoot?.activeElement) element = element.shadowRoot.activeElement;
        if (!element || element === document.body || element === document.documentElement) return null;
        const rect = element.getBoundingClientRect(), viewport = visualViewport;
        if (rect.width <= 0 || rect.height <= 0) return null;
        return { x: (rect.x + rect.width / 2 - (viewport?.offsetLeft || 0)) * (viewport?.scale || 1), y: (rect.y + rect.height / 2 - (viewport?.offsetTop || 0)) * (viewport?.scale || 1) };
      })()` }]).catch(() => null),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 200); }),
    ]).finally(() => clearTimeout(timer));
    if (current !== activeSurface || browserControlOwnership.isBlocked(browserControlOwnership.sessionFor(page.browserId))) return;
    if (focus && typeof focus.x === 'number' && typeof focus.y === 'number') point = { x: focus.x * page.geometry().focusScale, y: focus.y * page.geometry().focusScale };
  }
  const moved = point && page.pointer && (page.pointer.x !== point.x || page.pointer.y !== point.y);
  const pointer: BrowserControlPointer = {
    browserId: page.browserId, revision: current.revision,
    kind: before ? 'move' : down ? 'down' : params?.['type'] === 'mouseReleased' ? 'up'
      : params?.['type'] === 'mouseWheel' ? 'scroll' : method === 'Input.insertText' ? 'type'
      : method === 'Input.dispatchKeyEvent' ? 'key' : 'move',
    ...point, drag: params?.['buttons'] === 1,
  };
  if (point) page.pointer = point;
  overlay.webContents.send(IPC.browserControlPointer, pointer);
  if (before && moved && !config?.reducedMotion) await new Promise(resolve => setTimeout(resolve, 160));

}
