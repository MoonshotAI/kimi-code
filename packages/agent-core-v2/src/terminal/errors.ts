/**
 * `terminal` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const TerminalErrors = {
  codes: {
    SHELL_GIT_BASH_NOT_FOUND: 'shell.git_bash_not_found',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(TerminalErrors);
