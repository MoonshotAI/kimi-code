import { createServer, type IncomingMessage } from 'node:http';
import { spawn } from 'node:child_process';
import type { Duplex } from 'node:stream';
import { existsSync, chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { mkdir, chmod, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

import {
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiCodeOAuthRef,
  resolveKimiTokenStorageName,
  type TokenInfo,
} from '@moonshot-ai/kimi-code-oauth';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer, type RawData, type WebSocket } from 'ws';

import {
  buildRemoteControlUrl,
  filterForwardRequestHeaders,
  HttpTunnel,
  parseRawHttpRequest,
  resolveRemoteControlRelayOrigin,
  rewriteRemoteControlResponse,
  startRemoteControl,
  type HttpTunnelLimits,
  type RemoteControlHandle,
} from '../src/remote-control';
import { RemoteControlDeviceClient } from '../src/device-client';
import { remoteControlLockPath } from '../src/lock';
import { createRemoteControlManager } from '../src/manager';

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
    const url = buildRemoteControlUrl(
      'device/one',
      undefined,
      'https://code-rc.kimi.com',
      'kimi_code_cli',
    );
    expect(url).toBe(
      'https://code-rc.kimi.com/devices/device%2Fone/?rc=1&from=kimi_code_cli',
    );
    expect(url).not.toContain('token');
  });

  it('builds an encoded session deep link before the query', () => {
    expect(
      buildRemoteControlUrl('device-1', 'session/a b', 'https://code-rc.kimi.com', 'kimi_code_cli'),
    ).toBe(
      'https://code-rc.kimi.com/devices/device-1/sessions/session%2Fa%20b?rc=1&from=kimi_code_cli',
    );
  });

  it('tags the public URL with the caller-provided source', () => {
    expect(
      buildRemoteControlUrl(
        'device-1',
        undefined,
        'https://code-rc.kimi.com',
        'kimi_code_desktop',
      ),
    ).toBe('https://code-rc.kimi.com/devices/device-1/?rc=1&from=kimi_code_desktop');
  });

  it('falls back to the default relay origin when the env is unset or blank', () => {
    expect(resolveRemoteControlRelayOrigin({})).toBe('https://code-rc.kimi.com');
    expect(
      resolveRemoteControlRelayOrigin({ KIMI_CODE_REMOTE_CONTROL_RELAY_URL: '  ' }),
    ).toBe('https://code-rc.kimi.com');
    expect(resolveRemoteControlRelayOrigin({}, 'https://code-rc.kimi.ai')).toBe(
      'https://code-rc.kimi.ai',
    );
  });

  it('builds device URLs from the relay origin env override', () => {
    vi.stubEnv('KIMI_CODE_REMOTE_CONTROL_RELAY_URL', 'https://rc.example.test/coding-relay/');
    expect(resolveRemoteControlRelayOrigin()).toBe('https://rc.example.test/coding-relay/');
    expect(
      buildRemoteControlUrl('device-1', undefined, resolveRemoteControlRelayOrigin(), 'kimi_code_cli'),
    ).toBe(
      'https://rc.example.test/coding-relay/devices/device-1/?rc=1&from=kimi_code_cli',
    );
  });
});

describe('Remote Control HTTP forwarding', () => {
  it('parses raw requests and replaces relay credentials with local bearer auth', () => {
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
  });

  it('rejects absolute-form and malformed request targets', () => {
    expect(() =>
      parseRawHttpRequest([Buffer.from('GET https://example.test/ HTTP/1.1\r\n\r\n')]),
    ).toThrow(/request line/);
    expect(() => parseRawHttpRequest([Buffer.from('GET //example.test/ HTTP/1.1\r\n\r\n')])).toThrow(
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
        urlSource: 'kimi_code_cli',
        relayOrigin: `http://127.0.0.1:${relayPort}/coding-relay`,
        stderr: { write: () => true },
      }),
    ).rejects.toThrow(/DEVICE_LIMIT_EXCEEDED.*membership allows 3 devices/);
  });

  it('uses only Authorization when the refresh token is not a valid subprotocol token', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-rc-auth-'));
    cleanups.push(() => rmSync(homeDir, { recursive: true, force: true }));
    const oauthRef = resolveKimiCodeOAuthRef({
      oauthHost: 'https://auth.kimi.ai',
      baseUrl: 'https://api.kimi.ai/coding/v1',
    });
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ oauthKey: oauthRef.key }),
      { ...TOKEN, refreshToken: 'invalid/token=' },
    );
    const relay = await startAuthRelay();
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:1',
      localServerToken: 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      configuredOAuthKey: oauthRef.key,
      configuredOAuthHost: oauthRef.oauthHost,
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
      urlSource: 'kimi_code_cli',
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
      urlSource: 'kimi_code_cli',
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
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${relay.port}/coding-relay`,
      stderr: { write: () => true },
    });

    expect(relay.requests.length).toBeGreaterThanOrEqual(4);
  }, 6000);

  it('registers, forwards HTTP with local auth, and rewrites the response', async () => {
    const scenario = await startTunnelScenario();

    expect(scenario.registrations).toHaveLength(1);
    expect(scenario.httpCapabilities).toEqual(['request_chunk,response_chunk,abort']);
    expect(
      (scenario.registrations[0] as { payload?: Record<string, unknown> }).payload,
    ).not.toHaveProperty('capabilities');
    expect(scenario.handle.url).toContain('/coding-relay/devices/');
    expect(scenario.handle.url).toContain('?rc=1&from=kimi_code_cli');

    const rawRequest = probeRawRequest();
    const splitAt = Math.floor(rawRequest.length / 2);
    scenario.httpConnections[0]!.send(tunnelRequestFrame('request-1', rawRequest.subarray(0, splitAt), false));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scenario.state.localHttpRequest).toBeUndefined();
    const responsePromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(tunnelRequestFrame('request-1', rawRequest.subarray(splitAt), true));
    const responseMessage = await responsePromise;
    const response = frameBody(responseMessage).toString();
    expect(response).toContain('HTTP/1.1 200 OK');
    expect(scenario.state.localHttpRequest?.headers.authorization).toBe('Bearer local-server-token');
    expect(scenario.state.localHttpRequest?.headers.cookie).toBeUndefined();
    expect(scenario.state.localHttpRequest?.headers.origin).toBeUndefined();
    expect(scenario.state.localHttpRequest?.headers['x-hop']).toBeUndefined();
    expect(scenario.state.localHttpRequest?.headers['x-keep']).toBe('yes');
    expect(response).not.toContain('X-Remove');
    expect(response).not.toContain('immutable');
    expect(response).not.toContain('Content-Encoding');
    expect(response).not.toContain('Vary');
    expect(scenario.state.localHttpRequest?.headers['accept-encoding']).toBeUndefined();
    expect(response).toContain('Cache-Control: no-cache');
    expect(response).toContain(`/coding-relay/devices/${scenario.handle.deviceId}/boot.js`);
  });

  it('re-reads the local server token on every forwarded request', async () => {
    let currentToken = 'local-server-token';
    const scenario = await startTunnelScenario({ localServerToken: () => currentToken });
    const rawRequest = probeRawRequest();

    const firstResponsePromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(tunnelRequestFrame('request-1', rawRequest, true));
    await firstResponsePromise;
    await waitFor(
      () => scenario.state.localHttpRequest?.headers.authorization === 'Bearer local-server-token',
    );
    expect(scenario.state.localHttpRequest?.headers.authorization).toBe(
      'Bearer local-server-token',
    );

    currentToken = 'rotated-server-token';
    const rotatedResponsePromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(tunnelRequestFrame('request-2', rawRequest, true));
    await rotatedResponsePromise;
    await waitFor(
      () => scenario.state.localHttpRequest?.headers.authorization === 'Bearer rotated-server-token',
    );
    expect(scenario.state.localHttpRequest?.headers.authorization).toBe(
      'Bearer rotated-server-token',
    );
  });

  it('compresses textual responses, honors rewritten ETags, and passes binaries through', async () => {
    const scenario = await startTunnelScenario();
    const send = (requestId: string, raw: string): Promise<Record<string, unknown>> => {
      const responsePromise = nextJsonMessage(scenario.httpConnections[0]!);
      scenario.httpConnections[0]!.send(tunnelRequestFrame(requestId, Buffer.from(raw), true));
      return responsePromise;
    };
    const head = (body: Buffer): string =>
      body.subarray(0, body.indexOf('\r\n\r\n')).toString('latin1');
    const body = (full: Buffer): Buffer => full.subarray(full.indexOf('\r\n\r\n') + 4);

    const gzipResponse = frameBody(
      await send('request-3', 'GET /assets/index.js HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: br, gzip\r\n\r\n'),
    );
    const gzipHead = head(gzipResponse);
    const gzipBody = body(gzipResponse);
    expect(gzipHead).toContain('HTTP/1.1 200 OK');
    expect(gzipHead).toContain('Content-Encoding: gzip');
    expect(gzipHead).toContain('Vary: Accept-Encoding');
    expect(gzipHead).toContain('Cache-Control: no-cache');
    const rewrittenETag = /ETag: (W\/"[0-9a-f]{64}")/.exec(gzipHead)?.[0];
    expect(rewrittenETag).toBeDefined();
    expect(gzipHead).toContain(`Content-Length: ${gzipBody.length}`);
    expect(gunzipSync(gzipBody).toString()).toBe(
      scenario.assets.js.replaceAll('"/assets/', `"/coding-relay/devices/${scenario.handle.deviceId}/assets/`),
    );

    const revalidateResponse = frameBody(
      await send(
        'request-3b',
        `GET /assets/index.js HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: br, gzip\r\nIf-None-Match: ${rewrittenETag!.replace('ETag: ', '')}\r\n\r\n`,
      ),
    );
    const revalidateHead = head(revalidateResponse);
    expect(revalidateHead).toContain('HTTP/1.1 304 Not Modified');
    expect(revalidateHead).toContain('Cache-Control: no-cache');
    expect(revalidateHead).toContain(rewrittenETag!);
    expect(revalidateHead).not.toContain('Content-Encoding');
    expect(revalidateHead).not.toContain('Content-Length');

    const binaryResponse = frameBody(
      await send('request-4', 'GET /assets/logo.png HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: gzip\r\n\r\n'),
    );
    expect(head(binaryResponse)).not.toContain('Content-Encoding');
    expect(body(binaryResponse).equals(scenario.assets.png)).toBe(true);

    const excludedResponse = frameBody(
      await send('request-5', 'GET /assets/index.js HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: gzip;q=0, *;q=1\r\n\r\n'),
    );
    const excludedHead = head(excludedResponse);
    expect(excludedHead).not.toContain('Content-Encoding');
    expect(excludedHead).toContain('Vary: Accept-Encoding');
    expect(excludedHead).toContain(rewrittenETag!);
    expect(excludedHead).not.toContain('ETag: "v1"');
    expect(body(excludedResponse).toString()).toBe(
      scenario.assets.js.replaceAll('"/assets/', `"/coding-relay/devices/${scenario.handle.deviceId}/assets/`),
    );

    const svgResponse = frameBody(
      await send('request-6', 'GET /assets/logo.svg HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: gzip\r\n\r\n'),
    );
    const svgHead = head(svgResponse);
    expect(svgHead).toContain('Content-Encoding: gzip');
    expect(svgHead).toContain('Vary: Accept-Encoding');
    expect(svgHead).toContain('immutable');
    expect(gunzipSync(body(svgResponse)).toString()).toBe(scenario.assets.svg);

    const rangeResponse = frameBody(
      await send('request-7', 'GET /assets/partial.txt HTTP/1.1\r\nHost: relay.test\r\nAccept-Encoding: gzip\r\nRange: bytes=0-2047\r\n\r\n'),
    );
    const rangeHead = head(rangeResponse);
    expect(rangeHead).toContain('206');
    expect(rangeHead).toContain('Content-Range: bytes 0-2047/4096');
    expect(rangeHead).not.toContain('Content-Encoding');
    expect(body(rangeResponse).toString()).toBe(scenario.assets.text);
  });

  it('reassembles chunked upload bodies through the tunnel', async () => {
    const scenario = await startTunnelScenario();

    const largeBody = Buffer.alloc(64 * 1024, 0x61);
    const largeRequest = Buffer.concat([
      Buffer.from(`POST /upload HTTP/1.1\r\nHost: relay.test\r\nContent-Length: ${largeBody.length}\r\n\r\n`),
      largeBody,
    ]);
    const largeResponsePromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(tunnelRequestFrame('request-8', largeRequest, true));
    const largeResponseMessage = await largeResponsePromise;
    expect(frameBody(largeResponseMessage).toString()).toContain('HTTP/1.1 200 OK');
    expect(scenario.state.localHttpBodyBytes).toBe(largeBody.length);
    expect(largeResponseMessage['type']).toBe('response');
    expect(largeResponseMessage['is_last']).toBe(true);

    const uploadBody = Buffer.alloc(11 * 1024, 0x63);
    const uploadRequest = Buffer.concat([
      Buffer.from(`POST /upload HTTP/1.1\r\nHost: relay.test\r\nContent-Length: ${uploadBody.length}\r\n\r\n`),
      uploadBody,
    ]);
    const uploadResponsePromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(tunnelRequestFrame('request-9', uploadRequest.subarray(0, 5 * 1024), false));
    scenario.httpConnections[0]!.send(tunnelRequestFrame('request-9', uploadRequest.subarray(5 * 1024, 10 * 1024), false));
    scenario.httpConnections[0]!.send(tunnelRequestFrame('request-9', uploadRequest.subarray(10 * 1024), true));
    const uploadResponse = frameBody(await uploadResponsePromise).toString();
    expect(uploadResponse).toContain('HTTP/1.1 200 OK');
    expect(scenario.state.localHttpBodyBytes).toBe(uploadBody.length);
  });

  it('chunks large responses and interleaves concurrent transfers', async () => {
    const scenario = await startTunnelScenario({
      limits: { maxSingleFrameResponseBytes: 32 * 1024, responseChunkBytes: 16 * 1024 },
    });
    const send = (requestId: string, path: string): void => {
      scenario.httpConnections[0]!.send(
        tunnelRequestFrame(requestId, Buffer.from(`GET ${path} HTTP/1.1\r\nHost: relay.test\r\n\r\n`), true),
      );
    };

    const chunkedFramesPromise = collectJsonMessages(scenario.httpConnections[0]!, 3);
    send('request-10', '/assets/big.png');
    const chunkedFrames = await chunkedFramesPromise;
    expect(chunkedFrames.map((frame) => [frame['type'], frame['is_last']])).toEqual([
      ['response_chunk', false],
      ['response_chunk', false],
      ['response_chunk', true],
    ]);
    const chunkedParts = chunkedFrames.map(frameBody);
    expect(chunkedParts[0]!.length).toBe(16 * 1024);
    expect(chunkedParts[1]!.length).toBe(16 * 1024);
    const reassembled = Buffer.concat(chunkedParts);
    const reassembledSeparator = reassembled.indexOf('\r\n\r\n');
    expect(reassembledSeparator).toBeGreaterThan(0);
    expect(reassembledSeparator).toBeLessThan(16 * 1024);
    expect(reassembled.subarray(0, reassembledSeparator).toString('latin1')).toContain(
      'HTTP/1.1 200 OK',
    );
    expect(reassembled.subarray(reassembledSeparator + 4).equals(scenario.assets.big)).toBe(true);

    const alignedFramesPromise = collectJsonMessages(scenario.httpConnections[0]!, 4);
    send('request-11', '/assets/aligned.png');
    const alignedFrames = await alignedFramesPromise;
    expect(alignedFrames.map((frame) => [frame['type'], frame['is_last']])).toEqual([
      ['response_chunk', false],
      ['response_chunk', false],
      ['response_chunk', false],
      ['response_chunk', true],
    ]);
    const alignedParts = alignedFrames.map(frameBody);
    expect(alignedParts.map((part) => part.length)).toEqual([16 * 1024, 16 * 1024, 16 * 1024, 0]);
    const alignedReassembled = Buffer.concat(alignedParts);
    expect(alignedReassembled.length).toBe(scenario.assets.alignedResponseBytes);
    expect(
      alignedReassembled
        .subarray(alignedReassembled.indexOf('\r\n\r\n') + 4)
        .equals(scenario.assets.aligned),
    ).toBe(true);

    const concurrentFramesPromise = collectJsonMessages(scenario.httpConnections[0]!, 4);
    send('request-12', '/assets/big.png');
    send('request-13', '/assets/logo.png');
    const concurrentFrames = await concurrentFramesPromise;
    const concurrentBig = concurrentFrames.filter((frame) => frame['request_id'] === 'request-12');
    const concurrentSmall = concurrentFrames.filter((frame) => frame['request_id'] === 'request-13');
    expect(concurrentBig.map((frame) => frame['is_last'])).toEqual([false, false, true]);
    expect(concurrentSmall).toHaveLength(1);
    expect(concurrentSmall[0]!['type']).toBe('response');
    const concurrentReassembled = Buffer.concat(concurrentBig.map(frameBody));
    expect(
      concurrentReassembled
        .subarray(concurrentReassembled.indexOf('\r\n\r\n') + 4)
        .equals(scenario.assets.big),
    ).toBe(true);
  });

  it('orders frames, enforces retain limits, and aborts inside HttpTunnel', async () => {
    const tunnelFrames: string[] = [];
    const tunnelCallbacks: Array<(error?: Error | null) => void> = [];
    let tunnelTerminated = false;
    const tunnelSocket = {
      readyState: 1,
      send(frame: string, callback: (error?: Error | null) => void): void {
        tunnelFrames.push(frame);
        tunnelCallbacks.push(callback);
      },
      terminate(): void {
        tunnelTerminated = true;
      },
    } as unknown as WebSocket;
    const localCalls = new Map<
      string,
      {
        signal: AbortSignal;
        retain: (receivedBytes: number) => boolean;
        respond: (response: Buffer[]) => void;
      }
    >();
    const tunnel = new HttpTunnel(
      tunnelSocket,
      (request, signal, retain) =>
        new Promise((respond) => {
          localCalls.set(request.path, { signal, retain, respond });
        }),
      { write: () => true },
      {
        maxRequestBytes: 4096,
        maxRetainedBytes: 8192,
        maxSingleFrameResponseBytes: 64,
        responseChunkBytes: 32,
      },
    );
    const tunnelRequest = (requestId: string, raw: string, isLast = true): void =>
      tunnel.handleMessage(Buffer.from(tunnelRequestFrame(requestId, Buffer.from(raw), isLast)));
    const tunnelSent = (): string[] =>
      tunnelFrames.map((frame) => {
        const parsed = JSON.parse(frame) as Record<string, unknown>;
        return `${String(parsed['request_id'])}:${String(parsed['is_last'])}`;
      });
    const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

    tunnelRequest('a', 'GET /a HTTP/1.1\r\n\r\n');
    tunnelRequest('b', 'GET /b HTTP/1.1\r\n\r\n');
    localCalls.get('/a')!.respond([Buffer.alloc(40, 1), Buffer.alloc(40, 2)]);
    await flush();
    expect(tunnelSent()).toEqual(['a:false']);
    expect(
      (JSON.parse(tunnelFrames[0]!) as { body_base64: string }).body_base64,
    ).toBe(Buffer.alloc(32, 1).toString('base64'));
    localCalls.get('/b')!.respond([Buffer.from('b')]);
    await flush();
    tunnelCallbacks.shift()!(null);
    await flush();
    expect(tunnelSent()).toEqual(['a:false', 'b:true']);
    tunnelCallbacks.shift()!(null);
    await flush();
    expect(tunnelSent()).toEqual(['a:false', 'b:true', 'a:false']);
    tunnel.handleMessage(Buffer.from(tunnelAbortFrame('a')));
    tunnelCallbacks.shift()!(null);
    await flush();
    expect(tunnelSent()).toHaveLength(3);

    tunnelRequest('c', 'GET /c HTTP/1.1\r\n\r\n');
    tunnelRequest('d', 'GET /d HTTP/1.1\r\n\r\n');
    expect(localCalls.get('/c')!.retain(5000)).toBe(true);
    expect(localCalls.get('/d')!.retain(4096)).toBe(false);
    tunnelRequest('e', '', false);
    tunnelRequest('e', '', false);
    await flush();
    expect(tunnelSent()).toEqual(['a:false', 'b:true', 'a:false', 'e:true']);
    expect(
      Buffer.from(
        (JSON.parse(tunnelFrames[3]!) as { body_base64: string }).body_base64,
        'base64',
      ).toString(),
    ).toContain('HTTP/1.1 400');
    tunnelCallbacks.shift()!(null);
    tunnel.handleMessage(Buffer.from(tunnelAbortFrame('c')));
    expect(localCalls.get('/c')!.signal.aborted).toBe(true);
    expect(localCalls.get('/d')!.retain(6000)).toBe(true);
    tunnelRequest('f', 'GET /f HTTP/1.1\r\n\r\n');
    localCalls.get('/d')!.respond([Buffer.from('d')]);
    await flush();
    expect(tunnelSent()).toHaveLength(5);
    tunnelCallbacks.shift()!(new Error('write failed'));
    await flush();
    expect(tunnelTerminated).toBe(true);
    expect(localCalls.get('/f')!.signal.aborted).toBe(true);
    localCalls.get('/f')!.respond([Buffer.from('f')]);
    await flush();
    expect(tunnelSent()).toEqual(['a:false', 'b:true', 'a:false', 'e:true', 'd:true']);
  });

  it('rejects invalid tunnel limits at construction', () => {
    const socket = { readyState: 1 } as unknown as WebSocket;
    const forwardLocal = (): Promise<Buffer[]> => new Promise(() => {});
    const stderr = { write: (): boolean => true };
    const limits = {
      maxRequestBytes: 4096,
      maxRetainedBytes: 8192,
      maxSingleFrameResponseBytes: 64,
      responseChunkBytes: 32,
    };
    expect(() => new HttpTunnel(socket, forwardLocal, stderr, { ...limits, responseChunkBytes: 0 })).toThrow(
      /responseChunkBytes/,
    );
    expect(
      () => new HttpTunnel(socket, forwardLocal, stderr, { ...limits, responseChunkBytes: Number.MIN_VALUE }),
    ).toThrow(/responseChunkBytes/);
    expect(
      () => new HttpTunnel(socket, forwardLocal, stderr, { ...limits, responseChunkBytes: 1.5 }),
    ).toThrow(/responseChunkBytes/);
    expect(() => new HttpTunnel(socket, forwardLocal, stderr, { ...limits, maxRequestBytes: Number.NaN })).toThrow(
      /maxRequestBytes/,
    );
    expect(() => new HttpTunnel(socket, forwardLocal, stderr, { ...limits, maxRetainedBytes: -1 })).toThrow(
      /maxRetainedBytes/,
    );
    expect(
      () =>
        new HttpTunnel(socket, forwardLocal, stderr, {
          ...limits,
          maxSingleFrameResponseBytes: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(/maxSingleFrameResponseBytes/);
    expect(() => new HttpTunnel(socket, forwardLocal, stderr, limits)).not.toThrow();
  });

  it('rejects invalid tunnel limits before acquiring the instance lock', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    await expect(
      startRemoteControl({
        homeDir,
        localOrigin: 'http://127.0.0.1:1',
        localServerToken: 'local-server-token',
        clientVersion: CLIENT_VERSION,
        urlSource: 'kimi_code_cli',
        relayOrigin: 'http://127.0.0.1:1/coding-relay',
        stderr: { write: () => true },
        httpTunnelLimits: { responseChunkBytes: 0 },
      }),
    ).rejects.toThrow(/responseChunkBytes/);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
  });

  it('aborts in-flight requests without breaking the tunnel', async () => {
    const scenario = await startTunnelScenario();

    scenario.httpConnections[0]!.send(
      tunnelRequestFrame(
        'request-14',
        Buffer.from('POST /upload HTTP/1.1\r\nHost: relay.test\r\nContent-Length: 20\r\n\r\n0123456789'),
        false,
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    scenario.httpConnections[0]!.send(tunnelAbortFrame('request-14'));
    scenario.httpConnections[0]!.send(tunnelAbortFrame('request-14'));
    scenario.httpConnections[0]!.send(tunnelAbortFrame('request-unknown'));
    const postAbortPromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(
      tunnelRequestFrame('request-15', Buffer.from('GET /assets/logo.png HTTP/1.1\r\nHost: relay.test\r\n\r\n'), true),
    );
    expect((await postAbortPromise)['request_id']).toBe('request-15');

    scenario.httpConnections[0]!.send(
      tunnelRequestFrame('request-16', Buffer.from('GET /hang HTTP/1.1\r\nHost: relay.test\r\n\r\n'), true),
    );
    await waitFor(() => scenario.hangRequests.length === 1);
    scenario.httpConnections[0]!.send(tunnelAbortFrame('request-16'));
    await waitFor(() => scenario.state.hangClosedCount === 1);
    const forwardAbortPromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(
      tunnelRequestFrame('request-17', Buffer.from('GET /assets/logo.png HTTP/1.1\r\nHost: relay.test\r\n\r\n'), true),
    );
    expect((await forwardAbortPromise)['request_id']).toBe('request-17');
  });

  it('enforces the byte budget across transfers and recovers after aborts', async () => {
    const scenario = await startTunnelScenario({
      limits: { maxRequestBytes: 256 * 1024, maxRetainedBytes: 640 * 1024 },
      bigBytes: 300 * 1024,
    });
    const post = (requestId: string, path: string, body: Buffer): void => {
      scenario.httpConnections[0]!.send(
        tunnelRequestFrame(
          requestId,
          Buffer.concat([
            Buffer.from(`POST ${path} HTTP/1.1\r\nHost: relay.test\r\nContent-Length: ${body.length}\r\n\r\n`),
            body,
          ]),
          true,
        ),
      );
    };

    post('request-18a', '/hang-upload', Buffer.alloc(250 * 1024, 0x68));
    post('request-18b', '/hang-upload', Buffer.alloc(250 * 1024, 0x68));
    await waitFor(() => scenario.hangRequests.length === 2);

    const overLimitPromise = nextJsonMessage(scenario.httpConnections[0]!);
    post('request-18f', '/upload', Buffer.alloc(300 * 1024, 0x6a));
    expect(
      frameBody(await overLimitPromise).toString(),
    ).toContain('HTTP/1.1 400');

    const overflowResponsePromise = nextJsonMessage(scenario.httpConnections[0]!);
    post('request-18c', '/upload', Buffer.alloc(200 * 1024, 0x69));
    const overflowResponse = frameBody(await overflowResponsePromise).toString();
    expect(overflowResponse).toContain('HTTP/1.1 400');

    const deniedDownloadPromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(
      tunnelRequestFrame('request-18d', Buffer.from('GET /assets/big.png HTTP/1.1\r\nHost: relay.test\r\n\r\n'), true),
    );
    const deniedDownloadMessage = await deniedDownloadPromise;
    expect(deniedDownloadMessage['request_id']).toBe('request-18d');
    expect(frameBody(deniedDownloadMessage).toString()).toContain('HTTP/1.1 503');

    const headResponsePromise = nextJsonMessage(scenario.httpConnections[0]!);
    scenario.httpConnections[0]!.send(
      tunnelRequestFrame('request-18e', Buffer.from('HEAD /assets/aligned.png HTTP/1.1\r\nHost: relay.test\r\n\r\n'), true),
    );
    expect(frameBody(await headResponsePromise).toString()).toContain('HTTP/1.1 200 OK');

    scenario.httpConnections[0]!.send(tunnelAbortFrame('request-18a'));
    scenario.httpConnections[0]!.send(tunnelAbortFrame('request-18b'));
    const retryBody = Buffer.alloc(200 * 1024, 0x69);
    const retryResponsePromise = nextJsonMessage(scenario.httpConnections[0]!);
    post('request-19', '/upload', retryBody);
    const retryResponse = frameBody(await retryResponsePromise).toString();
    expect(retryResponse).toContain('HTTP/1.1 200 OK');
    expect(scenario.uploadBodyBytes.get('/upload')).toBe(retryBody.length);
  });

  it('forwards WebSocket streams with local auth and drains bursts before close', async () => {
    const scenario = await startTunnelScenario();

    scenario.managementConnections[0]!.send(
      JSON.stringify({
        type: 'open_ws',
        payload: {
          stream_id: 'stream-1',
          path: '/api/v1/ws',
          headers: { Cookie: 'relay-cookie', Origin: 'https://relay.test', 'X-Keep': 'yes' },
        },
      }),
    );
    await waitFor(() => scenario.streamConnections.length === 1 && scenario.state.localWs !== undefined);
    expect(scenario.state.localWsRequest?.headers['sec-websocket-protocol']).toBe(
      'kimi-code.bearer.local-server-token',
    );
    expect(scenario.state.localWsRequest?.headers.authorization).toBeUndefined();
    expect(scenario.state.localWsRequest?.headers.cookie).toBeUndefined();
    expect(scenario.state.localWsRequest?.headers.origin).toBeUndefined();
    expect(scenario.state.localWsRequest?.headers['x-keep']).toBe('yes');
    await waitFor(() =>
      scenario.managementMessages.some(
        (value) =>
          (value as { type?: string }).type === 'open_ws_result' &&
          (value as { payload?: { success?: boolean } }).payload?.success === true,
      ),
    );

    await waitFor(() => scenario.streamMessages.includes('server-hello-frame'));
    const localMessage = nextTextMessage(scenario.state.localWs!);
    scenario.streamConnections[0]!.send('from-relay');
    await expect(localMessage).resolves.toBe('from-relay');
    const relayMessage = nextTextMessage(scenario.streamConnections[0]!);
    scenario.state.localWs!.send('from-local');
    await expect(relayMessage).resolves.toBe('from-local');

    const burstFrames = ['burst-1', 'burst-2', 'burst-3'];
    const receivedBurst: string[] = [];
    scenario.state.localWs!.on('message', (data) => {
      receivedBurst.push(rawDataText(data));
    });
    for (const frame of burstFrames) scenario.streamConnections[0]!.send(frame);
    scenario.streamConnections[0]!.close();
    await waitFor(() => scenario.state.localWs?.readyState === 3);
    expect(receivedBurst).toEqual(burstFrames);
  });

  it('reconnects the tunnel pair after the relay drops it', async () => {
    const scenario = await startTunnelScenario();

    scenario.httpConnections[0]!.terminate();
    await waitFor(() => scenario.registrations.length === 2 && scenario.httpConnections.length === 2, 4000);
    expect(scenario.httpCapabilities).toEqual([
      'request_chunk,response_chunk,abort',
      'request_chunk,response_chunk,abort',
    ]);
    const reconnectResponsePromise = nextJsonMessage(scenario.httpConnections[1]!);
    scenario.httpConnections[1]!.send(tunnelRequestFrame('request-20', probeRawRequest(), true));
    const reconnectResponse = frameBody(await reconnectResponsePromise).toString();
    expect(reconnectResponse).toContain('HTTP/1.1 200 OK');

    await scenario.handle.close();
    await waitFor(() =>
      scenario.managementMessages.some(
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
      urlSource: 'kimi_code_cli',
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
      urlSource: 'kimi_code_cli',
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
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });

    await expect(
      startRemoteControl({
        homeDir,
        localOrigin: 'http://127.0.0.1:58628',
        localServerToken: 'local-server-token',
        clientVersion: CLIENT_VERSION,
        urlSource: 'kimi_code_cli',
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
      urlSource: 'kimi_code_cli',
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
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    };
    const first = await startRemoteControl(options);
    await first.close();

    let second: RemoteControlHandle | undefined;
    cleanups.push(async () => second?.close());
    second = await startRemoteControl(options);
    expect(second.url).toContain('/devices/');

    relay.managementSockets.at(-1)!.send(
      JSON.stringify({ type: 'disconnect', payload: { reason: 'user_requested' } }),
    );
    await second.closed;
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
  });

  it('reports a terminal status and close reason on user_requested only', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    const statuses: string[] = [];
    let handle: RemoteControlHandle | undefined;
    cleanups.push(async () => handle?.close());

    handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
      onStatus: (status) => statuses.push(status),
    });

    relay.managementSockets.at(-1)!.send(
      JSON.stringify({ type: 'disconnect', payload: { reason: 'user_requested' } }),
    );
    await expect(handle.closed).resolves.toBe('user_requested');
    expect(statuses).toEqual(['relay_connected', 'relay_terminated']);

    const localStatuses: string[] = [];
    let second: RemoteControlHandle | undefined;
    cleanups.push(async () => second?.close());
    second = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
      onStatus: (status) => localStatuses.push(status),
    });
    const closing = second.close();
    await expect(second.closed).resolves.toBe('local_close');
    await closing;
    expect(localStatuses).toEqual(['relay_connected', 'relay_disconnected']);
  });

  it('does not remove a successor lock when closing', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    const handle = await startRemoteControl({
      homeDir,
      localOrigin: 'http://127.0.0.1:58627',
      localServerToken: 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
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

describe('Remote Control device client', () => {
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

  it('exchanges once, caches the session cookie, and sends device operations', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const requests: Array<{
      method?: string;
      pathname: string;
      cookie?: string;
      body: string;
    }> = [];
    const server = createServer((request, response) => {
      void (async () => {
        const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
        const body = await requestText(request);
        requests.push({
          method: request.method,
          pathname,
          cookie: Array.isArray(request.headers.cookie)
            ? request.headers.cookie[0]
            : request.headers.cookie,
          body,
        });
        if (pathname === '/coding-relay/auth/exchange') {
          response.writeHead(204, {
            'Set-Cookie': ['rc_session=one; Path=/; HttpOnly', 'theme=dark; Path=/'],
          });
          response.end();
          return;
        }
        if (pathname === '/coding-relay/v1/remote/devices' && request.method === 'GET') {
          response.writeHead(200, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify({ devices: [device], max_devices: 3 }));
          return;
        }
        if (pathname === '/coding-relay/v1/remote/devices/device%2Fone' && (request.method === 'PATCH' || request.method === 'DELETE')) {
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
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: `http://127.0.0.1:${port}/coding-relay/`,
    });

    await expect(client.listDevices()).resolves.toEqual({ devices: [device], max_devices: 3 });
    await client.renameDevice('device/one', 'Renamed');
    await client.deleteDevice('device/one');

    expect(requests).toHaveLength(4);
    expect(JSON.parse(requests[0]!.body)).toEqual({
      access_token: TOKEN.accessToken,
      refresh_token: TOKEN.refreshToken,
      expires_in: TOKEN.expiresIn,
    });
    expect(requests.slice(1).map((request) => request.cookie)).toEqual([
      'rc_session=one; theme=dark',
      'rc_session=one; theme=dark',
      'rc_session=one; theme=dark',
    ]);
    expect(JSON.parse(requests[2]!.body)).toEqual({ alias: 'Renamed' });
    expect(requests[3]!.method).toBe('DELETE');
    expect(requests[3]!.pathname).toBe('/coding-relay/v1/remote/devices/device%2Fone');
  });

  it('projects only the documented device fields from the relay payload', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
      if (pathname === '/coding-relay/auth/exchange') {
        response.writeHead(204, { 'Set-Cookie': 'rc_session=one; Path=/' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(
        JSON.stringify({
          devices: [{ ...device, internal_note: 'cloud-only', session_debug: { trace: 'x' } }],
        }),
      );
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: `http://127.0.0.1:${port}/coding-relay/`,
    });

    const list = await client.listDevices();
    expect(list.devices).toEqual([device]);
    expect(Object.keys(list.devices[0]!).toSorted()).toEqual(Object.keys(device).toSorted());
  });

  it('requires a fresh exchange after clearing cached cloud sessions', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    let exchanges = 0;
    const deviceCookies: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
      if (pathname === '/auth/exchange') {
        exchanges += 1;
        response.writeHead(204, { 'Set-Cookie': `rc_session=${exchanges}; Path=/` });
        response.end();
        return;
      }
      deviceCookies.push(
        Array.isArray(request.headers.cookie) ? request.headers.cookie[0] : request.headers.cookie,
      );
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ devices: [] }));
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: `http://127.0.0.1:${port}`,
    });

    await client.listDevices();
    client.clear();
    await client.listDevices();

    expect(exchanges).toBe(2);
    expect(deviceCookies).toEqual(['rc_session=1', 'rc_session=2']);
  });

  it('re-exchanges and retries once when the cloud session expires', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    let exchanges = 0;
    const deviceCookies: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
      if (pathname === '/auth/exchange') {
        exchanges += 1;
        response.writeHead(204, { 'Set-Cookie': `rc_session=${exchanges}; Path=/; HttpOnly` });
        response.end();
        return;
      }
      deviceCookies.push(
        Array.isArray(request.headers.cookie) ? request.headers.cookie[0] : request.headers.cookie,
      );
      if (deviceCookies.length === 1) {
        response.writeHead(401, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: { message: 'session expired' } }));
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ devices: [] }));
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: `http://127.0.0.1:${port}`,
    });

    await expect(client.listDevices()).resolves.toEqual({ devices: [], max_devices: undefined });

    expect(exchanges).toBe(2);
    expect(deviceCookies).toEqual(['rc_session=1', 'rc_session=2']);
  });

  it('does not retry more than once after re-exchange', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    let exchanges = 0;
    let deviceRequests = 0;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
      if (pathname === '/auth/exchange') {
        exchanges += 1;
        response.writeHead(204, { 'Set-Cookie': `rc_session=${exchanges}; Path=/` });
        response.end();
        return;
      }
      deviceRequests += 1;
      response.writeHead(401, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ message: 'still unauthorized' }));
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: `http://127.0.0.1:${port}`,
    });

    await expect(client.listDevices()).rejects.toThrow(/HTTP 401.*still unauthorized/);
    expect(exchanges).toBe(2);
    expect(deviceRequests).toBe(2);
  });

  it('uses the configured OAuth slot when exchanging a session', async () => {
    const homeDir = mkdtempSync(join(tmpdir(), 'kimi-rc-device-slot-'));
    cleanups.push(() => {
      rmSync(homeDir, { recursive: true, force: true });
    });
    const oauthRef = resolveKimiCodeOAuthRef({
      oauthHost: 'https://auth.kimi.ai',
      baseUrl: 'https://api.kimi.ai/coding/v1',
    });
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ oauthKey: oauthRef.key }),
      { ...TOKEN, accessToken: 'custom-access', refreshToken: 'custom-refresh' },
    );
    let exchangedBody = '';
    const server = createServer((request, response) => {
      void (async () => {
        const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
        if (pathname === '/auth/exchange') {
          exchangedBody = await requestText(request);
          response.writeHead(204, { 'Set-Cookie': 'rc_session=custom; Path=/' });
          response.end();
          return;
        }
        response.writeHead(200, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ devices: [] }));
      })().catch(() => {
        response.writeHead(500);
        response.end();
      });
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      configuredOAuthKey: () => oauthRef.key,
      configuredOAuthHost: () => oauthRef.oauthHost,
      relayOrigin: `http://127.0.0.1:${port}`,
    });

    await client.listDevices();

    expect(JSON.parse(exchangedBody)).toEqual({
      access_token: 'custom-access',
      refresh_token: 'custom-refresh',
      expires_in: TOKEN.expiresIn,
    });
  });

  it('maps network failures to a safe client error', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: 'http://127.0.0.1:1',
      fetchImpl: async () => {
        throw new TypeError('network offline');
      },
    });

    await expect(client.listDevices()).rejects.toThrow(
      'Remote Control session exchange failed: network offline',
    );
  });

  it('rejects malformed device list payloads instead of reporting an empty list', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const payloads: unknown[] = [
      {},
      { devices: 'nope' },
      { devices: [{ ...device, status: 'busy' }] },
      { devices: [{ alias: 'missing fields' }] },
      { devices: [], max_devices: 'three' },
    ];
    let nextPayload = 0;
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
      if (pathname === '/auth/exchange') {
        response.writeHead(204, { 'Set-Cookie': 'rc_session=one; Path=/' });
        response.end();
        return;
      }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(payloads[nextPayload] ?? {}));
      nextPayload += 1;
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: `http://127.0.0.1:${port}`,
    });

    for (let index = 0; index < payloads.length; index += 1) {
      await expect(client.listDevices()).rejects.toThrow(
        'Remote Control device list returned an unexpected response.',
      );
    }
  });

  it('re-exchanges when the stored credential changes under the same OAuth slot', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    let exchanges = 0;
    const deviceCookies: Array<string | undefined> = [];
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
      if (pathname === '/auth/exchange') {
        exchanges += 1;
        response.writeHead(204, { 'Set-Cookie': `rc_session=${exchanges}; Path=/` });
        response.end();
        return;
      }
      deviceCookies.push(
        Array.isArray(request.headers.cookie) ? request.headers.cookie[0] : request.headers.cookie,
      );
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ devices: [] }));
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: `http://127.0.0.1:${port}`,
    });

    await client.listDevices();
    await new FileTokenStorage(join(homeDir, 'credentials')).save(
      resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
      { ...TOKEN, refreshToken: 'second-account-refresh' },
    );
    await client.listDevices();

    expect(exchanges).toBe(2);
    expect(deviceCookies).toEqual(['rc_session=1', 'rc_session=2']);
  });

  it('aborts an in-flight device request when sessions are cleared', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? '', 'http://relay.test').pathname;
      if (pathname === '/auth/exchange') {
        response.writeHead(204, { 'Set-Cookie': 'rc_session=one; Path=/' });
        response.end();
        return;
      }
    });
    const port = await listen(server);
    cleanups.push(() => closeServer(server));
    const client = new RemoteControlDeviceClient({
      homeDir,
      relayOrigin: `http://127.0.0.1:${port}`,
    });

    const pending = client.listDevices();
    await new Promise((resolve) => setTimeout(resolve, 50));
    client.clear();

    await expect(pending).rejects.toThrow('Remote Control device request failed');
  });
});

describe('Remote Control manager', () => {
  it('cancels an in-flight start on disable and releases the lock', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const managementServer = new WebSocketServer({ noServer: true });
    const relayServer = createServer();
    managementServer.on('connection', (ws) => {
      ws.on('error', () => {});
    });
    relayServer.on('upgrade', (request, socket, head) => {
      managementServer.handleUpgrade(request, socket, head, (ws) => {
        managementServer.emit('connection', ws, request);
      });
    });
    const port = await listen(relayServer);
    cleanups.push(() => closeServer(relayServer));
    const manager = createRemoteControlManager({
      homeDir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${port}`,
      stderr: { write: () => true },
    });
    cleanups.push(() => manager.close());

    const enabling = manager.enable();
    const enablingSettled = expect(enabling).rejects.toThrow(
      'Remote Control was disabled while starting.',
    );
    await waitFor(() => existsSync(remoteControlLockPath(homeDir)));
    expect(manager.status().state).toBe('starting');

    const startedAt = Date.now();
    const status = await manager.disable();
    expect(status.state).toBe('off');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    await enablingSettled;
  });

  it('re-enables immediately after cancelling a start', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const managementServer = new WebSocketServer({ noServer: true });
    const relayServer = createServer();
    managementServer.on('connection', (ws) => {
      ws.on('error', () => {});
      ws.on('message', (data) => {
        const message = JSON.parse(rawDataText(data)) as { type?: string };
        if (message.type === 'register') {
          setTimeout(() => {
            try {
              ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
            } catch {}
          }, 200);
        }
      });
    });
    relayServer.on('upgrade', (request, socket, head) => {
      managementServer.handleUpgrade(request, socket, head, (ws) => {
        managementServer.emit('connection', ws, request);
      });
    });
    const port = await listen(relayServer);
    cleanups.push(() => closeServer(relayServer));
    const manager = createRemoteControlManager({
      homeDir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${port}`,
      stderr: { write: () => true },
    });
    cleanups.push(() => manager.close());

    const first = manager.enable();
    const firstSettled = expect(first).rejects.toThrow(
      'Remote Control was disabled while starting.',
    );
    await waitFor(() => existsSync(remoteControlLockPath(homeDir)));
    await manager.disable();
    await firstSettled;

    const second = await manager.enable();
    expect(second.state).toBe('on');
    await manager.disable();
  });

  it('applies the latest toggle intent queued behind a cancelled start', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const managementServer = new WebSocketServer({ noServer: true });
    const relayServer = createServer();
    managementServer.on('connection', (ws) => {
      ws.on('error', () => {});
      ws.on('message', (data) => {
        const message = JSON.parse(rawDataText(data)) as { type?: string };
        if (message.type === 'register') {
          setTimeout(() => {
            try {
              ws.send(JSON.stringify({ type: 'register_ack', payload: { success: true } }));
            } catch {}
          }, 200);
        }
      });
    });
    relayServer.on('upgrade', (request, socket, head) => {
      managementServer.handleUpgrade(request, socket, head, (ws) => {
        managementServer.emit('connection', ws, request);
      });
    });
    const port = await listen(relayServer);
    cleanups.push(() => closeServer(relayServer));
    const manager = createRemoteControlManager({
      homeDir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${port}`,
      stderr: { write: () => true },
    });
    cleanups.push(() => manager.close());

    const first = manager.enable();
    const firstSettled = expect(first).rejects.toThrow(
      'Remote Control was disabled while starting.',
    );
    await waitFor(() => existsSync(remoteControlLockPath(homeDir)));

    const cancelling = manager.disable();
    const reenabled = manager.enable();
    const reenabledSettled = expect(reenabled).rejects.toThrow(
      'Remote Control was disabled while starting.',
    );
    const finalDisable = manager.disable();

    await cancelling;
    await firstSettled;
    await reenabledSettled;
    expect((await finalDisable).state).toBe('off');
    expect(manager.status().state).toBe('off');
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
  });

  it('aborts a pending relay handshake on disable', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relayServer = createServer();
    const upgradeSockets: Duplex[] = [];
    let upgrades = 0;
    relayServer.on('upgrade', (request, socket) => {
      upgrades += 1;
      socket.on('error', () => {});
      upgradeSockets.push(socket);
    });
    const port = await listen(relayServer);
    cleanups.push(() => {
      for (const socket of upgradeSockets) socket.destroy();
      return closeServer(relayServer);
    });
    const manager = createRemoteControlManager({
      homeDir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${port}`,
      stderr: { write: () => true },
    });
    cleanups.push(() => manager.close());

    const enabling = manager.enable();
    const enablingSettled = expect(enabling).rejects.toThrow();
    await waitFor(() => upgrades > 0);

    const startedAt = Date.now();
    const status = await manager.disable();
    expect(status.state).toBe('off');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await enablingSettled;
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
  });

  it('cancels a queued enable when disable arrives before it starts', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relayServer = createServer();
    const upgradeSockets: Duplex[] = [];
    let upgrades = 0;
    relayServer.on('upgrade', (request, socket) => {
      upgrades += 1;
      socket.on('error', () => {});
      upgradeSockets.push(socket);
    });
    const port = await listen(relayServer);
    cleanups.push(() => {
      for (const socket of upgradeSockets) socket.destroy();
      return closeServer(relayServer);
    });
    const manager = createRemoteControlManager({
      homeDir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${port}`,
      stderr: { write: () => true },
    });
    cleanups.push(() => manager.close());

    const enabling = manager.enable();
    const enablingSettled = expect(enabling).rejects.toThrow(
      'Remote Control was disabled while starting.',
    );

    const startedAt = Date.now();
    const status = await manager.disable();
    expect(status.state).toBe('off');
    expect(Date.now() - startedAt).toBeLessThan(1000);
    await enablingSettled;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(upgrades).toBe(0);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
  });

  it('surfaces a machine-lock release failure and remediates it on retry', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const managementServer = new WebSocketServer({ noServer: true });
    const relayServer = createServer();
    managementServer.on('connection', (ws) => {
      ws.on('error', () => {});
    });
    relayServer.on('upgrade', (request, socket, head) => {
      managementServer.handleUpgrade(request, socket, head, (ws) => {
        managementServer.emit('connection', ws, request);
      });
    });
    const port = await listen(relayServer);
    cleanups.push(() => closeServer(relayServer));
    const manager = createRemoteControlManager({
      homeDir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${port}`,
      stderr: { write: () => true },
    });
    cleanups.push(() => manager.close());

    const enabling = manager.enable();
    const enablingSettled = expect(enabling).rejects.toThrow(
      'Remote Control was disabled while starting.',
    );
    await waitFor(() => existsSync(remoteControlLockPath(homeDir)));

    const serverDir = join(homeDir, 'server');
    await chmod(serverDir, 0o555);
    await expect(manager.disable()).rejects.toThrow(/could not release the machine lock/);
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(true);
    await enablingSettled;

    await chmod(serverDir, 0o755);
    const status = await manager.disable();
    expect(status.state).toBe('off');
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
  });

  it('aborts the start when the credential disappears before registration', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    const original = FileTokenStorage.prototype.load;
    let loads = 0;
    vi.spyOn(FileTokenStorage.prototype, 'load').mockImplementation(function (
      this: FileTokenStorage,
      ...args: Parameters<FileTokenStorage['load']>
    ) {
      loads += 1;
      if (loads === 2) return Promise.resolve(undefined);
      return original.apply(this, args);
    });

    try {
      await expect(
        startRemoteControl({
          homeDir,
          localOrigin: 'http://127.0.0.1:58627',
          localServerToken: 'local-server-token',
          clientVersion: CLIENT_VERSION,
          urlSource: 'kimi_code_cli',
          relayOrigin: `http://127.0.0.1:${relay.port}`,
          stderr: { write: () => true },
        }),
      ).rejects.toThrow('Remote Control requires a Kimi login');
      expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('rejects immediately when the start signal is already aborted', async () => {
    const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const controller = new AbortController();
    controller.abort();

    await expect(
      startRemoteControl({
        homeDir,
        localOrigin: 'http://127.0.0.1:58627',
        localServerToken: 'local-server-token',
        clientVersion: CLIENT_VERSION,
        urlSource: 'kimi_code_cli',
        relayOrigin: 'http://127.0.0.1:1',
        stderr: { write: () => true },
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(existsSync(remoteControlLockPath(homeDir))).toBe(false);
  });

  it('rejects disable when the tunnel close fails', async () => {const homeDir = await createRemoteControlHome(TOKEN.refreshToken);
    const relay = await startAuthRelay();
    const manager = createRemoteControlManager({
      homeDir,
      localOrigin: () => 'http://127.0.0.1:58627',
      localServerToken: () => 'local-server-token',
      clientVersion: CLIENT_VERSION,
      urlSource: 'kimi_code_cli',
      relayOrigin: `http://127.0.0.1:${relay.port}`,
      stderr: { write: () => true },
    });
    cleanups.push(() => manager.close());
    await manager.enable();

    const lockPath = remoteControlLockPath(homeDir);
    chmodSync(join(homeDir, 'server'), 0o555);
    let error: unknown;
    try {
      error = await manager.disable().then(
        () => undefined,
        (disableError: unknown) => disableError,
      );
    } finally {
      chmodSync(join(homeDir, 'server'), 0o755);
    }

    expect(error).toBeInstanceOf(Error);
    expect(manager.status().state).toBe('off');
    expect(manager.status().error).toBeTruthy();
  });
});

function probeRawRequest(): Buffer {
  return Buffer.from(
    'GET / HTTP/1.1\r\nHost: relay.test\r\nAuthorization: Bearer relay-token\r\nCookie: sid=1\r\nOrigin: https://relay.test\r\nAccept-Encoding: gzip\r\nConnection: X-Hop\r\nX-Hop: remove\r\nX-Keep: yes\r\n\r\n',
  );
}

function tunnelRequestFrame(requestId: string, body: Buffer, isLast: boolean): string {
  return JSON.stringify({
    request_id: requestId,
    type: 'request',
    is_last: isLast,
    body_base64: body.toString('base64'),
  });
}

function tunnelAbortFrame(requestId: string): string {
  return JSON.stringify({
    request_id: requestId,
    type: 'abort',
    is_last: true,
    body_base64: '',
    reason: 'browser_closed',
  });
}

function frameBody(message: Record<string, unknown>): Buffer {
  return Buffer.from(message['body_base64'] as string, 'base64');
}

interface TunnelScenarioState {
  localHttpRequest: IncomingMessage | undefined;
  localHttpBodyBytes: number;
  localWsRequest: IncomingMessage | undefined;
  localWs: WebSocket | undefined;
  hangClosedCount: number;
}

interface TunnelScenario {
  handle: RemoteControlHandle;
  registrations: unknown[];
  httpCapabilities: Array<string | null>;
  managementConnections: WebSocket[];
  managementMessages: unknown[];
  httpConnections: WebSocket[];
  streamConnections: WebSocket[];
  streamMessages: string[];
  uploadBodyBytes: Map<string, number>;
  hangRequests: IncomingMessage[];
  assets: {
    js: string;
    png: Buffer;
    svg: string;
    text: string;
    big: Buffer;
    aligned: Buffer;
    alignedResponseBytes: number;
  };
  state: TunnelScenarioState;
}

async function startTunnelScenario(
  options: {
    limits?: Partial<HttpTunnelLimits>;
    localServerToken?: string | (() => string);
    bigBytes?: number;
    alignedResponseBytes?: number;
  } = {},
): Promise<TunnelScenario> {
  const homeDir = await createRemoteControlHome(TOKEN.refreshToken);

  const state: TunnelScenarioState = {
    localHttpRequest: undefined,
    localHttpBodyBytes: 0,
    localWsRequest: undefined,
    localWs: undefined,
    hangClosedCount: 0,
  };
  const uploadBodyBytes = new Map<string, number>();
  const localWsServer = new WebSocketServer({ noServer: true });
  const alignedResponseBytes = options.alignedResponseBytes ?? 48 * 1024;
  const assets: TunnelScenario['assets'] = {
    js: `const boot = "/assets/boot.js";\n${'const chunk = "/assets/chunk.js";\n'.repeat(120)}`,
    png: Buffer.alloc(4096, 7),
    svg: `<svg xmlns="http://www.w3.org/2000/svg">${'<rect width="100" height="100"/>'.repeat(100)}</svg>`,
    text: 'chunk of text\n'.repeat(160),
    big: Buffer.alloc(options.bigBytes ?? 40 * 1024, 0x64),
    aligned: Buffer.alloc(0),
    alignedResponseBytes,
  };
  let alignedBodyBytes = alignedResponseBytes;
  for (;;) {
    const headBytes =
      `HTTP/1.1 200 OK\r\nContent-Type: image/png\r\nDate: Mon, 01 Jan 2024 00:00:00 GMT\r\nContent-Length: ${alignedBodyBytes}\r\n\r\n`
        .length;
    const next = alignedResponseBytes - headBytes;
    if (next === alignedBodyBytes) break;
    alignedBodyBytes = next;
  }
  assets.aligned = Buffer.alloc(alignedBodyBytes, 0x65);
  const hangRequests: IncomingMessage[] = [];
  const localServer = createServer((request, response) => {
    state.localHttpRequest = request;
    if (request.url === '/assets/index.js') {
      response.writeHead(200, { 'Content-Type': 'text/javascript', ETag: '"v1"' });
      response.end(assets.js);
      return;
    }
    if (request.url === '/assets/logo.png') {
      response.writeHead(200, { 'Content-Type': 'image/png' });
      response.end(assets.png);
      return;
    }
    if (request.url === '/assets/logo.svg') {
      response.writeHead(200, {
        'Content-Type': 'image/svg+xml',
        'Cache-Control': 'public, max-age=31536000, immutable',
      });
      response.end(assets.svg);
      return;
    }
    if (request.url === '/assets/partial.txt' && request.headers.range !== undefined) {
      response.writeHead(206, {
        'Content-Type': 'text/plain',
        'Content-Range': 'bytes 0-2047/4096',
      });
      response.end(assets.text);
      return;
    }
    if (request.url === '/assets/big.png') {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        Date: 'Mon, 01 Jan 2024 00:00:00 GMT',
      });
      response.end(assets.big);
      return;
    }
    if (request.url === '/assets/aligned.png') {
      response.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': String(assets.aligned.length),
        Date: 'Mon, 01 Jan 2024 00:00:00 GMT',
      });
      response.end(assets.aligned);
      return;
    }
    if (request.url === '/hang' || request.url === '/hang-upload') {
      hangRequests.push(request);
      request.on('data', () => {});
      request.once('close', () => {
        state.hangClosedCount += 1;
      });
      return;
    }
    let bodyBytes = 0;
    request.on('data', (chunk: Buffer) => {
      bodyBytes += chunk.length;
    });
    request.on('end', () => {
      state.localHttpBodyBytes = bodyBytes;
      uploadBodyBytes.set(request.url ?? '', bodyBytes);
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
    state.localWsRequest = request;
    localWsServer.handleUpgrade(request, socket, head, (ws) =>
      localWsServer.emit('connection', ws, request),
    );
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
  const httpCapabilities: Array<string | null> = [];

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
    state.localWs = ws;
    ws.send('server-hello-frame');
  });
  relayServer.on('upgrade', (request, socket, head) => {
    const upgradeUrl = new URL(request.url!, 'http://relay.test');
    if (upgradeUrl.pathname.endsWith('/v1/remote/http')) {
      httpCapabilities.push(upgradeUrl.searchParams.get('capabilities'));
    }
    const pathname = upgradeUrl.pathname;
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
    localServerToken: options.localServerToken ?? 'local-server-token',
    clientVersion: CLIENT_VERSION,
    urlSource: 'kimi_code_cli',
    relayOrigin: `http://127.0.0.1:${relayPort}/coding-relay`,
    stderr: { write: () => true },
    httpTunnelLimits: options.limits,
  });

  return {
    handle,
    registrations,
    httpCapabilities,
    managementConnections,
    managementMessages,
    httpConnections,
    streamConnections,
    streamMessages,
    uploadBodyBytes,
    hangRequests,
    assets,
    state,
  };
}

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

function requestText(request: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
    request.once('error', reject);
    request.once('end', () => {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
  });
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

function collectJsonMessages(
  socket: WebSocket,
  count: number,
): Promise<Array<Record<string, unknown>>> {
  return new Promise((resolve) => {
    const messages: Array<Record<string, unknown>> = [];
    const onMessage = (data: RawData): void => {
      messages.push(JSON.parse(rawDataText(data)) as Record<string, unknown>);
      if (messages.length < count) return;
      socket.off('message', onMessage);
      resolve(messages);
    };
    socket.on('message', onMessage);
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
