import Anthropic, { APIError as RawAnthropicSDKAPIError } from '@anthropic-ai/sdk';
import { ApiError as RawGoogleGenAISDKApiError } from '@google/genai';
import OpenAI, {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import type { LlmRemoteErrorMessage } from '#/llm/errors';
import { createAssistantMessage, createUserMessage, type Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { classifyKimiQuotaError } from '#/llm-kimi/errors';
import { kimiConnection, kimiOpenAITrait } from '#/llm-kimi/trait';
import { convertAnthropicError } from '#/llm/requester/bases/anthropic/format';
import { createAnthropicRequester } from '#/llm/requester/bases/anthropic/requester';
import { convertGoogleGenAIError } from '#/llm/requester/bases/google-genai/format';
import { createGoogleGenAIRequester } from '#/llm/requester/bases/google-genai/requester';
import { convertOpenAIError } from '#/llm/requester/bases/openai/format';
import { createOpenAIResponsesFormat } from '#/llm/requester/bases/openai-responses/format';
import { createOpenAIResponsesRequester } from '#/llm/requester/bases/openai-responses/requester';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import { isRetryableError } from '#/llm/requester/retry';
import type { LlmRequester, LlmRequestEvent } from '#/llm/requester/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const messages: readonly Message[] = [createUserMessage('hi')];

describe('convertOpenAIError', () => {
  it('converts abort errors to abort kind', () => {
    expect(convertOpenAIError(new DOMException('x', 'AbortError'))).toEqual({
      kind: 'abort',
      message: 'x',
    });
  });

  it('lets the hook win and hands it the raw error', () => {
    const custom = { kind: 'provider', message: 'custom' } as const;
    const raw = new RawOpenAISDKAPIError(500, {}, 'server error', new Headers());
    let hookArg: unknown;
    const result = convertOpenAIError(raw, (error) => {
      hookArg = error;
      return custom;
    });
    expect(result).toBe(custom);
    expect(hookArg).toBe(raw);
  });

  it('maps connection errors to their kinds', () => {
    expect(
      convertOpenAIError(new RawOpenAISDKConnectionTimeoutError({ message: 'request timed out' })),
    ).toEqual({ kind: 'timeout', message: 'request timed out' });
    expect(
      convertOpenAIError(new RawOpenAISDKConnectionError({ message: 'connection refused' })),
    ).toEqual({ kind: 'connection', message: 'connection refused' });
  });

  it('maps 429 to rate_limit with retry-after and the raw backend message', () => {
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
    });
  });

  it('maps insufficient_quota to quota_exhausted with the raw backend message', () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { message: 'insufficient_quota' },
      'SDK-composed fallback',
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'quota_exhausted',
      message: 'insufficient_quota',
      statusCode: 429,
    });
  });

  it('maps context overflow messages to context_overflow', () => {
    const raw = new RawOpenAISDKAPIError(
      400,
      { message: 'maximum context length exceeded' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'context_overflow',
      message: 'maximum context length exceeded',
      statusCode: 400,
    });
  });

  it('maps remaining status errors to their kinds without inventing messages', () => {
    const tooLarge = new RawOpenAISDKAPIError(
      413,
      { message: 'request entity too large' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(tooLarge)).toMatchObject({
      kind: 'request_too_large',
      message: 'request entity too large',
      statusCode: 413,
    });
    const overloaded = new RawOpenAISDKAPIError(
      529,
      { message: 'overloaded' },
      'SDK-composed fallback',
      new Headers(),
    );
    expect(convertOpenAIError(overloaded)).toMatchObject({
      kind: 'overloaded',
      message: 'overloaded',
      statusCode: 529,
    });
    const generic = new RawOpenAISDKAPIError(500, {}, 'SDK-composed fallback', new Headers());
    expect(convertOpenAIError(generic)).toMatchObject({
      kind: 'status',
      message: '',
      statusCode: 500,
    });
  });

  it('preserves the backend message without HTML cleanup or thinking-effort hints', () => {
    const message = '<title>reasoning_effort is unsupported</title>';
    const raw = new RawOpenAISDKAPIError(
      400,
      { message },
      'SDK-composed fallback',
      new Headers(),
    );

    expect(convertOpenAIError(raw)).toMatchObject({ kind: 'status', message, statusCode: 400 });
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
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({ kind: 'request_structure', statusCode: 400 });
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
    });
    const unrelated = new RawOpenAISDKAPIError(
      400,
      { message: 'max_tokens must be positive' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(unrelated)).toMatchObject({ kind: 'status', statusCode: 400 });
  });

  it('maps 400 image-format rejections to image_format', () => {
    const imageFormat = [
      'unsupported image format',
      'Could not process image',
      'The image data you provided does not represent a valid image',
      "messages.0.content.1.image.source.base64.media_type: Input should be 'image/jpeg'",
    ];
    for (const message of imageFormat) {
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({ kind: 'image_format', statusCode: 400 });
    }
    const notFormat = [
      'too many images in request',
      'image input is disabled for this model',
      "messages.0.content.1.video.source.base64.media_type: Input should be 'video/mp4'",
    ];
    for (const message of notFormat) {
      const raw = new RawOpenAISDKAPIError(400, { message }, undefined, new Headers());
      expect(convertOpenAIError(raw)).toMatchObject({ kind: 'status', statusCode: 400 });
    }
    const wrongStatus = new RawOpenAISDKAPIError(
      422,
      { message: 'unsupported image format' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(wrongStatus)).toMatchObject({ kind: 'status', statusCode: 422 });
  });

  it('classifies a bare APIError by message', () => {
    const raw = new RawOpenAISDKAPIError(
      undefined,
      undefined,
      'network connection failed',
      undefined,
    );
    expect(convertOpenAIError(raw)).toEqual({
      kind: 'connection',
      message: 'network connection failed',
    });
  });

  it('uses an empty message for a status-less stream error without backend error.message', () => {
    const raw = new RawOpenAISDKAPIError(
      undefined,
      { code: 'server_error' },
      'SDK-composed fallback',
      new Headers(),
    );

    expect(convertOpenAIError(raw)).toEqual({ kind: 'provider', message: '' });
  });

  it('wraps an OpenAIError as provider', () => {
    expect(convertOpenAIError(new RawOpenAISDKError('boom'))).toEqual({
      kind: 'provider',
      message: 'Error: boom',
    });
  });

  it('classifies a generic Error by message', () => {
    expect(convertOpenAIError(new Error('deadline exceeded timeout'))).toEqual({
      kind: 'timeout',
      message: 'deadline exceeded timeout',
    });
    expect(convertOpenAIError(new Error('plain'))).toEqual({
      kind: 'provider',
      message: 'Error: plain',
    });
  });

  it('wraps non-error values as unknown', () => {
    expect(convertOpenAIError('nope')).toEqual({ kind: 'unknown', message: 'nope' });
  });
});

describe('classifyKimiQuotaError', () => {
  it('classifies by structured error code and uses the nested backend message', () => {
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
    if (classified?.kind === 'quota_exhausted') {
      expect(classified.headers?.['x-trace-id']).toBe('trace-1');
    }
  });

  it('classifies by message wording without changing the backend text', () => {
    const classified = classifyKimiQuotaError({
      status: 429,
      message: 'insufficient balance',
      error: { message: 'insufficient balance' },
      headers: new Headers(),
    });
    expect(classified).toMatchObject({
      kind: 'quota_exhausted',
      message: 'insufficient balance',
      statusCode: 429,
    });
  });

  it('ignores 429 without quota signals', () => {
    expect(
      classifyKimiQuotaError({ status: 429, message: 'slow down', headers: new Headers() }),
    ).toBeUndefined();
  });

  it('ignores non-429 errors', () => {
    expect(
      classifyKimiQuotaError({ status: 400, message: 'insufficient balance' }),
    ).toBeUndefined();
  });
});

describe('requester error conversion', () => {
  function failingOpenAIClient(error: unknown) {
    return () =>
      ({
        chat: {
          completions: {
            create: () => {
              throw error;
            },
          },
        },
      }) as never;
  }

  async function generateEvents(
    requester: LlmRequester,
    input: readonly Message[] = messages,
  ): Promise<readonly LlmRequestEvent[]> {
    const events: LlmRequestEvent[] = [];
    await requester.generate(
      { model },
      { messages: input },
      { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
    );
    return events;
  }

  it('converts a 429 response to rate_limit', async () => {
    const requester = createOpenAIRequester({
      clientFactory: failingOpenAIClient(
        new RawOpenAISDKAPIError(
          429,
          { message: 'too many requests' },
          'SDK-composed fallback',
          new Headers(),
        ),
      ),
    });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'rate_limit', message: 'too many requests' },
    });
  });

  it('converts a kimi quota response to quota_exhausted', async () => {
    const requester = createOpenAIRequester({
      connection: kimiConnection,
      trait: kimiOpenAITrait,
      classifyError: classifyKimiQuotaError,
      clientFactory: failingOpenAIClient(
        new RawOpenAISDKAPIError(
          429,
          { message: 'check your account balance' },
          'SDK-composed fallback',
          new Headers(),
        ),
      ),
    });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'quota_exhausted', message: 'check your account balance' },
    });
  });

  it('converts an OpenAI Responses thrown SSE error without inventing HTTP facts', async () => {
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: model.baseUrl,
      maxRetries: 0,
      fetch: async () =>
        new Response(
          'event: error\ndata: {"error":{"code":"rate_limit_exceeded","message":"backend responses stream failure"}}\n\n',
          {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'x-request-id': 'req-responses-stream',
              'retry-after': '2',
            },
          },
        ),
    });
    const requester = createOpenAIResponsesRequester({ clientFactory: () => client });

    const events = await generateEvents(requester);
    const failure = events.at(-1);

    expect(failure).toMatchObject({
      type: 'llm.failed.remote',
      error: {
        kind: 'rate_limit',
        message: 'backend responses stream failure',
        requestId: 'req-responses-stream',
        retryAfterMs: 2000,
      },
    });
    expect(failure).not.toHaveProperty('error.statusCode');
  });

  it('converts an Anthropic streaming error without inventing HTTP facts', async () => {
    const client = new Anthropic({
      apiKey: 'test-key',
      baseURL: model.baseUrl,
      maxRetries: 0,
      fetch: async () =>
        new Response(
          'event: error\ndata: {"type":"error","error":{"type":"rate_limit_error","message":"backend anthropic stream failure"}}\n\n',
          {
            status: 200,
            headers: {
              'content-type': 'text/event-stream',
              'request-id': 'req-anthropic-stream',
              'retry-after': '3',
            },
          },
        ),
    });
    const requester = createAnthropicRequester({ clientFactory: () => client });

    const events = await generateEvents(requester);
    const failure = events.at(-1);

    expect(failure).toMatchObject({
      type: 'llm.failed.remote',
      error: {
        kind: 'rate_limit',
        message: 'backend anthropic stream failure',
        requestId: 'req-anthropic-stream',
        retryAfterMs: 3000,
      },
    });
    expect(failure).not.toHaveProperty('error.statusCode');
  });

  it('distinguishes a Google stream business 429 from an initial HTTP 429', async () => {
    const raw = new RawGoogleGenAISDKApiError({
      status: 429,
      message: `got status: RESOURCE_EXHAUSTED. ${JSON.stringify({
        error: { code: 429, message: 'backend google business 429', status: 'RESOURCE_EXHAUSTED' },
      })}`,
    });
    const streamRequester = createGoogleGenAIRequester({
      clientFactory: () =>
        ({
          models: {
            generateContentStream: async () => ({
              async *[Symbol.asyncIterator]() {
                yield {};
                throw raw;
              },
            }),
          },
        }) as never,
    });
    const initialRequester = createGoogleGenAIRequester({
      clientFactory: () =>
        ({
          models: { generateContentStream: () => Promise.reject(raw) },
        }) as never,
    });

    const streamEvents = await generateEvents(streamRequester);
    const initialEvents = await generateEvents(initialRequester);
    const streamFailure = streamEvents.at(-1);

    expect(streamFailure).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'rate_limit', message: 'backend google business 429' },
    });
    expect(streamFailure).not.toHaveProperty('error.statusCode');
    expect(initialEvents.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: {
        kind: 'rate_limit',
        message: 'backend google business 429',
        statusCode: 429,
      },
    });
  });

  it('keeps a Google stream business 503 retryable without an HTTP status', () => {
    const raw = new RawGoogleGenAISDKApiError({
      status: 503,
      message: `got status: UNAVAILABLE. ${JSON.stringify({
        error: { code: 503, message: 'backend google business 503', status: 'UNAVAILABLE' },
      })}`,
    });
    const converted = convertGoogleGenAIError(raw, undefined, true);

    expect(converted).toMatchObject({
      kind: 'status',
      message: 'backend google business 503',
      retryable: true,
    });
    expect(converted).not.toHaveProperty('statusCode');
    expect(isRetryableError(converted)).toBe(true);
  });

  it('emits llm.failed.syntax for a local message syntax error without sending a request', async () => {
    const clientFactory = vi.fn(() => ({}) as never);
    const requester = createGoogleGenAIRequester({ clientFactory });
    const events = await generateEvents(requester, [
      createAssistantMessage([], [
        { type: 'function', id: 'call-1', name: 'some_tool', arguments: 'not json' },
      ]),
    ]);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.syntax',
      error: { kind: 'syntax', code: 'request_format' },
    });
    expect(clientFactory).not.toHaveBeenCalled();
  });
});

describe('OpenAI Responses stream errors', () => {
  function streamError(event: Record<string, unknown>): LlmRemoteErrorMessage {
    let failure: LlmRemoteErrorMessage | undefined;
    const parse = createOpenAIResponsesFormat().createStreamParser();
    parse(event, {
      onDelta: () => {},
      onFinish: () => {},
      onError: (error) => {
        failure = error;
      },
    });
    if (failure === undefined) throw new Error('Expected a stream failure');
    return failure;
  }

  it.each([
    { code: 'context_length_exceeded', kind: 'context_overflow', message: 'context too long' },
    { code: 'insufficient_quota', kind: 'quota_exhausted', message: 'quota exhausted' },
    { code: 'rate_limit_exceeded', kind: 'rate_limit', message: 'slow down' },
  ])('keeps $kind and the raw message without an HTTP status', ({ code, kind, message }) => {
    const error = streamError({ type: 'error', code, message, param: 'input' });

    expect(error).toEqual({
      kind,
      message,
      requestId: null,
      retryAfterMs: null,
      headers: null,
    });
    expect(error).not.toHaveProperty('statusCode');
  });

  it('uses a real response.failed event message without a prefix or synthetic HTTP status', () => {
    const error = streamError({
      type: 'response.failed',
      response: {
        status: 'failed',
        error: { code: 'rate_limit_exceeded', message: 'backend responses failure' },
      },
    });

    expect(error).toEqual({
      kind: 'rate_limit',
      message: 'backend responses failure',
      requestId: null,
      retryAfterMs: null,
      headers: null,
    });
    expect(error).not.toHaveProperty('statusCode');
  });

  it('uses an empty message when response.failed has no backend message', () => {
    for (const response of [
      { status: 'failed', error: { code: 'server_error' } },
      { status: 'failed', incomplete_details: { reason: 'max_output_tokens' } },
    ]) {
      expect(streamError({ type: 'response.failed', response })).toEqual({
        kind: 'provider',
        message: '',
      });
    }
    expect(streamError({ type: 'error', code: 'server_error' })).toEqual({
      kind: 'provider',
      message: '',
    });
  });

  it('extracts a genuinely nested gateway message without adding protocol text', () => {
    const error = streamError({
      message:
        'received error while streaming: {"code":"rate_limit_exceeded","message":"nested gateway failure","param":null}',
    });

    expect(error).toEqual({
      kind: 'rate_limit',
      message: 'nested gateway failure',
      requestId: null,
      retryAfterMs: null,
      headers: null,
    });
  });

  it('uses an empty nested gateway message when the field is missing', () => {
    const error = streamError({
      message: 'received error while streaming: {"code":"server_error"}',
    });

    expect(error).toEqual({ kind: 'provider', message: '' });
  });
});

describe('convertAnthropicError', () => {
  it('uses the nested backend error.message instead of the SDK-composed text', () => {
    const raw = new RawAnthropicSDKAPIError(
      503,
      { error: { type: 'api_error', message: 'backend anthropic failure' } },
      'SDK-composed fallback',
      new Headers(),
    );

    expect(convertAnthropicError(raw)).toMatchObject({
      kind: 'status',
      message: 'backend anthropic failure',
      statusCode: 503,
    });
  });

  it('uses an empty message when the backend body has no error.message', () => {
    const raw = new RawAnthropicSDKAPIError(
      400,
      { error: { type: 'invalid_request_error' } },
      'SDK-composed fallback',
      new Headers(),
    );

    expect(convertAnthropicError(raw)).toMatchObject({ kind: 'status', message: '', statusCode: 400 });
  });

  it('keeps status-less stream business semantics with an empty missing backend message', () => {
    const raw = new RawAnthropicSDKAPIError(
      undefined,
      { error: { type: 'overloaded_error' } },
      'SDK-composed fallback',
      undefined,
    );

    const converted = convertAnthropicError(raw);
    expect(converted).toEqual({
      kind: 'overloaded',
      message: '',
      requestId: null,
      retryAfterMs: null,
      headers: null,
    });
    expect(converted).not.toHaveProperty('statusCode');
  });
});

describe('convertGoogleGenAIError', () => {
  it('parses the backend message and RetryInfo from the same body', () => {
    const raw = new RawGoogleGenAISDKApiError({
      status: 429,
      message: JSON.stringify({
        error: {
          message: 'backend google failure',
          details: [
            {
              '@type': 'type.googleapis.com/google.rpc.RetryInfo',
              retryDelay: '1.25s',
            },
          ],
        },
      }),
    });

    expect(convertGoogleGenAIError(raw)).toMatchObject({
      kind: 'rate_limit',
      message: 'backend google failure',
      statusCode: 429,
      retryAfterMs: 1250,
    });
  });

  it('uses an empty message instead of serialized JSON or SDK fallback text', () => {
    const withoutMessage = new RawGoogleGenAISDKApiError({
      status: 503,
      message: JSON.stringify({ error: { details: [] } }),
    });
    const invalidBody = new RawGoogleGenAISDKApiError({
      status: 500,
      message: 'SDK-composed fallback',
    });

    expect(convertGoogleGenAIError(withoutMessage)).toMatchObject({
      kind: 'status',
      message: '',
      statusCode: 503,
    });
    expect(convertGoogleGenAIError(invalidBody)).toMatchObject({
      kind: 'status',
      message: '',
      statusCode: 500,
    });
  });
});
