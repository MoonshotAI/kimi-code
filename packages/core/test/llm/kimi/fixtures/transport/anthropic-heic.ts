import { TEST_MODEL, testModule } from '../../../harness';
import type { KimiAnthropicTransportFixture } from '../types';

export default {
  name: 'as a Kimi Anthropic user, I want HEIC images preserved in the raw non-streaming request',
  module: testModule({
    model: {
      ...TEST_MODEL,
      spec: { ...TEST_MODEL.spec, provider: 'kimi', name: 'kimi-for-coding' },
      maxOutputTokens: 1024,
    },
    messages: [{
      role: 'user',
      content: [{ type: 'image_url', imageUrl: { url: 'data:image/heic;base64,AAAA' } }],
    }],
  }),
  endpoint: { baseUrl: 'https://example.test', apiKey: 'test-key' },
  stream: false,
  rawRequest: true,
  response: {
    json: {
      id: 'msg-heic',
      type: 'message',
      role: 'assistant',
      model: 'kimi-for-coding',
      content: [{ type: 'text', text: 'received' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  expected: {
    url: 'https://example.test/v1/messages',
    body: {
      stream: false,
      messages: [{
        role: 'user',
        content: [{
          type: 'image',
          source: { type: 'base64', data: 'AAAA', media_type: 'image/heic' },
          cache_control: { type: 'ephemeral' },
        }],
      }],
    },
    outcome: {
      type: 'done',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'received' }],
        toolCalls: [],
      },
      messageId: 'msg-heic',
    },
  },
} satisfies KimiAnthropicTransportFixture;
