/**
 * `session` domain error codes — shared across the session layer
 * (`sessionLifecycle` / `sessionLegacy` / `messageLegacy`).
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SessionErrors = {
  codes: {
    SESSION_NOT_FOUND: 'session.not_found',
    SESSION_ALREADY_EXISTS: 'session.already_exists',
    SESSION_ID_INVALID: 'session.id_invalid',
    SESSION_CLOSED: 'session.closed',
    SESSION_FORK_ACTIVE_TURN: 'session.fork_active_turn',
    SESSION_UNDO_UNAVAILABLE: 'session.undo_unavailable',
    SESSION_INIT_FAILED: 'session.init_failed',
  },
  retryable: ['session.fork_active_turn'],
} as const satisfies ErrorDomain;

registerErrorDomain(SessionErrors);
