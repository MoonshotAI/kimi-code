import type { OpenAIDecodeFixture } from '../types';

const usage = { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150 };

export default {
  name: 'usage-cache-missing',
  chunks: [{ choices: [], usage }],
  expected: [{
    type: 'usage',
    usage: {
      inputOther: 120,
      output: 30,
      inputCacheRead: undefined,
      inputCacheCreation: 0,
      raw: usage,
    },
  }],
  replay: {
    response: { choices: [], usage },
  },
} satisfies OpenAIDecodeFixture;
