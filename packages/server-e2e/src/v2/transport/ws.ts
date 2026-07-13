/**
 * `/api/v2/ws` client — a single multiplexed WebSocket for RPC `call`s and
 * event `listen`s.
 *
 * Protocol (see `server-v2/src/transport/ws/wsProtocol.ts`):
 *   server → { type:'ready' } on connect
 *   client → { type:'hello', token? } (no ack; server accepts synchronously)
 *   client → { type:'call', id, scope, sessionId?, agentId?, sa, arg? }
 *   server → { type:'result', id, data } | { type:'error', id, code, msg }
 *   client → { type:'listen', id, scope, sessionId?, agentId?, event }
 *   server → { type:'event', id, data } (streamed until `unlisten`)
 *   server → { type:'ping' } → client → { type:'pong' }
 *
 * Auth is enforced at the HTTP upgrade, so the bearer token is sent on the
 * upgrade request (`authorization` header). The post-connect `hello` is a
 * defense-in-depth handshake, not the real gate.
 */
import { ulid } from 'ulid';
import { WebSocket as NodeWebSocket } from 'ws';

import { RpcError } from '../errors.js';

import type { ScopeKind, ScopeParams } from './http.js';

export interface V2SocketOptions {
  /** Base URL of the server, e.g. `http://127.0.0.1:58627`. */
  readonly baseUrl: string;
  /** Default `/api/v2`. WS endpoint is `${apiPrefix}/ws`. */
  readonly apiPrefix?: string;
  /** Optional bearer token sent on the upgrade request. */
  readonly token?: string;
  /** Override the WebSocket implementation (testing / browser). */
  readonly wsImpl?: typeof NodeWebSocket;
  /** Default 30s. Per-`call` deadline. */
  readonly callTimeoutMs?: number;
}

interface PendingCall {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Listener {
  onEvent: (data: unknown) => void;
  onError?: (err: RpcError) => void;
}

const DEFAULT_CALL_TIMEOUT_MS = 30_000;

/** A low-level v2 WebSocket. Most callers want the `EventsClient` wrapper. */
export class V2Socket {
  private readonly baseUrl: string;
  private readonly apiPrefix: string;
  private readonly token: string | undefined;
  private readonly wsImpl: typeof NodeWebSocket;
  private readonly callTimeoutMs: number;

  private ws: NodeWebSocket | null = null;
  private readonly calls = new Map<string, PendingCall>();
  private readonly listeners = new Map<string, Listener>();
  private closed = false;
  private readonly closeWaiters: Array<() => void> = [];

  constructor(opts: V2SocketOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, '');
    this.apiPrefix = opts.apiPrefix ?? '/api/v2';
    this.token = opts.token;
    this.wsImpl = opts.wsImpl ?? NodeWebSocket;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
  }

  /** Open the socket, wait for `ready`, and send `hello`. */
  connect(): Promise<void> {
    if (this.ws) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const wsUrl = `${this.baseUrl.replace(/^http/, 'ws')}${this.apiPrefix}/ws`;
      const headers: Record<string, string> = {};
      if (this.token !== undefined) headers['authorization'] = `Bearer ${this.token}`;
      const ws = new this.wsImpl(wsUrl, { headers });
      this.ws = ws;

      let opened = false;
      ws.once('error', (err) => {
        if (!opened) reject(err as Error);
      });
      ws.on('message', (data) => {
        if (!opened) {
          const frame = parseFrame(data);
          if (frame?.type === 'ready') {
            opened = true;
            this.send({ type: 'hello', token: this.token });
            resolve();
            return;
          }
        }
        this.onMessage(data);
      });
      ws.on('close', () => this.onClose());
      ws.on('error', () => this.onClose());
    });
  }

  /** Fire an RPC call over the socket; resolves with `data` or rejects. */
  call<T>(scope: ScopeKind, params: ScopeParams, sa: string, arg?: unknown): Promise<T> {
    const ws = this.requireWs();
    const id = `call-${ulid()}`;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.calls.delete(id);
        reject(new Error(`call ${sa} timed out after ${this.callTimeoutMs}ms`));
      }, this.callTimeoutMs);
      timer.unref?.();
      this.calls.set(id, {
        resolve: (data) => resolve(data as T),
        reject,
        timer,
      });
      this.send({
        type: 'call',
        id,
        scope,
        sessionId: params.sessionId,
        agentId: params.agentId,
        sa,
        arg,
      });
      void ws;
    });
  }

  /**
   * Subscribe to an event stream. `onEvent` fires for each pushed event. Returns
   * an `unlisten` handle (also sends `unlisten` to the server).
   */
  listen(
    scope: ScopeKind,
    params: ScopeParams,
    event: string,
    onEvent: (data: unknown) => void,
    onError?: (err: RpcError) => void,
  ): () => void {
    this.requireWs();
    const id = `listen-${ulid()}`;
    this.listeners.set(id, { onEvent, onError });
    this.send({
      type: 'listen',
      id,
      scope,
      sessionId: params.sessionId,
      agentId: params.agentId,
      event,
    });
    return () => {
      if (!this.listeners.has(id)) return;
      this.listeners.delete(id);
      this.send({ type: 'unlisten', id });
    };
  }

  /** Close the socket. Idempotent. */
  close(): Promise<void> {
    if (this.closed || !this.ws) return Promise.resolve();
    this.closed = true;
    return new Promise<void>((resolve) => {
      this.closeWaiters.push(resolve);
      this.ws?.close();
    });
  }

  private requireWs(): NodeWebSocket {
    if (!this.ws || this.closed) {
      throw new Error('v2 ws not connected — call `await socket.connect()` first');
    }
    return this.ws;
  }

  private send(frame: ClientFrame): void {
    if (!this.ws || this.closed) return;
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      // best-effort
    }
  }

  private onMessage(data: unknown): void {
    const frame = parseFrame(data);
    if (frame === null) return;
    switch (frame.type) {
      case 'ping':
        this.send({ type: 'pong' });
        return;
      case 'result': {
        const pending = this.calls.get(frame.id);
        if (pending) {
          this.calls.delete(frame.id);
          clearTimeout(pending.timer);
          pending.resolve(frame.data);
        }
        return;
      }
      case 'error': {
        const pending = this.calls.get(frame.id);
        if (pending) {
          this.calls.delete(frame.id);
          clearTimeout(pending.timer);
          pending.reject(new RpcError({ code: frame.code, msg: frame.msg, data: null, request_id: frame.id }));
          return;
        }
        const listener = this.listeners.get(frame.id);
        if (listener?.onError) {
          listener.onError(new RpcError({ code: frame.code, msg: frame.msg, data: null, request_id: frame.id }));
        }
        return;
      }
      case 'event': {
        const listener = this.listeners.get(frame.id);
        if (listener) listener.onEvent(frame.data);
        return;
      }
      default:
        return;
    }
  }

  private onClose(): void {
    if (this.closed && this.calls.size === 0 && this.listeners.size === 0) {
      // already cleaned up
    }
    this.closed = true;
    for (const pending of this.calls.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('v2 ws closed before call result'));
    }
    this.calls.clear();
    this.listeners.clear();
    for (const waiter of this.closeWaiters.splice(0)) waiter();
    this.ws = null;
  }
}

// ── Wire frame shapes (client view; not validated) ─────────────────────────

interface ReadyFrame {
  readonly type: 'ready';
  readonly heartbeatMs: number;
}
interface ResultFrame {
  readonly type: 'result';
  readonly id: string;
  readonly data: unknown;
}
interface ErrorFrame {
  readonly type: 'error';
  readonly id: string;
  readonly code: number;
  readonly msg: string;
}
interface EventFrame {
  readonly type: 'event';
  readonly id: string;
  readonly data: unknown;
}
interface PingFrame {
  readonly type: 'ping';
}
type ServerFrame = ReadyFrame | ResultFrame | ErrorFrame | EventFrame | PingFrame;

type ClientFrame =
  | { readonly type: 'hello'; readonly token?: string }
  | {
      readonly type: 'call';
      readonly id: string;
      readonly scope: ScopeKind;
      readonly sessionId?: string;
      readonly agentId?: string;
      readonly sa: string;
      readonly arg?: unknown;
    }
  | { readonly type: 'cancel'; readonly id: string }
  | {
      readonly type: 'listen';
      readonly id: string;
      readonly scope: ScopeKind;
      readonly sessionId?: string;
      readonly agentId?: string;
      readonly event: string;
    }
  | { readonly type: 'unlisten'; readonly id: string }
  | { readonly type: 'pong' };

function parseFrame(data: unknown): ServerFrame | null {
  const raw = typeof data === 'string' ? data : Buffer.isBuffer(data) ? data.toString('utf8') : null;
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ServerFrame;
  } catch {
    return null;
  }
}
