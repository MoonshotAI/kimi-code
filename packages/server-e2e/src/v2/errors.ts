/**
 * v2 RPC error + unwrap helpers.
 *
 * The `/api/v2` surface uses the same `{ code, msg, data, request_id }`
 * envelope as v1, but unlike v1 it legitimately returns `code: 0` with
 * `data: null` for "no body" actions (e.g. `session:setTitle`). The v1
 * `unwrap()` in `envelope.ts` treats `data === null` as a hard error, so v2
 * needs its own unwrap that only rejects on `code !== 0`.
 */
import type { Envelope } from '@moonshot-ai/protocol';

/** Thrown when an `/api/v2` call lands with a non-zero `code`. */
export class RpcError extends Error {
  readonly code: number;
  readonly requestId: string | undefined;
  readonly details: unknown;

  constructor(envelope: Envelope<unknown>) {
    super(`server-v2 returned code=${envelope.code}: ${envelope.msg}`);
    this.name = 'RpcError';
    this.code = envelope.code;
    this.requestId = envelope.request_id;
    this.details = (envelope as { details?: unknown }).details;
  }
}

/**
 * Unwrap a v2 envelope. Returns `data` (which may be `null`) on `code === 0`;
 * throws {@link RpcError} otherwise.
 */
export function unwrapData<T>(envelope: Envelope<T>): T {
  if (envelope.code !== 0) throw new RpcError(envelope as Envelope<unknown>);
  // The protocol envelope types `data` as `T | null`; v2 actions that return a
  // body are typed `T` (non-null) by the caller, and `code: 0` + null data is a
  // legitimate "no body" success for actions typed `T = null`. Cast through.
  return envelope.data as T;
}
