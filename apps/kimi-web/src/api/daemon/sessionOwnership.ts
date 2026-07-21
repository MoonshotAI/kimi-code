// apps/kimi-web/src/api/daemon/sessionOwnership.ts
// Session-ownership (multi-instance) error details — local re-implementation
// of the `details` payload carried under envelope code 40921
// (`session.held_by_peer`). kimi-web must not depend on @moonshot-ai/agent-core
// or @moonshot-ai/protocol, so the zod schema in
// packages/protocol/src/session-ownership.ts is mirrored here as plain types
// plus structural narrowing.
//
// Wire semantics (from the protocol schema):
//   - creating                lease file observed mid-creation; retry shortly
//   - routable                holder is live and registered an address; redirect
//   - held-by-local-instance  holder has no address (local/embedded); terminal

import { isDaemonApiError } from '../errors';

/** Envelope `code` for `session.held_by_peer` (see kap-server error-handler). */
export const SESSION_HELD_BY_PEER_CODE = 40921;

export type SessionOwnershipPhase =
  | 'creating'
  | 'routable'
  | 'held-by-local-instance';

export interface HeldByPeerDetails {
  kind: 'held-by-peer';
  phase: SessionOwnershipPhase;
  /** Present only when phase === 'routable'. */
  address?: string;
  /** Retry hint (ms) for 'creating'. */
  retry_after_ms?: number;
}

export type SessionOwnershipDetails = HeldByPeerDetails;

const PHASES: ReadonlySet<SessionOwnershipPhase> = new Set([
  'creating',
  'routable',
  'held-by-local-instance',
]);

function isSessionOwnershipPhase(value: string): value is SessionOwnershipPhase {
  return PHASES.has(value as SessionOwnershipPhase);
}

/** Structurally narrow an unknown envelope `details` payload. Returns undefined
 *  for anything that is not a well-formed ownership payload (defensive: the
 *  server contract is new, and a malformed payload must degrade to the generic
 *  error toast rather than a crash). */
export function narrowSessionOwnershipDetails(
  details: unknown,
): SessionOwnershipDetails | undefined {
  if (typeof details !== 'object' || details === null) return undefined;
  const record = details as Record<string, unknown>;
  if (record['kind'] !== 'held-by-peer') return undefined;
  const phase = record['phase'];
  if (typeof phase !== 'string' || !isSessionOwnershipPhase(phase)) {
    return undefined;
  }
  const address = record['address'];
  const retryAfterMs = record['retry_after_ms'];
  return {
    kind: 'held-by-peer',
    phase,
    address: typeof address === 'string' && address.length > 0 ? address : undefined,
    retry_after_ms:
      typeof retryAfterMs === 'number' && Number.isFinite(retryAfterMs) && retryAfterMs >= 0
        ? retryAfterMs
        : undefined,
  };
}

/** Extract the ownership details from any thrown value: a DaemonApiError with
 *  code 40921 carrying a well-formed details payload. Anything else → undefined. */
export function getSessionOwnershipDetails(err: unknown): SessionOwnershipDetails | undefined {
  if (!isDaemonApiError(err)) return undefined;
  if (err.code !== SESSION_HELD_BY_PEER_CODE) return undefined;
  return narrowSessionOwnershipDetails(err.details);
}
