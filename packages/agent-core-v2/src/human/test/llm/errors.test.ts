import {
  APIConnectionError as RawOpenAISDKConnectionError,
  APIConnectionTimeoutError as RawOpenAISDKConnectionTimeoutError,
  APIError as RawOpenAISDKAPIError,
  OpenAIError as RawOpenAISDKError,
} from 'openai';
import { describe, expect, it, vi } from 'vitest';

import { UNKNOWN_CAPABILITY } from '#/llm/capability';
import { createAssistantMessage, createUserMessage, type Message } from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import { classifyKimiQuotaError } from '#/llm-kimi/errors';
import { kimiOpenAITrait } from '#/llm-kimi/trait';
import { createGoogleGenAIRequester } from '#/llm/requester/bases/google-genai/requester';
import { convertOpenAIError } from '#/llm/requester/bases/openai/format';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
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

  it('maps 429 to rate_limit with retry-after', () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { error: { message: 'too many requests' } },
      'too many requests',
      new Headers({ 'retry-after': '3' }),
    );
    expect(convertOpenAIError(raw)).toMatchObject({
      kind: 'rate_limit',
      statusCode: 429,
      retryAfterMs: 3000,
    });
  });

  it('maps insufficient_quota to quota_exhausted', () => {
    const raw = new RawOpenAISDKAPIError(
      429,
      { error: { message: 'insufficient_quota' } },
      'insufficient_quota',
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({ kind: 'quota_exhausted', statusCode: 429 });
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

  it('maps 413 too-large messages to request_too_large', () => {
    const raw = new RawOpenAISDKAPIError(
      413,
      { message: 'request entity too large' },
      undefined,
      new Headers(),
    );
    expect(convertOpenAIError(raw)).toMatchObject({ kind: 'request_too_large', statusCode: 413 });
  });

  it('maps remaining status errors to their kinds', () => {
    const overloaded = new RawOpenAISDKAPIError(529, {}, 'overloaded', new Headers());
    expect(convertOpenAIError(overloaded)).toMatchObject({ kind: 'overloaded', statusCode: 529 });
    const generic = new RawOpenAISDKAPIError(500, {}, 'server error', new Headers());
    expect(convertOpenAIError(generic)).toMatchObject({ kind: 'status', statusCode: 500 });
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
  it('classifies by structured error code', () => {
    const classified = classifyKimiQuotaError({
      status: 429,
      message: 'quota',
      code: 'exceeded_current_quota_error',
      requestID: 'req-1',
      headers: new Headers({ 'retry-after': '5', 'x-trace-id': 'trace-1' }),
    });
    expect(classified).toMatchObject({
      kind: 'quota_exhausted',
      statusCode: 429,
      requestId: 'req-1',
      retryAfterMs: 5000,
    });
    if (classified?.kind === 'quota_exhausted') {
      expect(classified.headers?.['x-trace-id']).toBe('trace-1');
    }
  });

  it('classifies by message wording', () => {
    const classified = classifyKimiQuotaError({
      status: 429,
      message: 'insufficient balance',
      headers: new Headers(),
    });
    expect(classified).toMatchObject({ kind: 'quota_exhausted', statusCode: 429 });
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
    const requester = createOpenAIRequester(undefined, {
      clientFactory: failingOpenAIClient(
        new RawOpenAISDKAPIError(
          429,
          { error: { message: 'too many requests' } },
          'too many requests',
          new Headers(),
        ),
      ),
    });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'rate_limit' },
    });
  });

  it('converts a kimi quota response to quota_exhausted', async () => {
    const requester = createOpenAIRequester(kimiOpenAITrait, {
      clientFactory: failingOpenAIClient(
        new RawOpenAISDKAPIError(
          429,
          { error: { message: 'check your account balance' } },
          'check your account balance',
          new Headers(),
        ),
      ),
    });
    const events = await generateEvents(requester);
    expect(events.at(-1)).toMatchObject({
      type: 'llm.failed.remote',
      error: { kind: 'quota_exhausted' },
    });
  });

  it('emits llm.failed.syntax for a local message syntax error without sending a request', async () => {
    const clientFactory = vi.fn(() => ({}) as never);
    const requester = createGoogleGenAIRequester(undefined, { clientFactory });
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
