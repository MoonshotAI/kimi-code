import { createHash } from 'node:crypto';
import { hostname, platform } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, validateHeaderName, validateHeaderValue } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import { gzip } from 'node:zlib';

import {
  createKimiDeviceId,
  FileTokenStorage,
  resolveKimiRemoteControlAuth,
  resolveKimiTokenStorageName,
} from '@moonshot-ai/kimi-code-oauth';
import { WebSocket, type RawData } from 'ws';

import { acquireRemoteControlLock } from './lock';

export const REMOTE_CONTROL_RELAY_ORIGIN = 'https://code-rc.kimi.com';

export const REMOTE_CONTROL_RELAY_URL_ENV = 'KIMI_CODE_REMOTE_CONTROL_RELAY_URL';

export function resolveRemoteControlRelayOrigin(
  env: Readonly<Record<string, string | undefined>> = process.env,
  fallback: string = REMOTE_CONTROL_RELAY_ORIGIN,
): string {
  const value = env[REMOTE_CONTROL_RELAY_URL_ENV]?.trim();
  return value === undefined || value.length === 0 ? fallback : value;
}

const MAX_HTTP_HEADER_BYTES = 64 * 1024;
const MAX_HTTP_REQUEST_BYTES = 104 * 1024 * 1024;
const MAX_RETAINED_HTTP_BYTES = 2 * MAX_HTTP_REQUEST_BYTES;
const HTTP_FRAGMENT_OVERHEAD_BYTES = 1024;
const MAX_SINGLE_FRAME_RESPONSE_BYTES = 10 * 1024 * 1024;
const RESPONSE_CHUNK_BYTES = 5 * 1024 * 1024;
const HTTP_TUNNEL_CAPABILITIES = 'request_chunk,response_chunk,abort';
const HTTP_REQUEST_TIMEOUT_MS = 30_000;
const REGISTER_TIMEOUT_MS = 10_000;
const MAX_RECONNECT_DELAY_MS = 30_000;
const RELAY_PING_INTERVAL_MS = 30_000;
const RELAY_SILENCE_TIMEOUT_MS = 300_000;
const BLOCKED_REQUEST_HEADERS = new Set([
  'authorization',
  'cookie',
  'host',
  'origin',
  'proxy-authorization',
  'proxy-authenticate',
  'accept-encoding',
  'connection',
  'keep-alive',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const BLOCKED_RESPONSE_HEADERS = new Set([
  'connection',
  'content-length',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const GZIP_MIN_BODY_BYTES = 1024;
const GZIP_COMPRESSIBLE_TYPES = new Set([
  'application/javascript',
  'application/json',
  'application/xml',
  'image/svg+xml',
]);
const gzipAsync = promisify(gzip);

interface RelayMessage {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

interface HttpTransfer {
  readonly id: string;
  readonly controller: AbortController;
  chunks: Buffer[] | undefined;
  size: number;
  retained: number;
  frames: (() => string)[];
}

type LocalHttpForward = (
  request: ParsedRawHttpRequest,
  signal: AbortSignal,
  retain: (receivedBytes: number) => boolean,
) => Promise<Buffer[]>;

export interface ParsedRawHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly [string, string][];
  readonly body: readonly Buffer[];
}

export type RemoteControlStatus =
  | 'relay_connected'
  | 'relay_disconnected'
  | 'relay_terminated'
  | 'device_connected'
  | 'device_disconnected';

export type RemoteControlCloseReason = 'local_close' | 'user_requested';

export interface RemoteControlOptions {
  readonly homeDir: string;
  readonly localOrigin: string;
  readonly localServerToken: string | (() => string);
  readonly clientVersion: string;
  readonly urlSource: string;
  readonly relayOrigin?: string;
  readonly configuredOAuthKey?: string;
  readonly configuredOAuthHost?: string;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly onStatus?: (status: RemoteControlStatus) => void;
  readonly pingIntervalMs?: number;
  readonly silenceTimeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface RemoteControlHandle {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly url: string;
  readonly relayOrigin: string;
  readonly closed: Promise<RemoteControlCloseReason>;
  close(): Promise<void>;
}

interface ActiveStream {
  readonly local: WebSocket;
  readonly tunnel: WebSocket;
}

class RegistrationError extends Error {}

export function buildRemoteControlUrl(
  deviceId: string,
  sessionId: string | undefined,
  relayOrigin: string,
  from: string,
): string {
  const url = new URL(relayOrigin);
  const relayPath = url.pathname.replace(/\/+$/, '');
  const devicePath = `${relayPath}/devices/${encodeURIComponent(deviceId)}`;
  url.pathname =
    sessionId === undefined
      ? `${devicePath}/`
      : `${devicePath}/sessions/${encodeURIComponent(sessionId)}`;
  url.search = new URLSearchParams({ rc: '1', from }).toString();
  url.hash = '';
  return url.toString();
}

export function parseRawHttpRequest(chunks: readonly Buffer[]): ParsedRawHttpRequest {
  const prefix = Buffer.concat(sliceChunks(chunks, 0, MAX_HTTP_HEADER_BYTES + 4));
  const separator = prefix.indexOf('\r\n\r\n');
  if (separator < 0 || separator > MAX_HTTP_HEADER_BYTES) {
    throw new SyntaxError('invalid HTTP request headers');
  }
  const head = prefix.subarray(0, separator).toString('latin1');
  const lines = head.split('\r\n');
  const requestLine = lines.shift();
  const match = requestLine?.match(
    /^([!#$%&'*+.^_`|~0-9A-Za-z-]+) (\/[^\u0000-\u0020]*) HTTP\/1\.[01]$/,
  );
  if (match === null || match === undefined || match[2]!.startsWith('//')) {
    throw new SyntaxError('invalid HTTP request line');
  }
  const headers: [string, string][] = [];
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new SyntaxError('invalid HTTP request header');
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    try {
      validateHeaderName(name);
      validateHeaderValue(name, value);
    } catch {
      throw new SyntaxError('invalid HTTP request header');
    }
    headers.push([name, value]);
  }
  return {
    method: match[1]!,
    path: match[2]!,
    headers,
    body: sliceChunks(chunks, separator + 4, Infinity),
  };
}

function sliceChunks(chunks: readonly Buffer[], start: number, end: number): Buffer[] {
  const result: Buffer[] = [];
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= end) break;
    const from = Math.max(start - offset, 0);
    const to = Math.min(end - offset, chunk.length);
    if (from < to) result.push(chunk.subarray(from, to));
    offset += chunk.length;
  }
  return result;
}

export function filterForwardRequestHeaders(
  headers: readonly [string, string][],
  serverToken: string,
): string[] {
  const connectionHeaders = new Set<string>();
  for (const [name, value] of headers) {
    if (name.toLowerCase() === 'connection') {
      for (const token of value.split(',')) connectionHeaders.add(token.trim().toLowerCase());
    }
  }
  const result: string[] = [];
  for (const [name, value] of headers) {
    const lower = name.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(lower) || connectionHeaders.has(lower)) continue;
    result.push(name, value);
  }
  result.push('Authorization', `Bearer ${serverToken}`);
  return result;
}

export function rewriteRemoteControlResponse(
  contentType: string,
  body: Buffer,
  publicPrefix: string,
): Buffer {
  if (!rewritesContentType(contentType)) return body;
  const normalizedPrefix = publicPrefix.replace(/\/+$/, '');
  if (contentType.toLowerCase().includes('text/html')) {
    const prefixLiteral = JSON.stringify(normalizedPrefix);
    const injected = `<script>(function(){var p=${prefixLiteral};try{sessionStorage.setItem('kimi-desktop-server-origin',location.origin+p)}catch(e){}var w=function(f){return function(s,t,u){if(typeof u==='string'&&u.charAt(0)==='/'&&u.indexOf(p)!==0)u=p+u;return f.apply(this,[s,t,u])}};history.pushState=w(history.pushState);history.replaceState=w(history.replaceState)})();</script>`;
    let text = body.toString('utf8');
    const headMatch = /<head(?:\s[^>]*)?>/i.exec(text);
    text =
      headMatch === null
        ? injected + text
        : text.slice(0, headMatch.index + headMatch[0].length) +
          injected +
          text.slice(headMatch.index + headMatch[0].length);
    text = text.replaceAll(/\bsrc="\//g, `src="${normalizedPrefix}/`);
    text = text.replaceAll(/\bhref="\//g, `href="${normalizedPrefix}/`);
    return Buffer.from(text);
  }
  let text = body.toString('utf8');
  text = text.replaceAll('"/assets/', `"${normalizedPrefix}/assets/`);
  text = text.replaceAll("'/assets/", `'${normalizedPrefix}/assets/`);
  text = text.replaceAll('(/assets/', `(${normalizedPrefix}/assets/`);
  text = text.replaceAll('"/sessions/"', `"${normalizedPrefix}/sessions/"`);
  text = text.replaceAll('return"/"+', `return"${normalizedPrefix}/"+`);
  return Buffer.from(text);
}

function rewritesContentType(contentType: string): boolean {
  const lower = contentType.toLowerCase();
  return lower.includes('text/html') || lower.includes('javascript') || lower.includes('text/css');
}

function acceptsGzipEncoding(headers: readonly [string, string][]): boolean {
  let wildcard = false;
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'accept-encoding') continue;
    for (const token of value.split(',')) {
      const [encoding, ...params] = token.trim().toLowerCase().split(';');
      if (encoding !== 'gzip' && encoding !== '*') continue;
      const quality = params.map((param) => param.trim()).find((param) => param.startsWith('q='));
      const acceptable = quality === undefined || Number(quality.slice(2)) > 0;
      if (encoding === 'gzip') return acceptable;
      wildcard = wildcard || acceptable;
    }
  }
  return wildcard;
}

function isGzipCompressibleType(contentType: string): boolean {
  const mime = contentType.split(';', 1)[0]!.trim().toLowerCase();
  return mime.startsWith('text/') || GZIP_COMPRESSIBLE_TYPES.has(mime);
}

function rewrittenResponseETag(body: Buffer): string {
  return `W/"${createHash('sha256').update(body).digest('hex')}"`;
}

function requestMatchesETag(
  headers: readonly [string, string][],
  etag: string,
): boolean {
  const candidates = new Set([etag, etag.replace(/^W\//, '')]);
  for (const [name, value] of headers) {
    if (name.toLowerCase() !== 'if-none-match') continue;
    for (const token of value.split(',')) {
      const candidate = token.trim();
      if (candidate === '*') return true;
      if (candidates.has(candidate)) return true;
    }
  }
  return false;
}

export async function startRemoteControl(
  options: RemoteControlOptions,
): Promise<RemoteControlHandle> {
  const localServerToken =
    typeof options.localServerToken === 'function'
      ? options.localServerToken
      : () => options.localServerToken as string;
  if (localServerToken().length === 0) {
    throw new Error('Remote Control requires local server authentication.');
  }
  const auth = resolveKimiRemoteControlAuth({
    configuredOAuthHost: options.configuredOAuthHost,
    configuredOAuthKey: options.configuredOAuthKey,
    homeDir: options.homeDir,
  });
  const storage = new FileTokenStorage(join(options.homeDir, 'credentials'));
  const token = await storage.load(resolveKimiTokenStorageName({ oauthKey: auth.oauthKey }));
  if (token?.refreshToken === undefined || token.refreshToken.length === 0) {
    throw new Error('Remote Control requires a Kimi login. Run `kimi login` first.');
  }
  const relayOrigin =
    options.relayOrigin ?? resolveRemoteControlRelayOrigin(process.env, auth.relayOrigin);
  const deviceId = createKimiDeviceId(options.homeDir);
  const deviceName = hostname();
  const url = buildRemoteControlUrl(deviceId, undefined, relayOrigin, options.urlSource);
  const lock = await acquireRemoteControlLock(options.homeDir, {
    localOrigin: options.localOrigin.replace(/\/+$/, ''),
    deviceId,
    url,
  });
  const tokenAfterLock = await storage.load(resolveKimiTokenStorageName({ oauthKey: auth.oauthKey }));
  if (tokenAfterLock?.refreshToken !== token.refreshToken) {
    await lock.release();
    throw new Error('Remote Control requires a Kimi login. Run `kimi login` first.');
  }
  const client = new RemoteControlClient({
    ...options,
    localServerToken,
    relayOrigin,
    deviceId,
    refreshToken: token.refreshToken,
  });
  const abortStart = () => {
    void client.close();
  };
  options.signal?.addEventListener('abort', abortStart, { once: true });
  try {
    options.signal?.throwIfAborted();
    await client.start();
  } catch (error) {
    await lock.release();
    throw error;
  } finally {
    options.signal?.removeEventListener('abort', abortStart);
  }
  const closed = client.closed.then(async (reason) => {
    await lock.release();
    return reason;
  });
  return {
    deviceId,
    deviceName,
    url,
    relayOrigin,
    closed,
    close: async () => {
      await client.close();
      await closed;
    },
  };
}

class RemoteControlClient {
  private readonly localOrigin: string;
  private readonly localServerToken: () => string;
  private readonly clientVersion: string;
  private readonly relayOrigin: string;
  private readonly deviceId: string;
  private readonly refreshToken: string;
  private readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
  private readonly onStatus: (status: RemoteControlStatus) => void;
  private readonly streams = new Map<string, ActiveStream>();
  private readonly pendingSockets = new Set<WebSocket>();
  private management: WebSocket | undefined;
  private reconnectAbort: AbortController | undefined;
  private http: WebSocket | undefined;
  private httpTunnel: HttpTunnel | undefined;
  private reconnectAttempt = 0;
  private reconnectImmediately = false;
  private readonly pingIntervalMs: number;
  private readonly silenceTimeoutMs: number;
  private stopped = false;
  private userRequested = false;
  private connected = false;
  private relayOnline = false;
  private runPromise: Promise<void> | undefined;
  private initialResolve: (() => void) | undefined;
  private initialReject: ((error: unknown) => void) | undefined;

  constructor(
    options: Omit<RemoteControlOptions, 'localServerToken'> & {
      readonly localServerToken: () => string;
      readonly relayOrigin: string;
      readonly deviceId: string;
      readonly refreshToken: string;
    },
  ) {
    this.localOrigin = options.localOrigin.replace(/\/+$/, '');
    this.localServerToken = options.localServerToken;
    this.clientVersion = options.clientVersion;
    this.relayOrigin = options.relayOrigin;
    this.deviceId = options.deviceId;
    this.refreshToken = options.refreshToken;
    this.stderr = options.stderr ?? process.stderr;
    this.onStatus = options.onStatus ?? (() => {});
    this.pingIntervalMs = options.pingIntervalMs ?? RELAY_PING_INTERVAL_MS;
    this.silenceTimeoutMs = options.silenceTimeoutMs ?? RELAY_SILENCE_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    const initial = new Promise<void>((resolve, reject) => {
      this.initialResolve = resolve;
      this.initialReject = reject;
    });
    this.runPromise = this.run();
    await initial;
  }

  get closed(): Promise<RemoteControlCloseReason> {
    return (this.runPromise ?? Promise.resolve()).then(() =>
      this.userRequested ? 'user_requested' : 'local_close',
    );
  }

  async close(): Promise<void> {
    if (this.stopped) {
      await this.runPromise;
      return;
    }
    this.stopped = true;
    if (!this.connected) this.rejectInitial(new Error('Remote Control closed before ready.'));
    if (this.management?.readyState === WebSocket.OPEN) {
      this.management.send(
        JSON.stringify({ type: 'disconnect', payload: { reason: 'local_server_stopped' } }),
      );
    }
    this.closeCycle();
    this.reconnectAbort?.abort();
    await this.runPromise;
  }

  private async run(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.serveCycle();
      } catch (error) {
        if (error instanceof RegistrationError) {
          if (!this.connected) {
            this.rejectInitial(error);
            this.stopped = true;
            return;
          }
          this.stderr.write(`${error.message}\n`);
        } else if (!this.stopped && !this.reconnectImmediately) {
          this.stderr.write(`Remote Control disconnected: ${errorMessage(error)}\n`);
        }
      } finally {
        this.closeCycle();
      }
      if (this.stopped) {
        if (!this.connected) this.rejectInitial(new Error('Remote Control stopped before ready.'));
        return;
      }
      if (this.reconnectImmediately) {
        this.reconnectImmediately = false;
        continue;
      }
      this.reconnectAttempt += 1;
      const delay = Math.min(
        MAX_RECONNECT_DELAY_MS,
        1000 * 2 ** Math.min(this.reconnectAttempt - 1, 5),
      );
      await this.waitForReconnect(delay);
    }
  }

  private async serveCycle(): Promise<void> {
    const management = await this.connectRelay('/v1/remote/create');
    this.management = management;
    this.watchSocket(management, 'management');
    management.send(
      JSON.stringify({
        type: 'register',
        payload: {
          device_id: this.deviceId,
          alias: hostname(),
          platform: platform(),
          client_version: this.clientVersion,
          local_base_url: this.localOrigin,
        },
      }),
    );
    const registration = await waitForRelayMessage(management, REGISTER_TIMEOUT_MS);
    if (registration.type === 'register_nak') {
      const code = stringField(registration.payload, 'error_code') ?? 'REGISTRATION_REJECTED';
      const message = stringField(registration.payload, 'error_message') ?? 'registration rejected';
      throw new RegistrationError(`Remote Control registration failed (${code}): ${message}`);
    }
    if (registration.type !== 'register_ack') {
      throw new Error(`Remote Control expected register_ack, received ${registration.type}`);
    }

    const managementEnd = waitForSocketEnd(management);
    const http = await this.connectRelay(
      `/v1/remote/http?device_id=${encodeURIComponent(this.deviceId)}&capabilities=${HTTP_TUNNEL_CAPABILITIES}`,
    );
    this.http = http;
    const tunnel = new HttpTunnel(
      http,
      (request, signal, retain) =>
        requestLocalHttp(
          this.localOrigin,
          request,
          this.localServerToken(),
          this.publicPrefix(),
          signal,
          retain,
        ),
      this.stderr,
    );
    this.httpTunnel = tunnel;
    this.watchSocket(http, 'http');
    if (management.readyState !== WebSocket.OPEN) {
      throw new Error('management connection closed');
    }
    management.on('message', (data) => this.handleManagementMessage(data));
    http.on('message', (data) => tunnel.handleMessage(data));
    this.reconnectAttempt = 0;
    this.relayOnline = true;
    this.onStatus('relay_connected');

    if (!this.connected) {
      this.connected = true;
      this.initialResolve?.();
      this.initialResolve = undefined;
      this.initialReject = undefined;
    }

    await Promise.race([managementEnd, waitForSocketEnd(http)]);
    if (!this.stopped) throw new Error('relay connection closed');
  }

  private connectRelay(path: string): Promise<WebSocket> {
    return connectWebSocket(
      relayWebSocketUrl(this.relayOrigin, path),
      this.refreshToken,
      undefined,
      undefined,
      this.pendingSockets,
      () => this.stopped,
    );
  }

  private watchSocket(socket: WebSocket, label: string): void {
    const pingTimer = setInterval(() => {
      if (socket.readyState === WebSocket.OPEN) socket.ping();
    }, this.pingIntervalMs);
    pingTimer.unref();
    let silenceTimer: NodeJS.Timeout | undefined;
    const armSilenceTimer = (): void => {
      if (silenceTimer !== undefined) clearTimeout(silenceTimer);
      silenceTimer = setTimeout(() => {
        this.stderr.write(
          `Remote Control ${label} connection silent for ${Math.round(this.silenceTimeoutMs / 1000)}s; reconnecting…\n`,
        );
        socket.terminate();
      }, this.silenceTimeoutMs);
      silenceTimer.unref();
    };
    armSilenceTimer();
    socket.on('message', armSilenceTimer);
    socket.on('ping', armSilenceTimer);
    socket.on('pong', armSilenceTimer);
    socket.once('close', () => {
      clearInterval(pingTimer);
      if (silenceTimer !== undefined) clearTimeout(silenceTimer);
    });
  }

  private rejectInitial(error: Error): void {
    this.initialReject?.(error);
    this.initialReject = undefined;
    this.initialResolve = undefined;
  }

  private handleManagementMessage(data: RawData): void {
    let message: RelayMessage;
    try {
      message = parseRelayMessage(data);
    } catch (error) {
      this.stderr.write(`Remote Control message error: ${errorMessage(error)}\n`);
      return;
    }
    if (message.type === 'open_ws') {
      void this.openStream(message.payload ?? {});
      return;
    }
    if (message.type === 'close_ws') {
      const streamId = stringField(message.payload, 'stream_id');
      if (streamId !== undefined) this.closeStream(streamId);
      return;
    }
    if (message.type === 'disconnect') {
      const reason = stringField(message.payload, 'reason');
      if (reason === 'user_requested') {
        this.stopped = true;
        this.userRequested = true;
      }
      if (reason === 'server_shutting_down') this.reconnectImmediately = true;
      this.closeCycle();
    }
  }

  private async openStream(payload: Record<string, unknown>): Promise<void> {
    const streamId = stringField(payload, 'stream_id');
    const path = stringField(payload, 'path');
    if (streamId === undefined || path === undefined || !path.startsWith('/') || path.startsWith('//')) {
      if (streamId !== undefined) {
        this.sendOpenStreamResult(streamId, false, 'LOCAL_WS_FAILED', 'invalid local WebSocket path');
      }
      return;
    }

    let local: WebSocket | undefined;
    let tunnel: WebSocket | undefined;
    const earlyLocalFrames: [RawData, boolean][] = [];
    try {
      local = await connectWebSocket(
        localWebSocketUrl(this.localOrigin, path),
        this.localServerToken(),
        relayHeaders(payload['headers']),
        earlyLocalFrames,
        this.pendingSockets,
        () => this.stopped,
      );
      tunnel = await this.connectRelay(`/v1/remote/stream/${encodeURIComponent(streamId)}`);
      if (this.stopped || this.management?.readyState !== WebSocket.OPEN) {
        throw new Error('management connection closed');
      }
      this.streams.set(streamId, { local, tunnel });
      this.onStatus('device_connected');
      bridgeSockets(
        local,
        tunnel,
        () => {
          if (this.streams.get(streamId)?.local === local) {
            this.streams.delete(streamId);
            this.onStatus('device_disconnected');
          }
        },
        earlyLocalFrames,
      );
      this.sendOpenStreamResult(streamId, true);
    } catch (error) {
      local?.close();
      tunnel?.close();
      this.sendOpenStreamResult(
        streamId,
        false,
        local === undefined ? 'LOCAL_WS_FAILED' : 'TUNNEL_STREAM_FAILED',
        errorMessage(error),
      );
    }
  }

  private sendOpenStreamResult(
    streamId: string,
    success: boolean,
    errorCode?: string,
    error?: string,
  ): void {
    if (this.management?.readyState !== WebSocket.OPEN) return;
    this.management.send(
      JSON.stringify({
        type: 'open_ws_result',
        payload: {
          stream_id: streamId,
          success,
          error_code: errorCode,
          error_message: error,
        },
      }),
    );
  }

  private closeStream(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream === undefined) return;
    this.streams.delete(streamId);
    this.onStatus('device_disconnected');
    stream.local.close();
    stream.tunnel.close();
  }

  private closeCycle(): void {
    for (const streamId of this.streams.keys()) this.closeStream(streamId);
    this.httpTunnel?.close();
    for (const socket of this.pendingSockets) socket.terminate();
    this.pendingSockets.clear();
    this.management?.close();
    this.http?.close();
    if (this.relayOnline) {
      this.relayOnline = false;
      this.onStatus(this.userRequested ? 'relay_terminated' : 'relay_disconnected');
    }
    this.management = undefined;
    this.http = undefined;
    this.httpTunnel = undefined;
  }

  private publicPrefix(): string {
    const relayPath = new URL(this.relayOrigin).pathname.replace(/\/+$/, '');
    return `${relayPath}/devices/${encodeURIComponent(this.deviceId)}`;
  }

  private async waitForReconnect(ms: number): Promise<void> {
    if (this.stopped) return;
    const controller = new AbortController();
    this.reconnectAbort = controller;
    try {
      await sleep(ms, undefined, { signal: controller.signal });
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'AbortError') throw error;
    } finally {
      if (this.reconnectAbort === controller) this.reconnectAbort = undefined;
    }
  }
}

export class HttpTunnel {
  private readonly transfers = new Map<string, HttpTransfer>();
  private readonly ready = new Set<HttpTransfer>();
  private retainedBytes = 0;
  private pumping = false;

  constructor(
    private readonly socket: WebSocket,
    private readonly forwardLocal: LocalHttpForward,
    private readonly stderr: Pick<NodeJS.WriteStream, 'write'>,
  ) {}

  handleMessage(data: RawData): void {
    if (this.socket.readyState !== WebSocket.OPEN) return;
    const text = rawDataText(data).trim();
    if (text.length === 0) return;
    let receiving: HttpTransfer | undefined;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const requestId = typeof parsed['request_id'] === 'string' ? parsed['request_id'] : undefined;
      if (parsed['type'] === 'abort') {
        const aborted = requestId === undefined ? undefined : this.transfers.get(requestId);
        if (aborted !== undefined) this.end(aborted);
        return;
      }
      if (parsed['type'] !== 'request') return;
      if (requestId === undefined) throw new SyntaxError('invalid HTTP tunnel request message');
      const transfer = this.transfers.get(requestId) ?? this.open(requestId);
      const chunks = transfer.chunks;
      if (chunks === undefined) {
        throw new Error(`HTTP tunnel request ${requestId} is no longer accepting chunks`);
      }
      receiving = transfer;
      const bodyBase64 = parsed['body_base64'];
      if (typeof bodyBase64 !== 'string' || typeof parsed['is_last'] !== 'boolean') {
        throw new SyntaxError('invalid HTTP tunnel request message');
      }
      const minDecodedBytes = Math.floor(bodyBase64.length / 4) * 3 - 2;
      if (transfer.size + minDecodedBytes > MAX_HTTP_REQUEST_BYTES) {
        throw new SyntaxError(
          `HTTP tunnel request exceeds ${MAX_HTTP_REQUEST_BYTES / 1024 / 1024} MiB`,
        );
      }
      const chunk = decodeBase64(bodyBase64);
      if (transfer.size + chunk.length > MAX_HTTP_REQUEST_BYTES) {
        throw new SyntaxError(
          `HTTP tunnel request exceeds ${MAX_HTTP_REQUEST_BYTES / 1024 / 1024} MiB`,
        );
      }
      if (!this.tryRetain(transfer, transfer.retained + chunk.length + HTTP_FRAGMENT_OVERHEAD_BYTES)) {
        throw new SyntaxError(
          `HTTP tunnel retained bytes exceed ${MAX_RETAINED_HTTP_BYTES / 1024 / 1024} MiB`,
        );
      }
      chunks.push(chunk);
      transfer.size += chunk.length;
      if (!parsed['is_last']) return;
      transfer.chunks = undefined;
      void this.forward(transfer, chunks);
    } catch (error) {
      if (receiving !== undefined) {
        this.respond(receiving, [buildErrorResponse(error instanceof SyntaxError ? 400 : 502)]);
      }
      this.stderr.write(`Remote Control HTTP message error: ${errorMessage(error)}\n`);
    }
  }

  close(): void {
    for (const transfer of this.transfers.values()) this.end(transfer);
  }

  private open(id: string): HttpTransfer {
    const transfer: HttpTransfer = {
      id,
      controller: new AbortController(),
      chunks: [],
      size: 0,
      retained: 0,
      frames: [],
    };
    this.transfers.set(id, transfer);
    return transfer;
  }

  private async forward(transfer: HttpTransfer, chunks: readonly Buffer[]): Promise<void> {
    const requestBytes = transfer.retained;
    try {
      const response = await this.forwardLocal(
        parseRawHttpRequest(chunks),
        transfer.controller.signal,
        (receivedBytes) => this.tryRetain(transfer, requestBytes + receivedBytes),
      );
      this.respond(transfer, response);
    } catch (error) {
      if (transfer.controller.signal.aborted) return;
      const status =
        error instanceof ResponseBudgetExceededError
          ? 503
          : error instanceof SyntaxError
            ? 400
            : 502;
      this.respond(transfer, [buildErrorResponse(status)]);
      this.stderr.write(`Remote Control HTTP forwarding failed: ${errorMessage(error)}\n`);
    }
  }

  private respond(transfer: HttpTransfer, response: readonly Buffer[]): void {
    if (transfer.controller.signal.aborted) return;
    transfer.chunks = undefined;
    this.retain(transfer, byteLength(response));
    transfer.frames = responseFrames(transfer.id, response);
    this.ready.add(transfer);
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const transfer = this.ready.values().next().value;
        if (transfer === undefined) return;
        this.ready.delete(transfer);
        const frame = transfer.frames.shift()!;
        if (!(await sendFrame(this.socket, frame()))) {
          this.socket.terminate();
          this.close();
          return;
        }
        if (transfer.frames.length > 0) this.ready.add(transfer);
        else this.end(transfer);
      }
    } finally {
      this.pumping = false;
    }
  }

  private tryRetain(transfer: HttpTransfer, bytes: number): boolean {
    if (transfer.controller.signal.aborted) return false;
    const total = this.retainedBytes - transfer.retained + bytes;
    if (bytes > transfer.retained && total > MAX_RETAINED_HTTP_BYTES) return false;
    this.retain(transfer, bytes);
    return true;
  }

  private retain(transfer: HttpTransfer, bytes: number): void {
    this.retainedBytes += bytes - transfer.retained;
    transfer.retained = bytes;
  }

  private end(transfer: HttpTransfer): void {
    if (this.transfers.get(transfer.id) !== transfer) return;
    this.transfers.delete(transfer.id);
    this.ready.delete(transfer);
    this.retain(transfer, 0);
    transfer.chunks = undefined;
    transfer.frames = [];
    transfer.controller.abort();
  }
}

function responseFrames(requestId: string, response: readonly Buffer[]): (() => string)[] {
  const length = byteLength(response);
  const frame =
    (type: string, isLast: boolean, start: number, end: number) =>
    (): string =>
      JSON.stringify({
        request_id: requestId,
        type,
        is_last: isLast,
        body_base64: Buffer.concat(sliceChunks(response, start, end)).toString('base64'),
      });
  if (length <= MAX_SINGLE_FRAME_RESPONSE_BYTES) return [frame('response', true, 0, length)];
  const frames: (() => string)[] = [];
  for (let offset = 0; offset <= length; offset += RESPONSE_CHUNK_BYTES) {
    const end = Math.min(offset + RESPONSE_CHUNK_BYTES, length);
    frames.push(frame('response_chunk', end - offset < RESPONSE_CHUNK_BYTES, offset, end));
  }
  return frames;
}

function byteLength(chunks: readonly Buffer[]): number {
  return chunks.reduce((total, chunk) => total + chunk.length, 0);
}

function sendFrame(socket: WebSocket, data: string): Promise<boolean> {
  return new Promise((resolve) => {
    socket.send(data, (error) => resolve(error === undefined || error === null));
  });
}

async function connectWebSocket(
  url: string,
  token: string,
  headers: Record<string, string> = {},
  earlyFrames?: [RawData, boolean][],
  pendingSockets?: Set<WebSocket>,
  isStopped?: () => boolean,
): Promise<WebSocket> {
  const protocol = `kimi-code.bearer.${token}`;
  if (isWebSocketProtocolToken(protocol)) {
    try {
      return await connectWebSocketAttempt(url, [protocol], headers, earlyFrames, pendingSockets);
    } catch (error) {
      if (isStopped?.() === true) throw error;
    }
  }
  return connectWebSocketAttempt(
    url,
    undefined,
    {
      ...headers,
      Authorization: `Bearer ${token}`,
    },
    earlyFrames,
    pendingSockets,
  );
}

function connectWebSocketAttempt(
  url: string,
  protocols: string[] | undefined,
  headers: Record<string, string>,
  earlyFrames?: [RawData, boolean][],
  pendingSockets?: Set<WebSocket>,
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, {
      headers,
      handshakeTimeout: REGISTER_TIMEOUT_MS,
    });
    pendingSockets?.add(socket);
    if (earlyFrames !== undefined) {
      socket.on('message', (data, isBinary) => {
        earlyFrames.push([data, isBinary]);
      });
    }
    let settled = false;
    const cleanup = (): void => {
      socket.off('open', onOpen);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      cleanup();
      pendingSockets?.delete(socket);
      if (error === undefined) resolve(socket);
      else reject(error);
    };
    const onOpen = (): void => finish();
    const onError = (error: Error) => finish(error);
    const onClose = (code: number, reason: Buffer) => {
      finish(new Error(`WebSocket closed during handshake (${code} ${reason.toString()})`));
    };
    socket.once('open', onOpen);
    socket.once('error', onError);
    socket.once('close', onClose);
  });
}

function isWebSocketProtocolToken(value: string): boolean {
  return /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(value);
}

function waitForRelayMessage(socket: WebSocket, timeoutMs: number): Promise<RelayMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('Remote Control registration timed out')), timeoutMs);
    const onMessage = (data: RawData): void => {
      try {
        finish(undefined, parseRelayMessage(data));
      } catch (error) {
        finish(error);
      }
    };
    const onClose = (code: number, reason: Buffer): void => {
      finish(new Error(`Remote Control registration closed (${code} ${reason.toString()})`));
    };
    const onError = (error: Error): void => finish(error);
    const finish = (error?: unknown, message?: RelayMessage): void => {
      clearTimeout(timer);
      socket.off('message', onMessage);
      socket.off('close', onClose);
      socket.off('error', onError);
      if (error !== undefined) reject(error);
      else resolve(message!);
    };
    socket.once('message', onMessage);
    socket.once('close', onClose);
    socket.once('error', onError);
  });
}

function waitForSocketEnd(socket: WebSocket): Promise<void> {
  return new Promise((resolve) => {
    socket.once('close', () => resolve());
    socket.once('error', () => resolve());
  });
}

function parseRelayMessage(data: RawData): RelayMessage {
  const parsed = JSON.parse(rawDataText(data)) as Record<string, unknown>;
  if (typeof parsed['type'] !== 'string') throw new Error('relay message has no type');
  const payload = isRecord(parsed['payload']) ? parsed['payload'] : undefined;
  return { type: parsed['type'], payload };
}

class ResponseBudgetExceededError extends Error {}

function requestLocalHttp(
  localOrigin: string,
  parsed: ParsedRawHttpRequest,
  serverToken: string,
  publicPrefix: string,
  signal: AbortSignal,
  retain: (receivedBytes: number) => boolean,
): Promise<Buffer[]> {
  const origin = new URL(localOrigin);
  const headers = [...filterForwardRequestHeaders(parsed.headers, serverToken), 'Host', origin.host];
  const bodyBytes = byteLength(parsed.body);
  const declaresLength = headers.some(
    (value, index) => index % 2 === 0 && value.toLowerCase() === 'content-length',
  );
  if (bodyBytes > 0 && !declaresLength) headers.push('Content-Length', String(bodyBytes));
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port,
        method: parsed.method,
        path: parsed.path,
        headers,
        timeout: HTTP_REQUEST_TIMEOUT_MS,
        signal,
      },
      (localResponse) => {
        const chunks: Buffer[] = [];
        let receivedBytes = 0;
        localResponse.on('data', (chunk: Buffer | string) => {
          const buffer = Buffer.from(chunk);
          receivedBytes += buffer.length;
          if (!retain(receivedBytes)) {
            reject(new ResponseBudgetExceededError('remote control response byte budget exceeded'));
            request.destroy();
            return;
          }
          chunks.push(buffer);
        });
        localResponse.once('error', reject);
        localResponse.once('end', () => {
          void (async (): Promise<Buffer[]> => {
            const statusCode = localResponse.statusCode ?? 502;
            const statusMessage = localResponse.statusMessage ?? 'Bad Gateway';
            const responseHead = (headers: readonly string[]): Buffer =>
              Buffer.from(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n${headerLines(headers)}\r\n\r\n`);
            const contentType = localResponse.headers['content-type'] ?? '';
            const transformable =
              localResponse.headers['content-encoding'] === undefined &&
              (rewritesContentType(contentType) || isGzipCompressibleType(contentType));
            if (!transformable) {
              const headers = filterResponseHeaders(localResponse.rawHeaders);
              headers.push('Content-Length', String(receivedBytes));
              return [responseHead(headers), ...chunks];
            }
            const receivedBody = Buffer.concat(chunks);
            let body =
              localResponse.headers['content-encoding'] === undefined
                ? rewriteRemoteControlResponse(contentType, receivedBody, publicPrefix)
                : receivedBody;
            const rewritten = body !== receivedBody;
            const headers = filterResponseHeaders(localResponse.rawHeaders, rewritten);
            if (rewritten) {
              const etag = rewrittenResponseETag(body);
              headers.push('Cache-Control', 'no-cache', 'ETag', etag);
              const revalidatable =
                (parsed.method === 'GET' || parsed.method === 'HEAD') &&
                statusCode >= 200 &&
                statusCode < 300;
              if (revalidatable && requestMatchesETag(parsed.headers, etag)) {
                return [Buffer.from(`HTTP/1.1 304 Not Modified\r\n${headerLines(headers)}\r\n\r\n`)];
              }
            }
            const negotiated =
              localResponse.headers['content-encoding'] === undefined &&
              localResponse.statusCode !== 206 &&
              body.length >= GZIP_MIN_BODY_BYTES &&
              isGzipCompressibleType(contentType);
            if (negotiated) {
              let varyCovers = false;
              for (let index = 0; index < headers.length; index += 2) {
                if (headers[index]!.toLowerCase() !== 'vary') continue;
                const tokens = new Set(headers[index + 1]!
                  .toLowerCase()
                  .split(',')
                  .map((token) => token.trim()));
                if (tokens.has('*') || tokens.has('accept-encoding')) varyCovers = true;
              }
              if (!varyCovers) headers.push('Vary', 'Accept-Encoding');
            }
            if (negotiated && acceptsGzipEncoding(parsed.headers)) {
              body = await gzipAsync(body);
              headers.push('Content-Encoding', 'gzip');
            }
            headers.push('Content-Length', String(body.length));
            return [responseHead(headers), body];
          })().then(resolve, reject);
        });
      },
    );
    request.once('timeout', () => request.destroy(new Error('local HTTP request timed out')));
    request.once('error', reject);
    for (const chunk of parsed.body) request.write(chunk);
    request.end();
  });
}

function filterResponseHeaders(rawHeaders: readonly string[], blockCacheValidators = false): string[] {
  const connectionHeaders = new Set<string>();
  for (let index = 0; index < rawHeaders.length; index += 2) {
    if (rawHeaders[index]!.toLowerCase() === 'connection') {
      for (const token of rawHeaders[index + 1]!.split(',')) {
        connectionHeaders.add(token.trim().toLowerCase());
      }
    }
  }
  const result: string[] = [];
  for (let index = 0; index < rawHeaders.length; index += 2) {
    const name = rawHeaders[index]!;
    const lower = name.toLowerCase();
    if (BLOCKED_RESPONSE_HEADERS.has(lower) || connectionHeaders.has(lower)) {
      continue;
    }
    if (
      blockCacheValidators &&
      (lower === 'cache-control' || lower === 'etag' || lower === 'last-modified')
    ) {
      continue;
    }
    result.push(name, rawHeaders[index + 1]!);
  }
  return result;
}

function relayHeaders(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  const entries: [string, string][] = [];
  for (const [name, raw] of Object.entries(value)) {
    if (typeof raw !== 'string') continue;
    const lower = name.toLowerCase();
    if (BLOCKED_REQUEST_HEADERS.has(lower)) continue;
    try {
      validateHeaderName(name);
      validateHeaderValue(name, raw);
      entries.push([name, raw]);
    } catch {}
  }
  return Object.fromEntries(entries);
}

function bridgeSockets(
  left: WebSocket,
  right: WebSocket,
  onClose: () => void,
  earlyLeftFrames?: [RawData, boolean][],
): void {
  let closed = false;
  const closeBoth = (code = 1000, reason = Buffer.alloc(0)): void => {
    if (closed) return;
    closed = true;
    onClose();
    const safeCode = isValidCloseCode(code) ? code : 1000;
    if (left.readyState === WebSocket.OPEN) left.close(safeCode, reason);
    if (right.readyState === WebSocket.OPEN) right.close(safeCode, reason);
  };
  if (earlyLeftFrames !== undefined) {
    left.removeAllListeners('message');
    for (const [data, isBinary] of earlyLeftFrames) {
      if (right.readyState === WebSocket.OPEN) right.send(data, { binary: isBinary });
    }
  }
  left.on('message', (data, isBinary) => {
    if (right.readyState === WebSocket.OPEN) right.send(data, { binary: isBinary });
  });
  right.on('message', (data, isBinary) => {
    if (left.readyState === WebSocket.OPEN) left.send(data, { binary: isBinary });
  });
  left.once('close', closeBoth);
  right.once('close', closeBoth);
  left.once('error', () => closeBoth(1011));
  right.once('error', () => closeBoth(1011));
}

function isValidCloseCode(code: number): boolean {
  return (
    code === 1000 ||
    code === 1001 ||
    code === 1002 ||
    code === 1003 ||
    (code >= 1007 && code <= 1014) ||
    (code >= 3000 && code <= 4999)
  );
}

function relayWebSocketUrl(origin: string, path: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  const relayPath = url.pathname.replace(/\/+$/, '');
  const [pathname, query] = path.split('?', 2);
  url.pathname = `${relayPath}${pathname}`;
  url.search = query === undefined ? '' : query;
  url.hash = '';
  return url.toString();
}

function localWebSocketUrl(origin: string, path: string): string {
  const url = new URL(origin);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.pathname = path.split('?', 1)[0]!;
  const query = path.includes('?') ? path.slice(path.indexOf('?') + 1) : '';
  url.search = query;
  url.hash = '';
  return url.toString();
}

function headerLines(headers: readonly string[]): string {
  let result = '';
  for (let index = 0; index < headers.length; index += 2) {
    result += `${headers[index]}: ${headers[index + 1]}\r\n`;
  }
  return result.replace(/\r\n$/, '');
}

function buildErrorResponse(status: number): Buffer {
  const reason =
    status === 400 ? 'Bad Request' : status === 503 ? 'Service Unavailable' : 'Bad Gateway';
  return Buffer.from(`HTTP/1.1 ${status} ${reason}\r\nContent-Length: 0\r\n\r\n`);
}

function stringField(
  value: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const field = value?.[key];
  return typeof field === 'string' ? field : undefined;
}

function decodeBase64(value: string): Buffer {
  if (value.length % 4 !== 0) {
    throw new SyntaxError('invalid HTTP tunnel request base64');
  }
  let paddingStart = -1;
  for (let i = 0; i < value.length; i++) {
    const c = value.codePointAt(i)!;
    if (c === 0x3d) {
      if (paddingStart === -1) paddingStart = i;
      continue;
    }
    if (paddingStart !== -1) {
      throw new SyntaxError('invalid HTTP tunnel request base64');
    }
    const ok =
      (c >= 0x41 && c <= 0x5a) ||
      (c >= 0x61 && c <= 0x7a) ||
      (c >= 0x30 && c <= 0x39) ||
      c === 0x2b ||
      c === 0x2f;
    if (!ok) {
      throw new SyntaxError('invalid HTTP tunnel request base64');
    }
  }
  if (paddingStart !== -1 && value.length - paddingStart > 2) {
    throw new SyntaxError('invalid HTTP tunnel request base64');
  }
  return Buffer.from(value, 'base64');
}

function rawDataText(data: RawData): string {
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
