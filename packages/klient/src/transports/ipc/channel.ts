/**
 * IPC client channel — connects to a `serveKlientIpc` host over a unix
 * domain socket. Calls are correlated by client-chosen ids with a per-call
 * deadline; event subscriptions are registered before the handshake
 * completes and flushed once it does. There is no automatic reconnect: a
 * broken socket rejects in-flight calls and stays closed (the WS transport
 * owns the resumable-connection story).
 */

import { createConnection, type Socket } from 'node:net';

import type {
  EventSourceRef,
  IDisposable,
  KlientChannel,
  ScopeRef,
} from '../../core/channel.js';
import { RPCError } from '../../core/errors.js';
import { trimTrailingUndefined } from '../args.js';
import { encodeFrame, NdjsonDecoder, type IpcFrame } from './codec.js';

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export interface IpcChannelOptions {
  readonly socketPath: string;
  readonly token?: string;
  /** Per-call deadline (ms). Default `30000`; `0` disables. */
  readonly callTimeoutMs?: number;
}

interface PendingCall {
  readonly resolve: (data: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Async queue for streaming responses. The server pushes chunks via
 * `stream_data` frames; the client pulls them with `next()`. Back-pressure
 * is implicit: the queue buffers until the consumer drains.
 */
interface PendingStream {
  push(chunk: unknown): void;
  end(): void;
  error(err: Error): void;
}

function scopeKindOf(scope: ScopeRef): 'core' | 'session' | 'agent' {
  if (scope.agentId !== undefined) return 'agent';
  if (scope.sessionId !== undefined) return 'session';
  return 'core';
}

export class IpcChannel implements KlientChannel {
  private readonly socket: Socket;
  private readonly decoder = new NdjsonDecoder();
  private readonly callTimeoutMs: number;
  private readonly pending = new Map<string, PendingCall>();
  private readonly streams = new Map<string, PendingStream>();
  private readonly listens = new Map<
    string,
    { handler: (data: unknown) => void; onError?: (error: Error) => void }
  >();
  private readonly ready: Promise<void>;
  private closed = false;
  private seq = 0;
  private readonly idPrefix = `i${Date.now().toString(36)}`;

  constructor(options: IpcChannelOptions) {
    this.callTimeoutMs = options.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.socket = createConnection(options.socketPath);
    this.ready = new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        reject(error);
      };
      this.socket.once('error', onError);
      this.socket.once('connect', () => {
        // The host sends `ready` immediately; answer with the handshake.
        this.send({ type: 'hello', token: options.token });
        this.socket.off('error', onError);
        resolve();
      });
    });
    // The promise is consumed lazily by call/listen; never let it reject unhandled.
    this.ready.catch(() => {});

    this.socket.on('data', (chunk) => {
      for (const frame of this.decoder.push(chunk.toString('utf8'))) {
        this.onFrame(frame);
      }
    });
    this.socket.on('close', () => {
      this.closed = true;
      this.failAll(new Error('ipc closed'));
      this.listens.clear();
    });
    this.socket.on('error', () => {
      // 'close' always follows; teardown lives there.
    });
  }

  async call(scope: ScopeRef, service: string, method: string, args: unknown[]): Promise<unknown> {
    await this.ready;
    if (this.closed) throw new Error('ipc closed');
    const id = this.nextId();
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer =
        this.callTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RPCError(50001, `call timed out after ${this.callTimeoutMs}ms`));
            }, this.callTimeoutMs)
          : undefined;
      this.pending.set(id, { resolve, reject, timer });
    });
    this.send({
      type: 'call',
      id,
      scope: scopeKindOf(scope),
      service,
      method,
      // NDJSON is JSON: trailing optional args would cross as `null` and
      // defeat the host's default parameters — trim them.
      arg: trimTrailingUndefined(args),
      sessionId: scope.sessionId,
      agentId: scope.agentId,
    });
    return promise;
  }

  stream(scope: ScopeRef, service: string, method: string, args: unknown[]): AsyncIterable<unknown> {
    return {
      [Symbol.asyncIterator]: () => {
        // Simple queue: push/pull with deferred promises. `buffer` holds
        // already-received chunks waiting for a `next()` call; `waiters`
        // holds unresolved `next()` calls waiting for a chunk.
        const buffer: Array<IteratorResult<unknown>> = [];
        const waiters: Array<{
          resolve: (result: IteratorResult<unknown>) => void;
          reject: (err: Error) => void;
        }> = [];
        let done = false;
        let streamId: string | undefined;

        const pending: PendingStream = {
          push(chunk: unknown) {
            if (done) return;
            const result: IteratorResult<unknown> = { done: false, value: chunk };
            const waiter = waiters.shift();
            if (waiter !== undefined) {
              waiter.resolve(result);
            } else {
              buffer.push(result);
            }
          },
          end: () => {
            if (done) return;
            done = true;
            if (streamId !== undefined) this.streams.delete(streamId);
            const terminal: IteratorResult<unknown> = { done: true, value: undefined };
            const waiter = waiters.shift();
            if (waiter !== undefined) {
              waiter.resolve(terminal);
            } else {
              buffer.push(terminal);
            }
            // Resolve remaining waiters with done
            for (const w of waiters) {
              w.resolve({ done: true, value: undefined });
            }
            waiters.length = 0;
          },
          error: (err: Error) => {
            if (done) return;
            done = true;
            if (streamId !== undefined) this.streams.delete(streamId);
            const waiter = waiters.shift();
            if (waiter !== undefined) {
              waiter.reject(err);
            } else {
              // Store as a throwing result
              buffer.push({ done: true, value: err } as IteratorResult<unknown>);
            }
            for (const w of waiters) {
              w.reject(err);
            }
            waiters.length = 0;
          },
        };

        // Start the stream after the handshake is done.
        let started = false;
        const ensureStarted = (): void => {
          if (started) return;
          started = true;
          void this.ready.then(() => {
            if (this.closed) {
              pending.error(new Error('ipc closed'));
              return;
            }
            streamId = this.nextId();
            this.streams.set(streamId, pending);
            this.send({
              type: 'stream',
              id: streamId,
              scope: scopeKindOf(scope),
              service,
              method,
              arg: trimTrailingUndefined(args),
              sessionId: scope.sessionId,
              agentId: scope.agentId,
            });
          });
        };

        return {
          next(): Promise<IteratorResult<unknown>> {
            ensureStarted();
            const buffered = buffer.shift();
            if (buffered !== undefined) {
              // Check if this is an error stored as { done: true, value: Error }
              if (buffered.done && buffered.value instanceof Error) {
                return Promise.reject(buffered.value);
              }
              return Promise.resolve(buffered);
            }
            if (done) return Promise.resolve({ done: true, value: undefined });
            return new Promise((resolve, reject) => {
              waiters.push({ resolve, reject });
            });
          },
          return: (): Promise<IteratorResult<unknown>> => {
            if (!done) {
              done = true;
              if (streamId !== undefined) {
                this.streams.delete(streamId);
                this.send({ type: 'stream_cancel', id: streamId });
              }
              // Resolve any pending waiters
              for (const w of waiters) {
                w.resolve({ done: true, value: undefined });
              }
              waiters.length = 0;
            }
            return Promise.resolve({ done: true, value: undefined });
          },
        };
      },
    };
  }

  listen(
    scope: ScopeRef,
    source: EventSourceRef,
    handler: (data: unknown) => void,
    onError?: (error: Error) => void,
  ): IDisposable {
    const id = this.nextId();
    this.listens.set(id, { handler, onError });
    const base = {
      type: 'listen',
      id,
      scope: scopeKindOf(scope),
      sessionId: scope.sessionId,
      agentId: scope.agentId,
    };
    const frame: IpcFrame =
      source.kind === 'stream'
        ? { ...base, event: source.name }
        : { ...base, service: source.service, event: source.event };
    void this.ready.then(() => {
      this.send(frame);
    });
    return {
      dispose: () => {
        if (!this.listens.delete(id)) return;
        void this.ready.then(() => {
          this.send({ type: 'unlisten', id });
        });
      },
    };
  }

  close(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    this.failAll(new Error('ipc closed'));
    this.listens.clear();
    this.socket.end();
    return Promise.resolve();
  }

  // -------------------------------------------------------------------------

  private nextId(): string {
    this.seq += 1;
    return `${this.idPrefix}_${this.seq}`;
  }

  private onFrame(frame: IpcFrame): void {
    const id = typeof frame.id === 'string' ? frame.id : '';
    switch (frame.type) {
      case 'ready':
        return;
      case 'result': {
        const p = this.take(id);
        p?.resolve(frame.data);
        return;
      }
      case 'error': {
        const error = new RPCError(
          typeof frame.code === 'number' ? frame.code : 50001,
          frame.msg ?? 'error',
        );
        const p = this.take(id);
        if (p !== undefined) {
          p.reject(error);
          return;
        }
        const sub = this.listens.get(id);
        if (sub !== undefined) {
          this.listens.delete(id);
          sub.onError?.(error);
        }
        return;
      }
      case 'listen_result':
        return;
      case 'event': {
        this.listens.get(id)?.handler(frame.data);
        return;
      }
      case 'stream_data': {
        this.streams.get(id)?.push(frame.data);
        return;
      }
      case 'stream_end': {
        this.streams.get(id)?.end();
        return;
      }
      case 'stream_error': {
        const s = this.streams.get(id);
        if (s !== undefined) {
          s.error(
            new RPCError(
              typeof frame.code === 'number' ? frame.code : 50001,
              frame.msg ?? 'stream error',
            ),
          );
        }
        return;
      }
      default:
        return;
    }
  }

  private take(id: string): PendingCall | undefined {
    const p = this.pending.get(id);
    if (p !== undefined) {
      this.pending.delete(id);
      if (p.timer !== undefined) clearTimeout(p.timer);
    }
    return p;
  }

  private failAll(err: Error): void {
    for (const p of this.pending.values()) {
      if (p.timer !== undefined) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
    for (const s of this.streams.values()) {
      s.error(err);
    }
    this.streams.clear();
  }

  private send(frame: IpcFrame): void {
    if (this.closed || this.socket.destroyed) return;
    try {
      this.socket.write(encodeFrame(frame));
    } catch {
      // best-effort; the close handler handles teardown
    }
  }
}
