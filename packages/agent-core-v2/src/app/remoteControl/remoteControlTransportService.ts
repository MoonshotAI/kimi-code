/**
 * `remoteControl` domain — Node HTTP and WebSocket transport implementation.
 *
 * Owns relay and localhost sockets at App scope and releases pending IO on disposal.
 */

import http, { type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import https from 'node:https';

import { WebSocket } from 'ws';

import { Disposable, combinedDisposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';

import { resolveLocalUrl, sanitizeForwardHeaders, type LocalHttpRequest } from './protocol';
import {
  IRemoteControlTransport,
  type LocalHttpResponse,
  type RemoteSocket,
  type RemoteSocketBridge,
} from './remoteControlTransport';

const BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export class RemoteControlTransportService extends Disposable implements IRemoteControlTransport {
  declare readonly _serviceBrand: undefined;
  private readonly sockets = new Set<NodeRemoteSocket>();

  connectManagement(base: string, token: string, signal: AbortSignal): Promise<RemoteSocket> {
    return this.connectRelay(base, '/v1/remote/create', token, signal);
  }

  connectHttpTunnel(base: string, token: string, deviceId: string, signal: AbortSignal): Promise<RemoteSocket> {
    // The relay binds the tunnel to the registered device via the `device_id`
    // query parameter; without it the socket is dropped right after upgrade.
    return this.connectRelay(
      base,
      `/v1/remote/http?device_id=${encodeURIComponent(deviceId)}`,
      token,
      signal,
    );
  }

  connectTunnelStream(
    base: string,
    streamId: string,
    token: string,
    signal: AbortSignal,
  ): Promise<RemoteSocket> {
    return this.connectRelay(base, `/v1/remote/stream/${encodeURIComponent(streamId)}`, token, signal);
  }

  connectLocalWebSocket(
    base: string,
    path: string,
    headers: Readonly<Record<string, string>>,
    localToken: string,
    signal: AbortSignal,
  ): Promise<RemoteSocket> {
    const url = resolveLocalUrl(base, path);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return this.connectSocket(
      url,
      [`${BEARER_PROTOCOL_PREFIX}${localToken}`],
      {
        ...sanitizeForwardHeaders(headers),
        Authorization: `Bearer ${localToken}`,
      },
      signal,
    );
  }

  forwardLocalHttp(
    base: string,
    request: LocalHttpRequest,
    localToken: string,
    signal: AbortSignal,
  ): Promise<LocalHttpResponse> {
    const url = resolveLocalUrl(base, request.path);
    const requestFn = url.protocol === 'https:' ? https.request : http.request;
    return new Promise((resolve, reject) => {
      const req = requestFn(
        url,
        {
          method: request.method,
          headers: {
            ...sanitizeForwardHeaders(request.headers),
            authorization: `Bearer ${localToken}`,
            'content-length': String(request.body.byteLength),
          },
          signal,
        },
        (response) => { resolve(toLocalHttpResponse(response)); },
      );
      req.once('error', reject);
      if (request.body.byteLength > 0) req.write(request.body);
      req.end();
    });
  }

  bridgeWebSockets(local: RemoteSocket, tunnel: RemoteSocket): RemoteSocketBridge {
    let closed = false;
    let subscriptions: IDisposable | undefined;
    const listeners = new Set<() => void>();
    const closeBoth = (code = 1000, reason = ''): void => {
      if (closed) return;
      closed = true;
      local.close(code, reason);
      tunnel.close(code, reason);
      subscriptions?.dispose();
      for (const listener of listeners) listener();
      listeners.clear();
    };
    subscriptions = combinedDisposable(
      local.onMessage((data, binary) => { tunnel.send(data, binary); }),
      tunnel.onMessage((data, binary) => { local.send(data, binary); }),
      local.onPing((data) => { tunnel.ping(data); }),
      tunnel.onPing((data) => { local.ping(data); }),
      local.onPong((data) => { tunnel.pong(data); }),
      tunnel.onPong((data) => { local.pong(data); }),
      local.onClose(closeBoth),
      tunnel.onClose(closeBoth),
    );
    return {
      close: closeBoth,
      onClose: (listener) => {
        if (closed) {
          listener();
          return toDisposable(() => {});
        }
        listeners.add(listener);
        return toDisposable(() => { listeners.delete(listener); });
      },
      dispose: closeBoth,
    };
  }

  override dispose(): void {
    for (const socket of this.sockets) socket.dispose();
    this.sockets.clear();
    super.dispose();
  }

  private connectRelay(
    base: string,
    path: string,
    token: string,
    signal: AbortSignal,
  ): Promise<RemoteSocket> {
    // `path` is origin-absolute (`/v1/remote/...`), so `new URL(path, base)`
    // would discard any mount prefix in the base URL (e.g. `/coding-relay`).
    // Splice the relay paths under the base pathname instead.
    const rel = new URL(path, 'http://relay.invalid');
    const url = new URL(base);
    url.pathname = `${url.pathname.replace(/\/+$/, '')}${rel.pathname}`;
    url.search = rel.search;
    url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
    // The relay authenticates via the standard Authorization header; the bearer
    // subprotocol convention is only for the localhost hop, where the local
    // server echoes the protocol and the `ws` client requires that echo.
    return this.connectSocket(url, [], { Authorization: `Bearer ${token}` }, signal);
  }

  private async connectSocket(
    url: URL,
    protocols: string[],
    headers: Readonly<Record<string, string>>,
    signal: AbortSignal,
  ): Promise<RemoteSocket> {
    const ws = new WebSocket(url, protocols, { headers, autoPong: false });
    const socket = new NodeRemoteSocket(ws, () => this.sockets.delete(socket));
    this.sockets.add(socket);
    try {
      await waitForOpen(ws, signal);
      return socket;
    } catch (error) {
      socket.dispose();
      throw error;
    }
  }
}

class NodeRemoteSocket implements RemoteSocket {
  private disposed = false;

  constructor(
    private readonly ws: WebSocket,
    private readonly onDispose: () => void,
  ) {}

  send(data: string | Buffer, binary = Buffer.isBuffer(data)): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data, { binary });
  }

  close(code = 1000, reason = ''): void {
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
    }
  }

  ping(data?: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.ping(data);
  }

  pong(data?: Buffer): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.pong(data);
  }

  onMessage(listener: (data: Buffer, binary: boolean) => void): IDisposable {
    const handler = (data: WebSocket.RawData, binary: boolean): void => {
      listener(toBuffer(data), binary);
    };
    this.ws.on('message', handler);
    return toDisposable(() => this.ws.off('message', handler));
  }

  onClose(listener: (code: number, reason: string) => void): IDisposable {
    const handler = (code: number, reason: Buffer): void => {
      listener(code, reason.toString());
    };
    this.ws.on('close', handler);
    return toDisposable(() => this.ws.off('close', handler));
  }

  onError(listener: (error: Error) => void): IDisposable {
    this.ws.on('error', listener);
    return toDisposable(() => this.ws.off('error', listener));
  }

  onPing(listener: (data: Buffer) => void): IDisposable {
    this.ws.on('ping', listener);
    return toDisposable(() => this.ws.off('ping', listener));
  }

  onPong(listener: (data: Buffer) => void): IDisposable {
    this.ws.on('pong', listener);
    return toDisposable(() => this.ws.off('pong', listener));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.onDispose();
    this.ws.terminate();
  }
}

function waitForOpen(ws: WebSocket, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = (): void => {
      ws.off('open', onOpen);
      ws.off('error', onError);
      signal.removeEventListener('abort', onAbort);
    };
    const onOpen = (): void => { cleanup(); resolve(); };
    const onError = (error: Error): void => { cleanup(); reject(error); };
    const onAbort = (): void => { cleanup(); reject(signal.reason ?? new Error('aborted')); };
    if (signal.aborted) {
      onAbort();
      return;
    }
    ws.once('open', onOpen);
    ws.once('error', onError);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function toLocalHttpResponse(response: IncomingMessage): LocalHttpResponse {
  const headers = normalizeHeaders(response.headers);
  const contentType = response.headers['content-type'] ?? '';
  const streaming = contentType.toLowerCase().includes('text/event-stream') ||
    response.headers['transfer-encoding'] !== undefined;
  return {
    statusCode: response.statusCode ?? 502,
    statusMessage: response.statusMessage ?? 'Bad Gateway',
    headers,
    streaming,
    body: response as AsyncIterable<Buffer>,
  };
}

function normalizeHeaders(
  headers: IncomingHttpHeaders,
): Record<string, string | readonly string[] | undefined> {
  return { ...headers };
}

function toBuffer(data: WebSocket.RawData): Buffer {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data);
}

registerScopedService(
  LifecycleScope.App,
  IRemoteControlTransport,
  RemoteControlTransportService,
  ScopeActivation.OnDemand,
  'remoteControl',
);
