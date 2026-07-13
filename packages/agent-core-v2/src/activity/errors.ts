/**
 * `activity` domain error codes.
 *
 * `activity.agent_busy` inherits the retryable semantics of the legacy
 * `turn.agent_busy`; the two coexist during migration, and `turn.*` callers
 * move to the new code before the legacy one is retired. The legacy
 * `TURN_AGENT_BUSY` code itself is also registered here: with the `turn`
 * domain folded into `loop`, skill activation is its last thrower, and this
 * is the migration harbor that retires it once that caller moves over.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const ActivityErrors = {
  codes: {
    ACTIVITY_AGENT_BUSY: 'activity.agent_busy',
    ACTIVITY_CANCELLING: 'activity.cancelling',
    ACTIVITY_DISPOSING: 'activity.disposing',
    ACTIVITY_DISPOSED: 'activity.disposed',
    ACTIVITY_INITIALIZING: 'activity.initializing',
    ACTIVITY_SESSION_REJECTED: 'activity.session_rejected',
    TURN_AGENT_BUSY: 'turn.agent_busy',
  },
  retryable: [
    'activity.agent_busy',
    'activity.cancelling',
    'activity.initializing',
    'activity.session_rejected',
    'turn.agent_busy',
  ],
} as const satisfies ErrorDomain;

registerErrorDomain(ActivityErrors);
