import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createMediaDegradeRecovery } from '#/llm/builtin/policy/media-degrade';
import { credentialRecovery, runWithCredentialRecovery } from '#/llm/policy/credentials';
import { createUserMessage, type StreamedMessagePart, type ToolCall } from '#/llm/message';
import type { LlmModule, Protocol } from '#/llm/protocol/protocol';
import type { LlmCredentialProvider } from '#/llm/request';
import type { FinishInfo, LlmRemoteErrorMessage } from '#/llm/response';

import { asyncChunks, doneOutcome, failedOutcome, runGenerate, testModule } from './harness';

interface FakeChunk {
  readonly text?: string;
  readonly think?: string;
  readonly tool?: ToolCall;
  readonly finish?: FinishInfo;
}

function protocolWith(options: {
  readonly chunks?: readonly FakeChunk[];
  readonly sendStream: Protocol['sendStream'];
  readonly decodeError?: Protocol['decodeError'];
}): Protocol {
  const chunks = options.chunks ?? [];
  return {
    media: { kinds: {} },
    encode: (module: LlmModule) => module.content.messages,
    client: () => null,
    send: async () => ({ body: chunks, headers: { 'x-request-id': 'req-success' } }),
    sendStream: options.sendStream,
    decoder: (_module, sink) => ({
      push: (chunk: FakeChunk) => {
        if (chunk.text !== undefined) sink.onDelta({ type: 'text', text: chunk.text });
        if (chunk.think !== undefined) sink.onDelta({ type: 'think', think: chunk.think });
        if (chunk.tool !== undefined) {
          sink.onDelta(chunk.tool);
          sink.onToolCallEnd(chunk.tool._streamIndex);
        }
        if (chunk.finish !== undefined) sink.onFinish(chunk.finish);
      },
      end: () => {},
    }),
    replay: (response) => response,
    requestId: (headers) => headers['x-request-id'],
    decodeError: options.decodeError ?? ((error): LlmRemoteErrorMessage => ({
      kind: 'provider',
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
    })),
  };
}

function successfulChunks(text = 'recovered'): readonly FakeChunk[] {
  return [{ text, finish: { finishReason: 'completed', rawFinishReason: 'stop' } }];
}

const NULL_STATUS = { requestId: null, retryAfterMs: null, headers: null } as const;

function retryableProtocol(attempts: { count: number }, retryable = true): Protocol {
  return protocolWith({
    sendStream: async () => {
      attempts.count += 1;
      if (attempts.count > 1) return { body: asyncChunks(successfulChunks()) };
      throw new Error('temporary failure');
    },
    decodeError: (error): LlmRemoteErrorMessage => ({
      kind: 'provider',
      message: error instanceof Error ? error.message : String(error),
      retryable,
    }),
  });
}

function mediaMessage(id: string) {
  return createUserMessage([{ type: 'image_url', imageUrl: { url: `data:image/png;base64,${id}` } }]);
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('LLM retry policy', () => {
  it('fails after maxAttemptsPerStep is exhausted', async () => {
    const attempts = { count: 0 };
    const protocol = protocolWith({
      sendStream: async () => {
        attempts.count += 1;
        throw new Error('still unavailable');
      },
    });
    const pending = runGenerate(protocol, {
      module: testModule(),
      maxAttemptsPerStep: 2,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const { outcome, events } = await pending;

    expect(failedOutcome(outcome).error.message).toBe('still unavailable');
    expect(attempts.count).toBe(2);
    expect(events.filter((event) => event.type === 'llm.retry')).toHaveLength(1);
  });

  it('does not retry non-retryable errors', async () => {
    const attempts = { count: 0 };
    const { outcome, events } = await runGenerate(retryableProtocol(attempts, false), {
      module: testModule(),
      maxAttemptsPerStep: 10,
    });

    expect(outcome.type).toBe('failed');
    expect(attempts.count).toBe(1);
    expect(events.some((event) => event.type === 'llm.retry')).toBe(false);
  });

  it('retries a non-retryable error when infiniteRetry is on', async () => {
    const attempts = { count: 0 };
    const pending = runGenerate(retryableProtocol(attempts, false), {
      module: testModule(),
      maxAttemptsPerStep: 10,
      infiniteRetry: true,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const { outcome } = await pending;

    expect(doneOutcome(outcome).message.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(attempts.count).toBe(2);
  });

  it('prefers retryAfterMs from the error over the backoff delay', async () => {
    const protocol = protocolWith({
      sendStream: (() => {
        let attempts = 0;
        return async () => {
          attempts += 1;
          if (attempts > 1) return { body: asyncChunks(successfulChunks()) };
          throw new Error('rate limited');
        };
      })(),
      decodeError: (): LlmRemoteErrorMessage => ({
        kind: 'rate_limit',
        message: 'rate limited',
        statusCode: 429,
        ...NULL_STATUS,
        retryAfterMs: 50,
        retryable: true,
      }),
    });
    const pending = runGenerate(protocol, {
      module: testModule(),
      maxAttemptsPerStep: 2,
    });
    await vi.advanceTimersByTimeAsync(100);
    const { outcome, events } = await pending;

    expect(outcome.type).toBe('done');
    expect(events).toContainEqual(expect.objectContaining({
      type: 'llm.retry',
      reason: 'backoff',
      delayMs: 50,
    }));
  });

  it('falls back to the backoff delay without retryAfterMs', async () => {
    const attempts = { count: 0 };
    const pending = runGenerate(retryableProtocol(attempts), {
      module: testModule(),
      maxAttemptsPerStep: 2,
    });
    await vi.advanceTimersByTimeAsync(1_000);
    const { outcome, events } = await pending;

    expect(outcome.type).toBe('done');
    const retrying = events.find((event) => event.type === 'llm.retry');
    expect(retrying).toMatchObject({ reason: 'backoff' });
    if (retrying?.type !== 'llm.retry' || retrying.reason !== 'backoff') throw new Error('missing backoff');
    expect(retrying.delayMs).toBeGreaterThanOrEqual(500);
    expect(retrying.delayMs).toBeLessThanOrEqual(625);
  });

  it('does not honor retryAfterMs on a non-retryable error', async () => {
    const protocol = protocolWith({
      sendStream: async () => {
        throw new Error('permanent failure');
      },
      decodeError: (): LlmRemoteErrorMessage => ({
        kind: 'rate_limit',
        message: 'permanent failure',
        statusCode: 429,
        ...NULL_STATUS,
        retryAfterMs: 50,
        retryable: false,
      }),
    });
    const { outcome, events } = await runGenerate(protocol, {
      module: testModule(),
      maxAttemptsPerStep: 10,
    });

    expect(outcome.type).toBe('failed');
    expect(events.some((event) => event.type === 'llm.retry')).toBe(false);
  });

  it('does not retry without failure', async () => {
    const sendStream = vi.fn(async () => ({ body: asyncChunks(successfulChunks()) }));
    const protocol = protocolWith({ sendStream });
    const { outcome, events } = await runGenerate(protocol, {
      module: testModule(),
      maxAttemptsPerStep: 10,
    });

    expect(outcome.type).toBe('done');
    expect(sendStream).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'llm.retry')).toBe(false);
  });
});

describe('LLM media recovery', () => {
  it('degrades then strips media across request_too_large failures before failing', async () => {
    let attempts = 0;
    const protocol = protocolWith({
      sendStream: async () => {
        attempts += 1;
        throw new Error('request too large');
      },
      decodeError: (): LlmRemoteErrorMessage => ({
        kind: 'request_too_large',
        message: 'request too large',
        ...NULL_STATUS,
        retryable: true,
      }),
    });
    const pending = runGenerate(protocol, {
      module: testModule({
        messages: [mediaMessage('a'), mediaMessage('b'), mediaMessage('c'), mediaMessage('d')],
      }),
      maxAttemptsPerStep: 1,
      recoveries: [createMediaDegradeRecovery()],
    });
    await vi.advanceTimersByTimeAsync(10_000);
    const { outcome, events } = await pending;

    expect(outcome.type).toBe('failed');
    expect(attempts).toBe(3);
    expect(events.filter((event) => event.type === 'llm.retry').map((event) =>
      event.type === 'llm.retry' && event.reason === 'recovery' ? event.action : event.type)).toEqual([
        'degraded',
        'stripped',
      ]);
  });

  it('fails immediately on request_too_large without media', async () => {
    const sendStream = vi.fn(async () => {
      throw new Error('request too large');
    });
    const protocol = protocolWith({
      sendStream,
      decodeError: (): LlmRemoteErrorMessage => ({
        kind: 'request_too_large',
        message: 'request too large',
        ...NULL_STATUS,
        retryable: false,
      }),
    });
    const { outcome, events } = await runGenerate(protocol, {
      module: testModule(),
      maxAttemptsPerStep: 5,
      recoveries: [createMediaDegradeRecovery()],
    });

    expect(outcome.type).toBe('failed');
    expect(sendStream).toHaveBeenCalledTimes(1);
    expect(events.some((event) => event.type === 'llm.retry')).toBe(false);
  });
});

describe('LLM credential recovery', () => {
  it('keeps recovered messages when a credential refresh follows a message recovery', async () => {
    let attempts = 0;
    const provider: LlmCredentialProvider = {
      resolve: () => ({ apiKey: 'refreshed' }),
      canRecover: (error) => typeof error === 'object' && error !== null && (error as { statusCode?: unknown }).statusCode === 401,
      invalidate: vi.fn(),
    };
    const protocol = protocolWith({
      sendStream: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('request too large');
        if (attempts === 2) throw Object.assign(new Error('unauthorized'), { status: 401 });
        return { body: asyncChunks(successfulChunks('recovered')) };
      },
      decodeError: (error): LlmRemoteErrorMessage => {
        const status = typeof error === 'object' && error !== null ? (error as { status?: unknown }).status : undefined;
        if (status === 401) return { kind: 'auth', message: 'unauthorized', statusCode: 401, ...NULL_STATUS, retryable: true };
        return { kind: 'request_too_large', message: 'request too large', ...NULL_STATUS, retryable: true };
      },
    });
    const pending = runGenerate(protocol, {
      module: testModule({
        messages: [mediaMessage('a'), mediaMessage('b'), mediaMessage('c'), mediaMessage('d')],
      }),
      endpoint: { clientFactory: () => null, credentials: provider },
      maxAttemptsPerStep: 4,
      recoveries: [createMediaDegradeRecovery(), credentialRecovery],
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const { outcome, events } = await pending;

    expect(doneOutcome(outcome).message.content).toEqual([{ type: 'text', text: 'recovered' }]);
    expect(attempts).toBe(3);
    expect(provider.invalidate).toHaveBeenCalledTimes(1);
    expect(events).toContainEqual(expect.objectContaining({
      type: 'llm.retry',
      reason: 'recovery',
      strategy: 'credentials',
    }));
  });

  it('fails instead of hanging when credential resolution rejects', async () => {
    const resolutionError = new Error('credential resolution failed');
    const provider: LlmCredentialProvider = {
      resolve: () => ({ apiKey: 'unused' }),
      canRecover: () => {
        throw resolutionError;
      },
    };
    const run = vi.fn(async () => {
      throw new Error('unauthorized');
    });

    await expect(runWithCredentialRecovery(provider, run)).rejects.toBe(resolutionError);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('returns an aborted outcome without a remote failure when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();
    const sendStream = vi.fn(async () => ({ body: asyncChunks(successfulChunks()) }));
    const protocol = protocolWith({ sendStream });
    const { outcome, events } = await runGenerate(protocol, {
      module: testModule(),
      signal: controller.signal,
    });

    expect(outcome).toMatchObject({ type: 'aborted', message: null });
    expect(sendStream).not.toHaveBeenCalled();
    expect(events.some((event) => event.type === 'llm.ended' && event.outcome.type === 'failed')).toBe(false);
  });
});

describe('LLM streamed blocks', () => {
  it('numbers content parts by their content block and leaves tool calls without a content block', async () => {
    const tool: ToolCall = { type: 'function', id: 'call_1', name: 'weather', arguments: '{}', _streamIndex: 0 };
    const protocol = protocolWith({
      chunks: [
        { text: 'first' },
        { think: 'reason' },
        { tool },
        { text: 'second', finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
      ],
      sendStream: async () => ({
        body: asyncChunks([
          { text: 'first' },
          { think: 'reason' },
          { tool },
          { text: 'second', finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
        ]),
      }),
    });

    const { events } = await runGenerate(protocol, { module: testModule() });
    const parts: StreamedMessagePart[] = [];
    const blocks = events.flatMap((event) => {
      if (event.type !== 'llm.delta.part') return [];
      parts.push(event.part);
      return [event.block];
    });

    expect(parts.map((part) => part.type)).toEqual(['text', 'think', 'function', 'text']);
    expect(blocks).toEqual([0, 1, undefined, 2]);
  });
});
