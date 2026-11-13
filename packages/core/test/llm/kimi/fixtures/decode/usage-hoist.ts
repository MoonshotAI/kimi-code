import type { OpenAIRawChunk, OpenAIRawResponse } from '#/llm/builtin/protocol/openai/index';

import type { KimiOpenAIDecodeFixture } from '../types';

const usage = { prompt_tokens: 5, completion_tokens: 1 };

export const kimiOpenAIDecodeFixtures = [{
  name: 'kimi-openai-usage-hoist',
  chunks: [{
    id: 'chat-kimi',
    choices: [{
      delta: { content: 'ok' },
      finish_reason: 'stop',
      usage,
    }],
  }] as unknown as OpenAIRawChunk[],
  expected: [
    { type: 'messageId', messageId: 'chat-kimi' },
    {
      type: 'usage',
      usage: {
        inputOther: 5,
        output: 1,
        inputCacheRead: undefined,
        inputCacheCreation: 0,
        raw: usage,
      },
    },
    { type: 'part', part: { type: 'text', text: 'ok' } },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'stop' } },
  ],
  replay: {
    response: {
      id: 'chat-kimi',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop', usage }],
    } as unknown as OpenAIRawResponse,
  },
}] satisfies KimiOpenAIDecodeFixture[];
