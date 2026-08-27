import { hostname, platform } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest, validateHeaderName, validateHeaderValue } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  createKimiDeviceId,
  FileTokenStorage,
  KIMI_CODE_PROVIDER_NAME,
  resolveKimiTokenStorageName,
} from '@moonshot-ai/kimi-code-oauth';
import { WebSocket, type RawData } from 'ws';
import chalk from 'chalk';

import { getVersion } from '../../version';
import { darkColors } from '../../../tui/theme/colors';
import { supportsHyperlinks, toTerminalHyperlink } from '../../../utils/terminal-hyperlink';
import { acquireRemoteControlLock } from './remote-control-lock';

export const REMOTE_CONTROL_RELAY_ORIGIN = 'https://code-rc.kimi.com';

export const REMOTE_CONTROL_FLAG_ENV = 'KIMI_CODE_EXPERIMENTAL_REMOTE_CONTROL';

const TRUTHY_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);

export function isRemoteControlEnabled(
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const truthy = (key: string): boolean =>
    TRUTHY_ENV_VALUES.has((env[key] ?? '').trim().toLowerCase());
  return truthy('KIMI_CODE_EXPERIMENTAL_FLAG') || truthy(REMOTE_CONTROL_FLAG_ENV);
}

const MAX_HTTP_HEADER_BYTES = 64 * 1024;
const MAX_HTTP_REQUEST_BYTES = 10 * 1024 * 1024;
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

interface RelayMessage {
  readonly type: string;
  readonly payload?: Record<string, unknown>;
}

interface PendingHttpRequest {
  readonly chunks: Buffer[];
  size: number;
}

export interface ParsedRawHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: readonly [string, string][];
  readonly body: Buffer;
}

export type RemoteControlStatus =
  | 'relay_connected'
  | 'relay_disconnected'
  | 'device_connected'
  | 'device_disconnected';

export interface RemoteControlOptions {
  readonly homeDir: string;
  readonly localOrigin: string;
  readonly localServerToken: string;
  readonly relayOrigin?: string;
  readonly stderr?: Pick<NodeJS.WriteStream, 'write'>;
  readonly onStatus?: (status: RemoteControlStatus) => void;
  readonly pingIntervalMs?: number;
  readonly silenceTimeoutMs?: number;
}

export interface RemoteControlHandle {
  readonly deviceId: string;
  readonly deviceName: string;
  readonly url: string;
  close(): Promise<void>;
}

interface ActiveStream {
  readonly local: WebSocket;
  readonly tunnel: WebSocket;
}

class RegistrationError extends Error {}

export interface RemoteControlOutputOptions {
  readonly url: string;
  readonly localOrigin: string;
  readonly deviceName: string;
  readonly qrCode: string;
  readonly pngPath: string;
}

export function formatRemoteControlOutput(options: RemoteControlOutputOptions): string {
  const title = (text: string): string => chalk.bold.hex(darkColors.primary)(text);
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const accent = (text: string): string => chalk.hex(darkColors.accent)(text);
  const muted = (text: string): string => chalk.hex(darkColors.textMuted)(text);
  const status = (text: string): string => chalk.hex(darkColors.success)(text);
  const link = (url: string): string =>
    supportsHyperlinks()
      ? toTerminalHyperlink(accent(shortRemoteControlUrl(url)), url)
      : accent(url);
  const docs = toTerminalHyperlink('docs', 'https://kimi.com/code/docs/remote-control');
  const feedback = toTerminalHyperlink('feedback', 'https://kimi.com/code/feedback');
  return [
    '',
    `  ${title('Kimi Remote Control ready')}  ${muted(`${getVersion()} (experimental)`)}`,
    `  ${muted('Use Kimi Code on this machine from your phone or another computer.')}`,
    '',
    `  ${label('1.')} Scan the QR code, or open ${link(options.url)}`,
    `  ${label('2.')} Log in with your Kimi account`,
    `  ${label('3.')} Start chatting — sessions run on this machine`,
    '',
    `  ${status('✓')} ${muted(`Connected to ${new URL(options.url).host}, waiting for remote devices…`)}`,
    `  ${label('This device: ')}${muted(options.deviceName)}`,
    `  ${status('⚠')} ${muted('This link grants control of this machine. Do not share it.')}`,
    '',
    options.qrCode.trimEnd().replaceAll(/^/gm, '    '),
    `  ${label('QR code PNG: ')}${options.pngPath} ${muted('(open this if the QR above does not scan)')}`,
    `  ${label('Local UI: ')}${muted(options.localOrigin)} ${muted('(LAN: --host)')}`,
    '',
    `  ${muted('Experimental —')} ${docs} ${muted('·')} ${feedback}`,
    `  ${label('Logs: ')}${muted('off (--log-level info)')} ${muted('·')} ${label('Stop: ')}${muted('Ctrl+C')}`,
    '',
  ].join('\n');
}

export function formatRemoteControlStatus(status: RemoteControlStatus): string {
  const label = (text: string): string => chalk.bold.hex(darkColors.textDim)(text);
  const value = (text: string): string => chalk.hex(darkColors.success)(text);
  switch (status) {
    case 'relay_connected':
      return `  ${value('✓')} ${label('Connected to relay, waiting for remote devices…')}\n`;
    case 'relay_disconnected':
      return `  ${value('!')} ${label('Relay disconnected; reconnecting…')}\n`;
    case 'device_connected':
      return `  ${value('✓')} ${label('Remote device connected (1 active session)')}\n`;
    case 'device_disconnected':
      return `  ${value('→')} ${label('Remote device disconnected')}\n`;
  }
}

function shortRemoteControlUrl(url: string): string {
  const parsed = new URL(url);
  const parts = parsed.pathname.split('/');
  const deviceIndex = parts.indexOf('devices');
  const deviceId = deviceIndex >= 0 ? parts[deviceIndex + 1] : undefined;
  if (deviceId !== undefined && deviceId.length > 12) {
    parts[deviceIndex + 1] = `${deviceId.slice(0, 6)}…${deviceId.slice(-4)}`;
  }
  return `${parsed.host}${parts.join('/')}`;
}

export function buildRemoteControlUrl(
  deviceId: string,
  sessionId?: string,
  relayOrigin = REMOTE_CONTROL_RELAY_ORIGIN,
): string {
  const url = new URL(relayOrigin);
  const relayPath = url.pathname.replace(/\/+$/, '');
  const devicePath = `${relayPath}/devices/${encodeURIComponent(deviceId)}`;
  url.pathname =
    sessionId === undefined
      ? `${devicePath}/`
      : `${devicePath}/sessions/${encodeURIComponent(sessionId)}`;
  url.search = new URLSearchParams({ rc: '1', from: 'kimi_code_cli' }).toString();
  url.hash = '';
  return url.toString();
}

export function parseRawHttpRequest(raw: Buffer): ParsedRawHttpRequest {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 0 || separator > MAX_HTTP_HEADER_BYTES) {
    throw new SyntaxError('invalid HTTP request headers');
  }
  const head = raw.subarray(0, separator).toString('latin1');
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
    body: raw.subarray(separator + 4),
  };
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
  const lower = contentType.toLowerCase();
  if (lower.includes('javascript') || lower.includes('text/css')) {
    let text = body.toString('utf8');
    text = text.replaceAll('"/assets/', `"${normalizedPrefix}/assets/`);
    text = text.replaceAll("'/assets/", `'${normalizedPrefix}/assets/`);
    text = text.replaceAll('(/assets/', `(${normalizedPrefix}/assets/`);
    text = text.replaceAll('"/sessions/"', `"${normalizedPrefix}/sessions/"`);
    text = text.replaceAll('return"/"+', `return"${normalizedPrefix}/"+`);
    return Buffer.from(text);
  }
  return body;
}

export async function startRemoteControl(
  options: RemoteControlOptions,
): Promise<RemoteControlHandle> {
  if (options.localServerToken.length === 0) {
    throw new Error('Remote Control requires local server authentication.');
  }
  const storage = new FileTokenStorage(join(options.homeDir, 'credentials'));
  const token = await storage.load(
    resolveKimiTokenStorageName({ providerName: KIMI_CODE_PROVIDER_NAME }),
  );
  if (token?.refreshToken === undefined || token.refreshToken.length === 0) {
    throw new Error('Remote Control requires a Kimi login. Run `kimi login` first.');
  }
  const relayOrigin = options.relayOrigin ?? REMOTE_CONTROL_RELAY_ORIGIN;
  const deviceId = createKimiDeviceId(options.homeDir);
  const deviceName = hostname();
  const url = buildRemoteControlUrl(deviceId, undefined, relayOrigin);
  const lock = await acquireRemoteControlLock(options.homeDir, {
    localOrigin: options.localOrigin.replace(/\/+$/, ''),
    deviceId,
    url,
  });
  const client = new RemoteControlClient({
    ...options,
    relayOrigin,
    deviceId,
    refreshToken: token.refreshToken,
  });
  try {
    await client.start();
  } catch (error) {
    await lock.release();
    throw error;
  }
  return {
    deviceId,
    deviceName,
    url,
    close: async () => {
      await client.close();
      await lock.release();
    },
  };
}

class RemoteControlClient {
  private readonly localOrigin: string;
  private readonly localServerToken: string;
  private readonly relayOrigin: string;
  private readonly deviceId: string;
  private readonly refreshToken: string;
  private readonly stderr: Pick<NodeJS.WriteStream, 'write'>;
  private readonly onStatus: (status: RemoteControlStatus) => void;
  private readonly streams = new Map<string, ActiveStream>();
  private readonly pendingHttpRequests = new Map<string, PendingHttpRequest>();
  private management: WebSocket | undefined;
  private reconnectAbort: AbortController | undefined;
  private http: WebSocket | undefined;
  private pendingHttpBytes = 0;
  private reconnectAttempt = 0;
  private reconnectImmediately = false;
  private readonly pingIntervalMs: number;
  private readonly silenceTimeoutMs: number;
  private stopped = false;
  private connected = false;
  private relayOnline = false;
  private runPromise: Promise<void> | undefined;
  private initialResolve: (() => void) | undefined;
  private initialReject: ((error: unknown) => void) | undefined;

  constructor(
    options: RemoteControlOptions & {
      readonly relayOrigin: string;
      readonly deviceId: string;
      readonly refreshToken: string;
    },
  ) {
    this.localOrigin = options.localOrigin.replace(/\/+$/, '');
    this.localServerToken = options.localServerToken;
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
          client_version: `kimi-code/${getVersion()}`,
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
      `/v1/remote/http?device_id=${encodeURIComponent(this.deviceId)}`,
    );
    this.http = http;
    this.watchSocket(http, 'http');
    if (management.readyState !== WebSocket.OPEN) {
      throw new Error('management connection closed');
    }
    management.on('message', (data) => this.handleManagementMessage(data));
    http.on('message', (data) => this.handleHttpMessage(data));
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
    return connectWebSocket(relayWebSocketUrl(this.relayOrigin, path), this.refreshToken);
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
      if (reason === 'user_requested') this.stopped = true;
      if (reason === 'server_shutting_down') this.reconnectImmediately = true;
      this.closeCycle();
    }
  }

  private handleHttpMessage(data: RawData): void {
    const text = rawDataText(data).trim();
    if (text.length === 0) return;
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed['type'] !== 'request') return;
      requestId = typeof parsed['request_id'] === 'string' ? parsed['request_id'] : undefined;
      if (
        requestId === undefined ||
        typeof parsed['body_base64'] !== 'string' ||
        typeof parsed['is_last'] !== 'boolean'
      ) {
        throw new SyntaxError('invalid HTTP tunnel request message');
      }
      const chunk = decodeBase64(parsed['body_base64']);
      const pending = this.pendingHttpRequests.get(requestId) ?? { chunks: [], size: 0 };
      if (this.pendingHttpBytes + chunk.length > MAX_HTTP_REQUEST_BYTES) {
        throw new SyntaxError('HTTP tunnel request exceeds 10 MiB');
      }
      pending.chunks.push(chunk);
      pending.size += chunk.length;
      this.pendingHttpBytes += chunk.length;
      this.pendingHttpRequests.set(requestId, pending);
      if (!parsed['is_last']) return;
      const rawRequest = Buffer.concat(pending.chunks, pending.size);
      this.clearPendingHttpRequest(requestId);
      void this.forwardHttpRequest(requestId, rawRequest);
    } catch (error) {
      if (requestId !== undefined) {
        this.clearPendingHttpRequest(requestId);
        this.sendHttpResponse(requestId, buildErrorResponse(400));
      }
      this.stderr.write(`Remote Control HTTP message error: ${errorMessage(error)}\n`);
    }
  }

  private async forwardHttpRequest(requestId: string, rawRequest: Buffer): Promise<void> {
    try {
      const parsed = parseRawHttpRequest(rawRequest);
      const response = await requestLocalHttp(
        this.localOrigin,
        parsed,
        this.localServerToken,
        this.publicPrefix(),
      );
      this.sendHttpResponse(requestId, response);
    } catch (error) {
      const status = error instanceof SyntaxError ? 400 : 502;
      this.sendHttpResponse(requestId, buildErrorResponse(status));
      this.stderr.write(`Remote Control HTTP forwarding failed: ${errorMessage(error)}\n`);
    }
  }

  private sendHttpResponse(requestId: string, response: Buffer): void {
    if (this.http?.readyState !== WebSocket.OPEN) return;
    this.http.send(
      JSON.stringify({
        request_id: requestId,
        type: 'response',
        is_last: true,
        body_base64: response.toString('base64'),
      }),
    );
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
        this.localServerToken,
        relayHeaders(payload['headers']),
        earlyLocalFrames,
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

  private clearPendingHttpRequest(requestId: string): void {
    const pending = this.pendingHttpRequests.get(requestId);
    if (pending === undefined) return;
    this.pendingHttpRequests.delete(requestId);
    this.pendingHttpBytes -= pending.size;
  }

  private closeCycle(): void {
    for (const streamId of this.streams.keys()) this.closeStream(streamId);
    this.pendingHttpRequests.clear();
    this.pendingHttpBytes = 0;
    this.management?.close();
    this.http?.close();
    if (this.relayOnline) {
      this.relayOnline = false;
      this.onStatus('relay_disconnected');
    }
    this.management = undefined;
    this.http = undefined;
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

async function connectWebSocket(
  url: string,
  token: string,
  headers: Record<string, string> = {},
  earlyFrames?: [RawData, boolean][],
): Promise<WebSocket> {
  const protocol = `kimi-code.bearer.${token}`;
  if (isWebSocketProtocolToken(protocol)) {
    try {
      return await connectWebSocketAttempt(url, [protocol], headers, earlyFrames);
    } catch {}
  }
  return connectWebSocketAttempt(
    url,
    undefined,
    {
      ...headers,
      Authorization: `Bearer ${token}`,
    },
    earlyFrames,
  );
}

function connectWebSocketAttempt(
  url: string,
  protocols: string[] | undefined,
  headers: Record<string, string>,
  earlyFrames?: [RawData, boolean][],
): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, protocols, {
      headers,
      handshakeTimeout: REGISTER_TIMEOUT_MS,
    });
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
      if (error === undefined) resolve(socket);
      else reject(error);
    };
    const onOpen = (): void => finish();
    const onError = (error: Error): void => finish(error);
    const onClose = (code: number, reason: Buffer): void => {
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

function requestLocalHttp(
  localOrigin: string,
  parsed: ParsedRawHttpRequest,
  serverToken: string,
  publicPrefix: string,
): Promise<Buffer> {
  const origin = new URL(localOrigin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        protocol: origin.protocol,
        hostname: origin.hostname,
        port: origin.port,
        method: parsed.method,
        path: parsed.path,
        headers: [
          ...filterForwardRequestHeaders(parsed.headers, serverToken),
          'Host',
          origin.host,
        ],
        timeout: HTTP_REQUEST_TIMEOUT_MS,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer | string) => chunks.push(Buffer.from(chunk)));
        response.once('error', reject);
        response.once('end', () => {
          const contentType = response.headers['content-type'] ?? '';
          const receivedBody = Buffer.concat(chunks);
          const body =
            response.headers['content-encoding'] === undefined
              ? rewriteRemoteControlResponse(contentType, receivedBody, publicPrefix)
              : receivedBody;
          const rewritten = body !== receivedBody;
          const headers = filterResponseHeaders(response.rawHeaders, rewritten);
          if (rewritten) headers.push('Cache-Control', 'no-cache');
          headers.push('Content-Length', String(body.length));
          const statusCode = response.statusCode ?? 502;
          const statusMessage = response.statusMessage ?? 'Bad Gateway';
          resolve(
            Buffer.concat([
              Buffer.from(`HTTP/1.1 ${statusCode} ${statusMessage}\r\n${headerLines(headers)}\r\n\r\n`),
              body,
            ]),
          );
        });
      },
    );
    request.once('timeout', () => request.destroy(new Error('local HTTP request timed out')));
    request.once('error', reject);
    request.end(parsed.body);
  });
}

function filterResponseHeaders(rawHeaders: readonly string[], blockCacheControl = false): string[] {
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
    if (blockCacheControl && lower === 'cache-control') continue;
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
  const reason = status === 400 ? 'Bad Request' : 'Bad Gateway';
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
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
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
