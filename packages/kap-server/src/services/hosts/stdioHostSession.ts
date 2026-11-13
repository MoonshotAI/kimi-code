import type { Duplex } from 'node:stream';

import {
  HOST_RPC_MAX_BODY_BYTES,
  JsonlRpcStream,
  RPC_BACKPRESSURE_TIMEOUT_MS,
} from '../../transport/jsonlRpcStream';
import type { RpcFrame } from '../../transport/stdioRpc';
import {
  HOST_HTTP_TIMEOUT_MS,
  HostRequestError,
  type HostHttpRequest,
  type HostHttpResponse,
  type HostSession,
  type HostWsHandlers,
  type HostWsSession,
} from './hostSession';

interface PendingHttp {
  resolve(res: HostHttpResponse): void;
  reject(err: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onCancel?: () => void;
}

export class StdioHostSession implements HostSession {
  private nextId = 0;
  private closed = false;
  private readonly pendingHttp = new Map<string, PendingHttp>();
  private readonly wsChannels = new Map<string, HostWsHandlers>();
  private readonly rpc: JsonlRpcStream<RpcFrame>;

  constructor(
    readonly version: string,
    stream: Duplex,
  ) {
    this.rpc = new JsonlRpcStream(
      stream,
      (frame) => {
        this.onFrame(frame);
      },
      () => {
        for (const handlers of this.wsChannels.values()) handlers.onBackpressure(false);
      },
      (error) => {
        this.close(error);
      },
      RPC_BACKPRESSURE_TIMEOUT_MS,
    );
  }

  request(req: HostHttpRequest): Promise<HostHttpResponse> {
    if (this.closed) {
      return Promise.reject(new HostRequestError('unavailable', 'host session is closed'));
    }
    if (req.signal?.aborted === true) {
      return Promise.reject(new HostRequestError('cancelled', 'host request cancelled'));
    }
    if (req.body !== undefined && req.body.length > HOST_RPC_MAX_BODY_BYTES) {
      return Promise.reject(
        new HostRequestError('body_too_large', `HTTP body exceeds the ${String(HOST_RPC_MAX_BODY_BYTES)} byte host proxy limit`),
      );
    }
    const id = String(++this.nextId);
    const body = req.body !== undefined && req.body.length > 0 ? req.body.toString('base64') : undefined;
    return new Promise<HostHttpResponse>((resolve, reject) => {
      const settle = (failure: 'cancelled' | 'timeout', message: string): void => {
        const pending = this.pendingHttp.get(id);
        if (pending === undefined) return;
        this.pendingHttp.delete(id);
        clearTimeout(pending.timeout);
        if (pending.signal !== undefined && pending.onCancel !== undefined) {
          pending.signal.removeEventListener('abort', pending.onCancel);
        }
        this.rpc.write({ type: 'http.cancel', id });
        pending.reject(new HostRequestError(failure, message));
      };
      const onCancel = req.signal === undefined
        ? undefined
        : () => {
            settle('cancelled', 'host request cancelled');
          };
      const timeout = setTimeout(
        () => {
          settle('timeout', 'host request timed out');
        },
        req.timeoutMs ?? HOST_HTTP_TIMEOUT_MS,
      );
      timeout.unref?.();
      this.pendingHttp.set(id, { resolve, reject, timeout, signal: req.signal, onCancel });
      req.signal?.addEventListener('abort', onCancel!, { once: true });
      this.rpc.write({
        type: 'http.req',
        id,
        method: req.method,
        path: req.path,
        headers: req.headers,
        body,
      });
    });
  }

  openWebSocket(path: string, handlers: HostWsHandlers): HostWsSession {
    const id = String(++this.nextId);
    if (this.closed) {
      queueMicrotask(() => {
        handlers.onClose(1001, 'host session is closed');
      });
      return { send() {}, close() {} };
    }
    this.wsChannels.set(id, handlers);
    const ready = this.rpc.write({ type: 'ws.open', id, path });
    if (!ready) handlers.onBackpressure(true);
    return {
      send: (data) => {
        if (!this.closed && this.wsChannels.has(id)) {
          const ready = this.rpc.write({ type: 'ws.msg', id, data });
          handlers.onBackpressure(!ready);
        }
      },
      close: (code, reason) => {
        if (this.wsChannels.delete(id)) this.rpc.write({ type: 'ws.close', id, code, reason });
      },
    };
  }

  private onFrame(frame: RpcFrame): void {
    if (frame.type === 'http.res') {
      const pending = this.pendingHttp.get(frame.id);
      if (pending === undefined) return;
      this.pendingHttp.delete(frame.id);
      clearTimeout(pending.timeout);
      if (pending.signal !== undefined && pending.onCancel !== undefined) {
        pending.signal.removeEventListener('abort', pending.onCancel);
      }
      pending.resolve({
        status: frame.status,
        headers: frame.headers,
        body: frame.body === undefined ? Buffer.alloc(0) : Buffer.from(frame.body, 'base64'),
      });
      return;
    }
    if (frame.type === 'ws.msg') {
      this.wsChannels.get(frame.id)?.onMessage(frame.data);
      return;
    }
    if (frame.type === 'ws.close') {
      const handlers = this.wsChannels.get(frame.id);
      this.wsChannels.delete(frame.id);
      handlers?.onClose(frame.code, frame.reason);
    }
  }

  close(error?: Error): void {
    if (this.closed) return;
    this.closed = true;
    const failure = new HostRequestError('unavailable', error?.message ?? 'host connection closed');
    for (const pending of this.pendingHttp.values()) {
      clearTimeout(pending.timeout);
      if (pending.signal !== undefined && pending.onCancel !== undefined) {
        pending.signal.removeEventListener('abort', pending.onCancel);
      }
      pending.reject(failure);
    }
    this.pendingHttp.clear();
    for (const handlers of this.wsChannels.values()) handlers.onClose(1001, 'host connection closed');
    this.wsChannels.clear();
    this.rpc.dispose();
  }
}
