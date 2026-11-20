import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  startServerMock,
  installProxyMock,
  createKimiDeviceIdMock,
  wireDesktopTelemetryMock,
  startDesktopBrowserMcpMock,
  browserMcpCloseMock,
  registerBrowserMcpMock,
  registrationDisposeMock,
  browserAccess,
} = vi.hoisted(() => ({
  startServerMock: vi.fn(),
  installProxyMock: vi.fn(),
  createKimiDeviceIdMock: vi.fn(() => 'device-1'),
  wireDesktopTelemetryMock: vi.fn(),
  startDesktopBrowserMcpMock: vi.fn(),
  browserMcpCloseMock: vi.fn().mockResolvedValue(undefined),
  registerBrowserMcpMock: vi.fn(),
  registrationDisposeMock: vi.fn(),
  browserAccess: { allows: () => true },
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.2.3') },
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
vi.mock('../../../src/main/browser/browser-mcp-registration', () => ({
  createDesktopBrowserAccess: () => browserAccess,
  registerDesktopBrowserMcp: registerBrowserMcpMock,
}));
vi.mock('../../../src/main/browser/browser-dialog-reminder', () => ({
  registerDesktopBrowserDialogReminder: vi.fn(() => ({ dispose: vi.fn() })),
}));
vi.mock('../../../src/main/browser/browser-automation', () => ({
  collectBrowserDialogReminder: vi.fn(),
  forgetSessionBrowserDialogs: vi.fn(),
}));
vi.mock('../../../src/main/diagnostics/telemetry', () => ({
  wireDesktopTelemetry: wireDesktopTelemetryMock,
}));
vi.mock('../../../src/main/browser/browser-agent-control', () => ({
  browserAgentControl: { enabled: () => true, onDidChange: () => () => undefined },
  browserSubagentControl: { enabled: () => false, onDidChange: () => () => undefined },
}));
vi.mock('../../../src/main/browser/browser-mcp', () => ({
  startDesktopBrowserMcp: startDesktopBrowserMcpMock,
}));

import { startDesktopServer } from '../../../src/main/server/embedded-server';
import { desktopServerSecret } from '../../../src/main/server/server-auth';

describe('startDesktopServer', () => {
  function core() {
    return { accessor: 'CORE' };
  }

  beforeEach(() => {
    registerBrowserMcpMock.mockReset().mockReturnValue({ dispose: registrationDisposeMock });
    registrationDisposeMock.mockReset();
    startServerMock.mockReset();
    installProxyMock.mockReset();
    createKimiDeviceIdMock.mockReset().mockReturnValue('device-1');
    wireDesktopTelemetryMock.mockReset().mockResolvedValue(null);
    browserMcpCloseMock.mockReset().mockResolvedValue(undefined);
    startDesktopBrowserMcpMock.mockReset().mockResolvedValue({
      url: 'http://127.0.0.1:60001/mcp',
      token: 'secret',
      config: {
        transport: 'http',
        url: 'http://127.0.0.1:60001/mcp',
        headers: { Authorization: 'Bearer secret' },
      },
      close: browserMcpCloseMock,
    });
  });

  it.each(['registration', 'telemetry'])('closes both servers when %s initialization fails', async (step) => {
    const close = vi.fn().mockRejectedValue(new Error('close failure'));
    startServerMock.mockResolvedValue({ host: '127.0.0.1', port: 1234, core: core(), close });
    const failure = new Error('initialization failed');
    if (step === 'registration') registerBrowserMcpMock.mockImplementationOnce(() => { throw failure; });
    else wireDesktopTelemetryMock.mockRejectedValueOnce(failure);
    await expect(startDesktopServer({})).rejects.toBe(failure);
    expect(close).toHaveBeenCalledOnce();
    expect(browserMcpCloseMock).toHaveBeenCalledOnce();
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
    expect(startDesktopBrowserMcpMock).toHaveBeenCalledWith({ access: browserAccess, token: undefined });
    expect(startServerMock).toHaveBeenCalledOnce();
    const args = startServerMock.mock.calls[0]![0];
    expect(args.host).toBe('127.0.0.1');
    expect(args.port).toBe(0);
    expect(args.webAssetsDir).toBe('/app/web-dist');
    expect(args.env.KIMI_CODE_EXPERIMENTAL_TOOL_SELECT).toBe('1');
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
    expect(args.seeds).toBeUndefined();
    expect(registerBrowserMcpMock).toHaveBeenCalledWith(appCore, {
      transport: 'http',
      url: 'http://127.0.0.1:60001/mcp',
      headers: { Authorization: 'Bearer secret' },
    }, browserAccess);

    expect(wireDesktopTelemetryMock).toHaveBeenCalledWith(appCore, {
      deviceId: 'device-1',
    });

    expect(handle.origin).toBe('http://127.0.0.1:54321');
    expect(handle.port).toBe(54321);
    await handle.close();
    expect(close).toHaveBeenCalledOnce();
    expect(registrationDisposeMock).toHaveBeenCalledOnce();
    expect(browserMcpCloseMock).toHaveBeenCalledOnce();
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
    expect(startDesktopBrowserMcpMock).toHaveBeenCalledWith({ access: browserAccess, token: undefined });
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
