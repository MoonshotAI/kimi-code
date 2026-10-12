export const WS_PROTOCOL_VERSION = 2;

export const WS_BEARER_PROTOCOL_PREFIX = 'kimi-code.bearer.';

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

export interface ServerHelloFrame {
  type: 'server_hello';
  timestamp: string;
  payload: ServerHelloPayload;
}

export function buildServerHello(payload: ServerHelloPayload): ServerHelloFrame {
  return { type: 'server_hello', timestamp: new Date().toISOString(), payload };
}

export interface PingFrame {
  type: 'ping';
  timestamp: string;
  payload: { nonce: string };
}

export function buildPing(nonce: string): PingFrame {
  return { type: 'ping', timestamp: new Date().toISOString(), payload: { nonce } };
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

export interface WsErrorFrame {
  type: 'error';
  timestamp: string;
  payload: {
    code: number;
    msg: string;
    fatal: boolean;
    request_id?: string;
    details?: unknown;
  };
}

export function buildError(code: number, msg: string, fatal: boolean, requestId?: string): WsErrorFrame {
  return {
    type: 'error',
    timestamp: new Date().toISOString(),
    payload: { code, msg, fatal, ...(requestId !== undefined ? { request_id: requestId } : {}) },
  };
}

export function selectBearerProtocol(protocols: Set<string>): string | false {
  for (const protocol of protocols) {
    if (protocol.startsWith(WS_BEARER_PROTOCOL_PREFIX)) return protocol;
  }
  return false;
}
