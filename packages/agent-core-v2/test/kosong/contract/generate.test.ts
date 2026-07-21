/**
 * `kosong/contract` generate() — the stream-merging generation driver.
 *
 * Covers event normalization (text/think deltas merged, tool-call argument
 * deltas routed by stream index), the empty/thinking-only response
 * rejections, the abort contract (standard DOMException, stream cancelled),
 * callback plumbing, and per-turn intent passthrough via GenerateOptions.
 */

import { describe, expect, it, vi } from 'vitest';

import { APIEmptyResponseError } from '#/kosong/contract/errors';
import { generate, type GenerateResult } from '#/kosong/contract/generate';
import type { Message, StreamedMessagePart, ToolCall } from '#/kosong/contract/message';
import type {
  ChatProvider,
  FinishReason,
  GenerateOptions,
  StreamedMessage,
} from '#/kosong/contract/provider';
import type { Tool } from '#/kosong/contract/tool';
import type { TokenUsage } from '#/kosong/contract/usage';

const USAGE: TokenUsage = { inputOther: 10, output: 5, inputCacheRead: 2, inputCacheCreation: 1 };

class FakeStreamedMessage implements StreamedMessage {
  readonly id: string | null = 'gen-1';
  readonly usage: TokenUsage | null = USAGE;
  readonly finishReason: FinishReason | null = 'completed';
  readonly rawFinishReason: string | null = 'stop';
  readonly traceId?: string | null;
  cancelCalls = 0;

  constructor(
    private readonly parts: readonly StreamedMessagePart[],
    init: {
      readonly traceId?: string | null;
      readonly onBeforeYield?: (index: number) => void;
    } = {},
  ) {
    this.traceId = init.traceId;
    this.onBeforeYield = init.onBeforeYield;
  }

  private readonly onBeforeYield?: (index: number) => void;

  async *[Symbol.asyncIterator](): AsyncIterator<StreamedMessagePart> {
    for (const [index, part] of this.parts.entries()) {
      this.onBeforeYield?.(index);
      yield part;
    }
  }

  cancel(): void {
    this.cancelCalls++;
  }
}

interface FakeProvider {
  readonly provider: ChatProvider;
  readonly generateSpy: ReturnType<typeof vi.fn>;
}

function createFakeProvider(stream: StreamedMessage): FakeProvider {
  const generateSpy = vi.fn(
    async (
      _systemPrompt: string,
      _tools: Tool[],
      _history: Message[],
      _options?: GenerateOptions,
    ): Promise<StreamedMessage> => stream,
  );
  const provider: ChatProvider = {
    name: 'fake',
    modelName: 'fake-model',
    thinkingEffort: null,
    generate: generateSpy,
  };
  return { provider, generateSpy };
}

const SYSTEM_PROMPT = 'You are a test.';
const NO_TOOLS: Tool[] = [];
const HISTORY: Message[] = [
  { role: 'user', content: [{ type: 'text', text: 'hi' }], toolCalls: [] },
];

describe('generate() stream normalization', () => {
  it('merges text and think deltas into single content parts', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'think', think: 'let me ' },
      { type: 'think', think: 'think' },
      { type: 'text', text: 'Hello, ' },
      { type: 'text', text: 'world' },
    ]);
    const { provider } = createFakeProvider(stream);

    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);

    expect(result.message.content).toEqual([
      { type: 'think', think: 'let me think' },
      { type: 'text', text: 'Hello, world' },
    ]);
    expect(result.finishReason).toBe('completed');
    expect(result.usage).toBe(USAGE);
    expect(result.id).toBe('gen-1');
  });

  it('assembles tool calls from streamed argument deltas by stream index', async () => {
    const callA: ToolCall = {
      type: 'function',
      id: 'call-a',
      name: 'toolA',
      arguments: null,
      _streamIndex: 0,
    };
    const callB: ToolCall = {
      type: 'function',
      id: 'call-b',
      name: 'toolB',
      arguments: '{"y":2}',
      _streamIndex: 1,
    };
    const stream = new FakeStreamedMessage([
      callA,
      callB,
      { type: 'tool_call_part', argumentsPart: '{"x":', index: 0 },
      { type: 'tool_call_part', argumentsPart: '1}', index: 0 },
    ]);
    const { provider } = createFakeProvider(stream);

    const result = await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY);

    expect(result.message.toolCalls).toEqual([
      { type: 'function', id: 'call-a', name: 'toolA', arguments: '{"x":1}', extras: undefined },
      { type: 'function', id: 'call-b', name: 'toolB', arguments: '{"y":2}', extras: undefined },
    ]);
  });

  it('hands callbacks deep-copied parts and the final tool calls', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'abc' },
      {
        type: 'function',
        id: 'call-a',
        name: 'toolA',
        arguments: '{}',
      },
    ]);
    const { provider } = createFakeProvider(stream);
    const seenParts: StreamedMessagePart[] = [];
    const seenCalls: ToolCall[] = [];

    const result = await generate(
      provider,
      SYSTEM_PROMPT,
      NO_TOOLS,
      HISTORY,
      {
        onMessagePart: (part) => {
          seenParts.push(structuredClone(part));
          // Mutating the callback's copy must not corrupt the driver's merge.
          if (part.type === 'text') part.text = 'MUTATED';
        },
        onToolCall: (call) => {
          seenCalls.push(call);
        },
      },
    );

    expect(seenParts).toHaveLength(2);
    expect(result.message.content).toEqual([{ type: 'text', text: 'abc' }]);
    expect(seenCalls).toEqual([
      { type: 'function', id: 'call-a', name: 'toolA', arguments: '{}', extras: undefined },
    ]);
  });

  it('filters deferred tools before calling the provider', async () => {
    const stream = new FakeStreamedMessage([{ type: 'text', text: 'ok' }]);
    const { provider, generateSpy } = createFakeProvider(stream);
    const tools: Tool[] = [
      { name: 'visible', description: 'v', parameters: {} },
      { name: 'hidden', description: 'h', parameters: {}, deferred: true },
    ];

    await generate(provider, SYSTEM_PROMPT, tools, HISTORY);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    const sentTools = generateSpy.mock.calls[0]?.[1] as Tool[];
    expect(sentTools.map((tool) => tool.name)).toEqual(['visible']);
  });

  it('rejects an empty response with APIEmptyResponseError', async () => {
    const stream = new FakeStreamedMessage([]);
    const { provider } = createFakeProvider(stream);

    await expect(generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY)).rejects.toBeInstanceOf(
      APIEmptyResponseError,
    );
  });

  it('rejects a thinking-only response with APIEmptyResponseError', async () => {
    const stream = new FakeStreamedMessage([{ type: 'think', think: 'only thinking' }]);
    const { provider } = createFakeProvider(stream);

    await expect(generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY)).rejects.toBeInstanceOf(
      APIEmptyResponseError,
    );
  });

  it('forwards the trace id to onTraceId and the result', async () => {
    const stream = new FakeStreamedMessage([{ type: 'text', text: 'ok' }], {
      traceId: 'trace-123',
    });
    const { provider } = createFakeProvider(stream);
    const onTraceId = vi.fn();

    const result: GenerateResult = await generate(
      provider,
      SYSTEM_PROMPT,
      NO_TOOLS,
      HISTORY,
      undefined,
      { onTraceId },
    );

    expect(onTraceId).toHaveBeenCalledWith('trace-123');
    expect(result.traceId).toBe('trace-123');
  });

  it('reports stream timing stats via onStreamEnd', async () => {
    const stream = new FakeStreamedMessage([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
    const { provider } = createFakeProvider(stream);
    const onStreamEnd = vi.fn();

    await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, { onStreamEnd });

    expect(onStreamEnd).toHaveBeenCalledTimes(1);
    const stats = onStreamEnd.mock.calls[0]?.[0] as
      | { serverDecodeMs: number; clientConsumeMs: number }
      | undefined;
    expect(stats).toBeDefined();
    expect(stats?.serverDecodeMs).toBeGreaterThanOrEqual(0);
    expect(stats?.clientConsumeMs).toBeGreaterThanOrEqual(0);
  });
});

describe('generate() abort contract', () => {
  it('throws the standard abort DOMException when the signal is already aborted', async () => {
    const stream = new FakeStreamedMessage([{ type: 'text', text: 'ok' }]);
    const { provider, generateSpy } = createFakeProvider(stream);
    const controller = new AbortController();
    controller.abort();

    let caught: unknown;
    try {
      await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, {
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(generateSpy).not.toHaveBeenCalled();
  });

  it('cancels the stream and throws the standard abort DOMException on mid-stream abort', async () => {
    const controller = new AbortController();
    const stream = new FakeStreamedMessage(
      [
        { type: 'text', text: 'first' },
        { type: 'text', text: 'second' },
      ],
      {
        onBeforeYield: (index) => {
          if (index === 1) controller.abort();
        },
      },
    );
    const { provider } = createFakeProvider(stream);

    let caught: unknown;
    try {
      await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, {
        signal: controller.signal,
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(DOMException);
    expect((caught as DOMException).name).toBe('AbortError');
    expect(stream.cancelCalls).toBeGreaterThan(0);
  });
});

describe('generate() per-turn intent passthrough', () => {
  it('passes the GenerateOptions intent fields through to the provider', async () => {
    const stream = new FakeStreamedMessage([{ type: 'text', text: 'ok' }]);
    const { provider, generateSpy } = createFakeProvider(stream);
    const options: GenerateOptions = {
      cacheKey: 'session-42',
      sampling: { temperature: 0.7, topP: 0.9 },
      thinking: { effort: 'high', keep: 'all' },
      maxCompletionTokens: 4096,
      usedContextTokens: 1000,
      maxContextTokens: 128000,
    };

    await generate(provider, SYSTEM_PROMPT, NO_TOOLS, HISTORY, undefined, options);

    expect(generateSpy).toHaveBeenCalledTimes(1);
    expect(generateSpy.mock.calls[0]?.[3]).toBe(options);
  });
});
