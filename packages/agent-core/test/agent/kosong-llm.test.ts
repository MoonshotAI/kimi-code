import {
  emptyUsage,
  UNKNOWN_CAPABILITY,
  type ChatProvider,
  type Message,
  type ModelCapability,
  type StreamedMessagePart,
  type ToolCall,
} from '@moonshot-ai/kosong';
import { describe, expect, it } from 'vitest';

import {
  KosongLLM,
  downgradeUnsupportedMedia,
  type GenerateFn,
} from '../../src/agent/turn/kosong-llm';
import type { ToolCallDelta } from '../../src/loop';

const provider: ChatProvider = {
  name: 'test',
  modelName: 'test-model',
  thinkingEffort: null,
  async generate() {
    throw new Error('generate should be injected by the test');
  },
  withThinking() {
    return this;
  },
};

describe('KosongLLM streaming tool-call deltas', () => {
  it('maps indexed argument deltas back to the provider tool call id', async () => {
    const deltas = await collectToolCallDeltas([
      {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: null,
        _streamIndex: 0,
      },
      { type: 'tool_call_part', argumentsPart: '{"command"', index: 0 },
      { type: 'tool_call_part', argumentsPart: ':"pwd"}', index: 0 },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_bash', name: 'Bash' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: '{"command"' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: ':"pwd"}' },
    ]);
  });

  it('buffers indexed argument deltas until the provider tool call id is known', async () => {
    const deltas = await collectToolCallDeltas([
      { type: 'tool_call_part', argumentsPart: '{"command"', index: 0 },
      {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: null,
        _streamIndex: 0,
      },
      { type: 'tool_call_part', argumentsPart: ':"pwd"}', index: 0 },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_bash', name: 'Bash' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: '{"command"' },
      { toolCallId: 'call_bash', name: 'Bash', argumentsPart: ':"pwd"}' },
    ]);
    expect(deltas.map((delta) => delta.toolCallId)).not.toContain('0');
  });

  it('uses the latest tool call identity for linear unindexed argument deltas', async () => {
    const deltas = await collectToolCallDeltas([
      {
        type: 'function',
        id: 'call_write',
        name: 'Write',
        arguments: null,
      },
      { type: 'tool_call_part', argumentsPart: '{"path"' },
      { type: 'tool_call_part', argumentsPart: ':"a.txt"}' },
    ]);

    expect(deltas).toEqual([
      { toolCallId: 'call_write', name: 'Write' },
      { toolCallId: 'call_write', name: 'Write', argumentsPart: '{"path"' },
      { toolCallId: 'call_write', name: 'Write', argumentsPart: ':"a.txt"}' },
    ]);
  });
});

describe('KosongLLM stream timing', () => {
  it('returns timing measured from provider request start to stream end', async () => {
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
      options?.onStreamEnd?.();
      return {
        id: 'response-1',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'timed' }],
          toolCalls: [],
        },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new KosongLLM({
      provider,
      systemPrompt: 'system',
      generate,
    });

    const response = await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(response.streamTiming).toMatchObject({
      firstTokenLatencyMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
    });
    expect(response.streamTiming?.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
    expect(response.streamTiming?.streamDurationMs).toBeGreaterThanOrEqual(0);
  });

  it('splits first-token latency across the request-dispatch boundary', async () => {
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      options?.onRequestSent?.();
      await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
      options?.onStreamEnd?.();
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'timed' }], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new KosongLLM({ provider, systemPrompt: 'system', generate });

    const response = await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    const timing = response.streamTiming;
    expect(timing?.requestBuildMs).toBeGreaterThanOrEqual(0);
    expect(timing?.serverFirstTokenMs).toBeGreaterThanOrEqual(0);
    // The two components reconstruct the total (allowing for clock granularity).
    expect((timing?.requestBuildMs ?? 0) + (timing?.serverFirstTokenMs ?? 0)).toBe(
      timing?.firstTokenLatencyMs,
    );
  });

  it('leaves the split undefined when the provider does not report dispatch', async () => {
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      // No onRequestSent — older providers / stubs that do not mark dispatch.
      await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
      options?.onStreamEnd?.();
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'timed' }], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new KosongLLM({ provider, systemPrompt: 'system', generate });

    const response = await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(response.streamTiming?.firstTokenLatencyMs).toBeGreaterThanOrEqual(0);
    expect(response.streamTiming?.requestBuildMs).toBeUndefined();
    expect(response.streamTiming?.serverFirstTokenMs).toBeUndefined();
  });

  it('surfaces the decode wait/consume split reported by the stream', async () => {
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      options?.onRequestSent?.();
      await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
      options?.onStreamEnd?.({ serverDecodeMs: 800, clientConsumeMs: 200 });
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'timed' }], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new KosongLLM({ provider, systemPrompt: 'system', generate });

    const response = await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(response.streamTiming?.serverDecodeMs).toBe(800);
    expect(response.streamTiming?.clientConsumeMs).toBe(200);
  });

  it('leaves the decode split undefined when the stream reports no accounting', async () => {
    const generate: GenerateFn = async (
      _provider,
      _systemPrompt,
      _tools,
      _history,
      callbacks,
      options,
    ) => {
      options?.onRequestStart?.();
      await callbacks?.onMessagePart?.({ type: 'text', text: 'timed' });
      options?.onStreamEnd?.(); // no decode stats
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [{ type: 'text', text: 'timed' }], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new KosongLLM({ provider, systemPrompt: 'system', generate });

    const response = await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(response.streamTiming?.serverDecodeMs).toBeUndefined();
    expect(response.streamTiming?.clientConsumeMs).toBeUndefined();
  });
});

describe('KosongLLM completion budget', () => {
  it('applies the model context window as the completion cap', async () => {
    let appliedCap: number | undefined;
    let generatedProvider: ChatProvider | undefined;
    const providerWithBudget: ChatProvider = {
      ...provider,
      withMaxCompletionTokens(n: number) {
        appliedCap = n;
        return { ...this, withMaxCompletionTokens: this.withMaxCompletionTokens };
      },
    };
    const generate: GenerateFn = async (nextProvider) => {
      generatedProvider = nextProvider;
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new KosongLLM({
      provider: providerWithBudget,
      systemPrompt: 'system',
      capability: makeCapability(10000),
      completionBudgetConfig: { fallback: 32000 },
      generate,
    });

    await llm.chat({
      messages: [],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(appliedCap).toBe(10000);
    expect(generatedProvider).not.toBe(providerWithBudget);
  });
});

async function collectToolCallDeltas(
  parts: readonly StreamedMessagePart[],
): Promise<ToolCallDelta[]> {
  const deltas: ToolCallDelta[] = [];
  const generate: GenerateFn = async (_provider, _systemPrompt, _tools, _history, callbacks) => {
    for (const part of parts) {
      await callbacks?.onMessagePart?.(part);
    }
    return {
      id: 'response-1',
      message: {
        role: 'assistant',
        content: [],
        toolCalls: parts
          .filter((part): part is ToolCall => isToolCall(part))
          .map((toolCall) => stripStreamIndex(toolCall)),
      },
      usage: emptyUsage(),
      finishReason: 'tool_calls',
      rawFinishReason: 'tool_calls',
    };
  };
  const llm = new KosongLLM({
    provider,
    systemPrompt: 'system',
    generate,
  });

  await llm.chat({
    messages: [],
    tools: [],
    signal: new AbortController().signal,
    onToolCallDelta: (delta) => deltas.push(delta),
  });

  return deltas;
}

function isToolCall(part: StreamedMessagePart): part is ToolCall {
  return part.type === 'function';
}

function stripStreamIndex(toolCall: ToolCall): ToolCall {
  const { _streamIndex: _, ...rest } = toolCall;
  return rest;
}

function makeCapability(maxContextTokens: number): ModelCapability {
  return {
    image_in: false,
    video_in: false,
    audio_in: false,
    thinking: false,
    tool_use: true,
    max_context_tokens: maxContextTokens,
  };
}

function mediaMessage(content: Message['content']): Message {
  return { role: 'tool', content, toolCalls: [], toolCallId: 'call_media' };
}

describe('downgradeUnsupportedMedia', () => {
  const imagePart = { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAA' } } as const;
  const videoPart = { type: 'video_url', videoUrl: { url: 'ms://file-1', id: 'file-1' } } as const;
  const audioPart = { type: 'audio_url', audioUrl: { url: 'data:audio/mpeg;base64,AAA' } } as const;

  it('replaces video parts when the model lacks video_in and keeps the rest', () => {
    const capability: ModelCapability = { ...makeCapability(1000), image_in: true, audio_in: true };
    const input = [mediaMessage([{ type: 'text', text: '<video path="a.mp4">' }, videoPart])];

    const out = downgradeUnsupportedMedia(input, capability);

    expect(out[0]?.content).toEqual([
      { type: 'text', text: '<video path="a.mp4">' },
      { type: 'text', text: '[video omitted: current model has no video input]' },
    ]);
  });

  it('replaces image and audio parts when those capabilities are missing', () => {
    const capability: ModelCapability = { ...makeCapability(1000), video_in: true };
    const input = [mediaMessage([imagePart, audioPart, videoPart])];

    const out = downgradeUnsupportedMedia(input, capability);

    expect(out[0]?.content).toEqual([
      { type: 'text', text: '[image omitted: current model has no image input]' },
      { type: 'text', text: '[audio omitted: current model has no audio input]' },
      videoPart,
    ]);
  });

  it('keeps media untouched when the model is capable', () => {
    const capability: ModelCapability = {
      ...makeCapability(1000),
      image_in: true,
      video_in: true,
      audio_in: true,
    };
    const input = [mediaMessage([imagePart, videoPart])];

    const out = downgradeUnsupportedMedia(input, capability);

    expect(out[0]?.content).toEqual([imagePart, videoPart]);
  });

  it('does not downgrade for UNKNOWN_CAPABILITY or an undefined capability', () => {
    const input = [mediaMessage([videoPart])];
    expect(downgradeUnsupportedMedia(input, UNKNOWN_CAPABILITY)[0]?.content).toEqual([videoPart]);
    expect(downgradeUnsupportedMedia(input, undefined)[0]?.content).toEqual([videoPart]);
  });

  it('returns a new array and never mutates the caller input', () => {
    const capability = makeCapability(1000); // all media dropped
    const message = mediaMessage([videoPart]);
    const input = [message];
    const originalContent = message.content;

    const out = downgradeUnsupportedMedia(input, capability);

    expect(out).not.toBe(input);
    expect(out[0]).not.toBe(message);
    expect(message.content).toBe(originalContent);
    expect(message.content[0]).toEqual(videoPart);
  });

  it('KosongLLM strips unsupported video from messages sent to generate', async () => {
    let captured: readonly Message[] | undefined;
    const generate: GenerateFn = async (_p, _s, _t, messages) => {
      captured = messages;
      return {
        id: 'response-1',
        message: { role: 'assistant', content: [], toolCalls: [] },
        usage: emptyUsage(),
        finishReason: 'completed',
        rawFinishReason: 'stop',
      };
    };
    const llm = new KosongLLM({
      provider,
      systemPrompt: '',
      capability: { ...makeCapability(1000), image_in: true },
      generate,
    });

    await llm.chat({
      messages: [mediaMessage([videoPart])],
      tools: [],
      signal: new AbortController().signal,
    });

    expect(captured?.[0]?.content).toEqual([
      { type: 'text', text: '[video omitted: current model has no video input]' },
    ]);
  });
});
