import { TEST_MODEL, testModule } from '../../../harness';
import type { OpenAIResponsesEncodeFixture } from '../types';

const tool = {
  name: 'weather',
  description: 'Get weather',
  parameters: { type: 'object', properties: { city: { type: 'string' } } },
};

export default {
  name: 'input-items-and-params',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: { ...TEST_MODEL.spec, provider: 'openai', name: 'gpt-5-codex' },
      cacheKey: 'cache-1',
      thinking: { effort: 'high' },
      responseFormat: {
        type: 'json_schema',
        jsonSchema: { name: 'answer', schema: { type: 'object' }, strict: true },
      },
      maxOutputTokens: 2048,
      sampling: { temperature: 0, topP: 0.5 },
    },
    profile: {
      systemPrompt: 'Be useful',
      tools: [tool, { ...tool, name: 'later', deferred: true }],
    },
    messages: [
      { role: 'system', content: [{ type: 'text', text: 'Inline system' }] },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'Weather?' },
          { type: 'image_url', imageUrl: { url: 'https://example.test/a.png' } },
          { type: 'audio_url', audioUrl: { url: 'data:audio/wav;base64,AAAA' } },
          { type: 'video_url', videoUrl: { url: 'https://example.test/a.mp4' } },
        ],
      },
    ],
    options: { extras: { user: 'user-1' } },
  }),
  expected: {
    params: {
      model: 'gpt-5-codex',
      instructions: 'Be useful',
      input: [
        {
          type: 'message',
          role: 'developer',
          content: [{ type: 'input_text', text: 'Inline system' }],
        },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'Weather?' },
            { type: 'input_image', detail: 'auto', image_url: 'https://example.test/a.png' },
            { type: 'input_file', file_data: 'AAAA', filename: 'inline.wav' },
            { type: 'input_text', text: '(video omitted: not supported by this provider)' },
          ],
        },
      ],
      tools: [{ type: 'function', ...tool, strict: false }],
      store: false,
      prompt_cache_key: 'cache-1',
      reasoning: { effort: 'high', summary: 'auto' },
      include: ['reasoning.encrypted_content'],
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema: { type: 'object' },
          strict: true,
        },
      },
      max_output_tokens: 2048,
      temperature: 0,
      top_p: 0.5,
      user: 'user-1',
    },
  },
} satisfies OpenAIResponsesEncodeFixture;
