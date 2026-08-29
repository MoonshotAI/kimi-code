import { CoreErrors, registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, isError2 } from '#/_base/errors/errors';
import {
  CONTEXT_OVERFLOW_ERROR_CODE,
  PROVIDER_API_ERROR_CODE,
  PROVIDER_AUTH_ERROR_CODE,
  PROVIDER_CONNECTION_ERROR_CODE,
  PROVIDER_FILTERED_ERROR_CODE,
  PROVIDER_OVERLOADED_ERROR_CODE,
  PROVIDER_RATE_LIMIT_ERROR_CODE,
  throwIfAbortError,
} from '#/kosong/contract/errors';

export { sanitizeStatusErrorMessage } from '#/kosong/contract/errors';

export const ProtocolErrors = {
  codes: {
    PROVIDER_API_ERROR: PROVIDER_API_ERROR_CODE,
    PROVIDER_FILTERED: PROVIDER_FILTERED_ERROR_CODE,
    PROVIDER_RATE_LIMIT: PROVIDER_RATE_LIMIT_ERROR_CODE,
    PROVIDER_AUTH_ERROR: PROVIDER_AUTH_ERROR_CODE,
    PROVIDER_CONNECTION_ERROR: PROVIDER_CONNECTION_ERROR_CODE,
    PROVIDER_OVERLOADED: PROVIDER_OVERLOADED_ERROR_CODE,
    CONTEXT_OVERFLOW: CONTEXT_OVERFLOW_ERROR_CODE,
  },
  retryable: [
    'provider.rate_limit',
    'provider.connection_error',
    'provider.overloaded',
    'context.overflow',
  ],
  info: {
    'provider.rate_limit': {
      title: 'Provider rate limit',
      retryable: true,
      public: true,
      action: 'Retry after the provider rate limit resets.',
    },
    'provider.filtered': {
      title: 'Provider filtered response',
      retryable: false,
      public: true,
      action: 'Revise the prompt or model configuration to avoid provider safety filtering.',
    },
    'provider.auth_error': {
      title: 'Provider authentication failed',
      retryable: false,
      public: true,
      action: 'Check provider credentials and authentication configuration.',
    },
    'provider.overloaded': {
      title: 'Provider overloaded',
      retryable: true,
      public: true,
      action: 'Retry after the provider recovers from overload.',
    },
    'context.overflow': {
      title: 'Context overflow',
      retryable: true,
      public: true,
      action: 'Compact the conversation or retry with fewer tokens.',
    },
  },
} as const satisfies ErrorDomain;

registerErrorDomain(ProtocolErrors);

export function translateProviderError(error: unknown): Error2 {
  throwIfAbortError(error);
  if (isError2(error)) {
    return error;
  }
  if (error instanceof Error) {
    return new Error2(CoreErrors.codes.INTERNAL, error.message, {
      name: error.name,
      cause: error,
    });
  }
  return new Error2(CoreErrors.codes.INTERNAL, String(error), { cause: error });
}
