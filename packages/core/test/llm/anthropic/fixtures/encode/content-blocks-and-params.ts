import { TEST_MODEL, testModule } from '../../../harness';
import type { AnthropicEncodeFixture } from '../types';

const tool = {
  name: 'weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

export default {
  name: 'content-blocks-and-params',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: {
        ...TEST_MODEL.spec,
        provider: 'anthropic',
        name: 'claude-sonnet-4-5',
        thinking: { supportEfforts: ['low', 'medium', 'high'], adaptiveThinking: false },
      },
      cacheKey: 'cache-1',
      thinking: { effort: 'high' },
      responseFormat: {
        type: 'json_schema',
        jsonSchema: { name: 'answer', schema: { type: 'object' } },
      },
      maxOutputTokens: 100_000,
      sampling: { temperature: 0, topP: 0.5, topK: 10, stop: ['END'] },
    },
    profile: {
      systemPrompt: 'Be useful',
      tools: [tool, { ...tool, name: 'later', deferred: true }],
    },
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: 'Weather?' },
        { type: 'image_url', imageUrl: { url: 'data:image/png;base64,AAAA' } },
        { type: 'audio_url', audioUrl: { url: 'data:audio/wav;base64,CCCC' } },
      ],
    }],
    options: { extras: { top_p: 0.8 } },
  }),
  expected: {
    params: {
      model: 'claude-sonnet-4-5',
      max_tokens: 64_000,
      metadata: { user_id: 'cache-1' },
      thinking: { type: 'enabled', budget_tokens: 32_000 },
      output_config: { format: { type: 'json_schema', schema: { type: 'object' } } },
      temperature: 0,
      top_p: 0.8,
      top_k: 10,
      stop_sequences: ['END'],
      system: [{ type: 'text', text: 'Be useful', cache_control: { type: 'ephemeral' } }],
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'Weather?' },
          { type: 'image', source: { type: 'base64', data: 'AAAA', media_type: 'image/png' } },
          {
            type: 'text',
            text: '(audio omitted: not supported by this provider)',
            cache_control: { type: 'ephemeral' },
          },
        ],
      }],
      tools: [{
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters,
        cache_control: { type: 'ephemeral' },
      }],
    },
    betas: ['interleaved-thinking-2025-05-14'],
    useBetaApi: false,
  },
} satisfies AnthropicEncodeFixture;
