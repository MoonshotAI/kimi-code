/**
 * `/api/v2/ws` socket — the persistent WebSocket transport behind `WsKlient`.
 *
 * Speaks the kap-server v2 JSON protocol: one socket multiplexes RPC `call`s
 * and event `listen`s, correlated by client-chosen ids. Adds the client-side
 * safety features a long-lived devtool connection needs: `hello` handshake,
 * `ping`→`pong` heartbeat answers, per-call timeouts, and opt-out automatic
 * reconnect (active `listen`s are re-subscribed after a reconnect; in-flight
 * calls reject on close — the server cannot resume them).
 *
 * The bearer token is presented at the upgrade through the
 * `kimi-code.bearer.<token>` subprotocol (the only credential channel a browser
 * WebSocket has) and again in the `hello` frame for the present-only handshake
 * check. Works against the DOM WebSocket (browsers, Node ≥ 21); any compatible
 * implementation can be injected for tests.
 */

import { RPCError } from './errors.js';

/** Wire scope kinds, mirroring kap-server's `ScopeKind`. */
export type WsScopeKind = 'core' | 'session' | 'agent';

/** Scope coordinates carried on `call` / `listen` frames. */
export interface WsScopeIds {
  readonly sessionId?: string;
  readonly agentId?: string;
}

export type WsSocketState = 'connecting' | 'open' | 'closed';

export interface WsSubscription {
  dispose(): void;
}

/** Minimal DOM-compatible WebSocket surface this module codes against. */
export interface WsLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (event: never) => void): void;
}

export interface WsLikeCtor {
  new (url: string, protocols?: string | string[]): WsLike;
  readonly OPEN: number;
}

export interface WsSocketOptions {
  /** Server base URL (`http(s)://host:port`) or a full `ws(s)://…/api/v2/ws` URL. */
  readonly url: string;
  /** Optional bearer token. */
  readonly token?: string;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Reconnect after an unexpected close. Default `true`. */
  readonly autoReconnect?: boolean;
  /** Base delay (ms) for the reconnect backoff. Default `500`. */
  readonly reconnectDelayMs?: number;
  /** Per-call deadline (ms). Default `30000`. */
  readonly callTimeoutMs?: number;
}

interface PendingCall {
  readonly resolve: (data: unknown) => void;
  readonly reject: (err: Error) => void;
  readonly timer: ReturnType<typeof setTimeout> | undefined;
}

interface ActiveListen {
  readonly scope: WsScopeKind;
  readonly service?: string;
  readonly event: string;
  readonly ids: WsScopeIds;
  readonly handler: (data: unknown) => void;
  readonly onError?: (error: Error) => void;
  acknowledged: boolean;
}

export interface WsListenError {
  readonly scope: WsScopeKind;
  readonly service?: string;
  readonly event: string;
  readonly error: Error;
}

interface ServerFrame {
  readonly type: string;
  readonly id?: string;
  readonly data?: unknown;
  readonly code?: number;
  readonly msg?: string;
  readonly eventId?: string;
}

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';
const DEFAULT_CALL_TIMEOUT_MS = 30_000;

export class WsSocket {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly WsCtor: WsLikeCtor;
  private readonly autoReconnect: boolean;
  private readonly reconnectDelayMs: number;
  private readonly callTimeoutMs: number;

  private ws: WsLike | undefined;
  private state: WsSocketState = 'connecting';
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private readyWaiters: { resolve: () => void; reject: (err: Error) => void }[] = [];

  private readonly pending = new Map<string, PendingCall>();
  private readonly listens = new Map<string, ActiveListen>();
  private readonly eventControllers = new Map<string, AbortController>();
  private readonly stateListeners = new Set<(state: WsSocketState) => void>();
  private readonly listenErrorListeners = new Set<(event: WsListenError) => void>();

  private seq = 0;
  private readonly idPrefix = `k${Date.now().toString(36)}`;

  constructor(opts: WsSocketOptions) {
    this.wsUrl = toWsUrl(opts.url);
    this.token = opts.token;
    const ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsLikeCtor | undefined);
    if (ctor === undefined) {
      throw new Error('no WebSocket implementation available; pass WebSocketImpl');
    }
    this.WsCtor = ctor;
    this.autoReconnect = opts.autoReconnect ?? true;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.callTimeoutMs = opts.callTimeoutMs ?? DEFAULT_CALL_TIMEOUT_MS;
    this.connect();
  }

  get currentState(): WsSocketState {
    return this.state;
  }

  onDidChangeState(listener: (state: WsSocketState) => void): WsSubscription {
    this.stateListeners.add(listener);
    return { dispose: () => this.stateListeners.delete(listener) };
  }

  onDidListenError(listener: (event: WsListenError) => void): WsSubscription {
    this.listenErrorListeners.add(listener);
    return { dispose: () => this.listenErrorListeners.delete(listener) };
  }

  /** RPC call over the socket; rejects on `error` frame, timeout, or close. */
  async call<T>(
    scope: WsScopeKind,
    service: string,
    method: string,
    arg?: unknown,
    ids?: WsScopeIds,
  ): Promise<T> {
    await this.whenReady();
    // The socket may have dropped between `whenReady` resolving and this
    // continuation running; never register a call we cannot send.
    if (this.state !== 'open') {
      throw new Error('ws closed');
    }
    const id = this.nextId();
    const promise = new Promise<T>((resolve, reject) => {
      const timer =
        this.callTimeoutMs > 0
          ? setTimeout(() => {
              this.pending.delete(id);
              reject(new RPCError(50001, `call timed out after ${this.callTimeoutMs}ms`));
            }, this.callTimeoutMs)
          : undefined;
      this.pending.set(id, {
        resolve: resolve as (data: unknown) => void,
        reject,
        timer,
      });
    });
    this.send({ type: 'call', id, scope, service, method, arg, ...ids });
    return promise;
  }

  /**
   * Subscribe to a scope event stream. The subscription survives reconnects
   * (re-sent after each reconnect) until `dispose()`d.
   */
  listen(
    scope: WsScopeKind,
    event: string,
    ids: WsScopeIds,
    handler: (data: unknown) => void,
    service?: string,
    onError?: (error: Error) => void,
  ): WsSubscription {
    const id = this.nextId();
    this.listens.set(id, { scope, service, event, ids, handler, onError, acknowledged: false });
    if (this.state === 'open') {
      this.send({ type: 'listen', id, scope, service, event, ...ids });
    }
    return {
      dispose: () => {
        if (!this.listens.delete(id)) return;
        if (this.state === 'open') {
          this.send({ type: 'unlisten', id });
        }
      },
    };
  }

  /** Tear the socket down permanently; rejects in-flight calls. */
  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    this.setState('closed');
    this.ws?.close();
    this.ws = undefined;
    this.failAll(new Error('ws closed'));
    this.rejectReadyWaiters(new Error('ws closed'));
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private nextId(): string {
    this.seq += 1;
    return `${this.idPrefix}_${this.seq}`;
  }

  private connect(): void {
    this.setState('connecting');
    const protocols =
      this.token !== undefined && this.token.length > 0
        ? [`${WS_BEARER_PROTOCOL_PREFIX}${this.token}`]
        : undefined;
    let ws: WsLike;
    try {
      ws = new this.WsCtor(this.wsUrl, protocols);
    } catch (error) {
      this.scheduleReconnect(error);
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.onOpen();
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', () => {
      this.onClose();
    });
    ws.addEventListener('error', () => {
      // The 'close' event always follows 'error'; reconnect logic lives there.
    });
  }

  private onOpen(): void {
    this.reconnectAttempt = 0;
    this.setState('open');
    this.send({ type: 'hello', token: this.token });
    for (const [id, sub] of this.listens) {
      this.send({
        type: 'listen',
        id,
        scope: sub.scope,
        service: sub.service,
        event: sub.event,
        ...sub.ids,
      });
    }
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.resolve();
  }

  private onMessage(raw: unknown): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case 'ready':
      case 'server_hello':
        return;
      case 'ping':
        this.send({ type: 'pong' });
        return;
      case 'result': {
        const p = this.take(frame.id);
        p?.resolve(frame.data);
        return;
      }
      case 'error': {
        const p = this.take(frame.id);
        if (p !== undefined) {
          p.reject(new RPCError(frame.code ?? 50001, frame.msg ?? 'error'));
        } else {
          const sub = this.listens.get(frame.id ?? '');
          if (sub !== undefined) {
            this.listens.delete(frame.id ?? '');
            const error = new RPCError(frame.code ?? 50001, frame.msg ?? 'error');
            sub.onError?.(error);
            queueMicrotask(() => {
              for (const listener of this.listenErrorListeners) {
                listener({ scope: sub.scope, service: sub.service, event: sub.event, error });
              }
            });
          }
        }
        return;
      }
      case 'listen_result': {
        const sub = this.listens.get(frame.id ?? '');
        if (sub !== undefined) sub.acknowledged = true;
        return;
      }
      case 'event': {
        const sub = this.listens.get(frame.id ?? '');
        if (sub === undefined) return;
        if (frame.eventId === undefined) {
          sub.handler(frame.data);
          return;
        }
        const controller = new AbortController();
        const eventKey = `${frame.id}:${frame.eventId}`;
        this.eventControllers.set(eventKey, controller);
        const waits: Promise<unknown>[] = [];
        const data = {
          ...(frame.data as object),
          signal: controller.signal,
          waitUntil: (promise: Promise<unknown>) => waits.push(promise),
        };
        try {
          sub.handler(data);
        } catch {
          // Listener failures are fail-open for the server-side event.
        }
        void Promise.allSettled(waits).finally(() => {
          if (!this.eventControllers.delete(eventKey)) return;
          this.send({ type: 'event_result', id: frame.id, eventId: frame.eventId });
        });
        return;
      }
      case 'event_cancel': {
        const key = `${frame.id}:${frame.eventId}`;
        const controller = this.eventControllers.get(key);
        if (controller !== undefined) {
          this.eventControllers.delete(key);
          controller.abort();
        }
        return;
      }
    }
  }

  private onClose(): void {
    this.ws = undefined;
    for (const controller of this.eventControllers.values()) controller.abort();
    this.eventControllers.clear();
    this.failAll(new Error('ws closed'));
    if (this.manualClose || !this.autoReconnect) {
      this.setState('closed');
      this.rejectReadyWaiters(new Error('ws closed'));
      return;
    }
    // Transient drop: queued calls keep waiting for the reconnect.
    this.scheduleReconnect(undefined);
  }

  private scheduleReconnect(_cause: unknown): void {
    if (this.manualClose || !this.autoReconnect) {
      this.setState('closed');
      return;
    }
    this.reconnectAttempt += 1;
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), 10_000);
    this.setState('connecting');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  private whenReady(): Promise<void> {
    if (this.state === 'open') return Promise.resolve();
    if (this.state === 'closed' && this.manualClose) {
      return Promise.reject(new Error('ws closed'));
    }
    return new Promise<void>((resolve, reject) => {
      this.readyWaiters.push({ resolve, reject });
    });
  }

  private rejectReadyWaiters(err: Error): void {
    const waiters = this.readyWaiters;
    this.readyWaiters = [];
    for (const w of waiters) w.reject(err);
  }

  private take(id: string | undefined): PendingCall | undefined {
    const p = this.pending.get(id ?? '');
    if (p !== undefined) {
      this.pending.delete(id ?? '');
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
  }

  private send(frame: Record<string, unknown>): void {
    const ws = this.ws;
    if (ws === undefined || ws.readyState !== this.WsCtor.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      // best-effort; the close handler handles teardown
    }
  }

  private setState(next: WsSocketState): void {
    if (this.state === next) return;
    this.state = next;
    for (const listener of this.stateListeners) listener(next);
  }
}

/** Derive the `/api/v2/ws` WebSocket URL from a server base URL (or pass a full ws URL through). */
function toWsUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for WS transport: ${base}`);
  }
  if (!url.pathname.endsWith('/api/v2/ws')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v2/ws`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
