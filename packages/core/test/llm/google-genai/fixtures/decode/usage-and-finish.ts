import type { GoogleGenAIDecodeFixture } from '../types';

const usageMetadata = {
  promptTokenCount: 20,
  cachedContentTokenCount: 0,
  candidatesTokenCount: 4,
};
const response = {
  candidates: [{ content: { role: 'model', parts: [] }, finishReason: 'MAX_TOKENS' }],
  usageMetadata,
};

export default {
  name: 'usage-and-finish',
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
    { type: 'finish', finish: { finishReason: 'truncated', rawFinishReason: 'MAX_TOKENS' } },
  ],
  replay: { response },
} satisfies GoogleGenAIDecodeFixture;
