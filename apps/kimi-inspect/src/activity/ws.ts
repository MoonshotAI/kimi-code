/**
 * Minimal `/api/v3/ws` client for the GLOBAL messages — no subscriptions.
 *
 * The server sends `hello` right after the upgrade and fans every global
 * message (`session` / `workspace` / `config` / `config.warning` /
 * `model_catalog` / `plugin` / `capability`) out to every established
 * connection, so this client subscribes to nothing and sends nothing: it
 * dispatches the coarse per-session facts to the consumer:
 *
 *   - `session` (created / updated / archived / deleted) → forwarded whole;
 *     the embedded SessionInfo carries `busy` / `main_turn_active` /
 *     `pending_interaction` / `last_turn_reason`, and the consumer maps the
 *     subtype onto the activity map and the list invalidation;
 *   - `workspace` (created / updated / deleted) → list-level signal.
 *
 * Session/agent-grained traffic (entities, deltas, `session.state`) stays
 * subscribe-gated server-side and never arrives here; the transcript chat
 * channel has its own socket (`src/transcript/ws.ts`). Global messages are
 * live-only — a drop loses whatever fired meanwhile, so the consumer answers
 * `onReconnected` with a REST re-seed. Heartbeat is the WS protocol-level
 * ping/pong, handled by the WebSocket implementation itself.
 *
 * Every frame is validated against the shared `serverMessageSchema`: a frame
 * whose `type` is not in the schema is a future message type and is ignored
 * silently, while a frame naming a known global type but failing validation
 * is a server bug and surfaces via `onInvalidFrame`.
 *
 * The bearer token is presented at the upgrade through the
 * `kimi-code.bearer.<token>` subprotocol (the only credential channel a
 * browser WebSocket has).
 */

import { serverMessageSchema, type SessionMessage } from '@moonshot-ai/kap-server/protocol';

import type { WsLike, WsLikeCtor } from '../channel/wsLike';

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

const KNOWN_GLOBAL_TYPES: ReadonlySet<string> = new Set([
  'session',
  'workspace',
  'config',
  'config.warning',
  'model_catalog',
  'plugin',
  'capability',
  'hello',
  'ack',
  'error',
]);

export interface GlobalEventsWsHandlers {
  /** A `session` global message arrived (created / updated / archived /
   *  deleted); the embedded SessionInfo carries the coarse work facts. */
  onSession: (message: SessionMessage) => void;
  /** A `workspace` global message arrived (created / updated / deleted). */
  onWorkspaceChanged?: (() => void) | undefined;
  /** Socket established (initial connect and every reconnect) — the consumer
   *  answers with a REST re-seed, since live messages are missed while down. */
  onReconnected: () => void;
  /** A frame naming a known global type failed schema validation (server bug). */
  onInvalidFrame?: ((raw: unknown) => void) | undefined;
}

export interface GlobalEventsWsOptions {
  /** Server base URL (`http(s)://host:port`) or a full `ws(s)://…/api/v3/ws` URL. */
  readonly url: string;
  readonly token?: string | undefined;
  readonly handlers: GlobalEventsWsHandlers;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Base delay (ms) for the reconnect backoff. Default `500`. */
  readonly reconnectDelayMs?: number;
}

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
      // Established (first connect and every reconnect alike): live messages
      // may have been missed — the consumer re-seeds from REST.
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
    let frame: unknown;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : String(raw));
    } catch {
      this.handlers.onInvalidFrame?.(raw);
      return;
    }
    const parsed = serverMessageSchema.safeParse(frame);
    if (!parsed.success) {
      const type = (frame as { readonly type?: unknown } | null)?.type;
      if (typeof type === 'string' && KNOWN_GLOBAL_TYPES.has(type)) {
        this.handlers.onInvalidFrame?.(frame);
      }
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'session': {
        this.handlers.onSession(message);
        return;
      }
      case 'workspace': {
        this.handlers.onWorkspaceChanged?.();
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
}

/** Derive the `/api/v3/ws` WebSocket URL from a server base URL (or pass a full ws URL through). */
function toWsUrl(base: string): string {
  const url = new URL(base);
  if (url.protocol === 'http:') url.protocol = 'ws:';
  else if (url.protocol === 'https:') url.protocol = 'wss:';
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    throw new Error(`unsupported URL scheme for WS transport: ${base}`);
  }
  if (!url.pathname.endsWith('/api/v3/ws')) {
    url.pathname = `${url.pathname.replace(/\/$/, '')}/api/v3/ws`;
  }
  url.search = '';
  url.hash = '';
  return url.toString();
}
