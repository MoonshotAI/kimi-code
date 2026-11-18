import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

import type { RemoteControlDeviceClient, RemoteControlRelayAccess } from '@moonshot-ai/remote-control';
import { WebSocket, type RawData } from 'ws';

import {
  DEVICE_HTTP_TIMEOUT_MS,
  DeviceRequestError,
  HOP_BY_HOP_HEADERS,
  STRIPPED_REQUEST_HEADERS,
  type DeviceHttpRequest,
  type DeviceHttpResponse,
  type DeviceSession,
  type DeviceWsHandlers,
  type DeviceWsSession,
} from './deviceSession';

export type RelayAccessSource = Pick<RemoteControlDeviceClient, 'relayAccess'>;

const DROPPED_REQUEST_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP_HEADERS,
  ...STRIPPED_REQUEST_HEADERS,
  'content-length',
  'accept-encoding',
  'expect',
]);
const DROPPED_RESPONSE_HEADERS: ReadonlySet<string> = new Set([
  ...HOP_BY_HOP_HEADERS,
  'set-cookie',
  'content-encoding',
  'content-length',
]);
const RELAY_GATEWAY_STATUSES: ReadonlySet<number> = new Set([502, 503]);
const WS_HIGH_WATER_BYTES = 1024 * 1024;
const WS_LOW_WATER_BYTES = 256 * 1024;
const WS_HANDSHAKE_TIMEOUT_MS = 15_000;
const WS_RELAY_FAILURE_CODE = 1014;

export function relayDeviceUrl(relayOrigin: string, deviceId: string, path: string): string {
  const url = new URL(relayOrigin);
  const relayPath = url.pathname.replace(/\/+$/, '');
  return `${url.protocol}//${url.host}${relayPath}/devices/${encodeURIComponent(deviceId)}${path}`;
}

export function relayRequestHeaders(headers: IncomingHttpHeaders, cookie: string): Record<string, string> {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || DROPPED_REQUEST_HEADERS.has(lower)) continue;
    forwarded[lower] = Array.isArray(value) ? value.join(', ') : value;
  }
  forwarded['cookie'] = cookie;
  return forwarded;
}

export function relayResponseHeaders(headers: Headers): OutgoingHttpHeaders {
  const forwarded: OutgoingHttpHeaders = {};
  for (const [name, value] of headers) {
    if (!DROPPED_RESPONSE_HEADERS.has(name)) forwarded[name] = value;
  }
  return forwarded;
}

interface RelayWebSocketHost {
  access(): Promise<RemoteControlRelayAccess>;
  renew(stale: RemoteControlRelayAccess): Promise<RemoteControlRelayAccess>;
  connect(access: RemoteControlRelayAccess): WebSocket;
  fail(error: Error): void;
  release(): void;
}

export class RelayDeviceSession implements DeviceSession {
  private closed = false;
  private readonly lifetime = new AbortController();
  private readonly channels = new Set<RelayWebSocketChannel>();

  constructor(
    private readonly deviceId: string,
    private readonly relay: RelayAccessSource,
    private readonly onTransportFailure: (error: Error) => void = () => {},
  ) {}

  async request(req: DeviceHttpRequest): Promise<DeviceHttpResponse> {
    if (this.closed) throw new DeviceRequestError('unavailable', 'device session is closed');
    if (req.signal?.aborted === true) throw new DeviceRequestError('cancelled', 'device request cancelled');
    const timeout = AbortSignal.timeout(req.timeoutMs ?? DEVICE_HTTP_TIMEOUT_MS);
    const signals = [this.lifetime.signal, timeout];
    if (req.signal !== undefined) signals.push(req.signal);
    const signal = AbortSignal.any(signals);
    try {
      let access = await this.relay.relayAccess();
      let response = await this.send(req, access, signal);
      if (response.status === 401) {
        await response.body?.cancel();
        access = await this.renewAccess(access);
        response = await this.send(req, access, signal);
      }
      if (response.status === 401 || RELAY_GATEWAY_STATUSES.has(response.status)) {
        await response.body?.cancel();
        throw this.transportFailure(
          new DeviceRequestError('unavailable', `Remote Control relay responded with HTTP ${String(response.status)}`),
        );
      }
      return {
        status: response.status,
        headers: relayResponseHeaders(response.headers),
        body: Buffer.from(await response.arrayBuffer()),
      };
    } catch (error) {
      throw this.requestError(error, req.signal, timeout);
    }
  }

  openWebSocket(path: string, handlers: DeviceWsHandlers): DeviceWsSession {
    if (this.closed) {
      queueMicrotask(() => {
        handlers.onClose(1001, 'device session is closed');
      });
      return { send() {}, close() {} };
    }
    const channel: RelayWebSocketChannel = new RelayWebSocketChannel(handlers, {
      access: () => this.relay.relayAccess(),
      renew: (stale) => this.renewAccess(stale),
      connect: (access) =>
        new WebSocket(relayDeviceUrl(access.relayOrigin, this.deviceId, path).replace(/^http/, 'ws'), {
          headers: { cookie: access.cookie },
          handshakeTimeout: WS_HANDSHAKE_TIMEOUT_MS,
        }),
      fail: (error) => {
        this.transportFailure(error);
      },
      release: () => {
        this.channels.delete(channel);
      },
    });
    this.channels.add(channel);
    channel.open();
    return channel;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.lifetime.abort();
    for (const channel of this.channels) channel.terminate(1001, 'device connection closed');
    this.channels.clear();
  }

  private send(req: DeviceHttpRequest, access: RemoteControlRelayAccess, signal: AbortSignal): Promise<Response> {
    return fetch(relayDeviceUrl(access.relayOrigin, this.deviceId, req.path), {
      method: req.method,
      headers: relayRequestHeaders(req.headers, access.cookie),
      body: req.body !== undefined && req.body.length > 0 ? new Uint8Array(req.body) : undefined,
      redirect: 'manual',
      signal,
    });
  }

  private async renewAccess(stale: RemoteControlRelayAccess): Promise<RemoteControlRelayAccess> {
    const current = await this.relay.relayAccess();
    return current.cookie === stale.cookie ? this.relay.relayAccess(true) : current;
  }

  private requestError(error: unknown, callerSignal: AbortSignal | undefined, timeout: AbortSignal): DeviceRequestError {
    if (error instanceof DeviceRequestError) return error;
    if (this.closed) return new DeviceRequestError('unavailable', 'device session is closed');
    if (callerSignal?.aborted === true) return new DeviceRequestError('cancelled', 'device request cancelled');
    if (timeout.aborted) return new DeviceRequestError('timeout', 'device request timed out');
    return this.transportFailure(
      new DeviceRequestError('unavailable', `Remote Control relay request failed: ${describeError(error)}`),
    );
  }

  private transportFailure<T extends Error>(error: T): T {
    if (!this.closed) this.onTransportFailure(error);
    return error;
  }
}

class RelayWebSocketChannel implements DeviceWsSession {
  private socket: WebSocket | undefined;
  private readonly queue: string[] = [];
  private queuedBytes = 0;
  private blocked = false;
  private closed = false;
  private reauthenticated = false;

  constructor(
    private readonly handlers: DeviceWsHandlers,
    private readonly host: RelayWebSocketHost,
  ) {}

  open(): void {
    void this.host.access().then(
      (access) => {
        if (!this.closed) this.connect(access);
      },
      (error: unknown) => {
        this.reject(undefined, error);
      },
    );
  }

  private connect(access: RemoteControlRelayAccess): void {
    let socket: WebSocket;
    try {
      socket = this.host.connect(access);
    } catch (error) {
      this.reject(undefined, error);
      return;
    }
    this.socket = socket;
    let opened = false;
    let rejectedStatus: number | undefined;
    let lastError: unknown;
    socket.on('unexpected-response', (_request, response) => {
      rejectedStatus = response.statusCode;
      response.resume();
      socket.terminate();
    });
    socket.on('open', () => {
      opened = true;
      this.flush(socket);
    });
    socket.on('message', (data: RawData) => {
      if (!this.closed) this.handlers.onMessage(rawDataToString(data));
    });
    socket.on('error', (error) => {
      lastError = error;
    });
    socket.on('close', (code, reason) => {
      if (this.closed || this.socket !== socket) return;
      if (opened) {
        this.finish(code, reason.toString('utf8'));
      } else if (rejectedStatus === 401 && !this.reauthenticated) {
        this.reauthenticated = true;
        void this.host.renew(access).then(
          (renewed) => {
            if (!this.closed) this.connect(renewed);
          },
          (error: unknown) => {
            this.reject(undefined, error);
          },
        );
      } else {
        this.reject(rejectedStatus, lastError ?? new Error(`closed with code ${String(code)}`));
      }
    });
  }

  send(data: string): void {
    if (this.closed) return;
    const socket = this.socket;
    if (socket?.readyState === WebSocket.OPEN) {
      socket.send(data, () => {
        this.updateBackpressure();
      });
    } else {
      this.queue.push(data);
      this.queuedBytes += Buffer.byteLength(data);
    }
    this.updateBackpressure();
  }

  close(code?: number, reason?: string): void {
    if (!this.settle()) return;
    const socket = this.socket;
    if (socket?.readyState !== WebSocket.OPEN) {
      socket?.terminate();
      return;
    }
    try {
      socket.close(code !== undefined && sendableCloseCode(code) ? code : 1000, reason);
    } catch {
      socket.terminate();
    }
  }

  terminate(code: number, reason: string): void {
    this.finish(code, reason);
    this.socket?.terminate();
  }

  private flush(socket: WebSocket): void {
    const pending = this.queue.splice(0);
    this.queuedBytes = 0;
    for (const data of pending) {
      socket.send(data, () => {
        this.updateBackpressure();
      });
    }
    this.updateBackpressure();
  }

  private updateBackpressure(): void {
    if (this.closed) return;
    const buffered = this.queuedBytes + (this.socket?.bufferedAmount ?? 0);
    if (!this.blocked && buffered > WS_HIGH_WATER_BYTES) {
      this.blocked = true;
      this.handlers.onBackpressure(true);
    } else if (this.blocked && buffered < WS_LOW_WATER_BYTES) {
      this.blocked = false;
      this.handlers.onBackpressure(false);
    }
  }

  private reject(status: number | undefined, cause: unknown): void {
    if (status === undefined) {
      this.finish(WS_RELAY_FAILURE_CODE, 'Remote Control relay WebSocket failed');
      this.host.fail(new Error(`Remote Control relay WebSocket failed: ${describeError(cause)}`));
      return;
    }
    const reason = `Remote Control relay WebSocket responded with HTTP ${String(status)}`;
    this.finish(WS_RELAY_FAILURE_CODE, reason);
    if (status === 401 || RELAY_GATEWAY_STATUSES.has(status)) this.host.fail(new Error(reason));
  }

  private finish(code: number, reason: string): void {
    if (this.settle()) this.handlers.onClose(code, reason);
  }

  private settle(): boolean {
    if (this.closed) return false;
    this.closed = true;
    this.queue.length = 0;
    this.queuedBytes = 0;
    this.host.release();
    return true;
  }
}

function rawDataToString(data: RawData): string {
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

function sendableCloseCode(code: number): boolean {
  return (code >= 1000 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006) || (code >= 3000 && code <= 4999);
}

function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  return error.cause instanceof Error ? `${error.message} (${error.cause.message})` : error.message;
}
