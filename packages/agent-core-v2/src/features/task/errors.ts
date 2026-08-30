import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const TaskErrors = {
  codes: {
    TASK_ID_CONFLICT: 'task.id_conflict',
    TASK_LIMIT_EXCEEDED: 'task.limit_exceeded',
  },
  retryable: ['task.limit_exceeded'],
} as const satisfies ErrorDomain;

registerErrorDomain(TaskErrors);
