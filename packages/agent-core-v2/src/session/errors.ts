import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const SessionErrors = {
  codes: {
    SESSION_NOT_FOUND: 'session.not_found',
    SESSION_ALREADY_EXISTS: 'session.already_exists',
    SESSION_ID_INVALID: 'session.id_invalid',
    SESSION_CLOSED: 'session.closed',
    SESSION_LOCKED: 'session.locked',
    SESSION_FORK_ACTIVE_TURN: 'session.fork_active_turn',
    SESSION_UNDO_UNAVAILABLE: 'session.undo_unavailable',
    SESSION_INIT_FAILED: 'session.init_failed',
    SESSION_PLAN_MODE_INVALID: 'session.plan_mode_invalid',
    SESSION_TOWER_MODE_INVALID: 'session.tower_mode_invalid',
  },
  retryable: ['session.fork_active_turn'],
  info: {
    'session.locked': {
      title: 'Session locked',
      retryable: false,
      public: true,
      action: 'The session is held by another kimi-code instance; resume it there or wait for its heartbeat to expire.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(SessionErrors);
