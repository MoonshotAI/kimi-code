import type { AnthropicDecodeFixture } from '../types';

const startUsage = {
  input_tokens: 500,
  output_tokens: 1,
  cache_read_input_tokens: 300,
  cache_creation_input_tokens: 100,
};
const fullUsage = { ...startUsage, output_tokens: 87 };

export default {
  name: 'cache-usage',
  chunks: [
    { type: 'message_start', message: { usage: startUsage } },
    { type: 'message_delta', usage: { output_tokens: 87 } },
  ],
  expected: [
    {
      type: 'usage',
      usage: {
        inputOther: 500,
        inputCacheRead: 300,
        inputCacheCreation: 100,
        raw: startUsage,
      },
    },
    { type: 'usage', usage: { output: 87, raw: { output_tokens: 87 } } },
  ],
  replay: {
    response: { usage: fullUsage },
    expected: [{
      type: 'usage',
      usage: {
        inputOther: 500,
        inputCacheRead: 300,
        inputCacheCreation: 100,
        output: 87,
        raw: fullUsage,
      },
    }],
  },
} satisfies AnthropicDecodeFixture;
