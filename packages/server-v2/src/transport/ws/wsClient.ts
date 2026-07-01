/**
 * `/api/v2` WebSocket client — test/consumer-side counterpart of
 * {@link WsConnection}. Speaks the same JSON protocol:
 *   - `call(scope, sa, arg)` → Promise<data> (rejects on `error`)
 *   - `listen(scope, event)` → AsyncIterable<data> + `cancel()`
 *   - answers `ping` with `pong` (heartbeat)
 */

import { ulid } from 'ulid';
import { WebSocket } from 'ws';

import type { ScopeKind } from '../channel';
import { WS_BEARER_PROTOCOL_PREFIX } from './bearerProtocol';

interface PendingCall {
  readonly resolve: (data: unknown) => void;
  readonly reject: (err: Error) => void;
}

export interface WsClientOptions {
  readonly url: string;
  readonly token?: string;
}

interface ServerMsg {
  readonly type: string;
  readonly id?: string;
  readonly data?: unknown;
  readonly code?: number;
  readonly msg?: string;
}

export class RpcWsError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'RpcWsError';
  }
}

export class WsClient {
  private readonly ws: WebSocket;
  private readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (err: Error) => void;
  private readonly pending = new Map<string, PendingCall>();
  private readonly listeners = new Map<string, (data: unknown) => void>();

  constructor(opts: WsClientOptions) {
    // Present the credential at the upgrade (the server now requires a valid
    // bearer before completing the handshake) via the bearer subprotocol, the
    // same mechanism browser clients use. The `hello` frame still carries the
    // token for the present-only handshake check.
    const protocols =
      opts.token !== undefined ? [`${WS_BEARER_PROTOCOL_PREFIX}${opts.token}`] : undefined;
    this.ws = new WebSocket(opts.url, protocols);
    this.ready = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.ws.on('open', () => {
      this.ws.send(JSON.stringify({ type: 'hello', token: opts.token }));
    });
    this.ws.on('message', (data) => this.onMessage(data.toString()));
    this.ws.on('error', (err) => {
      this.rejectReady(err);
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
    this.ws.on('close', () => {
      const err = new Error('ws closed');
      for (const p of this.pending.values()) p.reject(err);
      this.pending.clear();
    });
  }

  async call<T>(
    scope: ScopeKind,
    sa: string,
    arg?: unknown,
    scopeIds?: { sessionId?: string; agentId?: string },
  ): Promise<T> {
    await this.ready;
    const id = ulid();
    this.ws.send(JSON.stringify({ type: 'call', id, scope, sa, arg, ...scopeIds }));
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (d: unknown) => void, reject });
    });
  }

  listen<T>(
    scope: ScopeKind,
    event: string,
    scopeIds?: { sessionId?: string; agentId?: string },
  ): { iterator: AsyncIterable<T>; cancel: () => void } {
    const id = ulid();
    const queue: T[] = [];
    let wake: (() => void) | undefined;
    let done = false;

    this.listeners.set(id, (data) => {
      queue.push(data as T);
      wake?.();
    });

    void this.ready.then(() => {
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: 'listen', id, scope, event, ...scopeIds }));
      }
    });

    const iterator: AsyncIterableIterator<T> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      next: async (): Promise<IteratorResult<T>> => {
        if (queue.length > 0) return { value: queue.shift() as T, done: false };
        if (done) return { value: undefined as unknown as T, done: true };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        if (queue.length > 0) return { value: queue.shift() as T, done: false };
        return { value: undefined as unknown as T, done: true };
      },
    };

    const cancel = (): void => {
      if (done) return;
      done = true;
      wake?.();
      this.listeners.delete(id);
      if (this.ws.readyState === this.ws.OPEN) {
        this.ws.send(JSON.stringify({ type: 'unlisten', id }));
      }
    };

    return { iterator, cancel };
  }

  close(): void {
    this.ws.close();
  }

  private onMessage(raw: string): void {
    let msg: ServerMsg;
    try {
      msg = JSON.parse(raw) as ServerMsg;
    } catch {
      return;
    }
    switch (msg.type) {
      case 'ready':
        this.resolveReady();
        return;
      case 'ping':
        this.ws.send(JSON.stringify({ type: 'pong' }));
        return;
      case 'result': {
        const p = this.pending.get(msg.id ?? '');
        if (p !== undefined) {
          this.pending.delete(msg.id ?? '');
          p.resolve(msg.data);
        }
        return;
      }
      case 'error': {
        const p = this.pending.get(msg.id ?? '');
        if (p !== undefined) {
          this.pending.delete(msg.id ?? '');
          p.reject(new RpcWsError(msg.code ?? 0, msg.msg ?? 'error'));
        }
        return;
      }
      case 'event': {
        const listener = this.listeners.get(msg.id ?? '');
        if (listener !== undefined) listener(msg.data);
        return;
      }
    }
  }
}
