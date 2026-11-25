import { openAIResponsesProtocol } from '@moonshot-ai/core/llm/builtin/protocol/openai-responses/index';
import { kimiResponsesProtocol } from '@moonshot-ai/core/llm/builtin/provider/kimi/protocol';
import type { StreamedMessagePart } from '@moonshot-ai/core/llm/message';
import { createRequester } from '@moonshot-ai/core/llm/requester';
import { streamLlmRequest } from '@moonshot-ai/core/llm/stream';
import { describe, expect, it } from 'vitest';

import { createMockProvider, withMockProvider } from './scripted-generate';

describe('scripted mock provider', () => {
  it.each([
    ['OpenAI', openAIResponsesProtocol],
    ['Kimi', kimiResponsesProtocol],
  ] as const)('answers a %s Responses request with the scripted text, tool call, usage and finish', async (_name, protocol) => {
    const toolCall = { type: 'function' as const, id: 'call_lookup', name: 'Lookup', arguments: '{"query":"moon"}' };
    const requester = withMockProvider(
      createRequester().with({
        protocol: { base: protocol },
        model: { spec: { provider: 'mock', name: 'mock-model' } },
        policy: { retry: { maxAttemptsPerStep: 1 } },
        endpoint: {
          baseUrl: 'https://provider.example.test/v1',
          credentials: { resolve: () => ({ apiKey: 'test-key' }) },
        },
      }),
      createMockProvider(async () => ({
        id: 'resp-1',
        parts: [{ type: 'text', text: 'Looking it up.' }, toolCall],
        usage: { inputOther: 5, output: 4, inputCacheRead: 1, inputCacheCreation: 0 },
      })),
    );

    const parts: StreamedMessagePart[] = [];
    let ended: unknown;
    for await (const event of streamLlmRequest(
      requester.request({
        profile: { systemPrompt: 'ping', tools: [] },
        content: { messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] },
      }),
      { signal: new AbortController().signal },
    )) {
      if (event.type === 'llm.delta.part') parts.push(event.part);
      if (event.type === 'llm.ended') ended = event.outcome;
    }

    expect(parts).toContainEqual({ type: 'text', text: 'Looking it up.' });
    expect(ended).toMatchObject({
      type: 'done',
      messageId: 'resp-1',
      finish: { finishReason: 'completed', rawFinishReason: 'completed' },
      message: {
        content: [{ type: 'text', text: 'Looking it up.' }],
        toolCalls: [expect.objectContaining({ id: 'call_lookup', name: 'Lookup', arguments: '{"query":"moon"}' })],
      },
      usage: { inputOther: 5, output: 4, inputCacheRead: 1, inputCacheCreation: 0 },
    });
  });
});
