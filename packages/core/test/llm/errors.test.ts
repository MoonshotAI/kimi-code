import { APIError as RawAnthropicSDKAPIError } from '@anthropic-ai/sdk';
import { ApiError as RawGoogleGenAISDKApiError } from '@google/genai';
import {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';
import { describe, expect, it } from 'vitest';

import { classifyKimiQuotaError } from '#/llm/builtin/provider/kimi/errors';
import {
  kimiAnthropicProtocol,
  kimiOpenAIProtocol,
} from '#/llm/builtin/provider/kimi/protocol';
import { decodeError as convertAnthropicError } from '#/llm/builtin/protocol/anthropic/decode';
import { decodeError as convertGoogleGenAIError } from '#/llm/builtin/protocol/google-genai/decode';
import {
  convertOpenAIError,
  decodeError as decodeOpenAIError,
} from '#/llm/builtin/protocol/openai/decode';
import { createDecoder as createOpenAIResponsesDecoder } from '#/llm/builtin/protocol/openai-responses/decode';
import { isRetryableError } from '#/llm/policy/retry';
import type { LlmRemoteErrorMessage } from '#/llm/response';

describe('convertOpenAIError', () => {
  it('as an API consumer, I want abort errors converted to abort kind', () => {
    expect(convertOpenAIError(new DOMException('x', 'AbortError'))).toEqual({
      kind: 'abort',
      message: 'x',
      retryable: false,
    });
  });

  it('as an API consumer, I want error hooks to win and receive the raw error', () => {
    const custom = { kind: 'provider', message: 'custom', retryable: true } as const;
    const raw = new RawOpenAISDKAPIError(500, {}, 'server error', new Headers());
    let hookArg: unknown;
    const result = convertOpenAIError(raw, (error) => {
      hookArg = error;
      return custom;
    });
    expect(result).toBe(custom);
    expect(hookArg).toBe(raw);
  });

  it('as an API consumer, I want connection errors mapped to their kinds', () => {
    expect(
      convertOpenAIError(new RawOpenAISDKConnectionTimeoutError({ message: 'request timed out' })),
    ).toEqual({ kind: 'timeout', message: 'request timed out', retryable: true });
    expect(
      convertOpenAIError(new RawOpenAISDKConnectionError({ message: 'connection refused' })),
    ).toEqual({ kind: 'connection', message: 'connection refused', retryable: true });
  });

  it('as an API consumer, I want 429 mapped to rate_limit with retry-after and the backend message', () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { message: 'too many requests' },
      'SDK-composed fallback',
      new Headers({ 'retry-after': '3' }),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'rate_limit',
      message: 'too many requests',
      statusCode: 429,
      retryAfterMs: 3000,
      retryable: true,
    });
  });

  it('as an API consumer, I want insufficient_quota mapped to quota_exhausted with the backend message', () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { message: 'backend quota message', code: 'insufficient_quota' },
      'SDK-composed fallback',
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend quota message',
      statusCode: 429,
      retryable: false,
    });
  });

  it('as an API consumer, I want structured context codes classified before the HTTP fallback', () => {
    const raw = new RawOpenAISDKAPIError(
      400,
      { code: 'context_length_exceeded' },
      'SDK-composed fallback',
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'context_overflow',
      message: '',
      statusCode: 400,
      retryable: false,
    });
  });

  it('as an API consumer, I want context overflow messages mapped to context_overflow', () => {
    const raw = new RawOpenAISDKAPIError(
      400,
      { message: 'maximum context length exceeded' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'context_overflow',
      statusCode: 400,
      retryable: false,
    });
  });

  it('as an API consumer, I want remaining status errors mapped without inventing messages', () => {
    const cases = [
      {
        raw: new RawOpenAISDKAPIError(
          413,
          { message: 'request entity too large' },
          undefined,
          new Headers(),
        ),
        expected: {
          kind: 'request_too_large',
          message: 'request entity too large',
          statusCode: 413,
          retryable: false,
        },
      },
      {
        raw: new RawOpenAISDKAPIError(
          529,
          { message: 'overloaded' },
          'SDK-composed fallback',
          new Headers(),
        ),
        expected: {
          kind: 'overloaded',
          message: 'overloaded',
          statusCode: 529,
          retryable: true,
        },
      },
      {
        raw: new RawOpenAISDKAPIError(500, {}, 'SDK-composed fallback', new Headers()),
        expected: { kind: 'status', message: '', statusCode: 500, retryable: true },
      },
    ];
    for (const { raw, expected } of cases) {
      expect(convertOpenAIError(raw)).toMatchObject(expected);
    }
  });

  it('as an API consumer, I want backend messages preserved without cleanup or appended hints', () => {
    const message = '<title>reasoning_effort is unsupported</title>';
    const raw = new RawOpenAISDKAPIError(400, { message }, 'SDK-composed fallback', new Headers());
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'status',
      message,
      statusCode: 400,
      retryable: false,
    });
  });

  it('as an API consumer, I want numeric stream business codes used only for classification', () => {
    const invalid = decodeOpenAIError(
      new RawOpenAISDKAPIError(
        400,
        { message: 'unsupported image format', code: 'invalid_request_error' },
        'SDK-composed fallback',
        new Headers(),
      ),
      'stream',
    );
    expect(invalid).toMatchObject({
      kind: 'image_format',
      message: 'unsupported image format',
      retryable: false,
    });
    expect(invalid).not.toHaveProperty('statusCode');
    expect(isRetryableError(invalid)).toBe(false);

    const tooLarge = decodeOpenAIError(
      new RawOpenAISDKAPIError(
        413,
        { message: 'request too large', code: 'request_too_large' },
        'SDK-composed fallback',
        new Headers(),
      ),
      'stream',
    );
    expect(tooLarge).toMatchObject({
      kind: 'request_too_large',
      message: 'request too large',
      retryable: false,
    });
    expect(tooLarge).not.toHaveProperty('statusCode');
    expect(isRetryableError(tooLarge)).toBe(false);
  });

  it('as an API consumer, I want request-structure rejections mapped to request_structure', () => {
    const structural = [
      'messages.142: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01MWFhDRqdbB4nzCJNuWYiun',
      'messages: `tool_use` ids must be unique',
      'text content blocks must be non-empty',
      'Invalid request: text content is empty',
      'first message must use the `user` role',
      'roles must alternate',
      "tool_call_id 'call_abc123' is not found",
      "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
      "the message at position 3 with role 'assistant' must not be empty",
    ];
    for (const message of structural) {
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({
        kind: 'request_structure',
        statusCode: 400,
        retryable: false,
      });
    }
    const unprocessable = new RawOpenAISDKAPIError(
      422,
      { message: 'roles must alternate' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(unprocessable)).toMatchObject({
      kind: 'request_structure',
      statusCode: 422,
      retryable: false,
    });
    const unrelated = new RawOpenAISDKAPIError(
      400,
      { message: 'max_tokens must be positive' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(unrelated)).toMatchObject({
      kind: 'status',
      statusCode: 400,
      retryable: false,
    });
  });

  it('as an API consumer, I want 400 image-format rejections mapped to image_format', () => {
    const imageFormat = [
      'unsupported image format',
      'Could not process image',
      'The image data you provided does not represent a valid image',
      "messages.0.content.1.image.source.base64.media_type: Input should be 'image/jpeg'",
    ];
    for (const message of imageFormat) {
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({
        kind: 'image_format',
        statusCode: 400,
        retryable: false,
      });
    }
    const notFormat = [
      'too many images in request',
      'image input is disabled for this model',
      "messages.0.content.1.video.source.base64.media_type: Input should be 'video/mp4'",
    ];
    for (const message of notFormat) {
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({
        kind: 'status',
        statusCode: 400,
        retryable: false,
      });
    }
    const wrongStatus = new RawOpenAISDKAPIError(
      422,
      { message: 'unsupported image format' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(wrongStatus)).toMatchObject({
      kind: 'status',
      statusCode: 422,
      retryable: false,
    });
  });

  it('as an API consumer, I want bare APIError instances classified by message', () => {
    const raw = new RawOpenAISDKAPIError(
      undefined,
      undefined,
      'network connection failed',
      undefined,
    );
    expect(convertOpenAIError(raw)).toEqual({
      kind: 'connection',
      message: 'network connection failed',
      retryable: true,
    });
  });

  it('as an API consumer, I want OpenAIError wrapped as provider', () => {
    expect(convertOpenAIError(new RawOpenAISDKError('boom'))).toEqual({
      kind: 'provider',
      message: 'Error: boom',
      retryable: true,
    });
  });

  it('as an API consumer, I want generic Error instances classified by message', () => {
    expect(convertOpenAIError(new Error('deadline exceeded timeout'))).toEqual({
      kind: 'timeout',
      message: 'deadline exceeded timeout',
      retryable: true,
    });
    expect(convertOpenAIError(new Error('plain'))).toEqual({
      kind: 'provider',
      message: 'Error: plain',
      retryable: true,
    });
  });

  it('as an API consumer, I want non-error values wrapped as unknown', () => {
    expect(convertOpenAIError('nope')).toEqual({
      kind: 'unknown',
      message: 'nope',
      retryable: false,
    });
  });
});

describe('retry policy', () => {
  it.each([
    [400, true],
    [503, false],
  ])('uses retryable instead of HTTP status %i', (statusCode, retryable) => {
    const error: LlmRemoteErrorMessage = {
      kind: 'status',
      message: 'backend failure',
      statusCode,
      requestId: null,
      retryAfterMs: null,
      headers: null,
      retryable,
    };
    expect(isRetryableError(error)).toBe(retryable);
  });
});

describe('classifyKimiQuotaError', () => {
  it('as an API consumer, I want structured error codes classified with the backend message preserved', () => {
    const classified = classifyKimiQuotaError({
      status: 429,
      message: 'SDK-composed fallback',
      code: 'exceeded_current_quota_error',
      error: { message: 'backend quota message' },
      requestID: 'req-1',
      headers: new Headers({ 'retry-after': '5', 'x-trace-id': 'trace-1' }),
    });
    expect(classified).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend quota message',
      statusCode: 429,
      requestId: 'req-1',
      retryAfterMs: 5000,
    });
    expect(classified).toMatchObject({
      headers: { 'x-trace-id': 'trace-1' },
    });
  });

  it('as an Anthropic user, I want quota errors read from the nested response body', () => {
    const classified = classifyKimiQuotaError({
      status: 429,
      message: 'SDK-composed fallback',
      error: {
        type: 'exceeded_current_quota_error',
        error: { message: 'backend anthropic quota message' },
      },
      headers: new Headers(),
    });
    expect(classified).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend anthropic quota message',
      statusCode: 429,
    });
  });

  it('as an API consumer, I want classification to avoid relying on message wording', () => {
    expect(classifyKimiQuotaError({
      status: 429,
      message: 'insufficient balance',
      error: { message: 'insufficient balance' },
      headers: new Headers(),
    })).toBeUndefined();
  });

  it('as an API consumer, I want non-429 errors ignored even when they carry a quota code', () => {
    expect(classifyKimiQuotaError({
      status: 400,
      code: 'exceeded_current_quota_error',
      error: { message: 'backend quota message' },
    })).toBeUndefined();
  });
});

describe('streaming provider error conversion', () => {
  it('as an OpenAI user, I want diagnostics preserved for unknown stream business codes', () => {
    const converted = decodeOpenAIError(
      new RawOpenAISDKAPIError(
        429,
        { message: 'backend unknown stream failure', code: 'unlisted_business_error' },
        'SDK-composed fallback',
        new Headers({ 'retry-after': '7', 'x-request-id': 'req-openai-unknown' }),
      ),
      'stream',
    );
    expect(converted).toMatchObject({
      kind: 'rate_limit',
      message: 'backend unknown stream failure',
      requestId: 'req-openai-unknown',
      retryAfterMs: 7000,
    });
    expect(converted).not.toHaveProperty('statusCode');
  });

  it('as a Kimi user, I want stream classification to avoid restoring HTTP statuses', () => {
    const openAI = kimiOpenAIProtocol.decodeError(
      new RawOpenAISDKAPIError(
        429,
        { message: 'backend stream quota', code: 'exceeded_current_quota_error' },
        'SDK-composed fallback',
        new Headers({ 'retry-after': '5' }),
      ),
      'stream',
    );
    expect(openAI).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend stream quota',
      retryAfterMs: 5000,
    });
    expect(openAI).not.toHaveProperty('statusCode', expect.any(Number));

    const anthropic = kimiAnthropicProtocol.decodeError(
      new RawAnthropicSDKAPIError(
        429,
        {
          type: 'error',
          error: {
            type: 'exceeded_current_quota_error',
            message: 'backend anthropic stream quota',
          },
        },
        'SDK-composed fallback',
        new Headers(),
      ),
      'stream',
    );
    expect(anthropic).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend anthropic stream quota',
    });
    expect(anthropic).not.toHaveProperty('statusCode', expect.any(Number));
  });
});

describe('Anthropic error decoding', () => {
  it('as an API consumer, I want nested backend messages used while preserving real HTTP statuses', () => {
    const raw = new RawAnthropicSDKAPIError(
      503,
      { error: { type: 'overloaded_error', message: 'backend anthropic failure' } },
      'SDK-composed fallback',
      new Headers({ 'retry-after': '4' }),
    );
    expect(convertAnthropicError(raw)).toMatchObject({
      kind: 'overloaded',
      message: 'backend anthropic failure',
      statusCode: 503,
      retryAfterMs: 4000,
    });
  });

  it('as an API consumer, I want structured context codes classified without exposing a stream status', () => {
    const raw = new RawAnthropicSDKAPIError(
      400,
      { error: { type: 'context_length_exceeded' } },
      'SDK-composed fallback',
      new Headers(),
    );
    const converted = convertAnthropicError(raw, 'stream');
    expect(converted).toMatchObject({ kind: 'context_overflow', message: '' });
    expect(converted).toMatchObject({ statusCode: undefined });
    expect(isRetryableError(converted)).toBe(false);
  });

  it('as an API consumer, I want diagnostics preserved for unknown stream business codes', () => {
    const raw = new RawAnthropicSDKAPIError(
      429,
      { error: { type: 'unlisted_business_error', message: 'backend unknown failure' } },
      'SDK-composed fallback',
      new Headers({ 'retry-after': '2' }),
    );
    const converted = convertAnthropicError(raw, 'stream');
    expect(converted).toMatchObject({
      kind: 'rate_limit',
      message: 'backend unknown failure',
      retryAfterMs: 2000,
    });
    expect(converted).not.toHaveProperty('statusCode');
  });

  it('as an API consumer, I want missing backend messages left empty instead of falling back to SDK messages', () => {
    const raw = new RawAnthropicSDKAPIError(
      500,
      { error: { type: 'api_error' } },
      'SDK-composed fallback',
      new Headers(),
    );
    expect(convertAnthropicError(raw)).toMatchObject({ kind: 'status', message: '' });
  });
});

describe('Google error decoding', () => {
  it('as an API consumer, I want stream business 503 errors to remain retryable without an HTTP status', () => {
    const raw = new RawGoogleGenAISDKApiError({
      status: 503,
      message: `got status: UNAVAILABLE. ${JSON.stringify({
        error: { code: 503, message: 'backend google business 503', status: 'UNAVAILABLE' },
      })}`,
    });
    const converted = convertGoogleGenAIError(raw, 'stream');
    expect(converted).toMatchObject({
      kind: 'status',
      message: 'backend google business 503',
      retryable: true,
    });
    expect(converted).not.toHaveProperty('statusCode');
    expect(isRetryableError(converted)).toBe(true);
    expect(convertGoogleGenAIError(raw)).toMatchObject({
      kind: 'status',
      message: 'backend google business 503',
      statusCode: 503,
    });
  });
});

describe('OpenAI Responses stream errors', () => {
  function streamError(event: Record<string, unknown>): LlmRemoteErrorMessage {
    let failure: LlmRemoteErrorMessage | undefined;
    const decoder = createOpenAIResponsesDecoder({
      onDelta: () => {},
      onFinish: () => {},
      onMessageId: () => {},
      onUsage: () => {},
      onToolCallEnd: () => {},
      onError: (error) => {
        failure = error;
      },
    });
    decoder.push(event);
    if (failure === undefined) throw new Error('Expected a stream failure');
    return failure;
  }

  it.each([
    ['rate_limit_exceeded', 'rate_limit'],
    ['rate_limit_reached_error', 'rate_limit'],
    ['engine_overloaded_error', 'overloaded'],
    ['insufficient_quota', 'quota_exhausted'],
    ['exceeded_current_quota_error', 'quota_exhausted'],
    ['context_length_exceeded', 'context_overflow'],
  ] as const)('maps structured %s without an HTTP status', (code, kind) => {
    const failure = streamError({ type: 'error', code, message: 'backend responses failure' });
    expect(failure).toMatchObject({ kind, message: 'backend responses failure' });
    expect(failure).not.toHaveProperty('statusCode');
  });

  it('as an API consumer, I want business kinds and HTTP statuses left unmodified when only message text is available', () => {
    const failure = streamError({
      type: 'error',
      code: null,
      message: 'upstream status_code: 429',
    });
    expect(failure).toMatchObject({
      kind: 'status',
      message: 'upstream status_code: 429',
      retryable: true,
    });
    expect(failure).not.toHaveProperty('statusCode');
  });

  it('as an API consumer, I want only known gateway payloads unwrapped without dropping ordinary prose', () => {
    const nested = { code: 'context_length_exceeded', message: 'field invalid' };
    for (const payload of [
      `received error while streaming: ${JSON.stringify(nested)}`,
      JSON.stringify(nested),
    ]) {
      expect(streamError({ message: payload })).toMatchObject({
        kind: 'context_overflow',
        message: 'field invalid',
      });
    }
    const prose = `schema rejected: ${JSON.stringify(nested)}`;
    expect(streamError({ message: prose })).toMatchObject({
      kind: 'status',
      message: prose,
      retryable: true,
    });
  });

  it('as a Responses API user, I want only the response.failed backend error message used', () => {
    const failure = streamError({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: { code: 'engine_overloaded_error', message: 'backend response failure' },
      },
    });
    expect(failure).toMatchObject({ kind: 'overloaded', message: 'backend response failure' });
    expect(failure).not.toHaveProperty('statusCode');
  });

  it('as a Responses API user, I want missing response.failed messages kept empty', () => {
    expect(streamError({ type: 'response.failed', response: { status: 'failed' } })).toEqual({
      kind: 'provider',
      message: '',
      retryable: true,
    });
  });
});
