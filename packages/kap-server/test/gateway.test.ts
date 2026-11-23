import { createServer } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocket, WebSocketServer, type RawData } from 'ws';

import { listLiveServerInstances } from '../src/instanceRegistry';
import { startWebGateway, type RunningWebGateway } from '../src/gateway';
import { startServer, type RunningServer } from '../src/start';
import { StdioHostSession } from '../src/services/hosts/stdioHostSession';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

const TEST_ENV = {
  KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: '0',
  KIMI_CODE_MODEL_CATALOG_REFRESH_INTERVAL_MS: '0',
};

const OAUTH_TOKEN: TokenInfo = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 0,
  scope: '',
  tokenType: 'Bearer',
  expiresIn: 0,
};

function connectSocket(socketPath: string): Promise<ReturnType<typeof createConnection>> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function openWs(url: string, token?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      url,
      token === undefined ? undefined : { headers: { authorization: `Bearer ${token}` } },
    );
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function rawToText(raw: RawData): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  return Buffer.from(raw).toString('utf8');
}

async function startFakeRelay(): Promise<{
  port: number;
  httpSockets: WebSocket[];
  close(): Promise<void>;
}> {
  const httpServer = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const httpSockets: WebSocket[] = [];
  wss.on('connection', (ws, req) => {
    if ((req.url ?? '').includes('http')) {
      httpSockets.push(ws);
      return;
    }
    ws.on('message', (raw) => {
      const parsed = JSON.parse(rawToText(raw)) as { type?: string };
      if (parsed.type === 'register') {
        ws.send(JSON.stringify({ type: 'register_ack', payload: {} }));
      }
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, '127.0.0.1', resolve));
  const address = httpServer.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    port,
    httpSockets,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}

describe.skipIf(process.platform === 'win32')('startWebGateway over shared unix daemon', () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    vi.unstubAllEnvs();
    while (cleanups.length > 0) {
      await cleanups.pop()!();
    }
  });

  async function bootSharedDaemon(opts?: { managedIdleExitMs?: number }): Promise<{
    home: string;
    socketPath: string;
    daemon: RunningServer;
  }> {
    const home = await mkdtemp(join(tmpdir(), 'kimi-web-gateway-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const socketPath = join(home, 'server', 'daemon.sock');
    const daemon = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: home,
      socketPath,
      managedBy: 'ensure-daemon',
      managedIdleExitMs: opts?.managedIdleExitMs,
      logLevel: 'silent',
      env: TEST_ENV,
    });
    cleanups.push(() => daemon.close());
    return { home, socketPath, daemon };
  }

  async function bootGateway(
    home: string,
    socketPath: string,
    overrides: Partial<Parameters<typeof startWebGateway>[0]> = {},
  ): Promise<RunningWebGateway> {
    const stream = await connectSocket(socketPath);
    const gateway = await startWebGateway({
      daemonStream: stream,
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
      ...overrides,
    });
    cleanups.push(() => gateway.close());
    return gateway;
  }

  it('shares live sessions and real-time WebSocket events between UDS (SSH) and multiple gateways', async () => {
    const { home, socketPath, daemon } = await bootSharedDaemon();
    const activateSpy = vi.spyOn(daemon.hostBridges, 'activate');

    const sshSocket = await connectSocket(socketPath);
    const sshSession = new StdioHostSession(sshSocket);
    cleanups.push(async () => {
      sshSession.close();
      sshSocket.destroy();
    });

    const gatewayA = await bootGateway(home, socketPath, { webTitle: 'Local Web' });
    const gatewayB = await bootGateway(home, socketPath, {
      disableAuth: true,
      webTitle: 'Bypass Web',
    });

    const baseA = `http://127.0.0.1:${gatewayA.port}`;
    const baseB = `http://127.0.0.1:${gatewayB.port}`;

    const instances = await listLiveServerInstances(home);
    expect(instances).toHaveLength(2);
    expect(new Set(instances.map((item) => item.serverId)).size).toBe(2);

    const metaA = (await (
      await authedFetch(gatewayA as unknown as RunningServer, baseA, '/api/v1/meta')
    ).json()) as { data: Record<string, unknown> };
    const metaB = (await (await fetch(`${baseB}/api/v1/meta`)).json()) as {
      data: Record<string, unknown>;
    };
    expect(metaA.data['web_title']).toBe('Local Web');
    expect(metaA.data['dangerous_bypass_auth']).toBe(false);
    expect(metaB.data['web_title']).toBe('Bypass Web');
    expect(metaB.data['dangerous_bypass_auth']).toBe(true);
    expect(metaA.data['server_id']).not.toBe(metaB.data['server_id']);
    expect(metaA.data['server_id']).not.toBe('socket');

    const sshEvents: string[] = [];
    sshSession.openWebSocket('/api/v1/ws', {
      onMessage: (data) => sshEvents.push(data),
      onClose: () => {},
      onBackpressure: () => {},
    });

    const wsA = await openWs(
      `ws://127.0.0.1:${gatewayA.port}/api/v1/ws`,
      gatewayA.authTokenService.getToken(),
    );
    cleanups.push(async () => wsA.close());
    const gatewayEvents: string[] = [];
    wsA.on('message', (raw) => gatewayEvents.push(rawToText(raw)));

    await vi.waitFor(() => {
      expect(activateSpy).toHaveBeenCalled();
    });

    const created = (await (
      await authedFetch(gatewayA as unknown as RunningServer, baseA, '/api/v1/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metadata: { cwd: home } }),
      })
    ).json()) as { code: number; data: { id: string } };
    expect(created.code).toBe(0);
    const sessionId = created.data.id;

    const renameBody = Buffer.from(JSON.stringify({ title: 'Synced From SSH' }));
    const renamed = await sshSession.request({
      method: 'POST',
      path: `/api/v1/sessions/${sessionId}/profile`,
      headers: { host: '127.0.0.1', 'content-type': 'application/json' },
      body: renameBody,
    });
    expect(renamed.status).toBe(200);

    await vi.waitFor(() => {
      expect(gatewayEvents.some((msg) => msg.includes('Synced From SSH'))).toBe(true);
      expect(sshEvents.some((msg) => msg.includes('Synced From SSH'))).toBe(true);
    });

    const listFromB = (await (await fetch(`${baseB}/api/v1/sessions`)).json()) as {
      code: number;
      data: { items: Array<{ id: string; title?: string }> };
    };
    expect(listFromB.code).toBe(0);
    expect(listFromB.data.items).toContainEqual(
      expect.objectContaining({ id: sessionId, title: 'Synced From SSH' }),
    );
  });

  it('proxies nested SSH host WebSockets over the daemon UDS channel', async () => {
    const { home, socketPath, daemon } = await bootSharedDaemon();
    const receivedFromBrowser: string[] = [];
    vi.spyOn(daemon.hostBridges, 'session').mockImplementation((hostId) => {
      if (hostId !== 'dev') return undefined;
      return {
        request: async () => ({ status: 200, headers: {}, body: Buffer.from('{}') }),
        openWebSocket: (path, handlers) => {
          handlers.onMessage(`opened:${path}`);
          return {
            send: (data) => {
              receivedFromBrowser.push(data);
              handlers.onMessage(`echo:${data}`);
            },
            close: () => {},
          };
        },
      };
    });

    const gateway = await bootGateway(home, socketPath);
    const messages: string[] = [];
    const ws = new WebSocket(
      `ws://127.0.0.1:${gateway.port}/api/v1/hosts/dev/proxy/api/v1/ws?client=web`,
      { headers: { authorization: `Bearer ${gateway.authTokenService.getToken()}` } },
    );
    ws.on('message', (raw) => messages.push(rawToText(raw)));
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => resolve());
      ws.once('error', reject);
    });
    cleanups.push(async () => ws.close());

    await vi.waitFor(() => {
      expect(messages).toContain('opened:/api/v1/ws?client=web');
    });
    ws.send('ping-remote');
    await vi.waitFor(() => {
      expect(receivedFromBrowser).toEqual(['ping-remote']);
      expect(messages).toContain('echo:ping-remote');
    });
  });

  it('keeps daemon alive while any UDS client is attached and stops on if_idle once all detach', async () => {
    const { home, socketPath } = await bootSharedDaemon({ managedIdleExitMs: 40 });
    const gateway = await bootGateway(home, socketPath);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const resWhileAttached = await authedFetch(
      gateway as unknown as RunningServer,
      `http://127.0.0.1:${gateway.port}`,
      '/api/v1/healthz',
    );
    expect(resWhileAttached.status).toBe(200);

    const probeSocket1 = await connectSocket(socketPath);
    const probe1 = new StdioHostSession(probeSocket1);
    const busyStop = await probe1.request({
      method: 'POST',
      path: '/api/v1/shutdown?if_idle=true',
      headers: { host: '127.0.0.1' },
    });
    expect(JSON.parse(busyStop.body.toString('utf8'))).toMatchObject({
      code: 0,
      data: { ok: false },
    });
    probe1.close();
    probeSocket1.destroy();

    await gateway.close();

    const probeSocket2 = await connectSocket(socketPath);
    const probe2 = new StdioHostSession(probeSocket2);
    const idleStop = await probe2.request({
      method: 'POST',
      path: '/api/v1/shutdown?if_idle=true',
      headers: { host: '127.0.0.1' },
    });
    expect(JSON.parse(idleStop.body.toString('utf8'))).toMatchObject({
      code: 0,
      data: { ok: true },
    });
    probe2.close();
    probeSocket2.destroy();
  });

  it('enforces non-loopback shutdown 404 and blocks internal routes on the gateway', async () => {
    const { home, socketPath } = await bootSharedDaemon();
    const lanGateway = await bootGateway(home, socketPath, {
      host: '0.0.0.0',
      insecureNoTls: true,
    });
    const token = lanGateway.authTokenService.getToken();

    const shutdownRes = await lanGateway.app.inject({
      method: 'POST',
      url: '/api/v1/shutdown',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(shutdownRes.statusCode).toBe(404);
    expect(shutdownRes.headers['x-content-type-options']).toBe('nosniff');

    const encodedShutdownRes = await lanGateway.app.inject({
      method: 'POST',
      url: '/api/v1/%73hutdown',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(encodedShutdownRes.statusCode).toBe(404);

    const importProvidersRes = await lanGateway.app.inject({
      method: 'POST',
      url: '/api/v1/hosts:import-providers',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ providers: {}, models: {} }),
    });
    expect(importProvidersRes.statusCode).toBe(404);

    const encodedImportProvidersRes = await lanGateway.app.inject({
      method: 'POST',
      url: '/api/v1/hosts%3Aimport-providers',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ providers: {}, models: {} }),
    });
    expect(encodedImportProvidersRes.statusCode).toBe(404);
  });

  it('serves Remote Control locally on the gateway and coordinates OAuth logout', async () => {
    const { home, socketPath } = await bootSharedDaemon();
    await new FileTokenStorage(join(home, 'credentials')).save(
      resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
      OAUTH_TOKEN,
    );
    await writeFile(
      join(home, 'config.toml'),
      `[providers."${KIMI_CODE_PROVIDER_NAME}"]\ntype = "kimi"\nbase_url = "https://api.kimi.com/coding/v1"\noauth = { storage = "file", key = "kimi-code", oauth_host = "https://auth.kimi.com" }\n[providers.broken]\noauth = "invalid"\n`,
      'utf8',
    );

    const relay = await startFakeRelay();
    cleanups.push(() => relay.close());
    vi.stubEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', `http://127.0.0.1:${relay.port}`);

    const gateway = await bootGateway(home, socketPath);
    const base = `http://127.0.0.1:${gateway.port}`;

    const enabledRes = await authedFetch(
      gateway as unknown as RunningServer,
      base,
      '/api/v1/remote-control',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ enabled: true }),
      },
    );
    const enabledBody = (await enabledRes.json()) as {
      code: number;
      data: { state: string; url?: string };
    };
    expect(enabledBody.code).toBe(0);
    expect(enabledBody.data.state).toBe('on');

    const logoutRes = await authedFetch(
      gateway as unknown as RunningServer,
      base,
      '/api/v1/oauth/logout',
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      },
    );
    const logoutBody = (await logoutRes.json()) as {
      code: number;
      data: { logged_out: boolean };
    };
    expect(logoutBody.code).toBe(0);
    expect(logoutBody.data.logged_out).toBe(true);

    await vi.waitFor(async () => {
      const statusRes = await authedFetch(
        gateway as unknown as RunningServer,
        base,
        '/api/v1/remote-control',
      );
      const statusBody = (await statusRes.json()) as { data: { state: string } };
      expect(statusBody.data.state).toBe('off');
    });
  });

  it('reconnects to a restarted daemon via reconnectDaemon without dropping the gateway port', async () => {
    const home = await mkdtemp(join(tmpdir(), 'kimi-web-gateway-reconnect-'));
    cleanups.push(() => rm(home, { recursive: true, force: true }));
    const socketPath = join(home, 'server', 'daemon.sock');

    let daemon1: RunningServer | undefined = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: home,
      socketPath,
      managedBy: 'ensure-daemon',
      logLevel: 'silent',
      env: TEST_ENV,
    });
    cleanups.push(async () => {
      await daemon1?.close();
    });

    const initialStream = await connectSocket(socketPath);
    const gateway = await startWebGateway({
      daemonStream: initialStream,
      reconnectDaemon: () => connectSocket(socketPath),
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    cleanups.push(() => gateway.close());

    const base = `http://127.0.0.1:${gateway.port}`;
    expect((await fetch(`${base}/api/v1/healthz`)).status).toBe(200);

    await daemon1.close();
    daemon1 = undefined;

    const daemon2 = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      homeDir: home,
      socketPath,
      managedBy: 'ensure-daemon',
      logLevel: 'silent',
      env: TEST_ENV,
    });
    cleanups.push(() => daemon2.close());

    const afterRestart = await authedFetch(
      gateway as unknown as RunningServer,
      base,
      '/api/v1/meta',
    );
    expect(afterRestart.status).toBe(200);
  });
});
