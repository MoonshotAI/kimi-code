import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  startServerMock,
  installProxyMock,
  hostRequestHeadersSeedMock,
  createKimiDefaultHeadersMock,
  wireDesktopTelemetryMock,
} = vi.hoisted(() => ({
  startServerMock: vi.fn(),
  installProxyMock: vi.fn(),
  hostRequestHeadersSeedMock: vi.fn(() => 'HOST_HEADERS_SEED'),
  // Mirrors the real createKimiDefaultHeaders: X-Msh-Platform starts out as
  // the CLI value so the test can verify the desktop override flips it.
  createKimiDefaultHeadersMock: vi.fn(() => ({
    'User-Agent': 'kimi-code-desktop/1.2.3',
    'X-Msh-Platform': 'kimi_code_cli',
  })),
  wireDesktopTelemetryMock: vi.fn(),
}));

vi.mock('@moonshot-ai/kap-server', () => ({
  startServer: startServerMock,
  createServerLogger: vi.fn(),
  serverTokenPath: () => '/tmp/kimi-test/server.token',
}));
vi.mock('@moonshot-ai/agent-core-v2', () => ({
  hostRequestHeadersSeed: hostRequestHeadersSeedMock,
}));
vi.mock('@moonshot-ai/kimi-code-oauth', () => ({
  createKimiDefaultHeaders: createKimiDefaultHeadersMock,
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
    hostRequestHeadersSeedMock.mockClear();
    createKimiDefaultHeadersMock.mockClear();
    wireDesktopTelemetryMock.mockReset().mockResolvedValue(null);
  });

  it('wires startServer with loopback, ephemeral port, corsOrigins, identity seed, webAssetsDir; calls installGlobalProxyDispatcher; returns origin/port/close', async () => {
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
      identity: { userAgentProduct: 'kimi-code-desktop', version: '1.2.3' },
    });

    expect(installProxyMock).toHaveBeenCalledOnce();
    expect(startServerMock).toHaveBeenCalledOnce();
    const args = startServerMock.mock.calls[0]![0];
    expect(args.host).toBe('127.0.0.1');
    expect(args.port).toBe(0);
    expect(args.webAssetsDir).toBe('/app/web-dist');
    expect(args.corsOrigins).toEqual(['app://renderer']);
    // server_version comes from the tsdown/vitest-injected __KIMI_CORE_VERSION__
    // (the kimi-code CLI version), never from the bundled package.json lookup.
    expect(typeof args.version).toBe('string');
    expect(args.version.length).toBeGreaterThan(0);

    // System-prompt identity overrides the CLI defaults (product name +
    // terminal-oriented reply style guide) for the desktop chat UI.
    expect(args.hostIdentity).toEqual({
      productName: 'Kimi Code',
      replyStyleGuide: expect.stringContaining('desktop app'),
    });

    // Host identity is seeded as the full Kimi request headers (v2 dropped
    // `coreProcessOptions`); no serviceOverrides / process.exit hack remains.
    expect(createKimiDefaultHeadersMock).toHaveBeenCalledWith({
      homeDir: '/tmp/kimi-test',
      userAgentProduct: 'kimi-code-desktop',
      version: '1.2.3',
    });
    expect(hostRequestHeadersSeedMock).toHaveBeenCalledWith({
      'User-Agent': 'kimi-code-desktop/1.2.3',
      'X-Msh-Platform': 'kimi_code_desktop',
    });
    expect(args.seeds).toBe('HOST_HEADERS_SEED');

    // The telemetry appender attaches to the embedded server's DI scope; with
    // consent denied (null handle) close just closes the server.
    expect(wireDesktopTelemetryMock).toHaveBeenCalledWith(core);

    expect(handle.origin).toBe('http://127.0.0.1:54321');
    expect(handle.port).toBe(54321);
    await handle.close();
    expect(close).toHaveBeenCalledOnce();
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

    const handle = await startDesktopServer({
      identity: { userAgentProduct: 'kimi-code-desktop', version: '1.2.3' },
    });
    await handle.close();

    expect(telemetryShutdown).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
    expect(telemetryShutdown.mock.invocationCallOrder[0]).toBeLessThan(
      close.mock.invocationCallOrder[0]!,
    );
  });
});
