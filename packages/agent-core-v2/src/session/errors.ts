/**
 * `session` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const SessionErrors = {
  codes: {
    SESSION_NOT_FOUND: 'session.not_found',
    SESSION_ALREADY_EXISTS: 'session.already_exists',
    SESSION_ID_INVALID: 'session.id_invalid',
    SESSION_ID_REQUIRED: 'session.id_required',
    SESSION_ID_EMPTY: 'session.id_empty',
    SESSION_TITLE_EMPTY: 'session.title_empty',
    SESSION_STATE_NOT_FOUND: 'session.state_not_found',
    SESSION_STATE_INVALID: 'session.state_invalid',
    SESSION_FORK_ACTIVE_TURN: 'session.fork_active_turn',
    SESSION_EXPORT_NOT_FOUND: 'session.export_not_found',
    SESSION_EXPORT_MISSING_VERSION: 'session.export_missing_version',
    SESSION_CLOSED: 'session.closed',
    SESSION_PERMISSION_MODE_INVALID: 'session.permission_mode_invalid',
    SESSION_THINKING_EMPTY: 'session.thinking_empty',
    SESSION_MODEL_EMPTY: 'session.model_empty',
    SESSION_PLAN_MODE_INVALID: 'session.plan_mode_invalid',
    SESSION_APPROVAL_HANDLER_ERROR: 'session.approval_handler_error',
    SESSION_QUESTION_HANDLER_ERROR: 'session.question_handler_error',
    SESSION_INIT_FAILED: 'session.init_failed',
  },
  retryable: ['session.fork_active_turn'],
} as const satisfies ErrorDomain;

registerErrorDomain(SessionErrors);
