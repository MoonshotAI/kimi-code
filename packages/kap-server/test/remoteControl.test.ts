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
import { remoteControlLockPath } from '@moonshot-ai/remote-control';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type RawData } from 'ws';

import { ErrorCode } from '../src/protocol/error-codes';
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

  it('starts and stops the tunnel at runtime and stays idempotent', async () => {
    const relay = await startRegisterAckRelay();
    vi.stubEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', `http://127.0.0.1:${relay.port}`);

    const initial = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
    const initialBody = (await initial.json()) as Envelope<RemoteControlStatusWire>;
    expect(initialBody.code).toBe(0);
    expect(initialBody.data.state).toBe('off');

    const started = await postRemoteControl(true);
    expect(started.code).toBe(0);
    expect(started.data.state).toBe('on');
    expect(started.data.enabled).toBe(true);
    expect(started.data.url).toContain('/devices/');
    expect(started.data.device_id).toBeTruthy();
    expect(started.data.device_name).toBeTruthy();
    expect(relay.registrations).toHaveLength(1);

    const again = await postRemoteControl(true);
    expect(again.code).toBe(0);
    expect(again.data.state).toBe('on');
    expect(relay.registrations).toHaveLength(1);

    const res = await authedFetch(server as RunningServer, base, '/api/v1/remote-control');
    const fetched = (await res.json()) as Envelope<RemoteControlStatusWire>;
    expect(fetched.data.state).toBe('on');

    const stopped = await postRemoteControl(false);
    expect(stopped.code).toBe(0);
    expect(stopped.data.state).toBe('off');
    expect(stopped.data.enabled).toBe(false);

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

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

async function startRegisterAckRelay(): Promise<{ port: number; registrations: unknown[]; close(): Promise<void> }> {  const wss = new WebSocketServer({ noServer: true });
  const relayServer = createServer();
  const registrations: unknown[] = [];
  wss.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const message = JSON.parse(rawDataText(data)) as { type?: string };
      if (message.type === 'register') {
        registrations.push(message);
        ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
      }
    });
  });
  relayServer.on('upgrade', (request, socket, head) => {
    wss.handleUpgrade(request, socket, head, (ws) => wss.emit('connection', ws, request));
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
    close: () =>
      new Promise((resolve, reject) => {
        relayServer.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      }),
  };
}
