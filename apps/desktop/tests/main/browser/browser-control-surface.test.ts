import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ views: [] as any[] }));
vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return { WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => false, focus: vi.fn(), send: vi.fn(), close: vi.fn(), loadURL: vi.fn(async () => {}), setWindowOpenHandler: vi.fn() });
    setBackgroundColor = vi.fn();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor() { mock.views.push(this); }
  } };
});
vi.mock('../../../src/main/app/protocol', () => ({ rendererDevBase: () => undefined }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { error: vi.fn() } }));

import { assertBrowserInputAllowed, browserInputScope, isBrowserInputScopeCurrent, attachBrowserUserInput, browserControlSessionKey, handleBrowserControlDownload, onBrowserControlDownloadAction, beginBrowserActivity, takeOverAllBrowsers, takeOverBrowser, takeOverClosedBrowser, attachBrowserControlPage, attachBrowserControlWindow, handleBrowserControlTakeover, markBrowserControlReady, onBrowserUserAction, refreshBrowserControlSurface, setBrowserControls, showBrowserInputFeedback } from '../../../src/main/browser/browser-control';
import { browserControlOwnership } from '../../../src/main/browser/browser-control-ownership';
import { browserValidators, type BrowserControlConfig } from '../../../src/shared/browser-control';
import { configureBrowserDialogs, listBrowserDialogHistory, recordBrowserDialogEvent, resetBrowserDialogsForTest, syncBrowserDialogControl } from '../../../src/main/browser/browser-dialogs';
import { IPC } from '../../../src/main/ipc/ipc-channels';
import { setDesktopTrackImpl } from '../../../src/main/diagnostics/track';
import { windowBorderWidth, windowCornerRadius } from '../../../src/main/window/window-corners';
import { release } from 'node:os';

const config: BrowserControlConfig = {
  controls: [{ browserId: 'page', sessionId: 'session', turnId: 'turn', status: 'running' }],
  labels: {
    running: 'Running', elapsed: '{time}', takeover: 'Take over', takeoverHint: 'Stop', pointer: 'Agent', typing: 'Typing', key: 'Keys', scrolling: 'Scrolling',
    activityTarget: '{activity} "{target}"',
    activities: { reading: 'Reading', inspecting: 'Inspecting', capturing: 'Capturing', clicking: 'Clicking', hovering: 'Hovering', typing: 'Typing', pressing: 'Pressing', selecting: 'Selecting', checking: 'Checking', scrolling: 'Scrolling', dragging: 'Dragging', navigating: 'Navigating', waiting: 'Waiting', answering: 'Answering' },
  },
  colorScheme: 'light', reducedMotion: true,
};

function setup() {
  const page = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => true, focus: vi.fn(), send: vi.fn(), executeJavaScriptInIsolatedWorld: vi.fn(async () => null) });
  const main = { isFocused: () => false, focus: vi.fn(), send: vi.fn() };
  const pageView = { webContents: page };
  const menuView = { webContents: {} };
  const children: any[] = [{ webContents: main }, pageView, menuView];
  const windowState = { fullScreen: false, maximized: false };
  const host = Object.assign(new EventEmitter(), {
    isDestroyed: () => false, isFocused: () => false, webContents: main,
    getContentSize: () => [900, 600], isFullScreen: () => windowState.fullScreen, isMaximized: () => windowState.maximized,
    contentView: {
      children,
      addChildView(view: any, index?: number) { const old = children.indexOf(view); if (old >= 0) children.splice(old, 1); children.splice(index ?? children.length, 0, view); },
      removeChildView(view: any) { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1); },
    },
  });
  const geometry = { visible: true, bounds: { x: 300, y: 100, width: 600, height: 500 }, feedbackScale: 1.5, focusScale: 1.5 };
  attachBrowserControlWindow(host as never);
  attachBrowserControlPage('page', page as never, () => geometry);
  setBrowserControls(config);
  const view = mock.views.at(-1);
  markBrowserControlReady(view.webContents);
  return { host, page, main, view, children, geometry, menuView, windowState };
}

beforeEach(() => { browserControlOwnership.reset(); setBrowserControls(null); mock.views.length = 0; });

describe('native browser control surface', () => {
  it('follows the page inside the same window, below menus, without focusing a background app', () => {
    const { host, page, main, view, geometry, children, menuView } = setup();
    expect(view.setBounds).toHaveBeenLastCalledWith(geometry.bounds);
    expect(children.indexOf(view)).toBeLessThan(children.indexOf(menuView));
    expect(view.webContents.focus).not.toHaveBeenCalled();
    expect(page.focus).not.toHaveBeenCalled();
    expect(main.focus).not.toHaveBeenCalled();
    geometry.bounds.width = 400;
    refreshBrowserControlSurface();
    expect(view.setBounds).toHaveBeenLastCalledWith(geometry.bounds);
    geometry.visible = false;
    refreshBrowserControlSurface();
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    host.emit('closed');
  });

  it('insets and rounds only the edges that meet the window edge, and clears both in full screen', () => {
    const { host, view, windowState } = setup();
    const surface = () => view.webContents.send.mock.calls.findLast((call: any[]) => call[0] === IPC.browserControlSurface)[1];
    const radius = windowCornerRadius(process.platform, release(), windowState), border = windowBorderWidth(process.platform, windowState);
    expect(surface().insets).toEqual([0, border, border, 0]);
    expect(surface().corners).toEqual([0, 0, Math.max(0, radius - border), 0]);
    windowState.fullScreen = true;
    host.emit('enter-full-screen');
    expect(surface().insets).toEqual([0, 0, 0, 0]);
    expect(surface().corners).toEqual([0, 0, 0, 0]);
    host.emit('closed');
  });

  it('tells the surface when the window resizes, before the overlay has its new bounds', () => {
    const { host, view } = setup();
    view.webContents.send.mockClear();
    host.emit('resize');
    expect(view.webContents.send).toHaveBeenCalledWith(IPC.browserControlResizing);
    host.emit('closed');
  });

  it('publishes the handled dialog history to the surface and routes download actions for saved records only', () => {
    resetBrowserDialogsForTest();
    configureBrowserDialogs({ isAgentControlled: () => true, controlSession: browserControlSessionKey });
    const handler = vi.fn();
    onBrowserControlDownloadAction(handler);
    try {
      const { host, view } = setup();
      const surface = view.webContents.send.mock.calls.findLast((call: any[]) => call[0] === IPC.browserControlSurface)[1];
      expect(view.webContents.send).toHaveBeenCalledWith(IPC.browserControlDialogs, { browserId: 'page', revision: surface.revision, records: [] });
      recordBrowserDialogEvent('page', { kind: 'download', origin: 'https://example.test', message: 'a.dmg', outcome: 'saved', files: ['/d/a.dmg'], downloadId: 'download-1' });
      recordBrowserDialogEvent('page', { kind: 'print', origin: 'https://example.test' });
      const published = view.webContents.send.mock.calls.findLast((call: any[]) => call[0] === IPC.browserControlDialogs)[1];
      expect(browserValidators.dialogs.Check(published)).toBe(true);
      expect(published.records.map((record: { kind: string }) => record.kind)).toEqual(['download', 'print']);
      const [download, print] = published.records;
      handleBrowserControlDownload({} as never, { browserId: 'page', revision: surface.revision, recordId: download.id, action: 'show' });
      handleBrowserControlDownload(view.webContents, { browserId: 'page', revision: surface.revision - 1, recordId: download.id, action: 'show' });
      handleBrowserControlDownload(view.webContents, { browserId: 'page', revision: surface.revision, recordId: print.id, action: 'show' });
      handleBrowserControlDownload(view.webContents, { browserId: 'page', revision: surface.revision, recordId: download.id, action: 'delete' });
      expect(handler).not.toHaveBeenCalled();
      handleBrowserControlDownload(view.webContents, { browserId: 'page', revision: surface.revision, recordId: download.id, action: 'move' });
      expect(handler).toHaveBeenCalledExactlyOnceWith('move', 'download-1', '/d/a.dmg');
      host.emit('closed');
    } finally {
      configureBrowserDialogs({ isAgentControlled: () => false, controlSession: () => undefined });
      resetBrowserDialogsForTest();
    }
  });

  it('keys the dialog history by control turn so a new turn starts a fresh session', () => {
    resetBrowserDialogsForTest();
    configureBrowserDialogs({ isAgentControlled: () => true, controlSession: browserControlSessionKey });
    try {
      const { host } = setup();
      expect(browserControlSessionKey('page')).toBe('session:turn');
      recordBrowserDialogEvent('page', { kind: 'print', origin: '' });
      setBrowserControls({ ...config, controls: [{ ...config.controls[0]!, turnId: 'turn-2' }] });
      syncBrowserDialogControl();
      expect(listBrowserDialogHistory('page')).toEqual([]);
      host.emit('closed');
    } finally {
      configureBrowserDialogs({ isAgentControlled: () => false, controlSession: () => undefined });
      resetBrowserDialogsForTest();
    }
  });

  it('refreshes the current controller and scopes dialog history by run identity', () => {
    resetBrowserDialogsForTest();
    configureBrowserDialogs({ isAgentControlled: () => true, controlSession: browserControlSessionKey });
    try {
      const { host, view } = setup();
      const run = { agentId: 'agent-1', generation: 2, turnId: 7 };
      setBrowserControls({ ...config, controls: [{ ...config.controls[0]!, turnId: '7', controller: { run, profile: 'coder', description: 'Inspect docs' } }] });
      expect(browserControlSessionKey('page')).toBe('session:agent-1:2:7');
      recordBrowserDialogEvent('page', { kind: 'print', origin: '' });
      let surface = view.webContents.send.mock.calls.findLast((call: any[]) => call[0] === IPC.browserControlSurface)[1];
      expect(surface.controller).toBe('coder · Inspect docs');

      setBrowserControls({ ...config, controls: [{ ...config.controls[0]!, turnId: '9', controller: { run: { agentId: 'agent-2', generation: 4, turnId: 9 } } }] });
      syncBrowserDialogControl();
      expect(listBrowserDialogHistory('page')).toEqual([]);
      surface = view.webContents.send.mock.calls.findLast((call: any[]) => call[0] === IPC.browserControlSurface)[1];
      expect(surface.controller).toBe('agent-2');
      host.emit('closed');
    } finally {
      configureBrowserDialogs({ isAgentControlled: () => false, controlSession: () => undefined });
      resetBrowserDialogsForTest();
    }
  });

  it('accepts takeover only from the current surface and rejects stale target revisions', () => {
    const { host, view } = setup();
    const payload = view.webContents.send.mock.calls.findLast((call: any[]) => call[0] === IPC.browserControlSurface)[1];
    handleBrowserControlTakeover({} as never, payload);
    expect(browserControlOwnership.isBlocked('session')).toBe(false);
    handleBrowserControlTakeover(view.webContents, { ...payload, revision: payload.revision - 1 });
    expect(browserControlOwnership.isBlocked('session')).toBe(false);
    handleBrowserControlTakeover(view.webContents, payload);
    expect(browserControlOwnership.isBlocked('session')).toBe(true);
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    host.emit('closed');
  });

  it('reports a user takeover once with its trigger and nothing when control is already taken', () => {
    const { host, page } = setup();
    const events: Array<{ event: string; properties?: unknown }> = [];
    setDesktopTrackImpl(null);
    setDesktopTrackImpl((event, properties) => events.push({ event, properties }));
    try {
      setBrowserControls({ ...config, controls: [{ ...config.controls[0]!, status: 'paused' }] });
      page.emit('before-mouse-event', {}, { type: 'mouseDown' });
      page.emit('before-mouse-event', {}, { type: 'mouseDown' });
      takeOverBrowser('page');
      expect(events.filter(item => item.event === 'browser_control_changed')).toEqual([
        { event: 'browser_control_changed', properties: { action: 'user_takeover', trigger: 'input', session_id: 'session' } },
      ]);
      browserControlOwnership.reset();
      setBrowserControls(config);
      events.length = 0;
      mock.views.at(-1).webContents.emit('render-process-gone');
      expect(events.filter(item => item.event === 'browser_control_changed').map(item => item.properties)).toEqual([
        { action: 'auto_takeover', trigger: 'overlay_failure', session_id: 'session' },
      ]);
    } finally {
      setDesktopTrackImpl(null);
      host.emit('closed');
    }
  });

  it('hides while awaiting input and treats user interaction during that time as takeover', () => {
    const { host, page, view } = setup();
    setBrowserControls({ ...config, controls: [{ ...config.controls[0]!, status: 'paused' }] });
    expect(view.setVisible).toHaveBeenLastCalledWith(false);
    page.emit('before-mouse-event', {}, { type: 'mouseDown' });
    expect(browserControlOwnership.isBlocked('session')).toBe(true);
    host.emit('closed');
  });

  it.each(['paused', 'unknown'] as const)('treats wheel scrolling while control is %s as takeover', (status) => {
    const { host, page } = setup();
    setBrowserControls({ ...config, controls: [{ ...config.controls[0]!, status }] });
    page.emit('before-mouse-event', {}, { type: 'mouseMove' });
    expect(browserControlOwnership.isBlocked('session')).toBe(false);
    page.emit('before-mouse-event', {}, { type: 'mouseWheel', deltaY: 120 });
    expect(browserControlOwnership.isBlocked('session')).toBe(true);
    host.emit('closed');
  });

  it('reports user wheel scrolling on an idle tab as a user action', () => {
    const { host, page } = setup();
    const actions: string[] = [];
    const off = onBrowserUserAction(browserId => actions.push(browserId));
    page.emit('before-mouse-event', {}, { type: 'mouseWheel', deltaY: 120 });
    expect(actions).toEqual([]);
    setBrowserControls({ ...config, controls: [{ ...config.controls[0]!, status: 'idle', turnId: null }] });
    page.emit('before-mouse-event', {}, { type: 'mouseMove' });
    page.emit('before-mouse-event', {}, { type: 'mouseWheel', deltaY: 120 });
    expect(actions).toEqual(['page']);
    off();
    host.emit('closed');
  });

  it('treats real user input in a popup window of an agent-controlled tab as takeover', () => {
    const { host } = setup();
    const popup = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => true });
    attachBrowserUserInput('page', popup as never);
    const actions: string[] = [];
    const off = onBrowserUserAction(browserId => actions.push(browserId));
    popup.emit('before-mouse-event', {}, { type: 'mouseMove' });
    expect(browserControlOwnership.isBlocked('session')).toBe(false);
    popup.emit('before-mouse-event', {}, { type: 'mouseDown' });
    expect(browserControlOwnership.isBlocked('session')).toBe(true);
    expect(actions).toEqual(['page']);
    off();
    host.emit('closed');
  });

  it('treats a user answer to a popup native page dialog as takeover before the page resumes', async () => {
    const { host } = setup();
    const popup = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => true });
    let answer: (() => void) | undefined;
    popup.on('-run-dialog', async (info: { dialogType: string }, callback: (success: boolean, text: string) => void) => {
      if (info.dialogType === 'prompt') { callback(false, ''); return; }
      await new Promise<void>(resolve => { answer = resolve; });
      callback(true, '');
    });
    attachBrowserUserInput('page', popup as never);
    const actions: string[] = [];
    const off = onBrowserUserAction(browserId => actions.push(browserId));
    const order: string[] = [];
    popup.emit('-run-dialog', { dialogType: 'prompt' }, () => order.push(`prompt:${browserControlOwnership.isBlocked('session')}`));
    expect(order).toEqual(['prompt:false']);
    expect(actions).toEqual([]);
    popup.emit('-run-dialog', { dialogType: 'confirm' }, (success: boolean) => order.push(`confirm:${success}:${browserControlOwnership.isBlocked('session')}`));
    await Promise.resolve();
    expect(browserControlOwnership.isBlocked('session')).toBe(false);
    answer!();
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(order).toEqual(['prompt:false', 'confirm:true:true']);
    expect(actions).toEqual(['page']);
    expect(popup.listenerCount('-run-dialog')).toBe(1);
    off();
    host.emit('closed');
  });

  it('signals blocked user keyboard input without releasing control', () => {
    const { host, page, view } = setup();
    const event = { preventDefault: vi.fn() };
    page.emit('before-input-event', event, { type: 'keyDown', key: 'a' });
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(view.webContents.send).toHaveBeenLastCalledWith(IPC.browserControlPointer, expect.objectContaining({ kind: 'blocked' }));
    expect(browserControlOwnership.isBlocked('session')).toBe(false);
    host.emit('closed');
  });

  it('projects pointer coordinates at page zoom without forwarding typed content', async () => {
    const { host, page, view } = setup();
    await showBrowserInputFeedback(page as never, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: 100, y: 40 }, false);
    expect(view.webContents.send).toHaveBeenLastCalledWith(IPC.browserControlPointer, expect.objectContaining({ kind: 'down', x: 150, y: 60 }));
    await showBrowserInputFeedback(page as never, 'Input.insertText', { text: 'password' }, false);
    expect(view.webContents.send).toHaveBeenLastCalledWith(IPC.browserControlPointer, expect.objectContaining({ kind: 'type' }));
    expect(JSON.stringify(view.webContents.send.mock.calls.at(-1))).not.toContain('password');
    host.emit('closed');
  });
});

it('binds input validation to the controller that started the operation', () => {
  const { page } = setup();
  const contents = page as never;
  const base = config.controls[0]!;
  const first = { agentId: 'first', generation: 1, turnId: 1 };
  const second = { agentId: 'second', generation: 1, turnId: 1 };
  setBrowserControls({ ...config, controls: [{ ...base, controller: { run: first } }] });
  const scope = browserInputScope(contents)!;
  expect(() => assertBrowserInputAllowed(contents, scope)).not.toThrow();
  expect(isBrowserInputScopeCurrent(contents, scope)).toBe(true);

  setBrowserControls({ ...config, controls: [{ ...base, controller: { run: second } }] });
  expect(browserControlOwnership.revision('session', second)).toBe(scope.revision);
  expect(() => assertBrowserInputAllowed(contents, scope)).toThrow('Browser control changed');
  expect(isBrowserInputScopeCurrent(contents, scope)).toBe(false);
  expect(() => assertBrowserInputAllowed(contents, browserInputScope(contents))).not.toThrow();
});

it('rejects input started without a controller after a subagent gains control', () => {
  const { page } = setup();
  const contents = page as never;
  setBrowserControls({ ...config, controls: [] });
  const scope = browserInputScope(contents)!;
  setBrowserControls({ ...config, controls: [{ ...config.controls[0]!, controller: { run: { agentId: 'second', generation: 1, turnId: 1 } } }] });
  expect(() => assertBrowserInputAllowed(contents, scope)).toThrow('Browser control changed');
});

it('revokes all controlled sessions even when their native views are absent', () => {
  setBrowserControls({ ...config, controls: [
    { browserId: 'parked', sessionId: 'one', turnId: 'turn', status: 'running' },
    { browserId: 'suspended', sessionId: 'two', turnId: 'turn', status: 'paused' },
    { browserId: 'idle', sessionId: 'three', turnId: null, status: 'idle' },
  ] });
  takeOverBrowser('parked');
  expect(browserControlOwnership.isBlocked('one')).toBe(true);
  takeOverAllBrowsers();
  expect(browserControlOwnership.isBlocked('two')).toBe(true);
  expect(browserControlOwnership.isBlocked('three')).toBe(false);
  expect(browserControlOwnership.revision('one')).toBe(1);
  setBrowserControls(null);
  expect(() => browserControlOwnership.assertAllowed('two')).toThrow('manually taken over');
});

it('treats closing a controlled tab as a takeover unless the agent closed it', () => {
  setBrowserControls({ ...config, controls: [
    { browserId: 'agent-closed', sessionId: 'one', turnId: 'turn', status: 'running' },
    { browserId: 'user-closed', sessionId: 'two', turnId: 'turn', status: 'running' },
  ] });
  const release = browserControlOwnership.expectAgentClose('agent-closed');
  takeOverClosedBrowser('agent-closed');
  expect(browserControlOwnership.isBlocked('one')).toBe(false);
  release();
  release();
  expect(browserControlOwnership.isAgentClosing('agent-closed')).toBe(false);
  takeOverClosedBrowser('user-closed');
  expect(browserControlOwnership.isBlocked('two')).toBe(true);
  setBrowserControls(null);
});

describe('browser activity feedback', () => {
  const activities = (view: any) => view.webContents.send.mock.calls.filter((call: any[]) => call[0] === IPC.browserControlActivity).map((call: any[]) => call[1]);
  const plain = (view: any) => activities(view).map(({ id: _id, ...message }: any) => message);
  const surfaceRevision = (view: any) => view.webContents.send.mock.calls.findLast((call: any[]) => call[0] === IPC.browserControlSurface)[1].revision;
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));

  it('announces the activity, then its target scaled to the surface, then clears it', async () => {
    const { host, view } = setup();
    const revision = surfaceRevision(view);
    const activity = beginBrowserActivity('page', { activity: 'clicking', scan: false });
    activity.target(Promise.resolve({ label: 'Send', rect: { x: 10, y: 20, width: 100, height: 40 } }));
    await settle();
    activity.end();
    activity.end();
    await settle();
    expect(plain(view)).toEqual([
      { browserId: 'page', revision, activity: 'clicking', scan: false },
      { browserId: 'page', revision, activity: 'clicking', scan: false, target: 'Send', rect: { x: 15, y: 30, width: 150, height: 60 } },
      { browserId: 'page', revision, activity: null },
    ]);
    const [first, second] = activities(view);
    expect(first.id).toEqual(expect.any(Number));
    expect(second.id).toBe(first.id);
    host.emit('closed');
  });

  it('shows the target of a quick operation that ends before its target is known', async () => {
    const { host, view } = setup();
    const activity = beginBrowserActivity('page', { activity: 'selecting', scan: false });
    let resolve: (value: { label: string }) => void = () => {};
    activity.target(new Promise(done => { resolve = done; }));
    activity.end();
    await settle();
    expect(plain(view).map((message: any) => message.activity)).toEqual(['selecting']);
    resolve({ label: 'City' });
    await settle();
    expect(plain(view).slice(1)).toEqual([
      expect.objectContaining({ activity: 'selecting', target: 'City' }),
      expect.objectContaining({ activity: null }),
    ]);
    host.emit('closed');
  });

  it('does not wait long for a target that never arrives, and ignores it afterwards', async () => {
    vi.useFakeTimers();
    try {
      const { host, view } = setup();
      const activity = beginBrowserActivity('page', { activity: 'selecting', scan: false });
      activity.target(new Promise(() => {}));
      activity.end();
      await vi.advanceTimersByTimeAsync(300);
      expect(plain(view).at(-1)).toEqual(expect.objectContaining({ activity: null }));
      host.emit('closed');
    } finally {
      vi.useRealTimers();
    }
  });

  it('binds a target to the operation that asked for it, not to whatever runs on top', async () => {
    const { host, view } = setup();
    const click = beginBrowserActivity('page', { activity: 'clicking', scan: false });
    let resolve: (value: { label: string }) => void = () => {};
    click.target(new Promise(done => { resolve = done; }));
    const wait = beginBrowserActivity('page', { activity: 'waiting', scan: false });
    resolve({ label: 'Send' });
    await settle();
    expect(plain(view).at(-1)).toEqual(expect.objectContaining({ activity: 'waiting' }));
    expect(plain(view).some((message: any) => message.activity === 'waiting' && message.target)).toBe(false);
    wait.end();
    await settle();
    expect(plain(view).at(-1)).toEqual(expect.objectContaining({ activity: 'clicking', target: 'Send' }));
    click.end();
    await settle();
    expect(plain(view).at(-1)).toEqual(expect.objectContaining({ activity: null }));
    host.emit('closed');
  });

  it('keeps the id of an activity that is shown again after a newer one ends', async () => {
    const { host, view } = setup();
    const read = beginBrowserActivity('page', { activity: 'reading', scan: true });
    const click = beginBrowserActivity('page', { activity: 'clicking', scan: false });
    click.end();
    await settle();
    const [first, second, third] = activities(view);
    expect([first.activity, second.activity, third.activity]).toEqual(['reading', 'clicking', 'reading']);
    expect(third.id).toBe(first.id);
    expect(second.id).not.toBe(first.id);
    read.end();
    host.emit('closed');
  });

  it('keeps the visible page activity when a background page works at the same time', async () => {
    const { host, view } = setup();
    const revision = surfaceRevision(view);
    const visible = beginBrowserActivity('page', { activity: 'waiting', scan: false });
    beginBrowserActivity('another-page', { activity: 'reading', scan: true }).end();
    await settle();
    expect(plain(view)).toEqual([{ browserId: 'page', revision, activity: 'waiting', scan: false }]);
    visible.end();
    await settle();
    expect(plain(view).at(-1)).toEqual({ browserId: 'page', revision, activity: null });
    host.emit('closed');
  });

  it('replays an activity that started before the surface was ready', async () => {
    const page = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => false, focus: vi.fn(), send: vi.fn(), executeJavaScriptInIsolatedWorld: vi.fn(async () => null) });
    const main = { isFocused: () => false, focus: vi.fn(), send: vi.fn() };
    const children: any[] = [{ webContents: main }, { webContents: page }];
    const host = Object.assign(new EventEmitter(), { isDestroyed: () => false, isFocused: () => false, getContentSize: () => [600, 500], isFullScreen: () => false, isMaximized: () => false, webContents: main, contentView: { children, addChildView(view: any) { children.push(view); }, removeChildView() {} } });
    attachBrowserControlWindow(host as never);
    attachBrowserControlPage('page', page as never, () => ({ visible: true, bounds: { x: 0, y: 0, width: 600, height: 500 }, feedbackScale: 1, focusScale: 1 }));
    setBrowserControls(config);
    const view = mock.views.at(-1);
    const read = beginBrowserActivity('page', { activity: 'reading', scan: true });
    expect(activities(view)).toEqual([]);
    markBrowserControlReady(view.webContents);
    expect(plain(view)).toEqual([{ browserId: 'page', revision: surfaceRevision(view), activity: 'reading', scan: true }]);
    read.end();
    host.emit('closed');
  });

  it('stays silent for pages that are not on the surface and after the user takes over', async () => {
    const { host, view } = setup();
    beginBrowserActivity('another-page', { activity: 'reading', scan: true }).end();
    takeOverBrowser('page');
    beginBrowserActivity('page', { activity: 'reading', scan: true }).end();
    await settle();
    expect(activities(view)).toEqual([]);
    host.emit('closed');
  });
});
