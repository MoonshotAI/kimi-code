import {
  APIConnectionError,
  APIEmptyResponseError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import { fromKimiErrorPayload, makeErrorPayload, toKimiErrorPayload } from '#/errors/serialize';

const NGINX_413_HTML =
  '413 <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n' +
  '<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n' +
  '<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

describe('toKimiErrorPayload — APIStatusError message sanitization', () => {
  it('extracts the <title> from an nginx 413 HTML body and strips CR', () => {
    const payload = toKimiErrorPayload(new APIStatusError(413, NGINX_413_HTML));
    expect(payload.code).toBe('provider.api_error');
    expect(payload.message).toBe('413 Request Entity Too Large');
    expect(payload.details).toMatchObject({ statusCode: 413 });
  });

  it('extracts the <title> from other nginx HTML error pages', () => {
    const html =
      '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n' +
      '<body><center><h1>502 Bad Gateway</h1></center></body></html>';
    const payload = toKimiErrorPayload(new APIStatusError(502, html));
    expect(payload.message).toBe('502 Bad Gateway');
  });

  it('leaves a plain-text message unchanged', () => {
    const payload = toKimiErrorPayload(new APIStatusError(500, 'Internal Server Error'));
    expect(payload.message).toBe('Internal Server Error');
  });

  it('strips carriage returns from a non-HTML message', () => {
    const payload = toKimiErrorPayload(new APIStatusError(500, 'line1\r\nline2\r'));
    expect(payload.message).toBe('line1\nline2');
  });

  it('falls back to the original message when the <title> is empty', () => {
    const html = '<html><head><title>   </title></head><body>x</body></html>';
    const payload = toKimiErrorPayload(new APIStatusError(500, html));
    expect(payload.message).toContain('<html>');
  });

  it('does not affect 429 / 401 code mapping, only the message', () => {
    const html = '<html><head><title>429 Too Many Requests</title></head></html>';
    expect(toKimiErrorPayload(new APIStatusError(429, html)).code).toBe('provider.rate_limit');
    expect(toKimiErrorPayload(new APIStatusError(401, 'Unauthorized')).code).toBe(
      'provider.auth_error',
    );
  });

  it('maps 403 to api_error (not auth_error, not rate_limit)', () => {
    const payload = toKimiErrorPayload(new APIStatusError(403, 'Forbidden'));
    expect(payload.code).toBe('provider.api_error');
    expect(payload.details).toMatchObject({ statusCode: 403 });
  });

  it('maps 503 to api_error', () => {
    const payload = toKimiErrorPayload(new APIStatusError(503, 'Service Unavailable'));
    expect(payload.code).toBe('provider.api_error');
    expect(payload.message).toBe('Service Unavailable');
  });

  it('handles APIStatusError with requestId in details', () => {
    const payload = toKimiErrorPayload(new APIStatusError(500, 'Internal Error', 'req-abc-123'));
    expect(payload.details).toMatchObject({ statusCode: 500, requestId: 'req-abc-123' });
  });

  it('handles an empty message body gracefully', () => {
    const payload = toKimiErrorPayload(new APIStatusError(502, ''));
    expect(payload.message).toBe('');
    expect(payload.code).toBe('provider.api_error');
  });

  it('handles a very long status message without crashing', () => {
    const longMsg = 'x'.repeat(10000);
    const payload = toKimiErrorPayload(new APIStatusError(500, longMsg));
    expect(payload.message).toBe(longMsg);
  });

  it('handles multi-line plain text messages', () => {
    const payload = toKimiErrorPayload(
      new APIStatusError(500, 'line 1\nline 2\nline 3'),
    );
    expect(payload.message).toBe('line 1\nline 2\nline 3');
  });
});

describe('toKimiErrorPayload — other kosong error types', () => {
  it('APIConnectionError maps to provider.connection_error', () => {
    const payload = toKimiErrorPayload(new APIConnectionError('connection refused'));
    expect(payload.code).toBe('provider.connection_error');
    expect(payload.message).toBe('connection refused');
    expect(payload.retryable).toBe(true);
  });

  it('APITimeoutError maps to provider.connection_error', () => {
    const payload = toKimiErrorPayload(new APITimeoutError('request timed out'));
    expect(payload.code).toBe('provider.connection_error');
    expect(payload.message).toBe('request timed out');
  });

  it('APIEmptyResponseError with no finish reason maps to api_error', () => {
    const payload = toKimiErrorPayload(new APIEmptyResponseError('empty response'));
    expect(payload.code).toBe('provider.api_error');
    expect(payload.details).toMatchObject({ finishReason: null, rawFinishReason: null });
  });

  it('APIEmptyResponseError with filtered finish reason maps to provider.filtered', () => {
    const payload = toKimiErrorPayload(
      new APIEmptyResponseError('content filtered', {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      }),
    );
    expect(payload.code).toBe('provider.filtered');
    expect(payload.details).toMatchObject({ finishReason: 'filtered', rawFinishReason: 'content_filter' });
  });

  it('ChatProviderError maps to provider.api_error', () => {
    const payload = toKimiErrorPayload(new ChatProviderError('generic provider error'));
    expect(payload.code).toBe('provider.api_error');
    expect(payload.message).toBe('generic provider error');
  });
});

describe('toKimiErrorPayload — non-API errors', () => {
  it('a plain Error maps to internal', () => {
    const payload = toKimiErrorPayload(new Error('something went wrong'));
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('something went wrong');
    expect(payload.name).toBe('Error');
  });

  it('a non-Error value maps to internal with String() representation', () => {
    const payload = toKimiErrorPayload('raw string error');
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('raw string error');
  });

  it('a null value maps to internal', () => {
    const payload = toKimiErrorPayload(null);
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('null');
  });

  it('an undefined value maps to internal', () => {
    const payload = toKimiErrorPayload(undefined);
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('undefined');
  });

  it('a number value maps to internal', () => {
    const payload = toKimiErrorPayload(42);
    expect(payload.code).toBe('internal');
    expect(payload.message).toBe('42');
  });
});

describe('makeErrorPayload', () => {
  it('builds a payload with the correct code and retryable from KIMI_ERROR_INFO', () => {
    const payload = makeErrorPayload('provider.rate_limit', 'Rate limited');
    expect(payload.code).toBe('provider.rate_limit');
    expect(payload.message).toBe('Rate limited');
    expect(payload.retryable).toBe(true);
  });

  it('accepts optional details and name', () => {
    const payload = makeErrorPayload('internal', 'test', {
      details: { foo: 'bar' },
      name: 'CustomError',
    });
    expect(payload.details).toEqual({ foo: 'bar' });
    expect(payload.name).toBe('CustomError');
  });
});

describe('fromKimiErrorPayload', () => {
  it('rehydrates a KimiErrorPayload back into a KimiError', () => {
    const payload = makeErrorPayload('provider.api_error', 'something broke', {
      details: { statusCode: 500 },
    });
    const error = fromKimiErrorPayload(payload);
    expect(error.code).toBe('provider.api_error');
    expect(error.message).toBe('something broke');
    expect(error.details).toEqual({ statusCode: 500 });
  });
});