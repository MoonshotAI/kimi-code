import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { WebSocketServer, type RawData } from 'ws';

import { errEnvelope } from '../../envelope';
import { CLIENT_IDENTITY_HEADER } from '../../protocol/clientIdentity';
import { ErrorCode } from '../../protocol/error-codes';
import { DEVICE_RPC_MAX_BODY_BYTES } from '../../transport/jsonlRpcStream';
import { selectWsBearerProtocol } from '../../transport/ws/bearerProtocol';
import type { DeviceManager } from './deviceManager';
import {
  DeviceRequestError,
  HOP_BY_HOP_HEADERS,
  STRIPPED_REQUEST_HEADERS,
  type DeviceSession,
} from './deviceSession';
import { rawDataToString } from './rawData';

type DeviceConnections = Pick<DeviceManager, 'session' | 'connect'>;

const PROXY_PATH = /^\/api\/v1\/devices\/([^/?]+)\/proxy(\/[^?]*)?(\?.*)?$/;
const SESSION_CREATE_PATH = /^\/api\/v1\/sessions(?:\?|$)/;

function bodyTooLarge(): DeviceRequestError {
  return new DeviceRequestError(
    'body_too_large',
    `HTTP body exceeds the ${String(DEVICE_RPC_MAX_BODY_BYTES)} byte device proxy limit`,
  );
}

export interface DeviceProxyTarget {
  readonly deviceId: string;
  readonly path: string;
}

export function matchDeviceProxyPath(url: string): DeviceProxyTarget | undefined {
  const match = PROXY_PATH.exec(url);
  if (match === null) return undefined;
  let deviceId: string;
  try {
    deviceId = decodeURIComponent(match[1]!);
  } catch {
    return undefined;
  }
  return { deviceId, path: `${match[2] ?? '/'}${match[3] ?? ''}` };
}

export function upstreamHeaders(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const forwarded: IncomingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    const lower = name.toLowerCase();
    if (!HOP_BY_HOP_HEADERS.has(lower) && !STRIPPED_REQUEST_HEADERS.has(lower)) forwarded[name] = value;
  }
  forwarded['host'] = '127.0.0.1';
  return forwarded;
}

function stampSessionCreation(
  method: string,
  path: string,
  headers: IncomingHttpHeaders,
  clientIdentityHeader: string,
): IncomingHttpHeaders {
  if (method !== 'POST' || !SESSION_CREATE_PATH.test(path)) return headers;
  return { ...headers, [CLIENT_IDENTITY_HEADER]: clientIdentityHeader };
}

function proxyRequestTimeout(method: string, path: string): number | undefined {
  if (method === 'POST' && /^\/api\/v1\/feedback\/\d+\/attachments(?:\/session)?(?:\?|$)/.test(path)) return Infinity;
  return /^\/api\/v1\/sessions\/[^/]+\/export(?:\?|$)/.test(path) ? 5 * 60_000 : undefined;
}

async function resolveSession(
  manager: DeviceConnections,
  deviceId: string,
): Promise<DeviceSession> {
  return manager.session(deviceId) ?? manager.connect(deviceId);
}

async function proxyHttp(
  manager: DeviceConnections,
  clientIdentityHeader: string,
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<void> {
  const target = matchDeviceProxyPath(req.raw.url ?? '');
  if (target === undefined) {
    await reply.code(404).send(errEnvelope(ErrorCode.ENVIRONMENT_NOT_FOUND, 'unknown device route', req.id));
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
  let session: DeviceSession;
  try {
    session = await resolveSession(manager, target.deviceId);
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
    if (declaredLength > DEVICE_RPC_MAX_BODY_BYTES) throw bodyTooLarge();
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req.raw) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > DEVICE_RPC_MAX_BODY_BYTES) throw bodyTooLarge();
      chunks.push(buffer);
    }
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
    const response = await session.request({
      method: req.method,
      path: target.path,
      headers: stampSessionCreation(req.method, target.path, upstreamHeaders(req.headers), clientIdentityHeader),
      body,
      signal: cancellation.signal,
      timeoutMs: proxyRequestTimeout(req.method, target.path),
    });
    for (const [name, value] of Object.entries(response.headers)) {
      if (value !== undefined && !HOP_BY_HOP_HEADERS.has(name.toLowerCase())) {
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
    if (error instanceof DeviceRequestError && error.failure === 'body_too_large') {
      await reply.code(413).send(errEnvelope(ErrorCode.FILE_TOO_LARGE, message, req.id));
      return;
    }
    const status = error instanceof DeviceRequestError && error.failure === 'timeout' ? 504 : 502;
    const cancelled = error instanceof DeviceRequestError && error.failure === 'cancelled';
    await reply.code(cancelled ? 499 : status).send(
      errEnvelope(ErrorCode.ENVIRONMENT_UNAVAILABLE, message, req.id),
    );
  }
}

export function registerDeviceProxyRoutes(
  app: FastifyInstance,
  manager: DeviceConnections,
  clientIdentityHeader: string,
): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => {
      done(null, payload);
    });
    for (const url of ['/api/v1/devices/:id/proxy', '/api/v1/devices/:id/proxy/*']) {
      scope.route({
        method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'],
        url,
        handler: async (req, reply) => {
          await proxyHttp(manager, clientIdentityHeader, req, reply);
        },
      });
    }
  });
}

const proxyWss = new WebSocketServer({
  noServer: true,
  handleProtocols: selectWsBearerProtocol,
  maxPayload: DEVICE_RPC_MAX_BODY_BYTES,
});

export async function proxyDeviceWebSocket(
  manager: DeviceConnections,
  target: DeviceProxyTarget,
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
): Promise<void> {
  let session: DeviceSession;
  try {
    session = await resolveSession(manager, target.deviceId);
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
