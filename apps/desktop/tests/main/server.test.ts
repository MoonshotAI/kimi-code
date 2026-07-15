import { describe, it, expect, vi, beforeEach } from 'vitest';

const {
  startServerMock,
  installProxyMock,
  hostRequestHeadersSeedMock,
  createKimiDefaultHeadersMock,
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

import { startDesktopServer } from './server';

describe('startDesktopServer', () => {
  beforeEach(() => {
    startServerMock.mockReset();
    installProxyMock.mockReset();
    hostRequestHeadersSeedMock.mockClear();
    createKimiDefaultHeadersMock.mockClear();
  });

  it('wires startServer with loopback, ephemeral port, independent lock, corsOrigins, identity seed, webAssetsDir; calls installGlobalProxyDispatcher; returns origin/port/close', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({
      host: '127.0.0.1',
      port: 54321,
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
    expect(args.lockPath).toMatch(/server-desktop\.lock$/);
    expect(args.webAssetsDir).toBe('/app/web-dist');
    expect(args.corsOrigins).toEqual(['app://renderer']);

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

    expect(handle.origin).toBe('http://127.0.0.1:54321');
    expect(handle.port).toBe(54321);
    await handle.close();
    expect(close).toHaveBeenCalledOnce();
  });
});
