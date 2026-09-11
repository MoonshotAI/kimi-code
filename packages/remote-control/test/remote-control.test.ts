import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  buildRemoteControlUrl,
  filterForwardRequestHeaders,
  parseRawHttpRequest,
  resolveRemoteControlRelayOrigin,
  rewriteRemoteControlResponse,
  startRemoteControl,
  type RemoteControlHandle,
} from '../src/remote-control';
import { remoteControlLockPath } from '../src/lock';

const CLIENT_VERSION = 'kimi-code/test';

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
  vi.unstubAllEnvs();
  while (cleanups.length > 0) await cleanups.pop()!();
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

  it('falls back to the default relay origin when the env is unset or blank', () => {
    expect(resolveRemoteControlRelayOrigin({})).toBe('https://code-rc.kimi.com');
    expect(
      resolveRemoteControlRelayOrigin({ KIMI_CODE_REMOTE_CONTROL_RELAY_URL: '  ' }),
    ).toBe('https://code-rc.kimi.com');
  });

  it('builds device URLs from the relay origin env override', () => {
    vi.stubEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', 'https://rc.example.test/coding-relay/');
    expect(resolveRemoteControlRelayOrigin()).toBe('https://rc.example.test/coding-relay/');
    expect(buildRemoteControlUrl('device-1')).toBe(
      'https://rc.example.test/coding-relay/devices/device-1/?rc=1&from=kimi_code_cli',
    );
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
        clientVersion: CLIENT_VERSION,
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
      clientVersion: CLIENT_VERSION,
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
      clientVersion: CLIENT_VERSION,
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
      clientVersion: CLIENT_VERSION,
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
      clientVersion: CLIENT_VERSION,
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
    let localHttpBodyBytes = 0;
    let localWsRequest: IncomingMessage | undefined;
    const localWsServer = new WebSocketServer({ noServer: true });
    const assetJs = `const boot = "/assets/boot.js";\n${'const chunk = "/assets/chunk.js";\n'.repeat(120)}`;
    const assetPng = Buffer.alloc(4096, 7);
    const assetSvg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="100" height="100"/>'.repeat(100)}</svg>`;
    const assetText = 'chunk of text\n'.repeat(160);
    const localServer = createServer((request, response) => {
      localHttpRequest = request;
      if (request.url === '/assets/index.js') {
        response.writeHead(200, { 'Content-Type': 'text/javascript', ETag: '"v1"' });
        response.end(assetJs);
        return;
      }
      if (request.url === '/assets/logo.png') {
        response.writeHead(200, { 'Content-Type': 'image/png' });
        response.end(assetPng);
        return;
      }
      if (request.url === '/assets/logo.svg') {
        response.writeHead(200, {
          'Content-Type': 'image/svg+xml',
          'Cache-Control': 'public, max-age=31536000, immutable',
        });
        response.end(assetSvg);
        return;
      }
      if (request.url === '/assets/partial.txt' && request.headers.range !== undefined) {
        response.writeHead(206, {
          'Content-Type': 'text/plain',
          'Content-Range': 'bytes 0-2047/4096',
        });
        response.end(assetText);
        return;
      }
      let bodyBytes = 0;
      request.on('data', (chunk: Buffer) => {
        bodyBytes += chunk.length;
      });
      request.on('end', () => {
        localHttpBodyBytes = bodyBytes;
        response.writeHead(200, {
          'Content-Type': 'text/html',
          'Cache-Control': 'public, max-age=31536000, immutable',
          Connection: 'X-Remove',
          'X-Remove': 'gone',
        });
        response.end('<html><head></head><script src="/boot.js"></script></html>');
      });
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
    let currentToken = 'local-server-token';
    handle = await startRemoteControl({
      homeDir,
      localOrigin: `http://127.0.0.1:${localPort}`,
      localServerToken: () => currentToken,
      clientVersion: CLIENT_VERSION,
      relayOrigin: `http://127.0.0.1:${relayPort}/coding-relay`,
      stderr: { write: () => true },
    });

    expect(registrations).toHaveLength(1);
    expect(handle.url).toContain('/coding-relay/devices/');
    expect(handle.url).toContain('?rc=1&from=kimi_code_cli');

    const rawRequest = Buffer.from(
      'GET / HTTP/1.1\r\nHost: relay.test\r\nAuthorization: Bearer relay-token\r\nCookie: sid=1\r\nOrigin: https://relay.test\r\nAccept-Encoding: gzip\r\nConnection: X-Hop\r\nX-Hop: remove\r\nX-Keep: yes\r\n\r\n',
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
    expect(response).not.toContain('Content-Encoding');
    expect(response).not.toContain('Vary');
    expect(localHttpRequest?.headers['accept-encoding']).toBeUndefined();
    expect(response).toContain('Cache-Control: no-cache');
    expect(response).toContain(`/coding-relay/devices/${handle.deviceId}/boot.js`);

    currentToken = 'rotated-server-token';
    const rotatedResponsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-2',
        type: 'request',
        is_last: true,
        body_base64: rawRequest.toString('base64'),
      }),
    );
    await rotatedResponsePromise;
    await waitFor(() => localHttpRequest?.headers.authorization === 'Bearer rotated-server-token');

    const gzipResponsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-3',
        type: 'request',
        is_last: true,
        body_base64: Buffer.from(
          'GET /assets/index.js HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: br, gzip\r\n\r\n',
        ).toString('base64'),
      }),
    );
    const gzipResponse = Buffer.from(
      (await gzipResponsePromise)['body_base64'] as string,
      'base64',
    );
    const gzipSeparator = gzipResponse.indexOf('\r\n\r\n');
    const gzipHead = gzipResponse.subarray(0, gzipSeparator).toString('latin1');
    const gzipBody = gzipResponse.subarray(gzipSeparator + 4);
    expect(gzipHead).toContain('HTTP/1.1 200 OK');
    expect(gzipHead).toContain('Content-Encoding: gzip');
    expect(gzipHead).toContain('Vary: Accept-Encoding');
    expect(gzipHead).toContain('Cache-Control: no-cache');
    const rewrittenETag = /ETag: (W\/"[0-9a-f]{64}")/.exec(gzipHead)?.[0];
    expect(rewrittenETag).toBeDefined();
    expect(gzipHead).toContain(`Content-Length: ${gzipBody.length}`);
    expect(gunzipSync(gzipBody).toString()).toBe(
      assetJs.replaceAll('"/assets/', `"/coding-relay/devices/${handle.deviceId}/assets/`),
    );

    const revalidateResponsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-3b',
        type: 'request',
        is_last: true,
        body_base64: Buffer.from(
          `GET /assets/index.js HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: br, gzip\r\nIf-None-Match: ${rewrittenETag!.replace('ETag: ', '')}\r\n\r\n`,
        ).toString('base64'),
      }),
    );
    const revalidateResponse = Buffer.from(
      (await revalidateResponsePromise)['body_base64'] as string,
      'base64',
    );
    const revalidateHead = revalidateResponse
      .subarray(0, revalidateResponse.indexOf('\r\n\r\n'))
      .toString('latin1');
    expect(revalidateHead).toContain('HTTP/1.1 304 Not Modified');
    expect(revalidateHead).toContain('Cache-Control: no-cache');
    expect(revalidateHead).toContain(rewrittenETag!);
    expect(revalidateHead).not.toContain('Content-Encoding');
    expect(revalidateHead).not.toContain('Content-Length');

    const binaryResponsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-4',
        type: 'request',
        is_last: true,
        body_base64: Buffer.from(
          'GET /assets/logo.png HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: gzip\r\n\r\n',
        ).toString('base64'),
      }),
    );
    const binaryResponse = Buffer.from(
      (await binaryResponsePromise)['body_base64'] as string,
      'base64',
    );
    const binarySeparator = binaryResponse.indexOf('\r\n\r\n');
    expect(binaryResponse.subarray(0, binarySeparator).toString('latin1')).not.toContain(
      'Content-Encoding',
    );
    expect(binaryResponse.subarray(binarySeparator + 4).equals(assetPng)).toBe(true);

    const excludedResponsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-5',
        type: 'request',
        is_last: true,
        body_base64: Buffer.from(
          'GET /assets/index.js HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: gzip;q=0, *;q=1\r\n\r\n',
        ).toString('base64'),
      }),
    );
    const excludedResponse = Buffer.from(
      (await excludedResponsePromise)['body_base64'] as string,
      'base64',
    );
    const excludedSeparator = excludedResponse.indexOf('\r\n\r\n');
    const excludedHead = excludedResponse.subarray(0, excludedSeparator).toString('latin1');
    expect(excludedHead).not.toContain('Content-Encoding');
    expect(excludedHead).toContain('Vary: Accept-Encoding');
    expect(excludedHead).toContain(rewrittenETag!);
    expect(excludedHead).not.toContain('ETag: "v1"');
    expect(excludedResponse.subarray(excludedSeparator + 4).toString()).toBe(
      assetJs.replaceAll('"/assets/', `"/coding-relay/devices/${handle.deviceId}/assets/`),
    );

    const svgResponsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-6',
        type: 'request',
        is_last: true,
        body_base64: Buffer.from(
          'GET /assets/logo.svg HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: gzip\r\n\r\n',
        ).toString('base64'),
      }),
    );
    const svgResponse = Buffer.from((await svgResponsePromise)['body_base64'] as string, 'base64');
    const svgSeparator = svgResponse.indexOf('\r\n\r\n');
    const svgHead = svgResponse.subarray(0, svgSeparator).toString('latin1');
    expect(svgHead).toContain('Content-Encoding: gzip');
    expect(svgHead).toContain('Vary: Accept-Encoding');
    expect(svgHead).toContain('immutable');
    expect(gunzipSync(svgResponse.subarray(svgSeparator + 4)).toString()).toBe(assetSvg);

    const rangeResponsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-7',
        type: 'request',
        is_last: true,
        body_base64: Buffer.from(
          'GET /assets/partial.txt HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: gzip\r\nRange: bytes=0-2047\r\n\r\n',
        ).toString('base64'),
      }),
    );
    const rangeResponse = Buffer.from(
      (await rangeResponsePromise)['body_base64'] as string,
      'base64',
    );
    const rangeSeparator = rangeResponse.indexOf('\r\n\r\n');
    const rangeHead = rangeResponse.subarray(0, rangeSeparator).toString('latin1');
    expect(rangeHead).toContain('206');
    expect(rangeHead).toContain('Content-Range: bytes 0-2047/4096');
    expect(rangeHead).not.toContain('Content-Encoding');
    expect(rangeResponse.subarray(rangeSeparator + 4).toString()).toBe(assetText);

    const largeBody = Buffer.alloc(4 * 1024 * 1024 + 512 * 1024, 0x61);
    const largeRequest = Buffer.concat([
      Buffer.from(`POST /upload HTTP/1.1\r\nHost: relay.test\r\nContent-Length: ${largeBody.length}\r\n\r\n`),
      largeBody,
    ]);
    const largeResponsePromise = nextJsonMessage(httpConnections[0]!);
    httpConnections[0]!.send(
      JSON.stringify({
        request_id: 'request-8',
        type: 'request',
        is_last: true,
        body_base64: largeRequest.toString('base64'),
      }),
    );
    const largeResponseMessage = await largeResponsePromise;
    const largeResponse = Buffer.from(largeResponseMessage['body_base64'] as string, 'base64').toString();
    expect(largeResponse).toContain('HTTP/1.1 200 OK');
    expect(localHttpBodyBytes).toBe(largeBody.length);

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
      'kimi-code.bearer.rotated-server-token',
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

  it('reconnects when the relay goes silent without closing the sockets', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());
    let logs = '';

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 'local-server-token',
      clientVersion: CLIENT_VERSION,
      relayOrigin: `http://127.0.0.1:${relay.port}/coding-relay`,
      stderr: { write: (text) => ((logs += String(text)), true) },
      pingIntervalMs: 50,
      silenceTimeoutMs: 300,
    });

    expect(relay.registrations).toHaveLength(1);
    relay.managementSockets[0]!.pause();
    relay.httpSockets[0]!.pause();

    await waitFor(() => relay.registrations.length === 2, 10_000);
    expect(logs).toContain('silent');
    relay.managementSockets[0]!.terminate();
    relay.httpSockets[0]!.terminate();
  }, 15_000);

  it('retries when registration is rejected after a reconnect', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay({ nakRegistrationsAfterFirst: 1 });
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());
    let logs = '';

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 'local-server-token',
      clientVersion: CLIENT_VERSION,
      relayOrigin: `http://127.0.0.1:${relay.port}/coding-relay`,
      stderr: { write: (text) => ((logs += String(text)), true) },
    });

    expect(relay.registrations).toHaveLength(1);
    relay.managementSockets[0]!.terminate();
    relay.httpSockets[0]!.terminate();

    await waitFor(() => relay.registrations.length >= 3, 10_000);
    await waitFor(
      () => relay.managementSockets.some((socket) => socket.readyState === 1) &&
        relay.httpSockets.some((socket) => socket.readyState === 1),
    );
    expect(logs).toContain('DEPLOYING');
    expect(handle.url).toContain('?rc=1&from=kimi_code_cli');
  }, 15_000);
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
      clientVersion: CLIENT_VERSION,
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });

    await expect(
      startRemoteControl({
        homeDir,
        localOrigin: 'http://127.0.0.1:58628',
        localServerToken: 'local-server-token',
        clientVersion: CLIENT_VERSION,
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
      clientVersion: CLIENT_VERSION,
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });

    const lock = JSON.parse(await readFile(remoteControlLockPath(homeDir), 'utf8')) as {
      pid: number;
    };
    expect(lock.pid).toBe(process.pid);
  });

  it('releases the lock on close and on relay-initiated shutdown', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    const options = {
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      clientVersion: CLIENT_VERSION,
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    };
    const first = await startRemoteControl(options);
    await first.close();

    let second: RemoteControlHandle | undefined;
    cleanups.push(async () => second?.close());
    second = await startRemoteControl(options);
    expect(second.url).toContain('/devices/');

    relay.managementSockets[relay.managementSockets.length - 1]!.send(
      JSON.stringify({ type: 'disconnect', payload: { reason: 'user_requested' } }),
    );
    await second.closed;
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
  });

  it('does not remove a successor lock when closing', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    const handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      clientVersion: CLIENT_VERSION,
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
    nakRegistrationsAfterFirst?: number;
  } = {},
): Promise<{
  port: number;
  requests: Array<{ authorization?: string; protocol?: string }>;
  registrations: unknown[];
  managementSockets: WebSocket[];
  httpSockets: WebSocket[];
}> {
  const handleProtocols = options.echoProtocol === false ? (): false => false : undefined;
  const managementServer = new WebSocketServer({ noServer: true, handleProtocols });
  const httpTunnelServer = new WebSocketServer({ noServer: true, handleProtocols });
  const relayServer = createServer();
  const requests: Array<{ authorization?: string; protocol?: string }> = [];
  const registrations: unknown[] = [];
  const managementSockets: WebSocket[] = [];
  const httpSockets: WebSocket[] = [];
  let remainingRejections = options.rejectUpgrades ?? 0;
  let closeManagement = options.closeManagementDuringFirstHttpHandshake === true;
  let delayHttpUpgrade = closeManagement;
  let pendingNaks = options.nakRegistrationsAfterFirst ?? 0;

  managementServer.on('connection', (ws) => {
    managementSockets.push(ws);
    ws.on('error', () => {});
    ws.on('message', (data) => {
      const message = JSON.parse(rawDataText(data)) as { type?: string };
      if (message.type === 'register') {
        const isReconnectRegistration = registrations.length > 0;
        registrations.push(message);
        if (isReconnectRegistration && pendingNaks > 0) {
          pendingNaks -= 1;
          ws.send(
            JSON.stringify({
              type: 'register_nak',
              payload: {
                error_code: 'DEPLOYING',
                error_message: 'relay is restarting',
              },
            }),
          );
          return;
        }
        ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
        if (closeManagement) {
          closeManagement = false;
          setTimeout(() => ws.close(), 10);
        }
      }
    });
  });
  httpTunnelServer.on('connection', (ws) => {
    httpSockets.push(ws);
    ws.on('error', () => {});
  });
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
  return { port, requests, registrations, managementSockets, httpSockets };
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
