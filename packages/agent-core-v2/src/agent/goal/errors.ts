/**
 * `goal` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { t } from '@moonshot-ai/kimi-i18n';

export const GoalErrors = {
  codes: {
    GOAL_ALREADY_EXISTS: 'goal.already_exists',
    GOAL_NOT_FOUND: 'goal.not_found',
    GOAL_OBJECTIVE_EMPTY: 'goal.objective_empty',
    GOAL_OBJECTIVE_TOO_LONG: 'goal.objective_too_long',
    GOAL_COMPLETION_CRITERION_EMPTY: 'goal.completion_criterion_empty',
    GOAL_COMPLETION_CRITERION_TOO_SHORT: 'goal.completion_criterion_too_short',
    GOAL_STATUS_INVALID: 'goal.status_invalid',
    GOAL_METADATA_RESERVED: 'goal.metadata_reserved',
    GOAL_NOT_RESUMABLE: 'goal.not_resumable',
    GOAL_UNSUPPORTED_AGENT: 'goal.unsupported_agent',
  },
  info: {
    'goal.already_exists': {
      title: t('v2Errors.goalAlreadyExists'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalAlreadyExistsAction'),
    },
    'goal.not_found': {
      title: t('v2Errors.goalNotFound'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalNotFoundAction'),
    },
    'goal.objective_empty': {
      title: t('v2Errors.goalObjectiveEmpty'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalObjectiveEmptyAction'),
    },
    'goal.objective_too_long': {
      title: t('v2Errors.goalObjectiveTooLong'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalObjectiveTooLongAction'),
    },
    'goal.completion_criterion_empty': {
      title: t('v2Errors.goalCompletionCriterionEmpty'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalCompletionCriterionEmptyAction'),
    },
    'goal.completion_criterion_too_short': {
      title: t('v2Errors.goalCompletionCriterionTooShort'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalCompletionCriterionTooShortAction'),
    },
    'goal.status_invalid': {
      title: t('v2Errors.goalStatusInvalid'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalStatusInvalidAction'),
    },
    'goal.metadata_reserved': {
      title: t('v2Errors.goalMetadataReserved'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalMetadataReservedAction'),
    },
    'goal.not_resumable': {
      title: t('v2Errors.goalNotResumable'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalNotResumableAction'),
    },
    'goal.unsupported_agent': {
      title: t('v2Errors.goalUnsupportedAgent'),
      retryable: false,
      public: true,
      action: t('v2Errors.goalUnsupportedAgentAction'),
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(GoalErrors);
