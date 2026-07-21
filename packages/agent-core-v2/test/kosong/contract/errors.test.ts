/**
 * `kosong/contract` errors — abort shape and error classification authority.
 *
 * Locks the behavior-fix intent of the kosong refactor: a user cancellation
 * surfaces as the standard abort DOMException from `createAbortError`, the
 * `throwIfAbortError` guard throws (never returns) and wins over every other
 * classification branch, and `isRetryableGenerateError` never retries aborts.
 */

import { describe, expect, it } from 'vitest';

import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  classifyApiError,
  createAbortError,
  isAbortError,
  isRetryableGenerateError,
  normalizeAPIStatusError,
  throwIfAbortError,
} from '#/kosong/contract/errors';

// Mirrors the OpenAI/Anthropic SDKs' abort class: the contract recognizes it
// structurally by constructor name, without importing any SDK.
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
    // A miniature stand-in for a provider error converter: the abort guard
    // runs first, then transport heuristics would classify by message.
    const convert = (error: unknown): ChatProviderError => {
      throwIfAbortError(error);
      return new APIConnectionError((error as Error).message);
    };

    // The abort message mentions a dropped connection — without the guard
    // first, this would be misclassified as a retryable connection error.
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
    // A 413 phrased as token overflow routes to compaction, not 4xx.
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
