import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileTokenStorage,
  KIMI_CODE_PLATFORM,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import {
  remoteControlLockPath,
  RemoteControlAlreadyRunningError,
  type RemoteControlDeviceClient,
  type RemoteControlManager,
} from '@moonshot-ai/remote-control';
import { IOAuthService, type ITelemetryService, type Scope } from '@moonshot-ai/agent-core-v2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { ErrorCode } from '../src/protocol/error-codes';
import { registerOAuthRoutes } from '../src/routes/oauth';
import { registerRemoteControlRoutes, type RemoteControlRouteOptions } from '../src/routes/remoteControl';
import { writeServerToken } from '../src/services/auth/persistentToken';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
}

interface RemoteControlStatusWire {
  enabled: boolean;
  state: 'off' | 'starting' | 'on';
  url?: string;
  device_id?: string;
  device_name?: string;
  error?: string;
}

interface RemoteControlDeviceWire {
  device_id: string;
  alias: string;
  status: 'online' | 'offline';
  platform: string;
  client_version: string;
  local_base_url: string;
  created_at: string;
  updated_at: string;
  last_remote_access_at: string;
}

interface RemoteControlDeviceListWire {
  devices: RemoteControlDeviceWire[];
  max_devices?: number;
}

const TOKEN: TokenInfo = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 0,
  scope: '',
  tokenType: 'Bearer',
  expiresIn: 0,
};

describe('server-v2 /api/v1/remote-control', () => {
  let home: string | undefined;
  let server: RunningServer | undefined;
  let base: string;

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rc-'));
    await new FileTokenStorage(join(home, 'credentials')).save(
      resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
      TOKEN,
    );
    server = await startServer({
      hostIdentity: TEST_HOST_IDENTITY,
      host: '127.0.0.1',
      port: 0,
      homeDir: home,
      logLevel: 'silent',
    });
    base = `http://127.0.0.1:${server.port}`;
  });

  afterAll(async () => {
    if (server !== undefined) await server.close();
    if (home !== undefined) await rm(home, { recursive: true, force: true });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  async function postRemoteControl(enabled: boolean): Promise<Envelope<RemoteControlStatusWire>> {
    const res = await authedFetch(server as RunningServer, base, '/api/v1/remote-control', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    expect(res.status).toBe(200);
    return (await res.json()) as Envelope<RemoteControlStatusWire>;
  }

  it('starts and stops the tunnel at runtime, dedupes concurrent enables, and tracks relay-initiated shutdown', async () => {
    const relay = await startRegisterAckRelay();
    vi.stubEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', `http://127.0.0.1:${relay.port}`);

    const initial = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
    const initialBody = (await initial.json()) as Envelope<RemoteControlStatusWire>;
    expect(initialBody.code).toBe(0);
    expect(initialBody.data.state).toBe('off');

    const [first, second] = await Promise.all([postRemoteControl(true), postRemoteControl(true)]);
    expect(first.code).toBe(0);
    expect(second.code).toBe(0);
    expect(first.data.state).toBe('on');
    expect(second.data.state).toBe('on');
    expect(first.data.url).toContain('/devices/');
    expect(first.data.device_id).toBeTruthy();
    expect(first.data.device_name).toBeTruthy();
    expect(relay.registrations).toHaveLength(1);
    expect(
      (relay.registrations[0] as { payload?: { client_version?: string } }).payload
        ?.client_version,
    ).toBe(`${TEST_HOST_IDENTITY.productName}/${TEST_HOST_IDENTITY.version}`);

    const res = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
    const fetched = (await res.json()) as Envelope<RemoteControlStatusWire>;
    expect(fetched.data.state).toBe('on');

    const stopped = await postRemoteControl(false);
    expect(stopped.code).toBe(0);
    expect(stopped.data.state).toBe('off');
    expect(stopped.data.enabled).toBe(false);

    const restarted = await postRemoteControl(true);
    expect(restarted.code).toBe(0);
    expect(restarted.data.state).toBe('on');

    await writeServerToken(home as string, 'rotated-server-token');
    const httpSocket = relay.httpSockets.at(-1)!;
    const rotatedResponsePromise = nextJsonMessage(httpSocket);
    httpSocket.send(
      JSON.stringify({
        request_id: 'request-rotated',
        type: 'request',
        is_last: true,
        body_base64: Buffer.from(
          'GET /api/v1/healthz HTTP/1.1\r\nHost: relay.test\r\n\r\n',
        ).toString('base64'),
      }),
    );
    const rotatedMessage = await rotatedResponsePromise;
    const rotatedResponse = Buffer.from(
      rotatedMessage['body_base64'] as string,
      'base64',
    ).toString();
    expect(rotatedResponse).toContain('HTTP/1.1 200');
    expect(rotatedResponse).toContain('"ok":true');

    relay.managementSockets.at(-1)!.send(
      JSON.stringify({ type: 'disconnect', payload: { reason: 'user_requested' } }),
    );
    await waitFor(async () => {
      const after = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
      const body = (await after.json()) as Envelope<RemoteControlStatusWire>;
      return body.data.state === 'off';
    });

    const reenabled = await postRemoteControl(true);
    expect(reenabled.code).toBe(0);
    expect(reenabled.data.state).toBe('on');

    await postRemoteControl(false);
    await relay.close();
  });

  it('reports REMOTE_CONTROL_ALREADY_RUNNING when another live process holds the lock', async () => {
    await mkdir(join(home as string, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(home as string),
      JSON.stringify({
        pid: process.pid,
        nonce: 'other-process',
        local_origin: 'http://127.0.0.1:58627',
        device_id: 'other-device',
        url: 'https://code-rc.kimi.com/devices/other-device/',
        started_at: Date.now(),
      }),
    );

    const posted = await postRemoteControl(true);
    expect(posted.code).toBe(ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING);
    expect(posted.msg).toContain('already running');
  });

  it('proxies device list and management operations through the Node-side cloud session', async () => {
    const cloud = await startDeviceCloud();
    vi.stubEnv(
      'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
      `http://127.0.0.1:${cloud.port}/coding-relay/`,
    );

    const listedRes = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/remote-control/devices',
    );
    const listed = (await listedRes.json()) as Envelope<RemoteControlDeviceListWire>;
    expect(listed.code).toBe(0);
    expect(listed.data.devices).toHaveLength(1);
    expect(listed.data.max_devices).toBe(3);

    const renamedRes = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/remote-control/devices/device-1',
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ alias: '  Renamed device  ' }),
      },
    );
    expect(((await renamedRes.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);

    const deactivatedRes = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/remote-control/devices/device-1/deactivate',
      { method: 'POST' },
    );
    expect(((await deactivatedRes.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);

    const deletedRes = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/remote-control/devices/device-1',
      { method: 'DELETE' },
    );
    expect(((await deletedRes.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);

    expect(cloud.requests.map((request) => `${request.method} ${request.pathname}`)).toEqual([
      'POST /coding-relay/auth/exchange',
      'GET /coding-relay/v1/remote/devices',
      'PATCH /coding-relay/v1/remote/devices/device-1',
      'POST /coding-relay/v1/remote/devices/device-1/deactivate',
      'DELETE /coding-relay/v1/remote/devices/device-1',
    ]);
    expect(JSON.parse(cloud.requests[2]!.body)).toEqual({ alias: 'Renamed device' });
    expect(cloud.requests.slice(1).every((request) => request.cookie === 'rc_session=one')).toBe(
      true,
    );
    await cloud.close();
  });

  it('rejects blank and overlong device aliases before reaching the cloud', async () => {
    const cloud = await startDeviceCloud();
    vi.stubEnv(
      'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
      `http://127.0.0.1:${cloud.port}/coding-relay/`,
    );

    for (const alias of ['', '   ', 'x'.repeat(51)]) {
      const res = await authedFetch(
        server as RunningServer,
        base,
        '/api/v1/remote-control/devices/device-1',
        {
          method: 'PATCH',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ alias }),
        },
      );
      expect(res.status).toBe(200);
      expect(((await res.json()) as Envelope<null>).code).toBe(ErrorCode.VALIDATION_FAILED);
    }
    expect(cloud.requests).toHaveLength(0);
    await cloud.close();
  });

  it('maps cloud session failures to an internal API error instead of local auth', async () => {
    const cloud = await startDeviceCloud({ exchangeStatus: 401 });
    vi.stubEnv(
      'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
      `http://127.0.0.1:${cloud.port}/coding-relay/`,
    );

    const res = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/remote-control/devices',
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.msg).toContain('Remote Control session exchange failed (HTTP 401)');
    expect(cloud.requests).toHaveLength(1);
    await cloud.close();
  });
});

describe('remote-control registration identity', () => {
  it('keeps the existing CLI client version shape', async () => {
    const cliHome = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rc-cli-'));
    const relay = await startRegisterAckRelay();
    let cliServer: RunningServer | undefined;
    try {
      await new FileTokenStorage(join(cliHome, 'credentials')).save(
        resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
        TOKEN,
      );
      cliServer = await startServer({
        hostIdentity: {
          productName: 'kimi-code-cli',
          version: '9.9.9',
          platform: KIMI_CODE_PLATFORM,
        },
        serverVersion: '9.9.9',
        host: '127.0.0.1',
        port: 0,
        homeDir: cliHome,
        logLevel: 'silent',
      });
      vi.stubEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', `http://127.0.0.1:${relay.port}`);
      const res = await authedFetch(
        cliServer,
        `http://127.0.0.1:${cliServer.port}`,
        '/api/v1/remote-control',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ enabled: true }),
        },
      );
      expect(((await res.json()) as Envelope<RemoteControlStatusWire>).code).toBe(0);
      expect(
        (relay.registrations[0] as { payload?: { client_version?: string } }).payload
          ?.client_version,
      ).toBe('kimi-code/9.9.9');
    } finally {
      if (cliServer !== undefined) await cliServer.close();
      await relay.close();
      await rm(cliHome, { recursive: true, force: true });
      vi.unstubAllEnvs();
    }
  });
});

describe('remote-control route telemetry', () => {
  const HOLDER = {
    pid: 1,
    nonce: 'n',
    localOrigin: 'http://127.0.0.1:1',
    deviceId: 'd',
    url: 'https://example.com/devices/d/',
    startedAt: 0,
  };

  function fakeService(behavior: 'ok' | 'already' | 'error'): RemoteControlManager {
    return {
      enable: async () => {
        if (behavior === 'already') throw new RemoteControlAlreadyRunningError(HOLDER);
        if (behavior === 'error') throw new Error('boom');
        return { enabled: true, state: 'on' };
      },
      disable: async () => ({ enabled: false, state: 'off' }),
    } as unknown as RemoteControlManager;
  }

  function postHandler(
    opts: Omit<RemoteControlRouteOptions, 'devices'>,
  ): (enabled: boolean) => Promise<void> {
    let handler: ((req: unknown, reply: unknown) => unknown) | undefined;
    const app = {
      get: () => {},
      post: (path: string, _options: unknown, h: unknown) => {
        if (path === '/remote-control') handler = h as typeof handler;
      },
      patch: () => {},
      delete: () => {},
    };
    registerRemoteControlRoutes(app as never, {
      ...opts,
      devices: {} as RemoteControlDeviceClient,
    });
    return async (enabled) => {
      await handler!({ id: 'req-1', body: { enabled } }, { send: () => {} });
    };
  }

  it('tracks remote_control_toggle outcomes', async () => {
    const tracked: [string, unknown][] = [];
    const telemetry = {
      track2: (event: string, properties: unknown) => tracked.push([event, properties]),
    } as unknown as ITelemetryService;

    await postHandler({ service: fakeService('ok'), telemetry })(true);
    await postHandler({ service: fakeService('ok'), telemetry })(false);
    await postHandler({ service: fakeService('already'), telemetry })(true);
    await postHandler({
      service: fakeService('ok'),
      staticEnableError: 'disabled by config',
      telemetry,
    })(true);
    await postHandler({ service: fakeService('error'), telemetry })(true);

    expect(tracked).toEqual([
      ['remote_control_toggle', { enabled: true, outcome: 'ok' }],
      ['remote_control_toggle', { enabled: false, outcome: 'ok' }],
      ['remote_control_toggle', { enabled: true, outcome: 'already_running' }],
      ['remote_control_toggle', { enabled: true, outcome: 'rejected' }],
      ['remote_control_toggle', { enabled: true, outcome: 'error' }],
    ]);
  });
});

describe('oauth logout remote-control cleanup', () => {
  function logoutHandler(
    remoteControl: RemoteControlManager,
    remoteControlDevices: Pick<RemoteControlDeviceClient, 'clear'>,
    logout: (provider?: string) => Promise<{ logged_out: true; provider: string }>,
  ): (body: { provider?: string }) => Promise<unknown> {
    let handler:
      | ((req: { id: string; body: { provider?: string } }, reply: { send(payload: unknown): unknown }) => Promise<void>)
      | undefined;
    const app = {
      get: () => {},
      delete: () => {},
      post: (path: string, _options: unknown, next: unknown) => {
        if (path === '/oauth/logout') handler = next as typeof handler;
      },
    };
    const core = {
      accessor: {
        get: (token: unknown) => (token === IOAuthService ? { logout } : undefined),
      },
    } as unknown as Scope;
    registerOAuthRoutes(app as never, core, remoteControl, remoteControlDevices);
    return async (body) => {
      let payload: unknown;
      await handler!(
        { id: 'req-1', body },
        {
          send: (value) => {
            payload = value;
          },
        },
      );
      return payload;
    };
  }

  it('disables the tunnel and clears cloud sessions before clearing OAuth credentials', async () => {
    const events: string[] = [];
    const remoteControl = {
      disable: async () => {
        events.push('disable');
        return { enabled: false, state: 'off' };
      },
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {
        events.push('clear');
      },
    };
    const post = logoutHandler(remoteControl, remoteControlDevices, async (provider) => {
      events.push('logout');
      return { logged_out: true, provider: provider ?? 'managed:kimi-code' };
    });

    const payload = (await post({ provider: 'managed:kimi-code' })) as Envelope<{
      logged_out: true;
      provider: string;
    }>;

    expect(events).toEqual(['disable', 'clear', 'logout']);
    expect(payload.code).toBe(0);
    expect(payload.data.logged_out).toBe(true);
  });

  it('does not clear cloud sessions or OAuth credentials when disabling the tunnel fails', async () => {
    let clearCalled = false;
    let logoutCalled = false;
    const remoteControl = {
      disable: async () => {
        throw new Error('tunnel stop failed');
      },
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {
        clearCalled = true;
      },
    };
    const post = logoutHandler(remoteControl, remoteControlDevices, async (provider) => {
      logoutCalled = true;
      return { logged_out: true, provider: provider ?? 'managed:kimi-code' };
    });

    const payload = (await post({ provider: 'managed:kimi-code' })) as Envelope<null>;

    expect(payload.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(payload.msg).toBe('tunnel stop failed');
    expect(clearCalled).toBe(false);
    expect(logoutCalled).toBe(false);
  });
});

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function nextJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once('message', (data) => {
      resolve(JSON.parse(rawDataText(data)) as Record<string, unknown>);
    });
  });
}

async function startRegisterAckRelay(): Promise<{
  port: number;
  registrations: unknown[];
  managementSockets: WebSocket[];
  httpSockets: WebSocket[];
  close(): Promise<void>;
}> {
  const managementServer = new WebSocketServer({ noServer: true });
  const httpTunnelServer = new WebSocketServer({ noServer: true });
  const relayServer = createServer();
  const registrations: unknown[] = [];
  const managementSockets: WebSocket[] = [];
  const httpSockets: WebSocket[] = [];
  managementServer.on('connection', (ws) => {
    managementSockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const message = JSON.parse(rawDataText(data)) as { type?: string };
      if (message.type === 'register') {
        registrations.push(message);
        ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
      }
    });
  });
  httpTunnelServer.on('connection', (ws) => {
    httpSockets.push(ws);
    ws.on('error', () => {});
  });
  relayServer.on('upgrade', (request, socket, head) => {
    const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
    const target = pathname.endsWith('/v1/remote/create') ? managementServer : httpTunnelServer;
    target.handleUpgrade(request, socket, head, (ws) => target.emit('connection', ws, request));
  });
  const port = await new Promise<number>((resolve, reject) => {
    relayServer.once('error', reject);
    relayServer.listen(0, '127.0.0.1', () => {
      const address = relayServer.address();
      if (address === null || typeof address === 'string') reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
  return {
    port,
    registrations,
    managementSockets,
    httpSockets,
    close: () =>
      new Promise((resolve, reject) => {
        relayServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

async function startDeviceCloud(options: { exchangeStatus?: number } = {}): Promise<{
  port: number;
  requests: Array<{
    method: string;
    pathname: string;
    cookie?: string;
    body: string;
  }>;
  close(): Promise<void>;
}> {
  const device: RemoteControlDeviceWire = {
    device_id: 'device-1',
    alias: 'Workstation',
    status: 'online',
    platform: 'darwin',
    client_version: 'test-host/0.0.0-test',
    local_base_url: 'http://127.0.0.1:58627',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    last_remote_access_at: '2026-01-01T00:00:00.000Z',
  };
  const requests: Array<{
    method: string;
    pathname: string;
    cookie?: string;
    body: string;
  }> = [];
  const cloudServer = createServer((request, response) => {
    void (async () => {
      const pathname = new URL(request.url ?? '', 'http://cloud.test').pathname;
      const body = await requestBody(request);
      requests.push({
        method: request.method ?? '',
        pathname,
        cookie: Array.isArray(request.headers.cookie)
          ? request.headers.cookie[0]
          : request.headers.cookie,
        body,
      });
      if (pathname === '/coding-relay/auth/exchange') {
        if (options.exchangeStatus !== undefined) {
          response.writeHead(options.exchangeStatus, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ error: { message: 'exchange rejected' } }));
          return;
        }
        response.writeHead(204, { 'Set-Cookie': 'rc_session=one; Path=/; HttpOnly' });
        response.end();
        return;
      }
      if (pathname === '/coding-relay/v1/remote/devices' && request.method === 'GET') {
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ devices: [device], max_devices: 3 }));
        return;
      }
      if (
        (pathname === '/coding-relay/v1/remote/devices/device-1' &&
          (request.method === 'PATCH' || request.method === 'DELETE')) ||
        (pathname === '/coding-relay/v1/remote/devices/device-1/deactivate' &&
          request.method === 'POST')
      ) {
        response.writeHead(204);
        response.end();
        return;
      }
      response.writeHead(404);
      response.end();
    })().catch(() => {
      response.writeHead(500);
      response.end();
    });
  });
  const port = await new Promise<number>((resolve, reject) => {
    cloudServer.once('error', reject);
    cloudServer.listen(0, '127.0.0.1', () => {
      const address = cloudServer.address();
      if (address === null || typeof address === 'string') reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
  return {
    port,
    requests,
    close: () =>
      new Promise((resolve, reject) => {
        cloudServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}

function requestBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.once('error', reject);
    request.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
