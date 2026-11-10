import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocketServer, type RawData } from 'ws';

import { errEnvelope } from '../../envelope';
import { ErrorCode } from '../../protocol/error-codes';
import { selectWsBearerProtocol } from '../../transport/ws/bearerProtocol';
import type { HostBridgeManager } from './hostBridgeManager';
import type { HostSession } from './sshKapBridge';

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
  let session: HostSession;
  try {
    session = await resolveSession(manager, target.hostId);
  } catch (error) {
    await reply.code(502).send(
      errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error instanceof Error ? error.message : String(error), req.id),
    );
    return;
  }
  try {
    const body = Buffer.isBuffer(req.body) && req.body.length > 0 ? req.body : undefined;
    const response = await session.request({
      method: req.method,
      path: target.path,
      headers: upstreamHeaders(req.headers),
      body,
    });
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) {
        reply.header(name, value);
      }
    }
    await reply.code(response.status).send(response.body);
  } catch (error) {
    await reply.code(502).send(
      errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error instanceof Error ? error.message : String(error), req.id),
    );
  }
}

export function registerHostProxyRoutes(
  app: FastifyInstance,
  manager: HostBridgeManager,
  isEnabled: () => boolean,
): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', { parseAs: 'buffer' }, (_req, payload, done) => done(null, payload));
    for (const url of ['/api/v1/hosts/:id/proxy', '/api/v1/hosts/:id/proxy/*']) {
      scope.route({
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
        url,
        handler: async (req, reply) => {
          if (!isEnabled()) {
            await reply.code(404).send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, 'not found', req.id));
            return;
          }
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
  return Buffer.from(data as ArrayBuffer).toString('utf8');
}

const proxyWss = new WebSocketServer({ noServer: true, handleProtocols: selectWsBearerProtocol });

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
