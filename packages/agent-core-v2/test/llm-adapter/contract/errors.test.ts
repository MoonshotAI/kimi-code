import { describe, expect, it } from 'vitest';

import type { LlmErrorMessage } from '#human/llm/errors';
import { toKimiErrorPayload } from '#/errors';
import '#/llm-adapter/protocol/errors';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  classifyApiError,
  createAbortError,
  errorFromLlmMessage,
  isAbortError,
  isImageFormatError,
  isProviderRateLimitError,
  isRecoverableRequestStructureError,
  isRetryableGenerateError,
  isToolExchangeAdjacencyError,
  LlmError,
  normalizeAPIStatusError,
  throwIfAbortError,
} from '#/llm-adapter/contract/errors';

class APIUserAbortError extends Error {
  constructor(message = 'Request was aborted.') {
    super(message);
  }
}

describe('createAbortError', () => {
  it('returns the standard abort DOMException', () => {
    const error = createAbortError();
    expect(error).toBeInstanceOf(DOMException);
    expect(error.name).toBe('AbortError');
    expect(error.message).toBe('The operation was aborted.');
  });
});

describe('isAbortError', () => {
  it('recognizes the standard abort DOMException', () => {
    expect(isAbortError(createAbortError())).toBe(true);
  });

  it('recognizes a bare Error named AbortError', () => {
    const error = new Error('Aborted');
    error.name = 'AbortError';
    expect(isAbortError(error)).toBe(true);
  });

  it('recognizes an SDK APIUserAbortError by constructor name', () => {
    expect(isAbortError(new APIUserAbortError())).toBe(true);
  });

  it('rejects provider errors and plain values', () => {
    expect(isAbortError(new APIConnectionError('Connection error.'))).toBe(false);
    expect(isAbortError(new Error('boom'))).toBe(false);
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError('AbortError')).toBe(false);
  });
});

describe('throwIfAbortError', () => {
  it('throws the standard abort DOMException for every abort shape', () => {
    for (const abort of [
      createAbortError(),
      Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      new APIUserAbortError(),
    ]) {
      let caught: unknown;
      try {
        throwIfAbortError(abort);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(DOMException);
      expect((caught as DOMException).name).toBe('AbortError');
    }
  });

  it('does nothing for non-abort errors', () => {
    expect(() => throwIfAbortError(new APIConnectionError('Connection error.'))).not.toThrow();
    expect(() => throwIfAbortError(new Error('boom'))).not.toThrow();
  });

  it('wins at the front of a classification chain, even over network-looking messages', () => {
    const convert = (error: unknown): ChatProviderError => {
      throwIfAbortError(error);
      return new APIConnectionError((error as Error).message);
    };

    const abort = new APIUserAbortError('connection aborted by user');
    let caught: unknown;
    try {
      convert(abort);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(caught)).toBe(false);
  });
});

describe('isRetryableGenerateError', () => {
  it('never retries aborts', () => {
    expect(isRetryableGenerateError(createAbortError())).toBe(false);
    expect(isRetryableGenerateError(new APIUserAbortError())).toBe(false);
  });

  it('retries transient failures', () => {
    expect(isRetryableGenerateError(new APIConnectionError('Connection error.'))).toBe(true);
    expect(isRetryableGenerateError(new APITimeoutError('Request timed out.'))).toBe(true);
    expect(isRetryableGenerateError(new APIProviderRateLimitError('Too many requests'))).toBe(
      true,
    );
    expect(isRetryableGenerateError(new APIProviderOverloadedError(529, 'Overloaded'))).toBe(
      true,
    );
    expect(isRetryableGenerateError(new APIStatusError(503, 'Service unavailable'))).toBe(true);
  });

  it('does not retry deterministic client failures', () => {
    expect(isRetryableGenerateError(new APIStatusError(400, 'Bad request'))).toBe(false);
    expect(isRetryableGenerateError(new APIStatusError(401, 'Unauthorized'))).toBe(false);
  });

  it('does not retry provider-filtered empty responses', () => {
    expect(
      isRetryableGenerateError(new APIEmptyResponseError('filtered', { finishReason: 'filtered' })),
    ).toBe(false);
    expect(
      isRetryableGenerateError(new APIEmptyResponseError('empty', { finishReason: 'completed' })),
    ).toBe(true);
    expect(isRetryableGenerateError(new APIEmptyResponseError('empty'))).toBe(true);
  });
});

describe('classifyApiError', () => {
  it('classifies typed errors and carries the status code', () => {
    expect(classifyApiError(new APIContextOverflowError(400, 'context length exceeded'))).toEqual({
      kind: 'context_overflow',
      statusCode: 400,
    });
    expect(classifyApiError(new APIProviderRateLimitError('Too many requests'))).toEqual({
      kind: 'rate_limit',
      statusCode: 429,
    });
    expect(classifyApiError(new APIProviderQuotaExhaustedError('quota exhausted'))).toEqual({
      kind: 'quota_exhausted',
      statusCode: 429,
    });
    expect(classifyApiError(new APIProviderOverloadedError(529, 'Overloaded'))).toEqual({
      kind: 'overloaded',
      statusCode: 529,
    });
    expect(classifyApiError(new APIConnectionError('Connection error.'))).toEqual({
      kind: 'network',
      statusCode: undefined,
    });
    expect(classifyApiError(new APITimeoutError('Request timed out.'))).toEqual({
      kind: 'timeout',
      statusCode: undefined,
    });
    expect(classifyApiError(new APIEmptyResponseError('empty'))).toEqual({
      kind: 'empty_response',
      statusCode: undefined,
    });
  });

  it('classifies status errors by status code', () => {
    expect(classifyApiError(new APIStatusError(401, 'Unauthorized')).kind).toBe('auth');
    expect(classifyApiError(new APIStatusError(403, 'Forbidden')).kind).toBe('auth');
    expect(classifyApiError(new APIStatusError(500, 'Internal')).kind).toBe('5xx_server');
    expect(classifyApiError(new APIStatusError(422, 'Nope')).kind).toBe('4xx_client');
    expect(classifyApiError(new APIStatusError(413, 'Request exceeds the maximum size')).kind).toBe(
      '4xx_client',
    );
    expect(classifyApiError(normalizeAPIStatusError(413, 'context length exceeded')).kind).toBe(
      'context_overflow',
    );
  });

  it('falls back to other for unknown values', () => {
    expect(classifyApiError(new Error('boom')).kind).toBe('other');
    expect(classifyApiError('boom').kind).toBe('other');
  });
});

describe('LlmError', () => {
  type CanonicalLlmMessage = Exclude<LlmErrorMessage, LlmErrorMessage<'abort'>>;

  const statusInfo = {
    requestId: 'req-1',
    retryAfterMs: 1500,
    headers: { 'x-trace-id': 'trace-1' },
  } as const;
  const legacyEquivalents = [
    ['rate limit', { kind: 'rate_limit', message: 'slow down', statusCode: 429, ...statusInfo }],
    ['quota', { kind: 'quota_exhausted', message: 'quota exhausted', statusCode: 429, ...statusInfo }],
    ['overloaded', { kind: 'overloaded', message: 'overloaded', statusCode: 529, ...statusInfo }],
    [
      'context overflow',
      { kind: 'context_overflow', message: 'context length exceeded', statusCode: 400, ...statusInfo },
    ],
    [
      'request too large',
      { kind: 'request_too_large', message: 'request entity too large', statusCode: 413, ...statusInfo },
    ],
    [
      'request structure',
      {
        kind: 'request_structure',
        message: 'tool_use blocks must be followed by tool_result blocks',
        statusCode: 400,
        ...statusInfo,
      },
    ],
    [
      'image format',
      { kind: 'image_format', message: 'unsupported image format', statusCode: 400, ...statusInfo },
    ],
    ['status', { kind: 'status', message: 'service unavailable', statusCode: 503, ...statusInfo }],
    [
      'empty response',
      { kind: 'empty_response', message: 'empty', finishReason: 'completed', rawFinishReason: 'stop' },
    ],
    [
      'filtered empty response',
      { kind: 'empty_response', message: 'filtered', finishReason: 'filtered', rawFinishReason: 'content_filter' },
    ],
    ['connection', { kind: 'connection', message: 'connection failed' }],
    ['timeout', { kind: 'timeout', message: 'request timed out' }],
    ['syntax', { kind: 'syntax', message: 'bad request', code: 'request_format' }],
    ['provider', { kind: 'provider', message: 'provider failure' }],
    ['unknown', { kind: 'unknown', message: 'unknown failure' }],
  ] as const satisfies readonly (readonly [string, CanonicalLlmMessage])[];

  it.each(legacyEquivalents)('preserves the legacy %s payload and policies', (_label, message) => {
    const canonical = new LlmError(message);
    const legacy = errorFromLlmMessage(message);

    expect(canonical.llmError).toBe(message);
    expect(canonical.cause).toBeUndefined();
    expect(toKimiErrorPayload(canonical)).toEqual(toKimiErrorPayload(legacy));
    expect(isRetryableGenerateError(canonical)).toBe(isRetryableGenerateError(legacy));
    expect(isImageFormatError(canonical)).toBe(isImageFormatError(legacy));
    expect(isToolExchangeAdjacencyError(canonical)).toBe(isToolExchangeAdjacencyError(legacy));
    expect(isRecoverableRequestStructureError(canonical)).toBe(
      isRecoverableRequestStructureError(legacy),
    );
    expect(isProviderRateLimitError(canonical)).toBe(isProviderRateLimitError(legacy));
    expect(classifyApiError(canonical)).toEqual(classifyApiError(legacy));
  });

  it('preserves actual HTTP 429 metadata without capturing headers in details', () => {
    const message: CanonicalLlmMessage = {
      kind: 'rate_limit',
      message: 'too many requests',
      statusCode: 429,
      requestId: 'req-real-429',
      retryAfterMs: 2000,
      headers: { 'x-trace-id': 'trace-real-429', 'retry-after': '2' },
    };
    const error = new LlmError(message);

    expect(error).toMatchObject({
      code: 'provider.rate_limit',
      name: 'APIProviderRateLimitError',
      message: 'too many requests',
      statusCode: 429,
      requestId: 'req-real-429',
      retryAfterMs: 2000,
      traceId: 'trace-real-429',
      details: {
        statusCode: 429,
        requestId: 'req-real-429',
        traceId: 'trace-real-429',
      },
    });
    expect(error.cause).toBeUndefined();
    expect(error.details).not.toHaveProperty('headers');
    expect(error.details).not.toHaveProperty('retryAfterMs');
  });

  it('keeps stream business semantics without HTTP status details', () => {
    const messages: CanonicalLlmMessage[] = [
      {
        kind: 'rate_limit',
        message: 'stream rate limited',
        requestId: null,
        retryAfterMs: null,
        headers: null,
      },
      {
        kind: 'quota_exhausted',
        message: 'stream quota exhausted',
        requestId: null,
        retryAfterMs: null,
        headers: null,
      },
      {
        kind: 'context_overflow',
        message: 'stream context overflow',
        requestId: null,
        retryAfterMs: null,
        headers: null,
      },
    ];

    for (const message of messages) {
      const error = new LlmError(message);
      const legacyExportResult = errorFromLlmMessage(message);
      expect(error.kind).toBe(message.kind);
      expect(error.statusCode).toBeUndefined();
      expect(error.details).toBeUndefined();
      expect(error.cause).toBeUndefined();
      expect(toKimiErrorPayload(error).details).toBeUndefined();
      expect(toKimiErrorPayload(error)).not.toHaveProperty('details.statusCode');
      expect(legacyExportResult).toBeInstanceOf(LlmError);
      expect((legacyExportResult as LlmError).llmError).toBe(message);
      expect(isProviderRateLimitError(error)).toBe(message.kind === 'rate_limit');
    }
  });

  it('keeps a stream business 503 retryable without an HTTP status', () => {
    const error = new LlmError({
      kind: 'status',
      message: 'stream unavailable',
      requestId: null,
      retryAfterMs: null,
      headers: null,
      retryable: true,
    });

    expect(error.statusCode).toBeUndefined();
    expect(error.retryable).toBe(true);
    expect(isRetryableGenerateError(error)).toBe(true);
    expect(toKimiErrorPayload(error).details).toBeUndefined();
  });
});
