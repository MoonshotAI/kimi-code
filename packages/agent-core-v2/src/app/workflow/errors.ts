/**
 * `workflow` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const WorkflowErrors = {
  codes: {
    WORKFLOW_NOT_FOUND: 'workflow.not_found',
    WORKFLOW_INVALID: 'workflow.invalid',
    WORKFLOW_ALREADY_EXISTS: 'workflow.already_exists',
  },
  info: {
    'workflow.not_found': {
      title: 'Workflow not found',
      retryable: false,
      public: true,
      action: 'Check the workflow name against the catalog listing.',
    },
    'workflow.invalid': {
      title: 'Invalid workflow',
      retryable: false,
      public: true,
      action: 'Fix the workflow script metadata or syntax.',
    },
    'workflow.already_exists': {
      title: 'Workflow already exists',
      retryable: false,
      public: true,
      action: 'Pick a different name or save with overwrite.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(WorkflowErrors);
