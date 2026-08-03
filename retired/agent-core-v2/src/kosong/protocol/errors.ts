/**
 * `kosong/protocol` domain (L1) — wire API failure codes and the boundary
 * translation from raw contract errors to coded `Error2`s.
 *
 * `translateProviderError` converts the L0 `API*Error` family into coded
 * errors callers can branch on across the wire. Its FIRST guard is the
 * contract's `throwIfAbortError`: a user cancellation is thrown as the
 * standard abort DOMException and can never be misclassified as a retryable
 * provider failure. The guard throws rather than returns, by design.
 *
 * Side-effect module: importing registers the error domain.
 */

import { t } from '@moonshot-ai/kimi-i18n';
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
  throwIfAbortError,
} from '#/kosong/contract/errors';

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
      title: t('v2Errors.providerRateLimit'),
      retryable: true,
      public: true,
      action: t('v2Errors.providerRateLimitAction'),
    },
    'provider.filtered': {
      title: t('v2Errors.providerFiltered'),
      retryable: false,
      public: true,
      action: t('v2Errors.providerFilteredAction'),
    },
    'provider.auth_error': {
      title: t('v2Errors.providerAuthError'),
      retryable: false,
      public: true,
      action: t('v2Errors.providerAuthErrorAction'),
    },
    'provider.overloaded': {
      title: t('v2Errors.providerOverloaded'),
      retryable: true,
      public: true,
      action: t('v2Errors.providerOverloadedAction'),
    },
    'context.overflow': {
      title: t('v2Errors.contextOverflow'),
      retryable: true,
      public: true,
      action: t('v2Errors.contextOverflowAction'),
    },
  },
} satisfies ErrorDomain;

registerErrorDomain(ProtocolErrors);

export function translateProviderError(error: unknown): Error2 {
  // Abort guard FIRST: throws the standard abort DOMException for any abort
  // shape — a cancellation is never converted into (or returned as) a
  // retryable provider error.
  throwIfAbortError(error);
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
      details: {
        statusCode: error.statusCode,
        requestId: error.requestId,
        traceId: error.traceId,
      },
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

/**
 * Normalize a provider status-error message for display: when the body is an
 * HTML error page, keep only its `<title>` text; always strip carriage
 * returns so multi-line wire bodies render sanely in logs and UI.
 */
export function sanitizeStatusErrorMessage(message: string): string {
  const titleMatch = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(message);
  const extracted = titleMatch?.[1]?.trim();
  const normalized = extracted !== undefined && extracted.length > 0 ? extracted : message;
  return normalized.replaceAll('\r', '');
}
