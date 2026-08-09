/**
 * Per-request pino logger access for route handlers whose request type is
 * structurally narrowed (`defineRoute` declares only the fields a handler
 * uses). At runtime every handler receives a real Fastify request, which
 * always carries `log` — the same pattern `error-handler.ts` relies on.
 */

import type { Logger } from 'pino';

/** Minimal pino surface used by route handlers. */
export type RequestLogger = Pick<Logger, 'info' | 'warn' | 'error'>;

/**
 * Extract Fastify's per-request logger from a narrowed route-handler request.
 * Returns `undefined` only for hand-rolled test doubles that never install a
 * logger — callers should use optional chaining.
 */
export function requestLog(req: { id: string }): RequestLogger | undefined {
  return (req as { log?: RequestLogger }).log;
}
