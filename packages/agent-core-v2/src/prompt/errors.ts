/**
 * `prompt` domain error codes — request/input validation failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const PromptErrors = {
  codes: {
    REQUEST_INVALID: 'request.invalid',
    REQUEST_WORK_DIR_REQUIRED: 'request.work_dir_required',
    REQUEST_PROMPT_INPUT_EMPTY: 'request.prompt_input_empty',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(PromptErrors);
