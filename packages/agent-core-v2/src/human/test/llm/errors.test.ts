import Anthropic, { APIError as RawAnthropicSDKAPIError } from '@anthropic-ai/sdk';
import { ApiError as RawGoogleGenAISDKApiError } from '@google/genai';
import OpenAI, {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm-requester/capability';
import { createAssistantMessage, createUserMessage, type Message } from '#/message';
import type { LlmModel } from '#/llm-requester/model';
import type { LlmRemoteErrorMessage } from '#/llm/response';
import { classifyKimiQuotaError } from '#/llm/builtin/provider/kimi/errors';
import { decodeError as convertAnthropicError } from '#/llm/builtin/protocol/anthropic/decode';
import { decodeError as convertGoogleGenAIError } from '#/llm/builtin/protocol/google-genai/decode';
import {
  convertOpenAIError,
  decodeError as decodeOpenAIError,
} from '#/llm/builtin/protocol/openai/decode';
import { createDecoder as createOpenAIResponsesDecoder } from '#/llm/builtin/protocol/openai-responses/decode';
import {
  createAnthropicRequester,
  createGoogleGenAIRequester,
  createKimiAnthropicRequester,
  createKimiOpenAIRequester,
  createOpenAIRequester,
  createOpenAIResponsesRequester,
  kimiEndpoint,
} from '#/llm-requester/factories';
import { isRetryableError } from '#/llm/policy/retry';
import type { LlmRequester, LlmRequestEvent } from '#/llm-requester/requester';

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

  it('maps 429 to rate_limit with retry-after and the backend message', () => {
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

  it('maps insufficient_quota to quota_exhausted with the backend message', () => {
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
    });
  });

  it('classifies a structured context code before the HTTP fallback', () => {
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
    });
  });

  it('maps context overflow messages to context_overflow', () => {
    const raw = new RawOpenAISDKAPIError(
      400,
      { message: 'maximum context length exceeded' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({ kind: 'context_overflow', statusCode: 400 });
  });

  it('maps remaining status errors without inventing messages', () => {
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

  it('preserves the backend message without cleanup or appended hints', () => {
    const message = '<title>reasoning_effort is unsupported</title>';
    const raw = new RawOpenAISDKAPIError(400, { message }, 'SDK-composed fallback', new Headers());
    expect(convertOpenAIError(raw)).toMatchObject({ kind: 'status', message, statusCode: 400 });
  });

  it('uses numeric stream business codes only for classification', () => {
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
      kind: 'status',
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
    expect(tooLarge).toMatchObject({ kind: 'request_too_large', message: 'request too large' });
    expect(tooLarge).not.toHaveProperty('statusCode');
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
  it('classifies by structured error code and uses the backend message', () => {
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

  it('descends into the Anthropic quota error body', () => {
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

  it('does not classify by message wording', () => {
    const classified = classifyKimiQuotaError({
      status: 429,
      message: 'insufficient balance',
      error: { message: 'insufficient balance' },
      headers: new Headers(),
    });
    expect(classified).toBeUndefined();
  });

  it('ignores non-429 errors even with a quota code', () => {
    expect(
      classifyKimiQuotaError({
        status: 400,
        code: 'exceeded_current_quota_error',
        error: { message: 'backend quota message' },
      }),
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

  it('converts a 429 response with the backend message', async () => {
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

  it('preserves the backend message through the OpenAI HTTP error factory', async () => {
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: model.baseUrl,
      maxRetries: 0,
      fetch: async () =>
        new Response(
          JSON.stringify({
            error: { code: 'rate_limit_exceeded', message: 'backend HTTP failure' },
          }),
          {
            status: 429,
            headers: {
              'content-type': 'application/json',
              'x-request-id': 'req-openai-http',
              'retry-after': '2',
            },
          },
        ),
    });
    const requester = createOpenAIRequester({ clientFactory: () => client });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: {
        kind: 'rate_limit',
        message: 'backend HTTP failure',
        statusCode: 429,
        requestId: 'req-openai-http',
        retryAfterMs: 2000,
      },
    });
  });

  it('converts a kimi quota response to quota_exhausted', async () => {
    const requester = createKimiOpenAIRequester({
      endpoint: kimiEndpoint,
      classifyError: classifyKimiQuotaError,
      clientFactory: failingOpenAIClient(
        new RawOpenAISDKAPIError(
          429,
          { message: 'backend quota message', code: 'exceeded_current_quota_error' },
          'SDK-composed fallback',
          new Headers(),
        ),
      ),
    });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'quota_exhausted', message: 'backend quota message' },
    });
  });

  it('does not restore a stream status through the Kimi classification hook', async () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { message: 'backend stream quota', code: 'exceeded_current_quota_error' },
      'SDK-composed fallback',
      new Headers({ 'retry-after': '5' }),
    );
    const requester = createKimiOpenAIRequester({
      endpoint: kimiEndpoint,
      classifyError: classifyKimiQuotaError,
      clientFactory: () =>
        ({
          chat: {
            completions: {
              create: () => ({
                withResponse: async () => ({
                  data: {
                    async *[Symbol.asyncIterator]() {
                      yield {};
                      throw raw;
                    },
                  },
                  response: new Response(null, {
                    status: 200,
                    headers: { 'x-trace-id': 'req-kimi-stream' },
                  }),
                }),
              }),
            },
          },
        }) as never,
    });
    const events = await generateEvents(requester);
    const failure = events.at(-1);
    expect(failure).toMatchObject({
      type: 'llm.failed.remote',
      error: {
        kind: 'quota_exhausted',
        message: 'backend stream quota',
        requestId: 'req-kimi-stream',
        retryAfterMs: 5000,
      },
    });
    expect(failure).not.toHaveProperty('error.statusCode');
  });

  it('does not restore a stream status through Kimi Anthropic classification', async () => {
    const raw = new RawAnthropicSDKAPIError(
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
      'error',
    );
    const requester = createKimiAnthropicRequester({
      endpoint: kimiEndpoint,
      betaApi: false,
      classifyError: classifyKimiQuotaError,
      clientFactory: () =>
        ({
          messages: {
            create: () => ({
              withResponse: async () => ({
                data: {
                  async *[Symbol.asyncIterator]() {
                    yield {};
                    throw raw;
                  },
                },
                response: new Response(null, {
                  status: 200,
                  headers: { 'x-trace-id': 'req-kimi-anthropic-stream', 'retry-after': '6' },
                }),
              }),
            }),
          },
        }) as never,
    });
    const events = await generateEvents(requester);
    const failure = events.at(-1);
    expect(failure).toMatchObject({
      type: 'llm.failed.remote',
      error: {
        kind: 'quota_exhausted',
        message: 'backend anthropic stream quota',
        requestId: 'req-kimi-anthropic-stream',
        retryAfterMs: 6000,
      },
    });
    expect(failure).not.toHaveProperty('error.statusCode');
    if (failure?.type === 'llm.failed.remote' && failure.error.kind === 'quota_exhausted') {
      expect(failure.error.headers?.['x-trace-id']).toBe('req-kimi-anthropic-stream');
    }
  });

  it('preserves diagnostics for an unknown OpenAI stream business code', async () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { message: 'backend unknown stream failure', code: 'unlisted_business_error' },
      'SDK-composed fallback',
      new Headers(),
    );
    const requester = createOpenAIRequester({
      clientFactory: () =>
        ({
          chat: {
            completions: {
              create: () => ({
                withResponse: async () => ({
                  data: {
                    async *[Symbol.asyncIterator]() {
                      yield {};
                      throw raw;
                    },
                  },
                  response: new Response(null, {
                    status: 200,
                    headers: { 'x-request-id': 'req-openai-unknown', 'retry-after': '7' },
                  }),
                }),
              }),
            },
          },
        }) as never,
    });
    const events = await generateEvents(requester);
    const failure = events.at(-1);
    expect(failure).toMatchObject({
      type: 'llm.failed.remote',
      error: {
        kind: 'rate_limit',
        message: 'backend unknown stream failure',
        requestId: 'req-openai-unknown',
        retryAfterMs: 7000,
      },
    });
    expect(failure).not.toHaveProperty('error.statusCode');
  });

  it('converts an OpenAI Responses stream error without inventing HTTP facts', async () => {
    const client = new OpenAI({
      apiKey: 'test-key',
      baseURL: model.baseUrl,
      maxRetries: 0,
      fetch: async () =>
        new Response(
          'event: error\ndata: {"type":"error","code":"rate_limit_exceeded","message":"backend responses stream failure"}\n\n',
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

  it('converts an Anthropic stream error without inventing HTTP facts', async () => {
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

  it('keeps abort semantics for a Google stream iteration failure', async () => {
    const requester = createGoogleGenAIRequester({
      clientFactory: () =>
        ({
          models: {
            generateContentStream: async () => ({
              async *[Symbol.asyncIterator]() {
                yield {};
                throw new DOMException('cancelled', 'AbortError');
              },
            }),
          },
        }) as never,
    });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'abort', message: 'cancelled' },
    });
    expect(events.filter((event) => event.type === 'llm.failed.remote')).toHaveLength(1);
    expect(events.some((event) => event.type === 'llm.done')).toBe(false);
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

describe('Anthropic error decoding', () => {
  it('uses the nested backend message and preserves a real HTTP status', () => {
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

  it('classifies a structured context code without exposing a stream status', () => {
    const raw = new RawAnthropicSDKAPIError(
      400,
      { error: { type: 'context_length_exceeded' } },
      'SDK-composed fallback',
      new Headers(),
    );
    const converted = convertAnthropicError(raw, 'stream');
    expect(converted).toMatchObject({ kind: 'context_overflow', message: '' });
    expect(converted.statusCode).toBeUndefined();
    expect(isRetryableError(converted)).toBe(false);
  });

  it('preserves diagnostics for an unknown stream business code', () => {
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

  it('does not fall back to the SDK message when the backend message is missing', () => {
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
  it('keeps a stream business 503 retryable without an HTTP status', () => {
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

  it('does not infer a business kind or HTTP status from message text', () => {
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

  it('uses only the response.failed backend error message', () => {
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

  it('keeps a missing response.failed message empty', () => {
    expect(streamError({ type: 'response.failed', response: { status: 'failed' } })).toEqual({
      kind: 'provider',
      message: '',
    });
  });
});
