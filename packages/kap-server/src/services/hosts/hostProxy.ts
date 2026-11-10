import { request, type IncomingHttpHeaders, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { errEnvelope } from '../../envelope';
import { ErrorCode } from '../../protocol/error-codes';
import { selectWsBearerProtocol, WS_BEARER_PROTOCOL_PREFIX } from '../../transport/ws/bearerProtocol';
import type { HostBridgeManager } from './hostBridgeManager';
import type { HostEndpoint } from './sshKapBridge';

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

export function upstreamHeaders(headers: IncomingHttpHeaders, endpoint: HostEndpoint): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!HOP_BY_HOP.has(name) && !STRIPPED_REQUEST_HEADERS.has(name)) forwarded[name] = value;
  }
  forwarded['host'] = `127.0.0.1:${endpoint.port}`;
  forwarded['authorization'] = `Bearer ${endpoint.token}`;
  return forwarded;
}

function responseHeaders(upstream: IncomingMessage): IncomingHttpHeaders {
  return Object.fromEntries(
    Object.entries(upstream.headers).filter(([name]) => !HOP_BY_HOP.has(name)),
  );
}

async function resolveEndpoint(
  manager: HostBridgeManager,
  hostId: string,
): Promise<HostEndpoint> {
  return manager.endpoint(hostId) ?? manager.connect(hostId);
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
  let endpoint: HostEndpoint;
  try {
    endpoint = await resolveEndpoint(manager, target.hostId);
  } catch (error) {
    await reply.code(502).send(
      errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error instanceof Error ? error.message : String(error), req.id),
    );
    return;
  }
  const localHeaders = reply.getHeaders();
  reply.hijack();
  const upstream = request(
    {
      host: '127.0.0.1',
      port: endpoint.port,
      method: req.raw.method,
      path: target.path,
      headers: upstreamHeaders(req.raw.headers, endpoint),
    },
    (response) => {
      reply.raw.writeHead(response.statusCode ?? 502, {
        ...localHeaders,
        ...responseHeaders(response),
      } as IncomingHttpHeaders);
      void pipeline(response, reply.raw).catch((error: unknown) => {
        reply.raw.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    },
  );
  upstream.on('error', (error) => {
    if (!reply.raw.headersSent) {
      reply.raw.writeHead(502, { 'content-type': 'application/json' });
      reply.raw.end(JSON.stringify(errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, error.message, req.id)));
      return;
    }
    reply.raw.destroy(error);
  });
  reply.raw.on('close', () => {
    if (!reply.raw.writableFinished) upstream.destroy();
  });
  req.raw.pipe(upstream);
}

export function registerHostProxyRoutes(
  app: FastifyInstance,
  manager: HostBridgeManager,
  isEnabled: () => boolean,
): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
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

export async function proxyHostWebSocket(
  manager: HostBridgeManager,
  target: HostProxyTarget,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  let endpoint: HostEndpoint;
  try {
    endpoint = await resolveEndpoint(manager, target.hostId);
  } catch {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  const clientProtocol = selectWsBearerProtocol(
    (req.headers['sec-websocket-protocol'] ?? '').split(',').map((entry) => entry.trim()),
  );
  const upstream = request({
    host: '127.0.0.1',
    port: endpoint.port,
    method: 'GET',
    path: target.path,
    headers: {
      ...upstreamHeaders(req.headers, endpoint),
      connection: 'Upgrade',
      upgrade: 'websocket',
      'sec-websocket-protocol': `${WS_BEARER_PROTOCOL_PREFIX}${endpoint.token}`,
    },
  });
  upstream.on('upgrade', (response, upstreamSocket, upstreamHead) => {
    const lines = ['HTTP/1.1 101 Switching Protocols'];
    for (let index = 0; index < response.rawHeaders.length; index += 2) {
      const name = response.rawHeaders[index]!;
      if (name.toLowerCase() === 'sec-websocket-protocol') continue;
      lines.push(`${name}: ${response.rawHeaders[index + 1]!}`);
    }
    if (clientProtocol !== false) lines.push(`Sec-WebSocket-Protocol: ${clientProtocol}`);
    socket.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (upstreamHead.length > 0) socket.write(upstreamHead);
    if (head.length > 0) upstreamSocket.write(head);
    upstreamSocket.pipe(socket);
    socket.pipe(upstreamSocket);
    upstreamSocket.on('error', () => socket.destroy());
    socket.on('error', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => socket.destroy());
    socket.on('close', () => upstreamSocket.destroy());
  });
  upstream.on('response', (response) => {
    socket.write(`HTTP/1.1 ${response.statusCode ?? 502} Upstream Rejected\r\nConnection: close\r\n\r\n`);
    socket.destroy();
    response.resume();
  });
  upstream.on('error', () => {
    socket.write('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    socket.destroy();
  });
  upstream.end();
}
