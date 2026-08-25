// app-core api/daemon/ws.ts
// DaemonEventSocket — browser WebSocket client for the daemon WS protocol.
// Handles: server_hello / client_hello handshake, subscribe/unsubscribe,
// ping/pong heartbeat, resync_required, error frames, event.* dispatch.

import { noopTracer } from '../../contracts';
import type { CredentialStore, Tracer } from '../../contracts';
import {
  transcriptOpsEventSchema,
  transcriptResetEventSchema,
  type AgentTranscriptSnapshot,
  type TranscriptOperation,
} from '@moonshot-ai/transcript';
import { classifyFrame } from './frameClassifier';
import type { WireEvent, WireServerFrame } from './wire';

// Mirrors kap-server's WS_BEARER_PROTOCOL_PREFIX. The browser WebSocket API
// cannot set arbitrary headers, so the bearer credential rides in the
// Sec-WebSocket-Protocol subprotocol instead.
const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

// A socket with no incoming frames for this long is presumed half-open even if
// the browser still reports OPEN (no onclose fired). Derived as 2x the server
// heartbeat, with a floor so a misconfigured tiny heartbeat can't thrash.
const STALE_SOCKET_FLOOR_MS = 30_000;

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
  /** Called after client_hello succeeds, once subscription replay is complete. */
  onReplayComplete?(): void;
  /** Called on error frames or JSON parse failures */
  onError(code: number, msg: string, fatal: boolean): void;
  onTerminalOutput?(sessionId: string, terminalId: string, data: string, seq: number): void;
  onTerminalExit?(sessionId: string, terminalId: string, exitCode: number | null): void;
  onTranscriptReset?(
    sessionId: string,
    agentId: string,
    snapshot: AgentTranscriptSnapshot,
    seq?: number,
  ): void;
  onTranscriptOps?(
    sessionId: string,
    agentId: string,
    ops: readonly TranscriptOperation[],
    seq?: number,
  ): boolean;
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

export interface DaemonEventSocketOptions {
  wsUrl: string;
  clientId: string;
  handlers: DaemonEventSocketHandlers;
  tracer?: Tracer;
  credentialStore?: CredentialStore;
  /** Limit the legacy raw event stream to the main agent. */
  mainAgentOnly?: boolean;
}

export class DaemonEventSocket {
  private ws: WebSocket | null = null;
  private connected = false;
  private closed = false;

  /** subscriptions we manage: sessionId → last known cursor {seq, epoch} */
  private readonly subscriptions = new Map<string, SessionCursor>();
  /** Transcript subscriptions per session, keyed by agent: one connection
   *  carries several agents' streams for the same session (the main flow and
   *  the detail panel coexist), and the server replaces the session's grade
   *  spec on every subscribe_v2 — so each send carries the FULL agent set. */
  private readonly transcriptSubscriptions = new Map<
    string,
    Map<string, { sinceSeq?: number }>
  >();
  /** Legacy raw agents needed by side channels while main-only mode is enabled. */
  private readonly sideChannelAgents = new Map<string, Set<string>>();

  /** subscriptions queued while not yet connected */
  private readonly pendingSubscriptions: PendingSubscription[] = [];
  private readonly terminalAttachments = new Map<string, TerminalAttachment>();

  private msgSeq = 0;
  private clientHelloId: string | null = null;

  /** Automatic reconnect (exponential backoff, reset on a successful hello). */
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /** Server-advertised heartbeat interval (ms); falls back to the daemon default. */
  private heartbeatMs = 30_000;
  /**
   * Epoch ms of the most recent frame (or the connect attempt). Used to detect
   * a silent-half-open socket that the browser never fires `onclose` for.
   */
  private lastActivityAt = 0;

  private readonly tracer: Tracer;

  constructor(private readonly opts: DaemonEventSocketOptions) {
    this.tracer = opts.tracer ?? noopTracer;
  }

  /** Open the WebSocket connection. No-op while one is open or after close(). */
  connect(): void {
    if (this.ws !== null || this.closed) return;

    this.lastActivityAt = Date.now();
    this.tracer.wsEvent?.({
      kind: 'lifecycle',
      event: 'connect',
      detail: { url: this.opts.wsUrl, attempt: this.reconnectAttempts },
    });
    const credential = this.opts.credentialStore?.getToken();
    const protocols =
      credential !== undefined ? [`${WS_BEARER_PROTOCOL_PREFIX}${credential}`] : undefined;
    const ws = new WebSocket(this.opts.wsUrl, protocols);
    this.ws = ws;

    ws.onopen = () => {
      // Don't mark as connected yet — wait for server_hello
      this.tracer.wsEvent?.({ kind: 'lifecycle', event: 'open' });
    };

    ws.onmessage = (ev: MessageEvent) => {
      // Any received frame proves the link is alive; reset the stale detector.
      this.lastActivityAt = Date.now();
      try {
        const frame = JSON.parse(String(ev.data)) as WireServerFrame;
        this.tracer.wsEvent?.({ kind: 'in', frame });
        this.handleFrame(frame);
      } catch (error) {
        this.tracer.wsEvent?.({
          kind: 'lifecycle',
          event: 'parse-error',
          detail: { error: String(error) },
        });
        this.opts.handlers.onError(0, `Failed to parse WS frame: ${String(error)}`, false);
      }
    };

    ws.onerror = () => {
      // The error details are not exposed by the browser WS API; the close
      // event with a reason code follows immediately.
      this.tracer.wsEvent?.({ kind: 'lifecycle', event: 'error' });
      this.opts.handlers.onError(0, 'WebSocket error', false);
    };

    ws.onclose = (ev?: CloseEvent) => {
      this.tracer.wsEvent?.({
        kind: 'lifecycle',
        event: 'close',
        detail: ev ? { code: ev.code, reason: ev.reason, wasClean: ev.wasClean } : undefined,
      });
      this.connected = false;
      this.ws = null;
      this.opts.handlers.onConnectionState(false);
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
    this.tracer.wsEvent?.({
      kind: 'lifecycle',
      event: 'reconnect-scheduled',
      detail: { delayMs: delay, attempt: this.reconnectAttempts },
    });
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
   * Add an agent's Transcript stream to a session. Several agents can stream
   * concurrently for one session (the main flow and the detail panel
   * coexist); the server replaces the session's grade spec per subscribe_v2,
   * so every send carries the full agent set.
   */
  subscribeTranscript(sessionId: string, agentId: string, sinceSeq?: number): void {
    let agents = this.transcriptSubscriptions.get(sessionId);
    if (agents === undefined) {
      agents = new Map();
      this.transcriptSubscriptions.set(sessionId, agents);
    }
    // A cursorless (re)subscribe means "send me a full baseline" — the gap
    // recovery path uses it after a failed REST refresh. Clear any saved
    // watermark instead of keeping it: carrying the old sinceSeq would make
    // the server replay the same gapped window again.
    agents.set(agentId, sinceSeq !== undefined ? { sinceSeq } : {});
    if (this.connected) this.sendTranscriptSubscribe(sessionId, agentId);
  }

  unsubscribeTranscript(sessionId: string, agentIds?: string[]): void {
    const agents = this.transcriptSubscriptions.get(sessionId);
    if (agents !== undefined) {
      if (agentIds === undefined) {
        this.transcriptSubscriptions.delete(sessionId);
      } else {
        for (const id of agentIds) agents.delete(id);
        if (agents.size === 0) this.transcriptSubscriptions.delete(sessionId);
      }
    }
    if (!this.connected || !this.ws) return;
    this.send({
      type: 'unsubscribe_v2',
      id: this.nextId(),
      payload: {
        session_id: sessionId,
        ...(agentIds !== undefined ? { agent_ids: agentIds } : {}),
      },
    });
  }

  /** Keep one side-channel agent in the legacy raw filter for its parent session. */
  markSideChannelAgent(sessionId: string, agentId: string): void {
    if (!this.opts.mainAgentOnly) return;
    let agents = this.sideChannelAgents.get(sessionId);
    if (agents === undefined) {
      agents = new Set();
      this.sideChannelAgents.set(sessionId, agents);
    }
    if (agents.has(agentId)) return;
    agents.add(agentId);
    const cursor = this.subscriptions.get(sessionId);
    if (this.connected && cursor !== undefined) {
      this.sendSubscribe([sessionId], { [sessionId]: cursor });
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

  /**
   * Snapshot the socket's health. `stale` is true when no frame has arrived for
   * longer than 2x the server heartbeat (floored at {@link STALE_SOCKET_FLOOR_MS}).
   * The browser may still report OPEN on a half-open connection that no longer
   * delivers data, so foreground recovery keys on the staleness signal rather
   * than the raw readyState.
   */
  health(): { connected: boolean; open: boolean; stale: boolean } {
    const open = this.ws !== null && this.ws.readyState === WebSocket.OPEN;
    const threshold = Math.max(this.heartbeatMs * 2, STALE_SOCKET_FLOOR_MS);
    const stale = this.lastActivityAt > 0 && Date.now() - this.lastActivityAt > threshold;
    return { connected: this.connected, open, stale };
  }

  /**
   * Force a clean reconnect. Used to recover from a silent-half-open socket
   * (e.g. after the browser froze a background tab) where `onclose` never
   * fires, so the automatic backoff reconnect wired into `onclose` is never
   * triggered.
   *
   * Tears down the current socket without waiting for `onclose`, resets the
   * handshake state, and opens a fresh socket immediately; `onServerHello`
   * re-sends every subscription at the last durable cursor. No-op after
   * {@link close()}.
   */
  reconnect(): void {
    if (this.closed) return;
    // Cancel any pending automatic reconnect — we're reconnecting synchronously.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const old = this.ws;
    if (old !== null) {
      // Detach before closing so the old socket's `onclose` doesn't race our
      // fresh connect (it would call scheduleReconnect and clobber `this.ws`).
      old.onopen = null;
      old.onmessage = null;
      old.onerror = null;
      old.onclose = null;
      try {
        old.close(1000, 'reconnect');
      } catch {
        // Ignore — the socket may already be closing.
      }
    }
    const wasConnected = this.connected;
    this.ws = null;
    this.connected = false;
    if (wasConnected) {
      this.opts.handlers.onConnectionState(false);
    }
    this.connect();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private handleFrame(rawFrame: WireServerFrame): void {
    // WireServerFrame union contains WireAck (payload: unknown) which prevents
    // TypeScript from narrowing .payload in each case arm. Cast once here.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const frame = rawFrame as any;
    const rawType = (rawFrame as { type: string }).type;
    if (rawType === 'transcript.reset') {
      const parsed = transcriptResetEventSchema.safeParse({
        type: rawType,
        ...(frame.payload as object),
      });
      const sessionId = frame.session_id;
      if (!parsed.success || typeof sessionId !== 'string') {
        this.opts.handlers.onError(0, 'Invalid transcript.reset frame', false);
        return;
      }
      const event = parsed.data;
      this.opts.handlers.onTranscriptReset?.(
        sessionId,
        event.agent_id,
        { ...event.snapshot, hasMoreOlder: event.has_more_older },
        event.seq,
      );
      const resetSub = this.transcriptSubscriptions.get(sessionId)?.get(event.agent_id);
      if (resetSub !== undefined && event.seq !== undefined) {
        resetSub.sinceSeq = event.seq;
      }
      return;
    }
    if (rawType === 'transcript.ops') {
      const parsed = transcriptOpsEventSchema.safeParse({
        type: rawType,
        ...(frame.payload as object),
      });
      const sessionId = frame.session_id;
      if (!parsed.success || typeof sessionId !== 'string') {
        this.opts.handlers.onError(0, 'Invalid transcript.ops frame', false);
        return;
      }
      const event = parsed.data;
      const accepted = this.opts.handlers.onTranscriptOps?.(
        sessionId,
        event.agent_id,
        event.ops,
        event.seq,
      );
      const opsSub = this.transcriptSubscriptions.get(sessionId)?.get(event.agent_id);
      if (accepted !== false && opsSub !== undefined && event.seq !== undefined) {
        opsSub.sinceSeq = event.seq;
      }
      return;
    }

    switch (rawType) {
      case 'server_hello': {
        const hb = (frame.payload as { heartbeat_ms?: unknown } | undefined)?.heartbeat_ms;
        if (typeof hb === 'number' && hb > 0) this.heartbeatMs = hb;
        this.onServerHello();
        break;
      }

      case 'ping':
        this.send({ type: 'pong', payload: { nonce: frame.payload.nonce } });
        break;

      case 'resync_required': {
        const sid = frame.payload.session_id as string;
        const epoch = frame.payload.epoch as string | undefined;
        // Adopt the announced cursor so the next reconnect handshake doesn't
        // re-trigger the same resync before the snapshot reload lands.
        this.subscriptions.set(sid, { seq: frame.payload.current_seq, epoch });
        this.opts.handlers.onResync(sid, frame.payload.current_seq, epoch);
        break;
      }

      case 'error': {
        // A session-scoped error (has top-level session_id) is a real agent-core
        // 'error' event — e.g. a 403 from the model provider — whose message
        // must surface in the conversation. A connection-level control error
        // (no session_id) goes to onError.
        const sid = (frame as { session_id?: unknown }).session_id;
        if (typeof sid === 'string' && this.opts.handlers.onRawAgentEvent) {
          this.opts.handlers.onRawAgentEvent({
            type: 'error',
            seq: frame.seq,
            session_id: sid,
            timestamp: frame.timestamp,
            payload: frame.payload,
          });
        } else {
          this.opts.handlers.onError(frame.payload.code, frame.payload.msg, frame.payload.fatal);
        }
        break;
      }

      case 'ack':
        if (frame.id === this.clientHelloId) {
          this.clientHelloId = null;
          if (frame.code === 0) this.opts.handlers.onReplayComplete?.();
        }
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
        this.opts.handlers.onTerminalOutput?.(sessionId, terminalId, data, seq);
        break;
      }

      case 'terminal_exit': {
        const sessionId = frame.session_id as string;
        const terminalId = frame.terminal_id as string;
        const rawExitCode = frame.payload?.exit_code;
        const exitCode = typeof rawExitCode === 'number' ? rawExitCode : null;
        this.opts.handlers.onTerminalExit?.(sessionId, terminalId, exitCode);
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
          this.opts.handlers.onWireEvent(frame as unknown as WireEvent);
          break;
        }

        if (decision.route === 'agent') {
          // Raw (or prefix-stripped) agent-core event → client-side projector.
          // We pass the prefix-stripped agentType so the projector matches its
          // raw case arms regardless of whether the wire frame carried "event.".
          if (
            this.opts.handlers.onRawAgentEvent &&
            typeof (frame as { session_id?: unknown }).session_id === 'string'
          ) {
            const f = frame as {
              seq: number;
              session_id: string;
              timestamp: string;
              payload: unknown;
            };
            const extras = frame as { volatile?: boolean; offset?: number };
            this.opts.handlers.onRawAgentEvent({
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
    this.opts.handlers.onConnectionState(true);

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

    const clientHelloId = this.nextId();
    this.clientHelloId = clientHelloId;
    this.send({
      type: 'client_hello',
      id: clientHelloId,
      payload: {
        client_id: this.opts.clientId,
        subscriptions: allSessionIds,
        cursors,
        ...(this.opts.mainAgentOnly
          ? {
              agent_filter: this.rawAgentFilter(allSessionIds),
            }
          : {}),
      },
    });

    for (const sessionId of this.transcriptSubscriptions.keys()) {
      // No agent argument: every agent's watermark rides transcript_since so
      // the server replays each stream's missed batches instead of resetting.
      this.sendTranscriptSubscribe(sessionId);
    }

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
        ...(this.opts.mainAgentOnly
          ? {
              agent_filter: this.rawAgentFilter(sessionIds),
            }
          : {}),
      },
    });
  }

  private rawAgentFilter(sessionIds: readonly string[]): Record<string, string[]> {
    return Object.fromEntries(
      sessionIds.map((sessionId) => [
        sessionId,
        ['main', ...(this.sideChannelAgents.get(sessionId) ?? [])],
      ]),
    );
  }

  private sendTranscriptSubscribe(sessionId: string, sinceAgentId?: string): void {
    const agents = this.transcriptSubscriptions.get(sessionId);
    if (agents === undefined || agents.size === 0) return;
    const grades: Record<string, string> = {};
    const since: Record<string, number> = {};
    for (const [agentId, sub] of agents) {
      grades[agentId] = 'delta';
      // The watermark rides only for the agent being (re)subscribed — or for
      // every agent on a reconnect (sinceAgentId undefined), where each one
      // needs its missed batches replayed.
      if (sub.sinceSeq !== undefined && (sinceAgentId === undefined || sinceAgentId === agentId)) {
        since[agentId] = sub.sinceSeq;
      }
    }
    this.send({
      type: 'subscribe_v2',
      id: this.nextId(),
      payload: {
        session_id: sessionId,
        transcript: grades,
        ...(Object.keys(since).length > 0 ? { transcript_since: since } : {}),
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
      this.tracer.wsEvent?.({ kind: 'out', frame: msg });
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
