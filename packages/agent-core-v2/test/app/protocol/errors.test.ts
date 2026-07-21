import { describe, expect, it } from 'vitest';

import { Error2 } from '#/_base/errors/errors';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderOverloadedError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '#/kosong/contract/errors';
import { translateProviderError } from '#/kosong/protocol/errors';

const NGINX_413_HTML =
  '413 <html>\r\n<head><title>413 Request Entity Too Large</title></head>\r\n' +
  '<body>\r\n<center><h1>413 Request Entity Too Large</h1></center>\r\n' +
  '<hr><center>nginx</center>\r\n</body>\r\n</html>\r\n';

describe('translateProviderError', () => {
  it('passes a Error2 through untouched (idempotent)', () => {
    const coded = new Error2('auth.login_required', 'login required');
    expect(translateProviderError(coded)).toBe(coded);
  });

  it('maps 429 to provider.rate_limit, keeping the raw error as cause and status in details', () => {
    const raw = new APIStatusError(429, 'Too Many Requests', 'req-1');
    const error = translateProviderError(raw);
    expect(error).toBeInstanceOf(Error2);
    expect(error.code).toBe('provider.rate_limit');
    expect(error.cause).toBe(raw);
    expect(error.name).toBe('APIStatusError');
    expect(error.details).toMatchObject({ statusCode: 429, requestId: 'req-1' });
  });

  it('maps 401 / 403 to provider.auth_error', () => {
    expect(translateProviderError(new APIStatusError(401, 'Unauthorized')).code).toBe(
      'provider.auth_error',
    );
    expect(translateProviderError(new APIStatusError(403, 'Forbidden')).code).toBe(
      'provider.auth_error',
    );
  });

  it('maps other status codes to provider.api_error', () => {
    expect(translateProviderError(new APIStatusError(500, 'oops')).code).toBe('provider.api_error');
  });

  it('maps context-overflow status errors to context.overflow', () => {
    const error = translateProviderError(new APIContextOverflowError(400, 'context length exceeded'));
    expect(error.code).toBe('context.overflow');
  });

  it('maps provider-overload errors to provider.overloaded, keeping HTTP details', () => {
    const raw = new APIProviderOverloadedError(529, 'Overloaded', 'req-overload');
    const error = translateProviderError(raw);
    expect(error.code).toBe('provider.overloaded');
    expect(error.cause).toBe(raw);
    expect(error.details).toMatchObject({ statusCode: 529, requestId: 'req-overload' });
  });

  it('maps a bare 529 status error to provider.overloaded', () => {
    const error = translateProviderError(new APIStatusError(529, 'Overloaded'));
    expect(error.code).toBe('provider.overloaded');
  });

  it('keeps a bare 503 status error on provider.api_error', () => {
    const error = translateProviderError(new APIStatusError(503, 'Service Unavailable'));
    expect(error.code).toBe('provider.api_error');
  });

  it('maps connection and timeout errors to provider.connection_error', () => {
    expect(translateProviderError(new APIConnectionError('reset')).code).toBe(
      'provider.connection_error',
    );
    expect(translateProviderError(new APITimeoutError('deadline')).code).toBe(
      'provider.connection_error',
    );
  });

  it('maps an empty filtered response to provider.filtered with finish reasons in details', () => {
    const error = translateProviderError(
      new APIEmptyResponseError('blocked', {
        finishReason: 'filtered',
        rawFinishReason: 'content_filter',
      }),
    );
    expect(error.code).toBe('provider.filtered');
    expect(error.details).toMatchObject({
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    });
  });

  it('maps other empty responses to provider.api_error', () => {
    expect(translateProviderError(new APIEmptyResponseError('empty')).code).toBe('provider.api_error');
  });

  it('maps a plain ChatProviderError to provider.api_error', () => {
    expect(translateProviderError(new ChatProviderError('bad')).code).toBe('provider.api_error');
  });

  it('maps an unknown Error to internal, preserving it as cause', () => {
    const raw = new Error('unexpected');
    const error = translateProviderError(raw);
    expect(error.code).toBe('internal');
    expect(error.cause).toBe(raw);
  });

  it('maps non-error throws to internal', () => {
    expect(translateProviderError('boom').code).toBe('internal');
    expect(translateProviderError(undefined).code).toBe('internal');
  });

  describe('message sanitization', () => {
    it('extracts the <title> from an nginx 413 HTML body and strips CR', () => {
      const error = translateProviderError(new APIStatusError(413, NGINX_413_HTML));
      expect(error.code).toBe('provider.api_error');
      expect(error.message).toBe('413 Request Entity Too Large');
      expect(error.details).toMatchObject({ statusCode: 413 });
    });

    it('extracts the <title> from other nginx HTML error pages', () => {
      const html =
        '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n' +
        '<body><center><h1>502 Bad Gateway</h1></center></body></html>';
      expect(translateProviderError(new APIStatusError(502, html)).message).toBe('502 Bad Gateway');
    });

    it('leaves a plain-text message unchanged', () => {
      expect(translateProviderError(new APIStatusError(500, 'Internal Server Error')).message).toBe(
        'Internal Server Error',
      );
    });

    it('strips carriage returns from a non-HTML message', () => {
      expect(translateProviderError(new APIStatusError(500, 'line1\r\nline2\r')).message).toBe(
        'line1\nline2',
      );
    });

    it('falls back to the original message when the <title> is empty', () => {
      const html = '<html><head><title>   </title></head><body>x</body></html>';
      expect(translateProviderError(new APIStatusError(500, html)).message).toContain('<html>');
    });

    it('does not affect 429 / 401 code mapping, only the message', () => {
      const html = '<html><head><title>429 Too Many Requests</title></head></html>';
      expect(translateProviderError(new APIStatusError(429, html)).code).toBe('provider.rate_limit');
      expect(translateProviderError(new APIStatusError(401, 'Unauthorized')).code).toBe(
        'provider.auth_error',
      );
    });
  });
});
