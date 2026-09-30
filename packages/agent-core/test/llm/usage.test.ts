import { describe, expect, it } from 'vitest';

import { createStreamDecoder as createAnthropicDecoder } from '#/llm/builtin/protocol/anthropic/decode';
import { createStreamDecoder as createOpenAIDecoder } from '#/llm/builtin/protocol/openai/decode';
import type { DecodeSink } from '#/llm/protocol/protocol';
import type { TokenUsage } from '#/llm/response';

function createSink() {
  const usages: Partial<TokenUsage>[] = [];
  const sink: DecodeSink = {
    onDelta: () => {},
    onFinish: () => {},
    onUsage: (usage) => usages.push(usage),
  };
  return { sink, usages };
}

describe('openAI stream decoder usage', () => {
  it('emits usage from the usage chunk', () => {
    const { sink, usages } = createSink();
    const raw = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
    createOpenAIDecoder()({ choices: [], usage: raw }, sink);
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
    createOpenAIDecoder()({ usage: raw }, sink);
    expect(usages).toEqual([
      { inputOther: 120, output: 50, inputCacheRead: 80, inputCacheCreation: 0, raw },
    ]);
  });
});

describe('anthropic stream decoder usage', () => {
  it('emits message_start input usage and message_delta output usage as they arrive', () => {
    const { sink, usages } = createSink();
    const parse = createAnthropicDecoder();
    const startRaw = {
      input_tokens: 500,
      output_tokens: 1,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    };
    const deltaRaw = { output_tokens: 87 };
    parse({ type: 'message_start', message: { usage: startRaw } }, sink);
    parse({ type: 'message_delta', usage: deltaRaw }, sink);
    expect(usages).toEqual([
      {
        inputOther: 500,
        inputCacheRead: 300,
        inputCacheCreation: 100,
        raw: startRaw,
      },
      { output: 87, raw: deltaRaw },
    ]);

    const alone = createSink();
    createAnthropicDecoder()({ type: 'message_delta', usage: { output_tokens: 87 } }, alone.sink);
    expect(alone.usages).toEqual([{ output: 87, raw: { output_tokens: 87 } }]);
  });
});

describe('stream usage absence', () => {
  it('emits nothing when usage is absent', () => {
    const openAI = createSink();
    const openAIParse = createOpenAIDecoder();
    openAIParse({ choices: [] }, openAI.sink);
    openAIParse({ usage: null }, openAI.sink);
    expect(openAI.usages).toEqual([]);

    const anthropic = createSink();
    createAnthropicDecoder()(
      { type: 'content_block_delta', delta: { text: 'hi' } },
      anthropic.sink,
    );
    expect(anthropic.usages).toEqual([]);
  });
});
