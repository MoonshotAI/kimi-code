import { TEST_MODEL, testModule } from '../../../harness';
import type { GoogleGenAIEncodeFixture } from '../types';

const tool = {
  name: 'weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

export default {
  name: 'generation-config',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: { ...TEST_MODEL.spec, provider: 'google', name: 'gemini-3-pro-preview' },
      thinking: { effort: 'high' },
      responseFormat: {
        type: 'json_schema',
        jsonSchema: { name: 'answer', schema: { type: 'object' } },
      },
      maxOutputTokens: 2048,
      sampling: {
        temperature: 0,
        topP: 0.5,
        topK: 10,
        stop: ['END'],
        seed: 7,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
      },
    },
    profile: {
      systemPrompt: 'Be useful',
      tools: [tool, { ...tool, name: 'later', deferred: true }],
    },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Weather?' }] }],
    options: { extras: { candidateCount: 2 } },
  }),
  expected: {
    params: {
      model: 'gemini-3-pro-preview',
      contents: [{ role: 'user', parts: [{ text: 'Weather?' }] }],
      config: {
        systemInstruction: 'Be useful',
        tools: [{
          functionDeclarations: [{
            name: tool.name,
            description: tool.description,
            parametersJsonSchema: tool.parameters,
          }],
        }],
        thinkingConfig: { includeThoughts: true, thinkingLevel: 'HIGH' },
        responseMimeType: 'application/json',
        responseJsonSchema: { type: 'object' },
        maxOutputTokens: 2048,
        temperature: 0,
        topP: 0.5,
        topK: 10,
        stopSequences: ['END'],
        seed: 7,
        presencePenalty: 0.1,
        frequencyPenalty: 0.2,
        candidateCount: 2,
      },
    },
  },
} satisfies GoogleGenAIEncodeFixture;
