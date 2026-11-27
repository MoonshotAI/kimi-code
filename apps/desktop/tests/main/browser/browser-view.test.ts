import * as contextMenus from '../../../src/main/shell/context-menu';
import { app, clipboard, shell } from 'electron';
import { browserUserAgentOverride } from '../../../src/shared/browser-user-agent';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureBrowserDebugger, setBrowserInputActive, suspendBrowserMouseTouch } from '../../../src/main/browser/browser-debugger';
import * as control from '../../../src/main/browser/browser-control';
import * as sites from '../../../src/main/browser/browser-sites';
import { cancelBrowserDialog, configureBrowserDialogs, hasPendingBrowserEvents, pushBrowserNotice, listBrowserDialogHistory, listBrowserDialogs, resetBrowserDialogsForTest, respondBrowserDialog, takeBrowserDialogRecords, takeBrowserNotices } from '../../../src/main/browser/browser-dialogs';
import { installBrowserPageDialogs, watchBrowserNavigationRequests } from '../../../src/main/browser/browser-page-dialogs';
import { browserEn } from '@moonshot-ai/app-i18n/browser';
import { BROWSER_ANNOTATION_WORLD } from '../../../src/main/browser/browser-annotation-script';
import { BROWSER_LINK_CLICK_QUERY_TIMEOUT_MS, browserLinkClickedScript, browserLinkClickTrackingScript } from '../../../src/main/browser/browser-link-click-script';

const mocks = vi.hoisted(() => {
  class FakeSession {
    handlers = new Map<string, (...args: unknown[]) => void>();
    fetch = vi.fn(async () => new Response(new Uint8Array([0, 0, 1, 0, 0, 0]), { headers: { 'Content-Type': 'image/x-icon' } }));
    permissionCheck = vi.fn();
    permissionRequest = vi.fn();
    webRequest = { onBeforeRequest: vi.fn(), onHeadersReceived: vi.fn(), onBeforeSendHeaders: vi.fn() };
    setUserAgent = vi.fn();
    closeAllConnections = vi.fn(async () => {});
    clearStorageData = vi.fn(async (_options?: unknown) => {});
    clearCache = vi.fn(async () => {});
    clearAuthCache = vi.fn(async () => {});
    getUserAgent = vi.fn(
      () =>
        'Mozilla/5.0 AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36 Electron/43.1.1 Kimi Code/0.0.20',
    );
    setPermissionCheckHandler(handler: (...args: unknown[]) => unknown): void {
      this.permissionCheck(handler);
    }
    setPermissionRequestHandler(handler: (...args: unknown[]) => unknown): void {
      this.permissionRequest(handler);
    }
    on(event: string, handler: (...args: unknown[]) => void): void {
      this.handlers.set(event, handler);
    }
  }

  let nextWebContentsId = 1;
  class FakeWebContents {
    id = nextWebContentsId++;
    session = new FakeSession();
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    url = '';
    title = '';
    loading = false;
    destroyed = false;
    userAgent = '';
    windowOpenHandler: ((details: { url: string; disposition?: string }) => { action: 'deny' }) | null = null;
    history = { canBack: false, canForward: false };
    zoomFactor = 1;
    setAudioMuted = vi.fn();
    debuggerListeners = new Map<string, Array<(...args: unknown[]) => void>>();
    debugger = {
      on: vi.fn((event: string, listener: (...args: unknown[]) => void) => {
        this.debuggerListeners.set(event, [...(this.debuggerListeners.get(event) ?? []), listener]);
      }),
      attached: false,
      isAttached: vi.fn(() => this.debugger.attached),
      attach: vi.fn(() => {
        if (this.devToolsOpened) throw new Error('Another debugger is already attached to this target');
        this.debugger.attached = true;
      }),
      detach: vi.fn(() => {
        this.debugger.attached = false;
        for (const listener of this.debuggerListeners.get('detach') ?? []) listener({}, 'target closed');
      }),
      sendCommand: vi.fn(async (method: string, _params?: Record<string, unknown>) => {
        if (mocks.queueCommandsWithoutRenderer && method === 'Emulation.setUserAgentOverride' && this.osProcessId === 0) await this.rendererStarted;
      }),
    };
    navigationHistory = {
      getAllEntries: vi.fn(() => this.url ? [{ url: this.url, title: this.title }] : []),
      getActiveIndex: vi.fn(() => 0),
      restore: vi.fn(async (options: { entries: Array<{url: string; title: string}>; index: number }) => {
        const url = options.entries[options.index]!.url;
        if (mocks.emitRestoreNavigation) this.emit('did-start-navigation', {}, url, false, true);
        await this.loadURL(url);
      }),
      canGoBack: vi.fn(() => this.history.canBack),
      canGoForward: vi.fn(() => this.history.canForward),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    loadURL = vi.fn(async (url: string) => {
      if (mocks.failNextLoad) { mocks.failNextLoad = false; throw new Error('Navigation cancelled'); }
      this.osProcessId = 4242;
      this.startRenderer();
      this.loading = true;
      this.emit('did-start-loading');
      this.url = url;
      this.title = url === 'about:blank' ? '' : `Title: ${url}`;
      this.emit('did-navigate', {}, url);
      this.emit('page-title-updated', { preventDefault: () => {} }, this.title);
      this.loading = false;
      this.emit('did-stop-loading');
    });
    reload = vi.fn(() => {
      this.emit('did-start-loading');
      this.emit('did-stop-loading');
    });
    executeJavaScriptInIsolatedWorld = vi.fn(async (_world: number, _scripts: Array<{ code: string }>, _userGesture?: boolean): Promise<unknown> => true);
    beginFrameSubscription = vi.fn();
    endFrameSubscription = vi.fn();
    focused = false;
    focus = vi.fn(() => { this.focused = true; });
    isFocused(): boolean { return this.focused; }
    findInPage = vi.fn();
    stopFindInPage = vi.fn();
    print = vi.fn((_options: unknown, callback: (success: boolean) => void) => callback(true));
    capturePage = vi.fn(async () => ({
      isEmpty: () => false,
      toPNG: () => Buffer.from('png'),
      resize: () => ({ toDataURL: () => 'data:image/png;base64,cG5n' }),
    }));
    stop = vi.fn(() => {
      this.loading = false;
      this.emit('did-stop-loading');
    });
    on(event: string, cb: (...args: unknown[]) => void): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    once(event: string, cb: (...args: unknown[]) => void): void {
      const listener = (...args: unknown[]): void => { this.removeListener(event, listener); cb(...args); };
      this.on(event, listener);
    }
    removeListener(event: string, cb: (...args: unknown[]) => void): void {
      this.handlers.set(event, (this.handlers.get(event) ?? []).filter(listener => listener !== cb));
    }
    listeners(event: string): ((...args: unknown[]) => void)[] {
      return [...(this.handlers.get(event) ?? [])];
    }
    removeAllListeners(event: string): void {
      this.handlers.delete(event);
    }
    setWindowOpenHandler(handler: (details: { url: string; disposition?: string }) => { action: 'deny' }): void {
      this.windowOpenHandler = handler;
    }
    setUserAgent(value: string): void {
      this.userAgent = value;
    }
    inspectElement = vi.fn();
    devToolsOpened = false;
    isDevToolsOpened(): boolean {
      return this.devToolsOpened;
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    subframeLoading = false;
    isLoading(): boolean {
      return this.loading || this.subframeLoading;
    }
    isLoadingMainFrame(): boolean {
      return this.loading;
    }
    crashed = false;
    isCrashed(): boolean {
      return this.crashed;
    }
    getURL(): string {
      return this.url;
    }
    osProcessId = 0;
    startRenderer!: () => void;
    rendererStarted = new Promise<void>((resolve) => { this.startRenderer = resolve; });
    getOSProcessId(): number {
      return this.osProcessId;
    }
    getTitle(): string {
      return this.title;
    }
    getZoomFactor(): number {
      return this.zoomFactor;
    }
    setZoomFactor(value: number): void {
      this.zoomFactor = value;
    }
    beforeUnload = false;
    close(options?: { waitForBeforeUnload?: boolean }): void {
      if (options?.waitForBeforeUnload === true && this.beforeUnload) {
        let allowed = false;
        this.emit('will-prevent-unload', { preventDefault: () => { allowed = true; } });
        if (!allowed) return;
      }
      if (this.debugger.attached) this.debugger.detach();
      this.emit('close');
      this.destroyed = true;
      this.emit('destroyed');
    }
  }

  class FakeWebContentsView {
    static instances: FakeWebContentsView[] = [];
    options: Record<string, unknown>;
    webContents = new FakeWebContents();
    bounds = { x: 0, y: 0, width: 0, height: 0 };
    visible = false;
    background = '';
    constructor(options: Record<string, unknown>) {
      this.options = options;
      this.webContents.session = (options['webPreferences'] as { session?: FakeSession })?.session ?? this.webContents.session;
      FakeWebContentsView.instances.push(this);
    }
    setBounds(bounds: { x: number; y: number; width: number; height: number }): void {
      this.bounds = bounds;
    }
    setVisible(visible: boolean): void {
      this.visible = visible;
    }
    getVisible(): boolean {
      return this.visible;
    }
    setBackgroundColor(color: string): void {
      this.background = color;
    }
  }

  class FakeBaseWindow {
    static instances: FakeBaseWindow[] = [];
    destroyed = false;
    contentView = {
      children: [] as unknown[],
      addChildView: (view: unknown, at?: number) => {
        const children = this.contentView.children;
        const index = children.indexOf(view);
        if (index !== -1) children.splice(index, 1);
        children.splice(at ?? children.length, 0, view);
      },
      removeChildView: (view: unknown) => { this.contentView.children = this.contentView.children.filter(child => child !== view); },
    };
    constructor(readonly options: unknown) { FakeBaseWindow.instances.push(this); }
    getContentSize(): [number, number] { return [1280, 720]; }
    setContentSize = vi.fn();
    isDestroyed(): boolean { return this.destroyed; }
    destroy(): void { this.destroyed = true; }
  }

  class FakeBrowserWindow extends FakeBaseWindow {
    static popups: FakeBrowserWindow[] = [];
    webContents = new FakeWebContents();
    closed: (() => void) | undefined;
    answerDialog: ((success: boolean) => void) | undefined;
    constructor(options: unknown) {
      super(options);
      FakeBrowserWindow.popups.push(this);
      this.webContents.on('-run-dialog', (_info, callback) => {
        void new Promise<boolean>(resolve => { this.answerDialog = resolve; }).then(success => (callback as (success: boolean, text: string) => void)(success, ''));
      });
    }
    isFocused() { return true; }
    isVisible() { return !this.destroyed; }
    setTitle = vi.fn();
    on = vi.fn();
    close = vi.fn();
    once(_event: string, callback: () => void) { this.closed = callback; }
    loadURL(url: string) { return this.webContents.loadURL(url); }
    override destroy() { super.destroy(); this.closed?.(); }
  }

  const fromPartition = vi.fn();
  return {
    FakeBaseWindow,
    FakeBrowserWindow,
    FakeSession,
    FakeWebContents,
    FakeWebContentsView,
    failNextLoad: false,
    queueCommandsWithoutRenderer: false,
    emitRestoreNavigation: false,
    autoplay: 'block' as 'allow' | 'block',
    sound: 'on' as 'on' | 'muted',
    siteSound: {} as Record<string, 'default' | 'on' | 'muted'>,
    fromPartition,
    clearSiteData: vi.fn(async (origin: string) => ({ origin, permissions: {}, cookieCount: 0 })),
    showMessageBoxSync: vi.fn(() => 0),
    showMessageBox: vi.fn(async () => ({ response: 0, checkboxChecked: false })),
    showErrorBox: vi.fn(),
    relocateBrowserDownload: vi.fn(() => true),
    showSaveDialog: vi.fn(async () => ({ canceled: false, filePath: '/tmp/browser.png' })),
    showSaveDialogSync: vi.fn((..._args: unknown[]): string | undefined => '/tmp/chosen/download.zip'),
    writeFile: vi.fn(async () => undefined),
    customBrowserUserAgent: vi.fn((): unknown => null),
    electronUserAgent: vi.fn(() => 'Mozilla/5.0 AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36 Electron/43.1.1 Kimi Code/0.0.20'),
    siteAutoplay: {} as Record<string, 'default' | 'allow' | 'block'>,
    getBrowserData: vi.fn(() => ({
      history: [],
      downloads: [],
      preferences: { agentControl: true, subagentControl: false, agentLocalFiles: false, askWhereToSave: true, autoplay: mocks.autoplay, sound: mocks.sound, defaultZoomFactor: 1, searchEngine: 'google', customUserAgent: null, userAgentPresets: [] },
    })),
    recordBrowserHistory: vi.fn(),
    updateBrowserHistoryFavicon: vi.fn(),
    trackBrowserDownload: vi.fn(),
    claimBrowserDownloadRetry: vi.fn((_item: unknown): { id: string; resume: boolean; savePath?: string } | undefined => undefined),
    retryBrowserDownload: vi.fn(async () => true),
    observeBrowserOverlayOutsidePointer: vi.fn(),
    showItemInFolder: vi.fn(),
    unlink: vi.fn(async () => {}),
    focusedWebContents: null as unknown,
    configureBrowserDownloadsDirectory: vi.fn<(resolve: () => string) => void>(),
    logWarn: vi.fn(),
    logError: vi.fn(),
  };
});

vi.mock('electron', () => ({
  clipboard: { writeText: vi.fn(async () => {}) }, shell: { openExternal: vi.fn(async () => {}), showItemInFolder: mocks.showItemInFolder },
  app: { getPath: vi.fn(() => '/tmp') },
  dialog: { showSaveDialog: mocks.showSaveDialog, showSaveDialogSync: mocks.showSaveDialogSync, showMessageBoxSync: mocks.showMessageBoxSync, showMessageBox: mocks.showMessageBox, showErrorBox: mocks.showErrorBox },
  nativeTheme: { shouldUseDarkColors: false },
  session: { fromPartition: mocks.fromPartition },
  WebContentsView: mocks.FakeWebContentsView,
  BaseWindow: mocks.FakeBaseWindow,
  BrowserWindow: mocks.FakeBrowserWindow,
  webContents: { getFocusedWebContents: () => mocks.focusedWebContents },
}));
vi.mock('node:fs/promises', () => ({ writeFile: mocks.writeFile, rename: vi.fn(async () => {}), copyFile: vi.fn(async () => {}), unlink: mocks.unlink }));
vi.mock('../../../src/main/browser/browser-page-dialogs', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/main/browser/browser-page-dialogs')>();
  return { ...original, installBrowserPageDialogs: vi.fn(), refreshBrowserPageDialogControl: vi.fn(), watchBrowserNavigationRequests: vi.fn() };
});
vi.mock('../../../src/main/browser/downloads', () => ({
  setAutomaticDownloadPath: vi.fn((item: { getFilename: () => string; setSavePath: (path: string) => void }, directory: string) => item.setSavePath(`${directory}/${item.getFilename()}`)),
}));
vi.mock('../../../src/main/browser/browser-user-agent', async () => {
  const { defaultBrowserUserAgentOverride } = await vi.importActual<typeof import('../../../src/shared/browser-user-agent')>('../../../src/shared/browser-user-agent');
  return {
    activeBrowserUserAgent: () => mocks.customBrowserUserAgent() ?? defaultBrowserUserAgentOverride(mocks.electronUserAgent(), 'arm'),
    customBrowserUserAgent: mocks.customBrowserUserAgent,
    electronUserAgent: mocks.electronUserAgent,
    resetCustomBrowserUserAgentCache: vi.fn(),
  };
});

vi.mock('../../../src/main/browser/browser-data', () => ({
  getBrowserData: mocks.getBrowserData,
  recordBrowserHistory: mocks.recordBrowserHistory,
  updateBrowserHistoryFavicon: mocks.updateBrowserHistoryFavicon,
  trackBrowserDownload: mocks.trackBrowserDownload,
  claimBrowserDownloadRetry: mocks.claimBrowserDownloadRetry,
  retryBrowserDownload: mocks.retryBrowserDownload,
  relocateBrowserDownload: mocks.relocateBrowserDownload,
  configureBrowserDownloadsDirectory: mocks.configureBrowserDownloadsDirectory,
  ensureBrowserDownloadsAccess: vi.fn(() => ({ path: '/agent', custom: false, fallback: false, access: 'granted' })),
  noteBrowserDownloadsFailure: vi.fn(),
}));
vi.mock('../../../src/main/browser/browser-sites', async importOriginal => {
  const original = await importOriginal<typeof import('../../../src/main/browser/browser-sites')>();
  return { ...original,
    clearBrowserSiteStorage: mocks.clearSiteData,
    configureBrowserSitePermissions: vi.fn(original.configureBrowserSitePermissions),
    browserAutoplayPolicy: (url: string) => {
      let origin = '';
      try { origin = new URL(url).origin; } catch {}
      const site = mocks.siteAutoplay[origin] ?? 'default';
      const global = mocks.getBrowserData().preferences.autoplay;
      if (site === 'block') return 'user-gesture-required';
      return site === 'allow' || global === 'allow' ? 'no-user-gesture-required' : 'document-user-activation-required';
    },
    browserSoundMuted: (url: string) => {
      let origin = '';
      try { origin = new URL(url).origin; } catch {}
      const site = mocks.siteSound[origin] ?? 'default';
      return (site === 'default' ? mocks.sound : site) === 'muted';
    },
  };
});
const overlayViews = vi.hoisted(() => new WeakSet<object>());
vi.mock('../../../src/main/browser/browser-overlay-state', () => ({
  isBrowserOverlayView: (view: object) => overlayViews.has(view),
  requestBrowserAnnotationOverlayRefresh: vi.fn(),
  observeBrowserOverlayOutsidePointer: mocks.observeBrowserOverlayOutsidePointer,
}));
vi.mock('../../../src/main/diagnostics/log', () => ({
  log: { warn: mocks.logWarn, error: mocks.logError },
  redactUrlForLog: (url: string) => url,
}));

import {
  applyDefaultBrowserZoom,
  cloneBrowser,
  browserTabCommand,
  restoreBrowser,
  suspendBrowser,
  attachBrowserWindow,
  browserGoBack,
  runBrowserHistoryNavigation,
  browserGoForward,
  browserFind,
  browserPrint,
  browserReload,
  browserStopLoading,
  browserStopFind,
  browserUserAgent,
  browserZoom,
  captureBrowserScreenshot,
  updateBrowserFocusEmulation,
  browserIdsForSite,
  clearBrowserData,
  clearBrowserSiteData,
  closeBrowser,
  destroyBrowserView,
  getBrowserPage,
  getBrowserGeneration,
  getBrowserState,
  setBrowserPagePersistence,
  setLocalPagesPolicy,
  setBrowserOccluded,
  isBrowserOccluded,
  browserHostLayerOrder,
  isAllowedBrowserUrl,
  keepBrowserPageRendering,
  navigateBrowser,
  normalizeBrowserAddress,
  openBrowserLocalFile,
  browserHistoryTargetIsLocalFile,
  takeLocalLinkGrant,
  grantBrowserUnload,
  takeBrowserUnloadGrant,
  setBrowserBounds,
  setBrowserVisible,
  toggleBrowserDeviceMode,
  updateBrowserDeviceMode,
  applyBrowserUserAgentPreference,
  applyBrowserAutoplayPolicy,
  applyBrowserSound,
  waitForBrowserLoad,
} from '../../../src/main/browser/browser-view';
import { setContextMenuLocale } from '../../../src/main/shell/context-menu';
import { setAutomaticDownloadPath } from '../../../src/main/browser/downloads';
import { noteBrowserDownloadsFailure } from '../../../src/main/browser/browser-data';
import { configureBrowserSitePermissions } from '../../../src/main/browser/browser-sites';
import { asBrowserBounds, asBrowserFavicon } from '../../../src/shared/browser';
import {
  asBrowserDeviceModeRequest,
  isBrowserDeviceState,
} from '../../../src/shared/browser-device';

function answerLinkClickQuery(contents: { executeJavaScriptInIsolatedWorld: ReturnType<typeof vi.fn> }, answer: boolean | Error | 'pending'): void {
  contents.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world: number, scripts: Array<{ code: string }>) => {
    if (!scripts[0]!.code.includes('last.url')) return true;
    if (answer === 'pending') return new Promise(() => {});
    if (answer instanceof Error) throw answer;
    return answer;
  });
}

function createHost() {
  const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
  const children: unknown[] = [];
  const host = {
    destroyed: false,
    focused: true,
    visible: true,
    isFocused() { return this.focused; },
    isVisible() { return this.visible; },
    handlers,
    webContents: {
      handlers: new Map<string, ((...args: unknown[]) => void)[]>(),
      send: vi.fn(),
      focus: vi.fn(),
      isDestroyed: () => false,
      zoomFactor: 1,
      getZoomFactor(): number { return this.zoomFactor; },
      on(event: string, cb: (...args: unknown[]) => void): void {
        this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      },
      emit(event: string, ...args: unknown[]): void {
        for (const cb of this.handlers.get(event) ?? []) cb(...args);
      },
    },
    contentView: {
      children,
      addChildView: vi.fn((view: unknown, at = children.length) => {
        const index = children.indexOf(view);
        if (index !== -1) children.splice(index, 1);
        children.splice(at, 0, view);
      }),
      removeChildView: vi.fn((view: unknown) => {
        const index = children.indexOf(view);
        if (index !== -1) children.splice(index, 1);
      }),
    },
    on(event: string, cb: (...args: unknown[]) => void): void {
      handlers.set(event, [...(handlers.get(event) ?? []), cb]);
    },
    once(event: string, cb: (...args: unknown[]) => void): void {
      this.on(event, cb);
    },
    removeListener(event: string, cb: (...args: unknown[]) => void): void {
      handlers.set(event, (handlers.get(event) ?? []).filter(handler => handler !== cb));
    },
    emit(event: string, ...args: unknown[]): void {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    isDestroyed(): boolean {
      return this.destroyed;
    },
  };
  return Object.assign(host, { hostView: { webContents: host.webContents } });
}

function closeFromPage(view: { webContents: unknown }): void {
  const contents = view.webContents as { emit: (event: string) => void; destroyed: boolean; debugger: { detach: () => void } };
  contents.emit('close');
  view.webContents = undefined;
  contents.debugger.detach();
  contents.destroyed = true;
  contents.emit('destroyed');
}

const downloadsDirectoryAtStartup = mocks.configureBrowserDownloadsDirectory.mock.calls[0]?.[0];

describe('browser-view downloads directory', () => {
  it('resolves the system downloads folder before any browser page exists', () => {
    vi.mocked(app.getPath).mockReturnValueOnce('/system/Downloads');
    expect(downloadsDirectoryAtStartup?.()).toBe('/system/Downloads');
    expect(app.getPath).toHaveBeenLastCalledWith('downloads');
  });
});

describe('browser-view unload grants', () => {
  it('matches a confirmed leave to the same method as well as the same URL', () => {
    const page = {} as never;
    grantBrowserUnload(page, { kind: 'url', url: 'https://example.test/submit', at: 0 }, 0);
    expect(takeBrowserUnloadGrant(page, { kind: 'url', url: 'https://example.test/submit', post: true, at: 1 }, 1)).toBe(false);
    expect(takeBrowserUnloadGrant(page, { kind: 'url', url: 'https://example.test/submit', at: 1 }, 1)).toBe(true);
    grantBrowserUnload(page, { kind: 'url', url: 'https://example.test/submit', post: true, at: 2 }, 2);
    expect(takeBrowserUnloadGrant(page, { kind: 'url', url: 'https://example.test/submit', at: 3 }, 3)).toBe(false);
    expect(takeBrowserUnloadGrant(page, { kind: 'url', url: 'https://example.test/submit', post: true, at: 3 }, 3)).toBe(true);
  });
});

describe('browser-view URL policy', () => {
  it('normalizes bare hosts and localhost while rejecting non-web schemes', () => {
    expect(normalizeBrowserAddress('example.com')).toBe('https://example.com/');
    expect(normalizeBrowserAddress('localhost:5174/test')).toBe('http://localhost:5174/test');
    expect(normalizeBrowserAddress('127.0.0.1:58627')).toBe('http://127.0.0.1:58627/');
    expect(normalizeBrowserAddress('browser annotation')).toBe('https://www.google.com/search?q=browser+annotation');
    expect(normalizeBrowserAddress('https://pubmed.ncbi.nlm.nih.gov/')).toBe(
      'https://pubmed.ncbi.nlm.nih.gov/',
    );
    expect(() => normalizeBrowserAddress('file:///etc/passwd')).toThrow('http(s)');
    expect(isAllowedBrowserUrl('javascript:alert(1)')).toBe(false);
    expect(() => normalizeBrowserAddress(`https://example.com/${'x'.repeat(5_000)}`)).toThrow(
      'too long',
    );
    expect(isAllowedBrowserUrl('https://dl.acm.org/')).toBe(true);
    expect(isAllowedBrowserUrl(`https://example.com/${'x'.repeat(5_000)}`)).toBe(false);
    expect(isAllowedBrowserUrl('about:blank')).toBe(false);
  });

  it.each(['site:github.com Kimi', 'site:github.com', 'TODO: repair button', 'label:value', 'javascript:alert(1)'])('treats non-web address text as a literal search: %s', (query) => {
    const url = new URL(normalizeBrowserAddress(query));
    expect(url.origin).toBe('https://www.google.com');
    expect(url.searchParams.get('q')).toBe(query);
  });

  it('removes Electron/app-shell tokens but preserves the Chromium identity', () => {
    const ua = browserUserAgent(
      'Mozilla/5.0 Chrome/144.0.0.0 Safari/537.36 Electron/43.1.1 kimi-code-app/0.0.20',
    );
    expect(ua).toContain('Chrome/144.0.0.0');
    expect(ua).not.toContain('Electron/');
    expect(ua).not.toContain('kimi-code-app/');
  });

  it('validates and rounds renderer geometry', () => {
    expect(asBrowserBounds({ x: 10.2, y: 20.7, width: 300.4, height: 199.6 })).toEqual({
      x: 10,
      y: 21,
      width: 300,
      height: 200,
    });
    expect(asBrowserBounds({ x: -1, y: 0, width: 1, height: 1 })).toBeNull();
    expect(asBrowserBounds({ x: 0, y: 0, width: Number.NaN, height: 1 })).toBeNull();
  });

  it('accepts only bounded web or image-data favicon URLs', () => {
    expect(asBrowserFavicon('https://example.com/favicon.ico')).toBe(
      'https://example.com/favicon.ico',
    );
    expect(asBrowserFavicon('data:image/png;base64,AA==')).toBe('data:image/png;base64,AA==');
    expect(asBrowserFavicon(`data:image/png;base64,${'A'.repeat(128 * 1_024)}`)).toBeNull();
    expect(asBrowserFavicon('javascript:alert(1)')).toBeNull();
    expect(asBrowserFavicon('data:text/html,<script>')).toBeNull();
  });

  it('validates bounded device emulation requests and state snapshots', () => {
    expect(
      asBrowserDeviceModeRequest({
        enabled: true,
        profileId: 'responsive',
        orientation: 'portrait',
        width: 393,
        height: 852,
        scaleMode: 'fit',
      }),
    ).toEqual({
      enabled: true,
      profileId: 'responsive',
      orientation: 'portrait',
      width: 393,
      height: 852,
      scaleMode: 'fit',
    });
    expect(
      asBrowserDeviceModeRequest({
        enabled: true,
        profileId: 'ipad-mini',
        orientation: 'landscape',
        scaleMode: 'fixed',
        scale: 0.5,
      }),
    ).not.toBeNull();
    expect(
      asBrowserDeviceModeRequest({
        enabled: true,
        profileId: 'responsive',
        orientation: 'portrait',
        width: 20,
        height: 852,
        scaleMode: 'fit',
      }),
    ).toBeNull();
    expect(
      asBrowserDeviceModeRequest({
        enabled: true,
        profileId: 'iphone-14-pro',
        orientation: 'portrait',
        width: 393,
        height: 852,
        scaleMode: 'fit',
      }),
    ).toBeNull();
    expect(
      isBrowserDeviceState({
        profileId: 'pixel-7',
        orientation: 'portrait',
        width: 412,
        height: 915,
        deviceScaleFactor: 2.625,
        mobile: true,
        touch: true,
        scaleMode: 'fit',
        requestedScale: 1,
        displayScale: 0.5,
        maxDisplayScale: 0.5,
      }),
    ).toBe(true);
  });
});

describe('browser-view lifecycle', () => {
  const browserId = 'browser-1';
  let browserSession: InstanceType<typeof mocks.FakeSession>;
  let host: ReturnType<typeof createHost>;

  beforeEach(() => {
    destroyBrowserView();
    mocks.FakeWebContentsView.instances = [];
    vi.clearAllMocks();
    mocks.emitRestoreNavigation = false;
    mocks.autoplay = 'block';
    mocks.siteAutoplay = {};
    mocks.sound = 'on';
    mocks.siteSound = {};
    setContextMenuLocale('en');
    browserSession = new mocks.FakeSession();
    mocks.fromPartition.mockReturnValue(browserSession);
    host = createHost();
    attachBrowserWindow(host as never);
  });

  afterEach(() => { destroyBrowserView(); resetBrowserDialogsForTest(); });

  it('treats a view whose native contents vanished as gone and rebuilds it on restore', async () => {
    await navigateBrowser(browserId, 'https://example.com/closed');
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    (view as { webContents: unknown }).webContents = undefined;
    expect(() => setBrowserVisible(browserId, true)).not.toThrow();
    expect(() => setBrowserVisible(browserId, false)).not.toThrow();
    expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
    restoreBrowser(browserId);
    expect(mocks.FakeWebContentsView.instances).toHaveLength(2);
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(rebuilt.webContents.loadURL).toHaveBeenCalledWith('https://example.com/closed'));
  });

  it('detaches a view whose native contents vanished from the window', async () => {
    await navigateBrowser(browserId, 'https://example.com/closed');
    setBrowserBounds(browserId, { x: 0, y: 0, width: 600, height: 400 });
    setBrowserVisible(browserId, true);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    expect(host.contentView.children).toContain(view);
    (view as { webContents: unknown }).webContents = undefined;
    restoreBrowser(browserId);
    expect(host.contentView.children).not.toContain(view);
    await vi.waitFor(() => expect(host.contentView.children).toContain(mocks.FakeWebContentsView.instances.at(-1)));
  });

  it.each([
    ['block', 'default', 'document-user-activation-required'],
    ['allow', 'default', 'no-user-gesture-required'],
    ['allow', 'block', 'user-gesture-required'],
    ['block', 'block', 'user-gesture-required'],
    ['block', 'allow', 'no-user-gesture-required'],
  ] as const)('constructs tabs with global=%s and site=%s autoplay policy', async (global, site, expected) => {
    mocks.autoplay = global;
    mocks.siteAutoplay['https://example.com'] = site;
    await navigateBrowser(browserId, 'https://example.com/media');
    const options = mocks.FakeWebContentsView.instances.at(-1)!.options['webPreferences'] as { autoplayPolicy: string };
    expect(options.autoplayPolicy).toBe(expected);
  });

  it('constructs popups with the effective autoplay policy and rebuilds them on origin changes', async () => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      const popupCount = mocks.FakeBrowserWindow.popups.length;
      menu.mock.calls[0]![3]!('https://allow.test/popup', 'window');
      const first = mocks.FakeBrowserWindow.popups.at(-1)!;
      await vi.waitFor(() => expect(first.webContents.loadURL).toHaveBeenCalled());
      expect((first.options as { webPreferences: { autoplayPolicy: string } }).webPreferences.autoplayPolicy).toBe('no-user-gesture-required');
      first.webContents.beforeUnload = true;
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      first.webContents.url = 'https://block.test/redirected';
      first.webContents.emit('did-start-navigation', {}, 'https://block.test/redirected', false, true);
      await vi.waitFor(() => expect(mocks.FakeBrowserWindow.popups.length).toBeGreaterThan(popupCount + 1));
      const rebuilt = mocks.FakeBrowserWindow.popups.at(-1)!;
      expect((rebuilt.options as { webPreferences: { autoplayPolicy: string } }).webPreferences.autoplayPolicy).toBe('document-user-activation-required');
      await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalled());
    } finally { menu.mockRestore(); }
  });

  it('rebuilds only the latest popup navigation after a refused policy rebuild', async () => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      const popupCount = mocks.FakeBrowserWindow.popups.length;
      menu.mock.calls[0]![3]!('https://allow.test/popup', 'window');
      const first = mocks.FakeBrowserWindow.popups.at(-1)!;
      first.webContents.beforeUnload = true;
      first.webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'https://block.test/refused');
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledOnce());
      await mocks.showMessageBox.mock.results.at(-1)!.value;
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      first.webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'https://block.test/accepted');
      await vi.waitFor(() => expect(mocks.FakeBrowserWindow.popups.length).toBe(popupCount + 2));
      const rebuilt = mocks.FakeBrowserWindow.popups.at(-1)!;
      await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({
        entries: [
          { url: 'https://allow.test/popup', title: 'Title: https://allow.test/popup' },
          { url: 'https://block.test/accepted', title: '' },
        ],
        index: 1,
      }));
    } finally { menu.mockRestore(); }
  });

  it('suppresses popup policy rebuilds while replaying POST history', async () => {
    mocks.emitRestoreNavigation = true;
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      const popupCount = mocks.FakeBrowserWindow.popups.length;
      menu.mock.calls[0]![3]!('https://allow.test/popup', 'window');
      const first = mocks.FakeBrowserWindow.popups.at(-1)!;
      const requested = vi.mocked(watchBrowserNavigationRequests).mock.lastCall![1];
      const bytes = Buffer.from('name=value');
      requested('https://block.test/submit', 'formSubmissionPost', { bytes, contentType: 'application/x-www-form-urlencoded' });
      await vi.waitFor(() => expect(mocks.FakeBrowserWindow.popups.length).toBe(popupCount + 2));
      const rebuilt = mocks.FakeBrowserWindow.popups.at(-1)!;
      await vi.waitFor(() => expect(rebuilt.webContents.loadURL).toHaveBeenCalledWith('https://block.test/submit', {
        postData: [{ type: 'rawData', bytes }],
        extraHeaders: 'Content-Type: application/x-www-form-urlencoded',
      }));
      await new Promise(resolve => setImmediate(resolve));
      expect(mocks.FakeBrowserWindow.popups.length).toBe(popupCount + 2);
    } finally { menu.mockRestore(); }
  });

  it('immediately rebuilds existing tabs after a global autoplay change', async () => {
    await navigateBrowser(browserId, 'https://example.com/media');
    mocks.autoplay = 'allow';
    applyBrowserAutoplayPolicy();
    expect(mocks.FakeWebContentsView.instances).toHaveLength(2);
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    expect((rebuilt.options['webPreferences'] as { autoplayPolicy: string }).autoplayPolicy).toBe('no-user-gesture-required');
    await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({ entries: [{ url: 'https://example.com/media', title: 'Title: https://example.com/media' }], index: 0 }));
  });

  it('mutes tabs by origin on creation, navigation and setting changes', async () => {
    mocks.sound = 'muted';
    mocks.siteSound['http://localhost:5173'] = 'on';
    await navigateBrowser(browserId, 'https://example.com/media');
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(getBrowserState(browserId).muted).toBe(true);
    view.webContents.url = 'http://localhost:5173/video';
    view.webContents.emit('did-navigate', {}, view.webContents.url);
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
    view.webContents.url = 'http://127.0.0.1:5173/video';
    view.webContents.emit('did-navigate', {}, view.webContents.url);
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    mocks.sound = 'on';
    applyBrowserSound();
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(getBrowserState(browserId).muted).toBe(false);
    mocks.siteSound['http://127.0.0.1:5173'] = 'muted';
    applyBrowserSound();
    expect(view.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
  });

  it('applies the destination sound setting to autoplay rebuilds and popups', async () => {
    mocks.sound = 'muted';
    mocks.siteSound['https://allow.test'] = 'on';
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com/media');
      const first = mocks.FakeWebContentsView.instances.at(-1)!;
      first.webContents.url = 'https://allow.test/video';
      first.webContents.emit('did-start-navigation', {}, 'https://allow.test/video', false, true);
      await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
      expect(mocks.FakeWebContentsView.instances.at(-1)!.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
      menu.mock.calls.at(-1)![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      expect(popup.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
      popup.webContents.url = 'https://allow.test/popup';
      popup.webContents.emit('did-navigate', {}, popup.webContents.url);
      expect(popup.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
      mocks.siteSound['https://allow.test'] = 'muted';
      applyBrowserSound();
      expect(popup.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    } finally { menu.mockRestore(); }
  });

  it('does not carry an origin autoplay exception across navigation', async () => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    await navigateBrowser(browserId, 'https://allow.test/start');
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    first.webContents.url = 'https://other.test/redirected';
    first.webContents.emit('did-start-navigation', {}, 'https://other.test/redirected', false, true);
    const loaded = waitForBrowserLoad(browserId, 'complete', 5_000);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    expect((rebuilt.options['webPreferences'] as { autoplayPolicy: string }).autoplayPolicy).toBe('document-user-activation-required');
    await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalled());
    expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-close-requested', expect.anything());
    rebuilt.webContents.url = 'https://other.test/redirected';
    rebuilt.webContents.emit('did-stop-loading');
    await expect(loaded).resolves.toMatchObject({ url: 'https://other.test/redirected' });
  });

  it('does not rebuild into a navigation blocked by URL validation', async () => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    await navigateBrowser(browserId, 'https://allow.test/start');
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    for (const url of ['about:blank', 'file:///etc/hosts']) {
      first.webContents.emit('did-start-navigation', {}, url, false, true);
      const event = { preventDefault: vi.fn() };
      first.webContents.emit('will-navigate', event, url);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      await new Promise(resolve => setImmediate(resolve));
    }
    expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
  });

  it('preserves back history when a policy rebuild precedes navigation', async () => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    await navigateBrowser(browserId, 'https://allow.test/first');
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    const source = { url: 'https://allow.test/first', title: 'First', pageState: 'first-state' };
    first.webContents.navigationHistory.getAllEntries.mockReturnValue([source]);
    const event = { preventDefault: vi.fn() };
    first.webContents.emit('will-navigate', event, 'https://block.test/second');
    expect(event.preventDefault).toHaveBeenCalledOnce();
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({
      entries: [
        { url: 'https://allow.test/first', title: 'First', pageState: 'first-state' },
        { url: 'https://block.test/second', title: '' },
      ],
      index: 1,
    }));
  });

  it.each([
    ['back', 1, 0, 'https://allow.test/first'],
    ['forward', 0, 1, 'https://block.test/second'],
  ] as const)('restores the target index when going %s across autoplay policies', async (action, active, target, url) => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    const entries = [{ url: 'https://allow.test/first', title: 'First' }, { url: 'https://block.test/second', title: 'Second' }];
    await navigateBrowser(browserId, entries[active]!.url);
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    first.webContents.navigationHistory.getAllEntries.mockReturnValue(entries);
    first.webContents.navigationHistory.getActiveIndex.mockReturnValue(active);
    first.webContents.history = { canBack: action === 'back', canForward: action === 'forward' };
    if (action === 'back') browserGoBack(browserId);
    else browserGoForward(browserId);
    first.webContents.emit('did-start-navigation', {}, url, false, true);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({ entries, index: target }));
  });

  it('rechecks redirects and waits for beforeunload confirmation before rebuilding', async () => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    await navigateBrowser(browserId, 'https://allow.test/first');
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    first.webContents.beforeUnload = true;
    const event = { preventDefault: vi.fn() };
    first.webContents.emit('will-redirect', event, 'https://block.test/final', false, true);
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
    const prompt = listBrowserDialogs(browserId).find(dialog => dialog.kind === 'beforeunload');
    expect(prompt).toBeDefined();
    await respondBrowserDialog(prompt!.dialogId, { accept: true }, 'user');
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    expect((rebuilt.options['webPreferences'] as { autoplayPolicy: string }).autoplayPolicy).toBe('document-user-activation-required');
    await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({
      entries: [
        { url: 'https://allow.test/first', title: 'Title: https://allow.test/first' },
        { url: 'https://block.test/final', title: '' },
      ],
      index: 1,
    }));
  });

  it('rebuilds only the latest navigation after a refused policy rebuild', async () => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    await navigateBrowser(browserId, 'https://allow.test/first');
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    first.webContents.beforeUnload = true;
    first.webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'https://block.test/refused');
    const refused = listBrowserDialogs(browserId).find(dialog => dialog.kind === 'beforeunload')!;
    await respondBrowserDialog(refused.dialogId, { accept: false }, 'user');
    first.webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'https://block.test/accepted');
    const accepted = listBrowserDialogs(browserId).find(dialog => dialog.kind === 'beforeunload')!;
    await respondBrowserDialog(accepted.dialogId, { accept: true }, 'user');
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({
      entries: [
        { url: 'https://allow.test/first', title: 'Title: https://allow.test/first' },
        { url: 'https://block.test/accepted', title: '' },
      ],
      index: 1,
    }));
  });

  it('lets a same-policy POST follow a cross-policy redirect so the redirected request is captured', async () => {
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    await navigateBrowser(browserId, 'https://allow.test/form');
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    const options = vi.mocked(installBrowserPageDialogs).mock.lastCall![1];
    options.onNavigationRequested!('https://allow.test/submit', 'formSubmissionPost');
    const event = { preventDefault: vi.fn() };
    first.webContents.emit('will-redirect', event, 'https://block.test/landing', false, true);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(options.interceptPost!('https://block.test/landing', false)).toBe(true);
    options.onNavigationRequested!('https://block.test/landing', 'redirect');
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({
      entries: [
        { url: 'https://allow.test/form', title: 'Title: https://allow.test/form' },
        { url: 'https://block.test/landing', title: '' },
      ],
      index: 1,
    }));
  });

  it('replays POST data after a cross-policy navigation rebuild', async () => {
    mocks.emitRestoreNavigation = true;
    mocks.siteAutoplay['https://allow.test'] = 'allow';
    await navigateBrowser(browserId, 'https://allow.test/form');
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    const options = vi.mocked(installBrowserPageDialogs).mock.lastCall![1];
    expect(options.interceptPost!('https://block.test/submit', true)).toBe(true);
    expect(options.interceptPost!('https://allow.test/next', true)).toBe(false);
    expect(options.interceptPost!('https://block.test/submit', false)).toBe(false);
    const bytes = Buffer.from('name=value');
    options.onNavigationRequested!('https://block.test/submit', 'formSubmissionPost', { bytes, contentType: 'application/x-www-form-urlencoded' });
    const event = { preventDefault: vi.fn() };
    first.webContents.emit('will-navigate', event, 'https://block.test/submit');
    expect(event.preventDefault).not.toHaveBeenCalled();
    first.webContents.emit('did-start-navigation', {}, 'https://block.test/submit', false, true);
    const committed = waitForBrowserLoad(browserId, 'committed', 5_000);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    await expect(committed).resolves.toMatchObject({ url: 'https://block.test/submit' });
    await vi.waitFor(() => expect(rebuilt.webContents.loadURL).toHaveBeenCalledWith('https://block.test/submit', {
      postData: [{ type: 'rawData', bytes }],
      extraHeaders: 'Content-Type: application/x-www-form-urlencoded',
    }));
    expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({
      entries: [{ url: 'https://allow.test/form', title: 'Title: https://allow.test/form' }],
      index: 0,
    });
    await new Promise(resolve => setImmediate(resolve));
    expect(mocks.FakeWebContentsView.instances).toHaveLength(2);
  });

  it('asks the window to close the tab when the page closes itself', async () => {
    await navigateBrowser(browserId, 'https://example.com/self-close');
    closeFromPage(mocks.FakeWebContentsView.instances.at(-1)!);
    expect(host.webContents.send).toHaveBeenCalledWith('kimi:browser-close-requested', { browserId });
  });

  it('keeps the tab and reopens its history when a page with earlier history closes itself', async () => {
    await navigateBrowser(browserId, 'https://example.com/first');
    await navigateBrowser(browserId, 'https://example.com/second');
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    const entries = [{ url: 'https://example.com/first', title: '' }, { url: 'https://example.com/second', title: '' }];
    view.webContents.navigationHistory.getAllEntries.mockReturnValue(entries);
    view.webContents.navigationHistory.getActiveIndex.mockReturnValue(1);
    closeFromPage(view);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const rebuilt = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(rebuilt.webContents.navigationHistory.restore).toHaveBeenCalledWith({ entries, index: 1 }));
    expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-close-requested', expect.anything());
  });

  it('reopens earlier history on an immediate second self-close', async () => {
    await navigateBrowser(browserId, 'https://example.com/first');
    await navigateBrowser(browserId, 'https://example.com/second');
    const entries = [{ url: 'https://example.com/first', title: '' }, { url: 'https://example.com/second', title: '' }];
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    first.webContents.navigationHistory.getAllEntries.mockReturnValue(entries);
    first.webContents.navigationHistory.getActiveIndex.mockReturnValue(1);
    closeFromPage(first);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const second = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(second.webContents.navigationHistory.restore).toHaveBeenCalledWith({ entries, index: 1 }));
    second.webContents.navigationHistory.getAllEntries.mockReturnValue(entries);
    second.webContents.navigationHistory.getActiveIndex.mockReturnValue(1);
    closeFromPage(second);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(3));
    const third = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(third.webContents.navigationHistory.restore).toHaveBeenCalledWith({ entries, index: 1 }));
    expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-close-requested', expect.anything());
  });

  it('asks to close a page whose remaining history is forward-only', async () => {
    await navigateBrowser(browserId, 'https://example.com/first');
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    const entries = [{ url: 'https://example.com/first', title: '' }, { url: 'https://example.com/forward', title: '' }];
    view.webContents.navigationHistory.getAllEntries.mockReturnValue(entries);
    view.webContents.navigationHistory.getActiveIndex.mockReturnValue(0);
    closeFromPage(view);
    expect(host.webContents.send).toHaveBeenCalledWith('kimi:browser-close-requested', { browserId });
    await new Promise(resolve => setImmediate(resolve));
    expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
  });

  it('does not ask to close the tab when the app closes or rebuilds the page', async () => {
    await navigateBrowser(browserId, 'https://example.com/kept');
    suspendBrowser(browserId);
    restoreBrowser(browserId);
    closeBrowser(browserId);
    await navigateBrowser(browserId, 'https://example.com/kept');
    destroyBrowserView();
    expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-close-requested', expect.anything());
  });

  it('rebuilds a closed page on reload', async () => {
    await navigateBrowser(browserId, 'https://example.com/closed');
    closeFromPage(mocks.FakeWebContentsView.instances.at(-1)!);
    browserReload(browserId);
    expect(mocks.FakeWebContentsView.instances).toHaveLength(2);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances.at(-1)!.webContents.loadURL).toHaveBeenCalledWith('https://example.com/closed'));
  });

  it('reports rejected navigation and restores the committed address', async () => {
    await navigateBrowser(browserId, 'https://example.com/original');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.loadURL.mockRejectedValueOnce(new Error('Navigation cancelled'));
    const result = await navigateBrowser(browserId, 'https://example.com/new');
    expect(result).toMatchObject({ url: 'https://example.com/original', loading: false, error: 'Navigation cancelled' });
  });

  it('keeps the current page when it declines to unload', async () => {
    await navigateBrowser(browserId, 'https://example.com/original');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.loadURL.mockRejectedValueOnce(Object.assign(new Error('ERR_ABORTED (-3) loading https://example.com/new'), { code: 'ERR_ABORTED', errno: -3 }));
    const onCancelled = vi.fn();
    const result = await navigateBrowser(browserId, 'https://example.com/new', { onCancelled });
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ url: 'https://example.com/original', title: 'Title: https://example.com/original', loading: false });
    expect(result.error).toBeUndefined();
    await expect(waitForBrowserLoad(browserId, 'complete', 100)).resolves.toMatchObject({ url: 'https://example.com/original' });
    expect(getBrowserPage(browserId)?.webContents).toBe(contents);
  });

  it('still reports an aborted first load as a failure', async () => {
    mocks.failNextLoad = false;
    const onCancelled = vi.fn();
    await navigateBrowser('fresh-tab', 'about:blank');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.url = '';
    contents.loadURL.mockRejectedValueOnce(Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 }));
    const result = await navigateBrowser('fresh-tab', 'https://example.com', { onCancelled });
    expect(onCancelled).not.toHaveBeenCalled();
    expect(result.error).toBe('ERR_ABORTED (-3)');
  });

  function turnNextLoadIntoDownload(contents: InstanceType<typeof mocks.FakeWebContentsView>['webContents']): void {
    contents.loadURL.mockImplementationOnce(async (url: string) => {
      contents.loading = true;
      contents.emit('did-start-loading');
      contents.emit('did-start-navigation', {}, url, false, true);
      contents.loading = false;
      contents.emit('did-stop-loading');
      const item = { ...downloadItem('file.zip'), getURLChain: () => [url, 'https://cdn.example.com/file.zip'], getURL: () => 'https://cdn.example.com/file.zip' };
      setTimeout(() => browserSession.handlers.get('will-download')?.({}, item, contents), 0);
      throw Object.assign(new Error(`ERR_FAILED (-2) loading '${url}'`), { code: 'ERR_FAILED', errno: -2 });
    });
  }

  it('keeps the current page when an entered address turns into a download', async () => {
    setBrowserBounds(browserId, { x: 0, y: 0, width: 640, height: 480 });
    setBrowserVisible(browserId, true);
    await navigateBrowser(browserId, 'https://example.com/original');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    mocks.recordBrowserHistory.mockClear();
    mocks.logWarn.mockClear();
    turnNextLoadIntoDownload(contents);
    const onCancelled = vi.fn();
    const result = await navigateBrowser(browserId, 'https://example.com/file.zip', { onCancelled });
    expect(result).toMatchObject({ url: 'https://example.com/original', title: 'Title: https://example.com/original', loading: false });
    expect(result.error).toBeUndefined();
    expect(onCancelled).not.toHaveBeenCalled();
    expect(mocks.trackBrowserDownload).toHaveBeenCalledOnce();
    expect(mocks.recordBrowserHistory).not.toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com/file.zip' }));
    expect(mocks.logWarn).not.toHaveBeenCalled();
    expect(getBrowserPage(browserId)?.visible).toBe(true);
    await expect(waitForBrowserLoad(browserId, 'complete', 100)).resolves.toMatchObject({ url: 'https://example.com/original' });
    await expect(navigateBrowser(browserId, 'https://example.com/next')).resolves.toMatchObject({ url: 'https://example.com/next', error: undefined });
  });

  it('returns a fresh tab to its empty state when its first address turns into a download', async () => {
    await navigateBrowser(browserId, 'about:blank');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.url = '';
    setBrowserBounds(browserId, { x: 0, y: 0, width: 640, height: 480 });
    setBrowserVisible(browserId, true);
    mocks.recordBrowserHistory.mockClear();
    turnNextLoadIntoDownload(contents);
    const result = await navigateBrowser(browserId, 'https://example.com/file.zip');
    expect(result).toMatchObject({ url: '', title: '', loading: false });
    expect(result.error).toBeUndefined();
    expect(mocks.recordBrowserHistory).not.toHaveBeenCalled();
    expect(getBrowserPage(browserId)).toBeNull();
    await expect(navigateBrowser(browserId, 'https://example.com/next')).resolves.toMatchObject({ url: 'https://example.com/next', error: undefined });
  });

  it('reports a generic load failure once no download follows it', async () => {
    await navigateBrowser(browserId, 'https://example.com/original');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.loadURL.mockRejectedValueOnce(Object.assign(new Error('ERR_FAILED (-2)'), { code: 'ERR_FAILED', errno: -2 }));
    vi.useFakeTimers();
    try {
      const pending = navigateBrowser(browserId, 'https://example.com/broken');
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ url: 'https://example.com/original', loading: false, error: 'ERR_FAILED (-2)' });
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a generic load failure when the tab starts an unrelated download meanwhile', async () => {
    await navigateBrowser(browserId, 'https://example.com/original');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    mocks.trackBrowserDownload.mockClear();
    contents.loadURL.mockImplementationOnce(async () => {
      const item = { ...downloadItem('other.zip'), getURLChain: () => ['https://example.com/other.zip'], getURL: () => 'https://example.com/other.zip' };
      setTimeout(() => browserSession.handlers.get('will-download')?.({}, item, contents), 0);
      throw Object.assign(new Error('ERR_FAILED (-2)'), { code: 'ERR_FAILED', errno: -2 });
    });
    vi.useFakeTimers();
    try {
      const pending = navigateBrowser(browserId, 'https://example.com/broken');
      await vi.advanceTimersByTimeAsync(1_000);
      await expect(pending).resolves.toMatchObject({ url: 'https://example.com/original', loading: false, error: 'ERR_FAILED (-2)' });
      expect(mocks.trackBrowserDownload).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('still reports an address that fails without starting a download', async () => {
    await navigateBrowser(browserId, 'https://example.com/original');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.loadURL.mockImplementationOnce(async (url: string) => {
      contents.emit('did-start-loading');
      contents.emit('did-start-navigation', {}, url, false, true);
      contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true);
      contents.emit('did-stop-loading');
      throw Object.assign(new Error(`ERR_CONNECTION_REFUSED (-102) loading '${url}'`), { code: 'ERR_CONNECTION_REFUSED', errno: -102 });
    });
    const result = await navigateBrowser(browserId, 'http://127.0.0.1:9/');
    expect(result).toMatchObject({ url: 'http://127.0.0.1:9/', loading: false, error: 'ERR_CONNECTION_REFUSED' });
  });

  it('reads a persisted page without creating native contents', () => {
    setBrowserPagePersistence({ getPage: () => ({ url: 'https://example.com/saved', title: 'Saved', zoomFactor: 1 }), savePage: vi.fn(), deletePage: vi.fn(), flush: vi.fn(), setDefaultZoom: vi.fn() });
    try {
      expect(getBrowserState('persisted-only')).toMatchObject({ url: 'https://example.com/saved', title: 'Saved', loading: false });
      expect(mocks.FakeWebContentsView.instances).toHaveLength(0);
    } finally { setBrowserPagePersistence(null); }
  });

  it('settles rejected restoration without a load-failure event', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    suspendBrowser(browserId);
    mocks.failNextLoad = true;
    restoreBrowser(browserId);
    await vi.waitFor(() => expect(getBrowserState(browserId)).toMatchObject({ loading: false, error: 'Navigation cancelled' }));
  });

  it('reports the page renderable only once its native view can paint', async () => {
    expect((await navigateBrowser(browserId, 'https://example.com')).renderable).toBe(true);
    suspendBrowser(browserId);
    expect(getBrowserState(browserId).renderable).toBeUndefined();
    mocks.failNextLoad = true;
    const restoring = restoreBrowser(browserId);
    expect(restoring.url).toBe('https://example.com/');
    expect(restoring.renderable).toBeUndefined();
    await vi.waitFor(() => expect(getBrowserState(browserId).error).toBe('Navigation cancelled'));
    expect(getBrowserState(browserId).renderable).toBeUndefined();
  });

  it('does not let a cancelled restoration overwrite a newer navigation', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    suspendBrowser(browserId);
    mocks.failNextLoad = true;
    restoreBrowser(browserId);
    await navigateBrowser(browserId, 'https://example.com/new');
    expect(getBrowserState(browserId)).toMatchObject({ url: 'https://example.com/new', loading: false, error: undefined });
  });

  it('applies default zoom to suspended pages', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    suspendBrowser(browserId);
    applyDefaultBrowserZoom(1.5);
    expect(getBrowserState(browserId).zoomFactor).toBe(1.5);
    restoreBrowser(browserId);
    expect(mocks.FakeWebContentsView.instances.at(-1)!.webContents.zoomFactor).toBe(1.5);
  });

  it('restores actual device parameters when an update fails', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'responsive', orientation: 'portrait', scaleMode: 'fit', width: 390, height: 800 });
    const previous = getBrowserState(browserId).device;
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.debugger.sendCommand.mockRejectedValueOnce(new Error('CDP unavailable'));
    await expect(updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'responsive', orientation: 'portrait', scaleMode: 'fit', width: 500, height: 900 })).rejects.toThrow();
    expect(getBrowserState(browserId).device).toEqual(previous);
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 390, height: 800 }));
  });

  it('closes pages before clearing storage and holds new navigation until cleanup completes', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    let release!: () => void;
    browserSession.clearStorageData.mockImplementationOnce(() => new Promise<void>(resolve => {
      expect(contents.destroyed).toBe(true);
      release = resolve;
    }));
    const clearing = clearBrowserData(browserId);
    await vi.waitFor(() => expect(browserSession.clearStorageData).toHaveBeenCalled());
    const opening = navigateBrowser('new-tab', 'https://example.org');
    await Promise.resolve();
    expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
    release();
    await Promise.all([clearing, opening]);
    expect(getBrowserState('new-tab').url).toBe('https://example.org/');
  });

  it('rechecks a queued navigation after cleanup and drops it when the check fails', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    let release!: () => void;
    browserSession.clearStorageData.mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve; }));
    const clearing = clearBrowserData(browserId);
    await vi.waitFor(() => expect(browserSession.clearStorageData).toHaveBeenCalled());
    const revoked = new Error('control revoked');
    const validate = vi.fn(async () => { throw revoked; });
    const opening = navigateBrowser('queued-tab', 'https://example.org', { validate });
    await Promise.resolve();
    expect(validate).not.toHaveBeenCalled();
    release();
    await clearing;
    await expect(opening).rejects.toBe(revoked);
    expect(validate).toHaveBeenCalledOnce();
    expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
    expect(getBrowserState('queued-tab').url).toBe('');
  });

  it('skips the navigation check when no cleanup is pending', async () => {
    const validate = vi.fn(async () => {});
    await navigateBrowser(browserId, 'https://example.com', { validate });
    expect(validate).not.toHaveBeenCalled();
    expect(getBrowserState(browserId).url).toBe('https://example.com/');
  });

  it('records main-frame same-document visits without recording subframe navigation', async () => {
    await navigateBrowser(browserId, 'https://example.com/start');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    mocks.recordBrowserHistory.mockClear();
    contents.url = 'https://example.com/next#details';
    contents.title = 'Next page';
    contents.emit('did-navigate-in-page', {}, contents.url, false);
    expect(mocks.recordBrowserHistory).not.toHaveBeenCalled();
    contents.emit('did-navigate-in-page', {}, contents.url, true);
    expect(mocks.recordBrowserHistory).toHaveBeenCalledWith(expect.objectContaining({ url: contents.url, title: 'Next page' }));
  });

  it('stops matching pages before clearing one site and restores visible pages afterward', async () => {
    await navigateBrowser('site-one', 'https://example.com/page');
    const target = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    setBrowserVisible('site-one', true);
    await navigateBrowser('site-two', 'https://other.test');
    const other = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    mocks.clearSiteData.mockImplementationOnce(async origin => {
      expect(target.destroyed).toBe(true);
      expect(other.destroyed).toBe(false);
      return { origin, permissions: {}, cookieCount: 0 };
    });
    await clearBrowserSiteData('https://example.com/settings');
    expect(mocks.clearSiteData).toHaveBeenCalledWith('https://example.com');
    expect(getBrowserPage('site-one')?.webContents).not.toBe(target);
    expect(other.destroyed).toBe(false);
  });

  it.each(['portrait', 'landscape'] as const)('keeps the requested %s orientation for a square responsive viewport', async (orientation) => {
    await navigateBrowser(browserId, 'https://example.com');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    const state = await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'responsive', orientation, scaleMode: 'fit', width: 500, height: 500 });
    expect(state.device).toMatchObject({ orientation, width: 500, height: 500 });
    const metrics = contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Emulation.setDeviceMetricsOverride').at(-1)?.[1];
    expect(metrics?.['screenOrientation']).toMatchObject({ type: orientation === 'portrait' ? 'portraitPrimary' : 'landscapePrimary' });
  });

  it('lists live and suspended tabs whose page belongs to a site', async () => {
    await navigateBrowser('site-live', 'https://example.com/page');
    await navigateBrowser('site-suspended', 'https://example.com/other');
    suspendBrowser('site-suspended');
    await navigateBrowser('site-elsewhere', 'https://other.test');
    expect(browserIdsForSite('https://example.com').sort()).toEqual(['site-live', 'site-suspended']);
    expect(browserIdsForSite('https://missing.test')).toEqual([]);
  });

  it('targets the selected tab for audio and uses its complete native URL', async () => {
    attachBrowserWindow(createHost() as never);
    await navigateBrowser('menu-one', 'https://example.com/one');
    const first = mocks.FakeWebContentsView.instances.at(-1)!;
    await navigateBrowser('menu-two', 'https://example.com/two');
    const second = mocks.FakeWebContentsView.instances.at(-1)!;
    const longUrl = 'https://example.com/?q=' + 'x'.repeat(6000);
    first.webContents.url = longUrl;
    first.webContents.emit('did-navigate', {}, longUrl);
    expect(getBrowserState('menu-one').urlTruncated).toBe(true);
    await browserTabCommand({ browserId: 'menu-one', action: 'copy-url' });
    expect(clipboard.writeText).toHaveBeenLastCalledWith(longUrl);
    first.webContents.url = 'chrome-error://chromewebdata/';
    first.webContents.emit('did-navigate', {}, first.webContents.url);
    await browserTabCommand({ browserId: 'menu-one', action: 'copy-url' });
    expect(clipboard.writeText).toHaveBeenLastCalledWith(longUrl);
    await browserTabCommand({ browserId: 'menu-two', action: 'open-external' });
    expect(shell.openExternal).toHaveBeenLastCalledWith('https://example.com/two');
    await browserTabCommand({ browserId: 'menu-one', action: 'mute' });
    expect(first.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    expect(second.webContents.setAudioMuted).toHaveBeenLastCalledWith(false);
    expect(getBrowserState('menu-one').muted).toBe(true);
    suspendBrowser('menu-one');
    restoreBrowser('menu-one');
    expect(mocks.FakeWebContentsView.instances.at(-1)!.webContents.setAudioMuted).toHaveBeenLastCalledWith(true);
    await browserTabCommand({ browserId: 'menu-one', action: 'unmute' });
    expect(getBrowserState('menu-one').muted).toBe(false);
  });



  it('opens only the web URL a known tab shows in the default browser', async () => {
    attachBrowserWindow(createHost() as never);
    await navigateBrowser('external-one', 'https://example.com/committed');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    vi.mocked(shell.openExternal).mockClear();
    await browserTabCommand({ browserId: 'external-one', action: 'open-external' });
    expect(shell.openExternal).toHaveBeenCalledExactlyOnceWith('https://example.com/committed');
    for (const url of ['about:blank', 'data:text/html,hi', 'javascript:alert(1)']) {
      contents.url = url;
      contents.emit('did-navigate', {}, url);
      await browserTabCommand({ browserId: 'external-one', action: 'open-external' });
      expect(shell.openExternal).toHaveBeenLastCalledWith(getBrowserState('external-one').url);
    }
    contents.url = 'file:///etc/passwd';
    contents.emit('did-navigate', {}, contents.url);
    expect(getBrowserState('external-one').url).toBe('file:///etc/passwd');
    await expect(browserTabCommand({ browserId: 'external-one', action: 'open-external' })).rejects.toThrow('no web URL');
    await browserTabCommand({ browserId: 'external-one', action: 'copy-url' });
    expect(clipboard.writeText).toHaveBeenLastCalledWith('file:///etc/passwd');
    expect(restoreBrowser('external-blank').url).toBe('');
    await expect(browserTabCommand({ browserId: 'external-blank', action: 'open-external' })).rejects.toThrow('no web URL');
    vi.mocked(shell.openExternal).mockClear();
    await expect(browserTabCommand({ browserId: 'external-missing', action: 'open-external' })).rejects.toThrow('Unknown browser tab');
    await expect(browserTabCommand({ browserId: 'external-missing', action: 'copy-url' })).rejects.toThrow('Unknown browser tab');
    expect(shell.openExternal).not.toHaveBeenCalled();
    setBrowserPagePersistence({ getPage: (id: string) => (id === 'external-saved' ? { url: 'https://example.com/saved', title: 'Saved', zoomFactor: 1 } : undefined), savePage: vi.fn(), deletePage: vi.fn(), flush: vi.fn(), setDefaultZoom: vi.fn() });
    try {
      await browserTabCommand({ browserId: 'external-saved', action: 'open-external' });
      expect(shell.openExternal).toHaveBeenLastCalledWith('https://example.com/saved');
      expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
    } finally { setBrowserPagePersistence(null); }
  });

  it('opens and copies the navigation target the address bar shows before it commits', async () => {
    attachBrowserWindow(createHost() as never);
    await navigateBrowser('external-pending', 'https://example.com/a');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.loadURL.mockImplementationOnce(() => new Promise<void>(() => {}));
    void navigateBrowser('external-pending', 'https://example.com/b');
    await Promise.resolve();
    expect(contents.url).toBe('https://example.com/a');
    expect(getBrowserState('external-pending')).toMatchObject({ url: 'https://example.com/b', loading: true });
    await browserTabCommand({ browserId: 'external-pending', action: 'open-external' });
    expect(shell.openExternal).toHaveBeenLastCalledWith('https://example.com/b');
    await browserTabCommand({ browserId: 'external-pending', action: 'copy-url' });
    expect(clipboard.writeText).toHaveBeenLastCalledWith('https://example.com/b');
  });

  it('exposes manual focus emulation per page without focusing the native window', async () => {
    await navigateBrowser(browserId, 'example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    expect((await updateBrowserFocusEmulation(browserId, true)).emulateFocus).toBe(true);
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setFocusEmulationEnabled', { enabled: true });
    expect((await updateBrowserFocusEmulation(browserId, false)).emulateFocus).toBe(false);
    expect(view.webContents.focus).not.toHaveBeenCalled();
  });

  it.each(['abort', 'revoked'] as const)('does not apply a queued device update after %s', async (reason) => {
    await navigateBrowser(browserId, 'example.com');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    let started!: () => void;
    let release!: () => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    let firstCommand = true;
    await contents.debugger.sendCommand.withImplementation(async () => {
      if (firstCommand) { firstCommand = false; started(); await gate; }
    }, async () => {
      const first = updateBrowserDeviceMode(browserId, {
        enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit',
      });
      await entered;
      const controller = new AbortController();
      const second = updateBrowserDeviceMode(browserId, {
        enabled: true, profileId: 'pixel-8', orientation: 'portrait', scaleMode: 'fit',
      }, { signal: controller.signal, validate: async () => { if (reason === 'revoked') throw new Error('control revoked'); } });
      const rejected = expect(second).rejects.toThrow(reason === 'abort' ? /aborted/i : 'control revoked');
      if (reason === 'abort') controller.abort();
      release();
      await first;
      await rejected;
    });
    expect(getBrowserState(browserId).device?.profileId).toBe('pixel-7');
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.objectContaining({ userAgent: expect.stringContaining('Pixel 8') }));
  });

  it.each(['revoked', 'abort'] as const)('stops and rolls back device emulation when control is lost midway (%s)', async (reason) => {
    await navigateBrowser(browserId, 'example.com');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.reload.mockClear();
    const controller = new AbortController();
    let lost = false;
    const validate = vi.fn(async () => { if (lost && reason === 'revoked') throw new Error('control revoked'); });
    await contents.debugger.sendCommand.withImplementation(async (method) => {
      if (method === 'Emulation.setDeviceMetricsOverride' && !lost) {
        lost = true;
        if (reason === 'abort') controller.abort();
      }
    }, async () => {
      await expect(updateBrowserDeviceMode(browserId, {
        enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit',
      }, { signal: controller.signal, validate })).rejects.toThrow(reason === 'abort' ? /aborted/i : 'control revoked');
    });
    expect(getBrowserState(browserId)).not.toHaveProperty('device');
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.objectContaining({ userAgent: expect.stringContaining('Pixel') }));
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.resetPageScaleFactor');
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it('checks control again before reloading after device emulation', async () => {
    await navigateBrowser(browserId, 'example.com');
    await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.reload.mockClear();
    const reset = () => contents.debugger.sendCommand.mock.calls.some(([method]) => method === 'Emulation.resetPageScaleFactor');
    contents.debugger.sendCommand.mockClear();
    await expect(updateBrowserDeviceMode(browserId, { enabled: false }, { validate: async () => { if (reset()) throw new Error('control revoked'); } })).rejects.toThrow('control revoked');
    expect(getBrowserState(browserId).device?.profileId).toBe('pixel-7');
    expect(contents.debugger.sendCommand).toHaveBeenLastCalledWith('Emulation.setEmitTouchEventsForMouse', expect.objectContaining({ enabled: true }));
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it('keeps mouse touch emulation off while suspended, including device changes, and restores it afterwards', async () => {
    await navigateBrowser(browserId, 'example.com');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    const touchCalls = () => contents.debugger.sendCommand.mock.calls.filter(([method]) => method === 'Emulation.setEmitTouchEventsForMouse');
    const idle = await suspendBrowserMouseTouch(contents as never);
    await idle();
    expect(touchCalls()).toEqual([]);

    await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
    contents.debugger.sendCommand.mockClear();
    const restore = await suspendBrowserMouseTouch(contents as never);
    expect(touchCalls()).toEqual([['Emulation.setEmitTouchEventsForMouse', { enabled: false, configuration: 'mobile' }]]);

    contents.debugger.sendCommand.mockClear();
    await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'iphone-14-pro', orientation: 'landscape', scaleMode: 'fit' });
    expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
    expect(touchCalls().at(-1)).toEqual(['Emulation.setEmitTouchEventsForMouse', { enabled: false, configuration: 'mobile' }]);

    contents.debugger.sendCommand.mockClear();
    await restore();
    await restore();
    expect(touchCalls()).toEqual([['Emulation.setEmitTouchEventsForMouse', { enabled: true, configuration: 'mobile' }]]);
  });

  it('invalidates device and focus state after an unexpected debugger detach without reconnecting', async () => {
    await navigateBrowser(browserId, 'example.com');
    await updateBrowserDeviceMode(browserId, {
      enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit',
    });
    await updateBrowserFocusEmulation(browserId, true);
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.reload.mockClear();
    contents.debugger.detach();
    expect(getBrowserState(browserId)).not.toHaveProperty('device');
    expect(getBrowserState(browserId).emulateFocus).toBe(false);
    expect(contents.debugger.attach).toHaveBeenCalledOnce();
    expect(contents.reload).not.toHaveBeenCalled();
  });

  it('stops device commands when a resolved CDP call detached the connection', async () => {
    await navigateBrowser(browserId, 'example.com');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    await contents.debugger.sendCommand.withImplementation(async (method) => {
      if (method === 'Emulation.setDeviceMetricsOverride') contents.debugger.detach();
    }, async () => {
      await expect(updateBrowserDeviceMode(browserId, {
        enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit',
      })).rejects.toThrow('detached');
    });
    expect(getBrowserState(browserId)).not.toHaveProperty('device');
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.anything());
  });

  it('does not restore stale device state when an in-flight update loses its debugger', async () => {
    await navigateBrowser(browserId, 'example.com');
    await updateBrowserDeviceMode(browserId, {
      enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit',
    });
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    let started!: () => void;
    let fail!: (error: Error) => void;
    const entered = new Promise<void>(resolve => { started = resolve; });
    const gate = new Promise<void>((_resolve, reject) => { fail = reject; });
    await contents.debugger.sendCommand.withImplementation(async (method) => {
      if (method === 'Emulation.setUserAgentOverride') { started(); await gate; }
    }, async () => {
      const update = updateBrowserDeviceMode(browserId, {
        enabled: true, profileId: 'pixel-8', orientation: 'portrait', scaleMode: 'fit',
      });
      const rejected = expect(update).rejects.toThrow('detached');
      await entered;
      contents.debugger.detach();
      fail(new Error('detached'));
      await rejected;
    });
    expect(getBrowserState(browserId)).not.toHaveProperty('device');
    expect(contents.debugger.attach).toHaveBeenCalledOnce();
  });

  it('moves an emulated page without reconfiguring its device metrics', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    setBrowserBounds(browserId, { x: 100, y: 80, width: 800, height: 600 });
    await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    const originalX = getBrowserPage(browserId)!.bounds.x;
    contents.debugger.sendCommand.mockClear();
    setBrowserBounds(browserId, { x: 200, y: 80, width: 800, height: 600 });
    await Promise.resolve();
    expect(getBrowserPage(browserId)?.bounds.x).toBe(originalX + 100);
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.anything());
  });

  describe('device emulation without a renderable page', () => {
    const responsive = (width: number, height: number) => ({ enabled: true as const, profileId: 'responsive' as const, orientation: 'portrait' as const, scaleMode: 'fit' as const, width, height });
    const emulationCalls = (contents: InstanceType<typeof mocks.FakeWebContents>) => contents.debugger.sendCommand.mock.calls.filter(([method]) => method.startsWith('Emulation.'));
    const failLoad = (contents: InstanceType<typeof mocks.FakeWebContents>, url: string) => {
      contents.loading = true;
      contents.emit('did-start-loading');
      contents.emit('did-fail-load', {}, -102, 'ERR_CONNECTION_REFUSED', url, true);
      contents.loading = false;
      contents.emit('did-stop-loading');
    };
    const failNavigation = async (contents: InstanceType<typeof mocks.FakeWebContents>, url: string) => {
      contents.loadURL.mockImplementationOnce(async (target: string) => {
        failLoad(contents, target);
        throw new Error(`ERR_CONNECTION_REFUSED (-102) loading '${target}'`);
      });
      await navigateBrowser(browserId, url);
    };

    it('keeps the device state but sends no emulation commands to a failed page', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      await failNavigation(contents, 'http://127.0.0.1:1/');
      expect(getBrowserState(browserId).error).toBe('ERR_CONNECTION_REFUSED');
      contents.debugger.sendCommand.mockClear();
      const state = await updateBrowserDeviceMode(browserId, responsive(500, 900));
      expect(state.device).toMatchObject({ width: 500, height: 900 });
      expect(emulationCalls(contents)).toEqual([]);
      setBrowserBounds(browserId, { x: 0, y: 0, width: 900, height: 700 });
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(emulationCalls(contents)).toEqual([]);
    });

    it('applies the pending device emulation once the page loads again', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      await failNavigation(contents, 'http://127.0.0.1:1/');
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      contents.debugger.sendCommand.mockClear();
      await navigateBrowser(browserId, 'https://example.com/recovered');
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 500, height: 900 })));
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.anything());
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', expect.anything());
      expect(getBrowserState(browserId).device).toMatchObject({ width: 500, height: 900 });
    });

    it('does not emulate the failed page before navigating away from it', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      await failNavigation(contents, 'http://127.0.0.1:1/');
      contents.debugger.sendCommand.mockClear();
      let callsBeforeLoad: unknown[] | undefined;
      const load = contents.loadURL.getMockImplementation()!;
      contents.loadURL.mockImplementationOnce(async (url: string) => {
        callsBeforeLoad = emulationCalls(contents);
        await load(url);
      });
      await navigateBrowser(browserId, 'https://example.com/recovered');
      expect(callsBeforeLoad).toEqual([]);
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 390, height: 800 })));
    });

    it('enables device mode on a failed page without rolling back', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      await failNavigation(contents, 'http://127.0.0.1:1/');
      contents.debugger.sendCommand.mockClear();
      contents.reload.mockImplementationOnce(() => failLoad(contents, 'http://127.0.0.1:1/'));
      const state = await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      expect(state.device).toMatchObject({ profileId: 'pixel-7' });
      expect(emulationCalls(contents)).toEqual([]);
      expect(contents.reload).not.toHaveBeenCalled();
      await navigateBrowser(browserId, 'https://example.com/recovered');
      await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledOnce());
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ mobile: true }));
      const userAgentOrder = contents.debugger.sendCommand.mock.invocationCallOrder[contents.debugger.sendCommand.mock.calls.findIndex(([method]) => method === 'Emulation.setUserAgentOverride')]!;
      expect(userAgentOrder).toBeLessThan(contents.reload.mock.invocationCallOrder[0]!);
    });

    it('reloads a page that loaded before a deferred device identity took effect', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.reload.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      expect(contents.reload).not.toHaveBeenCalled();
      expect(emulationCalls(contents)).toEqual([]);
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledOnce());
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.objectContaining({ userAgent: expect.stringContaining('Pixel 7') }));
    });

    it('holds early load waiters until the deferred device identity reload starts', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.reload.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      const committed = waitForBrowserLoad(browserId, 'committed', 5_000).then(() => contents.reload.mock.calls.length);
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.emit('dom-ready');
      const domReady = waitForBrowserLoad(browserId, 'dom_ready', 5_000).then(() => contents.reload.mock.calls.length);
      contents.loading = false;
      contents.emit('did-stop-loading');
      await expect(committed).resolves.toBe(1);
      await expect(domReady).resolves.toBe(1);
    });

    it('holds load waiters registered while the deferred device sync is in flight', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.reload.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      expect(getBrowserState(browserId).loading).toBe(false);
      const complete = waitForBrowserLoad(browserId, 'complete', 5_000).then(() => contents.reload.mock.calls.length);
      await expect(complete).resolves.toBe(1);
    });

    it.each([true, false])('routes the device identity reload through the beforeunload prompt (leave: %s)', async (accept) => {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.reload.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      contents.reload.mockImplementationOnce(() => { contents.emit('will-prevent-unload', { preventDefault: vi.fn() }); });
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledOnce());
      const prompt = listBrowserDialogs(browserId).find(item => item.kind === 'beforeunload')!;
      await respondBrowserDialog(prompt.dialogId, { accept }, 'user');
      if (accept) await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledTimes(2));
      else expect(getBrowserState(browserId).loading).toBe(false);
    });

    it.each([true, false])('holds device identity reload waiters until the beforeunload answer (leave: %s)', async (accept) => {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.reload.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      contents.reload.mockImplementationOnce(() => { contents.emit('will-prevent-unload', { preventDefault: vi.fn() }); });
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      let settled = false;
      const complete = waitForBrowserLoad(browserId, 'complete', 5_000).then(() => {
        settled = true;
        return contents.reload.mock.calls.length;
      });
      await vi.waitFor(() => expect(contents.reload).toHaveBeenCalledOnce());
      const prompt = listBrowserDialogs(browserId).find(item => item.kind === 'beforeunload')!;
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(settled).toBe(false);
      await respondBrowserDialog(prompt.dialogId, { accept }, 'user');
      await expect(complete).resolves.toBe(accept ? 2 : 1);
    });

    it('does not settle a newer navigation when an older deferred sync fails', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      let fail: ((error: Error) => void) | undefined;
      contents.debugger.sendCommand.mockImplementation(async (method: string) => {
        if (fail === undefined && method === 'Emulation.setDeviceMetricsOverride') {
          await new Promise<void>((_resolve, reject) => { fail = reject; });
        }
      });
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      await vi.waitFor(() => expect(fail).toBeDefined());
      contents.loading = true;
      contents.emit('did-start-loading');
      contents.emit('did-navigate', {}, 'https://example.com/next');
      contents.loading = false;
      contents.emit('did-stop-loading');
      const metricsCalls = (): number => emulationCalls(contents).filter(([method, params]) => method === 'Emulation.setDeviceMetricsOverride' && (params as { width?: number }).width === 500).length;
      const waited = waitForBrowserLoad(browserId, 'complete', 5_000).then(metricsCalls);
      fail!(new Error('CDP unavailable'));
      await expect(waited).resolves.toBe(2);
    });

    it('does not send emulation commands after the renderer exits cleanly', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.emit('render-process-gone', {}, { reason: 'clean-exit' });
      contents.debugger.sendCommand.mockClear();
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      expect(emulationCalls(contents)).toEqual([]);
      await navigateBrowser(browserId, 'https://example.com/recovered');
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 500 })));
    });

    it('keeps a failed deferred sync pending and rejects its load waiters', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      const waited = waitForBrowserLoad(browserId, 'complete', 5_000);
      contents.debugger.sendCommand.mockRejectedValueOnce(new Error('CDP unavailable'));
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      await expect(waited).rejects.toThrow('Browser device emulation failed to apply.');
      await expect(waitForBrowserLoad(browserId, 'complete', 5_000)).rejects.toThrow('Browser device emulation failed to apply.');
      contents.debugger.sendCommand.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 500 })));
    });

    it('reloads when re-enabling a device profile after a debugger detach and a desktop navigation', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.debugger.detach();
      await navigateBrowser(browserId, 'https://example.com/desktop');
      contents.reload.mockClear();
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      expect(contents.reload).toHaveBeenCalledOnce();
    });

    it('does not reload when only the deferred viewport changed', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.reload.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 500 })));
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(contents.reload).not.toHaveBeenCalled();
    });

    it('keeps blocking emulation after navigation from a failed page is stopped', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      await failNavigation(contents, 'http://127.0.0.1:1/');
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      contents.debugger.sendCommand.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/slow', true);
      contents.loading = false;
      contents.emit('did-stop-loading');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(emulationCalls(contents)).toEqual([]);
      await navigateBrowser(browserId, 'https://example.com/recovered');
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 500 })));
    });

    it.each(['failed page', 'clean exit'])('rejects load waiters of a navigation stopped while emulation is blocked (%s)', async (cause) => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      if (cause === 'failed page') await failNavigation(contents, 'http://127.0.0.1:1/');
      else contents.emit('render-process-gone', {}, { reason: 'clean-exit' });
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      contents.loading = true;
      contents.emit('did-start-loading');
      const waited = waitForBrowserLoad(browserId, 'complete', 5_000);
      contents.emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://example.com/slow', true);
      contents.loading = false;
      contents.emit('did-stop-loading');
      await expect(waited).rejects.toThrow('Browser device emulation failed to apply.');
      await expect(waitForBrowserLoad(browserId, 'complete', 5_000)).rejects.toThrow('Browser device emulation failed to apply.');
      await navigateBrowser(browserId, 'https://example.com/recovered');
      await expect(waitForBrowserLoad(browserId, 'complete', 5_000)).resolves.toMatchObject({ device: { width: 500 } });
    });

    it('resolves load waiters only after the deferred emulation is applied', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.loading = true;
      contents.emit('did-start-loading');
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      const waited = waitForBrowserLoad(browserId, 'complete', 5_000).then(() => emulationCalls(contents).some(([method, params]) => method === 'Emulation.setDeviceMetricsOverride' && (params as { width?: number }).width === 500));
      contents.emit('did-navigate', {}, 'https://example.com');
      contents.loading = false;
      contents.emit('did-stop-loading');
      await expect(waited).resolves.toBe(true);
    });

    it('applies emulation while only subframes are loading', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.debugger.sendCommand.mockClear();
      contents.subframeLoading = true;
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 500 }));
    });

    it('starts a recreated tab without the previous failure block', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.crashed = true;
      contents.emit('render-process-gone', {}, { reason: 'crashed' });
      setBrowserVisible(browserId, false);
      suspendBrowser(browserId);
      let callsBeforeLoad: unknown[] | undefined;
      const restored = restoreBrowser(browserId);
      expect(restored.device).toMatchObject({ width: 390 });
      const next = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      expect(next).not.toBe(contents);
      const load = next.loadURL.getMockImplementation()!;
      next.loadURL.mockImplementationOnce(async (url: string) => {
        callsBeforeLoad = emulationCalls(next);
        await load(url);
      });
      await vi.waitFor(() => expect(next.loadURL).toHaveBeenCalled());
      expect(callsBeforeLoad).toContainEqual(['Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 390 })]);
    });

    it('defers device emulation while the page is loading', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.debugger.sendCommand.mockClear();
      contents.loading = true;
      contents.emit('did-start-loading');
      const state = await updateBrowserDeviceMode(browserId, responsive(500, 900));
      expect(state.device).toMatchObject({ width: 500, height: 900 });
      expect(emulationCalls(contents)).toEqual([]);
      contents.loading = false;
      contents.emit('did-stop-loading');
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 500, height: 900 })));
    });

    it('defers the remaining commands when the page starts loading mid-update', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.debugger.sendCommand.mockClear();
      await contents.debugger.sendCommand.withImplementation(async (method?: string) => {
        if (method === 'Emulation.setDeviceMetricsOverride') {
          contents.loading = true;
          contents.emit('did-start-loading');
        }
      }, async () => {
        await updateBrowserDeviceMode(browserId, responsive(500, 900));
      });
      expect(emulationCalls(contents).map(([method]) => method)).toEqual(['Emulation.setDeviceMetricsOverride']);
      expect(getBrowserState(browserId).device).toMatchObject({ width: 500, height: 900 });
      contents.debugger.sendCommand.mockClear();
      contents.loading = false;
      contents.emit('did-stop-loading');
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', expect.anything()));
      expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.objectContaining({ width: 500, height: 900 }));
    });

    it('does not send emulation commands to a crashed page', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.crashed = true;
      contents.emit('render-process-gone', {}, { reason: 'crashed' });
      contents.debugger.sendCommand.mockClear();
      await updateBrowserDeviceMode(browserId, responsive(500, 900));
      expect(emulationCalls(contents)).toEqual([]);
    });

    it('finishes disabling device mode after a failed page recovers', async () => {
      await navigateBrowser(browserId, 'https://example.com');
      await updateBrowserDeviceMode(browserId, responsive(390, 800));
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      await failNavigation(contents, 'http://127.0.0.1:1/');
      contents.debugger.sendCommand.mockClear();
      contents.reload.mockImplementationOnce(() => failLoad(contents, 'http://127.0.0.1:1/'));
      const state = await updateBrowserDeviceMode(browserId, { enabled: false });
      expect(state).not.toHaveProperty('device');
      expect(emulationCalls(contents)).toEqual([]);
      await navigateBrowser(browserId, 'https://example.com/recovered');
      await vi.waitFor(() => expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.clearDeviceMetricsOverride'));
      expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.anything());
      expect(getBrowserState(browserId)).not.toHaveProperty('device');
    });
  });

  it('does not reapply device metrics when bounds change during disabling', async () => {
    await navigateBrowser(browserId, 'example.com');
    await updateBrowserDeviceMode(browserId, {
      enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit',
    });
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    let releaseClear!: () => void;
    let startedClear!: () => void;
    const clearStarted = new Promise<void>(resolve => { startedClear = resolve; });
    const clearGate = new Promise<void>(resolve => { releaseClear = resolve; });
    contents.debugger.sendCommand.mockClear();
    await contents.debugger.sendCommand.withImplementation(async (method?: string) => {
      if (method === 'Emulation.clearDeviceMetricsOverride') {
        startedClear();
        await clearGate;
      }
    }, async () => {
      const disable = updateBrowserDeviceMode(browserId, { enabled: false });
      await clearStarted;
      setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 500 });
      await new Promise(resolve => setTimeout(resolve, 0));
      releaseClear();
      await disable;
      await new Promise(resolve => setTimeout(resolve, 0));
    });
    expect(getBrowserState(browserId)).not.toHaveProperty('device');
    expect(contents.debugger.sendCommand).not.toHaveBeenCalledWith('Emulation.setDeviceMetricsOverride', expect.anything());
  });

  it('serializes device disabling and enabling across callers', async () => {
    await navigateBrowser(browserId, 'example.com');
    await updateBrowserDeviceMode(browserId, {
      enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit',
    });
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    let releaseClear!: () => void;
    let startedClear!: () => void;
    const clearStarted = new Promise<void>(resolve => { startedClear = resolve; });
    const clearGate = new Promise<void>(resolve => { releaseClear = resolve; });
    await contents.debugger.sendCommand.withImplementation(async (method?: string) => {
      if (method === 'Emulation.clearDeviceMetricsOverride') {
        startedClear();
        await clearGate;
      }
    }, async () => {
      const disable = updateBrowserDeviceMode(browserId, { enabled: false });
      await clearStarted;
      const enable = updateBrowserDeviceMode(browserId, {
        enabled: true, profileId: 'pixel-8', orientation: 'portrait', scaleMode: 'fit',
      });
      await new Promise(resolve => setTimeout(resolve, 0));
      releaseClear();
      await Promise.all([disable, enable]);
    });
    expect(getBrowserState(browserId).device?.profileId).toBe('pixel-8');
    const overrides = contents.debugger.sendCommand.mock.calls
      .filter(([method]) => method === 'Emulation.setUserAgentOverride');
    expect(overrides.at(-1)?.[1]).toMatchObject({ userAgent: expect.stringContaining('Pixel 8') });
  });

  it('does not reload when device mode is already disabled', async () => {
    await navigateBrowser(browserId, 'example.com');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    await updateBrowserDeviceMode(browserId, { enabled: false });
    await updateBrowserDeviceMode(browserId, { enabled: false });
    expect(contents.reload).not.toHaveBeenCalled();
    expect(contents.debugger.attach).not.toHaveBeenCalled();

    await updateBrowserDeviceMode(browserId, {
      enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit',
    });
    contents.reload.mockClear();
    await updateBrowserDeviceMode(browserId, { enabled: false });
    await updateBrowserDeviceMode(browserId, { enabled: false });
    expect(contents.reload).toHaveBeenCalledTimes(1);
    expect(getBrowserState(browserId)).not.toHaveProperty('device');
  });

  it('applies desktop presets with desktop user agent and without touch emulation', async () => {
    await navigateBrowser(browserId, 'example.com');
    const result = await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'desktop-1440', orientation: 'landscape', scaleMode: 'fit' });
    expect(result.device).toMatchObject({ width: 1440, height: 900, mobile: false, touch: false, orientation: 'landscape' });
    const view = mocks.FakeWebContentsView.instances[0]!;
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setTouchEmulationEnabled', { enabled: false, maxTouchPoints: 5 });
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.objectContaining({ platform: 'Win32', userAgent: expect.stringContaining('Windows NT 10.0'), userAgentMetadata: expect.objectContaining({ mobile: false }) }));
  });

  describe('custom user agent', () => {
    const chrome = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
    const safari = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15';
    const flush = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));
    const userAgentOverrides = (contents: { debugger: { sendCommand: { mock: { calls: unknown[][] } } } }) => contents.debugger.sendCommand.mock.calls
      .filter(([method]) => method === 'Emulation.setUserAgentOverride')
      .map(([, params]) => params as { userAgent: string; userAgentMetadata?: { brands: { brand: string }[] } });

    afterEach(() => {
      mocks.customBrowserUserAgent.mockReturnValue(null);
      mocks.electronUserAgent.mockRestore();
    });

    it('presents the default user agent as Chrome', async () => {
      mocks.electronUserAgent.mockReturnValue('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) KimiCodeCanary/1.0.4 Chrome/144.0.7559.60 Electron/43.1.1 Safari/537.36');
      const reduced = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36';
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      expect(contents.userAgent).toBe(reduced);
      expect(userAgentOverrides(contents).at(-1)?.userAgentMetadata?.brands.map(entry => entry.brand)).toContain('Google Chrome');
      const [listener] = browserSession.webRequest.onBeforeSendHeaders.mock.calls[0] as unknown as [(details: unknown, callback: (response: unknown) => void) => void];
      const callback = vi.fn();
      listener({ url: 'https://example.com/', requestHeaders: { Accept: '*/*' }, webContentsId: contents.id }, callback);
      expect(callback).toHaveBeenCalledWith({ requestHeaders: expect.objectContaining({
        'User-Agent': reduced,
        'sec-ch-ua': expect.stringContaining('"Google Chrome";v="144"'),
        'sec-ch-ua-mobile': '?0',
        'sec-ch-ua-platform': '"macOS"',
      }) });
      const signIn = vi.fn();
      listener({ url: 'https://accounts.google.com/', requestHeaders: { Accept: '*/*' }, webContentsId: contents.id }, signIn);
      expect(signIn).toHaveBeenCalledWith({ requestHeaders: expect.objectContaining({
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.7559.60 Electron/43.1.1 Safari/537.36',
      }) });
    });

    it.each(['navigate', 'restore'] as const)('applies custom client hint metadata before the first %s load', async (operation) => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      if (operation === 'restore') {
        await navigateBrowser(browserId, 'https://example.com/');
        suspendBrowser(browserId);
        restoreBrowser(browserId);
      } else {
        await navigateBrowser(browserId, 'example.com');
      }
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalled());
      const calls = contents.debugger.sendCommand.mock.calls as unknown as Array<[string, unknown]>;
      const overrideIndex = calls.findIndex(([name, params]) => name === 'Emulation.setUserAgentOverride' && (params as { userAgent: string }).userAgent === chrome);
      expect(overrideIndex).toBeGreaterThanOrEqual(0);
      expect(contents.debugger.sendCommand.mock.invocationCallOrder[overrideIndex]).toBeLessThan(contents.loadURL.mock.invocationCallOrder[0]!);
    });

    it('loads a new tab without waiting for an override that needs a renderer', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      mocks.queueCommandsWithoutRenderer = true;
      try {
        await navigateBrowser(browserId, 'https://example.com/');
        const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
        expect(contents.loadURL).toHaveBeenCalledWith('https://example.com/');
        const calls = contents.debugger.sendCommand.mock.calls as unknown as Array<[string, { userAgentMetadata?: { brands: { brand: string }[] } }]>;
        const overrideIndex = calls.findIndex(([name]) => name === 'Emulation.setUserAgentOverride');
        expect(calls[overrideIndex]?.[1].userAgentMetadata?.brands.map(entry => entry.brand)).toContain('Google Chrome');
        expect(contents.debugger.sendCommand.mock.invocationCallOrder[overrideIndex]).toBeLessThan(contents.loadURL.mock.invocationCallOrder[0]!);
      } finally { mocks.queueCommandsWithoutRenderer = false; }
    });

    it('loads a popup without waiting for an override that needs a renderer', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
      try {
        await navigateBrowser(browserId, 'https://example.com');
        mocks.queueCommandsWithoutRenderer = true;
        menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
        const contents = mocks.FakeBrowserWindow.popups.at(-1)!.webContents;
        await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalledWith('https://example.com/popup'));
        const overrideIndex = contents.debugger.sendCommand.mock.calls.findIndex(([name]) => name === 'Emulation.setUserAgentOverride');
        expect(contents.debugger.sendCommand.mock.invocationCallOrder[overrideIndex]).toBeLessThan(contents.loadURL.mock.invocationCallOrder[0]!);
      } finally {
        mocks.queueCommandsWithoutRenderer = false;
        menu.mockRestore();
      }
    });

    it('applies custom client hint metadata before a popup window loads', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
      try {
        await navigateBrowser(browserId, 'https://example.com');
        menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
        const contents = mocks.FakeBrowserWindow.popups.at(-1)!.webContents;
        expect(contents.loadURL).not.toHaveBeenCalled();
        await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalledWith('https://example.com/popup'));
        const calls = contents.debugger.sendCommand.mock.calls as unknown as Array<[string, unknown]>;
        const overrideIndex = calls.findIndex(([name, params]) => name === 'Emulation.setUserAgentOverride' && (params as { userAgent: string }).userAgent === chrome);
        expect(overrideIndex).toBeGreaterThanOrEqual(0);
      } finally { menu.mockRestore(); }
    });

    it('applies a Chromium custom user agent with client hints to tabs and the session', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      expect(contents.userAgent).toBe(chrome);
      expect(browserSession.setUserAgent).toHaveBeenCalledWith(chrome);
      expect(userAgentOverrides(contents).at(-1)).toMatchObject({ userAgent: chrome, platform: 'MacIntel' });
      expect(userAgentOverrides(contents).at(-1)?.userAgentMetadata?.brands.map(entry => entry.brand)).toContain('Google Chrome');
      const [listener] = browserSession.webRequest.onBeforeSendHeaders.mock.calls[0] as unknown as [(details: unknown, callback: (response: unknown) => void) => void];
      const callback = vi.fn();
      listener({ url: 'https://example.com/sw.js', requestHeaders: { 'User-Agent': 'Electron' } }, callback);
      expect(callback).toHaveBeenCalledWith({ requestHeaders: expect.objectContaining({ 'User-Agent': chrome, 'sec-ch-ua-platform': '"macOS"' }) });
      const signIn = vi.fn();
      listener({ url: 'https://accounts.google.com/', requestHeaders: {} }, signIn);
      expect(signIn).toHaveBeenCalledWith({ requestHeaders: expect.objectContaining({ 'User-Agent': chrome }) });
    });

    it('lets device mode win and returns to the custom user agent afterwards', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      expect(userAgentOverrides(contents).at(-1)?.userAgent).toContain('Pixel 7');
      const [listener] = browserSession.webRequest.onBeforeSendHeaders.mock.calls[0] as unknown as [(details: unknown, callback: (response: unknown) => void) => void];
      const callback = vi.fn();
      listener({ url: 'https://example.com/', requestHeaders: { 'sec-ch-ua-mobile': '?1' }, webContentsId: contents.id }, callback);
      expect(callback).toHaveBeenCalledWith({});
      applyBrowserUserAgentPreference();
      await flush();
      expect(userAgentOverrides(contents).at(-1)?.userAgent).toContain('Pixel 7');
      await updateBrowserDeviceMode(browserId, { enabled: false });
      expect(userAgentOverrides(contents).at(-1)).toMatchObject({ userAgent: chrome, platform: 'MacIntel' });
      expect(contents.debugger.attached).toBe(true);
    });

    it('releases the user agent debugger when leaving device mode with a non-Chromium value', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
      applyBrowserUserAgentPreference();
      await flush();
      await updateBrowserDeviceMode(browserId, { enabled: false });
      expect(userAgentOverrides(contents).at(-1)).toEqual({ userAgent: '' });
      expect(contents.debugger.attached).toBe(false);
    });

    it('waits for a pending override clear before navigating with a non-Chromium value', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      contents.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Emulation.setUserAgentOverride' && params?.['userAgent'] === '') await gate;
      });
      try {
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
        applyBrowserUserAgentPreference();
        const loads = contents.loadURL.mock.calls.length;
        const navigation = navigateBrowser(browserId, 'https://example.org/');
        await flush();
        expect(contents.loadURL.mock.calls.length).toBe(loads);
        release();
        await navigation;
        const calls = contents.debugger.sendCommand.mock.calls as unknown as Array<[string, { userAgent?: string }]>;
        const clearIndex = calls.findIndex(([name, params]) => name === 'Emulation.setUserAgentOverride' && params.userAgent === '');
        expect(contents.debugger.sendCommand.mock.invocationCallOrder[clearIndex]).toBeLessThan(contents.loadURL.mock.invocationCallOrder.at(-1)!);
      } finally {
        contents.debugger.sendCommand.mockImplementation(async () => undefined);
      }
    });

    it.each(['back', 'forward', 'reload'] as const)('waits for a pending user agent sync before going %s', async (action) => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      contents.history = { canBack: true, canForward: true };
      const navigate = { back: contents.navigationHistory.goBack, forward: contents.navigationHistory.goForward, reload: contents.reload }[action];
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      contents.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Emulation.setUserAgentOverride' && params?.['userAgent'] === '') await gate;
      });
      try {
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
        applyBrowserUserAgentPreference();
        ({ back: browserGoBack, forward: browserGoForward, reload: browserReload })[action](browserId);
        await flush();
        expect(navigate).not.toHaveBeenCalled();
        release();
        await vi.waitFor(() => expect(navigate).toHaveBeenCalledOnce());
        const calls = contents.debugger.sendCommand.mock.calls as unknown as Array<[string, { userAgent?: string }]>;
        const clearIndex = calls.findIndex(([name, params]) => name === 'Emulation.setUserAgentOverride' && params.userAgent === '');
        expect(contents.debugger.sendCommand.mock.invocationCallOrder[clearIndex]).toBeLessThan(navigate.mock.invocationCallOrder[0]!);
      } finally {
        contents.debugger.sendCommand.mockImplementation(async () => undefined);
      }
    });

    it.each(['back', 'forward', 'reload', 'navigate'] as const)('cancels a %s waiting for a user agent sync when loading is stopped', async (action) => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'https://example.com/');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      contents.history = { canBack: true, canForward: true };
      const navigate = { back: contents.navigationHistory.goBack, forward: contents.navigationHistory.goForward, reload: contents.reload, navigate: contents.loadURL }[action];
      const calls = navigate.mock.calls.length;
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      contents.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method === 'Emulation.setUserAgentOverride' && params?.['userAgent'] === '') await gate;
      });
      try {
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
        applyBrowserUserAgentPreference();
        const navigation = action === 'navigate'
          ? navigateBrowser(browserId, 'https://example.org/')
          : (({ back: browserGoBack, forward: browserGoForward, reload: browserReload })[action](browserId), Promise.resolve());
        await flush();
        expect(getBrowserState(browserId).loading).toBe(true);
        expect(browserStopLoading(browserId)).toMatchObject({ url: 'https://example.com/', loading: false });
        release();
        await navigation;
        await flush();
        await flush();
        expect(navigate.mock.calls.length).toBe(calls);
        expect(getBrowserState(browserId)).toMatchObject({ url: 'https://example.com/', loading: false });
        expect(getBrowserState(browserId).error).toBeUndefined();
      } finally {
        release();
        contents.debugger.sendCommand.mockImplementation(async () => undefined);
      }
    });

    it('releases the user agent debugger when the client hints override fails', async () => {
      await navigateBrowser(browserId, 'https://example.com/');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      expect(contents.debugger.attached).toBe(false);
      contents.debugger.sendCommand.mockImplementation(async (method: string) => {
        if (method === 'Emulation.setUserAgentOverride') throw new Error('CDP unavailable');
      });
      try {
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
        applyBrowserUserAgentPreference();
        await flush();
        await flush();
        expect(contents.debugger.sendCommand).toHaveBeenCalledWith('Emulation.setUserAgentOverride', expect.objectContaining({ userAgent: chrome }));
        expect(contents.debugger.attached).toBe(false);
      } finally {
        contents.debugger.sendCommand.mockImplementation(async () => undefined);
      }
    });

    it.each(['before', 'during'] as const)('retries a user agent override clear that failed %s the navigation barrier', async (timing) => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      expect(contents.debugger.attached).toBe(true);
      let failed = false;
      contents.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method !== 'Emulation.setUserAgentOverride' || params?.['userAgent'] !== '' || failed) return;
        failed = true;
        throw new Error('CDP unavailable');
      });
      try {
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
        applyBrowserUserAgentPreference();
        if (timing === 'before') {
          await flush();
          expect(userAgentOverrides(contents).filter(params => params.userAgent === '')).toHaveLength(1);
          expect(contents.debugger.attached).toBe(true);
        }
        const loads = contents.loadURL.mock.calls.length;
        await navigateBrowser(browserId, 'https://example.org/');
        const calls = contents.debugger.sendCommand.mock.calls as unknown as Array<[string, { userAgent?: string } | undefined]>;
        const clears = calls.flatMap(([name, params], index) => name === 'Emulation.setUserAgentOverride' && params?.userAgent === '' ? [index] : []);
        expect(clears).toHaveLength(2);
        expect(contents.loadURL.mock.calls.length).toBe(loads + 1);
        expect(contents.debugger.sendCommand.mock.invocationCallOrder[clears[1]!]).toBeLessThan(contents.loadURL.mock.invocationCallOrder[loads]!);
        expect(contents.debugger.attached).toBe(false);
      } finally {
        contents.debugger.sendCommand.mockImplementation(async () => undefined);
      }
    });

    it.each(['navigate', 'back'] as const)('waits for user agent syncs queued during the barrier before %s', async (action) => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      contents.history = { canBack: true, canForward: false };
      let releaseClear!: () => void;
      let releaseChrome!: () => void;
      const clearGate = new Promise<void>(resolve => { releaseClear = resolve; });
      const chromeGate = new Promise<void>(resolve => { releaseChrome = resolve; });
      contents.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
        if (method !== 'Emulation.setUserAgentOverride') return;
        if (params?.['userAgent'] === '') await clearGate;
        if (params?.['userAgent'] === chrome) await chromeGate;
      });
      try {
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
        applyBrowserUserAgentPreference();
        const loads = contents.loadURL.mock.calls.length;
        const navigation = action === 'navigate' ? navigateBrowser(browserId, 'https://example.org/') : (browserGoBack(browserId), Promise.resolve());
        await flush();
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
        applyBrowserUserAgentPreference();
        releaseClear();
        await flush();
        await flush();
        expect(contents.loadURL.mock.calls.length).toBe(loads);
        expect(contents.navigationHistory.goBack).not.toHaveBeenCalled();
        releaseChrome();
        await navigation;
        if (action === 'navigate') expect(contents.loadURL.mock.calls.length).toBe(loads + 1);
        else await vi.waitFor(() => expect(contents.navigationHistory.goBack).toHaveBeenCalledOnce());
        expect(contents.debugger.attached).toBe(true);
      } finally {
        releaseClear();
        releaseChrome();
        contents.debugger.sendCommand.mockImplementation(async () => undefined);
      }
    });

    it('serializes popup user agent syncs so an earlier clear cannot drop a later override', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
      try {
        await navigateBrowser(browserId, 'https://example.com');
        menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
        const contents = mocks.FakeBrowserWindow.popups.at(-1)!.webContents;
        await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalled());
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        contents.debugger.sendCommand.mockImplementation(async (method: string, params?: Record<string, unknown>) => {
          if (method === 'Emulation.setUserAgentOverride' && params?.['userAgent'] === '') await gate;
        });
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
        applyBrowserUserAgentPreference();
        await flush();
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
        applyBrowserUserAgentPreference();
        release();
        await flush();
        await flush();
        expect(contents.userAgent).toBe(chrome);
        expect(contents.debugger.attached).toBe(true);
        expect(userAgentOverrides(contents).at(-1)).toMatchObject({ userAgent: chrome, platform: 'MacIntel' });
      } finally { menu.mockRestore(); }
    });

    it('restores the popup client hint override after DevTools closes', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
      try {
        await navigateBrowser(browserId, 'https://example.com');
        menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
        const contents = mocks.FakeBrowserWindow.popups.at(-1)!.webContents;
        await vi.waitFor(() => expect(contents.loadURL).toHaveBeenCalled());
        contents.devToolsOpened = true;
        contents.debugger.detach();
        await flush();
        expect(contents.debugger.attached).toBe(false);
        contents.debugger.sendCommand.mockClear();
        contents.devToolsOpened = false;
        contents.emit('devtools-closed');
        await flush();
        expect(contents.debugger.attached).toBe(true);
        expect(userAgentOverrides(contents).at(-1)).toMatchObject({ userAgent: chrome, platform: 'MacIntel' });
      } finally { menu.mockRestore(); }
    });

    it('restores the custom client hint override after DevTools closes', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      contents.devToolsOpened = true;
      contents.debugger.detach();
      await flush();
      expect(contents.debugger.attached).toBe(false);
      contents.debugger.sendCommand.mockClear();
      contents.devToolsOpened = false;
      contents.emit('devtools-closed');
      await flush();
      expect(contents.debugger.attached).toBe(true);
      expect(userAgentOverrides(contents).at(-1)).toMatchObject({ userAgent: chrome, platform: 'MacIntel' });
    });

    it('re-syncs a user agent change made while device mode is exiting', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      contents.debugger.sendCommand.mockImplementation(async (method: string) => {
        if (method === 'Emulation.resetPageScaleFactor') await gate;
      });
      try {
        const exit = updateBrowserDeviceMode(browserId, { enabled: false });
        await vi.waitFor(() => expect(userAgentOverrides(contents).at(-1)).toMatchObject({ userAgent: chrome }));
        mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
        applyBrowserUserAgentPreference();
        release();
        await exit;
        await flush();
        expect(contents.userAgent).toBe(safari);
        expect(userAgentOverrides(contents).at(-1)).toEqual({ userAgent: '' });
        expect(contents.debugger.attached).toBe(false);
      } finally {
        contents.debugger.sendCommand.mockImplementation(async () => undefined);
      }
    });

    it('drops the CDP override for non-Chromium values and after a reset to default', async () => {
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(chrome));
      await navigateBrowser(browserId, 'example.com');
      await flush();
      const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
      mocks.customBrowserUserAgent.mockReturnValue(browserUserAgentOverride(safari));
      applyBrowserUserAgentPreference();
      await flush();
      expect(contents.userAgent).toBe(safari);
      expect(browserSession.setUserAgent).toHaveBeenLastCalledWith(safari);
      expect(userAgentOverrides(contents).at(-1)).toEqual({ userAgent: '' });
      expect(contents.debugger.attached).toBe(false);
      mocks.customBrowserUserAgent.mockReturnValue(null);
      applyBrowserUserAgentPreference();
      await flush();
      expect(contents.userAgent).toBe('Mozilla/5.0 AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36');
      expect(browserSession.setUserAgent).toHaveBeenLastCalledWith('Mozilla/5.0 AppleWebKit/537.36 Chrome/144.0.0.0 Safari/537.36');
    });
  });

  function downloadItem(filename = 'report.pdf') {
    let savePath = '';
    return {
      getFilename: () => filename, getURL: () => 'https://example.com/file', getURLChain: () => ['https://example.com/file'], getSavePath: () => savePath, getState: vi.fn(() => 'progressing'),
      setSavePath: vi.fn((path: string) => { savePath = path; }), setSaveDialogOptions: vi.fn(), cancel: vi.fn(), resume: vi.fn(), once: vi.fn(),
      getTotalBytes: () => 0, getReceivedBytes: () => 0, on: vi.fn(), removeListener: vi.fn(),
    };
  }

  function showTab(): void {
    setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 600 });
    setBrowserVisible(browserId, true);
  }

  it('asks where to save through the non-blocking download dialog while the user views the page', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    showTab();
    const item = downloadItem();
    browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    expect(item.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith({ title: 'Save download', defaultPath: join('/tmp', 'report.pdf') });
    expect(item.setSavePath).not.toHaveBeenCalled();
    expect(mocks.showSaveDialogSync).not.toHaveBeenCalled();
    expect(mocks.trackBrowserDownload).toHaveBeenCalledWith(item, undefined);
    expect(listBrowserDialogs(browserId)).toEqual([]);
  });

  it('saves straight to Downloads without a notice when askWhereToSave is off', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    showTab();
    const item = downloadItem();
    const data = mocks.getBrowserData();
    await mocks.getBrowserData.withImplementation(() => ({ ...data, preferences: { ...data.preferences, askWhereToSave: false } }), async () => {
      browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    });
    expect(item.setSavePath).toHaveBeenCalledExactlyOnceWith('/tmp/report.pdf');
    expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
    expect(listBrowserDialogs(browserId)).toEqual([]);
  });

  it('saves a download from a parked page to Downloads and offers to move it', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const item = downloadItem();
    browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    expect(item.setSavePath).toHaveBeenCalledExactlyOnceWith('/tmp/report.pdf');
    expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
    expect(mocks.showSaveDialogSync).not.toHaveBeenCalled();
    expect(listBrowserDialogs(browserId)).toEqual([expect.objectContaining({ kind: 'download', answerer: 'user', message: 'report.pdf', files: ['/tmp/report.pdf'] })]);
    expect(takeBrowserNotices(browserId)).toEqual([]);
  });

  it.each(['interrupted', 'cancelled'])('records a kept user download the agent saw as cancelled when it ends %s', async (state) => {
    await navigateBrowser(browserId, 'https://example.com');
    configureBrowserDialogs({ isAgentControlled: () => true });
    mocks.trackBrowserDownload.mockReturnValueOnce('download-user');
    const item = downloadItem();
    browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    const [notice] = listBrowserDialogs(browserId);
    await respondBrowserDialog(notice!.dialogId, { accept: false }, 'user');
    await Promise.resolve();
    expect(listBrowserDialogHistory(browserId)).toEqual([]);
    item.getState.mockReturnValue(state);
    for (const [event, listener] of item.once.mock.calls as unknown as Array<[string, () => void]>) if (event === 'done') listener();
    await vi.waitFor(() => expect(listBrowserDialogHistory(browserId)).toEqual([expect.objectContaining({ kind: 'download', outcome: 'cancelled', answerer: 'user', downloadId: 'download-user' })]));
    expect(listBrowserDialogHistory(browserId)[0]!.files).toBeUndefined();
    configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled });
  });

  it('records a kept user download the agent saw as saved once it completes', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    configureBrowserDialogs({ isAgentControlled: () => true });
    mocks.trackBrowserDownload.mockReturnValueOnce('download-user');
    const item = downloadItem();
    browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    const [notice] = listBrowserDialogs(browserId);
    await respondBrowserDialog(notice!.dialogId, { accept: false }, 'user');
    item.getState.mockReturnValue('completed');
    for (const [event, listener] of item.once.mock.calls as unknown as Array<[string, () => void]>) if (event === 'done') listener();
    await vi.waitFor(() => expect(listBrowserDialogHistory(browserId)).toEqual([expect.objectContaining({ kind: 'download', outcome: 'saved', answerer: 'user', files: ['/tmp/report.pdf'], downloadId: 'download-user' })]));
    configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled });
  });

  it('records a user download the agent saw at its moved path once the move finishes', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      mocks.trackBrowserDownload.mockReturnValueOnce('download-user');
      const item = downloadItem();
      item.getState.mockReturnValue('completed');
      browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      const [notice] = listBrowserDialogs(browserId);
      let choose!: (value: { canceled: boolean; filePath: string }) => void;
      mocks.showSaveDialog.mockReturnValueOnce(new Promise(resolve => { choose = resolve; }));
      const answered = respondBrowserDialog(notice!.dialogId, { accept: true }, 'user');
      await vi.waitFor(() => expect(mocks.showSaveDialog).toHaveBeenCalled());
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(listBrowserDialogHistory(browserId)).toEqual([]);
      choose({ canceled: false, filePath: '/tmp/moved/report.pdf' });
      await answered;
      await vi.waitFor(() => expect(listBrowserDialogHistory(browserId)).toEqual([expect.objectContaining({ kind: 'download', outcome: 'saved', files: ['/tmp/moved/report.pdf'], downloadId: 'download-user' })]));
    } finally { configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('shows the error when moving a download from its notice fails', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const item = downloadItem();
    item.getState.mockReturnValue('completed');
    browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    const [notice] = listBrowserDialogs(browserId);
    const { rename } = await import('node:fs/promises');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }));
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/locked/report.pdf' });
    await respondBrowserDialog(notice!.dialogId, { accept: true }, 'user');
    await vi.waitFor(() => expect(mocks.showErrorBox).toHaveBeenCalledWith(expect.any(String), 'EACCES: permission denied'));
    expect(mocks.relocateBrowserDownload).not.toHaveBeenCalled();
  });

  it('removes the copied file when a cross-volume move cannot delete the source', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const item = downloadItem();
    item.getState.mockReturnValue('completed');
    browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    const [notice] = listBrowserDialogs(browserId);
    const { rename, copyFile } = await import('node:fs/promises');
    vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }));
    vi.mocked(copyFile).mockClear();
    mocks.unlink.mockClear();
    mocks.unlink.mockRejectedValueOnce(Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' }));
    mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/Volumes/usb/report.pdf' });
    await respondBrowserDialog(notice!.dialogId, { accept: true }, 'user');
    await vi.waitFor(() => expect(mocks.showErrorBox).toHaveBeenCalledWith(expect.any(String), 'EBUSY: resource busy'));
    expect(copyFile).toHaveBeenCalledExactlyOnceWith('/tmp/report.pdf', '/Volumes/usb/report.pdf');
    expect(mocks.unlink.mock.calls).toEqual([['/tmp/report.pdf'], ['/Volumes/usb/report.pdf']]);
    expect(mocks.relocateBrowserDownload).not.toHaveBeenCalled();
  });

  it('drops a parked download notice when its tab closes', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    browserSession.handlers.get('will-download')?.({}, downloadItem(), mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    expect(listBrowserDialogs(browserId)).toEqual([expect.objectContaining({ kind: 'download' })]);
    closeBrowser(browserId);
    expect(listBrowserDialogs()).toEqual([]);
  });

  it('saves agent downloads to the agent location without a modal and records them for the indicator', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    showTab();
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      mocks.trackBrowserDownload.mockReturnValueOnce('download-1');
      const item = downloadItem();
      item.getState.mockReturnValue('completed');
      browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      expect(item.setSaveDialogOptions).not.toHaveBeenCalled();
      expect(item.setSavePath).toHaveBeenCalledExactlyOnceWith('/agent/report.pdf');
      expect(takeBrowserNotices(browserId)).toEqual([expect.stringContaining('/agent/report.pdf')]);
      expect(listBrowserDialogs(browserId)).toEqual([]);
      expect(listBrowserDialogHistory(browserId)).toEqual([]);
      for (const [event, listener] of item.once.mock.calls as unknown as Array<[string, () => void]>) if (event === 'done') listener();
      const [record] = listBrowserDialogHistory(browserId);
      expect(record).toMatchObject({ kind: 'download', outcome: 'saved', answerer: 'auto', message: 'report.pdf', files: ['/agent/report.pdf'], downloadId: 'download-1' });
      expect(control.performBrowserControlDownloadAction(browserId, record!.id, 'show')).toBe(true);
      expect(mocks.showItemInFolder).toHaveBeenCalledWith('/agent/report.pdf');
      mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/moved/report.pdf' });
      expect(control.performBrowserControlDownloadAction(browserId, record!.id, 'move')).toBe(true);
      await vi.waitFor(() => expect(mocks.relocateBrowserDownload).toHaveBeenCalledWith('download-1', '/tmp/moved/report.pdf'));
      expect(listBrowserDialogHistory(browserId)[0]!.files).toEqual(['/tmp/moved/report.pdf']);
      const { rename } = await import('node:fs/promises');
      vi.mocked(rename).mockClear();
      mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/again/report.pdf' });
      expect(control.performBrowserControlDownloadAction(browserId, record!.id, 'move')).toBe(true);
      await vi.waitFor(() => expect(mocks.relocateBrowserDownload).toHaveBeenCalledWith('download-1', '/tmp/again/report.pdf'));
      expect(rename).toHaveBeenCalledExactlyOnceWith('/tmp/moved/report.pdf', '/tmp/again/report.pdf');
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('moves an evicted agent download from its recorded path and reports a failed move', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      const first = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      await navigateBrowser('browser-2', 'https://example.com');
      const second = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      for (let index = 0; index < 65; index++) {
        mocks.trackBrowserDownload.mockReturnValueOnce(`download-${index}`);
        const item = downloadItem(`file-${index}.pdf`);
        item.getState.mockReturnValue('completed');
        browserSession.handlers.get('will-download')?.({}, item, index === 0 ? first : second);
        for (const [event, listener] of item.once.mock.calls as unknown as Array<[string, () => void]>) if (event === 'done') listener();
      }
      const record = listBrowserDialogHistory(browserId).find(item => item.downloadId === 'download-0')!;
      const { rename } = await import('node:fs/promises');
      vi.mocked(rename).mockClear();
      mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/moved/file-0.pdf' });
      expect(control.performBrowserControlDownloadAction(browserId, record.id, 'move')).toBe(true);
      await vi.waitFor(() => expect(mocks.relocateBrowserDownload).toHaveBeenCalledWith('download-0', '/tmp/moved/file-0.pdf'));
      expect(rename).toHaveBeenCalledExactlyOnceWith('/agent/file-0.pdf', '/tmp/moved/file-0.pdf');
      vi.mocked(rename).mockRejectedValueOnce(Object.assign(new Error('ENOENT: no such file'), { code: 'ENOENT' }));
      mocks.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: '/tmp/again/file-0.pdf' });
      expect(control.performBrowserControlDownloadAction(browserId, record.id, 'move')).toBe(true);
      await vi.waitFor(() => expect(mocks.showErrorBox).toHaveBeenCalledWith(expect.any(String), 'ENOENT: no such file'));
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('forgets undelivered browser events when every page is destroyed', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    pushBrowserNotice(browserId, 'pending notice');
    expect(hasPendingBrowserEvents()).toBe(true);
    destroyBrowserView();
    expect(hasPendingBrowserEvents()).toBe(false);
  });

  it('keeps attributing downloads to the agent after its control ends until the user acts on the tab', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    showTab();
    let agentControls = true;
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockImplementation(() => agentControls);
    configureBrowserDialogs({ isAgentControlled: () => agentControls });
    try {
      control.setBrowserControls(null);
      agentControls = false;
      control.setBrowserControls(null);
      mocks.trackBrowserDownload.mockReturnValueOnce('download-late');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      const late = downloadItem();
      late.getState.mockReturnValue('completed');
      browserSession.handlers.get('will-download')?.({}, late, contents);
      expect(late.setSaveDialogOptions).not.toHaveBeenCalled();
      expect(late.setSavePath).toHaveBeenCalledExactlyOnceWith('/agent/report.pdf');
      expect(listBrowserDialogs(browserId)).toEqual([]);
      for (const [event, listener] of late.once.mock.calls as unknown as Array<[string, () => void]>) if (event === 'done') listener();
      expect(listBrowserDialogHistory(browserId)).toEqual([]);
      agentControls = true;
      expect(takeBrowserDialogRecords(browserId)).toEqual([expect.objectContaining({ kind: 'download', outcome: 'saved', files: ['/agent/report.pdf'], downloadId: 'download-late' })]);
      agentControls = false;
      contents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
      const own = downloadItem('own.pdf');
      browserSession.handlers.get('will-download')?.({}, own, contents);
      expect(own.setSaveDialogOptions).toHaveBeenCalledOnce();
      expect(own.setSavePath).not.toHaveBeenCalled();
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); control.setBrowserControls(null); }
  });

  it('drops the result of an agent download that finishes after its tab closed', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    let agentControls = true;
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockImplementation(() => agentControls);
    configureBrowserDialogs({ isAgentControlled: () => agentControls });
    try {
      mocks.trackBrowserDownload.mockReturnValueOnce('download-orphan');
      const item = downloadItem();
      browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      takeBrowserNotices(browserId);
      agentControls = false;
      closeBrowser(browserId);
      item.getState.mockReturnValue('completed');
      for (const [event, listener] of item.once.mock.calls as unknown as Array<[string, () => void]>) if (event === 'done') listener();
      expect(hasPendingBrowserEvents()).toBe(false);
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('closes and suspends tabs without waiting for the page beforeunload handler', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const suspended = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    const suspendClose = vi.spyOn(suspended, 'close');
    suspendBrowser(browserId);
    expect(suspendClose).toHaveBeenCalledExactlyOnceWith();
    await navigateBrowser(browserId, 'https://example.com');
    const closed = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    const closeSpy = vi.spyOn(closed, 'close');
    closeBrowser(browserId);
    expect(closeSpy).toHaveBeenCalledExactlyOnceWith();
    expect(listBrowserDialogs(browserId)).toEqual([]);
  });

  it('records an interrupted agent download as not saved', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      mocks.trackBrowserDownload.mockReturnValueOnce('download-3');
      const item = downloadItem();
      browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      expect(listBrowserDialogHistory(browserId)).toEqual([]);
      item.getState.mockReturnValue('interrupted');
      for (const [event, listener] of item.once.mock.calls as unknown as Array<[string, () => void]>) if (event === 'done') listener();
      const history = listBrowserDialogHistory(browserId);
      expect(history).toEqual([expect.objectContaining({ kind: 'download', outcome: 'cancelled', downloadId: 'download-3' })]);
      expect(history[0]).not.toHaveProperty('files');
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  function sizedItem(total: number) {
    const listeners = new Map<string, Array<() => void>>();
    let received = 0;
    const item = {
      ...downloadItem('big.iso'), getTotalBytes: () => total, getReceivedBytes: () => received,
      on: vi.fn((event: string, listener: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); }),
      once: vi.fn((event: string, listener: () => void) => { listeners.set(event, [...(listeners.get(event) ?? []), listener]); }),
      removeListener: vi.fn((event: string, listener: () => void) => { listeners.set(event, (listeners.get(event) ?? []).filter(item => item !== listener)); }),
    };
    const emit = (event: string, bytes?: number) => { if (bytes !== undefined) received = bytes; for (const listener of listeners.get(event) ?? []) listener(); };
    return { item, emit };
  }

  it('blocks an agent download whose known size exceeds the limit before writing it', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      const data = mocks.getBrowserData();
      const { item } = sizedItem(1.2 * 1_024 ** 3);
      const event = { preventDefault: vi.fn() };
      await mocks.getBrowserData.withImplementation(() => ({ ...data, preferences: { ...data.preferences, agentDownloadLimitBytes: 500 * 1_024 ** 2 } }), async () => {
        browserSession.handlers.get('will-download')?.(event, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      });
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(item.setSavePath).not.toHaveBeenCalled();
      expect(mocks.trackBrowserDownload).not.toHaveBeenCalled();
      expect(takeBrowserNotices(browserId)).toEqual(['Download of "big.iso" blocked: 1.2 GB exceeds the 500 MB agent download limit set in Settings. Ask the user to download it or raise the limit.']);
      expect(listBrowserDialogHistory(browserId)).toEqual([expect.objectContaining({ kind: 'download', outcome: 'too-large', message: 'big.iso' })]);
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('cancels an agent download of unknown size once it passes the limit and removes the partial file', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      mocks.trackBrowserDownload.mockReturnValueOnce('download-2');
      const { item, emit } = sizedItem(0);
      const event = { preventDefault: vi.fn() };
      browserSession.handlers.get('will-download')?.(event, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(item.setSavePath).toHaveBeenCalledWith('/agent/big.iso');
      emit('updated', 1_024 ** 3);
      expect(item.cancel).not.toHaveBeenCalled();
      emit('updated', 1_024 ** 3 + 1);
      expect(item.cancel).toHaveBeenCalledOnce();
      emit('done');
      await vi.waitFor(() => expect(mocks.unlink).toHaveBeenCalledWith('/agent/big.iso'));
      expect(takeBrowserNotices(browserId).at(-1)).toContain('blocked: it passed 1.0 GB and exceeds the 1.0 GB agent download limit');
      expect(listBrowserDialogHistory(browserId)).toEqual([expect.objectContaining({ outcome: 'too-large', downloadId: 'download-2' })]);
      expect(listBrowserDialogHistory(browserId)[0]).not.toHaveProperty('files');
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('retries removing a blocked partial file and keeps its path when it cannot be deleted', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      mocks.trackBrowserDownload.mockReturnValueOnce('download-3');
      const busy = Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' });
      mocks.unlink.mockRejectedValueOnce(busy).mockRejectedValueOnce(busy).mockRejectedValueOnce(busy);
      const { item, emit } = sizedItem(0);
      browserSession.handlers.get('will-download')?.({ preventDefault: vi.fn() }, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      emit('updated', 1_024 ** 3 + 1);
      emit('done');
      await vi.waitFor(() => expect(listBrowserDialogHistory(browserId)).toEqual([expect.objectContaining({ outcome: 'too-large', files: ['/agent/big.iso'], downloadId: 'download-3' })]), { timeout: 3_000 });
      expect(mocks.unlink).toHaveBeenCalledTimes(3);
      expect(takeBrowserNotices(browserId).at(-1)).toContain('could not be deleted (EBUSY) and remains at "/agent/big.iso"');
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('cancels an agent download and tells the agent when its download folder is unavailable', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      vi.mocked(setAutomaticDownloadPath).mockImplementationOnce(() => { throw Object.assign(new Error('read-only'), { code: 'EROFS' }); });
      const { item } = sizedItem(1_024);
      const event = { preventDefault: vi.fn() };
      browserSession.handlers.get('will-download')?.(event, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(noteBrowserDownloadsFailure).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ code: 'EROFS' }));
      expect(mocks.trackBrowserDownload).not.toHaveBeenCalled();
      expect(takeBrowserNotices(browserId)).toEqual(['Download of "big.iso" was cancelled: the agent download folder /agent is not available (EROFS). Nothing was saved. Ask the user to check the agent download folder in Settings, then retry.']);
      expect(listBrowserDialogHistory(browserId)).toEqual([expect.objectContaining({ kind: 'download', outcome: 'cancelled', message: 'big.iso' })]);
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('never limits or redirects the user\'s own downloads', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const { item, emit } = sizedItem(50 * 1_024 ** 3);
    const event = { preventDefault: vi.fn() };
    browserSession.handlers.get('will-download')?.(event, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(item.setSavePath).toHaveBeenCalledWith('/tmp/big.iso');
    emit('updated', 60 * 1_024 ** 3);
    expect(item.cancel).not.toHaveBeenCalled();
  });

  it('forgets a download URL as the page to restore', async () => {
    const savePage = vi.fn();
    setBrowserPagePersistence({ getPage: () => undefined, savePage, deletePage: vi.fn(), flush: vi.fn(), setDefaultZoom: vi.fn() });
    await navigateBrowser(browserId, 'https://example.com');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    contents.emit('did-start-navigation', {}, 'https://example.com/file', false, true);
    expect(savePage).toHaveBeenLastCalledWith(browserId, expect.objectContaining({ url: 'https://example.com/file' }));
    browserSession.handlers.get('will-download')?.({}, downloadItem(), contents);
    expect(savePage).toHaveBeenLastCalledWith(browserId, expect.objectContaining({ url: expect.stringMatching(/^https:\/\/example\.com\/?$/) }));
  });

  it('retries into the recorded path without a save dialog and resumes only a recreated download', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    const resumed = { ...downloadItem('app.dmg'), getSavePath: () => '/d/app.dmg' };
    mocks.claimBrowserDownloadRetry.mockReturnValueOnce({ id: 'download-old', resume: true, savePath: '/d/app.dmg' });
    browserSession.handlers.get('will-download')?.({}, resumed, undefined);
    expect(mocks.claimBrowserDownloadRetry).toHaveBeenLastCalledWith(resumed, false);
    expect(resumed.setSavePath).not.toHaveBeenCalled();
    expect(mocks.trackBrowserDownload).toHaveBeenLastCalledWith(resumed, 'download-old');
    expect(resumed.resume).toHaveBeenCalledOnce();

    const restarted = downloadItem('app.dmg');
    mocks.claimBrowserDownloadRetry.mockReturnValueOnce({ id: 'download-old', resume: false, savePath: '/d/app.dmg' });
    browserSession.handlers.get('will-download')?.({}, restarted, undefined);
    expect(restarted.setSavePath).toHaveBeenCalledExactlyOnceWith('/d/app.dmg');
    expect(restarted.resume).not.toHaveBeenCalled();
    expect(mocks.trackBrowserDownload).toHaveBeenLastCalledWith(restarted, 'download-old');

    const unknownPath = downloadItem('app.dmg');
    mocks.claimBrowserDownloadRetry.mockReturnValueOnce({ id: 'download-old', resume: false });
    browserSession.handlers.get('will-download')?.({}, unknownPath, undefined);
    expect(unknownPath.setSavePath).toHaveBeenCalledExactlyOnceWith('/tmp/app.dmg');
    expect(mocks.trackBrowserDownload).toHaveBeenLastCalledWith(unknownPath, 'download-old');
    expect(mocks.showSaveDialogSync).not.toHaveBeenCalled();

    const pageDownload = downloadItem('app.dmg');
    browserSession.handlers.get('will-download')?.({}, pageDownload, contents);
    expect(mocks.claimBrowserDownloadRetry).toHaveBeenLastCalledWith(pageDownload, true);
  });

  it('asks where to save on the popup window that started the download', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const item = downloadItem();
      browserSession.handlers.get('will-download')?.({}, item, popup.webContents);
      expect(item.setSaveDialogOptions).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ title: 'Save download' }));
      expect(mocks.showSaveDialogSync).not.toHaveBeenCalled();
    } finally { menu.mockRestore(); }
  });

  it('saves to Downloads instead of opening a detached dialog when the app window is hidden', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    showTab();
    host.visible = false;
    const item = downloadItem();
    browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    expect(item.setSavePath).toHaveBeenCalledExactlyOnceWith('/tmp/report.pdf');
    expect(mocks.showSaveDialogSync).not.toHaveBeenCalled();
  });

  it('remembers the folder chosen in the download dialog', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    showTab();
    const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    const folder = mkdtempSync(join(tmpdir(), 'browser-download-'));
    try {
      const first = downloadItem('first.zip');
      browserSession.handlers.get('will-download')?.({}, first, contents);
      first.setSavePath(join(folder, 'first.zip'));
      const done = first.once.mock.calls.find(([event]) => event === 'done')?.[1] as () => void;
      done();
      const second = downloadItem('second.zip');
      browserSession.handlers.get('will-download')?.({}, second, contents);
      expect(second.setSaveDialogOptions).toHaveBeenCalledWith(expect.objectContaining({ defaultPath: join(folder, 'second.zip') }));
    } finally { rmSync(folder, { recursive: true, force: true }); }
  });

  it.each(['restore', 'navigate'] as const)('restores device capabilities before %s loads a suspended page', async (operation) => {
    setBrowserBounds(browserId, { x: 0, y: 0, width: 640, height: 520 });
    await navigateBrowser(browserId, 'https://example.com/');
    await updateBrowserDeviceMode(browserId, { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
    await updateBrowserFocusEmulation(browserId, true);
    suspendBrowser(browserId);
    expect(getBrowserState(browserId)).toMatchObject({ emulateFocus: true, device: { profileId: 'pixel-7' } });
    if (operation === 'restore') restoreBrowser(browserId);
    else await navigateBrowser(browserId, 'https://example.com/next');
    const restored = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
    await vi.waitFor(() => expect(restored.loadURL).toHaveBeenCalled());
    const calls = restored.debugger.sendCommand.mock.calls as unknown as Array<[string, unknown]>;
    const userAgentIndex = calls.findIndex(([name]) => name === 'Emulation.setUserAgentOverride');
    const touchIndex = calls.findIndex(([name]) => name === 'Emulation.setTouchEmulationEnabled');
    expect(userAgentIndex).toBeGreaterThanOrEqual(0);
    expect(touchIndex).toBeGreaterThanOrEqual(0);
    expect(calls[userAgentIndex]?.[1]).toMatchObject({ userAgent: expect.stringContaining('Pixel 7') });
    expect(calls[touchIndex]?.[1]).toMatchObject({ enabled: true });
    expect(restored.debugger.sendCommand.mock.invocationCallOrder[userAgentIndex]).toBeLessThan(restored.loadURL.mock.invocationCallOrder[0]!);
    expect(restored.debugger.sendCommand.mock.invocationCallOrder[touchIndex]).toBeLessThan(restored.loadURL.mock.invocationCallOrder[0]!);
  });

  it('creates the native page lazily with a persistent isolated session', async () => {
    setBrowserBounds(browserId, { x: 300, y: 80, width: 640, height: 520 });
    setBrowserVisible(browserId, true);
    expect(mocks.FakeWebContentsView.instances).toHaveLength(0);

    await navigateBrowser(browserId, 'example.com');
    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:kimi-browser');
    const view = mocks.FakeWebContentsView.instances[0]!;
    expect(view.options).toEqual({
      webPreferences: {
        session: browserSession,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: true,
        backgroundThrottling: false,
        autoplayPolicy: 'document-user-activation-required',
      },
    });
    expect(view.options).not.toHaveProperty('webPreferences.preload');
    expect(view.bounds).toEqual({ x: 300, y: 80, width: 640, height: 520 });
    expect(view.visible).toBe(true);
    expect(view.webContents.userAgent).not.toContain('Electron/');
    expect(mocks.observeBrowserOverlayOutsidePointer).toHaveBeenCalledWith(view.webContents, expect.any(Function));
    expect(browserSession.permissionCheck).toHaveBeenCalledOnce();
    expect(browserSession.permissionRequest).toHaveBeenCalledOnce();

    const item = { getFilename: () => 'report.pdf', getURL: () => 'https://example.com/report.pdf', getURLChain: () => [], getSavePath: () => '', setSavePath: vi.fn(), setSaveDialogOptions: vi.fn(), cancel: vi.fn(), once: vi.fn() };
    browserSession.handlers.get('will-download')?.({}, item, view.webContents);
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith(expect.objectContaining({ title: 'Save download' }));
    expect(mocks.trackBrowserDownload).toHaveBeenCalledWith(item, undefined);
  });

  it('stops attributing downloads to the agent after the user acts in a popup window', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    let agentControls = true;
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockImplementation(() => agentControls);
    configureBrowserDialogs({ isAgentControlled: () => agentControls });
    try {
      await navigateBrowser(browserId, 'https://example.com');
      browserSession.handlers.get('will-download')?.({}, downloadItem('agent.pdf'), mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      agentControls = false;
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const late = downloadItem();
      browserSession.handlers.get('will-download')?.({}, late, popup.webContents);
      expect(late.setSavePath).toHaveBeenCalledExactlyOnceWith('/agent/report.pdf');
      popup.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', x: 1, y: 1 });
      const own = downloadItem('own.pdf');
      browserSession.handlers.get('will-download')?.({}, own, popup.webContents);
      expect(own.setSaveDialogOptions).toHaveBeenCalledOnce();
      expect(own.setSavePath).not.toHaveBeenCalled();
    } finally { menu.mockRestore(); controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('stops attributing downloads to the agent after the user answers a native dialog in a popup window', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    let agentControls = true;
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockImplementation(() => agentControls);
    configureBrowserDialogs({ isAgentControlled: () => agentControls });
    try {
      await navigateBrowser(browserId, 'https://example.com');
      browserSession.handlers.get('will-download')?.({}, downloadItem('agent.pdf'), mocks.FakeWebContentsView.instances.at(-1)!.webContents);
      agentControls = false;
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const own = downloadItem('own.pdf');
      popup.webContents.emit('-run-dialog', { dialogType: 'confirm', messageText: 'Download?' }, () => {
        browserSession.handlers.get('will-download')?.({}, own, popup.webContents);
      });
      await Promise.resolve();
      popup.answerDialog!(true);
      await vi.waitFor(() => expect(own.setSaveDialogOptions).toHaveBeenCalledOnce());
      expect(own.setSavePath).not.toHaveBeenCalled();
    } finally { menu.mockRestore(); controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('stops attributing downloads to the agent only after the user confirms leaving a popup window page', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      popup.webContents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1));
      await mocks.showMessageBox.mock.results.at(-1)!.value;
      const stayed = downloadItem();
      browserSession.handlers.get('will-download')?.({}, stayed, popup.webContents);
      expect(stayed.setSavePath).toHaveBeenCalledExactlyOnceWith('/agent/report.pdf');
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      popup.webContents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(2));
      await mocks.showMessageBox.mock.results.at(-1)!.value;
      const own = downloadItem('own.pdf');
      browserSession.handlers.get('will-download')?.({}, own, popup.webContents);
      expect(own.setSaveDialogOptions).toHaveBeenCalledOnce();
      expect(own.setSavePath).not.toHaveBeenCalled();
    } finally { menu.mockRestore(); controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('stops attributing downloads to the agent after the user answers a page dialog in the panel', async () => {
    let agentControls = true;
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockImplementation(() => agentControls);
    configureBrowserDialogs({ isAgentControlled: () => agentControls });
    try {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      browserSession.handlers.get('will-download')?.({}, downloadItem('agent.pdf'), contents);
      agentControls = false;
      const late = downloadItem();
      browserSession.handlers.get('will-download')?.({}, late, contents);
      expect(late.setSavePath).toHaveBeenCalledExactlyOnceWith('/agent/report.pdf');
      contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      const prompt = listBrowserDialogs(browserId).find(item => item.kind === 'beforeunload')!;
      await respondBrowserDialog(prompt.dialogId, { accept: false }, 'user');
      const own = downloadItem('own.pdf');
      browserSession.handlers.get('will-download')?.({}, own, contents);
      expect(own.setSavePath).toHaveBeenCalledExactlyOnceWith('/tmp/own.pdf');
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('stops attributing downloads to the agent after the user answers a site permission prompt in the panel', async () => {
    let agentControls = true;
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockImplementation(() => agentControls);
    configureBrowserDialogs({ isAgentControlled: () => agentControls });
    try {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      browserSession.handlers.get('will-download')?.({}, downloadItem('agent.pdf'), contents);
      agentControls = false;
      const request = browserSession.permissionRequest.mock.calls.at(-1)![0] as (...args: unknown[]) => void;
      const allowed = vi.fn();
      request(contents, 'geolocation', allowed, { requestingUrl: 'https://example.com/', isMainFrame: true });
      const [pending] = sites.getBrowserPermissionRequests();
      expect(pending).toMatchObject({ browserId });
      expect(sites.resolveBrowserPermissionRequest({ requestId: pending!.requestId, decision: 'allow-once' })).toBe(true);
      expect(allowed).toHaveBeenCalledWith(true);
      const own = downloadItem('own.pdf');
      browserSession.handlers.get('will-download')?.({}, own, contents);
      expect(own.setSavePath).toHaveBeenCalledExactlyOnceWith('/tmp/own.pdf');
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('treats downloads after a user answer on a controlled tab as user downloads until the next agent action', async () => {
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      const prompt = listBrowserDialogs(browserId).find(item => item.kind === 'beforeunload')!;
      await respondBrowserDialog(prompt.dialogId, { accept: false }, 'user');
      const own = downloadItem('own.pdf');
      browserSession.handlers.get('will-download')?.({}, own, contents);
      expect(own.setSavePath).toHaveBeenCalledExactlyOnceWith('/tmp/own.pdf');
      control.notifyBrowserAgentAction(browserId);
      const agent = downloadItem('agent.pdf');
      browserSession.handlers.get('will-download')?.({}, agent, contents);
      expect(agent.setSavePath).toHaveBeenCalledExactlyOnceWith('/agent/agent.pdf');
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('keeps attributing downloads to the agent after the user answers a download notice on a controlled tab', async () => {
    let agentControls = false;
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockImplementation(() => agentControls);
    configureBrowserDialogs({ isAgentControlled: () => agentControls });
    try {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      browserSession.handlers.get('will-download')?.({}, downloadItem('own.pdf'), contents);
      const notice = listBrowserDialogs(browserId).find(item => item.kind === 'download')!;
      agentControls = true;
      await expect(respondBrowserDialog(notice.dialogId, { accept: false }, 'user')).resolves.toBe('answered');
      const agent = downloadItem('agent.pdf');
      browserSession.handlers.get('will-download')?.({}, agent, contents);
      expect(agent.setSavePath).toHaveBeenCalledExactlyOnceWith('/agent/agent.pdf');
    } finally { controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('treats downloads after a site permission answer on a controlled tab as user downloads for a short window', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const controlled = vi.spyOn(control, 'isBrowserAgentControlled').mockReturnValue(true);
    configureBrowserDialogs({ isAgentControlled: () => true });
    try {
      await navigateBrowser(browserId, 'https://example.com');
      const contents = mocks.FakeWebContentsView.instances.at(-1)!.webContents;
      const request = browserSession.permissionRequest.mock.calls.at(-1)![0] as (...args: unknown[]) => void;
      request(contents, 'geolocation', vi.fn(), { requestingUrl: 'https://example.com/', isMainFrame: true });
      const [pending] = sites.getBrowserPermissionRequests();
      expect(sites.resolveBrowserPermissionRequest({ requestId: pending!.requestId, decision: 'allow-once' })).toBe(true);
      const own = downloadItem('own.pdf');
      browserSession.handlers.get('will-download')?.({}, own, contents);
      expect(own.setSavePath).toHaveBeenCalledExactlyOnceWith('/tmp/own.pdf');
      vi.advanceTimersByTime(30_001);
      const late = downloadItem('late.pdf');
      browserSession.handlers.get('will-download')?.({}, late, contents);
      expect(late.setSavePath).toHaveBeenCalledExactlyOnceWith('/agent/late.pdf');
    } finally { vi.useRealTimers(); controlled.mockRestore(); configureBrowserDialogs({ isAgentControlled: control.isBrowserAgentControlled }); }
  });

  it('replays a popup navigation after leaving is confirmed and asks to repeat unknown or form navigations', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const requested = vi.mocked(watchBrowserNavigationRequests).mock.lastCall![1];
      const detail = () => (mocks.showMessageBox.mock.lastCall as unknown as [unknown, { detail: string }])[1].detail;
      const strings = browserEn.pageDialogs;
      popup.webContents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1));
      expect(detail()).toContain(strings.leaveRepeatAction);
      requested('https://example.com/submit', 'formSubmissionPost');
      popup.webContents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(2));
      expect(detail()).toContain(strings.leaveRepeatForm);
      requested('https://example.com/next', 'anchorClick');
      popup.webContents.loadURL.mockClear();
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      popup.webContents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(3));
      expect(detail()).not.toContain(strings.leaveRepeatAction);
      expect(detail()).not.toContain(strings.leaveRepeatForm);
      await vi.waitFor(() => expect(popup.webContents.loadURL).toHaveBeenCalledExactlyOnceWith('https://example.com/next'));
    } finally { menu.mockRestore(); }
  });

  it('does not replay a popup navigation the user refused for a later unload', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const requested = vi.mocked(watchBrowserNavigationRequests).mock.lastCall![1];
      const detail = () => (mocks.showMessageBox.mock.lastCall as unknown as [unknown, { detail: string }])[1].detail;
      requested('https://example.com/next', 'anchorClick');
      popup.webContents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(1));
      expect(detail()).not.toContain(browserEn.pageDialogs.leaveRepeatAction);
      await mocks.showMessageBox.mock.results.at(-1)!.value;
      popup.webContents.loadURL.mockClear();
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      popup.webContents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledTimes(2));
      expect(detail()).toContain(browserEn.pageDialogs.leaveRepeatAction);
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(popup.webContents.loadURL).not.toHaveBeenCalled();
    } finally { menu.mockRestore(); }
  });

  it('forgets a popup navigation target once that navigation commits', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const requested = vi.mocked(watchBrowserNavigationRequests).mock.lastCall![1];
      requested('https://example.com/next', 'anchorClick');
      popup.webContents.emit('did-navigate', {}, 'https://example.com/next');
      popup.webContents.loadURL.mockClear();
      mocks.showMessageBox.mockResolvedValueOnce({ response: 1, checkboxChecked: false });
      popup.webContents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledOnce());
      expect((mocks.showMessageBox.mock.lastCall as unknown as [unknown, { detail: string }])[1].detail).toContain(browserEn.pageDialogs.leaveRepeatAction);
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(popup.webContents.loadURL).not.toHaveBeenCalled();
    } finally { menu.mockRestore(); }
  });

  it.each([[1, 1], [0, 0]])('closes a popup window only after the user confirms leaving its page (response %i)', async (response, closes) => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const onClose = popup.on.mock.calls.find(([event]) => event === 'close')![1] as () => void;
      mocks.showMessageBox.mockResolvedValueOnce({ response, checkboxChecked: false });
      onClose();
      const preventDefault = vi.fn();
      popup.webContents.emit('will-prevent-unload', { preventDefault });
      expect(preventDefault).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(mocks.showMessageBox).toHaveBeenCalledOnce());
      await new Promise(resolve => setTimeout(resolve, 600));
      expect(popup.close).toHaveBeenCalledTimes(closes);
    } finally { menu.mockRestore(); }
  });

  it('keeps popup windows while parked and closes them with their source tab', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      mocks.recordBrowserHistory.mockClear();
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      await vi.waitFor(() => expect(mocks.recordBrowserHistory).toHaveBeenCalledWith({ url: 'https://example.com/popup', title: 'Title: https://example.com/popup' }));
      suspendBrowser(browserId);
      expect(popup.isDestroyed()).toBe(false);
      closeBrowser(browserId);
      expect(popup.isDestroyed()).toBe(true);
    } finally { menu.mockRestore(); }
  });

  it('opens modified clicks in a popup window as tabs of its source', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const popupCount = mocks.FakeBrowserWindow.popups.length;
      popup.webContents.windowOpenHandler?.({ url: 'https://example.com/background', disposition: 'background-tab' });
      answerLinkClickQuery(popup.webContents, true);
      popup.webContents.windowOpenHandler?.({ url: 'https://example.com/foreground', disposition: 'foreground-tab' });
      await vi.waitFor(() => expect(host.webContents.send).toHaveBeenCalledWith('kimi:browser-open-link-requested', { browserId, url: 'https://example.com/foreground' }));
      expect(host.webContents.send).toHaveBeenCalledWith('kimi:browser-open-link-requested', { browserId, url: 'https://example.com/background', background: true });
      expect(mocks.FakeBrowserWindow.popups).toHaveLength(popupCount);
      answerLinkClickQuery(popup.webContents, false);
      popup.webContents.windowOpenHandler?.({ url: 'https://example.com/plain', disposition: 'foreground-tab' });
      await vi.waitFor(() => expect(mocks.FakeBrowserWindow.popups).toHaveLength(popupCount + 1));
    } finally { menu.mockRestore(); }
  });

  it('still opens a popup request when the popup closes before the page answers', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const popupCount = mocks.FakeBrowserWindow.popups.length;
      answerLinkClickQuery(popup.webContents, 'pending');
      popup.webContents.windowOpenHandler?.({ url: 'https://example.com/child', disposition: 'foreground-tab' });
      popup.webContents.destroyed = true;
      popup.webContents.emit('destroyed');
      await vi.waitFor(() => expect(mocks.FakeBrowserWindow.popups).toHaveLength(popupCount + 1));
      expect(mocks.FakeBrowserWindow.popups.at(-1)!.webContents.loadURL).toHaveBeenCalledWith('https://example.com/child');
    } finally { menu.mockRestore(); }
  });

  it('drops a pending popup request when its source tab closes', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const popupCount = mocks.FakeBrowserWindow.popups.length;
      answerLinkClickQuery(popup.webContents, 'pending');
      popup.webContents.windowOpenHandler?.({ url: 'https://example.com/child', disposition: 'foreground-tab' });
      closeBrowser(browserId);
      expect(popup.isDestroyed()).toBe(true);
      popup.webContents.destroyed = true;
      popup.webContents.emit('destroyed');
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(mocks.FakeBrowserWindow.popups).toHaveLength(popupCount);
      expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-open-link-requested', expect.anything());
    } finally { menu.mockRestore(); }
  });

  it('attributes popup window permission requests to their source tab', async () => {
    const menu = vi.spyOn(contextMenus, 'installBrowserContextMenu').mockImplementation(() => {});
    try {
      await navigateBrowser(browserId, 'https://example.com');
      menu.mock.calls[0]![3]!('https://example.com/popup', 'window');
      const popup = mocks.FakeBrowserWindow.popups.at(-1)!;
      const browserIdFor = vi.mocked(configureBrowserSitePermissions).mock.calls.at(-1)![2]!;
      const view = mocks.FakeWebContentsView.instances.at(-1)!;
      expect(browserIdFor(view.webContents as never)).toBe(browserId);
      expect(browserIdFor(popup.webContents as never)).toBe(browserId);
      expect(browserIdFor(new mocks.FakeWebContents() as never)).toBeUndefined();
      popup.destroy();
      expect(browserIdFor(popup.webContents as never)).toBeUndefined();
    } finally { menu.mockRestore(); }
  });

  it('keeps popups in the same page and blocks non-http navigation', async () => {
    setBrowserBounds(browserId, { x: 0, y: 0, width: 640, height: 480 });
    setBrowserVisible(browserId, true);
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    expect(mocks.recordBrowserHistory).toHaveBeenCalledWith({
      url: 'https://example.com/',
      title: 'Title: https://example.com/',
    });
    expect(view.webContents.windowOpenHandler?.({ url: 'https://pubmed.ncbi.nlm.nih.gov/' })).toEqual({
      action: 'deny',
    });
    await Promise.resolve();
    expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://pubmed.ncbi.nlm.nih.gov/');

    expect(getBrowserPage(browserId)?.visible).toBe(true);
    const blocked = { preventDefault: vi.fn() };
    view.webContents.emit('will-navigate', blocked, 'file:///etc/passwd');
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    expect(getBrowserPage(browserId)?.visible).toBe(true);
  });

  it.each([
    { name: 'Cmd/Ctrl-click', button: 'left' },
    { name: 'middle click', button: 'middle' },
  ])('opens a $name link in a new background tab', async ({ button }) => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.loadURL.mockClear();
    view.webContents.emit('before-mouse-event', {}, { type: 'mouseDown', clickCount: 1, movementX: 0, movementY: 0, button, globalX: 1548.6, globalY: 613.5, x: 908.6, y: 317.5 });
    view.webContents.emit('before-mouse-event', {}, { type: 'mouseUp', clickCount: 1, movementX: 0, movementY: 0, button, globalX: 1548.6, globalY: 613.5, x: 908.6, y: 317.5 });
    expect(view.webContents.windowOpenHandler?.({ url: 'https://example.com/next', disposition: 'background-tab' })).toEqual({ action: 'deny' });
    await Promise.resolve();
    expect(view.webContents.loadURL).not.toHaveBeenCalled();
    expect(host.webContents.send).toHaveBeenCalledWith('kimi:browser-open-link-requested', { browserId, url: 'https://example.com/next', background: true });
  });

  it('opens a foreground tab when the page recorded a click on that link', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.loadURL.mockClear();
    answerLinkClickQuery(view.webContents, true);
    view.webContents.windowOpenHandler?.({ url: 'https://example.com/next', disposition: 'foreground-tab' });
    await vi.waitFor(() => expect(host.webContents.send).toHaveBeenCalledWith('kimi:browser-open-link-requested', { browserId, url: 'https://example.com/next' }));
    expect(view.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(BROWSER_ANNOTATION_WORLD, [{ code: browserLinkClickedScript('https://example.com/next') }]);
    expect(view.webContents.loadURL).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'the page has no matching link click', answer: false },
    { name: 'the page cannot be queried', answer: new Error('Script failed to execute') },
  ])('keeps a script-opened foreground tab in the current tab when $name', async ({ answer }) => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    answerLinkClickQuery(view.webContents, answer);
    view.webContents.windowOpenHandler?.({ url: 'https://example.com/next', disposition: 'foreground-tab' });
    await vi.waitFor(() => expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://example.com/next'));
    expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-open-link-requested', expect.anything());
  });

  it('navigates a tab in place when it is destroyed before the page answers', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    answerLinkClickQuery(view.webContents, 'pending');
    view.webContents.windowOpenHandler?.({ url: 'https://example.com/next', disposition: 'foreground-tab' });
    view.webContents.emit('destroyed');
    await vi.waitFor(() => expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://example.com/next'));
  });

  it('navigates a tab in place when its page does not answer in time', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    answerLinkClickQuery(view.webContents, 'pending');
    vi.useFakeTimers();
    try {
      view.webContents.windowOpenHandler?.({ url: 'https://example.com/next', disposition: 'foreground-tab' });
      await vi.advanceTimersByTimeAsync(BROWSER_LINK_CLICK_QUERY_TIMEOUT_MS - 1);
      expect(view.webContents.loadURL).not.toHaveBeenCalledWith('https://example.com/next');
      await vi.advanceTimersByTimeAsync(1);
    } finally { vi.useRealTimers(); }
    await vi.waitFor(() => expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://example.com/next'));
    expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-open-link-requested', expect.anything());
  });

  it('does not recreate a tab that closed before the page answered', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    let answer: (value: boolean) => void = () => {};
    view.webContents.executeJavaScriptInIsolatedWorld.mockImplementation(async (_world: number, scripts: Array<{ code: string }>) =>
      scripts[0]!.code.includes('last.url') ? new Promise<boolean>(resolve => { answer = resolve; }) : true);
    view.webContents.windowOpenHandler?.({ url: 'https://example.com/next', disposition: 'foreground-tab' });
    closeBrowser(browserId);
    answer(false);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(mocks.FakeWebContentsView.instances).toHaveLength(1);
    expect(view.webContents.loadURL).not.toHaveBeenCalledWith('https://example.com/next');
    expect(getBrowserPage(browserId)).toBeNull();
  });

  it('injects the link click tracker into each loaded page', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.emit('dom-ready');
    expect(view.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(BROWSER_ANNOTATION_WORLD, [{ code: browserLinkClickTrackingScript() }]);
  });

  it.each(['background-tab', 'foreground-tab'])('keeps agent-driven %s requests in the current tab', async (disposition) => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    answerLinkClickQuery(view.webContents, true);
    ensureBrowserDebugger(view.webContents as never, 'automation');
    await setBrowserInputActive(view.webContents as never, true);
    view.webContents.windowOpenHandler?.({ url: 'https://example.com/next', disposition });
    await setBrowserInputActive(view.webContents as never, false);
    await vi.waitFor(() => expect(view.webContents.loadURL).toHaveBeenLastCalledWith('https://example.com/next'));
    expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-open-link-requested', expect.anything());
  });

  it.each(['mailto:someone@example.com', 'tel:+8613800138000', 'obsidian://open?vault=notes', 'file:///etc/passwd'])(
    'keeps the current page intact when a link to %s is blocked',
    async (blockedUrl) => {
      setBrowserBounds(browserId, { x: 0, y: 0, width: 640, height: 480 });
      setBrowserVisible(browserId, true);
      await navigateBrowser(browserId, 'https://example.com');
      const view = mocks.FakeWebContentsView.instances[0]!;
      const before = getBrowserState(browserId);
      const generation = getBrowserGeneration(browserId);

      const blocked = { preventDefault: vi.fn() };
      view.webContents.emit('will-navigate', blocked, blockedUrl);

      expect(blocked.preventDefault).toHaveBeenCalledOnce();
      expect(getBrowserState(browserId)).toEqual(before);
      expect(getBrowserGeneration(browserId)).toBe(generation);
      expect(getBrowserPage(browserId)?.visible).toBe(true);
    },
  );

  it('does not reject a pending load waiter when a blocked scheme navigation is prevented', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.loading = true;
    view.webContents.emit('did-start-loading');
    const pending = waitForBrowserLoad(browserId, 'complete', 1000);
    view.webContents.emit('will-navigate', { preventDefault: vi.fn() }, 'mailto:someone@example.com');
    view.webContents.loading = false;
    view.webContents.emit('did-navigate');
    view.webContents.emit('did-stop-loading');
    await expect(pending).resolves.toMatchObject({ error: undefined });
  });

  it('still shows the error state when an http page fails to load', async () => {
    setBrowserBounds(browserId, { x: 0, y: 0, width: 640, height: 480 });
    setBrowserVisible(browserId, true);
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.emit('did-start-loading');
    view.webContents.emit('did-fail-load', {}, -105, 'NAME_NOT_RESOLVED', 'https://missing.invalid/', true);
    expect(getBrowserState(browserId)).toMatchObject({
      url: 'https://missing.invalid/',
      loading: false,
      error: 'NAME_NOT_RESOLVED',
    });
    expect(getBrowserPage(browserId)?.visible).toBe(false);
  });

  it('does not replace a new page favicon with a late previous-page fetch', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    let finish!: (response: Response) => void;
    view.webContents.session.fetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    view.webContents.emit('page-favicon-updated', {}, ['https://example.com/old.ico']);
    await navigateBrowser(browserId, 'https://other.test');
    view.webContents.emit('page-favicon-updated', {}, ['https://other.test/new.ico']);
    await vi.waitFor(() => expect(getBrowserState(browserId).favicon).toBe('data:image/x-icon;base64,AAABAAAA'));
    finish(new Response('old', { headers: { 'Content-Type': 'image/png' } }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(getBrowserState(browserId).favicon).toBe('data:image/x-icon;base64,AAABAAAA');
  });

  it('updates history controls, visibility, reload and clear-data state', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.history.canBack = true;
    view.webContents.history.canForward = true;
    view.webContents.emit('did-navigate', {}, 'https://example.com/two');
    expect(getBrowserState(browserId)).toMatchObject({ canGoBack: true, canGoForward: true });
    view.webContents.emit('page-favicon-updated', {}, [
      'javascript:alert(1)',
      'https://example.com/favicon.ico',
    ]);
    await vi.waitFor(() => expect(getBrowserState(browserId).favicon).toBe('data:image/x-icon;base64,AAABAAAA'));

    browserGoBack(browserId);
    browserGoForward(browserId);
    browserReload(browserId);
    expect(view.webContents.navigationHistory.goBack).toHaveBeenCalledOnce();
    expect(view.webContents.navigationHistory.goForward).toHaveBeenCalledOnce();
    expect(view.webContents.reload).toHaveBeenCalledOnce();

    setBrowserVisible(browserId, false);
    expect(getBrowserPage(browserId)?.visible).toBe(false);
    await clearBrowserData(browserId);
    expect(browserSession.clearStorageData).toHaveBeenNthCalledWith(1, { storages: ['serviceworkers'] });
    expect(browserSession.clearStorageData).toHaveBeenNthCalledWith(2);
    expect(browserSession.clearCache).toHaveBeenCalledOnce();
    expect(browserSession.clearAuthCache).toHaveBeenCalledOnce();
    expect(getBrowserState(browserId)).toEqual({
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
  });

  it('treats complete as satisfying earlier load phases and stops active loading', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    await expect(waitForBrowserLoad(browserId, 'committed', 100)).resolves.toMatchObject({
      loading: false,
    });
    await expect(waitForBrowserLoad(browserId, 'dom_ready', 100)).resolves.toMatchObject({
      loading: false,
    });
    await expect(waitForBrowserLoad(browserId, 'complete', 100)).resolves.toMatchObject({
      loading: false,
    });

    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.loading = true;
    browserStopLoading(browserId);
    expect(view.webContents.stop).toHaveBeenCalledOnce();
  });

  it('reports a bounded current URL after an oversized in-page URL change', async () => {
    await navigateBrowser(browserId, 'https://example.com/current');
    const view = mocks.FakeWebContentsView.instances[0]!;
    const oversizedUrl = `https://example.com/${'x'.repeat(5_000)}`;
    view.webContents.url = oversizedUrl;
    view.webContents.emit('did-navigate-in-page');

    expect(getBrowserState(browserId)).toMatchObject({
      url: `${oversizedUrl.slice(0, 4_095)}…`,
      urlTruncated: true,
    });
    expect(getBrowserState(browserId).url).toHaveLength(4_096);
  });

  it('navigates the full URL when the unchanged address display is truncated', async () => {
    await navigateBrowser(browserId, 'https://example.com/current');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    const full = `https://example.com/${'x'.repeat(5000)}`;
    contents.url = full;
    contents.emit('did-navigate-in-page');
    await navigateBrowser(browserId, getBrowserState(browserId).url);
    expect(contents.loadURL).toHaveBeenLastCalledWith(full);
    await navigateBrowser(browserId, 'https://example.com/edited');
    expect(contents.loadURL).toHaveBeenLastCalledWith('https://example.com/edited');
  });

  it('keeps the document generation across History API and hash navigations', async () => {
    await navigateBrowser(browserId, 'https://example.com/current');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    const generation = getBrowserGeneration(browserId);
    for (const url of ['https://example.com/route', 'https://example.com/route#section']) {
      contents.url = url;
      contents.emit('did-start-navigation', {}, url, true, true);
      contents.emit('did-navigate-in-page', {}, url, true);
      expect(getBrowserGeneration(browserId)).toBe(generation);
      expect(getBrowserState(browserId).url).toBe(url);
    }
    contents.emit('did-start-navigation', {}, 'https://example.com/new-document', false, true);
    expect(getBrowserGeneration(browserId)).toBeGreaterThan(generation!);
  });

  it('starts a fresh load generation before history and reload events arrive', async () => {
    await navigateBrowser(browserId, 'https://example.com/current');
    const view = mocks.FakeWebContentsView.instances[0]!;

    const completeLater = async (url: string, waiting: Promise<unknown>): Promise<void> => {
      let settled = false;
      void waiting.finally(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);
      view.webContents.url = url;
      view.webContents.loading = false;
      view.webContents.emit('did-navigate', {}, url);
      view.webContents.emit('dom-ready');
      view.webContents.emit('did-stop-loading');
      await expect(waiting).resolves.toMatchObject({ url, loading: false });
    };

    view.webContents.history.canBack = true;
    browserGoBack(browserId);
    await completeLater(
      'https://example.com/back',
      waitForBrowserLoad(browserId, 'complete', 100),
    );

    view.webContents.history.canForward = true;
    browserGoForward(browserId);
    await completeLater(
      'https://example.com/forward',
      waitForBrowserLoad(browserId, 'complete', 100),
    );

    view.webContents.reload.mockImplementationOnce(() => undefined);
    browserReload(browserId);
    await completeLater(
      'https://example.com/forward',
      waitForBrowserLoad(browserId, 'complete', 100),
    );
  });

  it.each([
    ['zh', '保存下载文件', '保存网页截图'],
    ['en', 'Save download', 'Save page screenshot'],
  ] as const)('localizes native save dialogs in %s', async (locale, downloadTitle, screenshotTitle) => {
    setContextMenuLocale(locale);
    await navigateBrowser(browserId, 'https://example.com');
    setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 600 });
    setBrowserVisible(browserId, true);
    const item = { getFilename: () => 'report.pdf', getURL: () => 'https://example.com/report.pdf', getURLChain: () => [], getSavePath: () => '', setSavePath: vi.fn(), setSaveDialogOptions: vi.fn(), cancel: vi.fn(), once: vi.fn() };
    browserSession.handlers.get('will-download')?.({}, item, mocks.FakeWebContentsView.instances.at(-1)!.webContents);
    expect(item.setSaveDialogOptions).toHaveBeenCalledWith(expect.objectContaining({ title: downloadTitle }));
    await captureBrowserScreenshot(browserId);
    expect(mocks.showSaveDialog).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ title: screenshotTitle }));
  });

  it('supports find, print, zoom, screenshots and device emulation', async () => {
    setBrowserBounds(browserId, { x: 300, y: 80, width: 640, height: 520 });
    setBrowserVisible(browserId, true);
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;

    browserFind(browserId, 'Example', { forward: true, findNext: false });
    expect(view.webContents.findInPage).toHaveBeenCalledWith('Example', {
      forward: true,
      findNext: false,
    });
    browserStopFind(browserId);
    expect(view.webContents.stopFindInPage).toHaveBeenCalledWith('clearSelection');

    expect(browserZoom(browserId, 'in').zoomFactor).toBe(1.1);
    expect(view.webContents.zoomFactor).toBe(1.1);
    expect(browserZoom(browserId, 'reset').zoomFactor).toBe(1);
    await expect(browserPrint(browserId)).resolves.toBe(true);
    expect(view.webContents.executeJavaScriptInIsolatedWorld).toHaveBeenCalledWith(1002, [{ code: 'window.print()' }], true);

    await expect(toggleBrowserDeviceMode(browserId)).resolves.toMatchObject({
      device: {
        profileId: 'responsive',
        width: 393,
        height: 852,
        deviceScaleFactor: 2,
        displayScale: 0.61,
      },
    });
    expect(view.webContents.debugger.attach).toHaveBeenCalledWith('1.3');
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        width: 393,
        height: 852,
        deviceScaleFactor: 2,
        mobile: true,
        scale: 0.61,
        screenOrientation: { type: 'portraitPrimary', angle: 0 },
      }),
    );
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      expect.objectContaining({
        userAgent: expect.stringContaining('Android 13; Pixel 7'),
        platform: 'Linux armv8l',
        userAgentMetadata: expect.objectContaining({
          platform: 'Android',
          model: 'Pixel 7',
          mobile: true,
        }),
      }),
    );
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setTouchEmulationEnabled',
      { enabled: true, maxTouchPoints: 5 },
    );
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setEmitTouchEventsForMouse',
      { enabled: true, configuration: 'mobile' },
    );
    expect(view.bounds).toEqual({ x: 500, y: 80, width: 240, height: 520 });

    await expect(
      updateBrowserDeviceMode(browserId, {
        enabled: true,
        profileId: 'responsive',
        orientation: 'landscape',
        width: 412,
        height: 915,
        scaleMode: 'fit',
      }),
    ).resolves.toMatchObject({
      device: {
        profileId: 'responsive',
        orientation: 'portrait',
        width: 412,
        height: 915,
      },
    });
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        width: 412,
        height: 915,
        screenOrientation: { type: 'portraitPrimary', angle: 0 },
      }),
    );

    await expect(
      updateBrowserDeviceMode(browserId, {
        enabled: true,
        profileId: 'ipad-mini',
        orientation: 'landscape',
        scaleMode: 'fixed',
        scale: 0.5,
      }),
    ).resolves.toMatchObject({
      device: {
        profileId: 'ipad-mini',
        orientation: 'landscape',
        width: 1_024,
        height: 768,
        displayScale: 0.5,
      },
    });
    expect(view.webContents.debugger.sendCommand).toHaveBeenLastCalledWith(
      'Emulation.setEmitTouchEventsForMouse',
      { enabled: true, configuration: 'mobile' },
    );
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setDeviceMetricsOverride',
      expect.objectContaining({
        width: 1_024,
        height: 768,
        scale: 0.5,
        screenOrientation: { type: 'landscapePrimary', angle: 90 },
      }),
    );
    expect(view.bounds).toEqual({ x: 364, y: 148, width: 512, height: 384 });
    expect(getBrowserPage(browserId)?.bounds).toEqual(view.bounds);

    await expect(toggleBrowserDeviceMode(browserId)).resolves.not.toHaveProperty('device');
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.clearDeviceMetricsOverride',
    );
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setTouchEmulationEnabled',
      { enabled: false },
    );
    expect(view.webContents.debugger.sendCommand).toHaveBeenCalledWith(
      'Emulation.setUserAgentOverride',
      { userAgent: '' },
    );
    expect(view.bounds).toEqual({ x: 300, y: 80, width: 640, height: 520 });
    expect(view.webContents.debugger.detach).toHaveBeenCalledOnce();

    await expect(captureBrowserScreenshot(browserId)).resolves.toBe(true);
    expect(mocks.showSaveDialog).toHaveBeenCalledOnce();
    expect(mocks.writeFile).toHaveBeenCalledWith('/tmp/browser.png', Buffer.from('png'));
  });

  it('keeps an active tab ready to render after shared browser data is cleared', async () => {
    setBrowserBounds(browserId, { x: 300, y: 80, width: 640, height: 520 });
    setBrowserVisible(browserId, true);
    await navigateBrowser(browserId, 'https://example.com/first');
    const first = mocks.FakeWebContentsView.instances[0]!;

    await clearBrowserData(browserId);
    expect(first.webContents.destroyed).toBe(true);

    await navigateBrowser(browserId, 'https://example.com/second');
    const replacement = mocks.FakeWebContentsView.instances[1]!;
    expect(replacement.visible).toBe(true);
  });

  it('keeps multiple pages independent while sharing one persistent session', async () => {
    setBrowserBounds('browser-a', { x: 300, y: 80, width: 500, height: 400 });
    setBrowserVisible('browser-a', true);
    await navigateBrowser('browser-a', 'https://example.com/a');
    const first = mocks.FakeWebContentsView.instances[0]!;

    setBrowserBounds('browser-b', { x: 300, y: 80, width: 700, height: 500 });
    setBrowserVisible('browser-b', true);
    await navigateBrowser('browser-b', 'https://example.com/b');
    const second = mocks.FakeWebContentsView.instances[1]!;

    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:kimi-browser');
    expect(first.options).toMatchObject({ webPreferences: { session: browserSession } });
    expect(second.options).toMatchObject({ webPreferences: { session: browserSession } });
    expect(getBrowserState('browser-a').url).toBe('https://example.com/a');
    expect(getBrowserState('browser-b').url).toBe('https://example.com/b');
    expect(getBrowserPage('browser-a')?.visible).toBe(false);
    expect(getBrowserPage('browser-b')?.visible).toBe(true);

    setBrowserVisible('browser-a', true);
    expect(getBrowserPage('browser-a')?.visible).toBe(true);
    expect(getBrowserPage('browser-b')?.visible).toBe(false);

    closeBrowser('browser-a');
    setBrowserVisible('browser-a', false);
    expect(first.webContents.destroyed).toBe(true);
    expect(second.webContents.destroyed).toBe(false);
    expect(getBrowserState('browser-a')).toEqual({
      url: '',
      title: '',
      loading: false,
      canGoBack: false,
      canGoForward: false,
    });
    expect(getBrowserState('browser-b').url).toBe('https://example.com/b');
  });

  it('keeps a protected page and asks through a pending dialog instead of a native prompt', async () => {
    await navigateBrowser(browserId, 'https://example.com/form');
    setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 600 });
    setBrowserVisible(browserId, true);
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    const preventDefault = vi.fn();
    contents.loadURL.mockImplementationOnce(async () => {
      contents.emit('will-prevent-unload', { preventDefault });
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 });
    });
    const onCancelled = vi.fn();
    await navigateBrowser(browserId, 'https://example.com/next', { onCancelled });
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
    expect(listBrowserDialogs(browserId)).toEqual([expect.objectContaining({ kind: 'beforeunload', origin: 'https://example.com', target: 'https://example.com/next' })]);
  });

  it('asks the user to submit a blocked form again, or to repeat an unknown navigation', async () => {
    await navigateBrowser(browserId, 'https://example.com/form');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
    expect(listBrowserDialogs(browserId)).toEqual([expect.objectContaining({ kind: 'beforeunload', repeat: 'action' })]);
    const options = vi.mocked(installBrowserPageDialogs).mock.lastCall![1];
    options.onNavigationRequested!('https://example.com/submit', 'formSubmissionPost');
    contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
    expect(listBrowserDialogs(browserId)).toEqual([expect.objectContaining({ kind: 'beforeunload', target: 'https://example.com/submit', repeat: 'form' })]);
    options.onNavigationRequested!('https://example.com/next', 'anchorClick');
    contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
    expect(listBrowserDialogs(browserId)[0]).not.toHaveProperty('repeat');
  });

  it('repeats the navigation once and lets it through when leaving is chosen', async () => {
    await navigateBrowser(browserId, 'https://example.com/form');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.loadURL.mockImplementationOnce(async () => {
      contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 });
    });
    await navigateBrowser(browserId, 'https://example.com/next');
    const [prompt] = listBrowserDialogs(browserId);
    contents.loadURL.mockClear();
    const leave = vi.fn();
    const stay = vi.fn();
    contents.loadURL.mockImplementationOnce(async () => {
      contents.emit('will-prevent-unload', { preventDefault: leave });
      contents.emit('will-prevent-unload', { preventDefault: stay });
    });
    await respondBrowserDialog(prompt!.dialogId, { accept: true }, 'agent');
    expect(contents.loadURL).toHaveBeenCalledWith('https://example.com/next');
    expect(listBrowserDialogs(browserId).map(dialog => dialog.dialogId)).not.toContain(prompt!.dialogId);
    expect(leave).toHaveBeenCalledOnce();
    expect(stay).not.toHaveBeenCalled();
  });

  it('asks again for a different navigation started after leaving was confirmed and drops the stale retry', async () => {
    await navigateBrowser(browserId, 'https://example.com/form');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.loadURL.mockImplementationOnce(async () => {
      contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 });
    });
    await navigateBrowser(browserId, 'https://example.com/next');
    const [prompt] = listBrowserDialogs(browserId);
    await respondBrowserDialog(prompt!.dialogId, { accept: true }, 'agent');
    const other = vi.fn();
    contents.loadURL.mockImplementationOnce(async () => {
      contents.emit('will-prevent-unload', { preventDefault: other });
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 });
    });
    await navigateBrowser(browserId, 'https://example.com/other');
    expect(other).not.toHaveBeenCalled();
    expect(listBrowserDialogs(browserId)).toEqual([expect.objectContaining({ kind: 'beforeunload', target: 'https://example.com/other' })]);
    contents.loadURL.mockClear();
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  it('stays on the page without retrying when the prompt is dismissed', async () => {
    await navigateBrowser(browserId, 'https://example.com/form');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.loadURL.mockImplementationOnce(async () => {
      contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 });
    });
    await navigateBrowser(browserId, 'https://example.com/next');
    const [prompt] = listBrowserDialogs(browserId);
    contents.loadURL.mockClear();
    await respondBrowserDialog(prompt!.dialogId, { accept: false }, 'user');
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(contents.loadURL).not.toHaveBeenCalled();
    const preventDefault = vi.fn();
    contents.emit('will-prevent-unload', { preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
  });

  it.each(['stay', 'cancel'] as const)('does not reuse a navigation target for a later unload after a %s', async (choice) => {
    await navigateBrowser(browserId, 'https://example.com/form');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.loadURL.mockImplementationOnce(async () => {
      contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      throw Object.assign(new Error('ERR_ABORTED (-3)'), { code: 'ERR_ABORTED', errno: -3 });
    });
    await navigateBrowser(browserId, 'https://example.com/next');
    const [prompt] = listBrowserDialogs(browserId);
    expect(prompt).toEqual(expect.objectContaining({ kind: 'beforeunload', target: 'https://example.com/next' }));
    if (choice === 'stay') await respondBrowserDialog(prompt!.dialogId, { accept: false }, 'user');
    else cancelBrowserDialog(prompt!.dialogId);
    contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
    const [again] = listBrowserDialogs(browserId);
    expect(again).toEqual(expect.objectContaining({ kind: 'beforeunload', repeat: 'action' }));
    expect(again).not.toHaveProperty('target');
    contents.loadURL.mockClear();
    await respondBrowserDialog(again!.dialogId, { accept: true }, 'user');
    await new Promise(resolve => setTimeout(resolve, 600));
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  it.each(['back', 'forward', 'reload'] as const)('restores the page state when the user stays instead of going %s', async (action) => {
    await navigateBrowser(browserId, 'https://example.com/form');
    setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 600 });
    setBrowserVisible(browserId, true);
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.history.canBack = true;
    contents.history.canForward = true;
    contents.reload.mockImplementationOnce(() => {});
    const before = getBrowserState(browserId);
    const run = { back: browserGoBack, forward: browserGoForward, reload: browserReload }[action];
    run(browserId);
    expect(getBrowserState(browserId).loading).toBe(true);
    const waiting = waitForBrowserLoad(browserId, 'complete', 1_000);
    mocks.showMessageBoxSync.mockReturnValueOnce(0);
    contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
    await expect(waiting).resolves.toMatchObject({ url: 'https://example.com/form', loading: false });
    expect(getBrowserState(browserId)).toMatchObject({ url: before.url, loading: false, error: undefined });
  });

  it.each(['back', 'forward', 'reload'] as const)('waits for going %s to start or be held by a leave confirmation', async (action) => {
    await navigateBrowser(browserId, 'https://example.com/form');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.history.canBack = true;
    contents.history.canForward = true;
    contents.reload.mockImplementation(() => {});
    const onCancelled = vi.fn();
    let settled = false;
    const held = runBrowserHistoryNavigation(browserId, action, { onCancelled }).finally(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);
    contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
    await expect(held).resolves.toMatchObject({ url: 'https://example.com/form', loading: false });
    expect(onCancelled).toHaveBeenCalledOnce();
    expect(listBrowserDialogs(browserId)).toEqual([expect.objectContaining({ kind: 'beforeunload' })]);
    const started = vi.fn();
    const going = runBrowserHistoryNavigation(browserId, action, { onCancelled: started });
    contents.emit('did-start-navigation', {}, 'https://example.com/other', false, true);
    await expect(going).resolves.toMatchObject({ loading: true });
    expect(started).not.toHaveBeenCalled();
    contents.reload.mockReset();
  });

  it.each(['back', 'forward', 'reload'] as const)('keeps waiting while a slow leave handler holds going %s and reports it undetermined at the bound', async (action) => {
    await navigateBrowser(browserId, 'https://example.com/form');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.history.canBack = true;
    contents.history.canForward = true;
    contents.reload.mockImplementation(() => {});
    vi.useFakeTimers();
    try {
      const onCancelled = vi.fn();
      const onUndetermined = vi.fn();
      let settled = false;
      const held = runBrowserHistoryNavigation(browserId, action, { onCancelled, onUndetermined }).finally(() => { settled = true; });
      await vi.advanceTimersByTimeAsync(5_000);
      expect(settled).toBe(false);
      contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
      await held;
      expect(onCancelled).toHaveBeenCalledOnce();
      expect(onUndetermined).not.toHaveBeenCalled();
      const stuck = vi.fn();
      const going = runBrowserHistoryNavigation(browserId, action, { onCancelled: stuck, onUndetermined }).finally(() => { settled = true; });
      settled = false;
      await vi.advanceTimersByTimeAsync(14_000);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1_000);
      await going;
      expect(onUndetermined).toHaveBeenCalledOnce();
      expect(stuck).not.toHaveBeenCalled();
      const controller = new AbortController();
      const aborted = vi.fn();
      const cancelling = runBrowserHistoryNavigation(browserId, action, { onUndetermined: aborted, signal: controller.signal });
      controller.abort();
      await cancelling;
      expect(aborted).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
      contents.reload.mockReset();
    }
  });

  it('ignores a later refused unload once the history navigation has committed', async () => {
    await navigateBrowser(browserId, 'https://example.com/form');
    setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 600 });
    setBrowserVisible(browserId, true);
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.history.canBack = true;
    browserGoBack(browserId);
    contents.emit('did-navigate', {}, 'https://example.com/form');
    mocks.showMessageBoxSync.mockReturnValueOnce(0);
    const waiting = waitForBrowserLoad(browserId, 'complete', 50);
    contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
    await expect(waiting).rejects.toThrow('Timed out');
  });

  it('reports a page as uncommitted from the start of a navigation until the new document commits', async () => {
    await navigateBrowser(browserId, 'https://example.com/form');
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    expect(getBrowserPage(browserId)?.committed).toBe(true);
    contents.reload.mockImplementationOnce(() => {});
    browserReload(browserId);
    expect(getBrowserPage(browserId)?.committed).toBe(false);
    contents.emit('did-navigate', {}, 'https://example.com/form');
    expect(getBrowserPage(browserId)?.committed).toBe(true);
  });

  it('repeats a history navigation when the user chooses to leave', async () => {
    await navigateBrowser(browserId, 'https://example.com/form');
    setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 600 });
    setBrowserVisible(browserId, true);
    const contents = mocks.FakeWebContentsView.instances[0]!.webContents;
    contents.reload.mockImplementationOnce(() => {});
    browserReload(browserId);
    contents.emit('will-prevent-unload', { preventDefault: vi.fn() });
    const [prompt] = listBrowserDialogs(browserId);
    contents.reload.mockClear();
    contents.reload.mockImplementationOnce(() => {});
    await respondBrowserDialog(prompt!.dialogId, { accept: true }, 'user');
    expect(contents.reload).toHaveBeenCalledOnce();
    expect(getBrowserState(browserId).loading).toBe(true);
  });

  it.each(['hidden', 'unfocused'] as const)('keeps protected background pages without a native prompt when %s', async (state) => {
    await navigateBrowser(browserId, 'https://example.com/form');
    setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 600 });
    setBrowserVisible(browserId, state !== 'hidden');
    host.focused = state !== 'unfocused';
    const preventDefault = vi.fn();
    mocks.FakeWebContentsView.instances[0]!.webContents.emit('will-prevent-unload', { preventDefault });
    expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
    expect(preventDefault).not.toHaveBeenCalled();
    expect(listBrowserDialogs(browserId)).toEqual([expect.objectContaining({ kind: 'beforeunload' })]);
  });

  it('starts a new navigation generation when a committed page navigates while resources are loading', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.loading = true;
    view.webContents.emit('did-start-loading');
    const provisionalGeneration = getBrowserGeneration(browserId);
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/first', false, true);
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/redirect', false, true);
    expect(getBrowserGeneration(browserId)).toBe(provisionalGeneration);
    view.webContents.emit('did-navigate');
    view.webContents.emit('dom-ready');
    expect(getBrowserState(browserId).loading).toBe(true);
    const loadingGeneration = getBrowserGeneration(browserId)!;
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/next', false, true);
    expect(getBrowserGeneration(browserId)).toBeGreaterThan(loadingGeneration);
  });

  it('keeps the native error page hidden through load-stop and restores it after a successful retry', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    setBrowserBounds(browserId, { x: 0, y: 0, width: 800, height: 600 });
    setBrowserVisible(browserId, true);
    expect(getBrowserPage(browserId)?.visible).toBe(true);
    mocks.recordBrowserHistory.mockClear();
    const view = mocks.FakeWebContentsView.instances[0]!;
    view.webContents.emit('did-start-loading');
    view.webContents.emit(
      'did-fail-load',
      {},
      -105,
      'NAME_NOT_RESOLVED',
      'https://missing.invalid/',
      true,
    );
    expect(getBrowserPage(browserId)?.visible).toBe(false);
    expect(getBrowserState(browserId)).toMatchObject({
      url: 'https://missing.invalid/',
      loading: false,
      error: 'NAME_NOT_RESOLVED',
    });
    view.webContents.emit('did-stop-loading');
    expect(getBrowserPage(browserId)?.visible).toBe(false);
    expect(getBrowserState(browserId)).toMatchObject({ url: 'https://missing.invalid/', error: 'NAME_NOT_RESOLVED', loading: false });
    expect(mocks.recordBrowserHistory).not.toHaveBeenCalled();
    await navigateBrowser(browserId, 'https://example.com/retry');
    expect(getBrowserPage(browserId)?.visible).toBe(true);
    expect(getBrowserState(browserId).error).toBeUndefined();
  });
});


describe('browser page cloning', () => {
  it('creates an independent page with the same history and zoom', async () => {
    const host = createHost();
    mocks.fromPartition.mockReturnValue(new mocks.FakeSession());
    attachBrowserWindow(host as never);
    setBrowserBounds('clone-source', { x: 0, y: 0, width: 600, height: 500 });
    setBrowserVisible('clone-source', true);
    await navigateBrowser('clone-source', 'https://example.com/two');
    const source = getBrowserPage('clone-source')!;
    const entries = [{ url: 'https://example.com/one', title: 'One' }, { url: 'https://example.com/two', title: 'Two' }];
    vi.spyOn(source.webContents.navigationHistory, 'getAllEntries').mockReturnValue(entries);
    vi.spyOn(source.webContents.navigationHistory, 'getActiveIndex').mockReturnValue(1);
    browserZoom('clone-source', 'in');
    cloneBrowser('clone-source', 'clone-target');
    const target = getBrowserPage('clone-target')!;
    expect(target.webContents).not.toBe(source.webContents);
    expect(target.visible).toBe(false);
    expect(mocks.FakeWebContentsView.instances.at(-1)!.webContents.navigationHistory.restore).toHaveBeenCalledWith({ entries, index: 1 });
    expect(target.webContents.getZoomFactor()).toBe(1.1);
    closeBrowser('clone-target');
    expect(source.webContents.isDestroyed()).toBe(false);
    expect(() => cloneBrowser('clone-source', 'clone-source')).toThrow('already exists');
    destroyBrowserView();
  });
});

it('keeps hidden pages attached to the host and foreground pages below overlays', async () => {
  const host = createHost();
  const renderer = host.hostView;
  const overlay = {};
  host.contentView.children.push(renderer, overlay);
  mocks.fromPartition.mockReturnValue(new mocks.FakeSession());
  attachBrowserWindow(host as never);
  await navigateBrowser('layer-test', 'https://example.com');
  const page = getBrowserPage('layer-test')!;
  const view = mocks.FakeWebContentsView.instances.at(-1)!;
  expect(page.bounds).toMatchObject({ width: 1280, height: 720 });
  expect(page.visible).toBe(false);
  expect(host.contentView.children).toEqual([renderer, overlay]);
  const nursery = mocks.FakeBaseWindow.instances.at(-1)!;
  expect(nursery).not.toBe(host);
  expect(nursery.contentView.children).toContain(view);
  expect(view.visible).toBe(true);
  setBrowserBounds('layer-test', { x: 0, y: 0, width: 600, height: 400 });
  setBrowserVisible('layer-test', true);
  expect(host.contentView.children).toEqual([renderer, view, overlay]);
  expect(nursery.contentView.children).not.toContain(view);
  expect(view.bounds).toMatchObject({ width: 600, height: 400 });
  expect(view.visible).toBe(true);
  setBrowserVisible('layer-test', false);
  expect(host.contentView.children).toEqual([renderer, view, overlay]);
  expect(view.visible).toBe(false);
  expect(view.bounds).toMatchObject({ width: 600, height: 400 });
  setBrowserVisible('layer-test', true);
  expect(host.contentView.children).toEqual([renderer, view, overlay]);
  expect(view.visible).toBe(true);
  closeBrowser('layer-test');
  expect(host.contentView.children).toEqual([renderer, overlay]);
  destroyBrowserView();
  expect(mocks.FakeBaseWindow.instances.at(-1)?.destroyed).toBe(true);
});

describe('raising the app renderer above browser pages while a dialog occludes them', () => {
  async function layered() {
    const host = createHost();
    const renderer = host.hostView;
    const overlay = {};
    overlayViews.add(overlay);
    host.contentView.children.push(renderer, overlay);
    mocks.fromPartition.mockReturnValue(new mocks.FakeSession());
    attachBrowserWindow(host as never);
    await navigateBrowser('occluded-page', 'https://example.com');
    setBrowserBounds('occluded-page', { x: 0, y: 0, width: 600, height: 400 });
    setBrowserVisible('occluded-page', true);
    const page = mocks.FakeWebContentsView.instances.at(-1)!;
    return { host, renderer, overlay, page };
  }

  afterEach(() => destroyBrowserView());

  it('orders pages, host, overlay while occluded and restores pages above the host afterwards', async () => {
    const { host, renderer, overlay, page } = await layered();
    expect(host.contentView.children).toEqual([renderer, page, overlay]);
    setBrowserOccluded('occluded-page', true);
    expect(isBrowserOccluded()).toBe(true);
    expect(host.contentView.children).toEqual([page, renderer, overlay]);
    expect(browserHostLayerOrder(host as never, true)).toEqual([page, renderer, overlay]);
    expect(page.visible).toBe(true);
    setBrowserOccluded('occluded-page', false);
    expect(isBrowserOccluded()).toBe(false);
    expect(host.contentView.children).toEqual([renderer, page, overlay]);
  });

  it('keeps pages attached while occluded below the host', async () => {
    const { host, renderer, overlay, page } = await layered();
    setBrowserOccluded('occluded-page', true);
    setBrowserVisible('occluded-page', false);
    await navigateBrowser('second-page', 'https://example.org');
    setBrowserBounds('second-page', { x: 0, y: 0, width: 600, height: 400 });
    setBrowserVisible('second-page', true);
    const second = mocks.FakeWebContentsView.instances.at(-1)!;
    expect(host.contentView.children.indexOf(second)).toBeLessThan(host.contentView.children.indexOf(renderer));
    expect(host.contentView.children.at(-1)).toBe(overlay);
    setBrowserOccluded('occluded-page', false);
    expect(host.contentView.children[0]).toBe(renderer);
    expect(host.contentView.children).toContain(page);
  });

  it('moves keyboard focus from the page to the app renderer and gives it back when the dialog closes', async () => {
    const { host, page } = await layered();
    mocks.focusedWebContents = page.webContents;
    setBrowserOccluded('occluded-page', true);
    expect(host.webContents.focus).toHaveBeenCalledTimes(1);
    mocks.focusedWebContents = host.webContents;
    page.webContents.focus.mockClear();
    setBrowserOccluded('occluded-page', false);
    expect(page.webContents.focus).toHaveBeenCalledTimes(1);
    mocks.focusedWebContents = null;
  });

  it('keeps focus in the app renderer when the page was hidden while the dialog was open', async () => {
    const { page } = await layered();
    mocks.focusedWebContents = page.webContents;
    setBrowserOccluded('occluded-page', true);
    setBrowserVisible('occluded-page', false);
    expect(page.visible).toBe(false);
    page.webContents.focus.mockClear();
    mocks.focusedWebContents = null;
    setBrowserOccluded('occluded-page', false);
    expect(page.webContents.focus).not.toHaveBeenCalled();
  });

  it('stays raised until every occluded tab is released and resets on renderer navigation', async () => {
    const { host, renderer } = await layered();
    setBrowserOccluded('occluded-page', true);
    setBrowserOccluded('other-tab', true);
    setBrowserOccluded('occluded-page', false);
    expect(isBrowserOccluded()).toBe(true);
    host.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false });
    expect(isBrowserOccluded()).toBe(false);
    expect(host.contentView.children[0]).toBe(renderer);
  });
});

describe('rendering hidden pages for captures', () => {
  async function shown(browserId: string) {
    const host = createHost();
    const renderer = host.hostView;
    const overlay = {};
    host.contentView.children.push(renderer, overlay);
    mocks.fromPartition.mockReturnValue(new mocks.FakeSession());
    attachBrowserWindow(host as never);
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    setBrowserBounds(browserId, { x: 0, y: 0, width: 600, height: 400 });
    setBrowserVisible(browserId, true);
    host.contentView.addChildView.mockClear();
    host.contentView.removeChildView.mockClear();
    return { host, renderer, overlay, view };
  }

  async function shownThenHidden(browserId: string) {
    const shownPage = await shown(browserId);
    setBrowserVisible(browserId, false);
    shownPage.host.contentView.addChildView.mockClear();
    shownPage.host.contentView.removeChildView.mockClear();
    return shownPage;
  }

  const windowListeners = (host: ReturnType<typeof createHost>) =>
    ['minimize', 'hide', 'restore', 'show'].reduce((count, event) => count + (host.handlers.get(event)?.length ?? 0), 0);

  afterEach(() => destroyBrowserView());

  it('keeps a page that was shown and then hidden producing frames while it is captured, without moving it', async () => {
    const { host, renderer, overlay, view } = await shownThenHidden('hidden-capture');
    const first = keepBrowserPageRendering(view.webContents as never);
    const second = keepBrowserPageRendering(view.webContents as never);
    expect(view.webContents.beginFrameSubscription).toHaveBeenCalledTimes(1);
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    expect(view.visible).toBe(false);
    expect(host.contentView.addChildView).not.toHaveBeenCalled();
    expect(host.contentView.removeChildView).not.toHaveBeenCalled();
    first();
    first();
    expect(view.webContents.endFrameSubscription).not.toHaveBeenCalled();
    second();
    expect(view.webContents.endFrameSubscription).toHaveBeenCalledTimes(1);
    const third = keepBrowserPageRendering(view.webContents as never);
    expect(view.webContents.beginFrameSubscription).toHaveBeenCalledTimes(2);
    third();
    expect(view.webContents.endFrameSubscription).toHaveBeenCalledTimes(2);
  });

  it('moves a hidden page out of a minimized or hidden main window before it is captured', async () => {
    const { host, renderer, overlay, view } = await shownThenHidden('parked-capture');
    host.visible = false;
    const release = keepBrowserPageRendering(view.webContents as never);
    const nursery = mocks.FakeBaseWindow.instances.at(-1)!;
    expect(nursery).not.toBe(host);
    expect(host.contentView.children).toEqual([renderer, overlay]);
    expect(nursery.contentView.children).toContain(view);
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 600, height: 400 });
    expect(view.webContents.beginFrameSubscription).not.toHaveBeenCalled();
    release();
    expect(view.webContents.endFrameSubscription).not.toHaveBeenCalled();
    host.visible = true;
    setBrowserVisible('parked-capture', true);
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(nursery.contentView.children).not.toContain(view);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 600, height: 400 });
    expect(view.visible).toBe(true);
    setBrowserVisible('parked-capture', false);
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    expect(view.visible).toBe(false);
  });

  it('leaves pages alone when they already render', async () => {
    const { host, view } = await shown('shown-capture');
    keepBrowserPageRendering(view.webContents as never)();
    expect(host.contentView.children).toContain(view);
    await navigateBrowser('never-shown-capture', 'https://example.com/other');
    const parked = mocks.FakeWebContentsView.instances.at(-1)!;
    keepBrowserPageRendering(parked.webContents as never)();
    keepBrowserPageRendering({} as never)();
    for (const candidate of [view, parked]) {
      expect(candidate.webContents.beginFrameSubscription).not.toHaveBeenCalled();
      expect(candidate.visible).toBe(true);
    }
    expect(host.contentView.children).not.toContain(parked);
    expect(host.contentView.removeChildView).not.toHaveBeenCalled();
    expect(host.contentView.addChildView).not.toHaveBeenCalled();
    expect(windowListeners(host)).toBe(0);
  });

  it('lends a shown page to the background window while its main window is hidden and returns it afterwards', async () => {
    const { host, renderer, overlay, view } = await shown('borrowed-capture');
    host.visible = false;
    const release = keepBrowserPageRendering(view.webContents as never);
    const nursery = mocks.FakeBaseWindow.instances.at(-1)!;
    expect(nursery).not.toBe(host);
    expect(host.contentView.children).toEqual([renderer, overlay]);
    expect(nursery.contentView.children).toContain(view);
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 600, height: 400 });
    setBrowserBounds('borrowed-capture', { x: 10, y: 20, width: 600, height: 400 });
    expect(nursery.contentView.children).toContain(view);
    expect(view.bounds).toEqual({ x: 0, y: 0, width: 600, height: 400 });
    release();
    release();
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1);
    expect(nursery.contentView.children).not.toContain(view);
    expect(view.visible).toBe(true);
    expect(view.bounds).toEqual({ x: 10, y: 20, width: 600, height: 400 });
    expect(view.webContents.beginFrameSubscription).not.toHaveBeenCalled();
    expect(windowListeners(host)).toBe(0);
  });

  it('follows the main window when it is minimized, hidden or restored during a capture', async () => {
    const { host, renderer, overlay, view } = await shown('minimized-capture');
    const release = keepBrowserPageRendering(view.webContents as never);
    expect(host.contentView.removeChildView).not.toHaveBeenCalled();
    host.visible = false;
    host.emit('minimize');
    expect(host.contentView.children).toEqual([renderer, overlay]);
    host.visible = true;
    host.emit('restore');
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    host.visible = false;
    host.emit('hide');
    expect(host.contentView.children).toEqual([renderer, overlay]);
    host.visible = true;
    host.emit('show');
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    host.visible = false;
    host.emit('minimize');
    release();
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    expect(windowListeners(host)).toBe(0);
    host.emit('minimize');
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
  });

  it('parks a hidden page when its main window is minimized during the capture', async () => {
    const { host, renderer, overlay, view } = await shownThenHidden('hidden-minimized-capture');
    const release = keepBrowserPageRendering(view.webContents as never);
    expect(view.webContents.beginFrameSubscription).toHaveBeenCalledTimes(1);
    host.visible = false;
    host.emit('minimize');
    const nursery = mocks.FakeBaseWindow.instances.at(-1)!;
    expect(host.contentView.children).toEqual([renderer, overlay]);
    expect(nursery.contentView.children).toContain(view);
    expect(view.visible).toBe(true);
    release();
    expect(view.webContents.endFrameSubscription).toHaveBeenCalledTimes(1);
    expect(nursery.contentView.children).toContain(view);
    host.visible = true;
    host.emit('restore');
    expect(nursery.contentView.children).toContain(view);
    setBrowserVisible('hidden-minimized-capture', true);
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(1);
  });

  it('returns a lent page only after the last overlapping capture and not once it was hidden meanwhile', async () => {
    const { host, renderer, overlay, view } = await shown('overlapping-capture');
    host.visible = false;
    const first = keepBrowserPageRendering(view.webContents as never);
    const second = keepBrowserPageRendering(view.webContents as never);
    first();
    expect(host.contentView.children).toEqual([renderer, overlay]);
    second();
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    const third = keepBrowserPageRendering(view.webContents as never);
    expect(host.contentView.children).toEqual([renderer, overlay]);
    setBrowserVisible('overlapping-capture', false);
    third();
    expect(host.contentView.children).toEqual([renderer, overlay]);
    host.visible = true;
    setBrowserVisible('overlapping-capture', true);
    expect(host.contentView.children).toEqual([renderer, view, overlay]);
    expect(host.contentView.addChildView).toHaveBeenCalledTimes(2);
    expect(windowListeners(host)).toBe(0);
  });
});

it('returns focus to the main renderer when hiding a focused page', async () => {
  const host = createHost();
  mocks.fromPartition.mockReturnValue(new mocks.FakeSession());
  attachBrowserWindow(host as never);
  await navigateBrowser('focus-handoff', 'https://example.com');
  const view = mocks.FakeWebContentsView.instances.at(-1)!;
  setBrowserBounds('focus-handoff', { x: 0, y: 0, width: 600, height: 400 });
  setBrowserVisible('focus-handoff', true);
  view.webContents.focus();
  expect(host.webContents.focus).not.toHaveBeenCalled();
  setBrowserVisible('focus-handoff', false);
  expect(view.visible).toBe(false);
  expect(host.webContents.focus).toHaveBeenCalledTimes(1);
  destroyBrowserView();
});

it('attaches a restored page at its final bounds in a single insert', async () => {
  const host = createHost();
  const renderer = host.hostView;
  const overlayA = {};
  const overlayB = {};
  host.contentView.children.push(renderer, overlayA, overlayB);
  mocks.fromPartition.mockReturnValue(new mocks.FakeSession());
  attachBrowserWindow(host as never);
  await navigateBrowser('attach-order', 'https://example.com');
  const view = mocks.FakeWebContentsView.instances.at(-1)!;
  setBrowserBounds('attach-order', { x: 40, y: 30, width: 600, height: 400 });
  setBrowserVisible('attach-order', true);
  expect(host.contentView.children).toEqual([renderer, view, overlayA, overlayB]);
  expect(view.bounds).toEqual({ x: 40, y: 30, width: 600, height: 400 });
  expect(view.visible).toBe(true);
  destroyBrowserView();
});

describe('browser-view local HTML files', () => {
  const browserId = 'browser-local';
  const page = 'file:///Users/me/site/index.html';
  let host: ReturnType<typeof createHost>;

  beforeEach(() => {
    destroyBrowserView();
    mocks.FakeWebContentsView.instances = [];
    vi.clearAllMocks();
    mocks.fromPartition.mockReturnValue(new mocks.FakeSession());
    host = createHost();
    attachBrowserWindow(host as never);
    setLocalPagesPolicy(async () => true);
  });

  afterEach(() => {
    setLocalPagesPolicy(async () => false);
    setBrowserPagePersistence(null);
    destroyBrowserView();
  });

  it('loads a file URL, shows it in the address bar, records it in history and saves it with the session', async () => {
    const savePage = vi.fn();
    setBrowserPagePersistence({ getPage: () => undefined, savePage, deletePage: vi.fn(), flush: vi.fn(), setDefaultZoom: vi.fn() });
    const state = await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    expect(view.webContents.loadURL).toHaveBeenCalledWith(page);
    expect(state).toMatchObject({ url: page, title: `Title: ${page}`, loading: false });
    expect(getBrowserState(browserId).url).toBe(page);
    expect(getBrowserPage(browserId)?.localFile).toBe(true);
    expect(mocks.recordBrowserHistory).toHaveBeenCalledWith(expect.objectContaining({ url: page, title: `Title: ${page}` }));
    expect(savePage).toHaveBeenLastCalledWith(browserId, expect.objectContaining({ url: page, title: `Title: ${page}` }));
  });

  it('restores a saved local file page after relaunch once local pages are allowed', async () => {
    setBrowserPagePersistence({ getPage: (id: string) => (id === browserId ? { url: page, title: 'Saved', zoomFactor: 1 } : undefined), savePage: vi.fn(), deletePage: vi.fn(), flush: vi.fn(), setDefaultZoom: vi.fn() });
    expect(getBrowserState(browserId)).toMatchObject({ url: page, title: 'Saved' });
    restoreBrowser(browserId);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances.at(-1)?.webContents.loadURL).toHaveBeenCalledWith(page));
    await vi.waitFor(() => expect(getBrowserState(browserId)).toMatchObject({ url: page, loading: false }));
  });

  it('keeps a restored local file tab unloaded with an error while local pages are turned off, including on reload', async () => {
    const savePage = vi.fn();
    setBrowserPagePersistence({ getPage: (id: string) => (id === browserId ? { url: page, title: 'Saved', zoomFactor: 1 } : undefined), savePage, deletePage: vi.fn(), flush: vi.fn(), setDefaultZoom: vi.fn() });
    const allowed = vi.fn(async () => false);
    setLocalPagesPolicy(allowed);
    restoreBrowser(browserId);
    await vi.waitFor(() => expect(getBrowserState(browserId).error).toContain('file:// privileges'));
    await new Promise(resolve => setImmediate(resolve));
    browserReload(browserId);
    await vi.waitFor(() => expect(allowed).toHaveBeenCalledTimes(2));
    expect(getBrowserState(browserId).url).toBe(page);
    expect(mocks.FakeWebContentsView.instances).toHaveLength(0);
    expect(savePage).toHaveBeenLastCalledWith(browserId, expect.objectContaining({ url: page }));
  });

  it('loads a file URL or local path from the address bar only when asked for a local file', async () => {
    await expect(navigateBrowser(browserId, page)).rejects.toThrow('only http(s) URLs are allowed');
    await expect(navigateBrowser(browserId, '/Users/me/site/index.html')).resolves.toMatchObject({ url: 'https://www.google.com/search?q=%2FUsers%2Fme%2Fsite%2Findex.html' });
    const state = await navigateBrowser(browserId, `${page}?tab=1#top`, { localFile: true });
    expect(state).toMatchObject({ url: `${page}?tab=1#top`, loading: false });
    expect(mocks.FakeWebContentsView.instances.at(-1)!.webContents.loadURL).toHaveBeenLastCalledWith(`${page}?tab=1#top`);
    await navigateBrowser(browserId, '/Users/me/site/other page.png', { localFile: true });
    expect(getBrowserState(browserId).url).toBe('file:///Users/me/site/other%20page.png');
    await expect(navigateBrowser(browserId, `/Users/${'x'.repeat(5_000)}`, { localFile: true })).rejects.toThrow('too long');
  });

  it('marks a local file page as refused for agents until local files are allowed', async () => {
    await openBrowserLocalFile(browserId, page);
    expect(getBrowserPage(browserId)?.localFile).toBe(true);
    const data = mocks.getBrowserData.getMockImplementation()!;
    mocks.getBrowserData.mockImplementation(() => ({ ...data(), preferences: { ...data().preferences, agentLocalFiles: true } }));
    try {
      expect(getBrowserPage(browserId)?.localFile).toBe(false);
    } finally {
      mocks.getBrowserData.mockImplementation(data);
    }
  });

  it('reports whether a history navigation target is a local file', async () => {
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    vi.spyOn(view.webContents.navigationHistory, 'getAllEntries').mockReturnValue([
      { url: page, title: 'Local' },
      { url: 'https://example.com/', title: 'Example' },
    ]);
    vi.spyOn(view.webContents.navigationHistory, 'getActiveIndex').mockReturnValue(1);
    expect(browserHistoryTargetIsLocalFile(browserId, -1)).toBe(true);
    expect(browserHistoryTargetIsLocalFile(browserId, 1)).toBe(false);
    expect(browserHistoryTargetIsLocalFile('browser-unknown', -1)).toBe(false);
  });

  it('installs the file read guard on the browser session', async () => {
    const browserSession = new mocks.FakeSession();
    mocks.fromPartition.mockReturnValue(browserSession);
    await openBrowserLocalFile(browserId, page);
    expect(browserSession.webRequest.onBeforeRequest).toHaveBeenCalledOnce();
    expect(browserSession.webRequest.onBeforeRequest).toHaveBeenCalledWith({ urls: ['file://*/*'] }, expect.any(Function));
    const listener = browserSession.webRequest.onBeforeRequest.mock.calls[0]![1] as (details: unknown, callback: (response: unknown) => void) => void;
    const callback = vi.fn();
    listener({ resourceType: 'xhr', frame: {} }, callback);
    listener({ resourceType: 'script', frame: {} }, callback);
    expect(callback.mock.calls).toEqual([[{ cancel: true }], [{ cancel: false }]]);
    expect(browserSession.webRequest.onHeadersReceived).toHaveBeenCalledWith({ urls: ['file://*/*'] }, expect.any(Function));
  });

  it('clears the local title when the page navigates on to the web before it commits', async () => {
    const savePage = vi.fn();
    setBrowserPagePersistence({ getPage: () => undefined, savePage, deletePage: vi.fn(), flush: vi.fn(), setDefaultZoom: vi.fn() });
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    savePage.mockClear();
    view.webContents.emit('did-start-navigation', {}, 'https://example.com/slow', false, true);
    expect(getBrowserState(browserId).url).toBe('https://example.com/slow');
    expect(savePage).toHaveBeenCalled();
    expect(savePage.mock.calls.every(([, saved]) => (saved as { title: string }).title === '')).toBe(true);
  });

  it('settles once the local page commits, even if its resources never finish loading', async () => {
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    const slow = 'file:///Users/me/site/slow.html';
    view.webContents.loadURL.mockImplementationOnce((url: string) => {
      view.webContents.loading = true;
      view.webContents.emit('did-start-loading');
      view.webContents.url = url;
      view.webContents.emit('did-navigate', {}, url);
      return new Promise<void>(() => {});
    });
    await expect(openBrowserLocalFile(browserId, slow)).resolves.toMatchObject({ url: slow });
  });

  it('gives up when a local page never commits', async () => {
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    view.webContents.loadURL.mockImplementationOnce(() => new Promise<void>(() => {}));
    vi.useFakeTimers();
    try {
      const opening = openBrowserLocalFile(browserId, 'file:///Users/me/site/stalled.html');
      const outcome = expect(opening).rejects.toThrow('Timed out waiting for browser committed');
      await vi.advanceTimersByTimeAsync(10_001);
      await outcome;
    } finally { vi.useRealTimers(); }
  });

  it('refuses anything that is not a file URL', async () => {
    await expect(openBrowserLocalFile(browserId, 'https://example.com/index.html')).rejects.toThrow('not a file URL');
    await expect(openBrowserLocalFile(browserId, '/Users/me/site/index.html')).rejects.toThrow('not a file URL');
    expect(mocks.FakeWebContentsView.instances).toHaveLength(0);
  });

  it('lets a local page follow links to other local files and to the web', async () => {
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    for (const target of ['file:///Users/me/index.html', 'https://example.com/']) {
      const event = { preventDefault: vi.fn() };
      view.webContents.emit('will-navigate', event, target);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    const blocked = { preventDefault: vi.fn() };
    view.webContents.emit('will-navigate', blocked, 'javascript:alert(1)');
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
  });

  it('reports an in-page navigation to another local file as a local page', async () => {
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    const sibling = 'file:///Users/me/other.html';
    view.webContents.emit('did-start-navigation', {}, sibling, false, true);
    await view.webContents.loadURL(sibling);
    expect(getBrowserState(browserId).url).toBe(sibling);
    expect(getBrowserPage(browserId)?.localFile).toBe(true);
  });

  it('opens target=_blank local links from a local page in the same tab', async () => {
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    expect(view.webContents.windowOpenHandler?.({ url: 'file:///Users/me/site/docs.html' })).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(view.webContents.loadURL).toHaveBeenLastCalledWith('file:///Users/me/site/docs.html'));
  });

  it.each(['background-tab', 'foreground-tab'])('opens a %s local link from a local page in a new tab with a single-use grant', async (disposition) => {
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    view.webContents.loadURL.mockClear();
    const sibling = 'file:///Users/me/site/notes.txt';
    expect(view.webContents.windowOpenHandler?.({ url: sibling, disposition })).toEqual({ action: 'deny' });
    await vi.waitFor(() => expect(host.webContents.send).toHaveBeenCalledWith('kimi:browser-open-link-requested', { browserId, url: sibling, ...(disposition === 'background-tab' ? { background: true } : {}) }));
    expect(view.webContents.loadURL).not.toHaveBeenCalled();
    expect(takeLocalLinkGrant('file:///Users/me/site/other.txt')).toBe(false);
    expect(takeLocalLinkGrant(sibling)).toBe(true);
    expect(takeLocalLinkGrant(sibling)).toBe(false);
  });

  it('grants each of several quick clicks on the same local link separately', async () => {
    await openBrowserLocalFile(browserId, page);
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    const sibling = 'file:///Users/me/site/twice.html';
    view.webContents.windowOpenHandler?.({ url: sibling, disposition: 'background-tab' });
    view.webContents.windowOpenHandler?.({ url: sibling, disposition: 'background-tab' });
    expect(takeLocalLinkGrant(sibling)).toBe(true);
    expect(takeLocalLinkGrant(sibling)).toBe(true);
    expect(takeLocalLinkGrant(sibling)).toBe(false);
  });

  it('lets a local link grant expire', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await openBrowserLocalFile(browserId, page);
      const view = mocks.FakeWebContentsView.instances.at(-1)!;
      view.webContents.windowOpenHandler?.({ url: 'file:///Users/me/site/late.html', disposition: 'background-tab' });
      vi.setSystemTime(Date.now() + 10_001);
      expect(takeLocalLinkGrant('file:///Users/me/site/late.html')).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('keeps web pages from opening local links in new tabs', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    view.webContents.windowOpenHandler?.({ url: page, disposition: 'background-tab' });
    await Promise.resolve();
    expect(host.webContents.send).not.toHaveBeenCalledWith('kimi:browser-open-link-requested', expect.anything());
    expect(takeLocalLinkGrant(page)).toBe(false);
  });

  it('keeps web pages away from local files', async () => {
    await navigateBrowser(browserId, 'https://example.com');
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    expect(getBrowserPage(browserId)?.localFile).toBe(false);
    const blocked = { preventDefault: vi.fn() };
    view.webContents.emit('will-navigate', blocked, page);
    expect(blocked.preventDefault).toHaveBeenCalledOnce();
    view.webContents.windowOpenHandler?.({ url: page });
    await Promise.resolve();
    expect(view.webContents.loadURL).not.toHaveBeenCalledWith(page);
    await expect(navigateBrowser(browserId, page)).rejects.toThrow('http(s)');
  });

  it('reloads a suspended local page within the session', async () => {
    await openBrowserLocalFile(browserId, page);
    suspendBrowser(browserId);
    restoreBrowser(browserId);
    await vi.waitFor(() => expect(mocks.FakeWebContentsView.instances).toHaveLength(2));
    const view = mocks.FakeWebContentsView.instances.at(-1)!;
    await vi.waitFor(() => expect(view.webContents.loadURL).toHaveBeenCalledWith(page));
    expect(getBrowserState(browserId).url).toBe(page);
  });
});

describe('browser-view host zoom geometry', () => {
  let host: ReturnType<typeof createHost>;

  beforeEach(() => {
    host = createHost();
    mocks.fromPartition.mockReturnValue(new mocks.FakeSession());
    attachBrowserWindow(host as never);
  });

  afterEach(() => destroyBrowserView());

  async function openPage(browserId = 'zoom-page') {
    await navigateBrowser(browserId, 'https://example.com/');
    setBrowserBounds(browserId, { x: 100, y: 80, width: 800, height: 600 });
    setBrowserVisible(browserId, true);
    return mocks.FakeWebContentsView.instances.at(-1)!;
  }

  it('places the page view at the reported bounds when the host window is not zoomed', async () => {
    const page = await openPage();
    expect(page.bounds).toEqual({ x: 100, y: 80, width: 800, height: 600 });
  });

  it('converts reported CSS bounds to device bounds when the host window is zoomed out', async () => {
    const page = await openPage();
    host.webContents.zoomFactor = 0.8;
    setBrowserBounds('zoom-page', { x: 100, y: 80, width: 800, height: 600 });
    expect(page.bounds).toEqual({ x: 80, y: 64, width: 640, height: 480 });
  });

  it('converts reported CSS bounds to device bounds when the host window is zoomed in', async () => {
    const page = await openPage();
    host.webContents.zoomFactor = 1.25;
    setBrowserBounds('zoom-page', { x: 100, y: 80, width: 800, height: 600 });
    expect(page.bounds).toEqual({ x: 125, y: 100, width: 1000, height: 750 });
  });

  it('snaps transformed edges outward so fractional zooms leave no gaps', async () => {
    const page = await openPage();
    host.webContents.zoomFactor = 0.8;
    setBrowserBounds('zoom-page', { x: 101, y: 81, width: 801, height: 601 });
    expect(page.bounds).toEqual({ x: 80, y: 64, width: 642, height: 482 });
    setBrowserBounds('zoom-page', { x: 302, y: 80, width: 801, height: 600 });
    expect(page.bounds).toEqual({ x: 241, y: 64, width: 642, height: 480 });
  });

  it('reports converted bounds to page automation while the host is zoomed', async () => {
    await openPage();
    host.webContents.zoomFactor = 0.8;
    setBrowserBounds('zoom-page', { x: 100, y: 80, width: 800, height: 600 });
    expect(getBrowserPage('zoom-page')?.bounds).toEqual({ x: 80, y: 64, width: 640, height: 480 });
  });

  it('re-applies converted geometry when the host zoom changes without new reported bounds', async () => {
    const page = await openPage();
    host.webContents.zoomFactor = 0.8;
    host.webContents.emit('zoom-changed', { preventDefault: vi.fn() });
    expect(page.bounds).toEqual({ x: 80, y: 64, width: 640, height: 480 });
    host.webContents.zoomFactor = 1;
    host.webContents.emit('zoom-changed', { preventDefault: vi.fn() });
    expect(page.bounds).toEqual({ x: 100, y: 80, width: 800, height: 600 });
  });

  it('keeps the parked page view within converted device bounds while hidden', async () => {
    const page = await openPage();
    host.webContents.zoomFactor = 0.8;
    setBrowserVisible('zoom-page', false);
    expect(page.bounds).toMatchObject({ x: 0, y: 0, width: 640, height: 480 });
  });

  it('scales device emulation output and input by the host zoom and re-sends metrics on zoom changes', async () => {
    const page = await openPage();
    await updateBrowserDeviceMode('zoom-page', { enabled: true, profileId: 'pixel-7', orientation: 'portrait', scaleMode: 'fit' });
    const metricsScale = () => {
      const calls = page.webContents.debugger.sendCommand.mock.calls as unknown as Array<[string, { scale?: number }]>;
      const call = [...calls].reverse().find(([name]) => name === 'Emulation.setDeviceMetricsOverride');
      return call?.[1].scale;
    };
    const displayScale = getBrowserState('zoom-page').device!.displayScale;
    expect(metricsScale()).toBeCloseTo(displayScale, 5);
    host.webContents.zoomFactor = 0.8;
    expect(getBrowserPage('zoom-page')?.inputScale).toBeCloseTo(displayScale * 0.8, 5);
    host.webContents.emit('zoom-changed', { preventDefault: vi.fn() });
    await vi.waitFor(() => {
      const calls = page.webContents.debugger.sendCommand.mock.calls as unknown as Array<[string, { scale?: number }]>;
      const sent = calls.filter(([name]) => name === 'Emulation.setDeviceMetricsOverride').length;
      expect(sent).toBeGreaterThanOrEqual(3);
    });
    expect(metricsScale()).toBeCloseTo(displayScale * 0.8, 5);
  });
});
