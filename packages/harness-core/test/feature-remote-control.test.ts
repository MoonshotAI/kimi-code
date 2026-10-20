import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiCodeOAuthRef,
  resolveKimiRemoteControlAuth,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { createFeature } from '@moonshot-ai/agent-core/app/index';
import { useInject } from '@moonshot-ai/agent-core/kernel/index';

import {
  acquireRemoteControlLock,
  buildRemoteControlUrl,
  createRemoteControl,
  filterForwardRequestHeaders,
  HttpTunnel,
  inspectRemoteControlLock,
  parseRawHttpRequest,
  releaseRemoteControlLockHeldBy,
  REMOTE_CONTROL_RELAY_URL_ENV,
  RemoteControlAlreadyRunningError,
  RemoteControlDeviceClient,
  RemoteControlRef,
  resolveRemoteControlRelayOrigin,
  rewriteRemoteControlResponse,
  type CreateRemoteControlProps,
  type RemoteControlCloseReason,
  type RemoteControlFace,
  type RemoteControlHandle,
  type RemoteControlOptions,
} from '#/feature-remote-control/index';
import { createHarness, memoryHarnessSpace, type Harness } from '#/runtime/index';

const harnesses: Harness[] = [];
const tmps: string[] = [];

const TOKEN: TokenInfo = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 0,
  scope: '',
  tokenType: 'Bearer',
  expiresIn: 0,
};

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(harnesses.splice(0).map((harness) => harness.close()));
  await Promise.all(tmps.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'remote-control-test-'));
  tmps.push(dir);
  return dir;
}

interface FakeTunnel {
  readonly handle: RemoteControlHandle;
  readonly close: ReturnType<typeof vi.fn>;
  readonly exit: (reason?: RemoteControlCloseReason) => void;
}

function createFakeTunnel(): FakeTunnel {
  let exit!: (reason?: RemoteControlCloseReason) => void;
  const closed = new Promise<RemoteControlCloseReason>((resolve) => {
    exit = (reason = 'local_close') => resolve(reason);
  });
  const close = vi.fn(async () => {
    exit();
  });
  const handle: RemoteControlHandle = {
    deviceId: 'd1',
    deviceName: 'host',
    url: 'https://rc.example.test/devices/d1/',
    relayOrigin: 'https://rc.example.test',
    closed,
    close,
  };
  return { handle, close, exit };
}

async function mountRemoteControl(props?: Partial<CreateRemoteControlProps>): Promise<RemoteControlFace> {
  const harness = createHarness({ space: memoryHarnessSpace() });
  harnesses.push(harness);
  harness.app.features.add(
    createRemoteControl({
      homeDir: await makeTmp(),
      localOrigin: () => 'http://127.0.0.1:3000',
      localServerToken: () => 'local-token',
      clientVersion: 'kimi-code/test',
      urlSource: 'kimi_code_test',
      ...props,
    }),
  );
  let face: RemoteControlFace | undefined;
  harness.app.features.add(
    createFeature('remote-control-capture', {
      app() {
        face = useInject(RemoteControlRef).value;
      },
    }),
  );
  if (face === undefined) throw new Error('remote-control facade was not exposed');
  return face;
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('remote-control feature', () => {
  it('exposes the facade with remote control off by default', async () => {
    const start = vi.fn(async () => createFakeTunnel().handle);
    const face = await mountRemoteControl({ start });

    expect(face.status()).toEqual({ enabled: false, state: 'off' });
    expect(start).not.toHaveBeenCalled();
  });

  it('enables once, shares concurrent attempts, and forwards the current client options', async () => {
    const tunnel = createFakeTunnel();
    const start = vi.fn(async () => tunnel.handle);
    const face = await mountRemoteControl({
      start,
      configuredOAuthKey: () => 'oauth/custom',
      configuredOAuthHost: () => 'https://auth.kimi.ai',
    });

    const [first, second] = await Promise.all([face.enable(), face.enable()]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        localOrigin: 'http://127.0.0.1:3000',
        clientVersion: 'kimi-code/test',
        urlSource: 'kimi_code_test',
        configuredOAuthKey: 'oauth/custom',
        configuredOAuthHost: 'https://auth.kimi.ai',
        signal: expect.any(AbortSignal),
      }),
    );
    for (const info of [first, second, face.status()]) {
      expect(info).toEqual({
        enabled: true,
        state: 'on',
        url: 'https://rc.example.test/devices/d1/',
        deviceId: 'd1',
        deviceName: 'host',
      });
    }
    await face.enable();
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('rethrows a start failure and records the error message on status', async () => {
    const start = vi.fn(async (): Promise<RemoteControlHandle> => {
      throw new Error('relay unreachable');
    });
    const face = await mountRemoteControl({ start });

    await expect(face.enable()).rejects.toThrow('relay unreachable');
    expect(face.status()).toEqual({ enabled: false, state: 'off', error: 'relay unreachable' });
  });

  it('propagates lock conflicts with their holder details', async () => {
    const already = new RemoteControlAlreadyRunningError({
      pid: 4242,
      nonce: 'nonce',
      localOrigin: 'http://127.0.0.1:4000',
      deviceId: 'other',
      url: 'https://rc.example.test/devices/other/',
      startedAt: 1,
    });
    const start = vi.fn(async (): Promise<RemoteControlHandle> => {
      throw already;
    });
    const face = await mountRemoteControl({ start });

    const caught = await face.enable().then(
      () => {
        throw new Error('enable should have rejected');
      },
      (error: unknown) => error,
    );
    expect(caught).toBe(already);
    expect(face.status()).toMatchObject({
      enabled: false,
      state: 'off',
      error: already.message,
      conflict: { pid: 4242, deviceId: 'other' },
    });
  });

  it('disables idempotently and cancels an in-flight start', async () => {
    const tunnel = createFakeTunnel();
    const face = await mountRemoteControl({ start: async () => tunnel.handle });
    await face.enable();

    const stopped = await face.disable();

    expect(tunnel.close).toHaveBeenCalledTimes(1);
    expect(stopped).toEqual({ enabled: false, state: 'off' });
    await face.disable();
    expect(tunnel.close).toHaveBeenCalledTimes(1);

    const start = vi.fn(
      (options: RemoteControlOptions) =>
        new Promise<RemoteControlHandle>((_resolve, reject) => {
          options.signal?.addEventListener('abort', () => reject(new Error('start aborted')), {
            once: true,
          });
        }),
    );
    const pendingFace = await mountRemoteControl({ start });
    const enabling = pendingFace.enable();
    const rejected = expect(enabling).rejects.toThrow('Remote Control was disabled while starting.');
    await flush();
    expect(start).toHaveBeenCalledTimes(1);

    expect(await pendingFace.disable()).toEqual({ enabled: false, state: 'off' });
    await rejected;
  });

  it('handles terminal tunnel exit and closes a running tunnel on unmount', async () => {
    const exited = createFakeTunnel();
    const face = await mountRemoteControl({ start: async () => exited.handle });
    await face.enable();

    exited.exit('user_requested');
    await flush();
    expect(face.status()).toEqual({ enabled: false, state: 'off' });

    const running = createFakeTunnel();
    const runningFace = await mountRemoteControl({ start: async () => running.handle });
    await runningFace.enable();
    const harness = harnesses.at(-1)!;
    await harness.close();

    expect(running.close).toHaveBeenCalledTimes(1);
  });

  it('round-trips the machine lock and supports releasing a lock held by this process', async () => {
    const homeDir = await makeTmp();
    const details = {
      localOrigin: 'http://127.0.0.1:3000',
      deviceId: 'd1',
      url: 'https://rc.example.test/devices/d1/',
    };

    await acquireRemoteControlLock(homeDir, details);
    expect(await inspectRemoteControlLock(homeDir)).toMatchObject({
      pid: process.pid,
      localOrigin: details.localOrigin,
      deviceId: details.deviceId,
      url: details.url,
    });
    await expect(acquireRemoteControlLock(homeDir, details)).rejects.toBeInstanceOf(
      RemoteControlAlreadyRunningError,
    );

    expect(await releaseRemoteControlLockHeldBy(homeDir, process.pid)).toBe(true);
    expect(await inspectRemoteControlLock(homeDir)).toBeUndefined();
    expect(await releaseRemoteControlLockHeldBy(homeDir, process.pid)).toBe(false);
    const reacquired = await acquireRemoteControlLock(homeDir, details);
    await reacquired.release();
  });

  it('builds source-tagged relay URLs and resolves credentials from the login region', () => {
    expect(
      buildRemoteControlUrl('device/one', undefined, 'https://code-rc.kimi.com', 'kimi_code_cli'),
    ).toBe('https://code-rc.kimi.com/devices/device%2Fone/?rc=1&from=kimi_code_cli');
    expect(
      buildRemoteControlUrl(
        'device-1',
        'ses 1',
        'https://code-rc.kimi.com',
        'kimi_code_desktop',
      ),
    ).toBe(
      'https://code-rc.kimi.com/devices/device-1/sessions/ses%201?rc=1&from=kimi_code_desktop',
    );
    vi.stubEnv(REMOTE_CONTROL_RELAY_URL_ENV, 'https://rc.example.test/coding-relay/');
    expect(
      buildRemoteControlUrl(
        'device-1',
        undefined,
        resolveRemoteControlRelayOrigin(),
        'kimi_code_cli',
      ),
    ).toBe(
      'https://rc.example.test/coding-relay/devices/device-1/?rc=1&from=kimi_code_cli',
    );

    const globalAuth = resolveKimiRemoteControlAuth({
      configuredOAuthHost: 'https://auth.kimi.ai',
      env: {},
      readMarker: false,
    });
    expect(globalAuth).toEqual({
      region: 'global',
      oauthKey: resolveKimiCodeOAuthRef({
        oauthHost: 'https://auth.kimi.ai',
        baseUrl: 'https://api.kimi.ai/coding/v1',
      }).key,
      relayOrigin: 'https://code-rc.kimi.ai',
    });
    expect(
      resolveKimiRemoteControlAuth({
        configuredOAuthKey: 'oauth/custom',
        env: {},
        readMarker: false,
      }).relayOrigin,
    ).toBe('https://code-rc.kimi.com');
  });

  it('parses chunked raw requests, swaps credentials, and rewrites textual responses', () => {
    const parsed = parseRawHttpRequest([
      Buffer.from(
        'POST /api/v1/messages?q=1 HTTP/1.1\r\nHost: relay.example\r\nAuthorization: Bearer relay\r\nCookie: sid=1\r\nOrigin: https://relay.example\r\nConnection: keep-alive, X-Hop\r\nX-Hop: remove\r\nX-Keep: yes\r\nContent-Length: 4\r\n\r',
      ),
      Buffer.from('\nda'),
      Buffer.from('ta'),
    ]);

    expect(parsed).toMatchObject({ method: 'POST', path: '/api/v1/messages?q=1' });
    expect(parsed.body.map((chunk) => chunk.toString())).toEqual(['da', 'ta']);
    expect(filterForwardRequestHeaders(parsed.headers, 'local-token')).toEqual([
      'X-Keep',
      'yes',
      'Content-Length',
      '4',
      'Authorization',
      'Bearer local-token',
    ]);

    const prefix = '/coding-relay/devices/device-1';
    const html = rewriteRemoteControlResponse(
      'text/html; charset=utf-8',
      Buffer.from(
        '<html><head></head><body><script src="/boot.js"></script><a href="/x">x</a></body></html>',
      ),
      prefix,
    ).toString();
    expect(html).toContain(`src="${prefix}/boot.js"`);
    expect(html).toContain(`href="${prefix}/x"`);
    expect(html).toContain("sessionStorage.setItem('kimi-desktop-server-origin',location.origin+p)");
    expect(
      rewriteRemoteControlResponse(
        'text/javascript',
        Buffer.from('const a="/assets/a.js";const s="/sessions/";'),
        prefix,
      ).toString(),
    ).toBe(`const a="${prefix}/assets/a.js";const s="${prefix}/sessions/";`);
    expect(
      rewriteRemoteControlResponse(
        'text/css',
        Buffer.from('.x{background:url(/assets/x.png)}'),
        prefix,
      ).toString(),
    ).toBe(`.x{background:url(${prefix}/assets/x.png)}`);
  });

  it('chunks responses, reassembles uploads, enforces budgets, and aborts transfers', async () => {
    const frames: Record<string, unknown>[] = [];
    const errors: string[] = [];
    const socket = {
      readyState: 1,
      send(frame: string, callback: (error?: Error | null) => void): void {
        frames.push(JSON.parse(frame) as Record<string, unknown>);
        callback(null);
      },
      terminate(): void {},
    } as unknown as WebSocket;
    const calls = new Map<
      string,
      {
        body: readonly Buffer[];
        signal: AbortSignal;
        retain: (receivedBytes: number) => boolean;
        respond: (response: Buffer[]) => void;
      }
    >();
    const limits = {
      maxRequestBytes: 4096,
      maxRetainedBytes: 8192,
      maxSingleFrameResponseBytes: 64,
      responseChunkBytes: 32,
    };
    const tunnel = new HttpTunnel(
      socket,
      (request, signal, retain) =>
        new Promise((respond) => {
          calls.set(request.path, { body: request.body, signal, retain, respond });
        }),
      {
        write: (text: string) => {
          errors.push(text);
          return true;
        },
      },
      limits,
    );
    const send = (id: string, raw: string | Buffer, isLast = true): void => {
      tunnel.handleMessage(
        Buffer.from(
          JSON.stringify({
            request_id: id,
            type: 'request',
            is_last: isLast,
            body_base64: Buffer.from(raw).toString('base64'),
          }),
        ),
      );
    };

    send('a', 'GET /a HTTP/1.1\r\n\r\n');
    send('b', 'GET /b HTTP/1.1\r\n\r\n');
    calls.get('/a')!.respond([Buffer.alloc(40, 1), Buffer.alloc(40, 2)]);
    await flush();
    calls.get('/b')!.respond([Buffer.from('b')]);
    await flush();

    const aFrames = frames.filter((frame) => frame['request_id'] === 'a');
    expect(aFrames.map((frame) => frame['is_last'])).toEqual([false, false, true]);
    const aParts = aFrames.map((frame) => Buffer.from(String(frame['body_base64']), 'base64'));
    expect(aParts.map((part) => part.length)).toEqual([32, 32, 16]);
    expect(Buffer.concat(aParts).equals(Buffer.concat([Buffer.alloc(40, 1), Buffer.alloc(40, 2)]))).toBe(
      true,
    );
    expect(frames.at(-1)).toMatchObject({ request_id: 'b', type: 'response', is_last: true });

    send('c', 'GET /c HTTP/1.1\r\n\r\n');
    tunnel.handleMessage(Buffer.from(JSON.stringify({ request_id: 'c', type: 'abort' })));
    expect(calls.get('/c')!.signal.aborted).toBe(true);

    send('d', 'GET /d HTTP/1.1\r\n\r\n');
    send('e', 'GET /e HTTP/1.1\r\n\r\n');
    expect(calls.get('/d')!.retain(5000)).toBe(true);
    expect(calls.get('/e')!.retain(4096)).toBe(false);
    tunnel.handleMessage(Buffer.from(JSON.stringify({ request_id: 'd', type: 'abort' })));
    expect(calls.get('/e')!.retain(5000)).toBe(true);

    const upload = Buffer.from('POST /f HTTP/1.1\r\nContent-Length: 4\r\n\r\ndata');
    send('f', upload.subarray(0, 17), false);
    expect(calls.has('/f')).toBe(false);
    send('f', upload.subarray(17), true);
    expect(calls.has('/f'), errors.join('\n')).toBe(true);
    expect(calls.get('/f')!.body.map((chunk) => chunk.toString()).join('')).toBe('data');
    calls.get('/f')!.respond([Buffer.from('done')]);
    await flush();
    expect(frames.at(-1)).toMatchObject({ request_id: 'f', is_last: true });

    expect(
      () =>
        new HttpTunnel(socket, async () => [], { write: () => true }, {
          ...limits,
          responseChunkBytes: 0,
        }),
    ).toThrow(/responseChunkBytes/);
    tunnel.close();
  });

  it('exchanges once and reuses the cloud session for device operations', async () => {
    const homeDir = await makeTmp();
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
      TOKEN,
    );
    const device = {
      device_id: 'device-1',
      alias: 'Workstation',
      status: 'online',
      platform: 'darwin',
      client_version: 'kimi-code/1.0.0',
      local_base_url: 'http://127.0.0.1:58627',
      created_at: '2026-01-01T00:00:00.000Z',
      updated_at: '2026-01-01T00:00:00.000Z',
      last_remote_access_at: '2026-01-01T00:00:00.000Z',
    };
    const requests: { url: string; method: string; cookie: string | null; body: string }[] = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(url).pathname;
      requests.push({
        url,
        method: init?.method ?? 'GET',
        cookie: new Headers(init?.headers).get('cookie'),
        body: typeof init?.body === 'string' ? init.body : '',
      });
      if (path === '/coding-relay/auth/exchange') {
        return new Response(null, {
          status: 204,
          headers: { 'Set-Cookie': 'rc_session=one; Path=/; HttpOnly' },
        });
      }
      if (path === '/coding-relay/v1/remote/devices' && init?.method === 'GET') {
        return Response.json({ devices: [device], max_devices: 3 });
      }
      return new Response(null, { status: 204 });
    };
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: 'https://rc.example.test/coding-relay/',
      fetchImpl,
    });

    await expect(client.listDevices()).resolves.toEqual({ devices: [device], max_devices: 3 });
    await client.listDevices();
    await client.renameDevice('device/one', 'Renamed');
    await client.deactivateDevice('device/one');
    await client.deleteDevice('device/one');

    expect(requests.map((request) => request.method)).toEqual([
      'POST',
      'GET',
      'GET',
      'PATCH',
      'POST',
      'DELETE',
    ]);
    expect(requests.filter((request) => new URL(request.url).pathname.endsWith('/auth/exchange'))).toHaveLength(
      1,
    );
    expect(requests.slice(1).every((request) => request.cookie === 'rc_session=one')).toBe(true);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      access_token: TOKEN.accessToken,
      refresh_token: TOKEN.refreshToken,
      expires_in: TOKEN.expiresIn,
    });
    expect(JSON.parse(requests[3]!.body)).toEqual({ alias: 'Renamed' });
    expect(new URL(requests[4]!.url).pathname).toBe(
      '/coding-relay/v1/remote/devices/device%2Fone/deactivate',
    );
    expect(new URL(requests[5]!.url).pathname).toBe(
      '/coding-relay/v1/remote/devices/device%2Fone',
    );
    client.clear();
  });
});
