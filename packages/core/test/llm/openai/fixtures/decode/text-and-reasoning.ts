import type { OpenAIDecodeFixture } from '../types';

const usage = {
  prompt_tokens: 10,
  completion_tokens: 3,
  prompt_tokens_details: { cached_tokens: 2 },
};

export default {
  name: 'text-and-reasoning',
  chunks: [
    { id: 'chat-1', choices: [{ delta: { reasoning_content: 'reason' } }] },
    { choices: [{ delta: { content: 'Hello' } }] },
    { choices: [{ delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage },
  ],
  expected: [
    { type: 'messageId', messageId: 'chat-1' },
    { type: 'part', part: { type: 'think', think: 'reason', reasoningKey: 'reasoning_content' } },
    { type: 'part', part: { type: 'text', text: 'Hello' } },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'stop' } },
    {
      type: 'usage',
      usage: {
        inputOther: 8,
        output: 3,
        inputCacheRead: 2,
        inputCacheCreation: 0,
        raw: usage,
      },
    },
  ],
  replay: {
    response: {
      id: 'chat-1',
      choices: [{
        message: { reasoning_content: 'reason', content: 'Hello' },
        finish_reason: 'stop',
      }],
      usage,
    },
    expected: [
      { type: 'messageId', messageId: 'chat-1' },
      {
        type: 'usage',
        usage: {
          inputOther: 8,
          output: 3,
          inputCacheRead: 2,
          inputCacheCreation: 0,
          raw: usage,
        },
      },
      { type: 'part', part: { type: 'think', think: 'reason', reasoningKey: 'reasoning_content' } },
      { type: 'part', part: { type: 'text', text: 'Hello' } },
      { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'stop' } },
    ],
  },
} satisfies OpenAIDecodeFixture;
