/**
 * Minimal `/api/v1/ws` client for the transcript stream — **delta only**.
 *
 * The socket is used exclusively as an incremental channel: after the
 * upgrade, the client sends `client_hello` with the session in
 * `subscriptions` plus the opt-in `transcript` grade map, and forwards every
 * `transcript.ops` frame to the consumer. Full state never comes from here:
 * `transcript.reset` snapshots are ignored by the store (they are surfaced
 * through the optional `onReset` handler for observers like the audit panel),
 * because complete data (initial load and any refresh) is read back from the
 * REST transcript API, paged from the tail backwards.
 *
 * Loss signals are surfaced, not repaired locally — transcript frames are
 * volatile by design (never journaled), so the consumer answers them with a
 * REST refresh: `resync_required` → `onResyncRequired`, and the subscribe
 * ack after every established socket → `onReconnected` (the server attaches
 * the stream only after processing `client_hello`; ops emitted between the
 * REST page load and that point are missed).
 *
 * The bearer token is presented at the upgrade through the
 * `kimi-code.bearer.<token>` subprotocol (the only credential channel a
 * browser WebSocket has).
 */

import {
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import type { WsLike, WsLikeCtor } from '../channel/wsLike';

/** Envelope/payload metadata carried alongside a transcript frame (for auditing + seq tracking). */
export interface TranscriptFrameMeta {
  /** Envelope `timestamp` (server send time, ISO); absent on legacy servers. */
  readonly at?: string | undefined;
  /** Op-batch sequence number (payload `seq`); absent on legacy servers. */
  readonly seq?: number | undefined;
}

export interface TranscriptWsHandlers {
  /** Incremental L2 op batch for the agent (the only data frame consumed). */
  onOps: (
    agentId: string,
    ops: readonly TranscriptOperation[],
    meta?: TranscriptFrameMeta,
  ) => void;
  /**
   * Baseline snapshot frame. The chat consumer deliberately ignores these
   * (full state is REST-sourced) — the handler exists for observers such as
   * the audit panel that want to record every frame on the wire.
   */
  onReset?: (
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    hasMoreOlder: boolean,
    meta?: TranscriptFrameMeta,
  ) => void;
  /** Server signalled desync for our session — consumer should REST-refresh. */
  onResyncRequired: () => void;
  /** Socket re-established after a drop — volatile ops were missed meanwhile. */
  onReconnected: () => void;
}

export interface TranscriptWsOptions {
  /** Server base URL (`http(s)://host:port`) or a full `ws(s)://…/api/v1/ws` URL. */
  readonly url: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly agentId: string;
  readonly handlers: TranscriptWsHandlers;
  /**
   * Returns the caller's current op-batch watermark at (re)subscribe time;
   * when defined it is sent as the `transcript_since` cursor so a sequenced
   * server replays missed batches instead of sending a baseline reset.
   */
  readonly getSince?: (() => number | undefined) | undefined;
  /** WebSocket implementation; defaults to the global `WebSocket`. */
  readonly WebSocketImpl?: WsLikeCtor;
  /** Base delay (ms) for the reconnect backoff. Default `500`. */
  readonly reconnectDelayMs?: number;
}

interface ServerFrame {
  readonly type: string;
  readonly id?: string;
  readonly code?: number;
  readonly timestamp?: string;
  readonly payload?: unknown;
}

const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

export class TranscriptWs {
  private readonly wsUrl: string;
  private readonly token?: string;
  private readonly sessionId: string;
  private readonly agentId: string;
  private readonly handlers: TranscriptWsHandlers;
  private readonly getSince?: (() => number | undefined) | undefined;
  private readonly WsCtor: WsLikeCtor;
  private readonly reconnectDelayMs: number;

  private ws: WsLike | undefined;
  private manualClose = false;
  private reconnectAttempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private helloId: string | undefined;
  private helloAcked = false;

  constructor(opts: TranscriptWsOptions) {
    this.wsUrl = toWsUrl(opts.url);
    this.token = opts.token;
    this.sessionId = opts.sessionId;
    this.agentId = opts.agentId;
    this.handlers = opts.handlers;
    this.getSince = opts.getSince;
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
      this.helloId = `kimi-inspect-${Date.now().toString(36)}`;
      this.helloAcked = false;
      const since = this.getSince?.();
      this.send({
        type: 'client_hello',
        id: this.helloId,
        payload: {
          client_id: 'kimi-inspect',
          subscriptions: [this.sessionId],
          transcript: { [this.sessionId]: { [this.agentId]: 'delta' } },
          transcript_since:
            since !== undefined ? { [this.sessionId]: { [this.agentId]: since } } : undefined,
        },
      });
      // The reconcile fires on the subscribe ACK (see onMessage) — the server
      // attaches the transcript stream only after processing client_hello,
      // so refreshing at open could finish before the subscription is active
      // and still miss the ops in between.
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
    switch (frame.type) {
      case 'ack': {
        // The subscribe ack: the server has attached the transcript stream
        // by now — reconcile once per hello (ops emitted between the REST
        // page load and this point are missed; the consumer refreshes).
        if (!this.helloAcked && frame.id !== undefined && frame.id === this.helloId) {
          this.helloAcked = true;
          this.handlers.onReconnected();
        }
        return;
      }
      case 'transcript.ops': {
        const parsed = transcriptOpsEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        this.handlers.onOps(parsed.data.agent_id, parsed.data.ops, {
          at: frame.timestamp,
          seq: parsed.data.seq,
        });
        return;
      }
      case 'transcript.reset': {
        // Snapshots are deliberately ignored by the chat store: full state is
        // REST-sourced. Surface them to optional observers (audit panel).
        if (this.handlers.onReset === undefined) return;
        const parsed = transcriptResetEventSchema.safeParse(frame.payload);
        if (!parsed.success) return;
        this.handlers.onReset(
          parsed.data.agent_id,
          parsed.data.snapshot,
          parsed.data.has_more_older,
          { at: frame.timestamp, seq: parsed.data.seq },
        );
        return;
      }
      case 'ping': {
        const nonce = (frame.payload as { nonce?: unknown } | undefined)?.nonce;
        this.send({ type: 'pong', payload: { nonce } });
        return;
      }
      case 'resync_required': {
        const sessionId = (frame.payload as { session_id?: unknown } | undefined)?.session_id;
        if (sessionId === this.sessionId) this.handlers.onResyncRequired();
        return;
      }
      default:
        // server_hello / ack / legacy session events — not consumed here.
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
