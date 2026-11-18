import { EventEmitter } from 'node:events';
import { chmod, mkdir, rm, stat } from 'node:fs/promises';
import type { IncomingHttpHeaders, IncomingMessage, OutgoingHttpHeaders } from 'node:http';
import { createServer, type Socket } from 'node:net';
import { dirname } from 'node:path';
import { PassThrough, type Duplex, type Readable } from 'node:stream';

import type { FastifyInstance } from 'fastify';
import type { WebSocket, WebSocketServer } from 'ws';

import {
  abortable,
  HOST_STREAM_BUFFER_BYTES,
  HOST_STREAM_CHUNK_BYTES,
  HOST_STREAM_MAX_CONCURRENT,
  hostStreamPolicy,
  type HostStreamPolicy,
  waitStreamDrain,
} from '../services/hosts/hostStreamPolicy';
import { withRequestCancellation } from '../routes/requestCancellation';
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

export interface RpcStreamRequestStartFrame {
  readonly type: 'stream.req.start';
  readonly id: string;
  readonly method: string;
  readonly path: string;
  readonly headers: IncomingHttpHeaders;
}

export interface RpcStreamResponseStartFrame {
  readonly type: 'stream.res.start';
  readonly id: string;
  readonly status: number;
  readonly headers: OutgoingHttpHeaders;
}

export interface RpcStreamDataFrame {
  readonly type: 'stream.req.data' | 'stream.res.data';
  readonly id: string;
  readonly seq: number;
  readonly data: string;
}

export interface RpcStreamEndFrame {
  readonly type: 'stream.req.end' | 'stream.res.end';
  readonly id: string;
}

export interface RpcStreamCreditFrame {
  readonly type: 'stream.req.credit' | 'stream.res.credit';
  readonly id: string;
  readonly seq: number;
}

export interface RpcStreamResetFrame {
  readonly type: 'stream.reset';
  readonly id: string;
  readonly message?: string;
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
  | RpcStreamRequestStartFrame
  | RpcStreamResponseStartFrame
  | RpcStreamDataFrame
  | RpcStreamEndFrame
  | RpcStreamCreditFrame
  | RpcStreamResetFrame
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

interface RemoteStream {
  readonly id: string;
  readonly policy: HostStreamPolicy;
  readonly request: PassThrough;
  readonly abort: AbortController;
  readonly routeAbort: AbortController;
  response?: Readable;
  responseCredit?: { readonly seq: number; resolve(): void };
  idleTimer?: ReturnType<typeof setTimeout>;
  totalTimer?: ReturnType<typeof setTimeout>;
  nextRequestSeq: number;
  nextResponseSeq: number;
  requestBytes: number;
  responseBytes: number;
  requestEnded: boolean;
  responseStarted: boolean;
  finished: boolean;
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
  const streams = new Map<string, RemoteStream>();
  const touchStream = (state: RemoteStream): void => {
    if (state.finished) return;
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => {
      finishStream(state, new Error('host stream made no progress'));
    }, state.policy.idleTimeoutMs);
    state.idleTimer.unref?.();
  };
  const finishStream = (state: RemoteStream, error?: Error, cancelRoute = true): void => {
    if (state.finished) return;
    state.finished = true;
    streams.delete(state.id);
    requests.delete(state.id);
    if (state.idleTimer !== undefined) clearTimeout(state.idleTimer);
    if (state.totalTimer !== undefined) clearTimeout(state.totalTimer);
    state.abort.abort();
    if (cancelRoute) state.routeAbort.abort();
    state.responseCredit = undefined;
    if (!state.requestEnded) state.request.destroy();
    state.response?.destroy();
    if (error !== undefined && !rpcCleaned()) {
      const failure = error;
      if (state.responseStarted) {
        rpc.write({ type: 'stream.reset', id: state.id, message: failure.message });
      } else if (error instanceof RpcBodyTooLargeError) {
        respondError(state.id, 413, 41301, failure.message);
      } else {
        respondError(state.id, 500, 50000, failure.message);
      }
    }
  };
  const rpcCleaned = (): boolean => stream.destroyed || !stream.writable;
  const writeStreamFrame = async (state: RemoteStream, frame: RpcFrame): Promise<void> => {
    const ready = rpc.write(frame);
    touchStream(state);
    if (!ready) await rpc.waitForDrain(state.abort.signal);
  };
  const receiveRequestData = (state: RemoteStream, frame: RpcStreamDataFrame): void => {
    if (state.requestEnded || frame.seq !== state.nextRequestSeq) return;
    const data = Buffer.from(frame.data, 'base64');
    if (data.length > HOST_STREAM_CHUNK_BYTES) {
      finishStream(state, new Error('host stream chunk exceeds its limit'));
      return;
    }
    state.requestBytes += data.length;
    if (state.requestBytes > state.policy.maxBodyBytes) {
      finishStream(state, new RpcBodyTooLargeError());
      return;
    }
    state.nextRequestSeq += 1;
    touchStream(state);
    const credit = (): void => {
      if (state.finished) return;
      const ready = rpc.write({ type: 'stream.req.credit', id: state.id, seq: frame.seq });
      touchStream(state);
      if (!ready) void rpc.waitForDrain(state.abort.signal).catch(() => {});
    };
    if (state.request.write(data)) credit();
    else void waitStreamDrain(state.request, state.abort.signal).then(credit).catch(() => {});
  };
  const startStream = (frame: RpcStreamRequestStartFrame): void => {
    if (aborted.has(frame.id) || streams.has(frame.id)) return;
    const policy = hostStreamPolicy(frame.path);
    if (policy === undefined) {
      respondError(frame.id, 400, 40000, 'host route is not streamable');
      return;
    }
    if (streams.size >= HOST_STREAM_MAX_CONCURRENT) {
      respondError(frame.id, 503, 50300, 'too many concurrent host streams');
      return;
    }
    if (Number(frame.headers['content-length'] ?? 0) > policy.maxBodyBytes) {
      respondError(frame.id, 413, 41301, `HTTP body exceeds the ${String(policy.maxBodyBytes)} byte host stream limit`);
      return;
    }
    const state: RemoteStream = {
      id: frame.id,
      policy,
      request: new PassThrough({ highWaterMark: HOST_STREAM_BUFFER_BYTES }),
      abort: new AbortController(),
      routeAbort: new AbortController(),
      nextRequestSeq: 0,
      nextResponseSeq: 0,
      requestBytes: 0,
      responseBytes: 0,
      requestEnded: false,
      responseStarted: false,
      finished: false,
    };
    streams.set(frame.id, state);
    requests.set(frame.id, () => {
      finishStream(state);
    });
    state.totalTimer = setTimeout(() => {
      finishStream(state, new Error('host stream timed out'));
    }, policy.totalTimeoutMs);
    state.totalTimer.unref?.();
    void (async () => {
      const res = await withRequestCancellation(state.routeAbort.signal, () => opts.app.inject({
        method: frame.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
        url: frame.path,
        headers: { ...frame.headers, host: '127.0.0.1' },
        payload: state.request,
        payloadAsStream: true,
      }));
      const response = res.stream();
      if (state.finished) {
        response.destroy();
        return;
      }
      state.response = response;
      const declaredLength = Number(res.headers['content-length'] ?? 0);
      if (declaredLength > policy.maxBodyBytes) throw new RpcBodyTooLargeError();
      state.responseStarted = true;
      await writeStreamFrame(state, {
        type: 'stream.res.start',
        id: frame.id,
        status: res.statusCode,
        headers: res.headers,
      });
      for await (const chunk of response) {
        const buffer = chunk as Buffer;
        for (let offset = 0; offset < buffer.length; offset += HOST_STREAM_CHUNK_BYTES) {
          const part = buffer.subarray(offset, offset + HOST_STREAM_CHUNK_BYTES);
          state.responseBytes += part.length;
          if (state.responseBytes > policy.maxBodyBytes) throw new RpcBodyTooLargeError();
          const seq = state.nextResponseSeq++;
          const credited = new Promise<void>((resolve) => {
            state.responseCredit = { seq, resolve };
          });
          await writeStreamFrame(state, {
            type: 'stream.res.data',
            id: frame.id,
            seq,
            data: part.toString('base64'),
          });
          await abortable(credited, state.abort.signal);
        }
      }
      await writeStreamFrame(state, { type: 'stream.res.end', id: frame.id });
      aborted.delete(frame.id);
      finishStream(state, undefined, false);
    })().catch((error: unknown) => {
      if (!state.finished) finishStream(state, error instanceof Error ? error : new Error('host stream failed'));
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
      if (frame.type === 'stream.req.start') {
        startStream(frame);
        return;
      }
      if (frame.type === 'stream.req.data') {
        const state = streams.get(frame.id);
        if (state !== undefined) receiveRequestData(state, frame);
        return;
      }
      if (frame.type === 'stream.req.end') {
        const state = streams.get(frame.id);
        if (state !== undefined && !state.requestEnded) {
          state.requestEnded = true;
          state.request.end();
          clearTimeout(state.idleTimer);
          state.idleTimer = undefined;
        }
        return;
      }
      if (frame.type === 'stream.res.credit') {
        const state = streams.get(frame.id);
        const credit = state?.responseCredit;
        if (state !== undefined && credit?.seq === frame.seq) {
          state.responseCredit = undefined;
          touchStream(state);
          credit.resolve();
        }
        return;
      }
      if (frame.type === 'stream.reset') {
        const state = streams.get(frame.id);
        if (state !== undefined) finishStream(state);
        return;
      }
      if (frame.type === 'http.req') {
        if (aborted.has(frame.id)) return;
        const routeAbort = new AbortController();
        requests.set(frame.id, () => {
          routeAbort.abort();
        });
        const finish = (): void => {
          requests.delete(frame.id);
          aborted.delete(frame.id);
        };
        void (async () => {
          const contentLength = Number(frame.headers['content-length'] ?? 0);
          if (contentLength > HOST_RPC_MAX_BODY_BYTES) throw new RpcBodyTooLargeError();
          const body = frame.body === undefined ? Buffer.alloc(0) : Buffer.from(frame.body, 'base64');
          if (body.length > HOST_RPC_MAX_BODY_BYTES) throw new RpcBodyTooLargeError();
          const res = await withRequestCancellation(routeAbort.signal, () => opts.app.inject({
            method: frame.method as 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE',
            url: frame.path,
            headers: { ...frame.headers, host: '127.0.0.1' },
            payload: body,
            payloadAsStream: true,
          }));
          const responseStream = res.stream();
          requests.set(frame.id, () => {
            routeAbort.abort();
            responseStream.destroy();
          });
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
