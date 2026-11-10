import { EventEmitter } from 'node:events';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline';
import type { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import type { WebSocket, WebSocketServer } from 'ws';

import { WS_DEBUG_PATH } from './ws/debug/registerWsDebug';
import { WS_PATH as WS_PATH_V1 } from './ws/v1/registerWsV1';

export interface RpcHttpRequestFrame {
  readonly type: 'http.req';
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
  readonly body?: string;
}

export interface RpcHttpResponseFrame {
  readonly type: 'http.res';
  readonly id: string;
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
  readonly body?: string;
}

export interface RpcWsOpenFrame {
  readonly type: 'ws.open';
  readonly id: string;
  readonly path: string;
}

export interface RpcWsMessageFrame {
  readonly type: 'ws.msg';
  readonly id: string;
  readonly data: string;
}

export interface RpcWsCloseFrame {
  readonly type: 'ws.close';
  readonly id: string;
  readonly code?: number;
  readonly reason?: string;
}

export type RpcFrame =
  | RpcHttpRequestFrame
  | RpcHttpResponseFrame
  | RpcWsOpenFrame
  | RpcWsMessageFrame
  | RpcWsCloseFrame;

export interface RpcStreamOptions {
  readonly app: FastifyInstance;
  readonly wssV1: WebSocketServer;
  readonly wssDebug?: WebSocketServer;
}

class FakeWebSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  bufferedAmount = 0;

  constructor(
    private readonly onSend: (data: string) => void,
    private readonly onClosed: (code?: number, reason?: string) => void,
  ) {
    super();
  }

  send(data: string): void {
    if (this.readyState !== this.OPEN) return;
    this.onSend(data);
  }

  ping(): void {
    if (this.readyState !== this.OPEN) return;
    this.emit('pong');
  }

  close(code?: number, reason?: string): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.onClosed(code, reason);
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  receiveMessage(data: string): void {
    if (this.readyState !== this.OPEN) return;
    this.emit('message', Buffer.from(data, 'utf8'));
  }

  receiveClose(code?: number, reason?: string): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 3;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }
}

export function attachRpcStream(stream: Duplex, opts: RpcStreamOptions): void {
  const sockets = new Map<string, FakeWebSocket>();
  const write = (frame: RpcFrame): void => {
    if (!stream.destroyed && stream.writable) {
      stream.write(`${JSON.stringify(frame)}\n`);
    }
  };

  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  lines.on('line', (line) => {
    const trimmed = line.trim();
    if (trimmed.length === 0) return;
    let frame: RpcFrame;
    try {
      frame = JSON.parse(trimmed) as RpcFrame;
    } catch {
      return;
    }
    if (frame.type === 'http.req') {
      void opts.app
        .inject({
          method: frame.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
          url: frame.path,
          headers: { ...frame.headers, host: '127.0.0.1' },
          payload: frame.body === undefined ? undefined : Buffer.from(frame.body, 'base64'),
        })
        .then(
          (res) => {
            write({
              type: 'http.res',
              id: frame.id,
              status: res.statusCode,
              headers: res.headers,
              body: res.rawPayload.length > 0 ? res.rawPayload.toString('base64') : undefined,
            });
          },
          (error: unknown) => {
            const payload = Buffer.from(
              JSON.stringify({
                code: 50000,
                msg: error instanceof Error ? error.message : String(error),
                data: null,
                request_id: frame.id,
              }),
            ).toString('base64');
            write({
              type: 'http.res',
              id: frame.id,
              status: 500,
              headers: { 'content-type': 'application/json' },
              body: payload,
            });
          },
        );
      return;
    }
    if (frame.type === 'ws.open') {
      const isV1 = frame.path === WS_PATH_V1 || frame.path.startsWith(`${WS_PATH_V1}?`);
      const isDebug = frame.path === WS_DEBUG_PATH || frame.path.startsWith(`${WS_DEBUG_PATH}?`);
      const wss = isV1 ? opts.wssV1 : isDebug ? opts.wssDebug : undefined;
      if (wss === undefined) {
        write({ type: 'ws.close', id: frame.id, code: 1008, reason: 'unknown ws route' });
        return;
      }
      const fake = new FakeWebSocket(
        (data) => write({ type: 'ws.msg', id: frame.id, data }),
        (code, reason) => {
          sockets.delete(frame.id);
          write({ type: 'ws.close', id: frame.id, code, reason });
        },
      );
      sockets.set(frame.id, fake);
      const fakeReq = {
        url: frame.path,
        headers: {},
        socket: { remoteAddress: 'unix' },
      } as unknown as IncomingMessage;
      wss.emit('connection', fake as unknown as WebSocket, fakeReq);
      return;
    }
    if (frame.type === 'ws.msg') {
      sockets.get(frame.id)?.receiveMessage(frame.data);
      return;
    }
    if (frame.type === 'ws.close') {
      const socket = sockets.get(frame.id);
      sockets.delete(frame.id);
      socket?.receiveClose(frame.code, frame.reason);
    }
  });

  const cleanup = (): void => {
    lines.close();
    for (const socket of sockets.values()) {
      socket.receiveClose(1001, 'rpc stream closed');
    }
    sockets.clear();
  };

  stream.on('close', cleanup);
  stream.on('error', cleanup);
}

export async function startUnixRpcServer(
  socketPath: string,
  opts: RpcStreamOptions,
): Promise<{ close(): Promise<void> }> {
  await mkdir(dirname(socketPath), { recursive: true, mode: 0o700 });
  await rm(socketPath, { force: true });
  const clients = new Set<Socket>();
  const server = createServer((socket) => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    attachRpcStream(socket, opts);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.off('error', reject);
      resolve();
    });
  });
  await chmod(socketPath, 0o600).catch(() => {});
  const boundIno = await stat(socketPath).then(
    (info) => info.ino,
    () => undefined,
  );
  return {
    async close() {
      for (const client of clients) client.destroy();
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      const currentIno = await stat(socketPath).then(
        (info) => info.ino,
        () => undefined,
      );
      if (boundIno !== undefined && currentIno === boundIno) {
        await rm(socketPath, { force: true });
      }
    },
  };
}
