import { Duplex, PassThrough } from 'node:stream';

import {
  HOST_RPC_MAX_BODY_BYTES,
  JsonlRpcStream,
  RPC_BACKPRESSURE_TIMEOUT_MS,
} from '../../transport/jsonlRpcStream';
import type { RpcFrame, RpcStreamDataFrame, RpcStreamResponseStartFrame } from '../../transport/stdioRpc';
import {
  HOST_HTTP_TIMEOUT_MS,
  HostRequestError,
  type HostHttpRequest,
  type HostHttpResponse,
  type HostSession,
  type HostStreamHttpRequest,
  type HostStreamHttpResponse,
  type HostWsHandlers,
  type HostWsSession,
} from './hostSession';
import {
  abortable,
  HOST_STREAM_BUFFER_BYTES,
  HOST_STREAM_CHUNK_BYTES,
  HOST_STREAM_MAX_CONCURRENT,
  HostStreamStopped,
  hostStreamPolicy,
  type HostStreamPolicy,
  waitStreamDrain,
} from './hostStreamPolicy';

interface PendingHttp {
  resolve(res: HostHttpResponse): void;
  reject(err: Error): void;
  timeout: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  onCancel?: () => void;
}

interface PendingStream {
  readonly id: string;
  readonly policy: HostStreamPolicy;
  readonly response: PassThrough;
  readonly resolveHead: (response: HostStreamHttpResponse) => void;
  readonly rejectHead: (error: Error) => void;
  readonly abort: AbortController;
  readonly uploadAbort: AbortController;
  readonly idleTimeoutMs: number;
  readonly signal?: AbortSignal;
  readonly onCancel?: () => void;
  requestIterator?: AsyncIterator<Uint8Array>;
  requestCredit?: { readonly seq: number; resolve(): void };
  idleTimer?: ReturnType<typeof setTimeout>;
  totalTimer?: ReturnType<typeof setTimeout>;
  nextRequestSeq: number;
  nextResponseSeq: number;
  requestBytes: number;
  responseBytes: number;
  requestFinished: boolean;
  responseStarted: boolean;
  responseEnded: boolean;
  headSettled: boolean;
  finished: boolean;
}

export class StdioHostSession implements HostSession {
  private nextId = 0;
  private closed = false;
  private readonly pendingHttp = new Map<string, PendingHttp>();
  private readonly pendingStreams = new Map<string, PendingStream>();
  private readonly wsChannels = new Map<string, HostWsHandlers>();
  private readonly rpc: JsonlRpcStream<RpcFrame>;

  constructor(stream: Duplex) {
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

  requestStream(req: HostStreamHttpRequest): Promise<HostStreamHttpResponse> {
    const policy = hostStreamPolicy(req.path);
    if (policy === undefined) {
      return Promise.reject(new HostRequestError('unavailable', 'host route is not streamable'));
    }
    if (this.closed) return Promise.reject(new HostRequestError('unavailable', 'host session is closed'));
    if (req.signal?.aborted === true) {
      return Promise.reject(new HostRequestError('cancelled', 'host request cancelled'));
    }
    if (this.pendingStreams.size >= HOST_STREAM_MAX_CONCURRENT) {
      return Promise.reject(new HostRequestError('busy', 'too many concurrent host streams'));
    }
    const declaredLength = Number(req.headers['content-length'] ?? 0);
    if (declaredLength > policy.maxBodyBytes) {
      return Promise.reject(
        new HostRequestError('body_too_large', `HTTP body exceeds the ${String(policy.maxBodyBytes)} byte host stream limit`),
      );
    }
    const id = String(++this.nextId);
    let resolveHead!: (response: HostStreamHttpResponse) => void;
    let rejectHead!: (error: Error) => void;
    const head = new Promise<HostStreamHttpResponse>((resolve, reject) => {
      resolveHead = resolve;
      rejectHead = reject;
    });
    const response = new PassThrough({ highWaterMark: HOST_STREAM_BUFFER_BYTES });
    response.on('error', () => {});
    const onCancel = req.signal === undefined
      ? undefined
      : () => {
          const pending = this.pendingStreams.get(id);
          if (pending !== undefined) {
            this.finishStream(pending, new HostRequestError('cancelled', 'host request cancelled'), true);
          }
        };
    const pending: PendingStream = {
      id,
      policy,
      response,
      resolveHead,
      rejectHead,
      abort: new AbortController(),
      uploadAbort: new AbortController(),
      idleTimeoutMs: req.idleTimeoutMs ?? req.timeoutMs ?? policy.idleTimeoutMs,
      signal: req.signal,
      onCancel,
      nextRequestSeq: 0,
      nextResponseSeq: 0,
      requestBytes: 0,
      responseBytes: 0,
      requestFinished: false,
      responseStarted: false,
      responseEnded: false,
      headSettled: false,
      finished: false,
    };
    this.pendingStreams.set(id, pending);
    response.once('close', () => {
      if (!pending.responseEnded && !pending.finished) {
        this.finishStream(pending, new HostRequestError('cancelled', 'host response cancelled'), true);
      }
    });
    req.signal?.addEventListener('abort', onCancel!, { once: true });
    pending.totalTimer = setTimeout(() => {
      this.finishStream(pending, new HostRequestError('timeout', 'host stream timed out'), true);
    }, req.timeoutMs ?? policy.totalTimeoutMs);
    pending.totalTimer.unref?.();
    this.touchStream(pending);
    this.upload(pending, req);
    return head;
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

  private upload(pending: PendingStream, req: HostStreamHttpRequest): void {
    void (async () => {
      pending.requestIterator = req.body?.[Symbol.asyncIterator]();
      await this.writeStreamFrame(pending, {
        type: 'stream.req.start',
        id: pending.id,
        method: req.method,
        path: req.path,
        headers: req.headers,
      });
      const iterator = pending.requestIterator;
      if (iterator !== undefined) {
        while (!pending.requestFinished) {
          const next = await abortable(iterator.next(), pending.uploadAbort.signal);
          if (next.done) break;
          const chunk = Buffer.from(next.value.buffer, next.value.byteOffset, next.value.byteLength);
          for (let offset = 0; offset < chunk.length; offset += HOST_STREAM_CHUNK_BYTES) {
            if (pending.uploadAbort.signal.aborted) throw new HostStreamStopped();
            const part = chunk.subarray(offset, offset + HOST_STREAM_CHUNK_BYTES);
            pending.requestBytes += part.length;
            if (pending.requestBytes > pending.policy.maxBodyBytes) {
              throw new HostRequestError(
                'body_too_large',
                `HTTP body exceeds the ${String(pending.policy.maxBodyBytes)} byte host stream limit`,
              );
            }
            const seq = pending.nextRequestSeq++;
            const credited = new Promise<void>((resolve) => {
              pending.requestCredit = { seq, resolve };
            });
            await this.writeStreamFrame(pending, {
              type: 'stream.req.data',
              id: pending.id,
              seq,
              data: part.toString('base64'),
            });
            await abortable(credited, pending.uploadAbort.signal);
          }
        }
      }
      if (pending.uploadAbort.signal.aborted) throw new HostStreamStopped();
      await this.writeStreamFrame(pending, { type: 'stream.req.end', id: pending.id });
      if (pending.idleTimer !== undefined) clearTimeout(pending.idleTimer);
      pending.idleTimer = undefined;
      pending.requestFinished = true;
      pending.requestIterator = undefined;
    })().catch((error: unknown) => {
      if (error instanceof HostStreamStopped || pending.finished || pending.requestFinished || pending.responseStarted) return;
      const failure = error instanceof HostRequestError
        ? error
        : new HostRequestError('unavailable', error instanceof Error ? error.message : String(error));
      this.finishStream(pending, failure, true);
    });
  }

  private async writeStreamFrame(pending: PendingStream, frame: RpcFrame): Promise<void> {
    const ready = this.rpc.write(frame);
    this.touchStream(pending);
    if (!ready) await this.rpc.waitForDrain(pending.uploadAbort.signal);
  }

  private touchStream(pending: PendingStream): void {
    if (pending.finished) return;
    if (pending.idleTimer !== undefined) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => {
      this.finishStream(pending, new HostRequestError('timeout', 'host stream made no progress'), true);
    }, pending.idleTimeoutMs);
    pending.idleTimer.unref?.();
  }

  private stopUpload(pending: PendingStream): void {
    if (pending.requestFinished) return;
    pending.requestFinished = true;
    pending.uploadAbort.abort();
    pending.requestCredit = undefined;
    const iterator = pending.requestIterator;
    pending.requestIterator = undefined;
    if (iterator?.return !== undefined) void iterator.return().catch(() => {});
  }

  private finishStream(pending: PendingStream, error?: HostRequestError, notify = false): void {
    if (pending.finished) return;
    pending.finished = true;
    this.pendingStreams.delete(pending.id);
    if (pending.idleTimer !== undefined) clearTimeout(pending.idleTimer);
    if (pending.totalTimer !== undefined) clearTimeout(pending.totalTimer);
    if (pending.signal !== undefined && pending.onCancel !== undefined) {
      pending.signal.removeEventListener('abort', pending.onCancel);
    }
    this.stopUpload(pending);
    pending.abort.abort();
    if (notify && !this.closed) this.rpc.write({ type: 'http.cancel', id: pending.id });
    if (!pending.headSettled) {
      pending.headSettled = true;
      pending.rejectHead(error ?? new HostRequestError('unavailable', 'host stream ended before response headers'));
    }
    if (error !== undefined && !pending.responseEnded) pending.response.destroy(error);
  }

  private startResponse(pending: PendingStream, frame: RpcStreamResponseStartFrame): void {
    if (pending.responseStarted) return;
    const declaredLength = Number(frame.headers['content-length'] ?? 0);
    if (declaredLength > pending.policy.maxBodyBytes) {
      this.finishStream(pending, new HostRequestError('body_too_large', 'host response exceeds the stream limit'), true);
      return;
    }
    pending.responseStarted = true;
    pending.headSettled = true;
    this.touchStream(pending);
    this.stopUpload(pending);
    pending.resolveHead({ status: frame.status, headers: frame.headers, body: pending.response });
  }

  private receiveResponseData(pending: PendingStream, frame: RpcStreamDataFrame): void {
    if (!pending.responseStarted || frame.seq !== pending.nextResponseSeq) return;
    const data = Buffer.from(frame.data, 'base64');
    if (data.length > HOST_STREAM_CHUNK_BYTES) {
      this.finishStream(pending, new HostRequestError('unavailable', 'host stream chunk exceeds its limit'), true);
      return;
    }
    pending.responseBytes += data.length;
    if (pending.responseBytes > pending.policy.maxBodyBytes) {
      this.finishStream(pending, new HostRequestError('body_too_large', 'host response exceeds the stream limit'), true);
      return;
    }
    pending.nextResponseSeq += 1;
    this.touchStream(pending);
    const credit = (): void => {
      if (pending.finished) return;
      const ready = this.rpc.write({ type: 'stream.res.credit', id: pending.id, seq: frame.seq });
      this.touchStream(pending);
      if (!ready) void this.rpc.waitForDrain(pending.abort.signal).catch(() => {});
    };
    if (pending.response.write(data)) credit();
    else void waitStreamDrain(pending.response, pending.abort.signal).then(credit).catch(() => {});
  }

  private onFrame(frame: RpcFrame): void {
    if (frame.type === 'http.res') {
      const stream = this.pendingStreams.get(frame.id);
      if (stream !== undefined) {
        const body = frame.body === undefined ? Buffer.alloc(0) : Buffer.from(frame.body, 'base64');
        stream.responseStarted = true;
        stream.responseEnded = true;
        stream.headSettled = true;
        this.stopUpload(stream);
        stream.response.end(body);
        stream.resolveHead({ status: frame.status, headers: frame.headers, body: stream.response });
        this.finishStream(stream);
        return;
      }
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
    if (frame.type === 'stream.res.start') {
      const pending = this.pendingStreams.get(frame.id);
      if (pending !== undefined) this.startResponse(pending, frame);
      return;
    }
    if (frame.type === 'stream.res.data') {
      const pending = this.pendingStreams.get(frame.id);
      if (pending !== undefined) this.receiveResponseData(pending, frame);
      return;
    }
    if (frame.type === 'stream.res.end') {
      const pending = this.pendingStreams.get(frame.id);
      if (pending === undefined) return;
      if (!pending.responseStarted) {
        this.finishStream(pending, new HostRequestError('unavailable', 'host stream ended before response headers'));
        return;
      }
      pending.responseEnded = true;
      pending.response.end();
      this.finishStream(pending);
      return;
    }
    if (frame.type === 'stream.req.credit') {
      const pending = this.pendingStreams.get(frame.id);
      const credit = pending?.requestCredit;
      if (pending !== undefined && credit?.seq === frame.seq) {
        pending.requestCredit = undefined;
        this.touchStream(pending);
        credit.resolve();
      }
      return;
    }
    if (frame.type === 'stream.reset') {
      const pending = this.pendingStreams.get(frame.id);
      if (pending !== undefined) {
        this.finishStream(pending, new HostRequestError('unavailable', frame.message ?? 'host stream reset'));
      }
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
    for (const pending of this.pendingStreams.values()) this.finishStream(pending, failure);
    for (const handlers of this.wsChannels.values()) handlers.onClose(1001, 'host connection closed');
    this.wsChannels.clear();
    this.rpc.dispose();
  }
}
