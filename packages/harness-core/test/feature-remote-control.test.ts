import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createHarness, type AppHandle } from '@moonshot-ai/agent-core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createHttp, HttpRef } from '#/feature-http/index';
import {
  acquireRemoteControlLock,
  buildRemoteControlUrl,
  createRemoteControl,
  filterForwardRequestHeaders,
  inspectRemoteControlLock,
  parseRawHttpRequest,
  REMOTE_CONTROL_RELAY_URL_ENV,
  RemoteControlAlreadyRunningError,
  RemoteControlRef,
  rewriteRemoteControlResponse,
  type CreateRemoteControlProps,
  type RemoteControlFace,
  type RemoteControlHandle,
} from '#/feature-remote-control/index';

const apps: AppHandle[] = [];
const tmps: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(apps.splice(0).map((app) => app.disposeAsync()));
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
  readonly exit: () => void;
}

function createFakeTunnel(): FakeTunnel {
  let exit!: () => void;
  const closed = new Promise<void>((resolve) => {
    exit = resolve;
  });
  const close = vi.fn(async () => {
    exit();
  });
  const handle: RemoteControlHandle = {
    deviceId: 'd1',
    deviceName: 'host',
    url: 'https://rc.example.test/devices/d1/',
    closed,
    close,
  };
  return { handle, close, exit };
}

async function mountRemoteControl(
  props?: Partial<CreateRemoteControlProps>,
): Promise<RemoteControlFace> {
  const app = createHarness({
    features: [
      createRemoteControl({
        homeDir: await makeTmp(),
        localOrigin: () => 'http://127.0.0.1:3000',
        localServerToken: () => 'local-token',
        clientVersion: 'kimi-code/test',
        ...props,
      }),
    ],
  });
  apps.push(app);
  await app.ready();
  return app.resolve(RemoteControlRef);
}

const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe('remote-control feature', () => {
  it('exposes the facade with remote control off by default', async () => {
    const start = vi.fn(async () => createFakeTunnel().handle);
    const face = await mountRemoteControl({ start });

    expect(face.status()).toEqual({ enabled: false, state: 'off' });
    expect(start).not.toHaveBeenCalled();
  });

  it('enables the tunnel once and shares the attempt across concurrent enable calls', async () => {
    const tunnel = createFakeTunnel();
    const start = vi.fn(async () => tunnel.handle);
    const face = await mountRemoteControl({ start });

    const [first, second] = await Promise.all([face.enable(), face.enable()]);

    expect(start).toHaveBeenCalledTimes(1);
    expect(start).toHaveBeenCalledWith(
      expect.objectContaining({
        localOrigin: 'http://127.0.0.1:3000',
        clientVersion: 'kimi-code/test',
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

  it('propagates the original RemoteControlAlreadyRunningError instance', async () => {
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
    expect(face.status().state).toBe('off');
  });

  it('disables the tunnel through the handle and stays idempotent while off', async () => {
    const tunnel = createFakeTunnel();
    const face = await mountRemoteControl({ start: async () => tunnel.handle });
    await face.enable();

    const stopped = await face.disable();

    expect(tunnel.close).toHaveBeenCalledTimes(1);
    expect(stopped).toEqual({ enabled: false, state: 'off' });
    await face.disable();
    expect(tunnel.close).toHaveBeenCalledTimes(1);
    expect(face.status()).toEqual({ enabled: false, state: 'off' });
  });

  it('drops back to off when the tunnel exits unexpectedly', async () => {
    const tunnel = createFakeTunnel();
    const face = await mountRemoteControl({ start: async () => tunnel.handle });
    await face.enable();
    expect(face.status().state).toBe('on');

    tunnel.exit();
    await flush();

    expect(face.status()).toEqual({ enabled: false, state: 'off' });
  });

  it('closes the tunnel when the app unmounts', async () => {
    const tunnel = createFakeTunnel();
    const app = createHarness({
      features: [
        createRemoteControl({
          homeDir: await makeTmp(),
          localOrigin: () => 'http://127.0.0.1:3000',
          localServerToken: () => 'local-token',
          clientVersion: 'kimi-code/test',
          start: async () => tunnel.handle,
        }),
      ],
    });
    await app.ready();
    await app.resolve(RemoteControlRef).enable();
    expect(tunnel.close).not.toHaveBeenCalled();

    await app.disposeAsync();

    expect(tunnel.close).toHaveBeenCalledTimes(1);
  });

  it('round-trips the machine-wide lock and rejects a second holder', async () => {
    const homeDir = await makeTmp();
    const details = {
      localOrigin: 'http://127.0.0.1:3000',
      deviceId: 'd1',
      url: 'https://rc.example.test/devices/d1/',
    };

    const lock = await acquireRemoteControlLock(homeDir, details);
    expect(await inspectRemoteControlLock(homeDir)).toMatchObject({
      pid: process.pid,
      localOrigin: details.localOrigin,
      deviceId: details.deviceId,
      url: details.url,
    });
    await expect(acquireRemoteControlLock(homeDir, details)).rejects.toBeInstanceOf(
      RemoteControlAlreadyRunningError,
    );

    await lock.release();
    expect(await inspectRemoteControlLock(homeDir)).toBeUndefined();
    const reacquired = await acquireRemoteControlLock(homeDir, details);
    await reacquired.release();
  });

  it('builds relay device URLs with optional session and env override', () => {
    expect(buildRemoteControlUrl('device-1')).toBe(
      'https://code-rc.kimi.com/devices/device-1/?rc=1&from=kimi_code_cli',
    );
    expect(buildRemoteControlUrl('device-1', 'ses 1')).toBe(
      'https://code-rc.kimi.com/devices/device-1/sessions/ses%201?rc=1&from=kimi_code_cli',
    );
    vi.stubEnv(REMOTE_CONTROL_RELAY_URL_ENV, 'https://rc.example.test/coding-relay/');
    expect(buildRemoteControlUrl('device-1')).toBe(
      'https://rc.example.test/coding-relay/devices/device-1/?rc=1&from=kimi_code_cli',
    );
  });

  it('parses raw HTTP requests and swaps relay headers for the local bearer token', () => {
    const parsed = parseRawHttpRequest(
      Buffer.from(
        'POST /api/v1/messages?q=1 HTTP/1.1\r\nHost: relay.example\r\nAuthorization: Bearer relay\r\nCookie: sid=1\r\nOrigin: https://relay.example\r\nConnection: keep-alive, X-Hop\r\nX-Hop: remove\r\nX-Keep: yes\r\nContent-Length: 4\r\n\r\ndata',
      ),
    );

    expect(parsed).toMatchObject({ method: 'POST', path: '/api/v1/messages?q=1' });
    expect(parsed.body.toString()).toBe('data');
    expect(filterForwardRequestHeaders(parsed.headers, 'local-token')).toEqual([
      'X-Keep',
      'yes',
      'Content-Length',
      '4',
      'Authorization',
      'Bearer local-token',
    ]);
  });

  it('rewrites HTML responses under the public device prefix', () => {
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
    expect(html).toContain('history.pushState=w(history.pushState)');
  });

  it('serves the toggle over feature-http and reports the facade-absent and already-running codes', async () => {
    const tunnel = createFakeTunnel();
    const start = vi.fn(async () => tunnel.handle);
    const app = createHarness({
      features: [
        createRemoteControl({
          homeDir: await makeTmp(),
          localOrigin: () => 'http://127.0.0.1:3000',
          localServerToken: () => 'local-token',
          clientVersion: 'kimi-code/test',
          start,
        }),
        createHttp(),
      ],
    });
    apps.push(app);
    await app.ready();
    const origin = app.resolve(HttpRef).origin;

    const initial = await fetch(`${origin}/api/v1/remote-control`);
    expect(initial.status).toBe(200);
    expect(await initial.json()).toMatchObject({ data: { enabled: false, state: 'off' } });

    const enabled = await fetch(`${origin}/api/v1/remote-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":true}',
    });
    expect(enabled.status).toBe(200);
    expect(await enabled.json()).toMatchObject({
      data: {
        enabled: true,
        state: 'on',
        url: 'https://rc.example.test/devices/d1/',
        device_id: 'd1',
        device_name: 'host',
      },
    });

    const invalid = await fetch(`${origin}/api/v1/remote-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":"yes"}',
    });
    expect(invalid.status).toBe(400);
    expect(await invalid.json()).toMatchObject({ code: 40001 });

    const disabled = await fetch(`${origin}/api/v1/remote-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":false}',
    });
    expect(disabled.status).toBe(200);
    expect(await disabled.json()).toMatchObject({ data: { enabled: false, state: 'off' } });
    expect(tunnel.close).toHaveBeenCalledTimes(1);

    const conflictStart = vi.fn(async () => {
      throw new RemoteControlAlreadyRunningError({
        pid: 123,
        nonce: 'n',
        localOrigin: 'http://127.0.0.1:4000',
        deviceId: 'd2',
        url: 'https://rc.example.test/devices/d2/',
        startedAt: 0,
      });
    });
    const conflict = createHarness({
      features: [
        createRemoteControl({
          homeDir: await makeTmp(),
          localOrigin: () => 'http://127.0.0.1:3000',
          localServerToken: () => 'local-token',
          clientVersion: 'kimi-code/test',
          start: conflictStart,
        }),
        createHttp(),
      ],
    });
    apps.push(conflict);
    await conflict.ready();
    const running = await fetch(`${conflict.resolve(HttpRef).origin}/api/v1/remote-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":true}',
    });
    expect(running.status).toBe(409);
    expect(await running.json()).toMatchObject({ code: 40928 });

    const bare = createHarness({ features: [createHttp()] });
    apps.push(bare);
    await bare.ready();
    const missing = await fetch(`${bare.resolve(HttpRef).origin}/api/v1/remote-control`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"enabled":true}',
    });
    expect(missing.status).toBe(409);
    expect(await missing.json()).toMatchObject({ code: 40937 });
  });
});
