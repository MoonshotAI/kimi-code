/**
 * `protocol` domain error codes — LLM wire API failures raised while driving
 * a Model's `request(...)` through the protocol adapter registry — plus
 * `translateProviderError`, the boundary translation that converts raw
 * `llmProtocol` provider errors into coded `Error2`s.
 *
 * Registered at module load. Historical name `ChatProviderErrors` is retained
 * as a re-exported alias so existing call sites don't have to migrate.
 */

import { CoreErrors, registerErrorDomain, type ErrorDomain } from '#/_base/errors/codes';
import { Error2, isError2 } from '#/_base/errors/errors';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '#/app/llmProtocol/errors';

export const ProtocolErrors = {
  codes: {
    PROVIDER_API_ERROR: 'provider.api_error',
    PROVIDER_FILTERED: 'provider.filtered',
    PROVIDER_RATE_LIMIT: 'provider.rate_limit',
    PROVIDER_AUTH_ERROR: 'provider.auth_error',
    PROVIDER_CONNECTION_ERROR: 'provider.connection_error',
    PROVIDER_OVERLOADED: 'provider.overloaded',
    CONTEXT_OVERFLOW: 'context.overflow',
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

export const ChatProviderErrors = ProtocolErrors;

registerErrorDomain(ProtocolErrors);

export function translateProviderError(error: unknown): Error2 {
  if (isError2(error)) {
    return error;
  }
  if (error instanceof APIStatusError) {
    const code =
      error instanceof APIContextOverflowError
        ? ProtocolErrors.codes.CONTEXT_OVERFLOW
        : error instanceof APIProviderOverloadedError || error.statusCode === 529
          ? ProtocolErrors.codes.PROVIDER_OVERLOADED
          : error.statusCode === 429
            ? ProtocolErrors.codes.PROVIDER_RATE_LIMIT
            : error.statusCode === 401 || error.statusCode === 403
              ? ProtocolErrors.codes.PROVIDER_AUTH_ERROR
              : ProtocolErrors.codes.PROVIDER_API_ERROR;
    return new Error2(code, sanitizeStatusErrorMessage(error.message), {
      name: error.name,
      cause: error,
      details: { statusCode: error.statusCode, requestId: error.requestId },
    });
  }
  if (error instanceof APIConnectionError || error instanceof APITimeoutError) {
    return new Error2(ProtocolErrors.codes.PROVIDER_CONNECTION_ERROR, error.message, {
      name: error.name,
      cause: error,
    });
  }
  if (error instanceof APIEmptyResponseError) {
    const code =
      error.finishReason === 'filtered'
        ? ProtocolErrors.codes.PROVIDER_FILTERED
        : ProtocolErrors.codes.PROVIDER_API_ERROR;
    return new Error2(code, error.message, {
      name: error.name,
      cause: error,
      details: {
        finishReason: error.finishReason,
        rawFinishReason: error.rawFinishReason,
      },
    });
  }
  if (error instanceof ChatProviderError) {
    return new Error2(ProtocolErrors.codes.PROVIDER_API_ERROR, error.message, {
      name: error.name,
      cause: error,
    });
  }
  if (error instanceof Error) {
    return new Error2(CoreErrors.codes.INTERNAL, error.message, {
      name: error.name,
      cause: error,
    });
  }
  return new Error2(CoreErrors.codes.INTERNAL, String(error), { cause: error });
}

export function sanitizeStatusErrorMessage(message: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(message);
  const extracted = titleMatch?.[1]?.trim();
  const normalized = extracted !== undefined && extracted.length > 0 ? extracted : message;
  return normalized.replaceAll('\r', '');
}
