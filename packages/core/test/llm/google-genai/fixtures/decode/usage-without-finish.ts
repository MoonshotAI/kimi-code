import type { GoogleGenAIDecodeFixture } from '../types';

const firstUsage = {
  promptTokenCount: 18,
  cachedContentTokenCount: 0,
  candidatesTokenCount: 4,
};
const secondUsage = {
  promptTokenCount: 18,
  cachedContentTokenCount: 0,
  candidatesTokenCount: 20,
};

export default {
  name: 'usage-without-finish',
  chunks: [
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '1' }] } }],
      usageMetadata: firstUsage,
    },
    {
      candidates: [{ content: { role: 'model', parts: [{ text: '\n2' }] } }],
      usageMetadata: secondUsage,
    },
  ],
  expected: [
    {
      type: 'usage',
      usage: {
        inputOther: 18,
        output: 4,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: firstUsage,
      },
    },
    { type: 'part', part: { type: 'text', text: '1' } },
    {
      type: 'usage',
      usage: {
        inputOther: 18,
        output: 20,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: secondUsage,
      },
    },
    { type: 'part', part: { type: 'text', text: '\n2' } },
  ],
} satisfies GoogleGenAIDecodeFixture;
