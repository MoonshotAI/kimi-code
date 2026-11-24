// Historical coverage: issue #4584; PR #4586 and #4628.
import { describe, expect, it } from 'vitest';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';

import {
  aimockEndpoint,
  doneOutcome,
  openAIChunk,
  rawMockResponse,
  runGenerate,
  testModule,
  useAimockServer,
} from '../harness';

describe('LLM streamed tool-call boundaries', () => {
  const server = useAimockServer();

  it('as a user, I want every streamed tool call to emit one complete tool_call_end', async () => {
    server().llm.on({ predicate: () => true }, rawMockResponse('openai-chat', {
      sse: {
        events: [
          openAIChunk({
            tool_calls: [{
              index: 0,
              id: 'call_1',
              type: 'function',
              function: { name: 'weather', arguments: '{"city":"Paris"}' },
            }],
          }),
          openAIChunk({
            tool_calls: [{
              index: 1,
              id: 'call_2',
              type: 'function',
              function: { name: 'search', arguments: '{"query":"news"}' },
            }],
          }),
          openAIChunk({}, {
            finishReason: 'tool_calls',
            usage: { prompt_tokens: 2, completion_tokens: 4 },
          }),
        ],
      },
    }));
    const result = await runGenerate(openAIProtocol, {
      module: testModule({
        profile: {
          tools: [
            {
              name: 'weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
            {
              name: 'search',
              description: 'Search',
              parameters: { type: 'object', properties: { query: { type: 'string' } } },
            },
          ],
        },
      }),
      endpoint: aimockEndpoint(server().url),
    });

    expect(doneOutcome(result.outcome).message.toolCalls.map((call) => call.id)).toEqual(['call_1', 'call_2']);
    expect(result.events.filter((event) => event.type === 'llm.delta.tool_call_end').map((event) => event.toolCall.id)).toEqual([
      'call_1',
      'call_2',
    ]);
    expect(result.events.filter((event) => event.type === 'llm.delta.tool_call_end').map((event) => event.index)).toEqual([0, 1]);
  });
});
