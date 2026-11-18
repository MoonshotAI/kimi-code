import type { OpenAIDecodeFixture } from '../types';

const usage = { prompt_tokens: 5, completion_tokens: 1 };

export default {
  name: 'usage-choice',
  chunks: [{
    id: 'chat-choice',
    choices: [{
      delta: { content: 'ok' },
      finish_reason: 'stop',
      usage,
    }],
  }],
  expected: [
    { type: 'messageId', messageId: 'chat-choice' },
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
      id: 'chat-choice',
      choices: [{ message: { content: 'ok' }, finish_reason: 'stop', usage }],
    },
  },
} satisfies OpenAIDecodeFixture;
