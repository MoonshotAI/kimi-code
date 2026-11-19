import { APIError as RawAnthropicSDKAPIError } from '@anthropic-ai/sdk';
import { ApiError as RawGoogleGenAISDKApiError } from '@google/genai';
import OpenAI, {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { classifyKimiQuotaError } from '#/llm/builtin/provider/kimi/errors';
import { kimiAnthropicProtocol, kimiOpenAIProtocol } from '#/llm/builtin/provider/kimi/protocol';
import { decodeError as convertAnthropicError } from '#/llm/builtin/protocol/anthropic/decode';
import { decodeError as convertGoogleGenAIError } from '#/llm/builtin/protocol/google-genai/decode';
import { convertOpenAIError, decodeError as decodeOpenAIError } from '#/llm/builtin/protocol/openai/decode';
import { createDecoder as createOpenAIResponsesDecoder } from '#/llm/builtin/protocol/openai-responses/decode';
import { googleGenAIProtocol } from '#/llm/builtin/protocol/google-genai/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { createAssistantMessage } from '#/llm/message';
import { createRequester } from '#/llm/requester';
import { isRetryableError, shouldRetry } from '#/llm/policy/retry';
import type { DecodeSink } from '#/llm/protocol/protocol';
import { llmStatusErrorMessage, type LlmRemoteErrorMessage } from '#/llm/response';

import { runGenerate, testModule } from './harness';

function openAIError(
  status: number | undefined,
  body: Record<string, unknown> | undefined,
  message = 'SDK fallback',
): RawOpenAISDKAPIError {
  return new RawOpenAISDKAPIError(status, body, message, new Headers());
}

function googleError(code: number, message: string): RawGoogleGenAISDKApiError {
  return new RawGoogleGenAISDKApiError({
    status: code,
    message: `got status: ${code}. ${JSON.stringify({ error: { code, message } })}`,
  });
}

function decodeResponses(chunk: Record<string, unknown>): LlmRemoteErrorMessage {
  const errors: LlmRemoteErrorMessage[] = [];
  const sink: DecodeSink = {
    onDelta: () => {},
    onFinish: () => {},
    onMessageId: () => {},
    onUsage: () => {},
    onError: (error) => errors.push(error),
    onToolCallEnd: () => {},
  };
  createOpenAIResponsesDecoder(sink).push(chunk);
  if (errors[0] === undefined) throw new Error('missing Responses error');
  return errors[0];
}

describe('OpenAI error conversion', () => {
  it('lets the hook win and hands it the raw error', () => {
    const custom = { kind: 'provider', message: 'custom', retryable: true } as const;
    const raw = openAIError(500, {}, 'server error');
    let hookArg: unknown;
    const result = convertOpenAIError(raw, (error) => {
      hookArg = error;
      return custom;
    });

    expect(result).toBe(custom);
    expect(hookArg).toBe(raw);
  });

  it('maps connection errors to their kinds', () => {
    expect(convertOpenAIError(new RawOpenAISDKConnectionTimeoutError({ message: 'request timed out' }))).toEqual({
      kind: 'timeout',
      message: 'request timed out',
      retryable: true,
    });
    expect(convertOpenAIError(new RawOpenAISDKConnectionError({ message: 'connection refused' }))).toEqual({
      kind: 'connection',
      message: 'connection refused',
      retryable: true,
    });
  });

  it('classifies a structured context code before the HTTP fallback', () => {
    expect(convertOpenAIError(openAIError(400, { code: 'context_length_exceeded' }))).toMatchObject({
      kind: 'context_overflow',
      message: '',
      statusCode: 400,
      retryable: false,
    });
  });

  it('maps context overflow messages to context_overflow', () => {
    expect(convertOpenAIError(openAIError(400, { message: 'maximum context length exceeded' }, undefined))).toMatchObject({
      kind: 'context_overflow',
      statusCode: 400,
      retryable: false,
    });
  });

  it('maps remaining status errors without inventing messages', () => {
    expect(convertOpenAIError(openAIError(413, { message: 'request entity too large' }, undefined))).toMatchObject({
      kind: 'request_too_large',
      message: 'request entity too large',
      statusCode: 413,
      retryable: false,
    });
    expect(convertOpenAIError(openAIError(529, { message: 'overloaded' }))).toMatchObject({
      kind: 'overloaded',
      message: 'overloaded',
      statusCode: 529,
      retryable: true,
    });
    expect(convertOpenAIError(openAIError(500, {}))).toMatchObject({
      kind: 'status',
      message: '',
      statusCode: 500,
      retryable: true,
    });
  });

  it('preserves the backend message without cleanup or appended hints', () => {
    const message = '<title>reasoning_effort is unsupported</title>';
    expect(convertOpenAIError(openAIError(400, { message }))).toMatchObject({
      kind: 'status',
      message,
      statusCode: 400,
      retryable: false,
    });
  });

  it('uses numeric stream business codes only for classification', () => {
    const invalid = decodeOpenAIError(openAIError(400, {
      message: 'unsupported image format',
      code: 'invalid_request_error',
    }), 'stream');
    expect(invalid).toMatchObject({ kind: 'image_format', message: 'unsupported image format', retryable: false });
    expect(llmStatusErrorMessage(invalid)?.statusCode).toBeUndefined();
    expect(isRetryableError(invalid)).toBe(false);

    const tooLarge = decodeOpenAIError(openAIError(413, {
      message: 'request too large',
      code: 'request_too_large',
    }), 'stream');
    expect(tooLarge).toMatchObject({ kind: 'request_too_large', message: 'request too large', retryable: false });
    expect(llmStatusErrorMessage(tooLarge)?.statusCode).toBeUndefined();
    expect(isRetryableError(tooLarge)).toBe(false);
  });

  it('maps 400 request-structure rejections to request_structure', () => {
    const structural = [
      'messages.142: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01MWFhDRqdbB4nzCJNuWYiun',
      'messages: `tool_use` ids must be unique',
      'text content blocks must be non-empty',
      'first message must use the `user` role',
      'roles must alternate',
      "tool_call_id 'call_abc123' is not found",
      "Messages with role 'tool' must be a response to a preceding message with 'tool_calls'",
      "the message at position 3 with role 'assistant' must not be empty",
    ];
    for (const message of structural) {
      expect(convertOpenAIError(openAIError(400, { message }, undefined))).toMatchObject({
        kind: 'request_structure',
        statusCode: 400,
        retryable: false,
      });
    }
    expect(convertOpenAIError(openAIError(422, { message: 'roles must alternate' }, undefined))).toMatchObject({
      kind: 'request_structure',
      statusCode: 422,
      retryable: false,
    });
    expect(convertOpenAIError(openAIError(400, { message: 'max_tokens must be positive' }, undefined))).toMatchObject({
      kind: 'status',
      statusCode: 400,
      retryable: false,
    });
  });

  it('maps 400 image-format rejections to image_format', () => {
    const imageFormat = [
      'unsupported image format',
      'Could not process image',
      'The image data you provided does not represent a valid image',
      "messages.0.content.1.image.source.base64.media_type: Input should be 'image/jpeg'",
    ];
    for (const message of imageFormat) {
      expect(convertOpenAIError(openAIError(400, { message }, undefined))).toMatchObject({
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
      expect(convertOpenAIError(openAIError(400, { message }, undefined))).toMatchObject({
        kind: 'status',
        statusCode: 400,
        retryable: false,
      });
    }
    expect(convertOpenAIError(openAIError(422, { message: 'unsupported image format' }, undefined))).toMatchObject({
      kind: 'status',
      statusCode: 422,
      retryable: false,
    });
  });

  it('classifies a bare APIError by message', () => {
    expect(convertOpenAIError(new RawOpenAISDKAPIError(undefined, undefined, 'network connection failed', undefined))).toEqual({
      kind: 'connection',
      message: 'network connection failed',
      retryable: true,
    });
  });

  it('wraps an OpenAIError as provider', () => {
    expect(convertOpenAIError(new RawOpenAISDKError('boom'))).toEqual({
      kind: 'provider',
      message: 'Error: boom',
      retryable: true,
    });
  });

  it('wraps non-error values as unknown', () => {
    expect(convertOpenAIError('nope')).toEqual({ kind: 'unknown', message: 'nope', retryable: false });
  });

  it('uses retryable instead of HTTP status', () => {
    const error: LlmRemoteErrorMessage = {
      kind: 'status',
      message: 'backend failure',
      statusCode: 400,
      requestId: null,
      retryAfterMs: null,
      headers: null,
      retryable: true,
    };
    expect(shouldRetry({ maxAttemptsPerStep: 2 }, 1, error)).toBe(true);
    expect(shouldRetry({ maxAttemptsPerStep: 2 }, 1, { ...error, statusCode: 503, retryable: false })).toBe(false);
  });
});

describe('Kimi quota classification', () => {
  it('descends into the Anthropic quota error body', () => {
    expect(classifyKimiQuotaError({
      status: 429,
      error: {
        type: 'exceeded_current_quota_error',
        error: { message: 'backend anthropic quota message' },
      },
      headers: new Headers(),
    })).toMatchObject({
      kind: 'quota_exhausted',
      message: 'backend anthropic quota message',
      statusCode: 429,
    });
  });

  it('does not classify by message wording', () => {
    expect(classifyKimiQuotaError({
      status: 429,
      message: 'insufficient balance',
      error: { message: 'insufficient balance' },
      headers: new Headers(),
    })).toBeUndefined();
  });

  it('ignores non-429 errors even with a quota code', () => {
    expect(classifyKimiQuotaError({
      status: 400,
      code: 'exceeded_current_quota_error',
      error: { message: 'backend quota message' },
    })).toBeUndefined();
  });
});

describe('requester and stream error conversion', () => {
  it('preserves the backend message through the OpenAI HTTP error factory', async () => {
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: 'https://example.test/v1',
      maxRetries: 0,
      fetch: async () => new Response(JSON.stringify({
        error: { code: 'rate_limit_exceeded', message: 'backend HTTP failure' },
      }), {
        status: 429,
        headers: {
          'content-type': 'application/json',
          'x-request-id': 'req-openai-http',
          'retry-after': '2',
        },
      }),
    });
    const requester = createRequester().with({
      protocol: { base: openAIProtocol },
      endpoint: { clientFactory: () => client },
    });

    const outcome = await requester.generate({
      model: testModule().model,
      content: testModule().content,
      policy: { retry: { maxAttemptsPerStep: 1 } },
    }, { signal: new AbortController().signal });

    expect(outcome).toMatchObject({
      type: 'failed',
      error: {
        kind: 'rate_limit',
        message: 'backend HTTP failure',
        statusCode: 429,
        requestId: 'req-openai-http',
        retryAfterMs: 2000,
      },
    });
  });

  it('does not restore a stream status through the Kimi classification hook', () => {
    const raw = openAIError(429, {
      message: 'backend stream quota',
      code: 'exceeded_current_quota_error',
    });
    const result = kimiOpenAIProtocol.decodeError(raw, 'stream');
    expect(result).toMatchObject({ kind: 'quota_exhausted', message: 'backend stream quota' });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });

  it('does not restore a stream status through Kimi Anthropic classification', () => {
    const raw = new RawAnthropicSDKAPIError(429, {
      type: 'error',
      error: { type: 'exceeded_current_quota_error', message: 'backend anthropic stream quota' },
    }, 'SDK fallback', new Headers());
    const result = kimiAnthropicProtocol.decodeError(raw, 'stream');
    expect(result).toMatchObject({ kind: 'quota_exhausted', message: 'backend anthropic stream quota' });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });

  it('preserves diagnostics for an unknown OpenAI stream business code', () => {
    const raw = new RawOpenAISDKAPIError(429, {
      message: 'new stream business code',
      code: 'new_business_code',
    }, 'SDK fallback', new Headers({ 'x-request-id': 'req-stream-business' }));
    const result = decodeOpenAIError(raw, 'stream');
    expect(result).toMatchObject({
      kind: 'rate_limit',
      message: 'new stream business code',
      requestId: 'req-stream-business',
    });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });

  it('converts an Anthropic stream error without inventing HTTP facts', () => {
    const result = convertAnthropicError(new RawAnthropicSDKAPIError(503, {
      type: 'error',
      error: { type: 'overloaded_error', message: 'backend overloaded' },
    }, 'SDK fallback', new Headers()), 'stream');
    expect(result).toMatchObject({ kind: 'overloaded', message: 'backend overloaded', retryable: true });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });

  it('distinguishes a Google stream business 429 from an initial HTTP 429', () => {
    const initial = convertGoogleGenAIError(googleError(429, 'slow down'));
    expect(initial).toMatchObject({ kind: 'rate_limit', statusCode: 429, retryable: true });
    const streamed = convertGoogleGenAIError(googleError(429, 'slow down'), 'stream');
    expect(streamed).toMatchObject({ kind: 'rate_limit', retryable: true });
    expect(llmStatusErrorMessage(streamed)?.statusCode).toBeUndefined();
  });

  it('keeps abort semantics for a Google stream iteration failure', async () => {
    const protocol = googleGenAIProtocol.with({
      sendStream: async () => ({
        body: (async function* () {
          yield {};
          throw new DOMException('cancelled', 'AbortError');
        })(),
      }),
    });
    const { outcome, events } = await runGenerate(protocol, { module: testModule() });

    expect(outcome).toMatchObject({ type: 'aborted' });
    expect(events.filter((event) => event.type === 'llm.ended')).toHaveLength(1);
    expect(events.some((event) => event.type === 'llm.ended' && event.outcome.type === 'done')).toBe(false);
  });

  it('emits a local syntax failure without sending a request', async () => {
    const clientFactory = vi.fn(() => null);
    const { outcome, events } = await runGenerate(googleGenAIProtocol, {
      module: testModule({
        messages: [createAssistantMessage([], [
          { type: 'function', id: 'call-1', name: 'some_tool', arguments: 'not json' },
        ])],
      }),
      endpoint: { clientFactory },
    });

    expect(outcome).toMatchObject({ type: 'failed', error: { kind: 'syntax', code: 'request_format' } });
    expect(events.at(-1)).toMatchObject({ type: 'llm.ended', outcome: { type: 'failed' } });
    expect(clientFactory).not.toHaveBeenCalled();
  });

  it('classifies a structured context code without exposing a stream status', () => {
    const result = convertAnthropicError(new RawAnthropicSDKAPIError(400, {
      type: 'error',
      error: { type: 'context_length_exceeded', message: 'context exceeded' },
    }, 'SDK fallback', new Headers()), 'stream');
    expect(result).toMatchObject({ kind: 'context_overflow', retryable: false });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });

  it('preserves diagnostics for an unknown Anthropic stream business code', () => {
    const result = convertAnthropicError(new RawAnthropicSDKAPIError(429, {
      type: 'error',
      error: { type: 'new_business_code', message: 'new Anthropic business code' },
    }, 'SDK fallback', new Headers({ 'request-id': 'req-anthropic-business' })), 'stream');
    expect(result).toMatchObject({
      kind: 'rate_limit',
      message: 'new Anthropic business code',
      requestId: 'req-anthropic-business',
    });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });

  it('does not fall back to the SDK message when the backend message is missing', () => {
    const result = convertAnthropicError(new RawAnthropicSDKAPIError(500, {
      type: 'error',
      error: { type: 'api_error' },
    }, 'SDK-composed fallback', new Headers()));
    expect(result).toMatchObject({ kind: 'status', message: '' });
  });

  it('keeps a Google stream business 503 retryable without an HTTP status', () => {
    const result = convertGoogleGenAIError(googleError(503, 'backend google business 503'), 'stream');
    expect(result).toMatchObject({ kind: 'status', retryable: true });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });
});

describe('OpenAI Responses stream errors', () => {
  it.each([
    ['rate_limit_exceeded', 'rate_limit'],
    ['rate_limit_reached_error', 'rate_limit'],
    ['engine_overloaded_error', 'overloaded'],
    ['insufficient_quota', 'quota_exhausted'],
    ['exceeded_current_quota_error', 'quota_exhausted'],
    ['context_length_exceeded', 'context_overflow'],
  ])('maps structured %s without an HTTP status', (code, kind) => {
    const result = decodeResponses({ type: 'error', code, message: 'backend failure' });
    expect(result).toMatchObject({ kind, message: 'backend failure' });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });

  it('does not infer a business kind or HTTP status from message text', () => {
    const result = decodeResponses({ type: 'error', code: null, message: '429' });
    expect(result).toMatchObject({ kind: 'status', message: '429' });
    expect(llmStatusErrorMessage(result)?.statusCode).toBeUndefined();
  });

  it('unwraps only known gateway payloads without dropping ordinary prose', () => {
    const nested = { code: 'context_length_exceeded', message: 'field invalid' };
    for (const payload of [
      `received error while streaming: ${JSON.stringify(nested)}`,
      JSON.stringify(nested),
    ]) {
      expect(decodeResponses({ message: payload })).toMatchObject({
        kind: 'context_overflow',
        message: 'field invalid',
      });
    }
    const prose = `schema rejected: ${JSON.stringify(nested)}`;
    expect(decodeResponses({ message: prose })).toMatchObject({
      kind: 'status',
      message: prose,
      retryable: true,
    });
  });

  it('uses only the response.failed backend error message', () => {
    const result = decodeResponses({
      type: 'response.failed',
      response: { error: { code: 'rate_limit_exceeded', message: 'backend failed message' } },
    });
    expect(result).toMatchObject({ kind: 'rate_limit', message: 'backend failed message' });
  });

  it('keeps a missing response.failed message empty', () => {
    const result = decodeResponses({ type: 'response.failed', response: {} });
    expect(result).toMatchObject({ kind: 'provider', message: '' });
  });

});
