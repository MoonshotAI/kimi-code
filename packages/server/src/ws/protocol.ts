/**
 * WS envelope helpers — thin builders around the `@moonshot-ai/protocol`
 * schemas so `WsConnection` and `EventService` don't both re-implement the wire
 * shape (WS.md §2).
 *
 * Includes `server_hello`, `ping`, `ack`, `event`, and `resync_required`
 * helpers.
 *
 * Per WS.md §3.5: `ping` is server-pushed, carries `timestamp` + `payload.nonce`.
 * Per WS.md §3.1: `server_hello` carries `timestamp` + canonical capability set.
 * Per WS.md §2:    `ack` carries `id` (echoes Control.id), `code` (REST error
 *                  namespace, 0=success), `msg`, and `payload`.
 * Per WS.md §2:    `event` envelope carries `seq` (per-session monotonic),
 *                  `session_id`, `timestamp`, `payload` (the agent-core Event).
 * Per WS.md §3.6:  `resync_required` carries `session_id`, `reason`
 *                  ('buffer_overflow' | 'session_recreated'), and `current_seq`.
 *
 * Outbound payloads go straight to `JSON.stringify` — no Zod re-validation on
 * the outbound path.
 */

import type { Event } from '@moonshot-ai/protocol';
import { ulid } from 'ulid';

/** WS.md §3.1: `server_hello.payload`. */
export interface ServerHelloPayload {
  ws_connection_id: string;
  protocol_version: number;
  heartbeat_ms: number;
  max_event_buffer_size: number;
  capabilities: {
    event_batching: boolean;
    compression: boolean;
  };
}

/** WS.md §3.1: `server_hello` frame. */
export interface ServerHelloFrame {
  type: 'server_hello';
  timestamp: string;
  payload: ServerHelloPayload;
}

export function buildServerHello(payload: ServerHelloPayload): ServerHelloFrame {
  return { type: 'server_hello', timestamp: new Date().toISOString(), payload };
}

/** WS.md §3.5: `ping` frame (S→C). `nonce` is server-minted ULID. */
export interface PingFrame {
  type: 'ping';
  timestamp: string;
  payload: { nonce: string };
}

export function buildPing(): PingFrame {
  return {
    type: 'ping',
    timestamp: new Date().toISOString(),
    payload: { nonce: ulid() },
  };
}

/**
 * WS.md §2: `ack` frame (S→C). `code` follows REST error namespace
 * (0 = success). `msg` matches `code`. Echoes `id` back from the inbound
 * control message — callers pass `''` when the inbound had no `id`.
 */
export interface AckFrame<P = unknown> {
  type: 'ack';
  id: string;
  code: number;
  msg: string;
  payload: P;
}

export function buildAck<P>(id: string, code: number, msg: string, payload: P): AckFrame<P> {
  return { type: 'ack', id, code, msg, payload };
}

/**
 * WS.md §2: event envelope (S→C). `seq` is per-session monotonically
 * increasing starting at 1; non-event frames use a different outer shape
 * (`server_hello` / `ping` / `ack` / `resync_required`).
 *
 * `payload` is the raw `Event` (camelCase per
 * `packages/agent-core/src/rpc/events.ts:320`). The server sends the camelCase
 * payload as-is; only the outer envelope (`type`, `seq`, `session_id`,
 * `timestamp`, `payload`) is snake_case.
 *
 * The `type` on the envelope is the agent-core event type string (e.g.
 * `event.assistant.delta`). Tests usually publish stub events with arbitrary
 * `type` strings.
 */
export interface EventEnvelope<P = Event> {
  type: string;
  seq: number;
  /** Journal epoch the seq belongs to (cursor invalidation across restarts). */
  epoch?: string;
  /**
   * True for ephemeral frames (deltas / progress / periodic status): they
   * carry the current durable watermark as `seq`, do not advance it, and are
   * never replayed after a reconnect.
   */
  volatile?: boolean;
  /** Pre-append stream offset for volatile text-delta frames. */
  offset?: number;
  session_id: string;
  timestamp: string;
  payload: P;
}

export function buildEventEnvelope(
  seq: number,
  sessionId: string,
  event: Event,
  opts: { epoch?: string; volatile?: boolean; offset?: number } = {},
): EventEnvelope<Event> {
  const type = (event as { type?: string }).type ?? 'event.unknown';
  return {
    type,
    seq,
    ...(opts.epoch !== undefined ? { epoch: opts.epoch } : {}),
    ...(opts.volatile === true ? { volatile: true } : {}),
    ...(opts.offset !== undefined ? { offset: opts.offset } : {}),
    session_id: sessionId,
    timestamp: new Date().toISOString(),
    payload: event,
  };
}

/**
 * WS.md §3.6: `resync_required` system message (S→C). Sent when the
 * client's cursor cannot be served incrementally: the gap exceeds the replay
 * cap (`buffer_overflow`), the cursor's journal epoch does not match
 * (`epoch_changed`), or the session was recreated (`session_recreated`).
 * The client should rebuild via `GET /sessions/{id}/snapshot` and
 * re-`subscribe` with `cursors[sid] = { seq: as_of_seq, epoch }`.
 */
export interface ResyncRequiredFrame {
  type: 'resync_required';
  timestamp: string;
  payload: {
    session_id: string;
    reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed';
    current_seq: number;
    epoch?: string;
  };
}

export function buildResyncRequired(
  sessionId: string,
  reason: 'buffer_overflow' | 'session_recreated' | 'epoch_changed',
  currentSeq: number,
  epoch?: string,
): ResyncRequiredFrame {
  return {
    type: 'resync_required',
    timestamp: new Date().toISOString(),
    payload: {
      session_id: sessionId,
      reason,
      current_seq: currentSeq,
      ...(epoch !== undefined ? { epoch } : {}),
    },
  };
}
