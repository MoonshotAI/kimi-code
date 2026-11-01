import { describe, expect, it } from 'vitest';

import type { DecodeSink } from '#/llm/protocol/protocol';
import { createDecoder as createAnthropicDecoder } from '#/llm/builtin/protocol/anthropic/decode';
import { createDecoder as createOpenAIDecoder } from '#/llm/builtin/protocol/openai/decode';
import type { TokenUsage } from '#/llm-requester/usage';

function createSink() {
  const usages: Partial<TokenUsage>[] = [];
  const sink: DecodeSink = {
    onDelta: () => {},
    onFinish: () => {},
    onMessageId: () => {},
    onUsage: (usage) => usages.push(usage),
    onError: () => {},
    onToolCallEnd: () => {},
  };
  return { sink, usages };
}

describe('openai decoder stream usage', () => {
  it('emits usage from the usage chunk', () => {
    const { sink, usages } = createSink();
    const raw = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
    createOpenAIDecoder(sink).push({ choices: [], usage: raw });
    expect(usages).toEqual([
      { inputOther: 120, output: 30, inputCacheRead: 0, inputCacheCreation: 0, raw },
    ]);
  });

  it('splits cached tokens out of the prompt total', () => {
    const { sink, usages } = createSink();
    const raw = {
      prompt_tokens: 200,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 80 },
      completion_tokens_details: { reasoning_tokens: 12 },
    };
    createOpenAIDecoder(sink).push({ usage: raw });
    expect(usages).toEqual([
      { inputOther: 120, output: 50, inputCacheRead: 80, inputCacheCreation: 0, raw },
    ]);
  });

  it('emits nothing for chunks without usage', () => {
    const { sink, usages } = createSink();
    const decoder = createOpenAIDecoder(sink);
    decoder.push({ choices: [] });
    decoder.push({ usage: null });
    expect(usages).toEqual([]);
  });
});

describe('anthropic decoder stream usage', () => {
  it('emits message_start input usage and message_delta output usage as they arrive', () => {
    const { sink, usages } = createSink();
    const decoder = createAnthropicDecoder(sink);
    const startRaw = {
      input_tokens: 500,
      output_tokens: 1,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    };
    const deltaRaw = { output_tokens: 87 };
    decoder.push({ type: 'message_start', message: { usage: startRaw } });
    decoder.push({ type: 'message_delta', usage: deltaRaw });
    expect(usages).toEqual([
      {
        inputOther: 500,
        inputCacheRead: 300,
        inputCacheCreation: 100,
        raw: startRaw,
      },
      { output: 87, raw: deltaRaw },
    ]);
  });

  it('emits a message_delta usage on its own', () => {
    const { sink, usages } = createSink();
    createAnthropicDecoder(sink).push({ type: 'message_delta', usage: { output_tokens: 87 } });
    expect(usages).toEqual([{ output: 87, raw: { output_tokens: 87 } }]);
  });

  it('emits nothing for events without usage', () => {
    const { sink, usages } = createSink();
    createAnthropicDecoder(sink).push({ type: 'content_block_delta', delta: { text: 'hi' } });
    expect(usages).toEqual([]);
  });
});
