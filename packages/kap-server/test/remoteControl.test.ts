import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import { remoteControlLockPath, RemoteControlAlreadyRunningError, type RemoteControlManager } from '@moonshot-ai/remote-control';
import type { ITelemetryService } from '@moonshot-ai/agent-core-v2';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import { ErrorCode } from '../src/protocol/error-codes';
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

  function postHandler(opts: RemoteControlRouteOptions): (enabled: boolean) => Promise<void> {
    let handler: ((req: unknown, reply: unknown) => unknown) | undefined;
    const app = {
      get: () => {},
      post: (_path: string, _options: unknown, h: unknown) => {
        handler = h as typeof handler;
      },
    };
    registerRemoteControlRoutes(app as never, opts);
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

async function waitFor(predicate: () => Promise<boolean>, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
