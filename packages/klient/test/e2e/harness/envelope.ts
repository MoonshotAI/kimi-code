/**
 * REST envelope helpers — unwrap `{ code, msg, data, request_id }` into either
 * a typed `data` or an `EnvelopeError` thrown by the caller.
 *
 * Mirrors `packages/protocol/src/envelope.ts` so the server's wire shape and
 * this client's parsing stay in lockstep.
 */
import { ErrorCode, ErrorCodeReason, type Envelope } from '@moonshot-ai/protocol';

/**
 * Thrown when an HTTP call lands but `envelope.code !== 0`.
 *
 * `data` is preserved separately because several server endpoints return
 * non-zero envelopes with a non-null `data` payload (REST §3.6 idempotent
 * re-resolve: `code: 40902 + data: { resolved: false }`).
 */
export class EnvelopeError<T = unknown> extends Error {
  readonly code: number;
  readonly reason: string;
  readonly requestId: string;
  readonly data: T | null;

  constructor(envelope: Envelope<T>) {
    const reason = ErrorCodeReason[envelope.code as ErrorCode] ?? 'unknown';
    super(`server returned code=${envelope.code} (${reason}): ${envelope.msg}`);
    this.name = 'EnvelopeError';
    this.code = envelope.code;
    this.reason = reason;
    this.requestId = envelope.request_id;
    this.data = envelope.data;
  }
}

/**
 * Unwrap a parsed envelope. On `code === 0` returns `data` (which may be
 * `null` — callers asking for a non-nullable type should narrow).
 */
export function unwrap<T>(envelope: Envelope<T>): T {
  if (envelope.code !== 0) throw new EnvelopeError(envelope);
  if (envelope.data === null) {
    // `code: 0 + data: null` is reserved for "no body" success envelopes; the
    // current server surface always returns a non-null data on success, so
    // surface this as a hard error rather than silently returning `null`.
    throw new EnvelopeError({ ...envelope, code: 50001, msg: 'success envelope had null data' });
  }
  return envelope.data;
}
