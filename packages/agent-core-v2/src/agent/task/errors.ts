/**
 * `task` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const TaskErrors = {
  codes: {
    TASK_ID_EMPTY: 'task.task_id_empty',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(TaskErrors);
