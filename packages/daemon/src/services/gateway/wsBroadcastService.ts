/**
 * `WSBroadcastService` — daemon-side `IWSBroadcastService` impl.
 *
 * Subscribes to `IEventService.onDidPublish` in its constructor. For each
 * published event:
 *   1. Extracts `session_id` (camelCase `sessionId` per agent-core
 *      `events.ts:320`; snake_case `session_id` accepted defensively).
 *   2. Increments the per-session `seq` counter (monotonic, starts at 1).
 *   3. Appends `{seq, envelope}` to the per-session ring buffer
 *      (capacity enforced at `maxBufferSize`; default 1000 per WS.md §3.1).
 *   4. Fans out the envelope to every WS connection subscribed via
 *      `ISessionClientsService`.
 *
 * Events without a session id are dropped with a warn log — we don't
 * broadcast globally to avoid silent fan-out leaks. Every agent-core
 * `Event` extends `AgentEvent & { agentId, sessionId }` so this should
 * never fire in production; the guard is there for fuzz/test events.
 *
 * **Ring buffer state is per-session**: `Map<sessionId, SessionState>`.
 * Different sessions count independently.
 *
 * **Anti-corruption**: subscribes to the `@moonshot-ai/services`
 * `IEventService` decorator; never imports the concrete services-pkg
 * `EventService` class.
 */

import { Disposable } from '@moonshot-ai/agent-core';
import type { Event } from '@moonshot-ai/protocol';
import { IEventService } from '@moonshot-ai/services';

import { ILogService } from '#/services/logger';
import { ISessionClientsService } from './sessionClients';
import {
  DEFAULT_MAX_BUFFER_SIZE,
  IWSBroadcastService,
  type BufferedSinceResult,
} from './wsBroadcast';

import { buildEventEnvelope, type EventEnvelope } from '#/ws/protocol';

interface BufferEntry {
  seq: number;
  envelope: EventEnvelope;
}

interface SessionState {
  /** Highest `seq` dispatched. Starts at 0; first event gets `seq=1`. */
  seq: number;
  /** Append-only ring buffer; capped at `maxBufferSize`. */
  buffer: BufferEntry[];
  /** Lowest `seq` still in `buffer`. Increments on eviction. */
  oldestSeq: number;
}

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  readonly _serviceBrand: undefined;

  private readonly _sessions = new Map<string, SessionState>();
  private readonly _maxBufferSize: number;

  constructor(
    @IEventService eventService: IEventService,
    @ILogService private readonly logger: ILogService,
    @ISessionClientsService private readonly sessionClients: ISessionClientsService,
  ) {
    super();
    this._maxBufferSize = DEFAULT_MAX_BUFFER_SIZE;
    // Auto-attach to the bus. The returned disposable lives on the service's
    // own dispose tracker, so reverse-construction order in start.ts (this
    // service constructed AFTER IEventService) ensures we unsubscribe BEFORE
    // the bus tears down its emitter.
    this._register(
      eventService.onDidPublish((event) => {
        this._onEvent(event);
      }),
    );
  }

  private _onEvent(event: Event): void {
    if (this._isDisposed) return;
    const sid = extractSessionId(event);
    const evType = (event as { type?: string }).type ?? '<no-type>';
    if (!sid) {
      this.logger.warn(
        { eventType: evType, eventKeys: Object.keys(event as object) },
        '[DBG wsBroadcast.onEvent] event has no session_id; dropping',
      );
      return;
    }
    const state = this._getOrCreateSession(sid);
    state.seq += 1;
    const envelope = buildEventEnvelope(state.seq, sid, event);
    state.buffer.push({ seq: state.seq, envelope });

    // Ring buffer cap eviction. `oldestSeq` tracks the lowest seq still
    // retained so `getBufferedSince` can detect "client gap older than
    // buffer".
    while (state.buffer.length > this._maxBufferSize) {
      const evicted = state.buffer.shift();
      if (evicted) state.oldestSeq = evicted.seq + 1;
    }

    // Fan-out to subscribers. `getConnections` returns an iterable view; we
    // capture into an array to avoid mutating-iterator hazards if a send()
    // synchronously triggers a forgetConnection (e.g. socket error → close).
    const targets = Array.from(this.sessionClients.getConnections(sid));
    this.logger.info(
      { eventType: evType, sessionId: sid, seq: state.seq, targetCount: targets.length },
      '[DBG wsBroadcast.onEvent] fan-out',
    );
    for (const conn of targets) {
      conn.send(envelope);
    }
  }

  getBufferedSince(sid: string, lastSeq: number): BufferedSinceResult {
    const state = this._sessions.get(sid);
    if (!state) {
      return { events: [], resyncRequired: false, currentSeq: 0 };
    }
    if (lastSeq >= state.seq) {
      return { events: [], resyncRequired: false, currentSeq: state.seq };
    }
    if (lastSeq + 1 < state.oldestSeq) {
      return { events: [], resyncRequired: true, currentSeq: state.seq };
    }
    const events = state.buffer.filter((e) => e.seq > lastSeq);
    return { events, resyncRequired: false, currentSeq: state.seq };
  }

  currentSeq(sid: string): number {
    return this._sessions.get(sid)?.seq ?? 0;
  }

  /** Test helper — current seq for a session (0 if never published). */
  _currentSeqForTest(sid: string): number {
    return this._sessions.get(sid)?.seq ?? 0;
  }

  /** Test helper — buffer length for a session (0 if never published). */
  _bufferLengthForTest(sid: string): number {
    return this._sessions.get(sid)?.buffer.length ?? 0;
  }

  /** Test helper — oldestSeq tracked for a session (0 if never published). */
  _oldestSeqForTest(sid: string): number {
    return this._sessions.get(sid)?.oldestSeq ?? 0;
  }

  private _getOrCreateSession(sid: string): SessionState {
    let state = this._sessions.get(sid);
    if (!state) {
      state = { seq: 0, buffer: [], oldestSeq: 1 };
      this._sessions.set(sid, state);
    }
    return state;
  }

  override dispose(): void {
    if (this._isDisposed) return;
    this._sessions.clear();
    super.dispose();
  }
}

/**
 * Pull a session id off an Event. agent-core's Event union is `AgentEvent &
 * { agentId, sessionId }` (camelCase) per
 * `packages/agent-core/src/rpc/events.ts:320`. WS wire format is
 * `session_id` (snake_case). We accept both spellings defensively so tests
 * can pass either and so future wire-mapped events still extract correctly.
 */
function extractSessionId(event: Event): string | undefined {
  const camel = (event as { sessionId?: unknown }).sessionId;
  if (typeof camel === 'string' && camel.length > 0) return camel;
  const snake = (event as { session_id?: unknown }).session_id;
  if (typeof snake === 'string' && snake.length > 0) return snake;
  return undefined;
}
