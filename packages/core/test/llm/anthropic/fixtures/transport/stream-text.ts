import { testModule } from '../../../harness';
import type { AnthropicTransportFixture } from '../types';

const events = [
  {
    type: 'message_start',
    message: {
      id: 'msg-stream',
      type: 'message',
      role: 'assistant',
      model: 'test-model',
      content: [],
      stop_reason: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  {
    type: 'content_block_delta',
    index: 0,
    delta: { type: 'text_delta', text: 'Anthropic 你好' },
  },
  { type: 'content_block_stop', index: 0 },
  {
    type: 'message_delta',
    delta: { stop_reason: 'end_turn' },
    usage: { output_tokens: 2 },
  },
  { type: 'message_stop' },
];

export default {
  name: 'stream-text',
  module: testModule(),
  endpoint: {
    baseUrl: 'https://example.test',
    apiKey: 'test-key',
    headers: { 'x-custom': 'custom' },
  },
  response: {
    headers: { 'request-id': 'req-anthropic-stream' },
    sse: { events, eventNames: true },
  },
  expected: {
    url: 'https://example.test/v1/messages',
    headers: {
      'x-api-key': 'test-key',
      'x-custom': 'custom',
      'anthropic-beta': 'interleaved-thinking-2025-05-14',
    },
    body: {
      model: 'test-model',
      max_tokens: 64_000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
      stream: true,
    },
    outcome: {
      type: 'done',
      requestId: 'req-anthropic-stream',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'Anthropic 你好' }],
        toolCalls: [],
      },
      usage: { inputOther: 1, output: 2 },
      finish: { finishReason: 'completed', rawFinishReason: 'end_turn' },
      messageId: 'msg-stream',
    },
  },
} satisfies AnthropicTransportFixture;
