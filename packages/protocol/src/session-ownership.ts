/**
 * Session-ownership error details — the structured `details` payload carried
 * under `SESSION_HELD_BY_PEER` (40921) when an instance receives a request for
 * a session whose lease is held by another instance.
 *
 * Wire semantics: the payload rides the REST envelope `details` field (HTTP
 * 200 envelope; the business outcome lives in `code`) and the v2 WS `error`
 * frame `details` field, verbatim in both directions. Clients branch on
 * `kind`; within `held-by-peer` the `phase` tells the client what to do next:
 *
 *   - creating                kernel lock held before owner metadata is visible; retry shortly
 *   - routable                holder is live and registered an address; client may redirect
 *   - holder-unresponsive     legacy heartbeat-based server response; retry later
 *   - held-by-local-instance  holder has no address (local/embedded engine); terminal, do not retry
 *
 * Current kernel-lock servers emit `creating`, `routable`, or
 * `held-by-local-instance`. `holder-unresponsive` remains in the wire schema
 * so current clients can still understand older servers.
 */
import { z } from 'zod';

export const sessionOwnershipPhaseSchema = z.enum([
  'creating',
  'routable',
  'holder-unresponsive',
  'held-by-local-instance',
]);
export type SessionOwnershipPhase = z.infer<typeof sessionOwnershipPhaseSchema>;

export const heldByPeerDetailsSchema = z.object({
  kind: z.literal('held-by-peer'),
  phase: sessionOwnershipPhaseSchema,
  /** Present only when phase === 'routable'. */
  address: z.string().optional(),
  /** Retry hint (ms) for `creating` or legacy `holder-unresponsive`. */
  retry_after_ms: z.number().int().nonnegative().optional(),
});
export type HeldByPeerDetails = z.infer<typeof heldByPeerDetailsSchema>;

export const unregisteredWriterDetailsSchema = z.object({
  kind: z.literal('unregistered-writer'),
});
export type UnregisteredWriterDetails = z.infer<typeof unregisteredWriterDetailsSchema>;

export const sessionOwnershipDetailsSchema = z.discriminatedUnion('kind', [
  heldByPeerDetailsSchema,
  unregisteredWriterDetailsSchema,
]);
export type SessionOwnershipDetails = z.infer<typeof sessionOwnershipDetailsSchema>;
