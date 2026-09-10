import { describe, expect, it } from 'vitest';

import type { StreamParseSink } from '#/llm/protocol/format';
import { anthropicFormat } from '#/llm/requester/bases/anthropic/format';
import { openAIFormat } from '#/llm/requester/bases/openai/format';
import type { TokenUsage } from '#/llm/usage';

function createSink() {
  const usages: Partial<TokenUsage>[] = [];
  const sink: StreamParseSink = {
    onDelta: () => {},
    onFinish: () => {},
    onUsage: (usage) => usages.push(usage),
  };
  return { sink, usages };
}

describe('openAIFormat stream usage', () => {
  it('emits usage from the usage chunk', () => {
    const { sink, usages } = createSink();
    const raw = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };
    openAIFormat.createStreamParser()({ choices: [], usage: raw }, sink);
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
    openAIFormat.createStreamParser()({ usage: raw }, sink);
    expect(usages).toEqual([
      { inputOther: 120, output: 50, inputCacheRead: 80, inputCacheCreation: 0, raw },
    ]);
  });

  it('emits nothing for chunks without usage', () => {
    const { sink, usages } = createSink();
    const parse = openAIFormat.createStreamParser();
    parse({ choices: [] }, sink);
    parse({ usage: null }, sink);
    expect(usages).toEqual([]);
  });
});

describe('anthropicFormat stream usage', () => {
  it('emits message_start input usage and message_delta output usage as they arrive', () => {
    const { sink, usages } = createSink();
    const parse = anthropicFormat.createStreamParser();
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
  });

  it('emits a message_delta usage on its own', () => {
    const { sink, usages } = createSink();
    anthropicFormat.createStreamParser()(
      { type: 'message_delta', usage: { output_tokens: 87 } },
      sink,
    );
    expect(usages).toEqual([{ output: 87, raw: { output_tokens: 87 } }]);
  });

  it('emits nothing for events without usage', () => {
    const { sink, usages } = createSink();
    anthropicFormat.createStreamParser()(
      { type: 'content_block_delta', delta: { text: 'hi' } },
      sink,
    );
    expect(usages).toEqual([]);
  });
});
