/**
 * `kosong/protocol` errors — provider-error boundary translation.
 *
 * Locks the abort behavior fix: the `throwIfAbortError` guard runs FIRST in
 * `translateProviderError` and THROWS the standard abort DOMException for
 * every abort shape, so a user cancellation can never come back as a
 * retryable `provider.*` Error2. Also locks the status→code mapping, the
 * message sanitizer, and the domain's self-registration at import time.
 */

import { describe, expect, it } from 'vitest';

import { errorInfo, isErrorCode } from '#/_base/errors/codes';
import { Error2 } from '#/_base/errors/errors';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  createAbortError,
} from '#/kosong/contract/errors';
import {
  ProtocolErrors,
  sanitizeStatusErrorMessage,
  translateProviderError,
} from '#/kosong/protocol/errors';

// Mirrors the OpenAI/Anthropic SDKs' abort class: recognized structurally by
// constructor name, without importing any SDK.
class APIUserAbortError extends Error {
  constructor(message = 'Request was aborted.') {
    super(message);
  }
}

function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error;
  }
}

describe('ProtocolErrors domain', () => {
  it('registers its codes at import time', () => {
    for (const code of Object.values(ProtocolErrors.codes)) {
      expect(isErrorCode(code)).toBe(true);
    }
    expect(errorInfo('provider.rate_limit').retryable).toBe(true);
    expect(errorInfo('provider.filtered').title).toBe('Provider filtered response');
  });
});

describe('translateProviderError — abort guard', () => {
  it('throws the standard abort DOMException for every abort shape', () => {
    for (const abort of [
      createAbortError(),
      Object.assign(new Error('Aborted'), { name: 'AbortError' }),
      new APIUserAbortError(),
    ]) {
      const thrown = catchThrown(() => translateProviderError(abort));
      expect(thrown).toBeInstanceOf(DOMException);
      expect((thrown as DOMException).name).toBe('AbortError');
    }
  });

  it('never converts an abort into a retryable provider Error2', () => {
    const thrown = catchThrown(() => translateProviderError(new APIUserAbortError()));
    expect(thrown).not.toBeInstanceOf(Error2);
  });
});

describe('translateProviderError — classification', () => {
  it('passes an Error2 through unchanged', () => {
    const original = new Error2('provider.rate_limit', 'slow down');
    expect(translateProviderError(original)).toBe(original);
  });

  it('maps status errors to their codes and preserves wire details', () => {
    const cases: ReadonlyArray<[APIStatusError, string]> = [
      [new APIStatusError(429, 'too many requests'), 'provider.rate_limit'],
      [new APIStatusError(529, 'overloaded'), 'provider.overloaded'],
      [new APIProviderOverloadedError(503, 'overloaded'), 'provider.overloaded'],
      [new APIContextOverflowError(400, 'context length exceeded'), 'context.overflow'],
      [new APIStatusError(401, 'bad key'), 'provider.auth_error'],
      [new APIStatusError(403, 'forbidden'), 'provider.auth_error'],
      [new APIStatusError(500, 'boom'), 'provider.api_error'],
    ];
    for (const [error, code] of cases) {
      const translated = translateProviderError(error);
      expect(translated.code).toBe(code);
      expect(translated.cause).toBe(error);
      expect(translated.details?.['statusCode']).toBe(error.statusCode);
    }
  });

  it('keeps requestId and traceId in the details', () => {
    const translated = translateProviderError(
      new APIStatusError(429, 'too many requests', 'req-1', null, 'trace-1'),
    );
    expect(translated.details).toMatchObject({
      statusCode: 429,
      requestId: 'req-1',
      traceId: 'trace-1',
    });
  });

  it('maps connection and timeout errors to the connection code', () => {
    expect(translateProviderError(new APIConnectionError('down')).code).toBe(
      'provider.connection_error',
    );
    expect(translateProviderError(new APITimeoutError('slow')).code).toBe(
      'provider.connection_error',
    );
  });

  it('maps an empty filtered response to the filtered code', () => {
    const filtered = new APIEmptyResponseError('empty', {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
    const translated = translateProviderError(filtered);
    expect(translated.code).toBe('provider.filtered');
    expect(translated.details).toMatchObject({
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });

    const other = new APIEmptyResponseError('empty', { finishReason: 'completed' });
    expect(translateProviderError(other).code).toBe('provider.api_error');
  });

  it('maps a plain provider error to the generic api code', () => {
    expect(translateProviderError(new ChatProviderError('weird')).code).toBe('provider.api_error');
  });

  it('maps unknown errors and non-errors to internal', () => {
    expect(translateProviderError(new Error('boom')).code).toBe('internal');
    expect(translateProviderError('boom').code).toBe('internal');
    expect(translateProviderError('boom').message).toBe('boom');
  });
});

describe('sanitizeStatusErrorMessage', () => {
  it('extracts the title text from an HTML error page', () => {
    const html = '<html>\r\n<head><title>429 Too Many Requests</title></head>\r\n<body>...</body></html>';
    expect(sanitizeStatusErrorMessage(html)).toBe('429 Too Many Requests');
  });

  it('strips carriage returns from plain messages', () => {
    expect(sanitizeStatusErrorMessage('line one\r\nline two\r')).toBe('line one\nline two');
  });

  it('keeps the original message when the title is empty or absent', () => {
    expect(sanitizeStatusErrorMessage('<title>   </title>fallback')).toBe(
      '<title>   </title>fallback',
    );
    expect(sanitizeStatusErrorMessage('plain')).toBe('plain');
  });
});
