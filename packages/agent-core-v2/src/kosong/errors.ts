/**
 * `kosong` domain error codes — provider (LLM API) failures.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const KosongErrors = {
  codes: {
    PROVIDER_API_ERROR: 'provider.api_error',
    PROVIDER_RATE_LIMIT: 'provider.rate_limit',
    PROVIDER_AUTH_ERROR: 'provider.auth_error',
    PROVIDER_CONNECTION_ERROR: 'provider.connection_error',
  },
  retryable: ['provider.rate_limit', 'provider.connection_error'],
  info: {
    'provider.rate_limit': {
      title: 'Provider rate limit',
      retryable: true,
      public: true,
      action: 'Retry after the provider rate limit resets.',
    },
    'provider.auth_error': {
      title: 'Provider authentication failed',
      retryable: false,
      public: true,
      action: 'Check provider credentials and authentication configuration.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(KosongErrors);
