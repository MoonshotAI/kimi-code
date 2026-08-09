/**
 * `goal` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const GoalErrors = {
  codes: {
    GOAL_ALREADY_EXISTS: 'goal.already_exists',
    GOAL_NOT_FOUND: 'goal.not_found',
    GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
    GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
    GOAL_STATUS_INVALID: 'goal.status_invalid',
    GOAL_METADATA_RESERVED: 'goal.metadata_reserved',
    GOAL_NOT_RESUMABLE: 'goal.not_resumable',
    GOAL_UNSUPPORTED_AGENT: 'goal.unsupported_agent',
  },
  info: {
    'goal.already_exists': {
      title: 'A goal is already active',
      retryable: false,
      public: true,
      action: 'Use `/goal replace <objective>` to replace the current goal.',
    },
    'goal.not_found': {
      title: 'No goal found',
      retryable: false,
      public: true,
      action: 'Start a goal with `/goal <objective>` first.',
    },
    'goal.objective_empty': {
      title: 'Goal objective is empty',
      retryable: false,
      public: true,
      action: 'Provide a non-empty objective.',
    },
    'goal.objective_too_long': {
      title: 'Goal objective is too long',
      retryable: false,
      public: true,
      action: 'Keep the objective under 4000 characters; reference long details by file path.',
    },
    'goal.status_invalid': {
      title: 'Invalid goal status transition',
      retryable: false,
      public: true,
      action: 'Only an active goal can be paused; resume a blocked goal with `/goal resume`.',
    },
    'goal.metadata_reserved': {
      title: 'Goal metadata is reserved',
      retryable: false,
      public: true,
      action: 'Do not write metadata.custom.goal directly; use the goal lifecycle methods.',
    },
    'goal.not_resumable': {
      title: 'Goal is not resumable',
      retryable: false,
      public: true,
      action: 'Only paused or blocked goals can be resumed.',
    },
    'goal.unsupported_agent': {
      title: 'Goals are unavailable for subagents',
      retryable: false,
      public: true,
      action: 'Run goal lifecycle commands on the main agent.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(GoalErrors);
