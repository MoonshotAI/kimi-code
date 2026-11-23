// Historical coverage: PR #101 (stream timing), PR #1448 (request trace), PR #3624 (retry lifecycle), PR #4820 (DI-free LLM core).
import { describe, expect, it } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
} from '#/llm/message';

import {
  aimockEndpoint,
  doneOutcome,
  openAIChunk,
  openAICompletion,
  rawMockResponse,
  runGenerate,
  testModule,
  useAimockServer,
} from '../harness';

describe('LLM run boundaries', () => {
  const server = useAimockServer();

  it('as an event consumer, I want streaming and replay to share message semantics and ordered run events', async () => {
    const finish = { finishReason: 'tool_calls', rawFinishReason: 'tool_calls' } as const;
    const toolCall = {
      type: 'function',
      id: 'call_1',
      function: { name: 'weather', arguments: '{}' },
    };
    const usage = {
      prompt_tokens: 8,
      completion_tokens: 2,
      total_tokens: 10,
      prompt_tokens_details: { cached_tokens: 0 },
    };
    server().llm.on({ predicate: () => true }, (request) => rawMockResponse(
      'openai-chat',
      request.stream === true
        ? {
            headers: { 'x-request-id': 'req-success' },
            sse: {
              events: [
                openAIChunk({ role: 'assistant', content: 'hello' }, { id: 'msg-1' }),
                openAIChunk({ tool_calls: [{ index: 0, ...toolCall }] }),
                openAIChunk({}, { finishReason: 'tool_calls', usage }),
              ],
            },
          }
        : {
            headers: { 'x-request-id': 'req-success' },
            json: openAICompletion(
              { content: 'hello', tool_calls: [toolCall] },
              { id: 'msg-1', finishReason: 'tool_calls', usage },
            ),
          },
    ));

    const streamed = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
    });
    const done = doneOutcome(streamed.outcome);
    expect(done.message).toMatchObject({
      role: 'assistant',
      content: [{ type: 'text', text: 'hello' }],
      toolCalls: [{
        type: 'function',
        id: 'call_1',
        name: 'weather',
        arguments: '{}',
      }],
      attributes: {
        source: 'llm',
        model: { provider: 'test', model: 'test-model' },
        finish,
        messageId: 'msg-1',
      },
    });
    expect(done.usage).toMatchObject({ inputOther: 8, output: 2 });
    expect(done.requestId).toBe('req-success');
    expect(done.timing).toMatchObject({
      firstTokenLatencyMs: expect.any(Number),
      streamDurationMs: expect.any(Number),
    });
    expect(streamed.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.requested',
      'llm.delta.response_header',
      'llm.delta.request_id',
      'llm.delta.message_id',
      'llm.delta.part',
      'llm.delta.part',
      'llm.delta.usage',
      'llm.delta.tool_call_end',
      'llm.delta.finish',
      'llm.delta.timing',
      'llm.ended',
    ]);
    expect(streamed.events[1]).toMatchObject({
      type: 'llm.requested',
      provider: 'test',
      model: 'test-model',
      systemPromptHash: expect.any(String),
      toolsHash: expect.any(String),
      messageCount: 1,
      attempt: '1',
    });
    expect(streamed.events[1]).not.toHaveProperty('messages');
    expect(streamed.events[1]).not.toHaveProperty('tools');
    expect(streamed.events.at(-1)).toMatchObject({ type: 'llm.ended', outcome: done });

    const replayed = doneOutcome((await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      stream: false,
    })).outcome);
    expect(replayed.message.content).toEqual(done.message.content);
    expect(replayed.message.toolCalls).toEqual(done.message.toolCalls);
    expect(replayed.message.attributes).toMatchObject({ finish, messageId: 'msg-1' });
    expect(replayed.usage).toEqual(done.usage);
    expect(replayed.finish).toEqual(done.finish);
    expect(replayed.requestId).toBe(done.requestId);

    const encoded = openAIProtocol.encode(testModule({
      messages: [
        createUserMessage('run tool', { promptId: 'p-1', origin: { kind: 'user' } }),
        createAssistantMessage([], [{ type: 'function', id: 'call_1', name: 'weather', arguments: '{}' }]),
        createToolMessage('call_1', 'boom', { isError: true, stopTurn: true }),
      ],
    }));
    expect(encoded.params.messages).toEqual([
      { role: 'user', content: 'run tool' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'weather', arguments: '{}' } }],
      },
      {
        role: 'tool',
        tool_call_id: 'call_1',
        content: '<system>ERROR: Tool execution failed.</system>\nboom',
      },
    ]);
  });

  it('as a user, I want resolver failures to end without requested or synthetic delta events', async () => {
    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      policy: {
        resolvers: [{
          id: 'fail-resolution',
          resolve: async () => {
            throw new Error('resolver failed');
          },
        }],
      },
    });

    expect(result.outcome).toMatchObject({
      type: 'failed',
      error: { message: 'resolver failed' },
    });
    expect(result.events.map((event) => event.type)).toEqual([
      'llm.started',
      'llm.ended',
    ]);
    expect(server().llm.getRequests()).toHaveLength(0);
  });

  it('as a user, I want cancellation before generation to prevent any provider request', async () => {
    const controller = new AbortController();
    controller.abort('stop before start');

    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      signal: controller.signal,
    });

    expect(result.outcome).toMatchObject({ type: 'aborted', message: null });
    expect(result.events.map((event) => event.type)).toEqual(['llm.started', 'llm.ended']);
    expect(server().llm.getRequests()).toHaveLength(0);
  });

  it('as a user, I want cancellation during resolution to prevent any provider request', async () => {
    const controller = new AbortController();
    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      signal: controller.signal,
      policy: {
        resolvers: [{
          id: 'cancel-resolution',
          resolve: async (request) => {
            controller.abort('stop resolving');
            return request;
          },
        }],
      },
    });

    expect(result.outcome).toMatchObject({ type: 'aborted', message: null });
    expect(result.events.map((event) => event.type)).toEqual(['llm.started', 'llm.ended']);
    expect(server().llm.getRequests()).toHaveLength(0);
  });

  it('as an event consumer, I want resolver rewrites to emit a notice before the requested summary', async () => {
    server().llm.on({ predicate: () => true }, rawMockResponse('openai-chat', {
      sse: { events: [openAIChunk({ content: 'ok' }, { finishReason: 'stop' })] },
    }));

    const result = await runGenerate(openAIProtocol, {
      module: testModule(),
      endpoint: aimockEndpoint(server().url),
      policy: {
        resolvers: [{
          id: 'test-resolver',
          resolve: async (request, { report }) => {
            report({ code: 'request_rewritten', message: 'Resolver rewrote the request.' });
            return { ...request, model: { ...request.model, cacheKey: 'resolved' } };
          },
        }],
      },
    });

    expect(result.outcome.type).toBe('done');
    expect(result.events.slice(0, 3).map((event) => event.type)).toEqual([
      'llm.started',
      'llm.notice',
      'llm.requested',
    ]);
    expect(result.events[1]).toMatchObject({
      type: 'llm.notice',
      notice: { source: 'test-resolver', code: 'request_rewritten' },
    });
    expect(server().llm.getRequests()[0]?.body).toMatchObject({ prompt_cache_key: 'resolved' });
  });

  it('as an event consumer, I want encoder adjustments to emit a notice within the requested attempt', async () => {
    server().llm.on({ predicate: () => true }, rawMockResponse('anthropic', {
      headers: { 'request-id': 'req-notice' },
      json: {
        id: 'msg-notice',
        type: 'message',
        role: 'assistant',
        model: 'test-model',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }));

    const result = await runGenerate(anthropicProtocol, {
      module: testModule({
        model: {
          spec: {
            provider: 'anthropic',
            name: 'test-model',
            capability: { thinking: true },
            thinking: { supportEfforts: ['low'] },
          },
          thinking: { effort: 'custom' },
          maxOutputTokens: 1024,
        },
      }),
      endpoint: aimockEndpoint(server().url, ''),
      stream: false,
    });

    expect(result.outcome.type).toBe('done');
    expect(result.events.slice(0, 3).map((event) => event.type)).toEqual([
      'llm.started',
      'llm.requested',
      'llm.notice',
    ]);
    expect(result.events[2]).toMatchObject({
      type: 'llm.notice',
      notice: {
        source: 'legalize-model',
        code: 'anthropic-thinking-effort-not-listed',
        data: { effort: 'custom', knownEfforts: ['low'] },
      },
    });
  });
});
