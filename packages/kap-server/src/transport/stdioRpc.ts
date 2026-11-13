import { EventEmitter } from 'node:events';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import type { Duplex } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import type { WebSocket, WebSocketServer } from 'ws';

import { HOST_RPC_MAX_BODY_BYTES, JsonlRpcStream } from './jsonlRpcStream';
import { WS_DEBUG_PATH } from './ws/debug/registerWsDebug';
import { WS_PATH as WS_PATH_V1 } from './ws/v1/registerWsV1';

export { HOST_RPC_MAX_BODY_BYTES } from './jsonlRpcStream';

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

export interface RpcHttpCancelFrame {
  readonly type: 'http.cancel';
  readonly id: string;
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
  | RpcHttpCancelFrame
  | RpcWsOpenFrame
  | RpcWsMessageFrame
  | RpcWsCloseFrame;

export interface RpcStreamOptions {
  readonly app: FastifyInstance;
  readonly wssV1: WebSocketServer;
  readonly wssDebug?: WebSocketServer;
}

class RpcBodyTooLargeError extends Error {
  constructor() {
    super(`HTTP body exceeds the ${String(HOST_RPC_MAX_BODY_BYTES)} byte host proxy limit`);
    this.name = 'RpcBodyTooLargeError';
  }
}

class FakeWebSocket extends EventEmitter { // oxlint-disable-line eslint-plugin-unicorn/prefer-event-target
  readonly OPEN = 1;
  readonly CLOSED = 3;
  readyState = 1;

  constructor(
    private readonly onSend: (data: string) => void,
    private readonly onClosed: (code?: number, reason?: string) => void,
    private readonly bufferedBytes: () => number,
  ) {
    super();
  }

  get bufferedAmount(): number {
    return this.bufferedBytes();
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
    this.readyState = this.CLOSED;
    this.onClosed(code, reason);
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }

  receiveMessage(data: string): void {
    if (this.readyState !== this.OPEN) return;
    this.emit('message', Buffer.from(data, 'utf8'));
  }

  receiveClose(code?: number, reason?: string): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = this.CLOSED;
    this.emit('close', code ?? 1000, Buffer.from(reason ?? ''));
  }
}

export function attachRpcStream(stream: Duplex, opts: RpcStreamOptions): void {
  const sockets = new Map<string, FakeWebSocket>();
  const requests = new Map<string, () => void>();
  const aborted = new Set<string>();
  const respondError = (id: string, status: number, code: number, message: string): void => {
    rpc.write({
      type: 'http.res',
      id,
      status,
      headers: { 'content-type': 'application/json' },
      body: Buffer.from(JSON.stringify({ code, msg: message, data: null, request_id: id })).toString('base64'),
    });
  };
  const cleanup = (): void => {
    for (const id of requests.keys()) {
      aborted.add(id);
      requests.get(id)?.();
    }
    requests.clear();
    for (const socket of sockets.values()) socket.receiveClose(1001, 'rpc stream closed');
    sockets.clear();
  };
  const rpc = new JsonlRpcStream<RpcFrame>(
    stream,
    (frame) => {
      if (frame.type === 'http.req') {
        if (aborted.has(frame.id)) return;
        requests.set(frame.id, () => {});
        const finish = (): void => {
          requests.delete(frame.id);
          aborted.delete(frame.id);
        };
        void (async () => {
          const contentLength = Number(frame.headers['content-length'] ?? 0);
          if (contentLength > HOST_RPC_MAX_BODY_BYTES) throw new RpcBodyTooLargeError();
          const body = frame.body === undefined ? Buffer.alloc(0) : Buffer.from(frame.body, 'base64');
          if (body.length > HOST_RPC_MAX_BODY_BYTES) throw new RpcBodyTooLargeError();
          const res = await opts.app.inject({
            method: frame.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
            url: frame.path,
            headers: { ...frame.headers, host: '127.0.0.1' },
            payload: body,
            payloadAsStream: true,
          });
          const responseStream = res.stream();
          requests.set(frame.id, () => responseStream.destroy());
          responseStream.once('close', finish);
          if (aborted.has(frame.id)) {
            responseStream.destroy();
            return;
          }
          const declaredLength = Number(res.headers['content-length'] ?? 0);
          if (declaredLength > HOST_RPC_MAX_BODY_BYTES) {
            responseStream.destroy();
            throw new RpcBodyTooLargeError();
          }
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of responseStream) {
            size += (chunk as Buffer).length;
            if (size > HOST_RPC_MAX_BODY_BYTES) throw new RpcBodyTooLargeError();
            chunks.push(chunk as Buffer);
          }
          if (aborted.has(frame.id)) return;
          rpc.write({
            type: 'http.res',
            id: frame.id,
            status: res.statusCode,
            headers: res.headers,
            body: chunks.length > 0 ? Buffer.concat(chunks).toString('base64') : undefined,
          });
        })().catch((error: unknown) => {
          if (aborted.has(frame.id)) {
            finish();
            return;
          }
          if (error instanceof RpcBodyTooLargeError) {
            respondError(frame.id, 413, 41301, error.message);
            finish();
            return;
          }
          respondError(frame.id, 500, 50000, error instanceof Error ? error.message : String(error));
          requests.get(frame.id)?.();
          finish();
        });
        return;
      }
      if (frame.type === 'http.cancel') {
        aborted.add(frame.id);
        requests.get(frame.id)?.();
        requests.delete(frame.id);
        return;
      }
      if (frame.type === 'ws.open') {
        const isV1 = frame.path === WS_PATH_V1 || frame.path.startsWith(`${WS_PATH_V1}?`);
        const isDebug = frame.path === WS_DEBUG_PATH || frame.path.startsWith(`${WS_DEBUG_PATH}?`);
        const wss = isV1 ? opts.wssV1 : isDebug ? opts.wssDebug : undefined;
        if (wss === undefined) {
          rpc.write({ type: 'ws.close', id: frame.id, code: 1008, reason: 'unknown ws route' });
          return;
        }
        const fake = new FakeWebSocket(
          (data) => {
            rpc.write({ type: 'ws.msg', id: frame.id, data });
          },
          (code, reason) => {
            sockets.delete(frame.id);
            rpc.write({ type: 'ws.close', id: frame.id, code, reason });
          },
          () => rpc.bufferedBytes,
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
    },
    undefined,
    cleanup,
  );
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
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
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
