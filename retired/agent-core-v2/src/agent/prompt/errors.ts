/**
 * `prompt` domain error codes — request/input validation failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const PromptErrors = {
  codes: {
    REQUEST_INVALID: 'request.invalid',
    REQUEST_WORK_DIR_REQUIRED: 'request.work_dir_required',
    REQUEST_PROMPT_INPUT_EMPTY: 'request.prompt_input_empty',
    PROMPT_NOT_FOUND: 'prompt.not_found',
    PROMPT_ALREADY_COMPLETED: 'prompt.already_completed',
    SESSION_BUSY: 'session.busy',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(PromptErrors);
