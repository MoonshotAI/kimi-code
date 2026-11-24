// Historical coverage: issue #96, #2226 and #2506; PR #3601.
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

describe('LLM streamed message parts', () => {
  const server = useAimockServer();

  it('as a user, I want reasoning and text parts to keep their order and adjacent text to accumulate', async () => {
    server().llm.on({ predicate: () => true }, rawMockResponse('openai-chat', {
      sse: {
        events: [
          openAIChunk({ reasoning_content: 'reasoning' }),
          openAIChunk({ content: 'answer' }),
          openAIChunk({ content: ' complete' }),
          openAIChunk({}, { finishReason: 'stop' }),
        ],
      },
    }));
    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
    });

    expect(doneOutcome(result.outcome).message.content).toEqual([
      { type: 'think', think: 'reasoning', reasoningKey: 'reasoning_content' },
      { type: 'text', text: 'answer complete' },
    ]);
    expect(result.events.filter((event) => event.type === 'llm.delta.part').map((event) => event.part.type)).toEqual([
      'think',
      'text',
      'text',
    ]);
  });
});
