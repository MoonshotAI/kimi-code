import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocketServer, type RawData } from 'ws';

import { errEnvelope } from '../../envelope';
import { ErrorCode } from '../../protocol/error-codes';
import { HOST_RPC_MAX_BODY_BYTES } from '../../transport/jsonlRpcStream';
import { selectWsBearerProtocol } from '../../transport/ws/bearerProtocol';
import type { HostBridgeManager } from './hostBridgeManager';
import { HostRequestError, type HostSession } from './hostSession';

const PROXY_PATH = /^\/api\/v1\/hosts\/([^/?]+)\/proxy(\/[^?]*)?(\?.*)?$/;
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);
const STRIPPED_REQUEST_HEADERS = new Set(['host', 'origin', 'referer', 'authorization', 'cookie']);

function bodyTooLarge(): HostRequestError {
  return new HostRequestError(
    'body_too_large',
    `HTTP body exceeds the ${String(HOST_RPC_MAX_BODY_BYTES)} byte host proxy limit`,
  );
}

export interface HostProxyTarget {
  readonly hostId: string;
  readonly path: string;
}

export function matchHostProxyPath(url: string): HostProxyTarget | undefined {
  const match = PROXY_PATH.exec(url);
  if (match === null) return undefined;
  let hostId: string;
  try {
    hostId = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  return { hostId, path: `${match[2] ?? '/'}${match[3] ?? ''}` };
}

export function upstreamHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP.has(lower) && !STRIPPED_REQUEST_HEADERS.has(lower)) forwarded[name] = value;
  }
  forwarded['host'] = '127.0.0.1';
  return forwarded;
}

async function resolveSession(
  manager: HostBridgeManager,
  hostId: string,
): Promise<HostSession> {
  return manager.session(hostId) ?? manager.connect(hostId);
}

async function proxyHttp(
  manager: HostBridgeManager,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const target = matchHostProxyPath(req.raw.url ?? '');
  if (target === undefined) {
    await reply.code(404).send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, 'unknown host route', req.id));
    return;
  }
  const cancellation = new AbortController();
  const cancel = (): void => {
    cancellation.abort();
  };
  req.raw.once('aborted', cancel);
  req.raw.once('close', () => {
    if (!req.raw.readableEnded) cancel();
  });
  reply.raw.once('close', () => {
    if (!reply.raw.writableFinished) cancel();
  });
  let session: HostSession;
  try {
    session = await resolveSession(manager, target.hostId);
  } catch (error) {
    if (!reply.raw.destroyed) {
      await reply.code(502).send(
        errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error instanceof Error ? error.message : String(error), req.id),
      );
    }
    return;
  }
  const request = async (): Promise<void> => {
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (declaredLength > HOST_RPC_MAX_BODY_BYTES) throw bodyTooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.raw) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > HOST_RPC_MAX_BODY_BYTES) throw bodyTooLarge();
      chunks.push(buffer);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const response = await session.request({
      method: req.method,
      path: target.path,
      headers: upstreamHeaders(req.headers),
      body,
      signal: cancellation.signal,
      timeoutMs: /^\/api\/v1\/sessions\/[^/]+\/export(?:\?|$)/.test(target.path) ? 5 * 60_000 : undefined,
    });
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
        reply.header(name, value);
      }
    }
    if (!reply.raw.destroyed) await reply.code(response.status).send(response.body);
  };
  try {
    await request();
  } catch (error) {
    if (reply.raw.destroyed) return;
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HostRequestError && error.failure === 'body_too_large') {
      await reply.code(413).send(errEnvelope(ErrorCode.FILE_TOO_LARGE, message, req.id));
      return;
    }
    const status = error instanceof HostRequestError && error.failure === 'timeout' ? 504 : 502;
    const cancelled = error instanceof HostRequestError && error.failure === 'cancelled';
    await reply.code(cancelled ? 499 : status).send(
      errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, message, req.id),
    );
  }
}

export function registerHostProxyRoutes(
  app: FastifyInstance,
  manager: HostBridgeManager,
): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });
    for (const url of ['/api/v1/hosts/:id/proxy', '/api/v1/hosts/:id/proxy/*']) {
      scope.route({
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
        url,
        handler: async (req, reply) => {
          await proxyHttp(manager, req, reply);
        },
      });
    }
  });
}

function rawDataToString(data: RawData): string {
  if (typeof data === 'string') return data;
  if (Buffer.isBuffer(data)) return data.toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return Buffer.from(data).toString('utf8');
}

const proxyWss = new WebSocketServer({
  noServer: true,
  handleProtocols: selectWsBearerProtocol,
  maxPayload: HOST_RPC_MAX_BODY_BYTES,
});

export async function proxyHostWebSocket(
  manager: HostBridgeManager,
  target: HostProxyTarget,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  let session: HostSession;
  try {
    session = await resolveSession(manager, target.hostId);
  } catch {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  proxyWss.handleUpgrade(req, socket, head, (ws) => {
    let closed = false;
    const upstream = session.openWebSocket(target.path, {
      onMessage: (data) => {
        if (!closed && ws.readyState === ws.OPEN) ws.send(data);
      },
      onClose: (code, reason) => {
        if (closed) return;
        closed = true;
        try {
          ws.close(code ?? 1000, reason);
        } catch {
          ws.terminate();
        }
      },
      onBackpressure: (blocked) => {
        if (!closed) {
          if (blocked) ws.pause();
          else ws.resume();
        }
      },
    });
    ws.on('message', (data: RawData) => {
      upstream.send(rawDataToString(data));
    });
    ws.on('close', (code, reason) => {
      if (closed) return;
      closed = true;
      upstream.close(code, reason.toString('utf8'));
    });
    ws.on('error', () => {
      if (closed) return;
      closed = true;
      upstream.close(1011, 'client error');
    });
  });
}
