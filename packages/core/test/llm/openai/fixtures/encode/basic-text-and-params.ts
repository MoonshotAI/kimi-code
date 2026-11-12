import { TEST_MODEL, testModule } from '../../../harness';
import type { OpenAIEncodeFixture } from '../types';

const tool = {
  name: 'weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

export default {
  name: 'basic-text-and-params',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: { ...TEST_MODEL.spec, provider: 'openai', name: 'gpt-5.1' },
      cacheKey: 'cache-1',
      thinking: { effort: 'high' },
      responseFormat: {
        type: 'json_schema',
        jsonSchema: {
          name: 'answer',
          schema: { type: 'object' },
          strict: true,
          description: 'Answer schema',
        },
      },
      maxOutputTokens: 200_000,
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
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    options: { extras: { user: 'user-1' } },
  }),
  expected: {
    params: {
      model: 'gpt-5.1',
      messages: [
        { role: 'system', content: 'Be useful' },
        { role: 'user', content: 'Hello' },
      ],
      tools: [{ type: 'function', function: tool }],
      prompt_cache_key: 'cache-1',
      reasoning_effort: 'high',
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          schema: { type: 'object' },
          strict: true,
          description: 'Answer schema',
        },
      },
      max_completion_tokens: 131_072,
      temperature: 0,
      top_p: 0.5,
      top_k: 10,
      stop: ['END'],
      seed: 7,
      presence_penalty: 0.1,
      frequency_penalty: 0.2,
      user: 'user-1',
    },
  },
} satisfies OpenAIEncodeFixture;
