

import { join } from 'node:path';

import { Disposable, IEnvironmentService, IEventService, ILogService } from '@moonshot-ai/agent-core';
import { isVolatileEventType, type Event, type SessionCursor } from '@moonshot-ai/protocol';
import { IConnectionRegistry } from './connectionRegistry';
import { InFlightTurnTracker } from './inFlightTurnTracker';
import { ISessionClientsService } from './sessionClients';
import { SessionEventJournal } from './sessionEventJournal';
import {
  DEFAULT_MAX_BUFFER_SIZE,
  IWSBroadcastService,
  type BufferedSinceResult,
  type SessionSnapshotState,
} from './wsBroadcast';

import { buildEventEnvelope, type EventEnvelope } from '#/ws/protocol';

interface BufferEntry {
  seq: number;
  envelope: EventEnvelope;
}

interface SessionState {
  /** Resolves when the journal file has been opened/recovered. */
  ready: Promise<SessionEventJournal>;
  /** Set once `ready` resolves — for sync best-effort reads. */
  journal: SessionEventJournal | undefined;
  /** In-memory tail cache of the most recent durable envelopes. */
  tail: BufferEntry[];
  /** Per-session dispatch chain: keeps journal append + fan-out ordered. */
  queue: Promise<void>;
}

export class WSBroadcastService extends Disposable implements IWSBroadcastService {
  readonly _serviceBrand: undefined;

  private readonly _sessions = new Map<string, SessionState>();
  private readonly _maxBufferSize: number;
  private readonly _journalDir: string;
  private readonly _turnTracker = new InFlightTurnTracker();

  constructor(
    @IEventService eventService: IEventService,
    @ILogService private readonly logger: ILogService,
    @ISessionClientsService private readonly sessionClients: ISessionClientsService,
    @IConnectionRegistry private readonly connectionRegistry: IConnectionRegistry,
    @IEnvironmentService env: IEnvironmentService,
  ) {
    super();
    this._maxBufferSize = DEFAULT_MAX_BUFFER_SIZE;
    this._journalDir = join(env.homeDir, 'server', 'events');

    this._register(
      eventService.onDidPublish((event) => {
        this._onEvent(event);
      }),
    );
  }

  private _onEvent(event: Event): void {
    if (this._store.isDisposed) return;
    const sid = extractSessionId(event);
    const evType = (event as { type?: string }).type ?? '<no-type>';
    if (!sid) {
      this.logger.warn(
        { eventType: evType, eventKeys: Object.keys(event as object) },
        'wsBroadcast: event has no session_id; dropping',
      );
      return;
    }
    const state = this._getOrCreateSession(sid);
    state.queue = state.queue
      .then(() => this._dispatch(sid, state, event))
      .catch((err: unknown) => {
        this.logger.warn({ sid, eventType: evType, err: String(err) }, 'wsBroadcast dispatch failed');
      });
  }

  private async _dispatch(sid: string, state: SessionState, event: Event): Promise<void> {
    if (this._store.isDisposed) return;
    const journal = await state.ready;
    const evType = (event as { type?: string }).type ?? 'event.unknown';

    // Track in-flight turn state inside the dispatch queue so accumulated
    // text, the journal watermark, and fan-out order stay consistent. For
    // text deltas this also yields the pre-append offset for the envelope.
    const annotation = this._turnTracker.apply(sid, event);

    let envelope: EventEnvelope;
    if (isVolatileEventType(evType)) {
      // Volatile frames ride the current durable watermark and are never
      // journaled or replayed; reconnecting clients recover their state from
      // the session snapshot instead.
      envelope = buildEventEnvelope(journal.seq, sid, event, {
        epoch: journal.epoch,
        volatile: true,
        ...(annotation.offset !== undefined ? { offset: annotation.offset } : {}),
      });
    } else {
      const seq = journal.nextSeq();
      envelope = buildEventEnvelope(seq, sid, event, { epoch: journal.epoch });
      journal.append(seq, envelope);
      state.tail.push({ seq, envelope });
      while (state.tail.length > this._maxBufferSize) {
        state.tail.shift();
      }
    }

    if (this._store.isDisposed) return;
    const targets = isGlobalSessionEvent(evType)
      ? this.connectionRegistry.values()
      : this.sessionClients.getConnections(sid);
    for (const conn of targets) {
      conn.send(envelope);
    }
  }

  async getBufferedSince(sid: string, cursor: SessionCursor): Promise<BufferedSinceResult> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    // Drain in-flight dispatches so the watermark reflects everything
    // published before this call.
    await state.queue;

    const currentSeq = journal.seq;
    const epoch = journal.epoch;

    if (cursor.epoch !== undefined && cursor.epoch !== epoch) {
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq > currentSeq) {
      // Client is ahead of the journal — a cursor from another incarnation
      // (e.g. pre-journal v1 server). Without a matching epoch we cannot
      // trust it; force a snapshot rebuild.
      return { events: [], resyncRequired: 'epoch_changed', currentSeq, epoch };
    }
    if (cursor.seq === currentSeq) {
      return { events: [], resyncRequired: false, currentSeq, epoch };
    }
    if (currentSeq - cursor.seq > this._maxBufferSize) {
      return { events: [], resyncRequired: 'buffer_overflow', currentSeq, epoch };
    }

    const tail = state.tail;
    if (tail.length > 0 && tail[0]!.seq <= cursor.seq + 1) {
      const events = tail.filter((e) => e.seq > cursor.seq);
      return { events, resyncRequired: false, currentSeq, epoch };
    }

    // Gap reaches behind the memory tail (e.g. first subscribe after a
    // server restart) — serve from the on-disk journal.
    const events = await journal.readSince(cursor.seq, this._maxBufferSize);
    return { events, resyncRequired: false, currentSeq, epoch };
  }

  async getCursor(sid: string): Promise<{ seq: number; epoch: string }> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    await state.queue;
    return { seq: journal.seq, epoch: journal.epoch };
  }

  async getSnapshotState(sid: string): Promise<SessionSnapshotState> {
    const state = this._getOrCreateSession(sid);
    const journal = await state.ready;
    await state.queue;
    // Sync reads after the drain — seq and in-flight state form a
    // consistent pair (no dispatch can interleave a sync section).
    return {
      seq: journal.seq,
      epoch: journal.epoch,
      inFlightTurn: this._turnTracker.get(sid),
    };
  }

  currentSeq(sid: string): number {
    return this._sessions.get(sid)?.journal?.seq ?? 0;
  }

  _currentSeqForTest(sid: string): number {
    return this.currentSeq(sid);
  }

  _bufferLengthForTest(sid: string): number {
    return this._sessions.get(sid)?.tail.length ?? 0;
  }

  /** Settles when every queued dispatch for `sid` has completed. */
  async _drainForTest(sid: string): Promise<void> {
    const state = this._sessions.get(sid);
    if (!state) return;
    await state.ready;
    await state.queue;
  }

  private _getOrCreateSession(sid: string): SessionState {
    let state = this._sessions.get(sid);
    if (!state) {
      const filePath = join(this._journalDir, `${sanitizeFileName(sid)}.jsonl`);
      const created: SessionState = {
        ready: SessionEventJournal.open(filePath, this.logger),
        journal: undefined,
        tail: [],
        queue: Promise.resolve(),
      };
      created.ready = created.ready.then((journal) => {
        created.journal = journal;
        return journal;
      });
      this._sessions.set(sid, created);
      state = created;
    }
    return state;
  }

  override dispose(): void {
    if (this._store.isDisposed) return;
    for (const state of this._sessions.values()) {
      const journal = state.journal;
      if (journal) {
        void journal.close().catch(() => {});
      }
    }
    this._sessions.clear();
    super.dispose();
  }
}

function extractSessionId(event: Event): string | undefined {
  const camel = (event as { sessionId?: unknown }).sessionId;
  if (typeof camel === 'string' && camel.length > 0) return camel;
  const snake = (event as { session_id?: unknown }).session_id;
  if (typeof snake === 'string' && snake.length > 0) return snake;
  return undefined;
}

function isGlobalSessionEvent(type: string): boolean {
  return (
    type === 'event.session.created' ||
    type === 'event.session.status_changed' ||
    type === 'event.config.changed' ||
    // Workspace registry is not session-scoped: workspace lifecycle events ride
    // the '__global__' watermark and fan out to every connection.
    type === 'event.workspace.created' ||
    type === 'event.workspace.updated' ||
    type === 'event.workspace.deleted'
  );
}

/** Session ids are ULID-ish, but never trust an id used as a path segment. */
function sanitizeFileName(sid: string): string {
  return sid.replace(/[^A-Za-z0-9._-]/g, '_');
}
