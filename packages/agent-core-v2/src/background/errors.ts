/**
 * `background` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const BackgroundErrors = {
  codes: {
    BACKGROUND_TASK_ID_EMPTY: 'background.task_id_empty',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(BackgroundErrors);
