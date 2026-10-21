import {
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';

import type { WsLike, WsLikeCtor } from '../channel/wsLike';

export interface TranscriptFrameMeta {
  readonly at?: string | undefined;
  readonly seq?: number | undefined;
}

export interface TranscriptWsHandlers {
  onOps: (agentId: string, ops: readonly TranscriptOperation[], meta?: TranscriptFrameMeta) => void;
  onReset?: (
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    hasMoreOlder: boolean,
    meta?: TranscriptFrameMeta,
  ) => void;
  onResyncRequired: () => void;
  onReconnected: () => void;
}

export interface TranscriptWsOptions {
  readonly url: string;
  readonly token?: string | undefined;
  readonly sessionId: string;
  readonly agentId: string;
  readonly handlers: TranscriptWsHandlers;
  readonly getSince?: (() => number | undefined) | undefined;
  readonly WebSocketImpl?: WsLikeCtor;
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
  private subscribeV2Id: string | undefined;
  private subscribeV2Acked = false;

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
      this.subscribeV2Id = `${this.helloId}-sub`;
      this.subscribeV2Acked = false;
      const since = this.getSince?.();
      this.send({
        type: 'client_hello',
        id: this.helloId,
        payload: {
          client_id: 'kimi-inspect',
          subscriptions: [this.sessionId],
        },
      });
      this.send({
        type: 'subscribe_v2',
        id: this.subscribeV2Id,
        payload: {
          session_id: this.sessionId,
          transcript: { [this.agentId]: 'block' },
          transcript_since: since !== undefined ? { [this.agentId]: since } : undefined,
        },
      });
    });
    ws.addEventListener('message', (event: { data: unknown }) => {
      this.onMessage(event.data);
    });
    ws.addEventListener('close', () => {
      if (this.ws !== ws) return;
      this.ws = undefined;
      if (!this.manualClose) this.scheduleReconnect();
    });
    ws.addEventListener('error', () => {
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
        if (!this.subscribeV2Acked && frame.id !== undefined && frame.id === this.subscribeV2Id) {
          this.subscribeV2Acked = true;
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
    }
  }
}

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
