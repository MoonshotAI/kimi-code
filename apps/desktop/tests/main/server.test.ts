import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  startServerMock,
  installProxyMock,
  createKimiDeviceIdMock,
  wireDesktopTelemetryMock,
} = vi.hoisted(() => ({
  startServerMock: vi.fn(),
  installProxyMock: vi.fn(),
  createKimiDeviceIdMock: vi.fn(() => 'device-1'),
  wireDesktopTelemetryMock: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getVersion: vi.fn(() => '1.2.3') },
}));
vi.mock('@moonshot-ai/kap-server', () => ({
  startServer: startServerMock,
  createServerLogger: vi.fn(),
}));
vi.mock('@moonshot-ai/kimi-code-oauth', () => ({
  createKimiDeviceId: createKimiDeviceIdMock,
}));
vi.mock('@moonshot-ai/kimi-code-sdk', () => ({
  installGlobalProxyDispatcher: installProxyMock,
  resolveKimiHome: () => '/tmp/kimi-test',
}));
vi.mock('../../src/main/telemetry', () => ({
  wireDesktopTelemetry: wireDesktopTelemetryMock,
}));

import { startDesktopServer } from '../../src/main/server';

describe('startDesktopServer', () => {
  beforeEach(() => {
    startServerMock.mockReset();
    installProxyMock.mockReset();
    createKimiDeviceIdMock.mockReset().mockReturnValue('device-1');
    wireDesktopTelemetryMock.mockReset().mockResolvedValue(null);
  });

  it('wires startServer with loopback, ephemeral port, hostIdentity, serverVersion, corsOrigins, webAssetsDir; calls installGlobalProxyDispatcher; returns origin/port/close', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const core = { accessor: 'CORE' };
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core,
      close,
    });

    const handle = await startDesktopServer({
      webAssetsDir: '/app/web-dist',
    });

    expect(installProxyMock).toHaveBeenCalledOnce();
    expect(startServerMock).toHaveBeenCalledOnce();
    const args = startServerMock.mock.calls[0]![0];
    expect(args.host).toBe('127.0.0.1');
    expect(args.port).toBe(0);
    expect(args.webAssetsDir).toBe('/app/web-dist');
    expect(args.corsOrigins).toEqual(['app://renderer']);
    // Embedded server skips the persistent bearer token entirely.
    expect(args.disableAuth).toBe(true);
    // server_version comes from the tsdown/vitest-injected __KIMI_CORE_VERSION__
    // (the kimi-code CLI version), never from the bundled package.json lookup.
    expect(typeof args.serverVersion).toBe('string');
    expect(args.serverVersion.length).toBeGreaterThan(0);

    // The desktop host identity: transport fields (kap-server derives the
    // bootstrap client identity and the outbound headers from them) plus the
    // system-prompt display overrides.
    expect(args.hostIdentity).toEqual({
      productName: 'kimi-code-desktop',
      version: '1.2.3',
      platform: 'kimi_code_desktop',
      displayName: 'Kimi Code',
      replyStyleGuide: expect.stringContaining('desktop app'),
    });
    // No seeds: headers are derived by kap-server from hostIdentity.
    expect(args.seeds).toBeUndefined();

    // The telemetry appender attaches to the embedded server's DI scope; with
    // consent denied (null handle) close just closes the server.
    expect(wireDesktopTelemetryMock).toHaveBeenCalledWith(core, {
      deviceId: 'device-1',
    });

    expect(handle.origin).toBe('http://127.0.0.1:54321');
    expect(handle.port).toBe(54321);
    await handle.close();
    expect(close).toHaveBeenCalledOnce();
  });

  it('passes the minted device id to telemetry', async () => {
    createKimiDeviceIdMock.mockReturnValue('device-new');
    const core = { accessor: 'CORE' };
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core,
      close: vi.fn().mockResolvedValue(undefined),
    });

    await startDesktopServer({});

    expect(createKimiDeviceIdMock).toHaveBeenCalledWith('/tmp/kimi-test');
    expect(wireDesktopTelemetryMock).toHaveBeenCalledWith(core, {
      deviceId: 'device-new',
    });
  });

  it('close shuts telemetry down before closing the server', async () => {
    const telemetryShutdown = vi.fn().mockResolvedValue(undefined);
    wireDesktopTelemetryMock.mockResolvedValue({ shutdown: telemetryShutdown });
    const close = vi.fn().mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
      core: { accessor: 'CORE' },
      close,
    });

    const handle = await startDesktopServer({});
    await handle.close();

    expect(telemetryShutdown).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(telemetryShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0]!,
    );
  });
});
