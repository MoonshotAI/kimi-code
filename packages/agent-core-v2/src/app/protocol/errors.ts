/**
 * `protocol` domain error codes — LLM wire API failures raised while driving
 * a Model's `request(...)` through the protocol adapter registry.
 *
 * Registered at module load. Historical name `ChatProviderErrors` is retained
 * as a re-exported alias so existing call sites don't have to migrate.
 */

import { registerErrorDomain, type ErrorDomain } from '#/_base/errors';

export const ProtocolErrors = {
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

/** @deprecated Use `ProtocolErrors` — same codes, renamed with the domain. */
export const ChatProviderErrors = ProtocolErrors;

registerErrorDomain(ProtocolErrors);
