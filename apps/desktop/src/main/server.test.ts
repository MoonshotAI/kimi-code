import { describe, it, expect, vi, beforeEach } from 'vitest';

const { SHUTDOWN_ID, startServerMock, installProxyMock } = vi.hoisted(() => ({
  SHUTDOWN_ID: { _serviceBrand: undefined, id: 'IServerShutdownService' },
  startServerMock: vi.fn(),
  installProxyMock: vi.fn(),
}));

vi.mock('@moonshot-ai/server', () => ({
  startServer: startServerMock,
  createServerLogger: vi.fn(),
  IServerShutdownService: SHUTDOWN_ID,
  serverTokenPath: () => '/tmp/kimi-test/server.token',
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
  });

  it('wires startServer with loopback, ephemeral port, independent lock, identity, shutdown override (no process.exit), webAssetsDir; calls installGlobalProxyDispatcher; returns origin/port/close', async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    startServerMock.mockResolvedValue({
      address: '127.0.0.1:54321',
      logger: {},
      services: {},
      close,
    });

    const handle = await startDesktopServer({
      webAssetsDir: '/app/web-dist',
      identity: { userAgentProduct: 'kimi-desktop', version: '1.2.3' },
    });

    expect(installProxyMock).toHaveBeenCalledOnce();
    expect(startServerMock).toHaveBeenCalledOnce();
    const args = startServerMock.mock.calls[0]![0];
    expect(args.host).toBe('127.0.0.1');
    expect(args.port).toBe(0);
    expect(args.lockPath).toMatch(/server-desktop\.lock$/);
    expect(args.webAssetsDir).toBe('/app/web-dist');
    expect(args.coreProcessOptions.identity).toEqual({
      userAgentProduct: 'kimi-desktop',
      version: '1.2.3',
    });

    // shutdown override neutralises process.exit and calls close
    expect(Array.isArray(args.serviceOverrides)).toBe(true);
    expect(args.serviceOverrides).toHaveLength(1);
    expect(args.serviceOverrides[0][0]).toBe(SHUTDOWN_ID);
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit must not be called');
    });
    await args.serviceOverrides[0][1].requestShutdown('test');
    expect(close).toHaveBeenCalledOnce();
    exitSpy.mockRestore();

    expect(handle.origin).toBe('http://127.0.0.1:54321');
    expect(handle.port).toBe(54321);
    await handle.close();
    expect(close).toHaveBeenCalledTimes(2);
  });
});
