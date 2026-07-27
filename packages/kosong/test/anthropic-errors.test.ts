import {
  APIConnectionError,
  APIContextOverflowError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isRetryableGenerateError,
} from '#/errors';
import { convertAnthropicError, AnthropicChatProvider } from '#/providers/anthropic';
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
  APIError as AnthropicAPIError,
  AnthropicError,
  APIUserAbortError as AnthropicUserAbortError,
  AuthenticationError as AnthropicAuthenticationError,
  RateLimitError as AnthropicRateLimitError,
} from '@anthropic-ai/sdk';
import { describe, it, expect, vi } from 'vitest';
describe('convertAnthropicError', () => {
  it('APIConnectionTimeoutError -> APITimeoutError (not misclassified as connection)', () => {
    const err = new AnthropicTimeoutError({ message: 'timed out' });
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APITimeoutError);
    // Must NOT be a plain APIConnectionError
    expect(result.constructor).toBe(APITimeoutError);
  });

  it('APIConnectionError -> APIConnectionError', () => {
    const err = new AnthropicConnectionError({ message: 'connection refused' });
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIConnectionError);
  });

  it('APIError with status -> APIStatusError', () => {
    const err = AnthropicAPIError.generate(
      502,
      { type: 'error', error: { type: 'api_error', message: 'bad gateway' } },
      'bad gateway',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(502);
  });

  it('context overflow APIError -> APIContextOverflowError', () => {
    const err = AnthropicAPIError.generate(
      422,
      {
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: 'prompt is too long: 210000 tokens exceeds the maximum',
        },
      },
      'prompt is too long: 210000 tokens exceeds the maximum',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIContextOverflowError);
    expect((result as APIContextOverflowError).statusCode).toBe(422);
  });

  it('AuthenticationError -> APIStatusError with 401', () => {
    const err = new AnthropicAuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid key' } },
      'invalid key',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(401);
  });

  it('RateLimitError -> APIProviderRateLimitError with 429', () => {
    const err = new AnthropicRateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
      'rate limited',
      new Headers(),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).statusCode).toBe(429);
  });

  it('reads an integer retry-after header (seconds) onto the rate-limit error', () => {
    const err = AnthropicAPIError.generate(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
      'rate limited',
      new Headers({ 'retry-after': '7' }),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).retryAfterMs).toBe(7_000);
  });

  it('ignores a non-integer (HTTP-date) retry-after header, leaving retryAfterMs null', () => {
    const err = AnthropicAPIError.generate(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'rate limited' } },
      'rate limited',
      new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).retryAfterMs).toBeNull();
  });

  it('generic AnthropicError -> ChatProviderError', () => {
    const err = new AnthropicError('something went wrong');
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(ChatProviderError);
    expect(result.message).toContain('something went wrong');
  });

  it('plain Error -> ChatProviderError', () => {
    const err = new Error('unexpected');
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(ChatProviderError);
    expect(result.message).toContain('unexpected');
  });

  it('non-Error value -> ChatProviderError', () => {
    const result = convertAnthropicError('string error');
    expect(result).toBeInstanceOf(ChatProviderError);
    expect(result.message).toContain('string error');
  });

  it('APIUserAbortError throws the standard abort DOMException instead of being classified', () => {
    // A user cancellation must never be converted into (or returned as) a
    // retryable provider error: the guard at the very front of the
    // classification chain throws the standard abort shape.
    const err = new AnthropicUserAbortError({ message: 'aborted by user' });
    let thrown: unknown;
    try {
      convertAnthropicError(err);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(thrown)).toBe(false);
  });

  it('bare AbortError DOMException throws the standard abort DOMException', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError');
    let thrown: unknown;
    try {
      convertAnthropicError(err);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(thrown)).toBe(false);
  });

  it('classifies undici TypeError("terminated") as a retryable APIConnectionError', () => {
    // Node v24 + undici raises a raw `TypeError: terminated` when an SSE
    // response stream is dropped mid-flight. It is NOT an Anthropic SDK error,
    // so it falls into the generic Error branch — but it is a transport-layer
    // connection failure and must be retryable like any dropped connection.
    const err = new TypeError('terminated');
    (err as { cause?: unknown }).cause = new Error('other side closed');

    const result = convertAnthropicError(err);

    expect(result).toBeInstanceOf(APIConnectionError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });

  it('still wraps an unrelated raw Error as a base ChatProviderError, now retryable via fallback', () => {
    // An unrelated raw Error is NOT an Anthropic SDK error and carries no
    // usable HTTP status, so convertAnthropicError wraps it as a base
    // ChatProviderError (constructor check guards that typing). The fallback
    // safety net in isRetryableGenerateError then treats such unclassified
    // provider failures as transient — retry beats failing the run on the
    // first blip.
    const result = convertAnthropicError(new Error('something completely unrelated'));

    expect(result.constructor).toBe(ChatProviderError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });
});
describe('non-stream error propagation', () => {
  function createNonStreamProvider(): AnthropicChatProvider {
    return new AnthropicChatProvider({
      model: 'k25',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: false,
    });
  }

  it('APIConnectionTimeoutError during generate is converted', async () => {
    const provider = createNonStreamProvider();
    const sdkError = new AnthropicTimeoutError({ message: 'stream timed out' });
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    await expect(
      provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      ),
    ).rejects.toThrow(APITimeoutError);
  });

  it('APIConnectionError during generate is converted', async () => {
    const provider = createNonStreamProvider();
    const sdkError = new AnthropicConnectionError({ message: 'connection reset' });
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    await expect(
      provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      ),
    ).rejects.toThrow(APIConnectionError);
  });

  it('APIError with status during generate is converted to APIStatusError', async () => {
    const provider = createNonStreamProvider();
    const sdkError = AnthropicAPIError.generate(
      500,
      { type: 'error', error: { type: 'api_error', message: 'internal error' } },
      'internal error',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    await expect(
      provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      ),
    ).rejects.toThrow(APIStatusError);
  });

  it('RateLimitError during generate is converted to APIProviderRateLimitError(429)', async () => {
    const provider = createNonStreamProvider();
    const sdkError = new AnthropicRateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } },
      'too many requests',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    try {
      await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(APIProviderRateLimitError);
      expect((error as APIProviderRateLimitError).statusCode).toBe(429);
    }
  });

  it('AuthenticationError during generate is converted to APIStatusError(401)', async () => {
    const provider = createNonStreamProvider();
    const sdkError = new AnthropicAuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid' } },
      'invalid',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi.fn().mockRejectedValue(sdkError);

    try {
      await provider.generate(
        '',
        [],
        [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
      );
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
    }
  });
});
describe('stream error propagation', () => {
  function createStreamProvider(): AnthropicChatProvider {
    return new AnthropicChatProvider({
      model: 'k25',
      apiKey: 'test-key',
      defaultMaxTokens: 1024,
      stream: true,
    });
  }

  function makeErrorStream(error: Error) {
    return {
      async *[Symbol.asyncIterator]() {
        yield {
          type: 'message_start',
          message: { id: 'msg_err', usage: { input_tokens: 0 } },
        };
        throw error;
      },
    };
  }

  it('APIConnectionTimeoutError during stream iteration is converted', async () => {
    const provider = createStreamProvider();
    const sdkError = new AnthropicTimeoutError({ message: 'stream timed out' });
    (provider as any)._client.messages.create = vi
      .fn()
      .mockResolvedValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    const parts: unknown[] = [];
    await expect(
      (async () => {
        for await (const part of result) {
          parts.push(part);
        }
      })(),
    ).rejects.toThrow(APITimeoutError);
  });

  it('APIConnectionError during stream iteration is converted', async () => {
    const provider = createStreamProvider();
    const sdkError = new AnthropicConnectionError({ message: 'connection reset' });
    (provider as any)._client.messages.create = vi
      .fn()
      .mockResolvedValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    await expect(
      (async () => {
        for await (const _ of result) {
          void _;
        }
      })(),
    ).rejects.toThrow(APIConnectionError);
  });

  it('APIError with status during stream iteration is converted to APIStatusError', async () => {
    const provider = createStreamProvider();
    const sdkError = AnthropicAPIError.generate(
      500,
      { type: 'error', error: { type: 'api_error', message: 'internal error' } },
      'internal error',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi
      .fn()
      .mockResolvedValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    await expect(
      (async () => {
        for await (const _ of result) {
          void _;
        }
      })(),
    ).rejects.toThrow(APIStatusError);
  });

  it('RateLimitError during stream iteration is converted to APIProviderRateLimitError(429)', async () => {
    const provider = createStreamProvider();
    const sdkError = new AnthropicRateLimitError(
      429,
      { type: 'error', error: { type: 'rate_limit_error', message: 'too many requests' } },
      'too many requests',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi
      .fn()
      .mockResolvedValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    try {
      for await (const _ of result) {
        void _;
      }
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(APIProviderRateLimitError);
      expect((error as APIProviderRateLimitError).statusCode).toBe(429);
    }
  });

  it('AuthenticationError during stream iteration is converted to APIStatusError(401)', async () => {
    const provider = createStreamProvider();
    const sdkError = new AnthropicAuthenticationError(
      401,
      { type: 'error', error: { type: 'authentication_error', message: 'invalid' } },
      'invalid',
      new Headers(),
    );
    (provider as any)._client.messages.create = vi
      .fn()
      .mockResolvedValue(makeErrorStream(sdkError)) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    try {
      for await (const _ of result) {
        void _;
      }
      expect.unreachable('Should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(APIStatusError);
      expect((error as APIStatusError).statusCode).toBe(401);
    }
  });

  it('undici TypeError("terminated") during stream iteration -> retryable APIConnectionError', async () => {
    // The real-world failure: the SSE stream drops mid-flight and undici raises
    // a raw `TypeError: terminated` from inside the for-await loop. The provider
    // must surface a retryable APIConnectionError so the loop retries instead of
    // failing the turn outright.
    const provider = createStreamProvider();
    (provider as any)._client.messages.create = vi
      .fn()
      .mockResolvedValue(makeErrorStream(new TypeError('terminated'))) as never;

    const result = await provider.generate(
      '',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'Hi' }], toolCalls: [] }],
    );
    let caught: unknown;
    try {
      for await (const _ of result) {
        void _;
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(APIConnectionError);
    expect(isRetryableGenerateError(caught)).toBe(true);
  });
});
