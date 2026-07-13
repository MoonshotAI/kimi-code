/**
 * `/api/v1/ws` wire frame builders — thin wrappers around the
 * `@moonshot-ai/protocol` message shapes, ported from v1
 * (`packages/server/src/ws/protocol.ts`).
 *
 * Outbound payloads go straight to `JSON.stringify` — no Zod re-validation.
 */

export interface ServerHelloPayload {
  ws_connection_id: string;
  protocol_version: number;
  max_event_buffer_size: number;
  capabilities: {
    event_batching: boolean;
    compression: boolean;
  };
}

export interface ServerHelloFrame {
  type: 'server_hello';
  timestamp: string;
  payload: ServerHelloPayload;
}

export function buildServerHello(payload: ServerHelloPayload): ServerHelloFrame {
  return { type: 'server_hello', timestamp: new Date().toISOString(), payload };
}

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

export type ResyncReason = 'buffer_overflow' | 'session_recreated' | 'epoch_changed';

export interface ResyncRequiredFrame {
  type: 'resync_required';
  timestamp: string;
  payload: {
    session_id: string;
    reason: ResyncReason;
    current_seq: number;
    epoch?: string;
  };
}

export function buildResyncRequired(
  sessionId: string,
  reason: ResyncReason,
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
