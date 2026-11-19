import { EventEmitter } from 'node:events';
import { createContext, runInContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ showOpenDialog: vi.fn(async () => ({ canceled: false, filePaths: ['/picked/a.txt'] })) }));
vi.mock('electron', () => ({ dialog: { showOpenDialog: mocks.showOpenDialog } }));
vi.mock('../../../src/main/diagnostics/log', () => ({ log: { warn: vi.fn(), error: vi.fn() } }));

import { browserFileFilters, browserPageDialogControlReady, browserPageDialogMarkersForTest, installBrowserPageDialogs, refreshBrowserPageDialogControl, watchBrowserNavigationRequests } from '../../../src/main/browser/browser-page-dialogs';
import { configureBrowserDialogs, hasPendingBrowserEvents, listBrowserDialogHistory, listBrowserDialogs, resetBrowserDialogsForTest, respondBrowserDialog, takeBrowserNotices } from '../../../src/main/browser/browser-dialogs';

class FakeDebugger extends EventEmitter {
  attached = false;
  attach = vi.fn(() => { this.attached = true; });
  detach = vi.fn(() => { this.attached = false; });
  isAttached = () => this.attached;
  sendCommand = vi.fn(async (method: string, _params?: Record<string, unknown>): Promise<unknown> => {
    if (method === 'Page.getFrameTree') {
      return { frameTree: { frame: { id: 'main', url: 'https://example.test/form', securityOrigin: 'https://example.test' }, childFrames: [{ frame: { id: 'child', url: 'https://pay.other.test/widget', securityOrigin: 'https://pay.other.test' } }] } };
    }
    if (method === 'Page.addScriptToEvaluateOnNewDocument') return { identifier: 'script-1' };
    if (method === 'DOM.resolveNode') return { object: { objectId: 'node-1' } };
    if (method === 'Runtime.callFunctionOn') return { result: { value: { accept: '.txt, image/*', directory: false } } };
    return {};
  });
}

class FakeContents extends EventEmitter {
  debugger = new FakeDebugger();
  destroyed = false;
  url = 'https://example.test/form';
  frames = [{ executeJavaScript: vi.fn(async () => undefined) }, { executeJavaScript: vi.fn(async () => { throw new Error('gone'); }) }, { executeJavaScript: vi.fn(async () => undefined) }];
  mainFrame = { framesInSubtree: this.frames };
  executeJavaScriptInIsolatedWorld = vi.fn(async () => undefined);
  isDestroyed = () => this.destroyed;
  getURL = () => this.url;
}

let agent = false;
let contents: FakeContents;
const onNavigationRequested = vi.fn();
const host = { isDestroyed: () => false, isVisible: () => true };

async function settle(): Promise<void> {
  for (let index = 0; index < 10; index += 1) await Promise.resolve();
}

function sent(method: string, target: FakeContents = contents) {
  return target.debugger.sendCommand.mock.calls.filter(([name]) => name === method).map(([, params]) => params);
}

beforeEach(async () => {
  resetBrowserDialogsForTest();
  agent = false;
  configureBrowserDialogs({ isAgentControlled: () => agent });
  contents = new FakeContents();
  contents.on('-run-dialog', () => { throw new Error('native dialog'); });
  installBrowserPageDialogs(contents as never, { browserId: 'browser-1', isAgentControlled: () => agent, host: () => host as never, onNavigationRequested });
  await settle();
});

afterEach(() => {
  contents.emit('destroyed');
  configureBrowserDialogs({ isAgentControlled: () => false });
  vi.clearAllMocks();
});

describe('browser page dialogs', () => {
  it('replaces native alert and confirm boxes with broker dialogs', async () => {
    const callback = vi.fn();
    contents.emit('-run-dialog', { frame: { origin: 'https://example.test' }, dialogType: 'confirm', messageText: 'Delete it?' }, callback);
    const [confirm] = listBrowserDialogs('browser-1');
    expect(confirm).toMatchObject({ kind: 'confirm', origin: 'https://example.test', message: 'Delete it?' });
    expect(callback).not.toHaveBeenCalled();
    await respondBrowserDialog(confirm!.dialogId, { accept: false }, 'agent');
    expect(callback).toHaveBeenCalledExactlyOnceWith(false, '');

    const alert = vi.fn();
    contents.emit('-run-dialog', { frame: { origin: 'https://example.test' }, dialogType: 'alert', messageText: 'Saved' }, alert);
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: false }, 'user');
    expect(alert).toHaveBeenCalledExactlyOnceWith(true, '');
  });

  it('brokers prompt dialogs and returns the typed text, the default text or null to the page', async () => {
    const typed = vi.fn();
    contents.emit('-run-dialog', { frame: { origin: 'https://example.test' }, dialogType: 'prompt', messageText: 'Name?', defaultPromptText: 'Ada' }, typed);
    const [prompt] = listBrowserDialogs('browser-1');
    expect(prompt).toMatchObject({ kind: 'prompt', origin: 'https://example.test', message: 'Name?', defaultValue: 'Ada', answerer: 'user' });
    expect(typed).not.toHaveBeenCalled();
    await respondBrowserDialog(prompt!.dialogId, { accept: true, text: 'Grace' }, 'user');
    expect(typed).toHaveBeenCalledExactlyOnceWith(true, 'Grace');

    const cancelled = vi.fn();
    contents.emit('-run-dialog', { frame: { origin: 'https://example.test' }, dialogType: 'prompt', messageText: 'Name?', defaultPromptText: 'Ada' }, cancelled);
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: false, text: 'ignored' }, 'user');
    expect(cancelled).toHaveBeenCalledExactlyOnceWith(false, '');

    agent = true;
    const kept = vi.fn();
    contents.emit('-run-dialog', { frame: { origin: 'https://example.test' }, dialogType: 'prompt', messageText: 'Name?', defaultPromptText: 'Ada' }, kept);
    expect(listBrowserDialogs('browser-1')[0]).toMatchObject({ kind: 'prompt', answerer: 'agent' });
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: true }, 'agent');
    expect(kept).toHaveBeenCalledExactlyOnceWith(true, 'Ada');
    expect(listBrowserDialogHistory('browser-1')).toEqual([expect.objectContaining({ kind: 'prompt', message: 'Name?', outcome: 'accepted', answerer: 'agent', text: 'Ada' })]);
  });

  it('drops alert, confirm and prompt dialogs the page cancelled', () => {
    const alert = vi.fn();
    const prompt = vi.fn();
    contents.emit('-run-dialog', { dialogType: 'alert', messageText: 'Hi' }, alert);
    contents.emit('-run-dialog', { dialogType: 'prompt', messageText: 'Name?', defaultPromptText: '' }, prompt);
    expect(listBrowserDialogs()).toHaveLength(2);
    contents.emit('-cancel-dialogs');
    expect(listBrowserDialogs()).toEqual([]);
    expect(alert).not.toHaveBeenCalled();
    expect(prompt).not.toHaveBeenCalled();
    expect(takeBrowserNotices('browser-1')).toEqual([]);
  });

  it('restores the native window.prompt from document start so it blocks like in Chrome', () => {
    const { promptRestore } = browserPageDialogMarkersForTest();
    const page = createContext({});
    runInContext(`
      globalThis.window = globalThis;
      globalThis.calls = [];
      window.prompt = function () { throw new Error('prompt() is not supported.'); };
      const nativePrompt = { prompt(message, value) { calls.push([this === window, message, value]); return 'answer'; } }.prompt;
      const children = [];
      globalThis.document = {
        documentElement: null,
        createElement: () => ({ contentWindow: { prompt: nativePrompt }, remove() { children.splice(children.indexOf(this), 1); } }),
        appendChild: (child) => { children.push(child); },
      };
      globalThis.children = children;
    `, page);
    runInContext(promptRestore, page);
    runInContext(promptRestore, page);
    expect(runInContext('[window.prompt.name, prompt("Name?", "Ada"), calls, children.length]', page)).toEqual(['prompt', 'answer', [[true, 'Name?', 'Ada']], 0]);
  });

  it('shares one debugger attachment and records main-frame navigation targets', () => {
    expect(contents.debugger.attach).toHaveBeenCalledOnce();
    expect(sent('Page.enable')).toHaveLength(1);
    contents.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'child', url: 'https://example.test/frame', reason: 'anchorClick', disposition: 'currentTab' });
    contents.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'main', url: 'https://example.test/next', reason: 'anchorClick', disposition: 'currentTab' });
    expect(onNavigationRequested).toHaveBeenCalledExactlyOnceWith('https://example.test/next', 'anchorClick');
  });

  it('queues the print guard together with the debugger attach so the first navigation cannot outrun it', () => {
    const fresh = new FakeContents();
    installBrowserPageDialogs(fresh as never, { browserId: 'browser-2', isAgentControlled: () => false, host: () => host as never });
    expect(fresh.debugger.sendCommand.mock.calls.map(([method]) => method)).toEqual(['Page.enable', 'Network.enable', 'Page.addScriptToEvaluateOnNewDocument']);
    fresh.emit('destroyed');
  });

  it('reports main-frame navigation requests of a popup window', async () => {
    const popup = new FakeContents();
    const requested = vi.fn();
    watchBrowserNavigationRequests(popup as never, requested, (url, post) => url.startsWith('https://other.test/') && (post || url.endsWith('/landing')));
    await settle();
    expect(popup.debugger.attach).toHaveBeenCalledOnce();
    expect(sent('Fetch.enable', popup)).toEqual([{ patterns: [{ resourceType: 'Document', requestStage: 'Request' }] }]);
    popup.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'child', url: 'https://example.test/frame', reason: 'anchorClick', disposition: 'currentTab' });
    popup.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'main', url: 'https://example.test/next', reason: 'formSubmissionPost', disposition: 'currentTab' });
    expect(requested).toHaveBeenCalledExactlyOnceWith('https://example.test/next', 'formSubmissionPost');
    popup.debugger.emit('message', {}, 'Network.requestWillBeSent', {
      frameId: 'main',
      type: 'Document',
      request: { url: 'https://example.test/next', method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'name=value' },
    });
    expect(requested).toHaveBeenLastCalledWith('https://example.test/next', 'formSubmissionPost');
    const paused = (requestId: string, url: string): void => {
      popup.debugger.emit('message', {}, 'Fetch.requestPaused', {
        requestId,
        frameId: 'main',
        resourceType: 'Document',
        request: { url, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, postData: 'name=value' },
      });
    };
    paused('same', 'https://example.test/next');
    paused('cross', 'https://other.test/submit');
    expect(sent('Fetch.continueRequest', popup)).toEqual([{ requestId: 'same' }]);
    expect(sent('Fetch.failRequest', popup)).toEqual([{ requestId: 'cross', errorReason: 'Aborted' }]);
    expect(requested).toHaveBeenLastCalledWith('https://other.test/submit', 'formSubmissionPost', { bytes: Buffer.from('name=value'), contentType: 'application/x-www-form-urlencoded' });
    popup.debugger.emit('message', {}, 'Fetch.requestPaused', { requestId: 'hop', frameId: 'main', resourceType: 'Document', request: { url: 'https://other.test/landing', method: 'GET', headers: {} } });
    expect(sent('Fetch.failRequest', popup)).toEqual([{ requestId: 'cross', errorReason: 'Aborted' }, { requestId: 'hop', errorReason: 'Aborted' }]);
    expect(requested).toHaveBeenLastCalledWith('https://other.test/landing', 'redirect');
    popup.debugger.emit('message', {}, 'Fetch.requestPaused', {
      requestId: 'upload',
      frameId: 'main',
      resourceType: 'Document',
      request: { url: 'https://other.test/upload', method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=x' }, postData: '--x\r\n', postDataEntries: [{ bytes: Buffer.from('--x\r\n').toString('base64') }, {}] },
    });
    expect(sent('Fetch.continueRequest', popup)).toEqual([{ requestId: 'same' }, { requestId: 'upload' }]);
    expect(requested).toHaveBeenLastCalledWith('https://other.test/landing', 'redirect');
  });

  it('retries popup navigation setup after a failed frame-tree read and ignores requests until the main frame is known', async () => {
    const popup = new FakeContents();
    const requested = vi.fn();
    const sendCommand = popup.debugger.sendCommand.getMockImplementation()!;
    popup.debugger.sendCommand.mockImplementationOnce(sendCommand).mockImplementationOnce(sendCommand).mockImplementationOnce(async () => { throw new Error('frame tree unavailable'); });
    watchBrowserNavigationRequests(popup as never, requested);
    await settle();
    popup.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'child', url: 'https://example.test/frame', reason: 'anchorClick', disposition: 'currentTab' });
    expect(requested).not.toHaveBeenCalled();
    popup.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await settle();
    expect(popup.debugger.attach).toHaveBeenCalledOnce();
    expect(popup.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.getFrameTree')).toHaveLength(2);
    popup.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'child', url: 'https://example.test/frame', reason: 'anchorClick', disposition: 'currentTab' });
    popup.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'main', url: 'https://example.test/next', reason: 'anchorClick', disposition: 'currentTab' });
    expect(requested).toHaveBeenCalledExactlyOnceWith('https://example.test/next', 'anchorClick');
  });

  it('intercepts file choosers only while the agent controls the tab and guards printing from document start', async () => {
    const guard = [{ source: browserPageDialogMarkersForTest().pageGuards, runImmediately: true }];
    expect(sent('Page.addScriptToEvaluateOnNewDocument')).toEqual(guard);
    expect(sent('Page.setInterceptFileChooserDialog')).toEqual([]);
    agent = true;
    refreshBrowserPageDialogControl();
    await settle();
    expect(sent('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }]);
    agent = false;
    refreshBrowserPageDialogControl();
    await settle();
    expect(sent('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }, { enabled: false }]);
    expect(sent('Page.addScriptToEvaluateOnNewDocument')).toEqual(guard);
    expect(sent('Page.removeScriptToEvaluateOnNewDocument')).toEqual([]);
  });

  it('keeps cached, reassigned and prototype print references on the guard', () => {
    const { printGuard, printMarker } = browserPageDialogMarkersForTest();
    const debug = vi.fn();
    const page = createContext({ console: { debug } });
    runInContext('globalThis.window = globalThis; globalThis.Window = function Window() {}; globalThis.nativePrints = 0; window.print = function print() { nativePrints += 1; };', page);
    runInContext(printGuard, page);
    runInContext(printGuard, page);
    runInContext(`
      const cached = window.print;
      window.print = function print() { nativePrints += 1; };
      delete window.print;
      try { Object.defineProperty(window, 'print', { value() { nativePrints += 1; } }); } catch {}
      try { Object.defineProperty(Window.prototype, 'print', { value() { nativePrints += 1; } }); } catch {}
      cached();
      window.print();
      Window.prototype.print.call(window);
    `, page);
    expect(runInContext('nativePrints', page)).toBe(0);
    expect(debug.mock.calls).toEqual([[printMarker], [printMarker], [printMarker]]);
  });

  it('hands page print calls to the native print dialog while the user controls the tab', () => {
    contents.emit('console-message', { message: browserPageDialogMarkersForTest().printMarker });
    expect(contents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledExactlyOnceWith(1002, [{ code: 'window.print()' }], true);
    expect(takeBrowserNotices('browser-1')).toEqual([]);
  });

  it('resolves the control gate only after file chooser interception is active for that tab', async () => {
    agent = true;
    let finish!: () => void;
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.setInterceptFileChooserDialog') await new Promise<void>(resolve => { finish = resolve; });
      return original(method, params);
    });
    refreshBrowserPageDialogControl();
    let ready = false;
    void browserPageDialogControlReady('browser-1').then(() => { ready = true; });
    await settle();
    expect(sent('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }]);
    expect(ready).toBe(false);
    finish();
    await vi.waitFor(() => expect(ready).toBe(true));
    await browserPageDialogControlReady('browser-1');
    expect(sent('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }]);
    await expect(browserPageDialogControlReady('browser-missing')).resolves.toBeUndefined();
  });

  it('enables interception from the control gate even before the control observer refreshes', async () => {
    agent = true;
    await browserPageDialogControlReady('browser-1');
    expect(sent('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }]);
  });

  it('retries the page guard setup on the next navigation when it failed while the debugger stayed attached', async () => {
    const fresh = new FakeContents();
    const navigated = vi.fn();
    fresh.debugger.sendCommand.mockImplementationOnce(async () => ({})).mockRejectedValueOnce(new Error('transient'));
    installBrowserPageDialogs(fresh as never, { browserId: 'browser-2', isAgentControlled: () => false, host: () => host as never, onNavigationRequested: navigated });
    await settle();
    expect(fresh.debugger.isAttached()).toBe(true);
    fresh.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await settle();
    const methods = fresh.debugger.sendCommand.mock.calls.map(([method]) => method);
    expect(methods.filter(method => method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(2);
    expect(methods.filter(method => method === 'Page.getFrameTree')).toHaveLength(1);
    fresh.debugger.emit('message', {}, 'Page.frameRequestedNavigation', { frameId: 'child', url: 'https://example.test/frame', reason: 'anchorClick', disposition: 'currentTab' });
    expect(navigated).not.toHaveBeenCalled();
    fresh.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await settle();
    expect(fresh.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(2);
    fresh.emit('destroyed');
  });

  it('retries the page guard setup from the control gate when it failed while the debugger stayed attached', async () => {
    const fresh = new FakeContents();
    const original = fresh.debugger.sendCommand.getMockImplementation()!;
    let failFrameTree = true;
    fresh.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.getFrameTree' && failFrameTree) { failFrameTree = false; throw new Error('transient'); }
      return original(method, params);
    });
    let freshAgent = false;
    installBrowserPageDialogs(fresh as never, { browserId: 'browser-3', isAgentControlled: () => freshAgent, host: () => host as never });
    await settle();
    freshAgent = true;
    await browserPageDialogControlReady('browser-3');
    const calls = fresh.debugger.sendCommand.mock.calls;
    expect(calls.filter(([method]) => method === 'Page.getFrameTree')).toHaveLength(2);
    expect(calls.filter(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(2);
    expect(calls.filter(([method]) => method === 'Page.setInterceptFileChooserDialog')).toEqual([['Page.setInterceptFileChooserDialog', { enabled: true }]]);
    fresh.emit('destroyed');
  });

  it('rejects controlled input when the page guard still cannot be installed after a retry', async () => {
    const fresh = new FakeContents();
    const original = fresh.debugger.sendCommand.getMockImplementation()!;
    fresh.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.addScriptToEvaluateOnNewDocument') throw new Error('transient');
      return original(method, params);
    });
    let freshAgent = false;
    installBrowserPageDialogs(fresh as never, { browserId: 'browser-4', isAgentControlled: () => freshAgent, host: () => host as never });
    await settle();
    freshAgent = true;
    await expect(browserPageDialogControlReady('browser-4')).rejects.toThrow('Page dialog guards could not be installed in this tab.');
    expect(fresh.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Page.addScriptToEvaluateOnNewDocument')).toHaveLength(3);
    fresh.emit('destroyed');
  });

  it('retries interception on the next refresh when a CDP command fails', async () => {
    agent = true;
    contents.debugger.sendCommand.mockRejectedValueOnce(new Error('detached'));
    refreshBrowserPageDialogControl();
    await settle();
    refreshBrowserPageDialogControl();
    await settle();
    expect(sent('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }, { enabled: true }]);
  });

  it('retries interception from the control gate and rejects when it still cannot be enabled', async () => {
    agent = true;
    contents.debugger.sendCommand.mockRejectedValueOnce(new Error('detached'));
    await expect(browserPageDialogControlReady('browser-1')).resolves.toBeUndefined();
    expect(sent('Page.setInterceptFileChooserDialog')).toEqual([{ enabled: true }, { enabled: true }]);
    agent = false;
    await browserPageDialogControlReady('browser-1');
    agent = true;
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.setInterceptFileChooserDialog' && params?.['enabled'] === true) throw new Error('detached');
      return original(method, params);
    });
    await expect(browserPageDialogControlReady('browser-1')).rejects.toThrow('File chooser interception is not active');
  });

  it('names the frame that opened the file chooser and refuses frames it cannot find', async () => {
    agent = true;
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'child', mode: 'selectSingle', backendNodeId: 5 });
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([expect.objectContaining({ kind: 'file', origin: 'https://pay.other.test' })]);
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: false }, 'agent');
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'remote', mode: 'selectSingle', backendNodeId: 6 });
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    expect(takeBrowserNotices('browser-1')).toEqual([expect.stringContaining('asked for a file upload')]);
  });

  it('turns an intercepted file input into a dialog the agent answers with paths', async () => {
    agent = true;
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectMultiple', backendNodeId: 7 });
    await settle();
    const [file] = listBrowserDialogs('browser-1');
    expect(file).toMatchObject({ kind: 'file', origin: 'https://example.test', accept: ['.txt', 'image/*'], multiple: true, answerer: 'agent' });
    await respondBrowserDialog(file!.dialogId, { accept: true, files: ['/work/a.txt', '/work/b.txt'] }, 'agent');
    expect(sent('DOM.setFileInputFiles')).toEqual([{ files: ['/work/a.txt', '/work/b.txt'], backendNodeId: 7 }]);
  });

  it('lets the user answer a file dialog with the native picker', async () => {
    agent = true;
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 9 });
    await settle();
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: true }, 'user');
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(host, expect.objectContaining({ properties: ['openFile'] }));
    expect(sent('DOM.setFileInputFiles')).toEqual([{ files: ['/picked/a.txt'], backendNodeId: 9 }]);
  });

  it('bounds a page-supplied accept list before it reaches the dialog and the native picker', async () => {
    agent = true;
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    const many = Array.from({ length: 5000 }, (_, index) => `.e${index}`).join(',');
    contents.debugger.sendCommand.mockImplementation(async (method, params) => method === 'Runtime.callFunctionOn' && String(params?.['functionDeclaration']).includes('webkitdirectory') ? { result: { value: { accept: many, directory: false } } } : original(method, params));
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 9 });
    await settle();
    await settle();
    const [file] = listBrowserDialogs('browser-1');
    expect(file!.accept).toEqual(Array.from({ length: 64 }, (_, index) => `.e${index}`));
    await respondBrowserDialog(file!.dialogId, { accept: true }, 'user');
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(host, expect.objectContaining({ filters: browserFileFilters(file!.accept!) }));
    expect(sent('Runtime.callFunctionOn').find(params => String(params?.['functionDeclaration']).includes('webkitdirectory'))?.['functionDeclaration']).toContain('.slice(0, 4096)');
  });

  it('ignores accept tokens past the length bound', async () => {
    agent = true;
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => method === 'Runtime.callFunctionOn' && String(params?.['functionDeclaration']).includes('webkitdirectory') ? { result: { value: { accept: `.txt,${'x'.repeat(5000)},.png`, directory: false } } } : original(method, params));
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 9 });
    await settle();
    await settle();
    const accept = listBrowserDialogs('browser-1')[0]!.accept!;
    expect(accept[0]).toBe('.txt');
    expect(accept).not.toContain('.png');
  });

  it.each([
    ['a file input', { accept: '.txt', directory: false }],
    ['a folder input', { accept: '', directory: true }],
    ['a capture input', { accept: 'image/*', directory: false }],
  ] as const)('reopens the native picker for %s the user clicks while interception is still being turned off', async (_name, input) => {
    agent = true;
    refreshBrowserPageDialogControl();
    await settle();
    let finishDisable!: () => void;
    const order: string[] = [];
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.setInterceptFileChooserDialog' && params?.['enabled'] === false) {
        await new Promise<void>(resolve => { finishDisable = resolve; });
        order.push('disabled');
        return {};
      }
      if (method === 'Runtime.callFunctionOn') {
        const declaration = String(params?.['functionDeclaration']);
        if (declaration.includes('showPicker')) order.push('showPicker');
        if (declaration.includes('"cancel"')) order.push('cancel');
        if (declaration.includes('webkitdirectory')) return { result: { value: input } };
        return { result: { value: true } };
      }
      return original(method, params);
    });
    agent = false;
    refreshBrowserPageDialogControl();
    await settle();
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 41 });
    await settle();
    expect(order).toEqual([]);
    finishDisable();
    await settle();
    await settle();
    expect(order).toEqual(['disabled', 'showPicker']);
    expect(sent('Runtime.callFunctionOn')).toContainEqual(expect.objectContaining({ userGesture: true, functionDeclaration: expect.stringContaining('showPicker') }));
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    expect(takeBrowserNotices('browser-1')).toEqual([]);
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
  });

  function holdDisable(): { finish: () => void } {
    const held = { finish: () => {} };
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.setInterceptFileChooserDialog' && params?.['enabled'] === false) await new Promise<void>(resolve => { held.finish = resolve; });
      return original(method, params);
    });
    return held;
  }

  it('holds page input until file chooser interception is off after control returns to the user, for a bounded time', async () => {
    const press = (name: 'before-input-event' | 'before-mouse-event') => {
      const event = { preventDefault: vi.fn() };
      contents.emit(name, event, { type: name === 'before-input-event' ? 'keyDown' : 'mouseDown' });
      return event.preventDefault.mock.calls.length > 0;
    };
    agent = true;
    refreshBrowserPageDialogControl();
    await settle();
    expect(press('before-mouse-event')).toBe(false);
    const disable = holdDisable();
    agent = false;
    refreshBrowserPageDialogControl();
    await settle();
    expect(press('before-mouse-event')).toBe(true);
    expect(press('before-input-event')).toBe(true);
    const now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 2_001);
    expect(press('before-mouse-event')).toBe(false);
    clock.mockRestore();
    disable.finish();
    await settle();
    expect(press('before-mouse-event')).toBe(false);
    expect(press('before-input-event')).toBe(false);
  });

  it('tells the user instead of the agent when a file system picker is swallowed while control returns to the user', async () => {
    agent = true;
    refreshBrowserPageDialogControl();
    await settle();
    const disable = holdDisable();
    agent = false;
    refreshBrowserPageDialogControl();
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle' });
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    disable.finish();
    await settle();
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([expect.objectContaining({ kind: 'alert', answerer: 'user', message: expect.stringContaining('Try again') })]);
    expect(takeBrowserNotices('browser-1')).toEqual([]);
  });

  it('cancels a file input handed back to the user when the native picker cannot reopen', async () => {
    const cancels = () => contents.debugger.sendCommand.mock.calls.filter(([name, params]) => name === 'Runtime.callFunctionOn' && String((params as { functionDeclaration?: string }).functionDeclaration).includes('"cancel"')).length;
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => method === 'Runtime.callFunctionOn' && String(params?.['functionDeclaration']).includes('showPicker') ? { result: { value: false } } : original(method, params));
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 42 });
    await settle();
    await settle();
    expect(cancels()).toBe(1);
    expect(listBrowserDialogs('browser-1')).toEqual([]);
  });

  it('retries turning interception off and serves the user with the app picker while it stays on', async () => {
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    agent = true;
    refreshBrowserPageDialogControl();
    await settle();
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.setInterceptFileChooserDialog' && params?.['enabled'] === false) throw new Error('detached');
      return original(method, params);
    });
    agent = false;
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 43 });
    await vi.waitFor(() => expect(sent('DOM.setFileInputFiles')).toEqual([{ files: ['/picked/a.txt'], backendNodeId: 43 }]), { timeout: 3_000 });
    expect(sent('Page.setInterceptFileChooserDialog').filter(params => params?.['enabled'] === false)).toHaveLength(3);
    expect(mocks.showOpenDialog).toHaveBeenCalledWith(host, expect.objectContaining({ properties: ['openFile'] }));
    expect(sent('Runtime.callFunctionOn').filter(params => String(params?.['functionDeclaration']).includes('showPicker'))).toEqual([]);
  });

  it('tells the user when interception stays on and the app picker cannot serve a folder input', async () => {
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    agent = true;
    refreshBrowserPageDialogControl();
    await settle();
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'Page.setInterceptFileChooserDialog' && params?.['enabled'] === false) throw new Error('detached');
      if (method === 'Runtime.callFunctionOn' && String(params?.['functionDeclaration']).includes('webkitdirectory')) return { result: { value: { accept: '', directory: true } } };
      return original(method, params);
    });
    agent = false;
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 44 });
    await vi.waitFor(() => expect(listBrowserDialogs('browser-1')).toEqual([expect.objectContaining({ kind: 'alert', answerer: 'user', message: expect.stringContaining('Try again') })]), { timeout: 3_000 });
    expect(mocks.showOpenDialog).not.toHaveBeenCalled();
    expect(sent('DOM.setFileInputFiles')).toEqual([]);
  });

  it('records the native picker result when the user answers a file dialog the agent saw', async () => {
    agent = true;
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 9 });
    await settle();
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: true }, 'user');
    expect(listBrowserDialogHistory('browser-1')).toEqual([expect.objectContaining({ kind: 'file', outcome: 'uploaded', answerer: 'user', files: ['/picked/a.txt'] })]);
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 10 });
    await settle();
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: true }, 'user');
    const cancelled = listBrowserDialogHistory('browser-1').at(-1);
    expect(cancelled).toMatchObject({ kind: 'file', outcome: 'dismissed', answerer: 'user' });
    expect(cancelled).not.toHaveProperty('files');
    expect(sent('DOM.setFileInputFiles')).toEqual([{ files: ['/picked/a.txt'], backendNodeId: 9 }]);
  });

  it('fires cancel on the file input when a file chooser is declined, times out, targets a folder or an unknown frame', async () => {
    const cancels = () => contents.debugger.sendCommand.mock.calls.filter(([name, params]) => name === 'Runtime.callFunctionOn' && String((params as { functionDeclaration?: string }).functionDeclaration).includes('"cancel"')).length;
    agent = true;
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 11 });
    await settle();
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: false }, 'agent');
    await settle();
    expect(cancels()).toBe(1);
    mocks.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] });
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 12 });
    await settle();
    await respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: true }, 'user');
    await settle();
    expect(cancels()).toBe(2);
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'remote', mode: 'selectSingle', backendNodeId: 13 });
    await settle();
    expect(cancels()).toBe(3);
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => method === 'Runtime.callFunctionOn' && String(params?.['functionDeclaration']).includes('webkitdirectory') ? { result: { value: { accept: '', directory: true } } } : original(method, params));
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 14 });
    await settle();
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    expect(cancels()).toBe(4);
    expect(sent('DOM.setFileInputFiles')).toEqual([]);
  });

  it('opens no file dialog when the page navigates, closes or loses the input while the chooser is inspected', async () => {
    const cancels = () => contents.debugger.sendCommand.mock.calls.filter(([name, params]) => name === 'Runtime.callFunctionOn' && String((params as { functionDeclaration?: string }).functionDeclaration).includes('"cancel"')).length;
    agent = true;
    const original = contents.debugger.sendCommand.getMockImplementation()!;
    let release: (() => void) | undefined;
    const holdOn = (target: string) => contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === target && !String(params?.['functionDeclaration'] ?? '').includes('"cancel"')) await new Promise<void>(resolve => { release = resolve; });
      return original(method, params);
    });
    holdOn('Page.getFrameTree');
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 21 });
    await settle();
    contents.emit('did-navigate');
    release!();
    await settle();
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    expect(cancels()).toBe(1);
    holdOn('DOM.resolveNode');
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 22 });
    await settle();
    contents.emit('did-navigate');
    release!();
    await settle();
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    contents.debugger.sendCommand.mockImplementation(async (method, params) => method === 'DOM.resolveNode' ? {} : original(method, params));
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 23 });
    await settle();
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    holdOn('Page.getFrameTree');
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 24 });
    await settle();
    contents.destroyed = true;
    contents.emit('destroyed');
    release!();
    await settle();
    await settle();
    expect(listBrowserDialogs('browser-1')).toEqual([]);
    expect(sent('DOM.setFileInputFiles')).toEqual([]);
  });

  it('attaches nothing and records a cancelled upload when the page changes while the file dialog is answered', async () => {
    agent = true;
    let pick: ((value: { canceled: boolean; filePaths: string[] }) => void) | undefined;
    mocks.showOpenDialog.mockImplementationOnce(() => new Promise(resolve => { pick = resolve; }));
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 31 });
    await settle();
    const picked = respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: true }, 'user');
    await settle();
    contents.emit('did-navigate');
    pick!({ canceled: false, filePaths: ['/picked/a.txt'] });
    await expect(picked).rejects.toThrow('nothing was uploaded');
    expect(listBrowserDialogHistory('browser-1').at(-1)).toMatchObject({ kind: 'file', outcome: 'cancelled' });

    const original = contents.debugger.sendCommand.getMockImplementation()!;
    contents.debugger.sendCommand.mockImplementation(async (method, params) => {
      if (method === 'DOM.setFileInputFiles') throw new Error('No node with given id found');
      return original(method, params);
    });
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 33 });
    await settle();
    await settle();
    await expect(respondBrowserDialog(listBrowserDialogs('browser-1')[0]!.dialogId, { accept: true, files: ['/work/a.txt'] }, 'agent')).rejects.toThrow('nothing was uploaded');
    expect(listBrowserDialogHistory('browser-1').at(-1)).toMatchObject({ kind: 'file', outcome: 'cancelled', answerer: 'auto' });
    expect(listBrowserDialogs('browser-1')).toEqual([]);

    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle', backendNodeId: 32 });
    await settle();
    await settle();
    const dialogId = listBrowserDialogs('browser-1')[0]!.dialogId;
    contents.debugger.detach();
    contents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    await expect(respondBrowserDialog(dialogId, { accept: true, files: ['/work/a.txt'] }, 'agent')).rejects.toThrow('nothing was uploaded');
    expect(sent('DOM.setFileInputFiles')).toEqual([{ files: ['/work/a.txt'], backendNodeId: 33 }]);
  });

  it('reports aborted file system pickers, blocked print, Bluetooth and sign-in requests to the agent', () => {
    agent = true;
    contents.debugger.emit('message', {}, 'Page.fileChooserOpened', { frameId: 'main', mode: 'selectSingle' });
    contents.emit('console-message', { message: browserPageDialogMarkersForTest().printMarker });
    const bluetooth = { preventDefault: vi.fn() };
    const choose = vi.fn();
    contents.emit('select-bluetooth-device', bluetooth, [], choose);
    contents.emit('login', {}, { url: 'https://example.test/private' }, { isProxy: false, host: 'example.test' });
    expect(bluetooth.preventDefault).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledExactlyOnceWith('');
    expect(listBrowserDialogs()).toEqual([]);
    const notices = takeBrowserNotices('browser-1');
    expect(notices).toEqual([
      expect.stringContaining('File System Access'),
      expect.stringContaining('print dialog'),
      expect.stringContaining('Bluetooth'),
      expect.stringContaining('HTTP authentication is not supported in the built-in browser'),
    ]);
  });

  it('cancels client certificate requests instead of sending the first certificate while the agent controls the tab', () => {
    const certificates = [{ subjectName: 'me' }];
    const userEvent = { preventDefault: vi.fn() };
    const userChoose = vi.fn();
    contents.emit('select-client-certificate', userEvent, 'https://example.test/', certificates, userChoose);
    expect(userEvent.preventDefault).not.toHaveBeenCalled();
    expect(userChoose).not.toHaveBeenCalled();
    agent = true;
    const agentEvent = { preventDefault: vi.fn() };
    const agentChoose = vi.fn();
    contents.emit('select-client-certificate', agentEvent, 'https://example.test/', certificates, agentChoose);
    expect(agentEvent.preventDefault).toHaveBeenCalledOnce();
    expect(agentChoose).toHaveBeenCalledExactlyOnceWith();
    expect(takeBrowserNotices('browser-1')).toEqual([expect.stringContaining('request was cancelled')]);
  });

  it('forgets pending dialogs when the page goes away', () => {
    contents.emit('-run-dialog', { dialogType: 'alert', messageText: 'Hi' }, vi.fn());
    contents.emit('destroyed');
    expect(listBrowserDialogs()).toEqual([]);
  });

  it('keeps undelivered notices for the tab when its page goes away', () => {
    agent = true;
    contents.emit('console-message', { message: browserPageDialogMarkersForTest().printMarker });
    contents.emit('destroyed');
    expect(hasPendingBrowserEvents()).toBe(true);
    expect(takeBrowserNotices('browser-1')).toEqual([expect.stringContaining('print dialog')]);
  });
});

describe('browserFileFilters', () => {
  it('maps extension accept tokens to picker filters and ignores MIME types', () => {
    expect(browserFileFilters(['.PNG', '.jpg', 'image/*'])).toEqual([{ name: 'png, jpg', extensions: ['png', 'jpg'] }, { name: '*', extensions: ['*'] }]);
    expect(browserFileFilters(['image/*'])).toBeUndefined();
  });
});
