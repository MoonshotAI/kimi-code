/**
 * `IWSBroadcastService` — server-local transport layer that turns the
 * in-process `IEventService.onDidPublish` firehose into a WS broadcast +
 * durable per-session event journal + replay surface.
 *
 * v2 (IM-style multi-device sync) responsibilities:
 *
 *   1. Extract `sessionId` from each published event (defensive: accepts
 *      both camelCase `sessionId` and snake_case `session_id`). Events
 *      without a session id are dropped with a warn log.
 *   2. Classify events as durable vs volatile (`VOLATILE_EVENT_TYPES`).
 *   3. Durable events: assign the next per-session `seq` (journal offset,
 *      monotonic ACROSS DAEMON RESTARTS), persist to the session's
 *      `SessionEventJournal`, cache in an in-memory tail buffer, fan out.
 *   4. Volatile events: fan out live with the current durable watermark as
 *      `seq` and `volatile: true`. Never journaled, never replayed.
 *   5. Expose replay (`getBufferedSince`) keyed by `{seq, epoch}` cursors:
 *      epoch mismatch or a cursor ahead of the journal → `epoch_changed`
 *      resync; a gap larger than the replay cap → `buffer_overflow` resync
 *      (the client should rebuild via `GET /sessions/{sid}/snapshot`);
 *      otherwise events come from the memory tail or the journal file.
 *   6. Expose `getCursor` so the snapshot route / subscribe acks can hand
 *      clients an authoritative `{seq, epoch}` watermark.
 *
 * Wiring: the impl auto-subscribes to `IEventService.onDidPublish` in its
 * constructor — producers continue to call `eventService.publish(event)`
 * unchanged; the broadcast layer transparently lifts those events onto the
 * wire.
 *
 * Dispose order: this service MUST dispose BEFORE `IEventService` so the
 * `onDidPublish` subscription is detached before the bus tears down its
 * emitter (reverse-construction order in `start.ts` is responsible).
 */

import { createDecorator } from '@moonshot-ai/agent-core';
import type { ISessionService as ISessionServiceT } from '@moonshot-ai/agent-core';
import type { InFlightTurn, SessionCursor } from '@moonshot-ai/protocol';

import type { EventEnvelope } from '#/ws/protocol';

export type ResyncReason = 'buffer_overflow' | 'session_recreated' | 'epoch_changed';

export interface SessionSnapshotState {
  seq: number;
  epoch: string;
  inFlightTurn: InFlightTurn | null;
}

export interface BufferedSinceResult {
  events: Array<{ seq: number; envelope: EventEnvelope }>;
  /**
   * Set when the cursor cannot be served incrementally — the client must
   * rebuild from the session snapshot and re-subscribe at the returned
   * `{currentSeq, epoch}`.
   */
  resyncRequired: ResyncReason | false;
  /** Highest durable `seq` for the session (0 if no events yet). */
  currentSeq: number;
  /** Current journal epoch for the session. */
  epoch: string;
}

export interface IWSBroadcastService {
  readonly _serviceBrand: undefined;

  /**
   * Fetch durable events with `seq > cursor.seq` for `sessionId`.
   *
   * Result interpretation:
   *   - `cursor.epoch` set but ≠ journal epoch     → resync `epoch_changed`.
   *   - `cursor.seq > currentSeq` (client ahead)   → resync `epoch_changed`
   *     (stale/foreign cursor — e.g. a v1 cursor from before journaling).
   *   - `currentSeq - cursor.seq > replay cap`     → resync `buffer_overflow`.
   *   - otherwise → durable events with `seq > cursor.seq`, in order, from
   *     the memory tail or the on-disk journal.
   */
  getBufferedSince(sessionId: string, cursor: SessionCursor): Promise<BufferedSinceResult>;

  /** Authoritative `{seq, epoch}` watermark for the session. */
  getCursor(sessionId: string): Promise<{ seq: number; epoch: string }>;

  /**
   * Watermark + accumulated in-flight turn state, read atomically with
   * respect to the per-session dispatch queue. Backs
   * `GET /sessions/{sid}/snapshot`.
   */
  getSnapshotState(sessionId: string): Promise<SessionSnapshotState>;

  /**
   * Best-effort sync watermark (0 if the session's journal has not been
   * touched this run). Used by the WS abort ack `at_seq` path.
   */
  currentSeq(sessionId: string): number;

  /**
   * Wire the session-close listener that drops per-session buffers, journal
   * state, and in-flight turn tracking when a session closes. Must be called
   * after this service's event-bus subscription is in place and after the
   * caller has resolved SessionService, so DI does not instantiate
   * SessionService before this service — that would flip bus subscription
   * order and let status_changed events overtake the turn boundaries that
   * caused them.
   */
  bindSessionCloseListener(sessionService: ISessionServiceT): void;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWSBroadcastService =
  createDecorator<IWSBroadcastService>('wsBroadcastService');

/**
 * Max durable events served by one incremental replay. Larger gaps get a
 * `buffer_overflow` resync — at that point a snapshot rebuild is cheaper
 * than streaming the backlog. Also sizes the in-memory tail cache.
 */
export const DEFAULT_MAX_BUFFER_SIZE = 1000;
