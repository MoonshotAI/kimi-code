import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { MainWindow } from '../../../src/main/window/main-window';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';

import type { DesktopServerHandle } from '../../../src/main/server/embedded-server';

const mocks = vi.hoisted(() => ({
  startDesktopServer: vi.fn(),
  startShellEnvProbe: vi.fn((): Promise<void> => Promise.resolve()),
  rendererUrl: vi.fn(() => 'renderer-url'),
  rendererDevBase: vi.fn((): string | undefined => undefined),
  dataUrl: vi.fn((_html: string): string => 'error-url'),
  errorHtml: vi.fn(() => '<error>'),
  waitingHtml: vi.fn(() => '<waiting>'),
  updateTimeoutHtml: vi.fn(() => '<timeout>'),
  stat: vi.fn(),
  isOnboarded: vi.fn(() => false),
  isVibrancyEnabled: vi.fn(() => true),
  isLinuxNativeTitleBar: vi.fn(() => false),
  readFileSync: vi.fn((): string => {
    throw new Error('ENOENT');
  }),
  trackDesktopEvent: vi.fn(),
  isPackaged: vi.fn(() => true),
  desktopServerSecret: vi.fn(() => 'launch-secret'),
  setEmbeddedServerOrigin: vi.fn(),
  setServerRegionSource: vi.fn(),
  restoreRemoteControlOnStartup: vi.fn((): Promise<void> => Promise.resolve()),
}));

vi.mock('electron', () => ({
  app: {
    get isPackaged() {
      return mocks.isPackaged();
    },
    getAppPath: () => '/app',
    getVersion: () => '1.2.3',
  },
  dialog: { showErrorBox: vi.fn() },
  net: { fetch: vi.fn(() => new Promise(() => {})) },
}));
vi.mock('@moonshot-ai/kap-server', () => ({
  serverTokenPath: () => '/tmp/kimi-test/server.token',
  loadOrCreateServerToken: async () => 'test-token',
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  readFileSync: mocks.readFileSync,
}));
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  stat: mocks.stat,
}));
vi.mock('@moonshot-ai/kimi-code-sdk', () => ({
  resolveKimiHome: () => '/tmp/kimi-test',
}));
vi.mock('../../../src/main/server/embedded-server', () => ({
  startDesktopServer: mocks.startDesktopServer,
}));
vi.mock('../../../src/main/server/server-auth', () => ({
  desktopServerSecret: mocks.desktopServerSecret,
  setEmbeddedServerOrigin: mocks.setEmbeddedServerOrigin,
}));
vi.mock('../../../src/main/server/region', () => ({
  setServerRegionSource: mocks.setServerRegionSource,
}));
vi.mock('../../../src/main/server/remote-control-restore', () => ({
  restoreRemoteControlOnStartup: mocks.restoreRemoteControlOnStartup,
}));
vi.mock('../../../src/main/system/shell-env', () => ({
  startShellEnvProbe: mocks.startShellEnvProbe,
}));
vi.mock('../../../src/main/app/protocol', () => ({
  rendererUrl: mocks.rendererUrl,
  rendererDevBase: mocks.rendererDevBase,
}));
vi.mock('../../../src/main/app/ui-state', () => ({
  isOnboarded: mocks.isOnboarded,
  isVibrancyEnabled: mocks.isVibrancyEnabled,
  isLinuxNativeTitleBar: mocks.isLinuxNativeTitleBar,
}));
vi.mock('../../../src/main/app/screens', () => ({
  dataUrl: mocks.dataUrl,
  errorHtml: mocks.errorHtml,
  waitingHtml: mocks.waitingHtml,
  updateTimeoutHtml: mocks.updateTimeoutHtml,
}));
vi.mock('../../../src/main/diagnostics/track', () => ({
  trackDesktopEvent: mocks.trackDesktopEvent,
  trySendDesktopEvent: vi.fn(),
}));

Object.defineProperty(process, 'resourcesPath', { value: '/resources' });

function fakeWindow(): {
  isDestroyed: () => boolean;
  loadURL: ReturnType<typeof vi.fn>;
  webContents: EventEmitter & {
    getURL: ReturnType<typeof vi.fn>;
  };
} {
  const webContents = Object.assign(new EventEmitter(), {
    getURL: vi.fn(() => 'renderer-url'),
  });
  return {
    isDestroyed: () => false,
    loadURL: vi.fn().mockResolvedValue(undefined),
    webContents,
  };
}

function fakeHandle(origin = 'http://127.0.0.1:54321'): DesktopServerHandle {
  return {
    origin,
    port: Number(origin.split(':').at(-1)),
    shutdownTelemetry: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function importConnect(): Promise<typeof import('../../../src/main/server/connect')> {
  return import('../../../src/main/server/connect');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.isPackaged.mockReturnValue(true);
  mocks.stat.mockReset();
  mocks.stat.mockResolvedValue({ isFile: () => true });
  mocks.dataUrl.mockReset();
  mocks.dataUrl.mockReturnValue('error-url');
  delete process.env['KIMI_SERVER_URL'];
  delete process.env['KIMI_RENDERER_DEV_URL'];
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

describe('connect', () => {
  it('starts the embedded server on first connect and loads the renderer URL', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    const win = fakeWindow();

    await connect(win as unknown as MainWindow);

    expect(mocks.startDesktopServer).toHaveBeenCalledTimes(1);
    expect(mocks.startDesktopServer).toHaveBeenCalledWith({
      webAssetsDir: join('/resources', 'desktop-dist'),
      extraCorsOrigins: [],
      debugEndpoints: false,
    });
    expect(mocks.rendererUrl).toHaveBeenCalledWith('http://127.0.0.1:54321', undefined, undefined, false, true, true, false);
    expect(mocks.setEmbeddedServerOrigin).toHaveBeenCalledWith('http://127.0.0.1:54321');
    expect(mocks.setServerRegionSource).toHaveBeenCalledWith('http://127.0.0.1:54321', 'launch-secret');
    expect(mocks.restoreRemoteControlOnStartup).toHaveBeenCalledWith(
      'http://127.0.0.1:54321',
      'launch-secret',
      fetch,
      expect.any(Function),
    );
    expect(win.loadURL).toHaveBeenCalledWith('renderer-url');
    expect(mocks.errorHtml).not.toHaveBeenCalled();
  });

  it('loads the renderer while Remote Control restoration is still pending', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    let finishRestore!: () => void;
    mocks.restoreRemoteControlOnStartup.mockImplementationOnce(
      () => new Promise<void>((resolve) => {
        finishRestore = resolve;
      }),
    );
    const win = fakeWindow();

    const connecting = connect(win as unknown as MainWindow);
    await vi.waitFor(() => expect(win.loadURL).toHaveBeenCalledWith('renderer-url'));
    finishRestore();
    await connecting;
  });

  it('ignores an aborted startup page after the renderer finishes loading', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    const win = fakeWindow();
    win.loadURL.mockImplementationOnce(async () => {
      win.webContents.emit('did-finish-load');
      throw new Error(" (-3) loading 'data:text/html;charset=utf-8,startup'");
    });

    await connect(win as unknown as MainWindow);

    expect(mocks.errorHtml).not.toHaveBeenCalled();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('embedded_renderer_load_result', {
      ok: true,
      duration_ms: expect.any(Number),
    });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_connect_result', { ok: true });
    expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
  });

  it('ignores an aborted startup page after the renderer consumes the token fragment', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    mocks.rendererUrl.mockReturnValueOnce('renderer-url#token=secret');
    const win = fakeWindow();
    win.webContents.getURL.mockReturnValue('renderer-url');
    win.loadURL.mockImplementationOnce(async () => {
      win.webContents.emit('did-finish-load');
      throw new Error(" (-3) loading 'data:text/html;charset=utf-8,startup'");
    });

    await connect(win as unknown as MainWindow);

    expect(mocks.errorHtml).not.toHaveBeenCalled();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_connect_result', { ok: true });
  });

  it('keeps handling an aborted startup page as a failure before the renderer finishes loading', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    const win = fakeWindow();
    win.loadURL.mockRejectedValueOnce(new Error(" (-3) loading 'data:text/html;charset=utf-8,startup'"));

    await connect(win as unknown as MainWindow);

    expect(mocks.errorHtml).toHaveBeenCalledOnce();
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_connect_result', {
      ok: false,
      failure_phase: 'handshake',
      retry_count: 1,
      error_class: 'Error',
    });
    expect(win.webContents.listenerCount('did-finish-load')).toBe(0);
  });

  it('serves built web assets through the embedded server in dev mode', async () => {
    mocks.isPackaged.mockReturnValue(false);
    mocks.rendererDevBase.mockReturnValue('http://127.0.0.1:5174/');
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    const win = fakeWindow();

    await connect(win as unknown as MainWindow);

    expect(mocks.startDesktopServer).toHaveBeenCalledWith({
      webAssetsDir: join('/app', 'desktop-dist'),
      extraCorsOrigins: ['http://127.0.0.1:5174'],
      debugEndpoints: true,
    });
  });

  it('starts dev mode API-only when the renderer dist is missing', async () => {
    mocks.isPackaged.mockReturnValue(false);
    mocks.rendererDevBase.mockReturnValue('http://127.0.0.1:5174/');
    mocks.stat.mockRejectedValue(new Error('ENOENT'));
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    const win = fakeWindow();

    await connect(win as unknown as MainWindow);

    expect(mocks.startDesktopServer).toHaveBeenCalledWith({
      webAssetsDir: undefined,
      extraCorsOrigins: ['http://127.0.0.1:5174'],
      debugEndpoints: true,
    });
  });

  it('keeps the server token out of the embedded renderer URL', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    const win = fakeWindow();

    await connect(win as unknown as MainWindow);

    expect(mocks.readFileSync).not.toHaveBeenCalled();
    expect(mocks.rendererUrl).toHaveBeenCalledWith('http://127.0.0.1:54321', undefined, undefined, false, true, true, false);
    expect(win.loadURL).toHaveBeenCalledWith('renderer-url');
  });

  it('awaits the shell env probe before starting the embedded server', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());

    await connect(fakeWindow() as unknown as MainWindow);

    expect(mocks.startShellEnvProbe).toHaveBeenCalledTimes(1);
    expect(mocks.startShellEnvProbe.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.startDesktopServer.mock.invocationCallOrder[0]!,
    );
  });

  it('reuses the live embedded server on reconnect — never closes it', async () => {
    const { connect } = await importConnect();
    const handle = fakeHandle();
    mocks.startDesktopServer.mockResolvedValue(handle);
    const win1 = fakeWindow();
    const win2 = fakeWindow();

    await connect(win1 as unknown as MainWindow);
    await connect(win2 as unknown as MainWindow);

    expect(mocks.startDesktopServer).toHaveBeenCalledTimes(1);
    expect(handle.close).not.toHaveBeenCalled();
    expect(mocks.rendererUrl).toHaveBeenCalledTimes(2);
    expect(mocks.rendererUrl).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:54321', undefined, undefined, false, true, true, false);
    expect(win2.loadURL).toHaveBeenCalledWith('renderer-url');
    expect(mocks.errorHtml).not.toHaveBeenCalled();
  });

  it('serializes concurrent connects so only one embedded server ever starts', async () => {
    const { connect } = await importConnect();
    const handle = fakeHandle();
    let resolveStart!: (h: DesktopServerHandle) => void;
    mocks.startDesktopServer.mockImplementation(
      () =>
        new Promise<DesktopServerHandle>((res) => {
          resolveStart = res;
        }),
    );
    const win1 = fakeWindow();
    const win2 = fakeWindow();

    const p1 = connect(win1 as unknown as MainWindow);
    const p2 = connect(win2 as unknown as MainWindow);
    await new Promise((r) => {
      setImmediate(r);
    });
    expect(mocks.startDesktopServer).toHaveBeenCalledTimes(1);
    resolveStart(handle);
    await Promise.all([p1, p2]);

    expect(mocks.startDesktopServer).toHaveBeenCalledTimes(1);
    expect(handle.close).not.toHaveBeenCalled();
    expect(win1.loadURL).toHaveBeenCalledWith('renderer-url');
    expect(win2.loadURL).toHaveBeenCalledWith('renderer-url');
    expect(mocks.errorHtml).not.toHaveBeenCalled();
  });

  it('waits for an in-flight embedded start and closes its handle before quitting', async () => {
    const { closeServerHandle, connect } = await importConnect();
    const handle = fakeHandle();
    let resolveStart!: (h: DesktopServerHandle) => void;
    mocks.startDesktopServer.mockImplementation(
      () =>
        new Promise<DesktopServerHandle>((resolve) => {
          resolveStart = resolve;
        }),
    );
    const win = fakeWindow();

    const connectPromise = connect(win as unknown as MainWindow);
    await vi.waitFor(() => expect(mocks.startDesktopServer).toHaveBeenCalledOnce());
    const closePromise = closeServerHandle();
    expect(handle.close).not.toHaveBeenCalled();

    resolveStart(handle);
    await Promise.all([connectPromise, closePromise]);

    expect(handle.close).toHaveBeenCalledOnce();
    expect(win.loadURL).not.toHaveBeenCalled();
  });

  it('does not start an embedded server when quit begins during the shell probe', async () => {
    const { closeServerHandle, connect } = await importConnect();
    let resolveProbe!: () => void;
    mocks.startShellEnvProbe.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          resolveProbe = resolve;
        }),
    );

    const connectPromise = connect(fakeWindow() as unknown as MainWindow);
    await vi.waitFor(() => expect(mocks.startShellEnvProbe).toHaveBeenCalledOnce());
    const closePromise = closeServerHandle();
    resolveProbe();
    await Promise.all([connectPromise, closePromise]);

    expect(mocks.startDesktopServer).not.toHaveBeenCalled();
  });

  it('shows the error page when the start fails, and the next retry starts fresh', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer
      .mockRejectedValueOnce(new Error('server already running (pid=1, port=2, started=x)'))
      .mockResolvedValueOnce(fakeHandle('http://127.0.0.1:5555'));
    const win1 = fakeWindow();
    const win2 = fakeWindow();

    await connect(win1 as unknown as MainWindow);
    const { diagnosticRoots } = await import('../../../src/main/diagnostics/log');
    expect(mocks.errorHtml).toHaveBeenCalledWith(
      'server already running (pid=1, port=2, started=x)',
      diagnosticRoots(),
    );
    expect(mocks.dataUrl).toHaveBeenCalledWith('<error>');
    expect(win1.loadURL).toHaveBeenCalledWith('error-url');
    expect(mocks.rendererUrl).not.toHaveBeenCalled();

    await connect(win2 as unknown as MainWindow);
    expect(mocks.startDesktopServer).toHaveBeenCalledTimes(2);
    expect(mocks.rendererUrl).toHaveBeenCalledWith('http://127.0.0.1:5555', undefined, undefined, false, true, true, false);
    expect(win2.loadURL).toHaveBeenCalledWith('renderer-url');
  });

  it('connects to an external server (KIMI_SERVER_URL) without starting the embedded one', async () => {
    const { connect } = await importConnect();
    process.env['KIMI_SERVER_URL'] = 'http://127.0.0.1:58627';
    const win = fakeWindow();

    await connect(win as unknown as MainWindow);

    expect(mocks.startDesktopServer).not.toHaveBeenCalled();
    expect(mocks.rendererUrl).toHaveBeenCalledWith('http://127.0.0.1:58627', undefined, undefined, false, true, false, false);
    expect(mocks.setEmbeddedServerOrigin).not.toHaveBeenCalled();
    expect(win.loadURL).toHaveBeenCalledWith('renderer-url');
    expect(mocks.errorHtml).not.toHaveBeenCalled();
  });

  it('awaits the probe before reading the external server token', async () => {
    const { connect } = await importConnect();
    process.env['KIMI_SERVER_URL'] = 'http://127.0.0.1:58627';
    mocks.readFileSync.mockReturnValue('tok\n');

    await connect(fakeWindow() as unknown as MainWindow);

    expect(mocks.readFileSync).toHaveBeenCalledWith('/tmp/kimi-test/server.token', 'utf-8');
    expect(mocks.startShellEnvProbe.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.readFileSync.mock.invocationCallOrder[0]!,
    );
    expect(mocks.rendererUrl).toHaveBeenCalledWith('http://127.0.0.1:58627', 'tok', undefined, false, true, false, false);
    expect(mocks.setServerRegionSource).toHaveBeenCalledWith('http://127.0.0.1:58627', 'tok');
  });

  it('tracks embedded_renderer_load_result after the embedded server starts', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    const win1 = fakeWindow();
    const win2 = fakeWindow();
    win1.loadURL.mockRejectedValueOnce(new TypeError('renderer failed'));

    await connect(win1 as unknown as MainWindow);
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith(
      'embedded_renderer_load_result',
      expect.objectContaining({ ok: false, error_class: 'TypeError' }),
    );

    await connect(win2 as unknown as MainWindow);
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith(
      'embedded_renderer_load_result',
      expect.objectContaining({ ok: true }),
    );
  });

  it('does not track a renderer result when the embedded server fails to start', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockRejectedValue(new Error('boom'));

    await connect(fakeWindow() as unknown as MainWindow);

    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith(
      'embedded_renderer_load_result',
      expect.anything(),
    );
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_connect_result', {
      ok: false,
      failure_phase: 'spawn',
      retry_count: 1,
      error_class: 'Error',
    });
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_failure_screen_shown', {});
  });

  it('does not track a renderer result in external-server mode', async () => {
    const { connect } = await importConnect();
    process.env['KIMI_SERVER_URL'] = 'http://127.0.0.1:58627';
    const win = fakeWindow();

    await connect(win as unknown as MainWindow);

    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith(
      'embedded_renderer_load_result',
      expect.anything(),
    );
    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_connect_result', { ok: true });
  });
});

describe('web assets wait', () => {
  it('skips the waiting screen when web assets are already present', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());

    await connect(fakeWindow() as unknown as MainWindow);

    expect(mocks.waitingHtml).not.toHaveBeenCalled();
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith('startup_web_assets_wait', expect.anything());
  });

  it('shows the waiting screen and starts once web assets appear', async () => {
    vi.useFakeTimers();
    try {
      mocks.stat
        .mockReset()
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockRejectedValueOnce(new Error('ENOENT'))
        .mockResolvedValue({ isFile: () => true });
      mocks.dataUrl.mockImplementation((html: string) => `url:${html}`);
      const { connect } = await importConnect();
      mocks.startDesktopServer.mockResolvedValue(fakeHandle());
      const win = fakeWindow();

      const run = connect(win as unknown as MainWindow);
      await vi.runAllTimersAsync();
      await run;

      expect(mocks.waitingHtml).toHaveBeenCalledOnce();
      expect(win.loadURL).toHaveBeenCalledWith('url:<waiting>');
      expect(mocks.startDesktopServer).toHaveBeenCalledOnce();
      expect(win.loadURL).toHaveBeenCalledWith('renderer-url');
      expect(mocks.errorHtml).not.toHaveBeenCalled();
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_web_assets_wait', {
        outcome: 'appeared',
        waited_ms: expect.any(Number),
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows the timeout screen instead of starting the server when web assets never appear', async () => {
    vi.useFakeTimers();
    try {
      mocks.stat.mockReset().mockRejectedValue(new Error('ENOENT'));
      mocks.dataUrl.mockImplementation((html: string) => `url:${html}`);
      const { connect } = await importConnect();
      const win = fakeWindow();

      const run = connect(win as unknown as MainWindow);
      await vi.runAllTimersAsync();
      await run;

      const { diagnosticRoots } = await import('../../../src/main/diagnostics/log');
      expect(mocks.startDesktopServer).not.toHaveBeenCalled();
      expect(mocks.updateTimeoutHtml).toHaveBeenCalledWith(diagnosticRoots());
      expect(win.loadURL).toHaveBeenCalledWith('url:<timeout>');
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_web_assets_wait', {
        outcome: 'timeout',
        waited_ms: expect.any(Number),
      });
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_connect_result', {
        ok: false,
        failure_phase: 'timeout',
        retry_count: 1,
        error_class: 'WebAssetsWaitTimeout',
      });
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_failure_screen_shown', {});
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops waiting without starting the server when quit begins mid-wait', async () => {
    vi.useFakeTimers();
    try {
      mocks.stat.mockReset().mockRejectedValue(new Error('ENOENT'));
      const { connect, closeServerHandle } = await importConnect();
      const win = fakeWindow();

      const run = connect(win as unknown as MainWindow);
      await vi.advanceTimersByTimeAsync(4_000);
      const closing = closeServerHandle();
      await vi.runAllTimersAsync();
      await Promise.all([run, closing]);

      expect(mocks.startDesktopServer).not.toHaveBeenCalled();
      expect(mocks.updateTimeoutHtml).not.toHaveBeenCalled();
      expect(mocks.errorHtml).not.toHaveBeenCalled();
      expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_web_assets_wait', {
        outcome: 'aborted',
        waited_ms: expect.any(Number),
      });
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('shutdownServerTelemetry', () => {
  it('returns null when no server exists or is starting', async () => {
    const { shutdownServerTelemetry } = await importConnect();
    expect(shutdownServerTelemetry()).toBeNull();
  });

  it('flushes the live handle immediately', async () => {
    const { connect, shutdownServerTelemetry } = await importConnect();
    const handle = fakeHandle();
    mocks.startDesktopServer.mockResolvedValue(handle);
    await connect(fakeWindow() as unknown as MainWindow);

    await shutdownServerTelemetry();

    expect(handle.shutdownTelemetry).toHaveBeenCalledOnce();
  });

  it('waits (bounded) for an in-flight start, then flushes', async () => {
    const { connect, shutdownServerTelemetry } = await importConnect();
    const handle = fakeHandle();
    let resolveServer!: (h: DesktopServerHandle) => void;
    mocks.startDesktopServer.mockImplementationOnce(
      () =>
        new Promise<DesktopServerHandle>((resolve) => {
          resolveServer = resolve;
        }),
    );
    const connectPromise = connect(fakeWindow() as unknown as MainWindow);
    await vi.waitFor(() => expect(mocks.startDesktopServer).toHaveBeenCalledOnce());

    let settled = false;
    const flush = shutdownServerTelemetry();
    expect(flush).not.toBeNull();
    const flushPromise = flush!.then(() => {
      settled = true;
    });
    await new Promise((resolve) => {
      setTimeout(resolve, 10);
    });
    expect(settled).toBe(false);

    resolveServer(handle);
    await Promise.all([connectPromise, flushPromise]);
    expect(handle.shutdownTelemetry).toHaveBeenCalledOnce();
  });
});

describe('startup_connect_result', () => {
  it('counts consecutive failures as retry_count and resets on success', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer
      .mockRejectedValueOnce(new Error('boom'))
      .mockRejectedValueOnce(new Error('boom again'))
      .mockResolvedValue(fakeHandle());

    await connect(fakeWindow() as unknown as MainWindow);
    await connect(fakeWindow() as unknown as MainWindow);
    await connect(fakeWindow() as unknown as MainWindow);
    const win4 = fakeWindow();
    win4.loadURL.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'));
    await connect(win4 as unknown as MainWindow);
    await connect(fakeWindow() as unknown as MainWindow);

    const results = mocks.trackDesktopEvent.mock.calls
      .filter((call) => call[0] === 'startup_connect_result')
      .map((call) => call[1]);
    expect(results).toEqual([
      { ok: false, failure_phase: 'spawn', retry_count: 1, error_class: 'Error' },
      { ok: false, failure_phase: 'spawn', retry_count: 2, error_class: 'Error' },
      { ok: true },
      { ok: false, failure_phase: 'handshake', retry_count: 1, error_class: 'Error' },
      { ok: true },
    ]);
  });

  it('classifies a renderer loadURL rejection as a handshake failure', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());
    const win = fakeWindow();
    win.loadURL.mockRejectedValueOnce(new Error('ERR_CONNECTION_REFUSED'));

    await connect(win as unknown as MainWindow);

    expect(mocks.trackDesktopEvent).toHaveBeenCalledWith('startup_connect_result', {
      ok: false,
      failure_phase: 'handshake',
      retry_count: 1,
      error_class: 'Error',
    });
  });

  it('shows and tracks the failure screen only on failure', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());

    await connect(fakeWindow() as unknown as MainWindow);
    expect(mocks.trackDesktopEvent).not.toHaveBeenCalledWith(
      'startup_failure_screen_shown',
      expect.anything(),
    );
  });
});
