/**
 * `auth` domain error codes.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const AuthErrors = {
  codes: {
    AUTH_LOGIN_REQUIRED: 'auth.login_required',
  },
  info: {
    'auth.login_required': {
      title: 'Login required',
      retryable: false,
      public: true,
      action: 'Run /login to authenticate with the OAuth provider.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(AuthErrors);
