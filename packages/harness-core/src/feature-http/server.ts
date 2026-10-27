import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Duplex } from 'node:stream';

import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import type { HttpAuthOptions, HttpAuthTokenService } from './auth';
import { ErrorCode, sendErr } from './route/http';
import { createHttpSecurity } from './security';
import { isOriginAllowed } from './security/origin';

export type HttpHandler = (request: Request, response: Response) => void | Promise<void>;

export type HttpUpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;

export interface HttpListen {
  readonly port?: number;
  readonly host?: string;
}

export interface CreateHttpServerOptions extends HttpAuthOptions {
  readonly corsOrigins?: readonly string[];
  readonly now: () => number;
}

const CORS_ALLOW_METHODS = 'GET, POST, PUT, PATCH, DELETE, OPTIONS';
const CORS_ALLOW_HEADERS =
  'Content-Type, Authorization, X-Kimi-Client-Id, X-Kimi-Client-Name, X-Kimi-Client-Version, X-Kimi-Client-Ui-Mode';

export interface Http {
  readonly app: Express;
  readonly origin: string | undefined;
  readonly dangerousBypassAuth: boolean;
  readonly authTokenService: HttpAuthTokenService | undefined;
  route(method: string | readonly string[], path: string, handler: HttpHandler): () => void;
  upgrade(handler: HttpUpgradeHandler): () => void;
  listen(options?: HttpListen): Promise<string>;
  close(): Promise<void>;
}

interface Slot {
  readonly handlers: HttpHandler[];
}

export function createHttpServer(options: CreateHttpServerOptions): Http {
  const security = createHttpSecurity(options);
  const app = express();
  app.use(security.hostMiddleware);
  const corsOrigins = options.corsOrigins ?? [];
  app.use((request, response, next) => {
    const origin = request.get('origin');
    if (origin === undefined) {
      next();
      return;
    }
    if (isOriginAllowed(origin, request.get('host'), corsOrigins)) {
      response.setHeader('Access-Control-Allow-Origin', origin);
      response.setHeader('Access-Control-Allow-Methods', CORS_ALLOW_METHODS);
      response.setHeader(
        'Access-Control-Allow-Headers',
        request.get('access-control-request-headers') ?? CORS_ALLOW_HEADERS,
      );
      response.setHeader('Vary', 'Origin');
    }
    if (request.method === 'OPTIONS') {
      response.status(204).end();
      return;
    }
    next();
  });
  app.use(security.authMiddleware);
  app.use(express.json());
  const slots = new Map<string, Slot>();
  const upgrades: HttpUpgradeHandler[] = [];
  let server: Server | undefined;
  let origin: string | undefined;

  const add = (method: string, path: string, handler: HttpHandler): (() => void) => {
    const key = `${method} ${path}`;
    const existing = slots.get(key);
    if (existing === undefined) {
      const slot: Slot = { handlers: [handler] };
      slots.set(key, slot);
      attach(app, method, path, dispatch(slot));
    } else {
      existing.handlers.push(handler);
    }
    return () => {
      const current = slots.get(key);
      if (current === undefined) {
        return;
      }
      const index = current.handlers.lastIndexOf(handler);
      if (index < 0) {
        return;
      }
      current.handlers.splice(index, 1);
    };
  };

  return {
    app,
    dangerousBypassAuth: options.disableAuth === true,
    get authTokenService() {
      return security.authTokenService;
    },
    get origin() {
      return origin;
    },
    route(method, path, handler) {
      const methods = typeof method === 'string' ? [method] : method;
      const undos = methods.map((item) => add(item.toUpperCase(), path, handler));
      return () => {
        for (const undo of undos) {
          undo();
        }
      };
    },
    upgrade(handler) {
      upgrades.push(handler);
      return () => {
        const index = upgrades.lastIndexOf(handler);
        if (index >= 0) {
          upgrades.splice(index, 1);
        }
      };
    },
    async listen(options = {}) {
      const port = options.port ?? 0;
      const host = options.host ?? '127.0.0.1';
      await security.listen(host);
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          listening.off('listening', onListening);
          security.close();
          server = undefined;
          reject(error);
        };
        const onListening = (): void => {
          listening.off('error', onError);
          const address = listening.address();
          if (address === null || typeof address === 'string') {
            origin = address ?? undefined;
            resolve(origin ?? '');
            return;
          }
          origin = formatOrigin(address);
          resolve(origin);
        };
        const listening = createServer((request, response) => {
          const handle = app as unknown as (
            req: IncomingMessage,
            res: ServerResponse,
            done: (error?: unknown) => void,
          ) => void;
          handle(request, response, (error) => {
            sendFallback(request, response, error);
          });
        });
        server = listening;
        listening.on('upgrade', (request, socket, head) => {
          void security
            .authorizeUpgrade(request)
            .then((status) => {
              if (status !== null) {
                const text = status === 403 ? 'Forbidden' : 'Unauthorized';
                socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\n\r\n`);
                socket.destroy();
                return;
              }
              for (const handler of upgrades) {
                if (handler(request, socket, head)) return;
              }
              socket.destroy();
            })
            .catch(() => {
              socket.destroy();
            });
        });
        listening.once('error', onError);
        listening.once('listening', onListening);
        listening.listen(port, host);
      });
    },
    close() {
      security.close();
      return new Promise((resolve, reject) => {
        origin = undefined;
        const current = server;
        server = undefined;
        if (current === undefined) {
          resolve();
          return;
        }
        current.close((error) => {
          if (error !== undefined && (error as { code?: unknown }).code !== 'ERR_SERVER_NOT_RUNNING') {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

function dispatch(slot: Slot): RequestHandler {
  return (request, response, next) => {
    const handler = slot.handlers.at(-1);
    if (handler === undefined) {
      sendErr(
        request,
        response,
        ErrorCode.ROUTE_NOT_FOUND,
        `route ${request.method} ${request.path} not found`,
      );
      return;
    }
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      next(error);
    });
  };
}

function sendFallback(request: IncomingMessage, response: ServerResponse, error: unknown): void {
  if (response.headersSent) {
    request.socket.destroy();
    return;
  }
  const code = error === undefined ? ErrorCode.ROUTE_NOT_FOUND : ErrorCode.INTERNAL_ERROR;
  const msg =
    error === undefined
      ? `route ${request.method ?? ''} ${request.url?.split('?')[0] ?? ''} not found`
      : error instanceof Error && error.message !== ''
        ? error.message
        : 'internal error';
  const header = request.headers['x-request-id'];
  response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
  response.end(
    JSON.stringify({
      code,
      msg,
      data: null,
      request_id: typeof header === 'string' ? header : '',
    }),
  );
}

function attach(app: Express, method: string, path: string, handler: RequestHandler): void {
  switch (method) {
    case 'GET':
      app.get(path, handler);
      return;
    case 'POST':
      app.post(path, handler);
      return;
    case 'PUT':
      app.put(path, handler);
      return;
    case 'PATCH':
      app.patch(path, handler);
      return;
    case 'DELETE':
      app.delete(path, handler);
      return;
    case 'HEAD':
      app.head(path, handler);
      return;
    case 'OPTIONS':
      app.options(path, handler);
      return;
    default:
      app.all(path, (request, response, next) => {
        if (request.method !== method) {
          next();
          return;
        }
        handler(request, response, next);
      });
  }
}

function formatOrigin(address: AddressInfo): string {
  const host = address.family === 'IPv6' ? `[${address.address}]` : address.address;
  return `http://${host}:${String(address.port)}`;
}

