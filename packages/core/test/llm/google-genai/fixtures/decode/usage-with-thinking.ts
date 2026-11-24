import type { GoogleGenAIDecodeFixture } from '../types';

const usageMetadata = {
  promptTokenCount: 1200,
  cachedContentTokenCount: 200,
  candidatesTokenCount: 40,
  thoughtsTokenCount: 900,
  totalTokenCount: 2140,
};
const response = {
  candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
  usageMetadata,
};

export default {
  name: 'usage-with-thinking-and-cached-prompt-tokens',
  chunks: [response],
  expected: [
    {
      type: 'usage',
      usage: {
        inputOther: 1000,
        output: 940,
        inputCacheRead: 200,
        inputCacheCreation: 0,
        raw: usageMetadata,
      },
    },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'STOP' } },
  ],
  replay: { response },
} satisfies GoogleGenAIDecodeFixture;
