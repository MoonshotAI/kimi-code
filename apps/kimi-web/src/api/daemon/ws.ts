// apps/kimi-web/src/api/daemon/ws.ts
// DaemonEventSocket — browser WebSocket client for the daemon WS protocol.
// Handles: server_hello / client_hello handshake, subscribe/unsubscribe,
// ping/pong heartbeat, resync_required, error frames, event.* dispatch.

import { traceWsIn, traceWsLifecycle, traceWsOut } from '../../debug/trace';
import { classifyFrame } from './agentEventProjector';
import { getCredential } from './serverAuth';
import type { WireEvent, WireServerFrame } from './wire';

// Mirrors packages/server WS_BEARER_PROTOCOL_PREFIX. The browser WebSocket API
// cannot set arbitrary headers, so the bearer credential rides in the
// Sec-WebSocket-Protocol subprotocol instead.
const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

// ---------------------------------------------------------------------------
// Handler interface
// ---------------------------------------------------------------------------

export interface DaemonEventSocketHandlers {
  /** Called for every event.* frame received */
  onWireEvent(event: WireEvent): void;
  /**
   * Called for raw agent-core frames (type does NOT start with "event." and
   * is not a control frame).  The full parsed frame object is passed so the
   * caller can extract type / seq / session_id / timestamp / payload, plus
   * the v2 envelope extras (volatile / offset).
   */
  onRawAgentEvent?(frame: {
    type: string;
    seq: number;
    session_id: string;
    timestamp: string;
    payload: unknown;
    volatile?: boolean;
    offset?: number;
  }): void;
  /** Called when server says client is out of sync for a session */
  onResync(sessionId: string, currentSeq: number, epoch?: string): void;
  /** Called when the WS connection opens or closes */
  onConnectionState(connected: boolean): void;
  /** Called on error frames or JSON parse failures */
  onError(code: number, msg: string, fatal: boolean): void;
  onTerminalOutput?(sessionId: string, terminalId: string, data: string, seq: number): void;
  onTerminalExit?(sessionId: string, terminalId: string, exitCode: number | null): void;
}

// ---------------------------------------------------------------------------
// DaemonEventSocket
// ---------------------------------------------------------------------------

/** v2 sync cursor: durable seq + journal epoch. */
export interface SessionCursor {
  seq: number;
  epoch?: string;
}

interface PendingSubscription {
  sessionId: string;
  cursor: SessionCursor;
}

interface TerminalAttachment {
  sessionId: string;
  terminalId: string;
  lastSeq: number;
}

export class DaemonEventSocket {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;

  /** subscriptions we manage: sessionId → last known cursor {seq, epoch} */
  private readonly subscriptions = new Map<string, SessionCursor>();

  /** subscriptions queued while not yet connected */
  private readonly pendingSubscriptions: PendingSubscription[] = [];
  private readonly terminalAttachments = new Map<string, TerminalAttachment>();

  private msgSeq = 0;

  /** Automatic reconnect (exponential backoff, reset on a successful hello). */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly wsUrl: string,
    private readonly clientId: string,
    private readonly handlers: DaemonEventSocketHandlers,
  ) {}

  /** Open the WebSocket connection. No-op while one is open or after close(). */
  connect(): void {
    if (this.ws !== null || this.closed) return;

    traceWsLifecycle('connect', { url: this.wsUrl, attempt: this.reconnectAttempts });
    const credential = getCredential();
    const protocols =
      credential !== undefined ? [`${WS_BEARER_PROTOCOL_PREFIX}${credential}`] : undefined;
    const ws = new WebSocket(this.wsUrl, protocols);
    this.ws = ws;

    ws.onopen = () => {
      // Don't mark as connected yet — wait for server_hello
      traceWsLifecycle('open');
    };

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const frame = JSON.parse(String(ev.data)) as WireServerFrame;
        traceWsIn(frame);
        this.handleFrame(frame);
      } catch (error) {
        traceWsLifecycle('parse-error', { error: String(error) });
        this.handlers.onError(0, `Failed to parse WS frame: ${String(error)}`, false);
      }
    };

    ws.onerror = () => {
      // The error details are not exposed by the browser WS API; the close
      // event with a reason code follows immediately.
      traceWsLifecycle('error');
      this.handlers.onError(0, 'WebSocket error', false);
    };

    ws.onclose = (ev?: CloseEvent) => {
      traceWsLifecycle('close', ev ? { code: ev.code, reason: ev.reason, wasClean: ev.wasClean } : undefined);
      this.connected = false;
      this.ws = null;
      this.handlers.onConnectionState(false);
      // Unexpected drop (daemon restart, sleep, network blip) → reconnect.
      // onServerHello re-sends every kept subscription via client_hello, and
      // the server answers a too-large seq gap with resync_required, so live
      // updates resume without a page reload.
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (this.closed || this.reconnectTimer !== null) return;
    const base = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    const delay = base + Math.floor(Math.random() * 250); // jitter
    this.reconnectAttempts += 1;
    traceWsLifecycle('reconnect-scheduled', { delayMs: delay, attempt: this.reconnectAttempts });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  /**
   * Subscribe to events for a session at a `{seq, epoch}` cursor.
   * If connected, sends immediately; otherwise queues until after server_hello.
   */
  subscribe(sessionId: string, cursor: SessionCursor = { seq: 0 }): void {
    this.subscriptions.set(sessionId, { ...cursor });

    if (this.connected) {
      this.sendSubscribe([sessionId], { [sessionId]: cursor });
    } else {
      // Remove any earlier pending entry for this session, then enqueue
      const idx = this.pendingSubscriptions.findIndex((p) => p.sessionId === sessionId);
      if (idx !== -1) this.pendingSubscriptions.splice(idx, 1);
      this.pendingSubscriptions.push({ sessionId, cursor: { ...cursor } });
    }
  }

  /** Unsubscribe from a session's events. */
  unsubscribe(sessionId: string): void {
    this.subscriptions.delete(sessionId);
    // Also cancel a subscribe that was queued before server_hello; otherwise
    // onServerHello would merge it back into the active subscription set.
    const pendingIdx = this.pendingSubscriptions.findIndex((p) => p.sessionId === sessionId);
    if (pendingIdx !== -1) this.pendingSubscriptions.splice(pendingIdx, 1);
    if (this.connected && this.ws) {
      this.send({
        type: 'unsubscribe',
        id: this.nextId(),
        payload: { session_ids: [sessionId] },
      });
    }
  }

  /**
   * Send a WS abort control message for a prompt.
   * (The REST :abort endpoint is the primary path; this is the WS path per spec.)
   */
  abort(sessionId: string, promptId: string): void {
    if (!this.connected || !this.ws) return;
    this.send({
      type: 'abort',
      id: this.nextId(),
      payload: { session_id: sessionId, prompt_id: promptId },
    });
  }

  terminalAttach(sessionId: string, terminalId: string, sinceSeq?: number): void {
    const key = terminalKey(sessionId, terminalId);
    const previous = this.terminalAttachments.get(key);
    const lastSeq = sinceSeq ?? previous?.lastSeq ?? 0;
    this.terminalAttachments.set(key, { sessionId, terminalId, lastSeq });
    if (!this.connected || !this.ws) return;
    this.sendTerminalAttach(sessionId, terminalId, lastSeq);
  }

  terminalInput(sessionId: string, terminalId: string, data: string): void {
    if (!this.connected || !this.ws) return;
    this.send({
      type: 'terminal_input',
      id: this.nextId(),
      payload: { session_id: sessionId, terminal_id: terminalId, data },
    });
  }

  terminalResize(sessionId: string, terminalId: string, cols: number, rows: number): void {
    if (!this.connected || !this.ws) return;
    this.send({
      type: 'terminal_resize',
      id: this.nextId(),
      payload: { session_id: sessionId, terminal_id: terminalId, cols, rows },
    });
  }

  terminalDetach(sessionId: string, terminalId: string): void {
    this.terminalAttachments.delete(terminalKey(sessionId, terminalId));
    if (!this.connected || !this.ws) return;
    this.send({
      type: 'terminal_detach',
      id: this.nextId(),
      payload: { session_id: sessionId, terminal_id: terminalId },
    });
  }

  terminalClose(sessionId: string, terminalId: string): void {
    this.terminalAttachments.delete(terminalKey(sessionId, terminalId));
    if (!this.connected || !this.ws) return;
    this.send({
      type: 'terminal_close',
      id: this.nextId(),
      payload: { session_id: sessionId, terminal_id: terminalId },
    });
  }

  /** Close the socket. Stops reconnect attempts. */
  close(): void {
    this.closed = true;
    this.connected = false;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000);
      this.ws = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private handleFrame(rawFrame: WireServerFrame): void {
    // WireServerFrame union contains WireAck (payload: unknown) which prevents
    // TypeScript from narrowing .payload in each case arm. Cast once here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const frame = rawFrame as any;
    switch ((rawFrame as { type: string }).type) {
      case 'server_hello':
        this.onServerHello();
        break;

      case 'ping':
        this.send({ type: 'pong', payload: { nonce: frame.payload.nonce } });
        break;

      case 'resync_required': {
        const sid = frame.payload.session_id as string;
        const epoch = frame.payload.epoch as string | undefined;
        // Adopt the announced cursor so the next reconnect handshake doesn't
        // re-trigger the same resync before the snapshot reload lands.
        this.subscriptions.set(sid, { seq: frame.payload.current_seq, epoch });
        this.handlers.onResync(sid, frame.payload.current_seq, epoch);
        break;
      }

      case 'error': {
        // A session-scoped error (has top-level session_id) is a real agent-core
        // 'error' event — e.g. a 403 from the model provider — whose message
        // must surface in the conversation. A connection-level control error
        // (no session_id) goes to onError.
        const sid = (frame as { session_id?: unknown }).session_id;
        if (typeof sid === 'string' && this.handlers.onRawAgentEvent) {
          this.handlers.onRawAgentEvent({
            type: 'error',
            seq: frame.seq,
            session_id: sid,
            timestamp: frame.timestamp,
            payload: frame.payload,
          });
        } else {
          this.handlers.onError(frame.payload.code, frame.payload.msg, frame.payload.fatal);
        }
        break;
      }

      case 'ack':
        // ack frames are fire-and-forget for now (no request tracking)
        break;

      case 'terminal_output': {
        const sessionId = frame.session_id as string;
        const terminalId = frame.terminal_id as string;
        const seq = frame.seq as number;
        const key = terminalKey(sessionId, terminalId);
        const existing = this.terminalAttachments.get(key);
        if (existing) {
          this.terminalAttachments.set(key, {
            ...existing,
            lastSeq: Math.max(existing.lastSeq, seq),
          });
        }
        const data = typeof frame.payload?.data === 'string' ? frame.payload.data : '';
        this.handlers.onTerminalOutput?.(sessionId, terminalId, data, seq);
        break;
      }

      case 'terminal_exit': {
        const sessionId = frame.session_id as string;
        const terminalId = frame.terminal_id as string;
        const rawExitCode = frame.payload?.exit_code;
        const exitCode = typeof rawExitCode === 'number' ? rawExitCode : null;
        this.handlers.onTerminalExit?.(sessionId, terminalId, exitCode);
        break;
      }

      default: {
        // Track the per-session cursor from durable event envelopes so the
        // reconnect handshake resumes from the freshest watermark. Volatile
        // frames carry the same watermark (never ahead), so skipping them is
        // safe and avoids regressing the cursor.
        this.trackCursor(frame as Record<string, unknown>);

        // Classify the frame into protocol vs agent-core. Robust to all three
        // shapes: raw agent-core, "event."-prefixed agent-core, and genuine
        // projected "event.*" protocol events. See classifyFrame() for rules.
        const type = (frame as { type: string }).type;
        const decision = classifyFrame(type, (frame as { payload?: unknown }).payload);

        if (decision.route === 'protocol') {
          // Genuine projected protocol event → existing toAppEvent() path.
          this.handlers.onWireEvent(frame as unknown as WireEvent);
          break;
        }

        if (decision.route === 'agent') {
          // Raw (or prefix-stripped) agent-core event → client-side projector.
          // We pass the prefix-stripped agentType so the projector matches its
          // raw case arms regardless of whether the wire frame carried "event.".
          if (
            this.handlers.onRawAgentEvent &&
            typeof (frame as { session_id?: unknown }).session_id === 'string'
          ) {
            const f = frame as {
              seq: number;
              session_id: string;
              timestamp: string;
              payload: unknown;
            };
            const extras = frame as { volatile?: boolean; offset?: number };
            this.handlers.onRawAgentEvent({
              type: decision.agentType,
              seq: f.seq,
              session_id: f.session_id,
              timestamp: f.timestamp,
              payload: f.payload,
              ...(extras.volatile !== undefined ? { volatile: extras.volatile } : {}),
              ...(extras.offset !== undefined ? { offset: extras.offset } : {}),
            });
          }
          break;
        }

        // decision.route === 'ignore' (control-shaped or unroutable) → drop.
        break;
      }
    }
  }

  private onServerHello(): void {
    this.connected = true;
    this.reconnectAttempts = 0;
    this.handlers.onConnectionState(true);

    // Build the initial subscription list from current subscriptions + pending
    const allSessionIds = Array.from(this.subscriptions.keys());
    // Drain pending: merge into subscriptions map (pending overrides if seq differs)
    for (const p of this.pendingSubscriptions) {
      this.subscriptions.set(p.sessionId, p.cursor);
      if (!allSessionIds.includes(p.sessionId)) allSessionIds.push(p.sessionId);
    }
    this.pendingSubscriptions.length = 0;

    // Build cursors from subscriptions
    const cursors: Record<string, SessionCursor> = {};
    for (const [sid, cursor] of this.subscriptions.entries()) {
      cursors[sid] = cursor;
    }

    this.send({
      type: 'client_hello',
      id: this.nextId(),
      payload: {
        client_id: this.clientId,
        subscriptions: allSessionIds,
        cursors,
      },
    });

    for (const attachment of this.terminalAttachments.values()) {
      this.sendTerminalAttach(attachment.sessionId, attachment.terminalId, attachment.lastSeq);
    }
  }

  private sendSubscribe(sessionIds: string[], cursors: Record<string, SessionCursor>): void {
    this.send({
      type: 'subscribe',
      id: this.nextId(),
      payload: {
        session_ids: sessionIds,
        cursors,
      },
    });
  }

  private sendTerminalAttach(sessionId: string, terminalId: string, sinceSeq: number): void {
    this.send({
      type: 'terminal_attach',
      id: this.nextId(),
      payload: {
        session_id: sessionId,
        terminal_id: terminalId,
        since_seq: sinceSeq > 0 ? sinceSeq : undefined,
      },
    });
  }

  /**
   * Advance the tracked cursor from a durable event envelope (seq + epoch).
   * Volatile frames are skipped (their seq is the same watermark, and a
   * volatile frame can never carry a NEWER seq than the last durable one).
   */
  private trackCursor(frame: Record<string, unknown>): void {
    if (frame['volatile'] === true) return;
    const sid = frame['session_id'];
    const seq = frame['seq'];
    if (typeof sid !== 'string' || typeof seq !== 'number') return;
    const existing = this.subscriptions.get(sid);
    if (!existing) return; // not a session we manage
    if (seq <= existing.seq && existing.epoch !== undefined) return;
    const epoch = typeof frame['epoch'] === 'string' ? (frame['epoch'] as string) : existing.epoch;
    this.subscriptions.set(sid, { seq: Math.max(seq, existing.seq), epoch });
  }

  private send(msg: unknown): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(msg));
      traceWsOut(msg);
    } catch {
      // Ignore send errors (socket closing races)
    }
  }

  private nextId(): string {
    return `c_${++this.msgSeq}`;
  }
}

function terminalKey(sessionId: string, terminalId: string): string {
  return `${sessionId}\0${terminalId}`;
}
