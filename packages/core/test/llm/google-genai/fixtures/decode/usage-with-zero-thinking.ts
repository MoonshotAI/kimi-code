import type { GoogleGenAIDecodeFixture } from '../types';

const usageMetadata = {
  promptTokenCount: 20,
  cachedContentTokenCount: 0,
  candidatesTokenCount: 4,
  thoughtsTokenCount: 0,
  totalTokenCount: 24,
};
const response = {
  candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'STOP' }],
  usageMetadata,
};

export default {
  name: 'usage-with-zero-thinking-tokens',
  chunks: [response],
  expected: [
    {
      type: 'usage',
      usage: {
        inputOther: 20,
        output: 4,
        inputCacheRead: 0,
        inputCacheCreation: 0,
        raw: usageMetadata,
      },
    },
    { type: 'finish', finish: { finishReason: 'completed', rawFinishReason: 'STOP' } },
  ],
  replay: { response },
} satisfies GoogleGenAIDecodeFixture;
