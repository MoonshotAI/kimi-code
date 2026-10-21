import type { WsLike, WsLikeCtor } from '../channel/wsLike';

export type SessionPendingInteraction = 'none' | 'approval' | 'question';
export type SessionTurnOutcome = 'completed' | 'cancelled' | 'failed';

export interface SessionWorkFacts {
  readonly busy: boolean;
  readonly mainTurnActive: boolean;
  readonly pendingInteraction: SessionPendingInteraction;
  readonly lastTurnReason?: SessionTurnOutcome | undefined;
}

export type DiUnitState = 'Pending' | 'Activating' | 'Active' | 'Unloading' | 'Failed';

export interface DiUnitChangedPayload {
  readonly scope: string;
  readonly token: string;
  readonly state: DiUnitState;
  readonly error?: string | undefined;
}

export interface GlobalEventsWsHandlers {
  onWorkChanged: (sessionId: string, facts: SessionWorkFacts) => void;
  onSessionCreated: (sessionId: string) => void;
  onMetaUpdated: (sessionId: string) => void;
  onSessionArchived?: ((sessionId: string) => void) | undefined;
  onSessionDeleted?: (sessionId: string) => void;
  onWorkspaceChanged?: (() => void) | undefined;
  onDiUnitChanged?: ((payload: DiUnitChangedPayload) => void) | undefined;
  onReconnected: () => void;
}

export interface GlobalEventsWsOptions {
  readonly url: string;
  readonly token?: string | undefined;
  readonly handlers: GlobalEventsWsHandlers;
  readonly WebSocketImpl?: WsLikeCtor;
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
      this.handlers.onReconnected();
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
      case 'event.session.archived': {
        const payload = frame.payload as { sessionId?: unknown } | undefined;
        const archivedId = payload?.sessionId;
        if (typeof archivedId === 'string' && archivedId !== '') {
          this.handlers.onSessionArchived?.(archivedId);
        }
        return;
      }
      case 'event.session.deleted': {
        const payload = frame.payload as { sessionId?: unknown } | undefined;
        const deletedId = payload?.sessionId;
        if (typeof deletedId === 'string' && deletedId !== '') {
          this.handlers.onSessionDeleted?.(deletedId);
        }
        return;
      }
      case 'event.workspace.created':
      case 'event.workspace.updated':
      case 'event.workspace.deleted': {
        this.handlers.onWorkspaceChanged?.();
        return;
      }
      case 'session.meta.updated': {
        this.handlers.onMetaUpdated(sessionId);
        return;
      }
      case 'event.di.unit_changed': {
        const payload = parseDiUnitChangedPayload(frame.payload);
        if (payload !== undefined) this.handlers.onDiUnitChanged?.(payload);
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
    pendingInteraction: pending === 'approval' || pending === 'question' ? pending : 'none',
    lastTurnReason:
      reason === 'completed' || reason === 'cancelled' || reason === 'failed' ? reason : undefined,
  };
}

const DI_UNIT_STATES: ReadonlySet<string> = new Set([
  'Pending',
  'Activating',
  'Active',
  'Unloading',
  'Failed',
]);

function parseDiUnitChangedPayload(payload: unknown): DiUnitChangedPayload | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const p = payload as Record<string, unknown>;
  if (typeof p['scope'] !== 'string' || typeof p['token'] !== 'string') return undefined;
  const state = p['state'];
  if (typeof state !== 'string' || !DI_UNIT_STATES.has(state)) return undefined;
  return {
    scope: p['scope'],
    token: p['token'],
    state: state as DiUnitState,
    error: typeof p['error'] === 'string' ? p['error'] : undefined,
  };
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
