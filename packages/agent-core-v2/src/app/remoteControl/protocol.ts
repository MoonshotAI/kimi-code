/**
 * `remoteControl` domain — validated relay protocol and HTTP tunnel codecs.
 */

import { z } from 'zod';

const HeadersSchema = z.record(z.string(), z.string());

export const RemoteDisconnectReasonSchema = z.enum([
  'user_requested',
  'server_shutting_down',
  'local_server_stopped',
  'client_upgrading',
]);
export type RemoteDisconnectReason = z.infer<typeof RemoteDisconnectReasonSchema>;

export const RemoteStreamCloseReasonSchema = z.enum([
  'browser_closed',
  'timeout',
  'server_shutting_down',
  'local_closed',
]);
export type RemoteStreamCloseReason = z.infer<typeof RemoteStreamCloseReasonSchema>;

export const RemoteStreamErrorCodeSchema = z.enum([
  'LOCAL_WS_FAILED',
  'TUNNEL_STREAM_FAILED',
  'TIMEOUT',
  'UNKNOWN',
]);
export type RemoteStreamErrorCode = z.infer<typeof RemoteStreamErrorCodeSchema>;

export const ManagementInboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('register_ack'),
    payload: z.object({ success: z.boolean() }),
  }),
  z.object({
    type: z.literal('open_ws'),
    payload: z.object({
      stream_id: z.string().min(1),
      path: z.string().min(1),
      headers: HeadersSchema.default({}),
    }),
  }),
  z.object({
    type: z.literal('close_ws'),
    payload: z.object({
      stream_id: z.string().min(1),
      close_code: z.number().int().min(1000).max(4999).optional(),
      reason: RemoteStreamCloseReasonSchema,
      path: z.string().min(1).optional(),
      headers: HeadersSchema.optional(),
    }),
  }),
  z.object({
    type: z.literal('disconnect'),
    payload: z.object({ reason: RemoteDisconnectReasonSchema }),
  }),
]);
export type ManagementInboundMessage = z.infer<typeof ManagementInboundMessageSchema>;

export const ManagementOutboundMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('register'),
    payload: z.object({
      device_id: z.string().min(1),
      alias: z.string().min(1),
      platform: z.string().min(1),
      client_version: z.string().min(1),
      local_base_url: z.string().url(),
    }),
  }),
  z.object({
    type: z.literal('open_ws_result'),
    payload: z.object({
      stream_id: z.string().min(1),
      success: z.boolean(),
      error_code: RemoteStreamErrorCodeSchema.optional(),
      error_message: z.string().optional(),
    }),
  }),
  z.object({
    type: z.literal('disconnect'),
    payload: z.object({ reason: RemoteDisconnectReasonSchema }),
  }),
]);
export type ManagementOutboundMessage = z.infer<typeof ManagementOutboundMessageSchema>;

export const HttpTunnelMessageSchema = z.object({
  request_id: z.string().min(1),
  type: z.enum(['request', 'response', 'response_chunk']),
  is_last: z.boolean(),
  body_base64: z.string(),
});
export type HttpTunnelMessage = z.infer<typeof HttpTunnelMessageSchema>;

export interface LocalHttpRequest {
  readonly method: string;
  readonly path: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
}

export function parseManagementInbound(data: string | Buffer): ManagementInboundMessage {
  return ManagementInboundMessageSchema.parse(JSON.parse(data.toString()));
}

export function parseHttpTunnelMessage(data: string | Buffer): HttpTunnelMessage {
  return HttpTunnelMessageSchema.parse(JSON.parse(data.toString()));
}

export function encodeManagementMessage(message: ManagementOutboundMessage): string {
  return JSON.stringify(ManagementOutboundMessageSchema.parse(message));
}

export function encodeHttpTunnelMessage(message: HttpTunnelMessage): string {
  return JSON.stringify(HttpTunnelMessageSchema.parse(message));
}

export class HttpRequestAssembler {
  private readonly chunks = new Map<string, Buffer[]>();

  push(message: HttpTunnelMessage): LocalHttpRequest | undefined {
    if (message.type !== 'request') throw new Error('expected an HTTP tunnel request');
    const chunks = this.chunks.get(message.request_id) ?? [];
    chunks.push(Buffer.from(message.body_base64, 'base64'));
    if (!message.is_last) {
      this.chunks.set(message.request_id, chunks);
      return undefined;
    }
    this.chunks.delete(message.request_id);
    return parseRawHttpRequest(Buffer.concat(chunks));
  }

  clear(): void {
    this.chunks.clear();
  }
}

const HOP_BY_HOP_HEADERS = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

export function sanitizeForwardHeaders(
  headers: Readonly<Record<string, string>>,
): Record<string, string> {
  const connectionTokens = new Set(
    Object.entries(headers)
      .find(([name]) => name.toLowerCase() === 'connection')?.[1]
      .split(',')
      .map((value) => value.trim().toLowerCase())
      .filter(Boolean) ?? [],
  );
  const result: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(lower) ||
      connectionTokens.has(lower) ||
      lower === 'authorization' ||
      lower === 'proxy-authorization' ||
      lower === 'host' ||
      lower === 'content-length' ||
      lower === 'origin' ||
      lower.startsWith('sec-websocket-')
    ) continue;
    result[name] = value;
  }
  return result;
}

export function resolveLocalUrl(localBaseUrl: string, path: string): URL {
  if (!path.startsWith('/')) throw new Error('local proxy path must start with /');
  const base = new URL(localBaseUrl);
  if (base.protocol !== 'http:' && base.protocol !== 'https:') {
    throw new Error('local base URL must use HTTP or HTTPS');
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new Error('local proxy path must stay on the local origin');
  return url;
}

export function parseRawHttpRequest(raw: Buffer): LocalHttpRequest {
  const separator = raw.indexOf('\r\n\r\n');
  if (separator < 0) throw new Error('HTTP request headers are incomplete');
  const lines = raw.subarray(0, separator).toString('latin1').split('\r\n');
  const requestLine = lines.shift();
  const match = requestLine?.match(/^([A-Z]+)\s+(\S+)\s+HTTP\/1\.[01]$/);
  if (match === null || match === undefined) throw new Error('invalid HTTP request line');
  const headers: Record<string, string> = {};
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon <= 0) throw new Error('invalid HTTP request header');
    const name = line.slice(0, colon).trim();
    const value = line.slice(colon + 1).trim();
    headers[name] = headers[name] === undefined ? value : `${headers[name]}, ${value}`;
  }
  return {
    method: match[1]!,
    path: match[2]!,
    headers: sanitizeForwardHeaders(headers),
    body: raw.subarray(separator + 4),
  };
}

export function serializeHttpResponseHead(
  statusCode: number,
  statusMessage: string,
  headers: Readonly<Record<string, string | readonly string[] | undefined>>,
  bodyLength?: number,
): Buffer {
  const safeHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (value === undefined || HOP_BY_HOP_HEADERS.has(lower) || lower === 'content-length') continue;
    safeHeaders[name] = typeof value === 'string' ? value : value.join(', ');
  }
  if (bodyLength !== undefined) safeHeaders['Content-Length'] = String(bodyLength);
  const lines = [`HTTP/1.1 ${String(statusCode)} ${statusMessage}`];
  for (const [name, value] of Object.entries(safeHeaders)) lines.push(`${name}: ${value}`);
  return Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
}

export const BAD_GATEWAY_RESPONSE = Buffer.from(
  'HTTP/1.1 502 Bad Gateway\r\nContent-Length: 0\r\n\r\n',
  'latin1',
);
