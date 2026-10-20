import { describe, expect, it } from 'vitest';

import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  classifyApiError,
  createAbortError,
  isAbortError,
  isRetryableGenerateError,
  isUnsupportedMediaError,
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

  it('leaves media rejections to the projection ladder', () => {
    expect(
      isRetryableGenerateError(new ChatProviderError('unsupported media type for base64 image')),
    ).toBe(false);
    expect(
      isRetryableGenerateError(
        new ChatProviderError('Unsupported media type for base64 video: video/avi'),
      ),
    ).toBe(false);
    expect(isRetryableGenerateError(new ChatProviderError('some other problem'))).toBe(true);
  });
});

describe('isUnsupportedMediaError', () => {
  it('matches the free-tokens gateway rejection of an inline video tool result', () => {
    const reporter = new APIStatusError(
      400,
      'messages.56.content.0.tool_result.content: Field required',
    );
    expect(isUnsupportedMediaError(reporter)).toBe(true);
  });

  it('matches common video-unsupported wordings on 400 and 422', () => {
    const wordings = [
      'Unsupported media type for base64 video: video/x-ms-wmv',
      'Invalid data URL for video: data:video/avi;base64,AAAA',
      'video not supported by this model',
    ];
    for (const message of wordings) {
      expect(isUnsupportedMediaError(new APIStatusError(400, message))).toBe(true);
      expect(isUnsupportedMediaError(new APIStatusError(422, message))).toBe(true);
    }
  });

  it('does not match field-required errors on other fields', () => {
    const others = [
      'messages.1.content.0.tool_use.input: Field required',
      'messages.0.content.0.text: Field required',
    ];
    for (const message of others) {
      expect(isUnsupportedMediaError(new APIStatusError(400, message))).toBe(false);
    }
  });

  it('does not match on non-400/422 statuses', () => {
    const message = 'messages.56.content.0.tool_result.content: Field required';
    expect(isUnsupportedMediaError(new APIStatusError(429, message))).toBe(false);
    expect(isUnsupportedMediaError(new APIStatusError(500, message))).toBe(false);
  });

  it('excludes overflow and too-large subclasses even with a matching message', () => {
    const message = 'messages.56.content.0.tool_result.content: Field required';
    expect(isUnsupportedMediaError(new APIContextOverflowError(400, message))).toBe(false);
    expect(isUnsupportedMediaError(new APIRequestTooLargeError(413, message))).toBe(false);
  });

  it('matches provider-side video format errors and ignores plain errors', () => {
    expect(
      isUnsupportedMediaError(
        new ChatProviderError('Unsupported media type for base64 video: video/avi'),
      ),
    ).toBe(true);
    expect(isUnsupportedMediaError(new ChatProviderError('Invalid data URL for video: x'))).toBe(
      true,
    );
    expect(isUnsupportedMediaError(new ChatProviderError('some other problem'))).toBe(false);
    expect(isUnsupportedMediaError(new Error('video not supported'))).toBe(false);
    expect(isUnsupportedMediaError('video not supported')).toBe(false);
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
