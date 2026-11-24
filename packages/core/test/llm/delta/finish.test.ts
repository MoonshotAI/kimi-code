// Historical coverage: issue #4964 and #4997; PR #5006 and #5012.
import { describe, expect, it } from 'vitest';

import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { openAIResponsesProtocol } from '#/llm/builtin/protocol/openai-responses/index';

import {
  aimockEndpoint,
  doneOutcome,
  failedOutcome,
  openAIChunk,
  openAICompletion,
  rawMockResponse,
  runGenerate,
  testModule,
  useAimockServer,
} from '../harness';

describe('LLM delta finish boundaries', () => {
  const server = useAimockServer();

  it('as a user, I want incomplete streams to fail while non-streaming responses can complete without a finish event', async () => {
    server().llm.on({ predicate: () => true }, (request) => rawMockResponse(
      'openai-chat',
      request.stream === true
        ? { sse: { events: [openAIChunk({ content: 'incomplete text' })] } }
        : { json: openAICompletion({ content: 'completed text' }) },
    ));

    const incomplete = failedOutcome((await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
    })).outcome);
    expect(incomplete.error).toMatchObject({
      kind: 'provider',
      retryable: true,
      message: expect.stringContaining('without a finish event'),
    });

    const nonStreaming = doneOutcome((await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      stream: false,
    })).outcome);
    expect(nonStreaming.message.content).toEqual([{ type: 'text', text: 'completed text' }]);
  });

  it('as a user, I want a provider error frame to preserve partial content and omit synthetic finish events', async () => {
    server().llm.on({ predicate: () => true }, rawMockResponse('openai-responses', {
      headers: { 'x-request-id': 'req-stream-error' },
      sse: {
        events: [
          { type: 'response.output_text.delta', delta: 'partial' },
          { type: 'error', code: 'server_error', message: 'stream failed' },
        ],
      },
    }));

    const result = await runGenerate(openAIResponsesProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
    });

    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { kind: 'status', message: 'stream failed', retryable: true },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        attributes: { source: 'salvaged' },
      },
    });
    expect(result.events.some((event) => event.type === 'llm.delta.timing')).toBe(true);
    expect(result.events.some((event) => event.type === 'llm.delta.finish')).toBe(false);
    expect(result.events.at(-1)).toMatchObject({ type: 'llm.ended', outcome: { type: 'failed' } });
  });
});
