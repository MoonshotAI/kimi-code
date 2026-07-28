import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow } from 'electron';
import { join } from 'node:path';

import type { DesktopServerHandle } from '../../src/main/server';

const mocks = vi.hoisted(() => ({
  startDesktopServer: vi.fn(),
  startShellEnvProbe: vi.fn((): Promise<void> => Promise.resolve()),
  rendererUrl: vi.fn(() => 'renderer-url'),
  rendererDevBase: vi.fn((): string | undefined => undefined),
  dataUrl: vi.fn(() => 'error-url'),
  errorHtml: vi.fn(() => '<error>'),
  isOnboarded: vi.fn(() => false),
  isVibrancyEnabled: vi.fn(() => true),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => '/app',
    getVersion: () => '1.2.3',
  },
  // connect.ts → log.ts imports `dialog` for the crash guard; vitest throws
  // on access to a mocked module's missing export, so keep it defined.
  dialog: { showErrorBox: vi.fn() },
}));
vi.mock('@moonshot-ai/kap-server', () => ({
  serverTokenPath: () => '/tmp/kimi-test/server.token',
}));
vi.mock('@moonshot-ai/kimi-code-sdk', () => ({
  resolveKimiHome: () => '/tmp/kimi-test',
}));
vi.mock('../../src/main/server', () => ({
  startDesktopServer: mocks.startDesktopServer,
}));
vi.mock('../../src/main/shell-env', () => ({
  startShellEnvProbe: mocks.startShellEnvProbe,
}));
vi.mock('../../src/main/protocol', () => ({
  rendererUrl: mocks.rendererUrl,
  rendererDevBase: mocks.rendererDevBase,
}));
vi.mock('../../src/main/ui-state', () => ({
  isOnboarded: mocks.isOnboarded,
  isVibrancyEnabled: mocks.isVibrancyEnabled,
}));
vi.mock('../../src/main/screens', () => ({
  dataUrl: mocks.dataUrl,
  errorHtml: mocks.errorHtml,
}));

// connect.ts computes `rendererDistRoot()` via `process.resourcesPath` in
// packaged mode; give it a stable value under vitest (typed readonly, so go
// through defineProperty).
Object.defineProperty(process, 'resourcesPath', { value: '/resources' });

function fakeWindow(): { isDestroyed: () => boolean; loadURL: ReturnType<typeof vi.fn> } {
  return { isDestroyed: () => false, loadURL: vi.fn().mockResolvedValue(undefined) };
}

function fakeHandle(origin = 'http://127.0.0.1:54321'): DesktopServerHandle {
  return {
    origin,
    port: Number(origin.split(':').at(-1)),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

async function importConnect(): Promise<typeof import('../../src/main/connect')> {
  return import('../../src/main/connect');
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
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

    await connect(win as unknown as BrowserWindow);

    expect(mocks.startDesktopServer).toHaveBeenCalledTimes(1);
    expect(mocks.startDesktopServer).toHaveBeenCalledWith({
      webAssetsDir: join('/resources', 'desktop-dist'),
      identity: { userAgentProduct: 'kimi-code-desktop', version: '1.2.3' },
      extraCorsOrigins: [],
    });
    expect(mocks.rendererUrl).toHaveBeenCalledWith('http://127.0.0.1:54321', undefined, undefined, false, true);
    expect(win.loadURL).toHaveBeenCalledWith('renderer-url');
    expect(mocks.errorHtml).not.toHaveBeenCalled();
  });

  it('awaits the shell env probe before starting the embedded server', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer.mockResolvedValue(fakeHandle());

    await connect(fakeWindow() as unknown as BrowserWindow);

    expect(mocks.startShellEnvProbe).toHaveBeenCalledTimes(1);
    expect(mocks.startShellEnvProbe.mock.invocationCallOrder[0]!).toBeLessThan(
      mocks.startDesktopServer.mock.invocationCallOrder[0]!,
    );
  });

  it('reuses the live embedded server on reconnect — never closes it', async () => {
    // Regression: window (re)creation / menu retry used to fire-and-forget the
    // old close() and immediately restart the server; the restart raced the old
    // close(), so the app showed a spurious failure and tore down the healthy
    // server.
    const { connect } = await importConnect();
    const handle = fakeHandle();
    mocks.startDesktopServer.mockResolvedValue(handle);
    const win1 = fakeWindow();
    const win2 = fakeWindow();

    await connect(win1 as unknown as BrowserWindow);
    await connect(win2 as unknown as BrowserWindow);

    expect(mocks.startDesktopServer).toHaveBeenCalledTimes(1);
    expect(handle.close).not.toHaveBeenCalled();
    expect(mocks.rendererUrl).toHaveBeenCalledTimes(2);
    expect(mocks.rendererUrl).toHaveBeenNthCalledWith(2, 'http://127.0.0.1:54321', undefined, undefined, false, true);
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

    const p1 = connect(win1 as unknown as BrowserWindow);
    const p2 = connect(win2 as unknown as BrowserWindow);
    // Let the first connectOnce reach the (pending) startDesktopServer call.
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

  it('shows the error page when the start fails, and the next retry starts fresh', async () => {
    const { connect } = await importConnect();
    mocks.startDesktopServer
      .mockRejectedValueOnce(new Error('server already running (pid=1, port=2, started=x)'))
      .mockResolvedValueOnce(fakeHandle('http://127.0.0.1:5555'));
    const win1 = fakeWindow();
    const win2 = fakeWindow();

    await connect(win1 as unknown as BrowserWindow);
    expect(mocks.errorHtml).toHaveBeenCalledWith(
      'server already running (pid=1, port=2, started=x)',
      join('/tmp/kimi-test', 'server', 'server.log'),
    );
    expect(mocks.dataUrl).toHaveBeenCalledWith('<error>');
    expect(win1.loadURL).toHaveBeenCalledWith('error-url');
    expect(mocks.rendererUrl).not.toHaveBeenCalled();

    // The failed attempt left no handle behind: the retry starts a new server
    // instead of tripping over a half-closed one.
    await connect(win2 as unknown as BrowserWindow);
    expect(mocks.startDesktopServer).toHaveBeenCalledTimes(2);
    expect(mocks.rendererUrl).toHaveBeenCalledWith('http://127.0.0.1:5555', undefined, undefined, false, true);
    expect(win2.loadURL).toHaveBeenCalledWith('renderer-url');
  });

  it('connects to an external server (KIMI_SERVER_URL) without starting the embedded one', async () => {
    const { connect } = await importConnect();
    process.env['KIMI_SERVER_URL'] = 'http://127.0.0.1:58627';
    const win = fakeWindow();

    await connect(win as unknown as BrowserWindow);

    expect(mocks.startDesktopServer).not.toHaveBeenCalled();
    expect(mocks.rendererUrl).toHaveBeenCalledWith('http://127.0.0.1:58627', undefined, undefined, false, true);
    expect(win.loadURL).toHaveBeenCalledWith('renderer-url');
    expect(mocks.errorHtml).not.toHaveBeenCalled();
  });
});
