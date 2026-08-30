import { createControlledPromise } from '@antfu/utils';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { unwrapErrorCause } from '#/errors';
import {
  APIConnectionError,
  APIContextOverflowError,
  APIEmptyResponseError,
  APIProviderQuotaExhaustedError,
  APIProviderRateLimitError,
  APIRequestTooLargeError,
  APIStatusError,
} from '#/kosong/contract/errors';
import { isToolCall, type Message, type StreamedMessagePart } from '#/kosong/contract/message';
import { emptyUsage } from '#/kosong/contract/usage';
import {
  AgentLlmRequester,
  type LlmRequesterRuntime,
} from '#/actor/llmRequester/llmRequesterAgentRuntime';
import { KIMI_CODE_INFINITE_RETRY_ENV } from '#/actor/llmRequester/llmRequester';
import { AgentProfile } from '#/actor/profile/profileAgentRuntime';
import type { generate as kosongGenerate } from '#/kosong/contract/generate';

import {
  configServices,
  createTestAgent,
  llmGenerateServices,
  telemetryServices,
  type TestAgentContext,
} from '../../harness';
import { recordingTelemetry, type TelemetryRecord } from '../../app/telemetry/stubs';

type GenerateFn = typeof kosongGenerate;

type WireEvent = Extract<
  TestAgentContext['allEvents'][number],
  { readonly type: '[wire]' }
>;

function wireEvents(
  ctx: TestAgentContext,
  eventName: string,
): readonly WireEvent[] {
  return ctx.allEvents.filter(
    (event): event is WireEvent => event.type === '[wire]' && event.event === eventName,
  );
}

function projections(ctx: TestAgentContext): readonly unknown[] {
  return wireEvents(ctx, 'llm.request').map(
    (event) => (event.args as Record<string, unknown>)['projection'],
  );
}

function assistantText(text: string): Message {
  return { role: 'assistant', content: [{ type: 'text', text }], toolCalls: [] };
}

function imageMessage(url: string, id: string): Message {
  return {
    role: 'user',
    content: [{ type: 'image_url', imageUrl: { url, id } }],
    toolCalls: [],
  };
}

function textResult(text: string) {
  return {
    id: 'response-1',
    message: assistantText(text),
    usage: emptyUsage(),
    finishReason: 'completed' as const,
    rawFinishReason: 'stop',
  };
}

function fastRetry<T extends Error>(error: T): T {
  Object.assign(error, { retryAfterMs: 1 });
  return error;
}

function failingThenOkGenerate(errors: readonly Error[]): {
  readonly generate: GenerateFn;
  readonly calls: { value: number };
} {
  const calls = { value: 0 };
  const generate: GenerateFn = async () => {
    const error = errors[calls.value];
    calls.value += 1;
    if (error !== undefined) throw error;
    return textResult('ok');
  };
  return { generate, calls };
}

describe('LlmRequesterRuntime measured anchors', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('skips the measured anchor when the stream reports no usage', async () => {
    ctx = createTestAgent(
      llmGenerateServices(async () => ({
        id: 'response-1',
        message: assistantText('ok'),
        usage: null,
        finishReason: 'completed' as const,
        rawFinishReason: 'stop',
      })),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate();

    expect(wireEvents(ctx, 'token_counting.measured')).toHaveLength(0);
  });

  it('writes the measured anchor from the reported usage', async () => {
    ctx = createTestAgent(
      llmGenerateServices(async () => ({
        id: 'response-1',
        message: assistantText('ok'),
        usage: { inputOther: 40, output: 2, inputCacheRead: 0, inputCacheCreation: 0 },
        finishReason: 'completed' as const,
        rawFinishReason: 'stop',
      })),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate();

    const measured = wireEvents(ctx, 'token_counting.measured');
    expect(measured).toHaveLength(1);
    expect(measured[0]?.args).toMatchObject({ tokens: 42 });
  });
});

describe('LlmRequesterRuntime Anthropic effort diagnostics', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('warns and sends when the effort is not listed by the model', async () => {
    ctx = createTestAgent(
      configServices(() => ({
        providers: {
          kimi: {
            type: 'kimi',
            apiKey: 'test-key',
            baseUrl: 'https://api.example.test/v1',
          },
        },
        models: {
          'kimi-code/compatible': {
            provider: 'kimi',
            protocol: 'anthropic',
            model: 'compatible-model',
            maxContextSize: 128_000,
            capabilities: ['thinking'],
            supportEfforts: ['max'],
          },
        },
      })),
    );
    const profile = ctx.resolve(AgentProfile);
    profile.update({ modelAlias: 'kimi-code/compatible', thinkingLevel: 'high' });
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    const requester = ctx.resolve(AgentLlmRequester);
    const effortWarnings = () =>
      ctx!.allEvents.filter(
        (event) =>
          event.type === '[rpc]' &&
          event.event === 'warning' &&
          (event.args as Record<string, unknown>)['code'] ===
            'anthropic-thinking-effort-not-listed',
      );
    const beforeRequest = effortWarnings().length;

    const result = await requester.generate();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    const warnings = effortWarnings();
    expect(warnings.length).toBe(beforeRequest + 1);
    expect(warnings.at(-1)?.args).toMatchObject({
      message:
        'Thinking effort "high" is not listed for model "compatible-model" (known: max). The configured value will be sent unchanged to the Anthropic-compatible backend.',
    });
  });
});

describe('LlmRequesterRuntime strict resend', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('does not resend for non-recoverable errors', async () => {
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        throw new APIStatusError(401, 'unauthorized');
      }),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    await expect(requester.generate()).rejects.toMatchObject({ name: 'APIStatusError' });
    expect(wireEvents(ctx, 'llm.request')).toHaveLength(1);
    expect(projections(ctx)).toEqual([undefined]);
  });
});

describe('LlmRequesterRuntime infinite retry', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('retries every request error while KIMI_CODE_INFINITE_RETRY is set', async () => {
    vi.stubEnv(KIMI_CODE_INFINITE_RETRY_ENV, '1');
    const { generate, calls } = failingThenOkGenerate([
      fastRetry(new APIStatusError(400, 'endpoint broken')),
      fastRetry(new APIStatusError(404, 'model not found')),
      fastRetry(new APIConnectionError('socket hang up')),
      fastRetry(new APIProviderQuotaExhaustedError('quota exhausted')),
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    const finish = await requester.generate();

    expect(calls.value).toBe(5);
    expect(finish.message.content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('honors the provider retry-after delay while retrying indefinitely', async () => {
    vi.stubEnv(KIMI_CODE_INFINITE_RETRY_ENV, '1');
    const { generate, calls } = failingThenOkGenerate([
      new APIProviderRateLimitError('slow down', null, 1),
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    const startedAt = Date.now();
    await requester.generate();

    expect(calls.value).toBe(2);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('stops retrying when the caller aborts during the backoff wait', async () => {
    vi.stubEnv(KIMI_CODE_INFINITE_RETRY_ENV, '1');
    const { generate, calls } = failingThenOkGenerate([
      new APIProviderRateLimitError('slow down', null, 10_000),
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error('stop')), 20);

    await expect(requester.generate({}, undefined, controller.signal)).rejects.toThrow('stop');
    expect(calls.value).toBe(1);
  });

  it('keeps deterministic projection recovery ahead of infinite retry', async () => {
    vi.stubEnv(KIMI_CODE_INFINITE_RETRY_ENV, '1');
    const { generate, calls } = failingThenOkGenerate([
      new APIRequestTooLargeError(413, 'Request Entity Too Large'),
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate();

    expect(calls.value).toBe(2);
    expect(projections(ctx)).toEqual([undefined, 'media-degraded']);
  });

  it('lets context overflow reach deterministic recovery instead of retrying', async () => {
    vi.stubEnv(KIMI_CODE_INFINITE_RETRY_ENV, '1');
    const { generate, calls } = failingThenOkGenerate([
      new APIContextOverflowError(400, 'context length exceeded'),
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await expect(requester.generate()).rejects.toSatisfy(
      (error) => unwrapErrorCause(error) instanceof APIContextOverflowError,
    );
    expect(calls.value).toBe(1);
  });

  it('retries operation requests indefinitely', async () => {
    vi.stubEnv(KIMI_CODE_INFINITE_RETRY_ENV, '1');
    const { generate, calls } = failingThenOkGenerate([
      fastRetry(new APIStatusError(400, 'endpoint broken')),
      fastRetry(new APIStatusError(404, 'model not found')),
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate({ source: { type: 'operation', requestKind: 'full_compaction' } });

    expect(calls.value).toBe(3);
  });

  it('does not retry when the switch is unset', async () => {
    const { generate, calls } = failingThenOkGenerate([
      new APIStatusError(400, 'endpoint broken'),
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await expect(requester.generate()).rejects.toMatchObject({ name: 'APIStatusError' });
    expect(calls.value).toBe(1);
  });
});

describe('LlmRequesterRuntime media-stripped resend', () => {
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );

  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('resends once with the media-stripped projection after an image-format 400', async () => {
    const { generate, calls } = failingThenOkGenerate([IMAGE_FORMAT_400]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    const result = await requester.generate();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projections(ctx)).toEqual([undefined, 'media-stripped']);
  });

  it('keeps later steps of the same turn on the stripped projection', async () => {
    const { generate, calls } = failingThenOkGenerate([IMAGE_FORMAT_400]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);

    await requester.generate({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projections(ctx)).toEqual([undefined, 'media-stripped', 'media-stripped']);
  });

  it('does not resend for an unrelated 400', async () => {
    const { generate, calls } = failingThenOkGenerate([
      new APIStatusError(400, 'some other validation problem'),
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await expect(requester.generate()).rejects.toMatchObject({ name: 'APIStatusError' });
    expect(calls.value).toBe(1);
    expect(projections(ctx)).toEqual([undefined]);
  });
});

describe('LlmRequesterRuntime media-degraded resend', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');

  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('resends once with the media-degraded projection after an HTTP 413', async () => {
    const { generate, calls } = failingThenOkGenerate([BODY_TOO_LARGE_413]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    const result = await requester.generate();

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(2);
    expect(projections(ctx)).toEqual([undefined, 'media-degraded']);
  });

  it('falls back to media-stripped when the media-degraded request still receives 413', async () => {
    const { generate, calls } = failingThenOkGenerate([BODY_TOO_LARGE_413, BODY_TOO_LARGE_413]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    const result = await requester.generate({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(result.message.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(calls.value).toBe(3);
    expect(projections(ctx)).toEqual([undefined, 'media-degraded', 'media-stripped']);
  });

  it('records repeated-413 recovery projections on the sticky later request', async () => {
    const { generate } = failingThenOkGenerate([BODY_TOO_LARGE_413, BODY_TOO_LARGE_413]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate({ source: { type: 'turn', turnId: 1, step: 1 } });
    await requester.generate({ source: { type: 'turn', turnId: 1, step: 2 } });

    expect(projections(ctx)).toEqual([undefined, 'media-degraded', 'media-stripped', 'media-stripped']);
  });

  it('keeps new recovery media visible on later snapshot-stripped steps', async () => {
    const oldUrl = 'data:image/png;base64,REJECTED';
    const newUrl = 'data:image/png;base64,SMALL';
    const histories: Message[][] = [];
    const { generate } = failingThenOkGenerate([BODY_TOO_LARGE_413, BODY_TOO_LARGE_413]);
    ctx = createTestAgent(
      llmGenerateServices(async (_provider, _systemPrompt, _tools, history, callbacks, options) => {
        histories.push(structuredClone(history));
        return generate(_provider, _systemPrompt, _tools, history, callbacks, options);
      }),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate({
      messages: [imageMessage(oldUrl, 'rejected-id')],
      source: { type: 'turn', turnId: 1, step: 1 },
    });
    await requester.generate({
      messages: [imageMessage(oldUrl, 'rejected-id'), imageMessage(newUrl, 'recovery-id')],
      source: { type: 'turn', turnId: 1, step: 2 },
    });

    const visibleUrls = histories
      .at(-1)
      ?.flatMap((message) => message.content)
      .filter((part) => part.type === 'image_url')
      .map((part) => part.imageUrl.url);
    expect(visibleUrls).toEqual([newUrl]);
  });

  it('stops after the media-stripped request also receives 413', async () => {
    const { generate, calls } = failingThenOkGenerate([
      BODY_TOO_LARGE_413,
      BODY_TOO_LARGE_413,
      BODY_TOO_LARGE_413,
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await expect(
      requester.generate({ source: { type: 'turn', turnId: 1, step: 1 } }),
    ).rejects.toSatisfy(
      (error) => unwrapErrorCause(error) instanceof APIRequestTooLargeError,
    );
    expect(calls.value).toBe(3);
    expect(projections(ctx)).toEqual([undefined, 'media-degraded', 'media-stripped']);
  });

  it('keeps later steps of the same turn on the degraded projection', async () => {
    const { generate, calls } = failingThenOkGenerate([BODY_TOO_LARGE_413]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate({ source: { type: 'turn', turnId: 1, step: 1 } });
    expect(calls.value).toBe(2);

    await requester.generate({ source: { type: 'turn', turnId: 1, step: 2 } });
    expect(calls.value).toBe(3);
    expect(projections(ctx)).toEqual([undefined, 'media-degraded', 'media-degraded']);
  });

  it('does not resend for a plain 400 or a non-413 status', async () => {
    for (const error of [
      new APIStatusError(400, 'max_tokens must be positive'),
      new APIStatusError(422, 'unprocessable'),
    ]) {
      const { generate, calls } = failingThenOkGenerate([error]);
      ctx = createTestAgent(llmGenerateServices(generate));
      const requester = ctx.resolve(AgentLlmRequester);

      await expect(requester.generate()).rejects.toMatchObject({ name: 'APIStatusError' });
      expect(calls.value).toBe(1);
      expect(projections(ctx)).toEqual([undefined]);
      await ctx.dispose();
      ctx = undefined;
    }
  });
});

describe('LlmRequesterRuntime combined recovery projections', () => {
  const BODY_TOO_LARGE_413 = new APIRequestTooLargeError(413, 'Request Entity Too Large');
  const IMAGE_FORMAT_400 = new APIStatusError(
    400,
    'unsupported image format: image/avif is not supported',
  );
  const STRUCTURAL_400 = new APIStatusError(400, 'messages: `tool_use` ids must be unique');

  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('accumulates media repairs on top of strict across repeated rejections', async () => {
    const { generate, calls } = failingThenOkGenerate([
      STRUCTURAL_400,
      BODY_TOO_LARGE_413,
      BODY_TOO_LARGE_413,
    ]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate({ source: { type: 'turn', turnId: 1, step: 1 } });

    expect(calls.value).toBe(4);
    expect(projections(ctx)).toEqual([
      undefined,
      'strict',
      'strict-media-degraded',
      'strict-media-stripped',
    ]);
  });

  it('strips rejected images on top of strict after an image-format rejection on the strict resend', async () => {
    const { generate, calls } = failingThenOkGenerate([STRUCTURAL_400, IMAGE_FORMAT_400]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate();

    expect(calls.value).toBe(3);
    expect(projections(ctx)).toEqual([undefined, 'strict', 'strict-media-stripped']);
  });

  it('applies the strict repair on top of degraded media when a structural 400 follows a 413', async () => {
    const { generate, calls } = failingThenOkGenerate([BODY_TOO_LARGE_413, STRUCTURAL_400]);
    ctx = createTestAgent(llmGenerateServices(generate));
    const requester = ctx.resolve(AgentLlmRequester);

    await requester.generate();

    expect(calls.value).toBe(3);
    expect(projections(ctx)).toEqual([undefined, 'media-degraded', 'strict-media-degraded']);
  });
});

describe('LlmRequesterRuntime trace id', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  it('exposes the request trace and returns it on finish', async () => {
    const headersArrived = createControlledPromise<void>();
    const releaseStream = createControlledPromise<void>();
    ctx = createTestAgent(
      llmGenerateServices(async (_provider, _systemPrompt, _tools, _history, callbacks, options) => {
        options?.onRequestStart?.();
        options?.onTraceId?.('trace-req-1');
        headersArrived.resolve();
        await releaseStream;
        await callbacks?.onMessagePart?.({ type: 'text', text: 'ok' });
        options?.onStreamEnd?.();
        return { ...textResult('ok'), traceId: 'trace-req-1' };
      }),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    const request = requester.stream({ source: { type: 'turn', turnId: 1, step: 1 } });
    await headersArrived;
    expect(request.trace.traceId).toBe('trace-req-1');
    releaseStream.resolve();
    const finish = await request.result;

    expect(finish.traceId).toBe('trace-req-1');
    expect(request.trace.traceId).toBe('trace-req-1');
  });

  it('reports an absent trace before a request that returns none', async () => {
    ctx = createTestAgent();
    ctx.mockNextResponse({ type: 'text', text: 'ok' });
    const requester = ctx.resolve(AgentLlmRequester);

    const request = requester.stream();
    const finish = await request.result;

    expect(finish.traceId).toBeUndefined();
    expect(request.trace.traceId).toBeUndefined();
  });

  it('attaches trace_id, turn_id and step_no to api_error from the failed request', async () => {
    const records: TelemetryRecord[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async () => {
        throw new APIStatusError(500, 'boom', 'req-1', null, 'trace-fail-1');
      }),
      telemetryServices(recordingTelemetry(records)),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    const request = requester.stream({ source: { type: 'turn', turnId: 3, step: 2 } });
    await expect(request.result).rejects.toMatchObject({ name: 'APIStatusError' });

    expect(records).toContainEqual({
      event: 'api_error',
      properties: expect.objectContaining({
        error_type: '5xx_server',
        trace_id: 'trace-fail-1',
        turn_id: 3,
        step_no: 2,
      }),
    });
    expect(request.trace.traceId).toBe('trace-fail-1');
  });

  it('keeps the header-captured trace when the request fails after headers arrived', async () => {
    const records: TelemetryRecord[] = [];
    ctx = createTestAgent(
      llmGenerateServices(async (_provider, _systemPrompt, _tools, _history, _callbacks, options) => {
        options?.onTraceId?.('trace-mid-stream');
        throw new APIEmptyResponseError('no content, no tool calls');
      }),
      telemetryServices(recordingTelemetry(records)),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    const request = requester.stream({ source: { type: 'turn', turnId: 4, step: 1 } });
    await expect(request.result).rejects.toMatchObject({ name: 'APIEmptyResponseError' });

    const apiError = records.find((record) => record.event === 'api_error');
    expect(apiError?.properties?.['trace_id']).toBe('trace-mid-stream');
    expect(request.trace.traceId).toBe('trace-mid-stream');
  });

  it('clears the previous physical request trace before a projection retry', async () => {
    const records: TelemetryRecord[] = [];
    let attempts = 0;
    ctx = createTestAgent(
      llmGenerateServices(async (_provider, _systemPrompt, _tools, _history, _callbacks, options) => {
        attempts += 1;
        if (attempts === 1) {
          options?.onTraceId?.('trace-first-projection');
          throw new APIRequestTooLargeError(413, 'retry with degraded media');
        }
        throw new APIConnectionError('socket hang up');
      }),
      telemetryServices(recordingTelemetry(records)),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    const request = requester.stream();
    await expect(request.result).rejects.toMatchObject({ name: 'APIConnectionError' });

    expect(attempts).toBe(2);
    expect(request.trace.traceId).toBeUndefined();
    expect(
      records.find((record) => record.event === 'api_error')?.properties?.['trace_id'],
    ).toBeUndefined();
  });
});

describe('LlmRequesterRuntime tool call id normalization', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    if (ctx === undefined) return;
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
      ctx = undefined;
    }
  });

  function toolCallPart(id: string, streamIndex: number): StreamedMessagePart {
    return {
      type: 'function',
      id,
      name: 'Bash',
      arguments: '{"command":"ls"}',
      _streamIndex: streamIndex,
    };
  }

  it('passes provider-unique ids through unchanged', async () => {
    ctx = createTestAgent();
    ctx.mockNextProviderResponse({
      parts: [toolCallPart('call_1', 0), toolCallPart('call_2', 1)],
    });
    const requester = ctx.resolve(AgentLlmRequester);
    const parts: StreamedMessagePart[] = [];

    const result = await requester.generate({}, (part) => {
      parts.push(part);
    });

    expect(result.message.toolCalls.map((call) => call.id)).toEqual(['call_1', 'call_2']);
    expect(parts.filter(isToolCall).map((part) => part.id)).toEqual(['call_1', 'call_2']);
  });

  it('rewrites an id repeated across responses and keeps streamed parts consistent', async () => {
    ctx = createTestAgent();
    ctx.mockNextProviderResponse({ parts: [toolCallPart('Bash_0', 0)] });
    ctx.mockNextProviderResponse({ parts: [toolCallPart('Bash_0', 0)] });
    const requester = ctx.resolve(AgentLlmRequester);
    const parts: StreamedMessagePart[] = [];

    const first = await requester.generate({}, (part) => {
      parts.push(part);
    });
    const second = await requester.generate({}, (part) => {
      parts.push(part);
    });

    expect(first.message.toolCalls[0]!.id).toBe('Bash_0');
    expect(second.message.toolCalls[0]!.id).toBe('Bash_0__2');
    expect(parts.filter(isToolCall).map((part) => part.id)).toEqual(['Bash_0', 'Bash_0__2']);
  });

  it('rewrites duplicates within a single response', async () => {
    ctx = createTestAgent();
    ctx.mockNextProviderResponse({
      parts: [toolCallPart('Bash_0', 0), toolCallPart('Bash_0', 1)],
    });
    const requester = ctx.resolve(AgentLlmRequester);

    const result = await requester.generate();

    expect(result.message.toolCalls.map((call) => call.id)).toEqual(['Bash_0', 'Bash_0__2']);
  });

  it('rolls claims back when the attempt fails mid-stream', async () => {
    let calls = 0;
    ctx = createTestAgent(
      llmGenerateServices(async (_provider, _systemPrompt, _tools, _history, callbacks, options) => {
        calls += 1;
        options?.onRequestStart?.();
        await callbacks?.onMessagePart?.(toolCallPart('Bash_9', 0));
        if (calls === 1) throw new Error('stream boom');
        options?.onStreamEnd?.();
        return {
          id: 'response-1',
          message: {
            role: 'assistant' as const,
            content: [],
            toolCalls: [
              { type: 'function' as const, id: 'Bash_9', name: 'Bash', arguments: '{"command":"ls"}' },
            ],
          },
          usage: emptyUsage(),
          finishReason: 'tool_calls' as const,
          rawFinishReason: 'tool_calls',
        };
      }),
    );
    const requester = ctx.resolve(AgentLlmRequester);

    await expect(requester.generate()).rejects.toThrow('stream boom');
    const retry = await requester.generate();
    expect(retry.message.toolCalls[0]!.id).toBe('Bash_9');
  });

  it('rewrites an id that already exists in the restored context', async () => {
    ctx = createTestAgent();
    await ctx.context.append({
      role: 'assistant',
      content: [],
      toolCalls: [{ type: 'function', id: 'Bash_0', name: 'Bash', arguments: '{}' }],
    });
    ctx.mockNextProviderResponse({ parts: [toolCallPart('Bash_0', 0)] });
    const requester = ctx.resolve(AgentLlmRequester);

    const result = await requester.generate();

    expect(result.message.toolCalls[0]!.id).toBe('Bash_0__2');
  });
});
