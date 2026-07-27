/**
 * Minimal `/api/v1/ws` client for GLOBAL session facts — no subscriptions.
 *
 * The server pushes every global event (`event.session.*` /
 * `session.meta.updated` / `event.workspace.*` / `event.config.*`) to every
 * established connection, so this client subscribes to nothing: it sends a
 * `client_hello` with an empty subscription list (etiquette only — the
 * delivery set does not depend on it) and dispatches the coarse per-session
 * facts to the consumer:
 *
 *   - `event.session.work_changed` → `{busy, main_turn_active,
 *     pending_interaction, last_turn_reason}` for one session;
 *   - `event.session.created` / `session.meta.updated` → list-level signals
 *     (a session appeared / retitled), forwarded for list invalidation.
 *
 * Session/agent-grained events never arrive here (they stay subscribe-gated
 * server-side); the transcript chat channel has its own socket. Global
 * frames are live-only — a drop loses whatever fired meanwhile, so the
 * consumer answers `onReconnected` with a REST re-seed.
 *
 * The bearer token is presented at the upgrade through the
 * `kimi-code.bearer.<token>` subprotocol (the only credential channel a
 * browser WebSocket has).
 */

import type { WsLike, WsLikeCtor } from '../channel/wsLike';

export type SessionPendingInteraction = 'none' | 'approval' | 'question';
export type SessionTurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface SessionWorkFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: SessionTurnOutcome | undefined;
}

export interface GlobalEventsWsHandlers {
  /** Coarse work-fact tuple for one session changed. */
  onWorkChanged: (sessionId: string, facts: SessionWorkFacts) => void;
  /** A session was created (list-level signal). */
  onSessionCreated: (sessionId: string) => void;
  /** A session's title/patch changed (list-level signal). */
  onMetaUpdated: (sessionId: string) => void;
  /** Socket established (initial connect and every reconnect) — the consumer
   *  answers with a REST re-seed, since live facts are missed while down. */
  onReconnected: () => void;
}

export interface GlobalEventsWsOptions {
  /** Server base URL (`http(s)://host:port`) or a full `ws(s)://…/api/v1/ws` URL. */
  readonly url: string;
  readonly token?: string | undefined;
  readonly handlers: GlobalEventsWsHandlers;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Base delay (ms) for the reconnect backoff. Default `500`. */
  readonly reconnectDelayMs?: number;
}

interface ServerFrame {
  readonly type: string;
  readonly id?: string;
  readonly session_id?: string;
  readonly payload?: unknown;
}

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export class GlobalEventsWs {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly handlers: GlobalEventsWsHandlers;
  private readonly WsCtor: WsLikeCtor;
  private readonly reconnectDelayMs: number;

  private ws: WsLike | undefined;
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(opts: GlobalEventsWsOptions) {
    this.wsUrl = toWsUrl(opts.url);
    this.token = opts.token;
    this.handlers = opts.handlers;
    const ctor = opts.WebSocketImpl ?? (globalThis.WebSocket as unknown as WsLikeCtor | undefined);
    if (ctor === undefined) {
      throw new Error('no WebSocket implementation available; pass WebSocketImpl');
    }
    this.WsCtor = ctor;
    this.reconnectDelayMs = opts.reconnectDelayMs ?? 500;
    this.connect();
  }

  /** Tear the socket down permanently. */
  close(): void {
    this.manualClose = true;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
  }

  private connect(): void {
    const protocols =
      this.token !== undefined && this.token.length > 0
        ? [`${WS_BEARER_PROTOCOL_PREFIX}${this.token}`]
        : undefined;
    let ws: WsLike;
    try {
      ws = new this.WsCtor(this.wsUrl, protocols);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;
    ws.addEventListener('open', () => {
      this.reconnectAttempt = 0;
      this.send({
        type: 'client_hello',
        id: `kimi-inspect-global-${Date.now().toString(36)}`,
        payload: { client_id: 'kimi-inspect', subscriptions: [] },
      });
      // Established (first connect and every reconnect alike): live facts may
      // have been missed — the consumer re-seeds from REST.
      this.handlers.onReconnected();
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', () => {
      // Stale socket (a manual close already cleared `this.ws`).
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (!this.manualClose) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
      // The 'close' event always follows 'error'; reconnect logic lives there.
    });
  }

  private onMessage(raw: unknown): void {
    let frame: ServerFrame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw)) as ServerFrame;
    } catch {
      return;
    }
    const sessionId = frame.session_id;
    if (typeof sessionId !== 'string' || sessionId === '') return;
    switch (frame.type) {
      case 'event.session.work_changed': {
        const facts = parseWorkFacts(frame.payload);
        if (facts !== undefined) this.handlers.onWorkChanged(sessionId, facts);
        return;
      }
      case 'event.session.created': {
        this.handlers.onSessionCreated(sessionId);
        return;
      }
      case 'session.meta.updated': {
        this.handlers.onMetaUpdated(sessionId);
        return;
      }
      case 'ping': {
        const nonce = (frame.payload as { nonce?: unknown } | undefined)?.nonce;
        this.send({ type: 'pong', payload: { nonce } });
        return;
      }
      default:
        return;
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    this.reconnectAttempt += 1;
    const delay = Math.min(this.reconnectDelayMs * 2 ** (this.reconnectAttempt - 1), 10_000);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
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
}

function parseWorkFacts(payload: unknown): SessionWorkFacts | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p['busy'] !== 'boolean') return undefined;
  const pending = p['pending_interaction'];
  const reason = p['last_turn_reason'];
  return {
    busy: p['busy'],
    mainTurnActive: p['main_turn_active'] === true,
    pendingInteraction:
      pending === 'approval' || pending === 'question' ? pending : 'none',
    lastTurnReason:
      reason === 'completed' || reason === 'cancelled' || reason === 'failed' ? reason : undefined,
  };
}

/** Derive the `/api/v1/ws` WebSocket URL from a server base URL (or pass a full ws URL through). */
function toWsUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for WS transport: ${base}`);
  }
  if (!url.pathname.endsWith('/api/v1/ws')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v1/ws`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
