/**
 * Remote Control boundary scenarios — validates protocol codecs, localhost URL/header isolation,
 * device tunnel lifecycle, stream bridging, and reconnect behavior through DI-resolved services.
 * OAuth and network transports are stubbed; protocol helpers and the Node bridge are real.
 * Run with: pnpm --filter @moonshot-ai/agent-core-v2 exec vitest run test/app/remoteControl/remoteControl.test.ts
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocketServer } from 'ws';

import { DisposableStore, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { createServices, type TestInstantiationService } from '#/_base/di/test';
import { ILogService } from '#/_base/log/log';
import { IOAuthService } from '#/app/auth/auth';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import {
  BAD_GATEWAY_RESPONSE,
  HttpRequestAssembler,
  parseRawHttpRequest,
  resolveLocalUrl,
  sanitizeForwardHeaders,
  type HttpTunnelMessage,
  type LocalHttpRequest,
} from '#/app/remoteControl/protocol';
import { IRemoteControlService } from '#/app/remoteControl/remoteControl';
import { RemoteControlService } from '#/app/remoteControl/remoteControlService';
import {
  IRemoteControlTransport,
  type LocalHttpResponse,
  type RemoteSocket,
  type RemoteSocketBridge,
} from '#/app/remoteControl/remoteControlTransport';
import { RemoteControlTransportService } from '#/app/remoteControl/remoteControlTransportService';
import { stubLog } from '../../_base/log/stubs';

class FakeSocket implements RemoteSocket {
  readonly sent: Array<string | Buffer> = [];
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  closed = false;
  private readonly messages = new Set<(data: Buffer, binary: boolean) => void>();
  private readonly closes = new Set<(code: number, reason: string) => void>();
  private readonly errors = new Set<(error: Error) => void>();
  private readonly pings = new Set<(data: Buffer) => void>();
  private readonly pongs = new Set<(data: Buffer) => void>();

  send(data: string | Buffer): void { this.sent.push(data); }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = true;
    this.closeCalls.push({ code, reason });
    for (const listener of this.closes) listener(code, reason);
  }
  ping(data = Buffer.alloc(0)): void { for (const listener of this.pings) listener(data); }
  pong(data = Buffer.alloc(0)): void { for (const listener of this.pongs) listener(data); }
  onMessage(listener: (data: Buffer, binary: boolean) => void): IDisposable {
    this.messages.add(listener); return toDisposable(() => this.messages.delete(listener));
  }
  onClose(listener: (code: number, reason: string) => void): IDisposable {
    this.closes.add(listener); return toDisposable(() => this.closes.delete(listener));
  }
  onError(listener: (error: Error) => void): IDisposable {
    this.errors.add(listener); return toDisposable(() => this.errors.delete(listener));
  }
  onPing(listener: (data: Buffer) => void): IDisposable {
    this.pings.add(listener); return toDisposable(() => this.pings.delete(listener));
  }
  onPong(listener: (data: Buffer) => void): IDisposable {
    this.pongs.add(listener); return toDisposable(() => this.pongs.delete(listener));
  }
  emit(value: unknown): void {
    const data = Buffer.from(JSON.stringify(value));
    for (const listener of this.messages) listener(data, false);
  }
  emitClose(code = 1000, reason = ''): void {
    this.closed = true;
    for (const listener of this.closes) listener(code, reason);
  }
  dispose(): void { this.closed = true; }
}

class FakeBridge implements RemoteSocketBridge {
  readonly closeCalls: Array<{ code: number; reason: string }> = [];
  private readonly listeners = new Set<() => void>();

  close(code = 1000, reason = ''): void {
    this.closeCalls.push({ code, reason });
    this.emitClose();
  }
  onClose(listener: () => void): IDisposable {
    this.listeners.add(listener);
    return toDisposable(() => { this.listeners.delete(listener); });
  }
  emitClose(): void {
    for (const listener of this.listeners) listener();
    this.listeners.clear();
  }
  dispose(): void { this.close(); }
}

class FakeTransport implements IRemoteControlTransport {
  readonly _serviceBrand = undefined;
  readonly management = new FakeSocket();
  readonly http = new FakeSocket();
  readonly order: string[] = [];
  readonly bridges: FakeBridge[] = [];
  local = new FakeSocket();
  tunnel = new FakeSocket();
  response: LocalHttpResponse = responseOf(200, [Buffer.from('ok')]);
  managementError = false;
  forwardError = false;
  localError = false;
  tunnelError = false;
  bridgeError = false;
  forwarded: Array<{ request: LocalHttpRequest; token: string }> = [];

  connectManagement(): Promise<RemoteSocket> {
    this.order.push('management');
    return this.managementError
      ? Promise.reject(new Error('relay unavailable'))
      : Promise.resolve(this.management);
  }
  connectHttpTunnel(): Promise<RemoteSocket> { this.order.push('http'); return Promise.resolve(this.http); }
  connectTunnelStream(): Promise<RemoteSocket> {
    this.order.push('tunnel');
    return this.tunnelError ? Promise.reject(new Error('tunnel failed')) : Promise.resolve(this.tunnel);
  }
  connectLocalWebSocket(): Promise<RemoteSocket> {
    this.order.push('local');
    return this.localError ? Promise.reject(new Error('local failed')) : Promise.resolve(this.local);
  }
  forwardLocalHttp(_base: string, request: LocalHttpRequest, token: string): Promise<LocalHttpResponse> {
    this.forwarded.push({ request, token });
    return this.forwardError ? Promise.reject(new Error('local unavailable')) : Promise.resolve(this.response);
  }
  bridgeWebSockets(): RemoteSocketBridge {
    this.order.push('bridge');
    if (this.bridgeError) throw new Error('bridge failed');
    const bridge = new FakeBridge();
    this.bridges.push(bridge);
    return bridge;
  }
}

function responseOf(statusCode: number, chunks: Buffer[], streaming = false): LocalHttpResponse {
  return {
    statusCode,
    statusMessage: statusCode === 200 ? 'OK' : 'Error',
    headers: { 'content-type': streaming ? 'text/event-stream' : 'application/json' },
    streaming,
    body: (async function* () { for (const chunk of chunks) yield chunk; })(),
  };
}

function sentJson(socket: FakeSocket): unknown[] {
  return socket.sent.map((value) => JSON.parse(value.toString()));
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('remote control protocol', () => {
  it('assembles concurrent request fragments and strips remote credentials', () => {
    const assembler = new HttpRequestAssembler();
    const part = (requestId: string, raw: string, isLast: boolean): HttpTunnelMessage => ({
      request_id: requestId,
      type: 'request',
      is_last: isLast,
      body_base64: Buffer.from(raw).toString('base64'),
    });
    expect(assembler.push(part('a', 'POST /a HTTP/1.1\r\nAuthorization: Bearer remote\r\nContent-Length: 3\r\n\r\n', false))).toBeUndefined();
    const requestB = assembler.push(part('b', 'GET /b?q=1 HTTP/1.1\r\nConnection: close\r\n\r\n', true));
    const requestA = assembler.push(part('a', 'abc', true));
    expect(requestB).toMatchObject({ method: 'GET', path: '/b?q=1', headers: {} });
    expect(requestA).toMatchObject({ method: 'POST', path: '/a', headers: {}, body: Buffer.from('abc') });
  });

  it('rejects malformed raw HTTP requests', () => {
    expect(() => parseRawHttpRequest(Buffer.from('not HTTP'))).toThrow();
  });

  it('uses the protocol-defined empty 502 response', () => {
    expect(BAD_GATEWAY_RESPONSE.toString()).toBe(
      'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n',
    );
  });
});

describe('remote control localhost boundary', () => {
  it('resolves a rooted path within the local origin', () => {
    expect(resolveLocalUrl('http://127.0.0.1:4321', '/api/v1/sessions?q=1').href).toBe(
      'http://127.0.0.1:4321/api/v1/sessions?q=1',
    );
  });

  it.each(['https://example.test/steal', '//example.test/steal', 'api/v1/sessions'])(
    'rejects non-local path %s before forwarding',
    (path) => {
      expect(() => resolveLocalUrl('http://127.0.0.1:4321', path)).toThrow();
    },
  );

  it('strips Origin and WebSocket handshake headers before localhost forwarding', () => {
    expect(sanitizeForwardHeaders({
      Origin: 'https://remote.example.test',
      Authorization: 'Bearer remote',
      'Sec-WebSocket-Key': 'remote-key',
      'Sec-WebSocket-Extensions': 'permessage-deflate',
      'Sec-WebSocket-Protocol': 'remote-protocol',
      'Sec-WebSocket-Version': '13',
      'User-Agent': 'browser',
    })).toEqual({ 'User-Agent': 'browser' });
  });

  it('rejects an absolute WebSocket URL before opening a socket', () => {
    const transport = new RemoteControlTransportService();
    expect(() => transport.connectLocalWebSocket(
      'http://127.0.0.1:4321',
      'https://example.test/steal',
      {},
      'local-token',
      new AbortController().signal,
    )).toThrow();
    transport.dispose();
  });

  it('rejects an absolute HTTP URL before attaching the local token', () => {
    const transport = new RemoteControlTransportService();
    expect(() => transport.forwardLocalHttp(
      'http://127.0.0.1:4321',
      { method: 'GET', path: 'https://example.test/steal', headers: {}, body: Buffer.alloc(0) },
      'local-token',
      new AbortController().signal,
    )).toThrow();
    transport.dispose();
  });

  it('closes both bridge sockets with the requested code and reason', () => {
    const transport = new RemoteControlTransportService();
    const local = new FakeSocket();
    const tunnel = new FakeSocket();
    const bridge = transport.bridgeWebSockets(local, tunnel);
    bridge.close(4001, 'browser_closed');
    expect(local.closeCalls).toEqual([{ code: 4001, reason: 'browser_closed' }]);
    expect(tunnel.closeCalls).toEqual([{ code: 4001, reason: 'browser_closed' }]);
    transport.dispose();
  });
});

describe('remote control relay transport', () => {
  it('connects relay sockets under the base URL mount prefix', async () => {
    const upgrades: Array<{ url: string | undefined; authorization: string | undefined }> = [];
    const wss = new WebSocketServer({ noServer: true });
    const httpServer = createServer();
    httpServer.on('upgrade', (req, socket, head) => {
      upgrades.push({ url: req.url, authorization: req.headers.authorization });
      wss.handleUpgrade(req, socket, head, (ws) => { wss.emit('connection', ws, req); });
    });
    await new Promise<void>((resolve) => { httpServer.listen(0, '127.0.0.1', resolve); });
    try {
      const address = httpServer.address();
      if (address === null || typeof address === 'string') throw new Error('listener has no port');
      const transport = new RemoteControlTransportService();
      const socket = await transport.connectManagement(
        `http://127.0.0.1:${String(address.port)}/coding-relay`,
        'relay-token',
        new AbortController().signal,
      );
      expect(upgrades).toEqual([{
        url: '/coding-relay/v1/remote/create',
        authorization: 'Bearer relay-token',
      }]);
      socket.dispose();
      transport.dispose();
    } finally {
      wss.close();
      await new Promise<void>((resolve) => { httpServer.close(() => { resolve(); }); });
    }
  });
});

describe('Remote Control service lifecycle', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let transport: FakeTransport;
  let homeDir: string;
  let service: IRemoteControlService;
  const localToken = 'local-secret';
  const deviceToken = 'device-secret';

  beforeEach(async () => {
    disposables = new DisposableStore();
    transport = new FakeTransport();
    homeDir = await mkdtemp(join(tmpdir(), 'remote-control-test-'));
    ix = createServices(disposables, {
      additionalServices: (reg) => {
        reg.defineInstance(IRemoteControlTransport, transport);
        reg.definePartialInstance(IOAuthService, {
          getCachedAccessToken: () => Promise.resolve(deviceToken),
        });
        reg.definePartialInstance(IBootstrapService, {
          homeDir,
          platform: 'darwin',
          clientIdentity: { productName: 'test-host', version: '1.2.3', platform: 'test_platform' },
        });
        reg.definePartialInstance(IFlagService, { enabled: () => true });
        reg.defineInstance(ILogService, stubLog());
        reg.define(IRemoteControlService, RemoteControlService);
      },
      strict: true,
    });
    service = ix.get(IRemoteControlService);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    disposables.dispose();
    await rm(homeDir, { recursive: true, force: true });
  });

  function options() {
    return {
      relayBaseUrl: 'https://relay.example.test',
      localBaseUrl: 'http://127.0.0.1:4321',
      alias: 'test-device',
      getLocalToken: () => localToken,
    };
  }

  async function startAndAck(): Promise<void> {
    await service.start(options());
    transport.management.emit({ type: 'register_ack', payload: { success: true } });
    await flushMicrotasks();
  }

  it('sends device metadata without embedding the OAuth token when registration starts', async () => {
    await service.start(options());
    const register = sentJson(transport.management)[0] as { payload: Record<string, string> };
    expect(register.payload).toMatchObject({
      alias: 'test-device',
      platform: 'darwin',
      client_version: '1.2.3',
      local_base_url: 'http://127.0.0.1:4321',
    });
    expect(JSON.stringify(register)).not.toContain(deviceToken);
  });

  it('enters online after registration opens the HTTP tunnel', async () => {
    const states: string[] = [];
    service.onDidChangeState((state) => states.push(state));
    await startAndAck();
    expect(service.state).toBe('online');
    expect(states).toEqual(['connecting', 'online']);
  });

  it('opens only one HTTP tunnel when register_ack is repeated', async () => {
    await service.start(options());
    transport.management.emit({ type: 'register_ack', payload: { success: true } });
    transport.management.emit({ type: 'register_ack', payload: { success: true } });
    await flushMicrotasks();
    expect(transport.order.filter((step) => step === 'http')).toHaveLength(1);
  });

  it('forwards a reassembled HTTP upload with only the local credential', async () => {
    await startAndAck();
    const raw = 'POST /api/test HTTP/1.1\r\nAuthorization: Bearer remote\r\n\r\nbody';
    transport.http.emit({
      request_id: 'r1', type: 'request', is_last: true,
      body_base64: Buffer.from(raw).toString('base64'),
    });
    await flushMicrotasks();
    expect(transport.forwarded[0]).toMatchObject({ token: localToken });
    expect(transport.forwarded[0]!.request.headers).toEqual({});
  });

  it('emits response chunks when localhost returns a streaming response', async () => {
    transport.response = responseOf(200, [Buffer.from('one'), Buffer.from('two')], true);
    await startAndAck();
    transport.http.emit({
      request_id: 'r1', type: 'request', is_last: true,
      body_base64: Buffer.from('GET /events HTTP/1.1\r\n\r\n').toString('base64'),
    });
    await flushMicrotasks();
    const messages = sentJson(transport.http) as HttpTunnelMessage[];
    expect(messages.map((message) => [message.type, message.is_last])).toEqual([
      ['response_chunk', false],
      ['response_chunk', false],
      ['response_chunk', false],
      ['response_chunk', true],
    ]);
  });

  it('returns a synthetic 502 when localhost forwarding fails', async () => {
    transport.forwardError = true;
    await startAndAck();
    transport.http.emit({
      request_id: 'r2', type: 'request', is_last: true,
      body_base64: Buffer.from('GET / HTTP/1.1\r\n\r\n').toString('base64'),
    });
    await flushMicrotasks();
    const response = sentJson(transport.http)[0] as HttpTunnelMessage;
    expect(Buffer.from(response.body_base64, 'base64')).toEqual(BAD_GATEWAY_RESPONSE);
  });

  it('opens the relay stream before localhost when handling open_ws', async () => {
    await startAndAck();
    transport.management.emit({
      type: 'open_ws',
      payload: { stream_id: 's1', path: '/api/v1/ws', headers: { Authorization: 'remote' } },
    });
    await flushMicrotasks();
    expect(transport.order.slice(-3)).toEqual(['tunnel', 'local', 'bridge']);
  });

  it.each([
    ['localError', 'LOCAL_WS_FAILED'],
    ['tunnelError', 'TUNNEL_STREAM_FAILED'],
    ['bridgeError', 'UNKNOWN'],
  ] as const)('reports %s as %s when stream setup fails', async (failure, errorCode) => {
    transport[failure] = true;
    await startAndAck();
    transport.management.emit({
      type: 'open_ws', payload: { stream_id: 'failed', path: '/api/v1/ws', headers: {} },
    });
    await flushMicrotasks();
    expect(sentJson(transport.management).at(-1)).toMatchObject({
      type: 'open_ws_result',
      payload: { stream_id: 'failed', success: false, error_code: errorCode },
    });
  });

  it('passes relay close code and reason to the active stream bridge', async () => {
    await startAndAck();
    transport.management.emit({
      type: 'open_ws', payload: { stream_id: 's1', path: '/api/v1/ws', headers: {} },
    });
    await flushMicrotasks();
    transport.management.emit({
      type: 'close_ws',
      payload: { stream_id: 's1', close_code: 4001, reason: 'browser_closed' },
    });
    await flushMicrotasks();
    expect(transport.bridges[0]!.closeCalls).toEqual([{ code: 4001, reason: 'browser_closed' }]);
  });

  it('forgets a stream after the bridge closes naturally', async () => {
    await startAndAck();
    transport.management.emit({
      type: 'open_ws', payload: { stream_id: 's1', path: '/api/v1/ws', headers: {} },
    });
    await flushMicrotasks();
    transport.bridges[0]!.emitClose();
    transport.management.emit({
      type: 'close_ws', payload: { stream_id: 's1', reason: 'browser_closed' },
    });
    await flushMicrotasks();
    expect(transport.bridges[0]!.closeCalls).toEqual([]);
  });

  it('resolves offline when the first relay connection is temporarily unavailable', async () => {
    transport.managementError = true;
    await expect(service.start(options())).resolves.toBeUndefined();
    expect(service.state).toBe('offline');
  });

  it('rejects an invalid relay URL before starting the tunnel', async () => {
    await expect(service.start({ ...options(), relayBaseUrl: 'not a URL' })).rejects.toThrow();
    expect(transport.order).toEqual([]);
  });

  it('sends local_server_stopped when the service stops', async () => {
    await startAndAck();
    await service.stop('local_server_stopped');
    expect(sentJson(transport.management).at(-1)).toEqual({
      type: 'disconnect', payload: { reason: 'local_server_stopped' },
    });
  });

  it('closes the management channel when an invalid message arrives', async () => {
    await service.start(options());
    transport.management.emit({ type: 'unknown' });
    expect(transport.management.closed).toBe(true);
  });

  it('does not log credentials when an invalid message arrives', async () => {
    const log = ix.get(ILogService);
    const warn = vi.spyOn(log, 'warn');
    await service.start(options());
    transport.management.emit({ type: 'unknown', token: deviceToken });
    expect(JSON.stringify(warn.mock.calls)).not.toContain(deviceToken);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(localToken);
  });
});
