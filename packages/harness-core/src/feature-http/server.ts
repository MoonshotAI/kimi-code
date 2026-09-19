import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import express, {
  type Express,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

export type HttpHandler = (request: Request, response: Response) => void | Promise<void>;

export interface HttpListen {
  readonly port?: number;
  readonly host?: string;
}

export interface Http {
  readonly app: Express;
  readonly origin: string | undefined;
  route(method: string | readonly string[], path: string, handler: HttpHandler): () => void;
  listen(options?: HttpListen): Promise<string>;
  close(): Promise<void>;
}

interface Slot {
  readonly handlers: HttpHandler[];
}

export function createHttpServer(): Http {
  const app = express();
  app.use(express.json());
  const slots = new Map<string, Slot>();
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
    listen(options = {}) {
      const port = options.port ?? 0;
      const host = options.host ?? '127.0.0.1';
      return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
          listening.off('listening', onListening);
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
        const listening = app.listen(port, host);
        server = listening;
        listening.once('error', onError);
        listening.once('listening', onListening);
      });
    },
    close() {
      return new Promise((resolve, reject) => {
        origin = undefined;
        const current = server;
        server = undefined;
        if (current === undefined) {
          resolve();
          return;
        }
        current.close((error) => {
          if (error !== undefined) {
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
    const handler = slot.handlers[slot.handlers.length - 1];
    if (handler === undefined) {
      response.status(404).end();
      return;
    }
    void Promise.resolve(handler(request, response)).catch((error: unknown) => {
      next(error);
    });
  };
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
