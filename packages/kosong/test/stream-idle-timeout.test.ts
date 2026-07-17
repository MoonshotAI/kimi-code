/**
 * Stream idle watchdog on kosong's `generate()`: a provider stream that goes
 * silent mid-flight must fail with `StreamIdleTimeoutError` instead of
 * hanging `generate()` forever, and must be classified as retryable so the
 * agent-core loop's step-retry re-drives the failed step.
 *
 * kosong is the shared LLM-streaming layer used by the ACP path (kimi-code
 * TUI + `kimi acp` → kimi-code-sdk → agent-core → kosong.generate). The
 * agent-core-v2 stack ships its own equivalent watchdog in
 * `packages/agent-core-v2/src/app/llmProtocol/generate.ts` for the
 * kap-server path — the same failure signature must fail loudly on both.
 */
import { APITimeoutError, isRetryableGenerateError } from '#/errors';
import type { StreamedMessagePart } from '#/message';
import type { ChatProvider, StreamedMessage, ThinkingEffort } from '#/provider';
import type { Tool } from '#/tool';
import type { Message } from '#/message';
import { describe, expect, it } from 'vitest';

function makeProvider(stream: StreamedMessage): ChatProvider {
  return {
    name: 'fake',
    modelName: 'fake-model',
    thinkingEffort: null,
    generate: async (
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
    ): Promise<StreamedMessage> => stream,
    withThinking(_effort: ThinkingEffort): ChatProvider {
      return this;
    },
  };
}

function stalledStream(
  parts: StreamedMessagePart[],
  onCancel?: () => void,
  traceId: string | null = null,
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
      };
    },
  } as unknown as StreamedMessage;
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
  } as unknown as StreamedMessage;
}

// All three cases below share the same 200ms watchdog window. The env var is
// read once at module init; setting it before the first import is enough.
async function importGenerateWithTimeout(ms: number) {
  process.env['KIMI_STREAM_IDLE_TIMEOUT_MS'] = String(ms);
  const mod = await import('#/generate');
  return mod;
}

describe('kosong.generate() stream idle watchdog', () => {
  it('throws StreamIdleTimeoutError when the stream goes silent after first part', async () => {
    const { generate, StreamIdleTimeoutError } = await importGenerateWithTimeout(200);
    let cancelled = false;
    const stream = stalledStream(
      [{ type: 'think', think: 'partial thinking' }],
      () => {
        cancelled = true;
      },
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
});
