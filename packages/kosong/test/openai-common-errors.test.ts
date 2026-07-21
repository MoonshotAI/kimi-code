import {
  APIConnectionError,
  APIContextOverflowError,
  APIProviderRateLimitError,
  APIStatusError,
  APITimeoutError,
  ChatProviderError,
  isRetryableGenerateError,
  normalizeAPIStatusError,
} from '#/errors';
import type { ContentPart } from '#/message';
import {
  convertContentPart,
  convertOpenAIError,
} from '#/providers/openai-common';
import { OpenAILegacyChatProvider, OpenAILegacyStreamedMessage } from '#/providers/openai-legacy';
import {
  APIError as OpenAIAPIError,
  APIConnectionError as OpenAIConnectionError,
  APIConnectionTimeoutError as OpenAITimeoutError,
  APIUserAbortError as OpenAIUserAbortError,
} from 'openai';
import { describe, it, expect } from 'vitest';
describe('OpenAI client creation', () => {
  it('does not inject max_retries into OpenAI client', () => {
    // The OpenAI constructor is called with apiKey and baseURL only —
    // we verify that the provider does not set max_retries.
    const provider = new OpenAILegacyChatProvider({
      model: 'gpt-4.1',
      apiKey: 'test-key',
      baseUrl: 'https://example.com/v1',
    });

    const client = (provider as any)._client as Record<string, unknown>;
    expect((client as unknown as Record<string, unknown>)['maxRetries']).not.toBe(0);
  });
});
describe('convertOpenAIError: base APIError mapping', () => {
  const cases: Array<{ message: string; expectedType: typeof ChatProviderError; id: string }> = [
    {
      message: 'Network connection lost.',
      expectedType: APIConnectionError,
      id: 'network_connection_lost',
    },
    { message: 'Connection error.', expectedType: APIConnectionError, id: 'connection_error' },
    { message: 'network error', expectedType: APIConnectionError, id: 'network_error' },
    { message: 'disconnected from server', expectedType: APIConnectionError, id: 'disconnected' },
    {
      message: 'connection reset by peer',
      expectedType: APIConnectionError,
      id: 'connection_reset_by_peer',
    },
    {
      message: 'connection closed unexpectedly',
      expectedType: APIConnectionError,
      id: 'connection_closed_unexpectedly',
    },
    { message: 'Request timed out.', expectedType: APITimeoutError, id: 'request_timed_out' },
    { message: 'timed out', expectedType: APITimeoutError, id: 'timed_out' },
    // Timeout must take priority over network when both patterns match.
    {
      message: 'connection timed out',
      expectedType: APITimeoutError,
      id: 'connection_timed_out_timeout_priority',
    },
    {
      message: 'Something completely unrelated',
      expectedType: ChatProviderError,
      id: 'unrelated_error',
    },
    {
      message: 'Internal server error',
      expectedType: ChatProviderError,
      id: 'internal_server_error',
    },
    // Bare "reset"/"closed" must NOT match — they are too broad
    {
      message: 'Your session has been reset',
      expectedType: ChatProviderError,
      id: 'bare_reset_no_match',
    },
    {
      message: 'Stream closed by server due to policy violation',
      expectedType: ChatProviderError,
      id: 'bare_closed_no_match',
    },
  ];

  for (const { message, expectedType, id } of cases) {
    it(`classifies "${id}": ${message}`, () => {
      // Base APIError with no status and no body (transport-layer failure)
      const err = new OpenAIAPIError(undefined, undefined, message, undefined);
      const result = convertOpenAIError(err);
      expect(result).toBeInstanceOf(expectedType);
    });
  }
});
describe('convertOpenAIError: existing provider errors', () => {
  it('preserves an existing ChatProviderError instance', () => {
    const err = new APIStatusError(401, 'Unauthorized', 'req-401');

    expect(convertOpenAIError(err)).toBe(err);
  });
});
describe('convertOpenAIError: context overflow', () => {
  it('normalizes context overflow status errors', () => {
    const err = new OpenAIAPIError(413, undefined, 'Context length exceeded', undefined);
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIContextOverflowError);
    expect((result as APIContextOverflowError).statusCode).toBe(413);
  });
});
describe('convertOpenAIError: provider rate limit', () => {
  it('normalizes HTTP 429 status errors to APIProviderRateLimitError', () => {
    const err = new OpenAIAPIError(429, undefined, 'Too many requests', new Headers());
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).statusCode).toBe(429);
  });

  it('reads an integer retry-after header (seconds) onto the rate-limit error', () => {
    const err = new OpenAIAPIError(
      429,
      undefined,
      'Too many requests',
      new Headers({ 'retry-after': '12' }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).retryAfterMs).toBe(12_000);
  });

  it('ignores a non-integer (HTTP-date) retry-after header, leaving retryAfterMs null', () => {
    const err = new OpenAIAPIError(
      429,
      undefined,
      'Too many requests',
      new Headers({ 'retry-after': 'Wed, 21 Oct 2026 07:28:00 GMT' }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIProviderRateLimitError);
    expect((result as APIProviderRateLimitError).retryAfterMs).toBeNull();
  });

  it('carries the x-trace-id response header onto the status error', () => {
    const err = new OpenAIAPIError(
      500,
      undefined,
      'Internal server error',
      new Headers({ 'x-trace-id': 'trace-err-500' }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).traceId).toBe('trace-err-500');
  });

  it('leaves traceId null when the error response has no x-trace-id header', () => {
    const err = new OpenAIAPIError(500, undefined, 'Internal server error', new Headers());
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).traceId).toBeNull();
  });

  it('leaves traceId null when the x-trace-id header is empty', () => {
    const err = new OpenAIAPIError(
      500,
      undefined,
      'Internal server error',
      new Headers({ 'x-trace-id': '' }),
    );
    const result = convertOpenAIError(err);
    expect(result).toBeInstanceOf(APIStatusError);
    expect((result as APIStatusError).traceId).toBeNull();
  });
});
describe('convertOpenAIError: subclass errors still match first', () => {
  it('APIConnectionError matches its own case', () => {
    const connErr = new OpenAIConnectionError({ message: 'Connection error.' });
    const result = convertOpenAIError(connErr);
    expect(result).toBeInstanceOf(APIConnectionError);
  });

  it('APIConnectionTimeoutError matches as timeout', () => {
    const timeoutErr = new OpenAITimeoutError({ message: 'Request timed out.' });
    const result = convertOpenAIError(timeoutErr);
    expect(result).toBeInstanceOf(APITimeoutError);
  });
});
describe('convertOpenAIError: APIError with body skips heuristic', () => {
  it('does not heuristically reclassify when error has a body', () => {
    // SSE error events carry a body — they must NOT be reclassified
    // even if the message contains network keywords.
    const err = new OpenAIAPIError(
      undefined,
      { error: { message: 'Connection limit exceeded', type: 'server_error' } },
      'Connection limit exceeded',
      undefined,
    );
    const result = convertOpenAIError(err);
    // Should NOT be APIConnectionError despite "Connection" in message
    expect(result.constructor).toBe(ChatProviderError);
  });
});
describe('convertOpenAIError: abort guard', () => {
  it('APIUserAbortError throws the standard abort DOMException instead of being classified', () => {
    // A user cancellation must never be converted into (or returned as) a
    // retryable provider error: the guard at the very front of the
    // classification chain throws the standard abort shape.
    const err = new OpenAIUserAbortError({ message: 'connection aborted by user' });
    const thrown = catchThrown(() => convertOpenAIError(err));
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(thrown)).toBe(false);
  });

  it('bare AbortError DOMException throws the standard abort DOMException', () => {
    const err = new DOMException('The operation was aborted.', 'AbortError');
    const thrown = catchThrown(() => convertOpenAIError(err));
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(thrown)).toBe(false);
  });

  it('bare Error named AbortError throws the standard abort DOMException', () => {
    const err = new Error('The operation was aborted.');
    err.name = 'AbortError';
    const thrown = catchThrown(() => convertOpenAIError(err));
    expect(thrown).toBeInstanceOf(DOMException);
    expect((thrown as DOMException).name).toBe('AbortError');
    expect(isRetryableGenerateError(thrown)).toBe(false);
  });
});

function catchThrown(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('Expected the function to throw');
}
describe('OpenAI streaming error propagation', () => {
  it('base APIError("Network connection lost.") during streaming becomes APIConnectionError', async () => {
    // Simulates: streaming for ~33 minutes, then SSE connection drops
    // and the SDK raises openai.APIError("Network connection lost.")
    async function* failingStream(): AsyncGenerator<never> {
      throw new OpenAIAPIError(undefined, undefined, 'Network connection lost.', undefined);
      // Make this an async generator (unreachable)
      yield undefined as never;
    }

    const msg = new OpenAILegacyStreamedMessage(
      failingStream() as AsyncIterable<never>,
      true,
      undefined,
    );

    await expect(async () => {
      for await (const _ of msg) {
        void _;
      }
    }).rejects.toThrow(APIConnectionError);

    // Verify the message is preserved
    await expect(async () => {
      async function* failingStream2(): AsyncGenerator<never> {
        throw new OpenAIAPIError(undefined, undefined, 'Network connection lost.', undefined);
        yield undefined as never;
      }
      const msg2 = new OpenAILegacyStreamedMessage(
        failingStream2() as AsyncIterable<never>,
        true,
        undefined,
      );
      for await (const _ of msg2) {
        void _;
      }
    }).rejects.toThrow(/Network connection lost/);
  });
});
describe('convertOpenAIError: raw transport-layer stream errors', () => {
  it('classifies undici TypeError("terminated") as a retryable APIConnectionError', () => {
    // Node v24 + undici raises a raw `TypeError: terminated` when an SSE
    // response stream is dropped mid-flight. It is NOT an OpenAI SDK error,
    // so it falls into the generic Error branch — but it is a transport-layer
    // connection failure and must be retryable like any dropped connection.
    const err = new TypeError('terminated');
    (err as { cause?: unknown }).cause = new Error('other side closed');

    const result = convertOpenAIError(err);

    expect(result).toBeInstanceOf(APIConnectionError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });

  it('still wraps an unrelated raw Error as a base ChatProviderError, now retryable via fallback', () => {
    // An unrelated raw Error is NOT an OpenAI SDK error and carries no usable
    // HTTP status, so convertOpenAIError wraps it as a base ChatProviderError
    // (constructor check guards that typing). The fallback safety net in
    // isRetryableGenerateError then treats such unclassified provider failures
    // as transient — retry beats failing the run on the first blip.
    const result = convertOpenAIError(new Error('something completely unrelated'));

    expect(result.constructor).toBe(ChatProviderError);
    expect(isRetryableGenerateError(result)).toBe(true);
  });
});
describe('OpenAI streaming: undici terminated mid-stream', () => {
  it('a stream that throws TypeError("terminated") rejects with retryable APIConnectionError', async () => {
    // Simulates the real-world failure: the SSE stream drops mid-flight and
    // undici raises a raw `TypeError: terminated` from inside the for-await
    // loop. The provider must surface a retryable APIConnectionError so the
    // loop retries instead of failing the turn outright.
    async function* terminatedStream(): AsyncGenerator<never> {
      throw new TypeError('terminated');
      yield undefined as never;
    }

    const msg = new OpenAILegacyStreamedMessage(
      terminatedStream() as AsyncIterable<never>,
      true,
      undefined,
    );

    let caught: unknown;
    try {
      for await (const _ of msg) {
        void _;
      }
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(APIConnectionError);
    expect(isRetryableGenerateError(caught)).toBe(true);
  });
});
describe('convertContentPart', () => {
  it('converts TextPart to OpenAI text content part', () => {
    expect(convertContentPart({ type: 'text', text: 'hi' })).toEqual({
      type: 'text',
      text: 'hi',
    });
  });

  it('returns null for ThinkPart (handled separately as reasoning_content)', () => {
    expect(convertContentPart({ type: 'think', think: 'reasoning' })).toBeNull();
  });

  it('converts ImageURLPart without id', () => {
    expect(
      convertContentPart({ type: 'image_url', imageUrl: { url: 'https://ex/img.png' } }),
    ).toEqual({ type: 'image_url', image_url: { url: 'https://ex/img.png' } });
  });

  it('converts ImageURLPart with id', () => {
    expect(
      convertContentPart({
        type: 'image_url',
        imageUrl: { url: 'https://ex/img.png', id: 'img-1' },
      }),
    ).toEqual({ type: 'image_url', image_url: { url: 'https://ex/img.png', id: 'img-1' } });
  });

  it('converts AudioURLPart without id', () => {
    expect(
      convertContentPart({ type: 'audio_url', audioUrl: { url: 'https://ex/a.mp3' } }),
    ).toEqual({ type: 'audio_url', audio_url: { url: 'https://ex/a.mp3' } });
  });

  it('converts AudioURLPart with id', () => {
    expect(
      convertContentPart({
        type: 'audio_url',
        audioUrl: { url: 'https://ex/a.mp3', id: 'a-1' },
      }),
    ).toEqual({ type: 'audio_url', audio_url: { url: 'https://ex/a.mp3', id: 'a-1' } });
  });

  it('converts VideoURLPart without id', () => {
    expect(
      convertContentPart({ type: 'video_url', videoUrl: { url: 'https://ex/v.mp4' } }),
    ).toEqual({ type: 'video_url', video_url: { url: 'https://ex/v.mp4' } });
  });

  it('converts VideoURLPart with id', () => {
    expect(
      convertContentPart({
        type: 'video_url',
        videoUrl: { url: 'https://ex/v.mp4', id: 'v-1' },
      }),
    ).toEqual({ type: 'video_url', video_url: { url: 'https://ex/v.mp4', id: 'v-1' } });
  });

  it('throws on unknown content part type', () => {
    // Force an invalid type to exercise the defensive branch.
    const bogus = { type: 'bogus', text: 'x' } as unknown as ContentPart;
    expect(() => convertContentPart(bogus)).toThrow(/Unknown content part type/);
  });
});
describe('normalizeAPIStatusError thinking effort guidance', () => {
  it('adds configuration guidance when a provider rejects reasoning_effort', () => {
    const error = normalizeAPIStatusError(400, 'Invalid reasoning_effort: xhigh');

    expect(error.message).toContain('Non-Kimi providers receive effort strings');
    expect(error.message).toContain(
      'https://moonshotai.github.io/kimi-code/en/configuration/config-files.html#thinking',
    );
  });
});
describe('convertOpenAIError: non-Error values', () => {
  it('wraps a plain string as ChatProviderError', () => {
    const result = convertOpenAIError('something went sideways');
    expect(result.constructor).toBe(ChatProviderError);
    expect(result.message).toContain('something went sideways');
  });

  it('wraps a plain Error as ChatProviderError', () => {
    const result = convertOpenAIError(new Error('plain error'));
    expect(result.constructor).toBe(ChatProviderError);
    expect(result.message).toContain('plain error');
  });
});
