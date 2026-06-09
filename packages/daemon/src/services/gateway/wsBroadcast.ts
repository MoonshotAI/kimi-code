/**
 * `IWSBroadcastService` — daemon-local transport layer that turns the
 * in-process `IEventService.onDidPublish` firehose into a WS broadcast +
 * per-session ring buffer + replay surface.
 *
 * Responsibilities (all daemon transport concerns; intentionally NOT on the
 * `@moonshot-ai/services` cross-package `IEventService` contract):
 *
 *   1. Extract `sessionId` from each published event (defensive: accepts
 *      both camelCase `sessionId` and snake_case `session_id`). Events
 *      without a session id are dropped with a warn log.
 *   2. Maintain per-session monotonic `seq` (starts at 1).
 *   3. Maintain per-session ring buffer (capped at `maxBufferSize`,
 *      tracking `oldestSeq` for replay/resync decisions).
 *   4. Build the WS `EventEnvelope<Event>` (snake_case wire shape with
 *      `seq`, `session_id`, `timestamp`, `payload`).
 *   5. Fan out the envelope to every `WsConnection` subscribed to the
 *      session (via `ISessionClientsService.getConnections`).
 *   6. Expose replay queries (`getBufferedSince` / `currentSeq`) for the
 *      `client_hello.last_seq_by_session` and WS abort `at_seq` paths.
 *
 * Wiring: the impl auto-subscribes to `IEventService.onDidPublish` in its
 * constructor — producers continue to call `eventService.publish(event)`
 * unchanged; the broadcast layer transparently lifts those events onto the
 * wire.
 *
 * Decorator name `'wsBroadcastService'` surfaces in
 * `CyclicDependencyError.path` and `'No service registered for identifier
 * ...'` diagnostics. Replaces the prior `'eventReplayService'` (which was
 * an alias for the same singleton under a narrower surface).
 *
 * Dispose order: this service MUST dispose BEFORE `IEventService` so the
 * `onDidPublish` subscription is detached before the bus tears down its
 * emitter (reverse-construction order in `start.ts` is responsible).
 */

import { createDecorator } from '@moonshot-ai/agent-core';

import type { EventEnvelope } from '#/ws/protocol';

export interface BufferedSinceResult {
  events: Array<{ seq: number; envelope: EventEnvelope }>;
  /**
   * True iff `lastSeq + 1 < oldestSeq` (the client's gap is older than what
   * the buffer retains). The connection should send a `resync_required`
   * frame for this session and NOT replay events.
   */
  resyncRequired: boolean;
  /** Highest dispatched `seq` for the session (0 if no events yet). */
  currentSeq: number;
}

export interface IWSBroadcastService {
  readonly _serviceBrand: undefined;

  /**
   * Fetch buffered events with `seq > lastSeq` for `sessionId`.
   *
   * Result interpretation (per WS.md §6):
   *   - `currentSeq == 0`           → session has no events yet; empty replay.
   *   - `lastSeq >= currentSeq`     → client is caught up.
   *   - `lastSeq + 1 < oldestSeq`   → buffer evicted past client; resyncRequired.
   *   - otherwise                   → events with `seq > lastSeq`, in order.
   */
  getBufferedSince(sessionId: string, lastSeq: number): BufferedSinceResult;

  /**
   * Highest dispatched `seq` for the session (0 if never published).
   * Used by the WS abort ack to populate `at_seq` on idempotent calls.
   */
  currentSeq(sessionId: string): number;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IWSBroadcastService =
  createDecorator<IWSBroadcastService>('wsBroadcastService');

/** Default ring buffer cap (WS.md §3.1, §6). */
export const DEFAULT_MAX_BUFFER_SIZE = 1000;
