import { openAIResponsesProtocol } from '@moonshot-ai/core/llm/builtin/protocol/openai-responses/index';
import { createRequester } from '@moonshot-ai/core/llm/requester';
import { streamLlmRequest } from '@moonshot-ai/core/llm/stream';
import { describe, expect, it } from 'vitest';

import { createMockProvider, takeScriptedModelProblems, withMockProvider } from './scripted-generate';

describe('scripted mock provider', () => {
  it('fails a Responses-protocol request with a named problem because the testkit model does not answer that protocol', async () => {
    const requester = withMockProvider(
      createRequester().with({
        protocol: { base: openAIResponsesProtocol },
        model: { spec: { provider: 'mock', name: 'mock-model' } },
        policy: { retry: { maxAttemptsPerStep: 1 } },
        endpoint: {
          baseUrl: 'https://provider.example.test/v1',
          credentials: { resolve: () => ({ apiKey: 'test-key' }) },
        },
      }),
      createMockProvider(async () => ({ parts: [{ type: 'text', text: 'unused' }] })),
    );

    let failure: unknown;
    for await (const event of streamLlmRequest(
      requester.request({
        profile: { systemPrompt: 'ping', tools: [] },
        content: { messages: [{ role: 'user', content: [{ type: 'text', text: 'ping' }] }] },
      }),
      { signal: new AbortController().signal },
    )) {
      if (event.type === 'llm.ended' && event.outcome.type === 'failed') failure = event.outcome.error;
    }

    expect(JSON.stringify(failure)).toContain('OpenAI Responses protocol');
    expect(takeScriptedModelProblems()).toEqual([expect.stringContaining('OpenAI Responses protocol')]);
  });
});
