import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  class FakeWebContents {
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    executeJavaScript = vi.fn((_js: string) => Promise.resolve());
    on(event: string, cb: (...args: unknown[]) => void): void {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
  }
  class FakeBrowserWindow {
    static instances: FakeBrowserWindow[] = [];
    options: Record<string, unknown>;
    handlers = new Map<string, ((...args: unknown[]) => void)[]>();
    destroyed = false;
    webContents = new FakeWebContents();
    loadURL = vi.fn();
    show = vi.fn();
    focus = vi.fn();
    setTitle = vi.fn();
    constructor(options: Record<string, unknown>) {
      this.options = options;
      FakeBrowserWindow.instances.push(this);
    }
    on(event: string, cb: (...args: unknown[]) => void): this {
      this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
      return this;
    }
    once(event: string, cb: (...args: unknown[]) => void): this {
      return this.on(event, cb);
    }
    emit(event: string, ...args: unknown[]): void {
      for (const cb of this.handlers.get(event) ?? []) cb(...args);
    }
    isDestroyed(): boolean {
      return this.destroyed;
    }
    destroy(): void {
      this.destroyed = true;
    }
  }
  const partitionSession = { tag: 'preview-session' };
  return {
    FakeBrowserWindow,
    app: { isPackaged: true },
    nativeTheme: { shouldUseDarkColors: false },
    partitionSession,
    fromPartition: vi.fn(() => partitionSession),
    openExternal: vi.fn(),
    rendererUrl: vi.fn(
      (origin: string, token: string | undefined, base: string | undefined, onboarded: boolean, vibrancy: boolean) =>
        `${base ?? 'app://renderer/index.html'}?kimi_origin=${encodeURIComponent(origin)}${token ? `&kimi_token=${token}` : ''}&onboarded=${onboarded}&vibrancy=${vibrancy}`,
    ),
    registerPreviewRendererProtocol: vi.fn(),
    installExternalLinkGuard: vi.fn(),
    installEditableContextMenu: vi.fn(),
    isVibrancyEnabled: vi.fn(() => true),
    vibrancyWindowOptions: vi.fn(() => ({ vibrancy: 'sidebar' })),
    windowsWindowOptions: vi.fn(() => ({})),
    titleBarWindowOptions: vi.fn(() => ({ titleBarStyle: 'hidden' })),
    logInfo: vi.fn(),
  };
});

vi.mock('electron', () => ({
  BrowserWindow: mocks.FakeBrowserWindow,
  app: mocks.app,
  nativeTheme: mocks.nativeTheme,
  session: { fromPartition: mocks.fromPartition },
  shell: { openExternal: mocks.openExternal },
}));
vi.mock('../../src/main/protocol', () => ({
  rendererUrl: mocks.rendererUrl,
  registerPreviewRendererProtocol: mocks.registerPreviewRendererProtocol,
}));
vi.mock('../../src/main/external-links', () => ({ installExternalLinkGuard: mocks.installExternalLinkGuard }));
vi.mock('../../src/main/context-menu', () => ({ installEditableContextMenu: mocks.installEditableContextMenu }));
vi.mock('../../src/main/ui-state', () => ({ isVibrancyEnabled: mocks.isVibrancyEnabled }));
vi.mock('../../src/main/window', () => ({
  vibrancyWindowOptions: mocks.vibrancyWindowOptions,
  windowsWindowOptions: mocks.windowsWindowOptions,
  titleBarWindowOptions: mocks.titleBarWindowOptions,
}));
vi.mock('../../src/main/log', () => ({ log: { info: mocks.logInfo, warn: vi.fn(), error: vi.fn() } }));

import { closePreviewWindow, initPreviewSession, isPreviewWindowOpen, openPreviewWindow } from '../../src/main/preview-window';

const OPTS = { label: '#362', distRoot: '/previews/pr-362/dist', origin: 'http://127.0.0.1:58627' };

describe('preview-window', () => {
  beforeEach(() => {
    mocks.FakeBrowserWindow.instances = [];
    vi.clearAllMocks();
    mocks.fromPartition.mockReturnValue(mocks.partitionSession);
    mocks.isVibrancyEnabled.mockReturnValue(true);
  });

  afterEach(() => {
    closePreviewWindow();
  });

  it('initPreviewSession registers the scheme on the preview partition, once', () => {
    const getter = () => '/previews/x/dist';
    // The module guards idempotency internally; this test file gets one
    // registration total (module state persists across its tests).
    initPreviewSession(getter);
    expect(mocks.fromPartition).toHaveBeenCalledWith('kimi-pr-preview');
    expect(mocks.registerPreviewRendererProtocol).toHaveBeenCalledWith(mocks.partitionSession, getter);
    initPreviewSession(getter);
    expect(mocks.registerPreviewRendererProtocol).toHaveBeenCalledTimes(1);
  });

  it('opens a new preview window on the preview session with the app:// URL and host options', () => {
    const setDistRoot = vi.fn();
    openPreviewWindow(OPTS, setDistRoot);

    expect(setDistRoot).toHaveBeenCalledWith('/previews/pr-362/dist');
    expect(mocks.FakeBrowserWindow.instances).toHaveLength(1);
    const win = mocks.FakeBrowserWindow.instances[0]!;
    expect(win.options['title']).toBe('PR Preview #362');
    const prefs = win.options['webPreferences'] as Record<string, unknown>;
    expect(prefs['preload']).toMatch(/preload\.cjs$/);
    expect(prefs['sandbox']).toBe(true);
    expect(prefs['session']).toBe(mocks.partitionSession);
    expect(win.loadURL).toHaveBeenCalledTimes(1);
    const url = win.loadURL.mock.calls[0]![0] as string;
    expect(url).toContain('app://renderer/index.html');
    expect(url).not.toContain('__preview__');
    expect(url).toContain(`kimi_origin=${encodeURIComponent('http://127.0.0.1:58627')}`);
    expect(url).not.toContain('kimi_token=');
    expect(win.show).toHaveBeenCalled();
    expect(mocks.installExternalLinkGuard).toHaveBeenCalledWith(win.webContents, expect.any(Function));
    expect(mocks.installEditableContextMenu).toHaveBeenCalledWith(win.webContents);
    expect(isPreviewWindowOpen()).toBe(true);
  });

  it('passes the external-server token through to the preview URL', () => {
    openPreviewWindow({ ...OPTS, token: 'secret-token' }, vi.fn());
    const url = mocks.FakeBrowserWindow.instances[0]!.loadURL.mock.calls[0]![0] as string;
    expect(url).toContain('kimi_token=secret-token');
  });

  it('reuses the open window for a new preview (retitle, reload, focus)', () => {
    const setDistRoot = vi.fn();
    openPreviewWindow(OPTS, setDistRoot);
    openPreviewWindow({ ...OPTS, label: 'feat/branch', distRoot: '/previews/branch/dist' }, setDistRoot);

    expect(mocks.FakeBrowserWindow.instances).toHaveLength(1);
    const win = mocks.FakeBrowserWindow.instances[0]!;
    expect(win.setTitle).toHaveBeenCalledWith('PR Preview feat/branch');
    expect(win.loadURL).toHaveBeenCalledTimes(2);
    expect(win.focus).toHaveBeenCalled();
    expect(setDistRoot).toHaveBeenLastCalledWith('/previews/branch/dist');
  });

  it('closePreviewWindow destroys the window and is idempotent', () => {
    openPreviewWindow(OPTS, vi.fn());
    const win = mocks.FakeBrowserWindow.instances[0]!;
    closePreviewWindow();
    expect(win.destroyed).toBe(true);
    expect(isPreviewWindowOpen()).toBe(false);
    expect(() => closePreviewWindow()).not.toThrow();
  });

  it('a user close clears the dist root and frees the singleton', () => {
    const setDistRoot = vi.fn();
    openPreviewWindow(OPTS, setDistRoot);
    const win = mocks.FakeBrowserWindow.instances[0]!;
    win.emit('closed');
    expect(setDistRoot).toHaveBeenLastCalledWith(null);
    expect(isPreviewWindowOpen()).toBe(false);

    // The next preview opens a fresh window.
    openPreviewWindow(OPTS, setDistRoot);
    expect(mocks.FakeBrowserWindow.instances).toHaveLength(2);
  });

  it('vetoes page-title-updated so the PR Preview title sticks', () => {
    openPreviewWindow(OPTS, vi.fn());
    const win = mocks.FakeBrowserWindow.instances[0]!;
    const event = { preventDefault: vi.fn() };
    win.emit('page-title-updated', event, 'Kimi Code');
    expect(event.preventDefault).toHaveBeenCalled();
    expect(win.setTitle).toHaveBeenCalledWith('PR Preview #362');
  });
});
