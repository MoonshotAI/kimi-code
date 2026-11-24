import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';

const {
  startServerMock,
  installProxyMock,
  createKimiDeviceIdMock,
  wireDesktopTelemetryMock,
  createDesktopBrowserHostMock,
  configureSearchWorkerRuntimeMock,
  hostDisposeMock,
  registerDialogCleanupMock,
  registrationDisposeMock,
  startBrowserTestEndpointMock,
  testEndpointCloseMock,
  browserHost,
  forgetSessionBrowserDialogsMock,
  collectBrowserDialogReminderMock,
} = vi.hoisted(() => ({
  startServerMock: vi.fn(),
  installProxyMock: vi.fn(),
  createKimiDeviceIdMock: vi.fn(() => 'device-1'),
  wireDesktopTelemetryMock: vi.fn(),
  createDesktopBrowserHostMock: vi.fn(),
  configureSearchWorkerRuntimeMock: vi.fn(),
  hostDisposeMock: vi.fn(),
  registerDialogCleanupMock: vi.fn(),
  registrationDisposeMock: vi.fn(),
  startBrowserTestEndpointMock: vi.fn(),
  testEndpointCloseMock: vi.fn().mockResolvedValue(undefined),
  browserHost: { dispose: vi.fn() },
  forgetSessionBrowserDialogsMock: vi.fn(),
  collectBrowserDialogReminderMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.2.3') },
}));
vi.mock('@moonshot-ai/kap-server/search-worker-runtime', () => ({
  configureSearchWorkerRuntime: configureSearchWorkerRuntimeMock,
}));
vi.mock('@moonshot-ai/kap-server', () => ({
  startServer: startServerMock,
  createServerLogger: vi.fn(),
  serverTokenPath: () => '/tmp/kimi-test/server.token',
  loadOrCreateServerToken: async () => 'test-token',
}));
vi.mock('@moonshot-ai/kimi-code-oauth', () => ({
  createKimiDeviceId: createKimiDeviceIdMock,
}));
vi.mock('@moonshot-ai/kimi-code-sdk', () => ({
  installGlobalProxyDispatcher: installProxyMock,
  resolveKimiHome: () => '/tmp/kimi-test',
}));
vi.mock('../../../src/main/browser/browser-host', () => ({
  createDesktopBrowserHost: createDesktopBrowserHostMock,
}));
vi.mock('../../../src/main/browser/browser-test-endpoint', () => ({
  startBrowserTestEndpoint: startBrowserTestEndpointMock,
}));
vi.mock('../../../src/main/browser/browser-dialog-reminder', () => ({
  registerBrowserDialogCleanup: registerDialogCleanupMock,
}));
vi.mock('../../../src/main/browser/browser-automation', () => ({
  collectBrowserDialogReminder: collectBrowserDialogReminderMock,
  forgetSessionBrowserDialogs: forgetSessionBrowserDialogsMock,
}));
vi.mock('../../../src/main/diagnostics/telemetry', () => ({
  wireDesktopTelemetry: wireDesktopTelemetryMock,
}));
vi.mock('../../../src/main/browser/browser-agent-control', () => ({
  browserAgentControl: { enabled: () => true, onDidChange: () => () => undefined },
  browserSubagentControl: { enabled: () => false, onDidChange: () => () => undefined },
}));

import { startDesktopServer } from '../../../src/main/server/embedded-server';
import { HostBrowserFeature } from '../../../src/main/browser/browser-feature';
import { IHostBrowser } from '../../../src/main/browser/browser-host-contract';
import { browserAgentControl, browserSubagentControl } from '../../../src/main/browser/browser-agent-control';
import { desktopServerSecret } from '../../../src/main/server/server-auth';

describe('startDesktopServer', () => {
  function core() {
    return { accessor: 'CORE' };
  }

  beforeEach(() => {
    registerDialogCleanupMock.mockReset().mockReturnValue({ dispose: registrationDisposeMock });
    registrationDisposeMock.mockReset();
    hostDisposeMock.mockReset();
    browserHost.dispose = hostDisposeMock;
    createDesktopBrowserHostMock.mockReset().mockReturnValue(browserHost);
    testEndpointCloseMock.mockReset().mockResolvedValue(undefined);
    startBrowserTestEndpointMock.mockReset().mockResolvedValue({ url: 'http://127.0.0.1:60001/run', close: testEndpointCloseMock });
    vi.unstubAllEnvs();
    startServerMock.mockReset();
    installProxyMock.mockReset();
    createKimiDeviceIdMock.mockReset().mockReturnValue('device-1');
    wireDesktopTelemetryMock.mockReset().mockResolvedValue(null);
  });

  it.each(['registration', 'telemetry'])('closes the server and the browser host when %s initialization fails', async (step) => {
    const close = vi.fn().mockRejectedValue(new Error('close failure'));
    startServerMock.mockResolvedValue({ host: '127.0.0.1', port: 1234, core: core(), close });
    const failure = new Error('initialization failed');
    if (step === 'registration') registerDialogCleanupMock.mockImplementationOnce(() => { throw failure; });
    else wireDesktopTelemetryMock.mockRejectedValueOnce(failure);
    await expect(startDesktopServer({})).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(hostDisposeMock).toHaveBeenCalledOnce();
    if (step === 'telemetry') expect(registrationDisposeMock).toHaveBeenCalledOnce();
  });

  it('wires startServer with loopback, ephemeral port, hostIdentity, serverVersion, corsOrigins, webAssetsDir; calls installGlobalProxyDispatcher; returns origin/port/close', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const appCore = core();
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core: appCore,
      close,
    });

    const handle = await startDesktopServer({
      webAssetsDir: '/app/web-dist',
    });

    expect(installProxyMock).toHaveBeenCalledOnce();
    expect(createDesktopBrowserHostMock).toHaveBeenCalledWith(browserAgentControl, browserSubagentControl, { collect: collectBrowserDialogReminderMock });
    expect(startServerMock).toHaveBeenCalledOnce();
    expect(configureSearchWorkerRuntimeMock).toHaveBeenCalledWith(fileURLToPath(new URL('../../../src/main/server/search-worker.cjs', import.meta.url)));
    const args = startServerMock.mock.calls[0]![0];
    expect(args.host).toBe('127.0.0.1');
    expect(args.port).toBe(0);
    expect(args.webAssetsDir).toBe('/app/web-dist');
    expect(args.corsOrigins).toEqual(['app://renderer']);
    expect(args.disableAuth).toBeUndefined();
    expect(args.debugEndpoints).toBe(false);
    expect(typeof args.serverVersion).toBe('string');
    expect(args.serverVersion.length).toBeGreaterThan(0);

    expect(args.hostIdentity).toEqual({
      productName: 'kimi-code-desktop',
      version: '1.2.3',
      platform: 'kimi_code_desktop',
      displayName: 'Kimi Code',
      replyStyleGuide: expect.stringContaining('desktop app'),
    });
    expect(args.seeds).toEqual([[IHostBrowser, browserHost]]);
    expect(args.features).toEqual([HostBrowserFeature]);
    expect(registerDialogCleanupMock).toHaveBeenCalledWith(appCore, forgetSessionBrowserDialogsMock);
    expect(startBrowserTestEndpointMock).not.toHaveBeenCalled();

    expect(wireDesktopTelemetryMock).toHaveBeenCalledWith(appCore, {
      deviceId: 'device-1',
    });

    expect(handle.origin).toBe('http://127.0.0.1:54321');
    expect(handle.port).toBe(54321);
    await handle.close();
    expect(close).toHaveBeenCalledOnce();
    expect(registrationDisposeMock).toHaveBeenCalledOnce();
    expect(hostDisposeMock).toHaveBeenCalledOnce();
  });

  it('passes the minted device id to telemetry', async () => {
    createKimiDeviceIdMock.mockReturnValue('device-new');
    const appCore = core();
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core: appCore,
      close: vi.fn().mockResolvedValue(undefined),
    });

    await startDesktopServer({});

    expect(createKimiDeviceIdMock).toHaveBeenCalledWith('/tmp/kimi-test');
    expect(wireDesktopTelemetryMock).toHaveBeenCalledWith(appCore, {
      deviceId: 'device-new',
    });
  });

  it('passes an auth token service that accepts the per-launch secret and keeps it out of the server env', async () => {
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core: core(),
      close: vi.fn().mockResolvedValue(undefined),
    });

    await startDesktopServer({});

    const service = startServerMock.mock.calls[0]![0].authTokenService;
    expect(service).toBeDefined();
    const secret = desktopServerSecret();
    await expect(service.isValid(secret)).resolves.toBe(true);
    await expect(service.isValid('not-the-secret')).resolves.toBe(false);
    const env = startServerMock.mock.calls[0]![0].env as Record<string, string>;
    expect(Object.values(env)).not.toContain(secret);
  });

  it('passes debugEndpoints through when requested', async () => {
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core: core(),
      close: vi.fn().mockResolvedValue(undefined),
    });

    await startDesktopServer({ debugEndpoints: true });

    expect(startServerMock.mock.calls[0]![0].debugEndpoints).toBe(true);
    expect(startBrowserTestEndpointMock).not.toHaveBeenCalled();
  });

  it('opens the browser test endpoint only with debug endpoints and a test token', async () => {
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core: core(),
      close: vi.fn().mockResolvedValue(undefined),
    });
    vi.stubEnv('KIMI_BROWSER_TEST_TOKEN', 'browser-test-token');

    await startDesktopServer({});
    expect(startBrowserTestEndpointMock).not.toHaveBeenCalled();

    const handle = await startDesktopServer({ debugEndpoints: true });
    expect(startBrowserTestEndpointMock).toHaveBeenCalledExactlyOnceWith(browserHost, 'browser-test-token');
    await handle.close();
    expect(testEndpointCloseMock).toHaveBeenCalledOnce();
  });

  it('close shuts telemetry down before closing the server', async () => {
    const telemetryShutdown = vi.fn().mockResolvedValue(undefined);
    wireDesktopTelemetryMock.mockResolvedValue({ shutdown: telemetryShutdown });
    const close = vi.fn().mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core: core(),
      close,
    });

    const handle = await startDesktopServer({});
    await handle.close();

    expect(telemetryShutdown).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(registrationDisposeMock).toHaveBeenCalledOnce();
    expect(telemetryShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0]!,
    );
  });

});
