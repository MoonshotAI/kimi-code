import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  buildRemoteControlUrl,
  filterForwardRequestHeaders,
  formatRemoteControlOutput,
  formatRemoteControlStatus,
  isRemoteControlEnabled,
  parseRawHttpRequest,
  rewriteRemoteControlResponse,
  startRemoteControl,
  type RemoteControlHandle,
} from '#/cli/sub/web/remote-control';
import { remoteControlLockPath } from '#/cli/sub/web/remote-control-lock';

const TOKEN: TokenInfo = {
  accessToken: 'access-token',
  refreshToken: 'refresh-token',
  expiresAt: 0,
  scope: '',
  tokenType: 'Bearer',
  expiresIn: 0,
};

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

describe('Remote Control experimental flag', () => {
  it('is off unless the per-feature env or the master switch is truthy', () => {
    expect(isRemoteControlEnabled({})).toBe(false);
    expect(isRemoteControlEnabled({ KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL: '0' })).toBe(false);
    expect(isRemoteControlEnabled({ KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL: '1' })).toBe(true);
    expect(isRemoteControlEnabled({ KIMI_CODE_EXPERIMENTAL_FLAG: 'true' })).toBe(true);
    expect(
      isRemoteControlEnabled({
        KIMI_CODE_EXPERIMENTAL_FLAG: '0',
        KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL: 'yes',
      }),
    ).toBe(true);
  });
});

describe('Remote Control URLs', () => {
  it('builds the public device entry without a local token', () => {
    const url = buildRemoteControlUrl('device/one');
    expect(url).toBe(
      'https://code-rc.kimi.com/devices/device%2Fone/?rc=1&from=kimi_code_cli',
    );
    expect(url).not.toContain('token');
  });

  it('builds an encoded session deep link before the query', () => {
    expect(buildRemoteControlUrl('device-1', 'session/a b')).toBe(
      'https://code-rc.kimi.com/devices/device-1/sessions/session%2Fa%20b?rc=1&from=kimi_code_cli',
    );
  });
});

describe('Remote Control output', () => {
  it('keeps the full URL clickable while showing a short link and the setup contract', () => {
    const url = 'https://example.test/devices/example-device/?rc=1&from=kimi_code_cli';
    const output = formatRemoteControlOutput({
      url,
      localOrigin: 'http://127.0.0.1:1234',
      deviceName: 'example-device',
      qrCode: 'QR\n',
      pngPath: '/tmp/example-qr.png',
    });
    expect(output).toContain('Use Kimi Code on this machine');
    expect(output).toContain('1.');
    expect(output).toContain('2.');
    expect(output).toContain('3.');
    expect(output).toContain('example.test/devices/exampl…vice/');
    expect(output).toContain(`\u001B]8;;${url}`);
    expect(output).toContain('Connected to example.test');
    expect(output).toContain('This device:');
    expect(output).toContain('max 5');
    expect(output).toContain('PNG:');
    expect(output).toContain('grants control of this machine');
    expect(output).toContain('docs');
    expect(output).toContain('feedback');
    expect(output).toContain('Logs: off');
    expect(output).not.toContain('stream-1');
  });

  it('formats relay and device lifecycle states', () => {
    expect(formatRemoteControlStatus('relay_connected').toLowerCase()).toContain('connected');
    expect(formatRemoteControlStatus('relay_disconnected')).toContain('disconnected');
    expect(formatRemoteControlStatus('device_connected').toLowerCase()).toContain('connected');
    expect(formatRemoteControlStatus('device_disconnected')).toContain('disconnected');
  });
});

describe('Remote Control HTTP forwarding', () => {
  it('parses raw requests and replaces relay credentials with local bearer auth', () => {
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

  it('rejects absolute-form and malformed request targets', () => {
    expect(() =>
      parseRawHttpRequest(Buffer.from('GET https://example.test/ HTTP/1.1\r\n\r\n')),
    ).toThrow(/request line/);
    expect(() => parseRawHttpRequest(Buffer.from('GET //example.test/ HTTP/1.1\r\n\r\n'))).toThrow(
      /request line/,
    );
  });

  it('rewrites HTML, JavaScript, and CSS under the device prefix', () => {
    const prefix = '/coding-relay/devices/device-1';
    const html = rewriteRemoteControlResponse(
      'text/html; charset=utf-8',
      Buffer.from('<html><head></head><body><script src="/boot.js"></script><a href="/x">x</a></body></html>'),
      prefix,
    ).toString();
    expect(html).toContain(`src="${prefix}/boot.js"`);
    expect(html).toContain(`href="${prefix}/x"`);
    expect(html).toContain("sessionStorage.setItem('kimi-desktop-server-origin',location.origin+p)");
    expect(html).toContain('history.pushState=w(history.pushState)');

    const js = rewriteRemoteControlResponse(
      'text/javascript',
      Buffer.from(
        'const a="/assets/a.js";const s="/sessions/";const p=function(e){return"/"+e};',
      ),
      prefix,
    ).toString();
    expect(js).toBe(
      `const a="${prefix}/assets/a.js";const s="${prefix}/sessions/";const p=function(e){return"${prefix}/"+e};`,
    );

    const css = rewriteRemoteControlResponse(
      'text/css',
      Buffer.from('.x{background:url(/assets/x.png)}'),
      prefix,
    ).toString();
    expect(css).toBe(`.x{background:url(${prefix}/assets/x.png)}`);
  });
});

describe('Remote Control tunnel', () => {
  it('surfaces register_nak details', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-rc-nak-'));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
      TOKEN,
    );
    const managementServer = new WebSocketServer({ noServer: true });
    const relayServer = createServer();
    managementServer.on('connection', (ws) => {
      ws.once('message', () => {
        ws.send(
          JSON.stringify({
            type: 'register_nak',
            payload: {
              error_code: 'DEVICE_LIMIT_EXCEEDED',
              error_message: 'membership allows 3 devices',
            },
          }),
        );
      });
    });
    relayServer.on('upgrade', (request, socket, head) => {
      managementServer.handleUpgrade(request, socket, head, (ws) =>
        managementServer.emit('connection', ws, request),
      );
    });
    const relayPort = await listen(relayServer);
    cleanups.push(() => closeServer(relayServer));

    await expect(
      startRemoteControl({
        homeDir,
        localOrigin: 'http://127.0.0.1:1',
        localServerToken: 'local-server-token',
        relayOrigin: `http://127.0.0.1:${relayPort}/coding-relay`,
        stderr: { write: () => true },
      }),
    ).rejects.toThrow(/DEVICE_LIMIT_EXCEEDED.*membership allows 3 devices/);
  });

  it('uses only Authorization when the refresh token is not a valid subprotocol token', async () => {
    const homeDir = await createRemoteControlHome('invalid/token=');
    const relay = await startAuthRelay();
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relay.port}/coding-relay`,
      stderr: { write: () => true },
    });

    expect(relay.requests).toHaveLength(2);
    expect(relay.requests.every((request) => request.protocol === undefined)).toBe(true);
    expect(relay.requests.every((request) => request.authorization === 'Bearer invalid/token=')).toBe(
      true,
    );
  });

  it('retries with only Authorization when the server does not echo the subprotocol', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay({ echoProtocol: false });
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relay.port}/coding-relay`,
      stderr: { write: () => true },
    });

    expect(relay.requests.some((request) => request.protocol?.startsWith('kimi-code.bearer.'))).toBe(
      true,
    );
    expect(
      relay.requests.some(
        (request) =>
          request.protocol === undefined &&
          request.authorization === `Bearer ${TOKEN.refreshToken}`,
      ),
    ).toBe(true);
  });

  it('keeps the initial start pending through transient failures and recovers', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay({ rejectUpgrades: 2 });
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relay.port}/coding-relay`,
      stderr: { write: () => true },
    });

    expect(relay.requests.length).toBeGreaterThanOrEqual(4);
    expect(handle.url).toContain('?rc=1&from=kimi_code_cli');
  }, 6000);

  it('reconnects when management closes during the HTTP tunnel handshake', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay({ closeManagementDuringFirstHttpHandshake: true });
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relay.port}/coding-relay`,
      stderr: { write: () => true },
    });

    expect(relay.requests.length).toBeGreaterThanOrEqual(4);
  }, 6000);

  it('registers, forwards HTTP and WS with local auth, then reconnects the pair', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-rc-'));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
      TOKEN,
    );

    let localHttpRequest: IncomingMessage | undefined;
    let localWsRequest: IncomingMessage | undefined;
    const localWsServer = new WebSocketServer({ noServer: true });
    const localServer = createServer((request, response) => {
      localHttpRequest = request;
      response.writeHead(200, {
        'Content-Type': 'text/html',
        'Cache-Control': 'public, max-age=31536000, immutable',
        Connection: 'X-Remove',
        'X-Remove': 'gone',
      });
      response.end('<html><head></head><script src="/boot.js"></script></html>');
    });
    localServer.on('upgrade', (request, socket, head) => {
      localWsRequest = request;
      localWsServer.handleUpgrade(request, socket, head, (ws) => localWsServer.emit('connection', ws, request));
    });
    const localPort = await listen(localServer);
    cleanups.push(() => closeServer(localServer));

    const managementServer = new WebSocketServer({ noServer: true });
    const httpTunnelServer = new WebSocketServer({ noServer: true });
    const streamServer = new WebSocketServer({ noServer: true });
    const relayServer = createServer();
    const managementConnections: WebSocket[] = [];
    const httpConnections: WebSocket[] = [];
    const streamConnections: WebSocket[] = [];
    const registrations: unknown[] = [];
    const managementMessages: unknown[] = [];
    const streamMessages: string[] = [];
    let localWs: WebSocket | undefined;

    managementServer.on('connection', (ws) => {
      managementConnections.push(ws);
      ws.on('message', (data) => {
        const message = JSON.parse(rawDataText(data)) as { type: string };
        managementMessages.push(message);
        if (message.type === 'register') {
          registrations.push(message);
          ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
        }
      });
    });
    httpTunnelServer.on('connection', (ws) => httpConnections.push(ws));
    streamServer.on('connection', (ws) => {
      streamConnections.push(ws);
      ws.on('message', (data) => streamMessages.push(rawDataText(data)));
    });
    localWsServer.on('connection', (ws) => {
      localWs = ws;
      ws.send('server-hello-frame');
    });
    relayServer.on('upgrade', (request, socket, head) => {
      const pathname = new URL(request.url!, 'http://relay.test').pathname;
      const target = pathname.endsWith('/v1/remote/create')
        ? managementServer
        : pathname.endsWith('/v1/remote/http')
          ? httpTunnelServer
          : streamServer;
      target.handleUpgrade(request, socket, head, (ws) => target.emit('connection', ws, request));
    });
    const relayPort = await listen(relayServer);
    cleanups.push(() => closeServer(relayServer));

    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());
    handle = await startRemoteControl({
      homeDir,
      localOrigin: `http://127.0.0.1:${localPort}`,
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relayPort}/coding-relay`,
      stderr: { write: () => true },
    });

    expect(registrations).toHaveLength(1);
    expect(handle.url).toContain('/coding-relay/devices/');
    expect(handle.url).toContain('?rc=1&from=kimi_code_cli');

    const rawRequest = Buffer.from(
      'GET / HTTP/1.1\r\nHost: relay.test\r\nAuthorization: Bearer relay-token\r\nCookie: sid=1\r\nOrigin: https://relay.test\r\nConnection: X-Hop\r\nX-Hop: remove\r\nX-Keep: yes\r\n\r\n',
    );
    const splitAt = Math.floor(rawRequest.length / 2);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-1',
        type: 'request',
        is_last: false,
        body_base64: rawRequest.subarray(0, splitAt).toString('base64'),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(localHttpRequest).toBeUndefined();
    const responsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-1',
        type: 'request',
        is_last: true,
        body_base64: rawRequest.subarray(splitAt).toString('base64'),
      }),
    );
    const responseMessage = await responsePromise;
    const response = Buffer.from(responseMessage['body_base64'] as string, 'base64').toString();
    expect(response).toContain('HTTP/1.1 200 OK');
    expect(localHttpRequest?.headers.authorization).toBe('Bearer local-server-token');
    expect(localHttpRequest?.headers.cookie).toBeUndefined();
    expect(localHttpRequest?.headers.origin).toBeUndefined();
    expect(localHttpRequest?.headers['x-hop']).toBeUndefined();
    expect(localHttpRequest?.headers['x-keep']).toBe('yes');
    expect(response).not.toContain('X-Remove');
    expect(response).not.toContain('immutable');
    expect(response).toContain('Cache-Control: no-cache');
    expect(response).toContain(`/coding-relay/devices/${handle.deviceId}/boot.js`);

    managementConnections[0]!.send(
      JSON.stringify({
        type: 'open_ws',
        payload: {
          stream_id: 'stream-1',
          path: '/api/v1/ws',
          headers: { Cookie: 'relay-cookie', Origin: 'https://relay.test', 'X-Keep': 'yes' },
        },
      }),
    );
    await waitFor(() => streamConnections.length === 1 && localWs !== undefined);
    expect(localWsRequest?.headers['sec-websocket-protocol']).toBe(
      'kimi-code.bearer.local-server-token',
    );
    expect(localWsRequest?.headers.authorization).toBeUndefined();
    expect(localWsRequest?.headers.cookie).toBeUndefined();
    expect(localWsRequest?.headers.origin).toBeUndefined();
    expect(localWsRequest?.headers['x-keep']).toBe('yes');
    await waitFor(() =>
      managementMessages.some(
        (value) =>
          (value as { type?: string }).type === 'open_ws_result' &&
          (value as { payload?: { success?: boolean } }).payload?.success === true,
      ),
    );

    await waitFor(() => streamMessages.includes('server-hello-frame'));
    const localMessage = nextTextMessage(localWs!);
    streamConnections[0]!.send('from-relay');
    await expect(localMessage).resolves.toBe('from-relay');
    const relayMessage = nextTextMessage(streamConnections[0]!);
    localWs!.send('from-local');
    await expect(relayMessage).resolves.toBe('from-local');

    streamConnections[0]!.terminate();
    await waitFor(() => localWs?.readyState === 3);

    httpConnections[0]!.terminate();
    await waitFor(() => registrations.length === 2 && httpConnections.length === 2, 4000);

    await handle.close();
    await waitFor(() =>
      managementMessages.some(
        (value) =>
          (value as { type?: string; payload?: { reason?: string } }).type === 'disconnect' &&
          (value as { payload?: { reason?: string } }).payload?.reason === 'local_server_stopped',
      ),
    );
  });
});

describe('Remote Control single-instance lock', () => {
  async function deadPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' });
    await new Promise<void>((resolve) => child.on('exit', () => resolve()));
    return child.pid!;
  }

  it('refuses a second instance on the same home and reports the running link', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    let first: RemoteControlHandle | undefined;
    cleanups.push(async () => first?.close());
    first = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });

    await expect(
      startRemoteControl({
        homeDir,
        localOrigin: 'http://127.0.0.1:58628',
        localServerToken: 'local-server-token',
        relayOrigin: `http://127.0.0.1:${relay.port}`,
        stderr: { write: () => true },
      }),
    ).rejects.toThrow(/already running[\s\S]*127\.0\.0\.1:58627[\s\S]*\/devices\//);
    expect(relay.requests).toHaveLength(2);
  });

  it('reaps a stale lock left by a dead process', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    await mkdir(join(homeDir, 'server'), { recursive: true });
    await writeFile(
      remoteControlLockPath(homeDir),
      JSON.stringify({
        pid: await deadPid(),
        nonce: 'stale',
        local_origin: 'http://127.0.0.1:1',
        device_id: 'dead-device',
        url: 'https://code-rc.kimi.com/devices/dead-device/',
        started_at: 0,
      }),
    );
    const relay = await startAuthRelay();
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });

    const lock = JSON.parse(await readFile(remoteControlLockPath(homeDir), 'utf8')) as {
      pid: number;
    };
    expect(lock.pid).toBe(process.pid);
  });

  it('releases the lock on close so a new instance can start', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    const options = {
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    };
    const first = await startRemoteControl(options);
    await first.close();

    let second: RemoteControlHandle | undefined;
    cleanups.push(async () => second?.close());
    second = await startRemoteControl(options);
    expect(second.url).toContain('/devices/');
  });

  it('does not remove a successor lock when closing', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    const handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });
    cleanups.push(async () => handle?.close());
    await writeFile(
      remoteControlLockPath(homeDir),
      JSON.stringify({
        pid: process.pid,
        nonce: 'successor',
        local_origin: 'http://127.0.0.1:58628',
        device_id: 'device-2',
        url: 'https://code-rc.kimi.com/devices/device-2/',
        started_at: Date.now(),
      }),
    );

    await handle.close();

    const lock = JSON.parse(await readFile(remoteControlLockPath(homeDir), 'utf8')) as {
      nonce: string;
    };
    expect(lock.nonce).toBe('successor');
  });
});

async function createRemoteControlHome(refreshToken: string): Promise<string> {
  const homeDir = mkdtempSync(join(tmpdir(), 'kimi-rc-auth-'));
  cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
  await new FileTokenStorage(join(homeDir, 'credentials')).save(
    resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
    {
      ...TOKEN,
      refreshToken,
    },
  );
  return homeDir;
}

async function startAuthRelay(
  options: {
    echoProtocol?: boolean;
    rejectUpgrades?: number;
    closeManagementDuringFirstHttpHandshake?: boolean;
  } = {},
): Promise<{
  port: number;
  requests: Array<{ authorization?: string; protocol?: string }>;
}> {
  const handleProtocols = options.echoProtocol === false ? (): false => false : undefined;
  const managementServer = new WebSocketServer({ noServer: true, handleProtocols });
  const httpTunnelServer = new WebSocketServer({ noServer: true, handleProtocols });
  const relayServer = createServer();
  const requests: Array<{ authorization?: string; protocol?: string }> = [];
  let remainingRejections = options.rejectUpgrades ?? 0;
  let closeManagement = options.closeManagementDuringFirstHttpHandshake === true;
  let delayHttpUpgrade = closeManagement;

  managementServer.on('connection', (ws) => {
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const message = JSON.parse(rawDataText(data)) as { type?: string };
      if (message.type === 'register') {
        ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
        if (closeManagement) {
          closeManagement = false;
          setTimeout(() => ws.close(), 10);
        }
      }
    });
  });
  httpTunnelServer.on('connection', (ws) => ws.on('error', () => {}));
  relayServer.on('upgrade', (request, socket, head) => {
    const authorization = request.headers.authorization;
    const protocol = request.headers['sec-websocket-protocol'];
    requests.push({
      authorization: Array.isArray(authorization) ? authorization[0] : authorization,
      protocol: Array.isArray(protocol) ? protocol[0] : protocol,
    });
    if (remainingRejections > 0) {
      remainingRejections -= 1;
      socket.end(
        'HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n',
      );
      return;
    }
    const pathname = new URL(request.url!, 'http://relay.test').pathname;
    const target = pathname.endsWith('/v1/remote/create')
      ? managementServer
      : httpTunnelServer;
    const upgrade = (): void => {
      target.handleUpgrade(request, socket, head, (ws) => target.emit('connection', ws, request));
    };
    if (target === httpTunnelServer && delayHttpUpgrade) {
      delayHttpUpgrade = false;
      setTimeout(upgrade, 50);
      return;
    }
    upgrade();
  });
  const port = await listen(relayServer);
  cleanups.push(() => closeServer(relayServer));
  return { port, requests };
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') reject(new Error('missing address'));
      else resolve(address.port);
    });
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error === undefined) resolve();
      else reject(error);
    });
  });
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function nextJsonMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(JSON.parse(rawDataText(data)) as Record<string, unknown>));
  });
}

function nextTextMessage(socket: WebSocket): Promise<string> {
  return new Promise((resolve) => {
    socket.once('message', (data) => resolve(rawDataText(data)));
  });
}

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
