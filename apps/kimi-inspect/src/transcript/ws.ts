/**
 * Minimal `/api/v3/ws` client for the message protocol.
 *
 * Handshake per the protocol contract: the server sends `hello` right after
 * the upgrade, the client answers with `subscribe` (`{id, session_id,
 * agent_ids?, omit?}`), the server replies with `ack` (matched by `id`) and
 * then streams the recovery payload followed by live traffic — one ordered
 * session sequence, no cursors anywhere. Heartbeat is the WS protocol-level
 * ping/pong, handled by the WebSocket implementation itself.
 *
 * Every data frame is validated against the shared
 * `serverMessageSchema`; control frames (`hello` / `ack` / `error`) are
 * handled here, everything else is forwarded through `onMessage`. The union
 * is open: a frame whose `type` is not in the current schema is a future
 * message type and is ignored silently; a frame that names a known type but
 * fails validation is a server bug and surfaces via `onInvalidFrame`.
 *
 * A drop is answered with a backoff reconnect and a fresh subscribe — the
 * recovery payload is idempotent, so the consumer's only job on `onAck` is
 * to run its REST tail catch-up. The bearer token rides the
 * `kimi-code.bearer.<token>` subprotocol at the upgrade (the only
 * credential channel a browser WebSocket has).
 */

import { serverMessageSchema, type ServerMessage } from '@moonshot-ai/kap-server/protocol';

import type { WsLike, WsLikeCtor } from '../channel/wsLike';

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

const KNOWN_MESSAGE_TYPES: ReadonlySet<string> = new Set([
  'turn',
  'step',
  'user',
  'assistant',
  'assistant.delta',
  'thinking',
  'thinking.delta',
  'tool_call',
  'tool_call.delta',
  'tool.progress',
  'system',
  'interaction',
  'task',
  'todo',
  'session.state',
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

export interface ChatWsHandlers {
  /** Any validated non-control server message (entity, delta, state, global). */
  onMessage: (message: ServerMessage) => void;
  /** The subscribe ack (code 0 = subscribed) — fires on every (re)subscribe. */
  onAck: (code: number, msg?: string) => void;
  /** Protocol-level `error` frame (auth failure, unknown frame, slow consumer). */
  onProtocolError: (code: number, msg: string) => void;
  /** A frame naming a KNOWN type failed schema validation (server bug). */
  onInvalidFrame?: (raw: unknown) => void;
  /** The socket dropped and a reconnect attempt is scheduled. */
  onReconnectScheduled?: (attempt: number) => void;
}

export interface ChatWsOptions {
  /** Server base URL (`http(s)://host:port`) or a full `ws(s)://…/api/v3/ws` URL. */
  readonly url: string;
  readonly token?: string;
  readonly sessionId: string;
  /** Agents to subscribe; defaults to all agents of the session when empty. */
  readonly agentIds?: readonly string[];
  /** Message types to exclude from the subscription (exact `type` names). */
  readonly omit?: readonly string[];
  readonly handlers: ChatWsHandlers;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Base delay (ms) for the reconnect backoff. Default `500`. */
  readonly reconnectDelayMs?: number;
}

export class ChatWs {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly sessionId: string;
  private readonly agentIds?: readonly string[];
  private readonly omit?: readonly string[];
  private readonly handlers: ChatWsHandlers;
  private readonly WsCtor: WsLikeCtor;
  private readonly reconnectDelayMs: number;

  private ws: WsLike | undefined;
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private subscribeId = 0;

  constructor(opts: ChatWsOptions) {
    this.wsUrl = toWsV3Url(opts.url);
    this.token = opts.token;
    this.sessionId = opts.sessionId;
    this.agentIds = opts.agentIds;
    this.omit = opts.omit;
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

  /** Force a reconnect (debug/testing): drop the socket and re-subscribe after `delayMs`. */
  reconnect(delayMs = 0): void {
    if (this.manualClose) return;
    if (this.reconnectTimer !== undefined) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    const ws = this.ws;
    this.ws = undefined;
    ws?.close();
    this.reconnectAttempt += 1;
    this.handlers.onReconnectScheduled?.(this.reconnectAttempt);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delayMs);
    this.reconnectTimer.unref?.();
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
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (!this.manualClose) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {});
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
      if (typeof type !== 'string' || KNOWN_MESSAGE_TYPES.has(type)) {
        this.handlers.onInvalidFrame?.(frame);
      }
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case 'hello': {
        this.subscribeId += 1;
        this.send({
          type: 'subscribe',
          id: this.subscribeId,
          session_id: this.sessionId,
          agent_ids: this.agentIds !== undefined && this.agentIds.length > 0 ? [...this.agentIds] : undefined,
          omit: this.omit !== undefined && this.omit.length > 0 ? [...this.omit] : undefined,
        });
        return;
      }
      case 'ack': {
        if (message.id === this.subscribeId) {
          this.handlers.onAck(message.code, message.msg);
        }
        return;
      }
      case 'error': {
        this.handlers.onProtocolError(message.code, message.msg);
        return;
      }
      default: {
        this.handlers.onMessage(message);
        return;
      }
    }
  }

  private scheduleReconnect(): void {
    if (this.manualClose) return;
    this.reconnectAttempt += 1;
    this.handlers.onReconnectScheduled?.(this.reconnectAttempt);
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
    }
  }
}

/** Derive the `/api/v3/ws` WebSocket URL from a server base URL (or pass a full ws URL through). */
function toWsV3Url(base: string): string {
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
