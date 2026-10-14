import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  createKimiDeviceId,
  FileTokenStorage,
  KIMI_CODE_PLATFORM,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import {
  acquireRemoteControlLock,
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
import {
  acquireRemoteControlStartGate,
  registerRemoteControlRoutes,
  type RemoteControlRouteOptions,
} from '../src/routes/remoteControl';
import { writeServerToken } from '../src/services/auth/persistentToken';
import { type RunningServer, startServer } from '../src/start';
import { authedFetch } from './helpers/auth';
import { TEST_HOST_IDENTITY } from './helpers/hostIdentity';

interface Envelope<T> {
  code: number;
  msg: string;
  data: T;
  request_id: string;
  details?: unknown;
}

interface RemoteControlStatusWire {
  enabled: boolean;
  state: 'off' | 'starting' | 'on';
  url?: string;
  device_id?: string;
  device_name?: string;
  error?: string;
  conflict?: {
    pid: number;
    local_origin: string;
    device_id: string;
    url: string;
    started_at: number;
  };
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
    expect(first.data.url).toContain(`from=${TEST_HOST_IDENTITY.platform}`);
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
    expect(posted.details).toMatchObject({
      pid: process.pid,
      local_origin: 'http://127.0.0.1:58627',
      device_id: 'other-device',
      url: 'https://code-rc.kimi.com/devices/other-device/',
    });
    expect(typeof (posted.details as { started_at?: unknown }).started_at).toBe('number');

    const statusRes = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
    const statusBody = (await statusRes.json()) as Envelope<RemoteControlStatusWire>;
    expect(statusBody.data.state).toBe('off');
    expect(statusBody.data.error).toContain('already running');
    expect(statusBody.data.conflict).toMatchObject({
      pid: process.pid,
      local_origin: 'http://127.0.0.1:58627',
      device_id: 'other-device',
      url: 'https://code-rc.kimi.com/devices/other-device/',
    });
  });

  it('reports a live lock in status without an enable attempt and clears it once the holder is gone', async () => {
    await rm(remoteControlLockPath(home as string), { force: true });
    await mkdir(join(home as string, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(home as string),
      JSON.stringify({
        pid: process.pid,
        nonce: 'live-holder',
        local_origin: 'http://127.0.0.1:58627',
        device_id: 'live-device',
        url: 'https://code-rc.kimi.com/devices/live-device/',
        started_at: Date.now(),
      }),
    );

    const liveRes = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
    const live = (await liveRes.json()) as Envelope<RemoteControlStatusWire>;
    expect(live.data.state).toBe('off');
    expect(live.data.conflict).toMatchObject({
      pid: process.pid,
      local_origin: 'http://127.0.0.1:58627',
      device_id: 'live-device',
      url: 'https://code-rc.kimi.com/devices/live-device/',
    });

    const posted = await postRemoteControl(true);
    expect(posted.code).toBe(ErrorCode.REMOTE_CONTROL_ALREADY_RUNNING);

    await writeFile(
      remoteControlLockPath(home as string),
      JSON.stringify({
        pid: 999999,
        nonce: 'dead-holder',
        local_origin: 'http://127.0.0.1:58628',
        device_id: 'dead-device',
        url: 'https://code-rc.kimi.com/devices/dead-device/',
        started_at: Date.now(),
      }),
    );
    const staleRes = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
    const stale = (await staleRes.json()) as Envelope<RemoteControlStatusWire>;
    expect(stale.data.conflict).toBeUndefined();
    expect(stale.data.error).toBeUndefined();

    await rm(remoteControlLockPath(home as string), { force: true });
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

  it('stops the local tunnel when the current device is deactivated', async () => {
    await rm(remoteControlLockPath(home as string), { force: true });
    const cloud = await startDeviceCloud({ tunnel: true });
    vi.stubEnv(
      'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
      `http://127.0.0.1:${cloud.port}/coding-relay/`,
    );

    const currentState = async (): Promise<string> => {
      const res = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
      return ((await res.json()) as Envelope<RemoteControlStatusWire>).data.state;
    };

    const enabled = await postRemoteControl(true);
    expect(enabled.data.state).toBe('on');
    const currentId = enabled.data.device_id;
    expect(currentId).toBeTruthy();

    const otherRes = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/remote-control/devices/other-device/deactivate',
      { method: 'POST' },
    );
    expect(((await otherRes.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(await currentState()).toBe('on');

    const ownRes = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/remote-control/devices/${currentId}/deactivate`,
      { method: 'POST' },
    );
    expect(((await ownRes.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(await currentState()).toBe('off');

    await cloud.close();
  });

  it('stops the local tunnel when the current device is deleted', async () => {
    await rm(remoteControlLockPath(home as string), { force: true });
    const cloud = await startDeviceCloud({ tunnel: true });
    vi.stubEnv(
      'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
      `http://127.0.0.1:${cloud.port}/coding-relay/`,
    );

    const currentState = async (): Promise<string> => {
      const res = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
      return ((await res.json()) as Envelope<RemoteControlStatusWire>).data.state;
    };

    const enabled = await postRemoteControl(true);
    expect(enabled.data.state).toBe('on');
    const currentId = enabled.data.device_id;
    expect(currentId).toBeTruthy();

    const otherRes = await authedFetch(
      server as RunningServer,
      base,
      '/api/v1/remote-control/devices/other-device',
      { method: 'DELETE' },
    );
    expect(((await otherRes.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(await currentState()).toBe('on');

    const ownRes = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/remote-control/devices/${currentId}`,
      { method: 'DELETE' },
    );
    expect(((await ownRes.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(await currentState()).toBe('off');
    await waitFor(async () => (await currentState()) === 'off');
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(await currentState()).toBe('off');

    await cloud.close();
  });

  it('waits for the lock holder to release before answering current-device deactivation', async () => {
    await rm(remoteControlLockPath(home as string), { force: true });
    const cloud = await startDeviceCloud();
    vi.stubEnv(
      'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
      `http://127.0.0.1:${cloud.port}/coding-relay/`,
    );

    const deviceId = createKimiDeviceId(home as string);
    await mkdir(join(home as string, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(home as string),
      JSON.stringify({
        pid: process.pid,
        nonce: 'holder',
        local_origin: 'http://127.0.0.1:58627',
        device_id: deviceId,
        url: 'https://code-rc.kimi.com/devices/x/',
        started_at: Date.now(),
      }),
    );
    const releaser = setTimeout(() => {
      void rm(remoteControlLockPath(home as string), { force: true });
    }, 200);

    const startedAt = Date.now();
    const res = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/remote-control/devices/${deviceId}/deactivate`,
      { method: 'POST' },
    );
    const elapsed = Date.now() - startedAt;
    clearTimeout(releaser);

    expect(((await res.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(elapsed).toBeGreaterThanOrEqual(150);
    expect(
      await readFile(remoteControlLockPath(home as string), 'utf8').catch(() => undefined),
    ).toBeUndefined();
    await cloud.close();
  });

  it('fails current-device deactivation when the lock holder never releases', async () => {
    await rm(remoteControlLockPath(home as string), { force: true });
    const cloud = await startDeviceCloud();
    vi.stubEnv(
      'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
      `http://127.0.0.1:${cloud.port}/coding-relay/`,
    );

    const deviceId = createKimiDeviceId(home as string);
    await mkdir(join(home as string, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(home as string),
      JSON.stringify({
        pid: process.pid,
        nonce: 'holder',
        local_origin: 'http://127.0.0.1:58627',
        device_id: deviceId,
        url: 'https://code-rc.kimi.com/devices/x/',
        started_at: Date.now(),
      }),
    );

    const startedAt = Date.now();
    const res = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/remote-control/devices/${deviceId}/deactivate`,
      { method: 'POST' },
    );
    const elapsed = Date.now() - startedAt;

    const body = (await res.json()) as Envelope<null>;
    expect(body.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(body.msg).toContain('did not stop in time');
    expect(elapsed).toBeGreaterThanOrEqual(4900);
    await rm(remoteControlLockPath(home as string), { force: true });
    await cloud.close();
  }, 12000);

  it('treats the deterministic device id as local before the lock file exists', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rc-prelock-'));
    let disabled = false;
    const service = {
      status: () => ({ enabled: false, state: 'starting', deviceId: undefined }),
      disable: async () => {
        disabled = true;
        return { enabled: false, state: 'off' };
      },
    } as unknown as RemoteControlManager;
    const devices = {
      deactivateDevice: async () => {},
    } as unknown as RemoteControlDeviceClient;
    let handler: ((req: unknown, reply: unknown) => unknown) | undefined;
    const app = {
      get: () => {},
      post: (path: string, _options: unknown, next: unknown) => {
        if (path === '/remote-control/devices/:id/deactivate') handler = next as typeof handler;
      },
      patch: () => {},
      delete: () => {},
    };
    registerRemoteControlRoutes(app as never, { service, devices, homeDir });

    let payload: unknown;
    await handler!(
      { id: 'req-1', params: { id: createKimiDeviceId(homeDir) } },
      {
        send: (value: unknown) => {
          payload = value;
        },
      },
    );

    expect(disabled).toBe(true);
    expect((payload as Envelope<{ ok: true }>).data.ok).toBe(true);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('treats the active tunnel registered id as local when it differs from the recomputed id', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rc-legacy-'));
    const events: string[] = [];
    const service = {
      status: () => ({ enabled: true, state: 'on', deviceId: 'legacy-id' }),
      disable: async () => {
        events.push('disable');
        return { enabled: false, state: 'off' };
      },
    } as unknown as RemoteControlManager;
    const devices = {
      deactivateDevice: async (deviceId: string) => {
        events.push(`deactivate:${deviceId}`);
      },
    } as unknown as RemoteControlDeviceClient;
    let handler: ((req: unknown, reply: unknown) => unknown) | undefined;
    const app = {
      get: () => {},
      post: (path: string, _options: unknown, next: unknown) => {
        if (path === '/remote-control/devices/:id/deactivate') handler = next as typeof handler;
      },
      patch: () => {},
      delete: () => {},
    };
    registerRemoteControlRoutes(app as never, { service, devices, homeDir });

    let payload: unknown;
    await handler!(
      { id: 'req-1', params: { id: 'legacy-id' } },
      {
        send: (value: unknown) => {
          payload = value;
        },
      },
    );

    expect(events).toEqual(['disable', 'deactivate:legacy-id', 'disable']);
    expect((payload as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('blocks concurrent starts while the current device is being deactivated', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rc-gated-'));
    const service = {
      status: () => ({ enabled: false, state: 'off' }),
      disable: async () => ({ enabled: false, state: 'off' }),
    } as unknown as RemoteControlManager;
    const devices = {
      deactivateDevice: async () => {
        await expect(
          acquireRemoteControlLock(homeDir, {
            localOrigin: 'http://127.0.0.1:58627',
            deviceId: createKimiDeviceId(homeDir),
            url: 'https://code-rc.kimi.com/devices/x/',
          }),
        ).rejects.toBeInstanceOf(RemoteControlAlreadyRunningError);
      },
    } as unknown as RemoteControlDeviceClient;
    let handler: ((req: unknown, reply: unknown) => unknown) | undefined;
    const app = {
      get: () => {},
      post: (path: string, _options: unknown, next: unknown) => {
        if (path === '/remote-control/devices/:id/deactivate') handler = next as typeof handler;
      },
      patch: () => {},
      delete: () => {},
    };
    registerRemoteControlRoutes(app as never, { service, devices, homeDir });

    let payload: unknown;
    await handler!(
      { id: 'req-1', params: { id: createKimiDeviceId(homeDir) } },
      {
        send: (value: unknown) => {
          payload = value;
        },
      },
    );

    expect((payload as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('keeps the status readable when stale-lock cleanup fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rc-stale-'));
    await mkdir(join(homeDir, 'server'), { recursive: true });
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise((resolve) => child.once('exit', resolve));
    await writeFile(
      remoteControlLockPath(homeDir),
      JSON.stringify({
        pid: child.pid,
        nonce: 'stale',
        local_origin: 'http://127.0.0.1:58627',
        device_id: 'stale-device',
        url: 'https://code-rc.kimi.com/devices/x/',
        started_at: Date.now(),
      }),
    );
    await chmod(join(homeDir, 'server'), 0o555);
    const service = {
      status: () => ({ enabled: false, state: 'off' }),
    } as unknown as RemoteControlManager;
    let handler: ((req: unknown, reply: unknown) => unknown) | undefined;
    const app = {
      get: (path: string, _options: unknown, next: unknown) => {
        if (path === '/remote-control') handler = next as typeof handler;
      },
      post: () => {},
      patch: () => {},
      delete: () => {},
    };
    registerRemoteControlRoutes(app as never, {
      service,
      devices: {} as RemoteControlDeviceClient,
      homeDir,
    });

    let payload: unknown;
    await handler!(
      { id: 'req-1' },
      {
        send: (value: unknown) => {
          payload = value;
        },
      },
    );

    const body = payload as Envelope<{ state: string; conflict?: unknown }>;
    expect(body.code).toBe(0);
    expect(body.data.state).toBe('off');
    expect(body.data.conflict).toBeUndefined();
    await chmod(join(homeDir, 'server'), 0o755);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('rechecks the local manager before releasing the deactivation gate', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-rc-recheck-'));
    let state = 'off';
    const events: string[] = [];
    const service = {
      status: () => ({ enabled: state === 'on', state }),
      disable: async () => {
        events.push('disable');
        state = 'off';
        return { enabled: false, state: 'off' };
      },
    } as unknown as RemoteControlManager;
    const devices = {
      deactivateDevice: async () => {
        events.push('deactivate');
        state = 'starting';
      },
    } as unknown as RemoteControlDeviceClient;
    let handler: ((req: unknown, reply: unknown) => unknown) | undefined;
    const app = {
      get: () => {},
      post: (path: string, _options: unknown, next: unknown) => {
        if (path === '/remote-control/devices/:id/deactivate') handler = next as typeof handler;
      },
      patch: () => {},
      delete: () => {},
    };
    registerRemoteControlRoutes(app as never, { service, devices, homeDir });

    let payload: unknown;
    await handler!(
      { id: 'req-1', params: { id: createKimiDeviceId(homeDir) } },
      {
        send: (value: unknown) => {
          payload = value;
        },
      },
    );

    expect(events).toEqual(['deactivate', 'disable']);
    expect((payload as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('cancels an in-flight start when the current device is deactivated', async () => {await rm(remoteControlLockPath(home as string), { force: true });
    const cloud = await startDeviceCloud({ tunnel: true, registerDelayMs: 1000 });
    vi.stubEnv(
      'KIMI_CODE_REMOTE_CONTROL_RELAY_URL',
      `http://127.0.0.1:${cloud.port}/coding-relay/`,
    );

    const currentState = async (): Promise<string> => {
      const res = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
      return ((await res.json()) as Envelope<RemoteControlStatusWire>).data.state;
    };
    const lockExists = async (): Promise<boolean> =>
      (await readFile(remoteControlLockPath(home as string), 'utf8').catch(() => undefined)) !==
      undefined;

    const enablePromise = postRemoteControl(true);
    await waitFor(lockExists);
    expect(await currentState()).toBe('starting');

    const deviceId = createKimiDeviceId(home as string);
    const startedAt = Date.now();
    const res = await authedFetch(
      server as RunningServer,
      base,
      `/api/v1/remote-control/devices/${deviceId}/deactivate`,
      { method: 'POST' },
    );
    const elapsed = Date.now() - startedAt;

    expect(((await res.json()) as Envelope<{ ok: true }>).data.ok).toBe(true);
    expect(elapsed).toBeLessThan(900);
    expect(await currentState()).toBe('off');

    const enableBody = await enablePromise;
    expect(enableBody.code).toBe(ErrorCode.INTERNAL_ERROR);
    await cloud.close();
  }, 8000);

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
  it('registers with the host product name and version', async () => {
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
      const body = (await res.json()) as Envelope<RemoteControlStatusWire>;
      expect(body.code).toBe(0);
      expect(body.data.url).toContain('from=kimi_code_cli');
      expect(
        (relay.registrations[0] as { payload?: { client_version?: string } }).payload
          ?.client_version,
      ).toBe('kimi-code-cli/9.9.9');
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

  function fakeService(behavior: 'ok' | 'already' | 'error' | 'disableError'): RemoteControlManager {
    return {
      enable: async () => {
        if (behavior === 'already') throw new RemoteControlAlreadyRunningError(HOLDER);
        if (behavior === 'error') throw new Error('boom');
        return { enabled: true, state: 'on' };
      },
      disable: async () => {
        if (behavior === 'disableError') throw new Error('stop failed');
        return { enabled: false, state: 'off' };
      },
    } as unknown as RemoteControlManager;
  }

  function postHandler(
    opts: Omit<RemoteControlRouteOptions, 'devices' | 'homeDir'>,
  ): (enabled: boolean) => Promise<unknown> {
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
      homeDir: '/nonexistent',
    });
    return async (enabled) => {
      let payload: unknown;
      await handler!(
        { id: 'req-1', body: { enabled } },
        {
          send: (value: unknown) => {
            payload = value;
          },
        },
      );
      return payload;
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

  it('tracks disable failures and answers with the internal-error envelope', async () => {
    const tracked: [string, unknown][] = [];
    const telemetry = {
      track2: (event: string, properties: unknown) => tracked.push([event, properties]),
    } as unknown as ITelemetryService;

    const payload = (await postHandler({ service: fakeService('disableError'), telemetry })(
      false,
    )) as Envelope<null>;

    expect(tracked).toEqual([['remote_control_toggle', { enabled: false, outcome: 'error' }]]);
    expect(payload.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(payload.msg).toBe('stop failed');
  });
});

describe('oauth logout remote-control cleanup', () => {
  async function logoutHandler(
    remoteControl: RemoteControlManager,
    remoteControlDevices: Pick<RemoteControlDeviceClient, 'clear' | 'deactivateDevice'>,
    logout: (provider?: string) => Promise<{ logged_out: true; provider: string }>,
    homeDir?: string,
  ): Promise<(body: { provider?: string }) => Promise<unknown>> {
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
    const resolvedHomeDir = homeDir ?? (await mkdtemp(join(tmpdir(), 'kimi-server-v2-logout-')));
    registerOAuthRoutes(app as never, core, remoteControl, remoteControlDevices, resolvedHomeDir);
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

  it('clears cloud sessions around OAuth logout and tears down the local tunnel after responding', async () => {
    const events: string[] = [];
    let state = 'on';
    const remoteControl = {
      status: () => ({ enabled: state === 'on', state }),
      disable: async () => {
        events.push('disable');
        state = 'off';
        return { enabled: false, state: 'off' };
      },
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {
        events.push('clear');
      },
      deactivateDevice: async () => {},
    };
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-logout-'));
    const post = await logoutHandler(
      remoteControl,
      remoteControlDevices,
      async (provider) => {
        events.push('logout');
        return { logged_out: true, provider: provider ?? 'managed:kimi-code' };
      },
      homeDir,
    );

    const payload = (await post({ provider: 'managed:kimi-code' })) as Envelope<{
      logged_out: true;
      provider: string;
    }>;

    expect(events).toEqual(['clear', 'logout', 'clear']);
    expect(payload.code).toBe(0);
    expect(payload.data.logged_out).toBe(true);
    await waitFor(async () => events.includes('disable'));
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('holds the machine lock during logout so concurrent starts are rejected', async () => {
    const events: string[] = [];
    const remoteControl = {
      status: () => ({ enabled: false, state: 'off' }),
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {
        events.push('clear');
      },
      deactivateDevice: async () => {},
    };
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-logout-'));
    const post = await logoutHandler(
      remoteControl,
      remoteControlDevices,
      async (provider) => {
        events.push('logout');
        const gateHolder = await readFile(remoteControlLockPath(homeDir), 'utf8');
        expect(JSON.parse(gateHolder)).toMatchObject({ local_origin: 'logout in progress' });
        await expect(
          acquireRemoteControlLock(homeDir, {
            localOrigin: 'http://127.0.0.1:58627',
            deviceId: 'racing-device',
            url: 'https://code-rc.kimi.com/devices/racing-device/',
          }),
        ).rejects.toBeInstanceOf(RemoteControlAlreadyRunningError);
        return { logged_out: true, provider: provider ?? 'managed:kimi-code' };
      },
      homeDir,
    );

    const payload = (await post({ provider: 'managed:kimi-code' })) as Envelope<{
      logged_out: true;
      provider: string;
    }>;

    expect(payload.code).toBe(0);
    expect(events).toEqual(['clear', 'logout', 'clear']);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('does not clear cloud sessions or OAuth credentials when disabling the tunnel fails', async () => {
    let clearCalled = false;
    let logoutCalled = false;
    const remoteControl = {
      status: () => ({ enabled: false, state: 'starting' }),
      disable: async () => {
        throw new Error('tunnel stop failed');
      },
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {
        clearCalled = true;
      },
      deactivateDevice: async () => {},
    };
    const post = await logoutHandler(remoteControl, remoteControlDevices, async (provider) => {
      logoutCalled = true;
      return { logged_out: true, provider: provider ?? 'managed:kimi-code' };
    });

    const payload = (await post({ provider: 'managed:kimi-code' })) as Envelope<null>;

    expect(payload.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(payload.msg).toBe('tunnel stop failed');
    expect(clearCalled).toBe(false);
    expect(logoutCalled).toBe(false);
  });

  it('skips remote-control cleanup when logging out an unrelated provider', async () => {
    let statusCalled = false;
    let clearCalled = false;
    const remoteControl = {
      status: () => {
        statusCalled = true;
        return { enabled: true, state: 'on' };
      },
      disable: async () => ({ enabled: false, state: 'off' }),
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {
        clearCalled = true;
      },
      deactivateDevice: async () => {},
    };
    const post = await logoutHandler(remoteControl, remoteControlDevices, async (provider) => ({
      logged_out: true,
      provider: provider ?? 'managed:kimi-code',
    }));

    const payload = (await post({ provider: 'managed:other' })) as Envelope<{
      logged_out: true;
      provider: string;
    }>;

    expect(payload.code).toBe(0);
    expect(payload.data.provider).toBe('managed:other');
    expect(statusCalled).toBe(false);
    expect(clearCalled).toBe(false);
  });

  it('serializes concurrent Kimi logouts so repeated logout stays idempotent', async () => {
    const events: string[] = [];
    const remoteControl = {
      status: () => ({ enabled: false, state: 'off' }),
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {
        events.push('clear');
      },
      deactivateDevice: async () => {},
    };
    let logouts = 0;
    let resolveFirst!: () => void;
    const post = await logoutHandler(remoteControl, remoteControlDevices, async (provider) => {
      logouts += 1;
      events.push(`logout:${logouts}`);
      if (logouts === 1) {
        await new Promise<void>((resolve) => {
          resolveFirst = resolve;
        });
      }
      return { logged_out: true, provider: provider ?? 'managed:kimi-code' };
    });

    const first = post({ provider: 'managed:kimi-code' }) as Promise<
      Envelope<{ logged_out: true }>
    >;
    const second = post({ provider: 'managed:kimi-code' }) as Promise<
      Envelope<{ logged_out: true }>
    >;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(events).toEqual(['clear', 'logout:1']);
    resolveFirst();
    const [firstPayload, secondPayload] = await Promise.all([first, second]);

    expect(firstPayload.code).toBe(0);
    expect(secondPayload.code).toBe(0);
    expect(events).toEqual(['clear', 'logout:1', 'clear', 'clear', 'logout:2', 'clear']);
  });

  it('deactivates a lock held by another process before clearing OAuth credentials', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-logout-lock-'));
    await mkdir(join(homeDir, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(homeDir),
      JSON.stringify({
        pid: process.pid,
        nonce: 'cli-holder',
        local_origin: 'http://127.0.0.1:58627',
        device_id: 'cli-device',
        url: 'https://code-rc.kimi.com/devices/cli-device/',
        started_at: Date.now(),
      }),
    );
    const events: string[] = [];
    const remoteControl = {
      status: () => ({ enabled: false, state: 'off' }),
      disable: async () => {
        events.push('disable');
        return { enabled: false, state: 'off' };
      },
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {
        events.push('clear');
      },
      deactivateDevice: async (deviceId: string) => {
        events.push(`deactivate:${deviceId}`);
        await rm(remoteControlLockPath(homeDir), { force: true });
      },
    };
    const post = await logoutHandler(
      remoteControl,
      remoteControlDevices,
      async (provider) => {
        events.push('logout');
        return { logged_out: true, provider: provider ?? 'managed:kimi-code' };
      },
      homeDir,
    );

    const payload = (await post({ provider: 'managed:kimi-code' })) as Envelope<{
      logged_out: true;
      provider: string;
    }>;

    expect(payload.code).toBe(0);
    expect(events).toEqual(['deactivate:cli-device', 'clear', 'logout', 'clear']);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('blocks logout when deactivating a foreign lock holder fails', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-logout-lock-'));
    await mkdir(join(homeDir, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(homeDir),
      JSON.stringify({
        pid: process.pid,
        nonce: 'cli-holder',
        local_origin: 'http://127.0.0.1:58627',
        device_id: 'cli-device',
        url: 'https://code-rc.kimi.com/devices/cli-device/',
        started_at: Date.now(),
      }),
    );
    let logoutCalled = false;
    const remoteControl = {
      status: () => ({ enabled: false, state: 'off' }),
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {},
      deactivateDevice: async () => {
        throw new Error('cloud unavailable');
      },
    };
    const post = await logoutHandler(
      remoteControl,
      remoteControlDevices,
      async (provider) => {
        logoutCalled = true;
        return { logged_out: true, provider: provider ?? 'managed:kimi-code' };
      },
      homeDir,
    );

    const payload = (await post({ provider: 'managed:kimi-code' })) as Envelope<null>;

    expect(payload.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(payload.msg).toBe('cloud unavailable');
    expect(logoutCalled).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('deactivates a foreign holder that races the start gate before acquiring it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-start-gate-'));
    await mkdir(join(homeDir, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(homeDir),
      JSON.stringify({
        pid: process.pid,
        nonce: 'cli-holder',
        local_origin: 'http://127.0.0.1:58627',
        device_id: 'cli-device',
        url: 'https://code-rc.kimi.com/devices/cli-device/',
        started_at: Date.now(),
      }),
    );
    const deactivated: string[] = [];
    const devices = {
      deactivateDevice: async (deviceId: string) => {
        deactivated.push(deviceId);
        await rm(remoteControlLockPath(homeDir), { force: true });
      },
    };

    const gate = await acquireRemoteControlStartGate(homeDir, devices);

    expect(deactivated).toEqual(['cli-device']);
    const gateHolder = JSON.parse(await readFile(remoteControlLockPath(homeDir), 'utf8')) as {
      local_origin?: string;
      device_id?: string;
    };
    expect(gateHolder.local_origin).toBe('logout in progress');
    expect(gateHolder.device_id).toBe(createKimiDeviceId(homeDir));
    await gate.release();
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('waits for a logout gate held by another server instead of deactivating it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-logout-gate-'));
    await mkdir(join(homeDir, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(homeDir),
      JSON.stringify({
        pid: process.pid,
        nonce: 'gate',
        local_origin: 'logout in progress',
        device_id: createKimiDeviceId(homeDir),
        url: '',
        started_at: Date.now(),
      }),
    );
    let deactivated = false;
    const remoteControl = {
      status: () => ({ enabled: false, state: 'off' }),
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {},
      deactivateDevice: async () => {
        deactivated = true;
      },
    };
    const post = await logoutHandler(
      remoteControl,
      remoteControlDevices,
      async (provider) => ({ logged_out: true, provider: provider ?? 'managed:kimi-code' }),
      homeDir,
    );

    const startedAt = Date.now();
    const [payload] = await Promise.all([
      post({ provider: 'managed:kimi-code' }) as Promise<Envelope<{ logged_out: true }>>,
      (async () => {
        await new Promise((resolve) => setTimeout(resolve, 200));
        await rm(remoteControlLockPath(homeDir), { force: true });
      })(),
    ]);

    expect(payload.code).toBe(0);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(150);
    expect(deactivated).toBe(false);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('waits out another server start gate without deactivating it', async () => {
    const homeDir = await mkdtemp(join(tmpdir(), 'kimi-server-v2-start-gate-'));
    await mkdir(join(homeDir, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(homeDir),
      JSON.stringify({
        pid: process.pid,
        nonce: 'gate',
        local_origin: 'logout in progress',
        device_id: createKimiDeviceId(homeDir),
        url: '',
        started_at: Date.now(),
      }),
    );
    const releaser = setTimeout(() => {
      void rm(remoteControlLockPath(homeDir), { force: true });
    }, 200);
    let deactivated = false;

    const gate = await acquireRemoteControlStartGate(homeDir, {
      deactivateDevice: async () => {
        deactivated = true;
      },
    });
    clearTimeout(releaser);

    expect(deactivated).toBe(false);
    await gate.release();
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await rm(homeDir, { recursive: true, force: true });
  });

  it('retries the delayed tunnel teardown after logout', async () => {
    let disableAttempts = 0;
    const remoteControl = {
      status: () => ({ enabled: true, state: 'on' }),
      disable: async () => {
        disableAttempts += 1;
        if (disableAttempts < 3) throw new Error('lock release failed');
        return { enabled: false, state: 'off' };
      },
    } as unknown as RemoteControlManager;
    const remoteControlDevices = {
      clear: () => {},
      deactivateDevice: async () => {},
    };
    const post = await logoutHandler(
      remoteControl,
      remoteControlDevices,
      async (provider) => ({ logged_out: true, provider: provider ?? 'managed:kimi-code' }),
    );

    const payload = (await post({ provider: 'managed:kimi-code' })) as Envelope<{
      logged_out: true;
    }>;

    expect(payload.code).toBe(0);
    expect(disableAttempts).toBe(0);
    await waitFor(async () => disableAttempts === 3, 10000);
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

async function startDeviceCloud(
  options: { exchangeStatus?: number; tunnel?: boolean; registerDelayMs?: number } = {},
): Promise<{
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
      const mutation = pathname.match(/^\/coding-relay\/v1\/remote\/devices\/[^/]+(\/deactivate)?$/);
      if (
        mutation !== null &&
        ((mutation[1] === undefined && (request.method === 'PATCH' || request.method === 'DELETE')) ||
          (mutation[1] === '/deactivate' && request.method === 'POST'))
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
  if (options.tunnel === true) {
    const managementServer = new WebSocketServer({ noServer: true });
    const httpTunnelServer = new WebSocketServer({ noServer: true });
    managementServer.on('connection', (ws) => {
      ws.on('error', () => {});
      ws.on('message', (data) => {
        const message = JSON.parse(rawDataText(data)) as { type?: string };
        if (message.type === 'register') {
          const ack = () =>
            ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
          if (options.registerDelayMs !== undefined) setTimeout(ack, options.registerDelayMs);
          else ack();
        }
      });
    });
    httpTunnelServer.on('connection', (ws) => {
      ws.on('error', () => {});
    });
    cloudServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url ?? '', 'http://cloud.test').pathname;
      const target = pathname.endsWith('/v1/remote/create') ? managementServer : httpTunnelServer;
      target.handleUpgrade(request, socket, head, (ws) => target.emit('connection', ws, request));
    });
  }
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
