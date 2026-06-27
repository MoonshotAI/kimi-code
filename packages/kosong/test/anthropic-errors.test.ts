import {
  APIConnectionError,
  APIContextOverflowError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
} from '#/errors';
import { convertAnthropicError, AnthropicChatProvider } from '#/providers/anthropic';
import {
  APIConnectionError as AnthropicConnectionError,
  APIConnectionTimeoutError as AnthropicTimeoutError,
  APIError as AnthropicAPIError,
  AnthropicError,
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

  it('generic AnthropicError -> ChatProviderError', () => {
    const err = new AnthropicError('something went wrong');
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(ChatProviderError);
    expect(result.message).toContain('something went wrong');
  });

  it('AnthropicError "Engine Busy" → APIStatusError(503)', () => {
    const err = new AnthropicError(
      'Xunfei claude request failed with code: 10010, msg: RecvFromEngineError:Engine Busy',
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(503);
    expect(result.message).toContain('Engine Busy');
  });

  it('AnthropicError "overloaded" → APIStatusError(503)', () => {
    const err = new AnthropicError('server is overloaded, try again later');
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(503);
  });

  it('AnthropicError rate-limit message → APIStatusError(429)', () => {
    const err = new AnthropicError('rate limited: too many requests');
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(429);
  });

  it('AnthropicError "Xunfei request failed" → APIStatusError(503)', () => {
    const err = new AnthropicError(
      '{"error":{"message":"Xunfei claude request failed with Sid: abc123 code: 11210, msg: internal error"}}',
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).statusCode).toBe(503);
    expect(result.message).toContain('Xunfei claude request failed');
  });

  it('AnthropicError "Xunfei auth failure" → ChatProviderError', () => {
    const err = new AnthropicError(
      '{"error":{"message":"Xunfei claude request failed with code: 10001, msg: invalid api key. Also saw code: 11210 earlier"}}',
    );
    const result = convertAnthropicError(err);
    expect(result).toBeInstanceOf(ChatProviderError);
    expect(result).not.toBeInstanceOf(APIStatusError);
    expect(result.message).toContain('invalid api key');
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
});
