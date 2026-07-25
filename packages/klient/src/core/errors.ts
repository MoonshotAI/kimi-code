/**
 * Client-side RPC error surfaced when the wire envelope carries a non-zero
 * `code`. Mirrors the server envelope (`{ code, msg, data, request_id }`) — the
 * numeric `code` is the stable branch key across the wire, not `instanceof`.
 */
export class RPCError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'RPCError';
  }
}
