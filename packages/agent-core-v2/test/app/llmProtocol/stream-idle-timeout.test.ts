/**
 * Stream idle watchdog: a provider stream that goes silent mid-flight must
 * fail with StreamIdleTimeoutError instead of hanging `generate()` forever,
 * and must be classified as retryable so the loop's step-retry plugin
 * re-drives the failed step.
 */
import type { ChatProvider, StreamedMessage } from '#/app/llmProtocol/provider';
import type { StreamedMessagePart } from '#/app/llmProtocol/message';
import {
  APITimeoutError,
  isRetryableGenerateError,
} from '#/app/llmProtocol/errors';
import { describe, expect, it } from 'vitest';

function makeProvider(
  stream: StreamedMessage,
  onGenerate?: (options?: { signal?: AbortSignal }) => void,
): ChatProvider {
  return {
    name: 'fake',
    modelName: 'fake-model',
    generate: async (
      _systemPrompt: unknown,
      _tools: unknown,
      _history: unknown,
      options?: { signal?: AbortSignal },
    ) => {
      onGenerate?.(options);
      return stream;
    },
  } as unknown as ChatProvider;
}

function stalledStream(
  parts: StreamedMessagePart[],
  onCancel?: () => void,
  traceId: string | null = null,
  onIteratorReturn?: () => void,
): StreamedMessage {
  let i = 0;
  return {
    id: 'msg-1',
    usage: null,
    finishReason: null,
    rawFinishReason: null,
    traceId,
    cancel: () => onCancel?.(),
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<StreamedMessagePart>> {
          if (i < parts.length) {
            return Promise.resolve({ done: false, value: parts[i++]! });
          }
          return new Promise<never>(() => {}); // silent forever
        },
        return(): Promise<IteratorResult<StreamedMessagePart>> {
          onIteratorReturn?.();
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  } as StreamedMessage;
}

function healthyStream(parts: StreamedMessagePart[]): StreamedMessage {
  let i = 0;
  return {
    id: 'msg-1',
    usage: null,
    finishReason: 'completed',
    rawFinishReason: 'stop',
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<StreamedMessagePart>> {
          if (i < parts.length) {
            return Promise.resolve({ done: false, value: parts[i++]! });
          }
          return Promise.resolve({ done: true, value: undefined });
        },
      };
    },
  } as StreamedMessage;
}

async function importGenerateWithTimeout(ms: number) {
  process.env['KIMI_STREAM_IDLE_TIMEOUT_MS'] = String(ms);
  const mod = await import('#/app/llmProtocol/generate');
  return mod;
}

describe('generate() stream idle watchdog', () => {
  it('throws StreamIdleTimeoutError when the stream goes silent after first part', async () => {
    const { generate, StreamIdleTimeoutError } = await importGenerateWithTimeout(200);
    let cancelled = false;
    const stream = stalledStream(
      [{ type: 'think', think: 'partial thinking' }],
      () => { cancelled = true; },
    );
    await expect(
      generate(makeProvider(stream), 'system', [], [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ]),
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(cancelled).toBe(true);
  });

  it('classifies the timeout error as a retryable APITimeoutError so step-retry drives recovery', async () => {
    const { generate, StreamIdleTimeoutError } = await importGenerateWithTimeout(200);
    const stream = stalledStream(
      [{ type: 'think', think: 'partial thinking' }],
      undefined,
      'trace-abc123',
    );
    let captured: unknown;
    try {
      await generate(makeProvider(stream), 'system', [], [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ]);
    } catch (error) {
      captured = error;
    }
    expect(captured).toBeInstanceOf(StreamIdleTimeoutError);
    expect(captured).toBeInstanceOf(APITimeoutError);
    expect(isRetryableGenerateError(captured)).toBe(true);
    const err = captured as InstanceType<typeof StreamIdleTimeoutError>;
    expect(err.traceId).toBe('trace-abc123');
    expect(err.idleMs).toBe(200);
    expect(err.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(err.message).toContain('traceId=trace-abc123');
  });

  it('does not interfere with a healthy stream', async () => {
    const { generate } = await importGenerateWithTimeout(200);
    const stream = healthyStream([
      { type: 'text', text: 'hello ' },
      { type: 'text', text: 'world' },
    ]);
    const result = await generate(makeProvider(stream), 'system', [], [
      { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
    ]);
    expect(result.message.content.some((p) => p.type === 'text')).toBe(true);
  });

  it('aborts the provider request and closes the iterator when the watchdog fires', async () => {
    const { generate, StreamIdleTimeoutError } = await importGenerateWithTimeout(200);
    let providerSignal: AbortSignal | undefined;
    let iteratorReturned = false;
    const stream = stalledStream(
      [{ type: 'think', think: 'partial thinking' }],
      undefined,
      null,
      () => {
        iteratorReturned = true;
      },
    );
    const provider = makeProvider(stream, (options) => {
      providerSignal = options?.signal;
    });
    await expect(
      generate(provider, 'system', [], [
        { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
      ]),
    ).rejects.toBeInstanceOf(StreamIdleTimeoutError);
    expect(providerSignal?.aborted).toBe(true);
    expect(providerSignal?.reason).toBeInstanceOf(StreamIdleTimeoutError);
    expect(iteratorReturned).toBe(true);
  });

  it('still delivers caller aborts to the provider through the merged signal', async () => {
    const { generate } = await importGenerateWithTimeout(200);
    let providerSignal: AbortSignal | undefined;
    const stream = healthyStream([{ type: 'text', text: 'hello' }]);
    const provider = makeProvider(stream, (options) => {
      providerSignal = options?.signal;
    });
    const caller = new AbortController();
    await generate(
      provider,
      'system',
      [],
      [{ role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] }],
      undefined,
      { signal: caller.signal },
    );
    expect(providerSignal).toBeDefined();
    expect(providerSignal?.aborted).toBe(false);
    caller.abort();
    expect(providerSignal?.aborted).toBe(true);
  });
});
