/**
 * `debug` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';

export const DebugErrors = {
  codes: {
    DEBUG_SCOPE_NOT_FOUND: 'debug.scope_not_found',
    DEBUG_TOKEN_NOT_FOUND: 'debug.token_not_found',
  },
} as const satisfies ErrorDomain;

registerErrorDomain(DebugErrors);
