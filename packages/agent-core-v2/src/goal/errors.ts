/**
 * `goal` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const GoalErrors = {
  codes: {
    GOAL_ALREADY_EXISTS: 'goal.already_exists',
    GOAL_NOT_FOUND: 'goal.not_found',
    GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
    GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
    GOAL_STATUS_INVALID: 'goal.status_invalid',
    GOAL_METADATA_RESERVED: 'goal.metadata_reserved',
    GOAL_NOT_RESUMABLE: 'goal.not_resumable',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(GoalErrors);
