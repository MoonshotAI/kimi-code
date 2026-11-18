import { describe, expect, it } from 'vitest';

import {
  createAssistantMessage,
  createToolMessage,
  createUserMessage,
  type Message,
  type StreamedMessagePart,
  type ToolCall,
} from '#/llm/message';
import type { LlmModule, Protocol } from '#/llm/protocol/protocol';
import type { FinishInfo, LlmRemoteErrorMessage, TokenUsage } from '#/llm/response';

import {
  asyncChunks,
  doneOutcome,
  failedOutcome,
  runGenerate,
  testModule,
} from './harness';

interface FakeChunk {
  readonly tool?: ToolCall;
  readonly part?: StreamedMessagePart;
  readonly usage?: Partial<TokenUsage>;
  readonly finish?: FinishInfo;
}

function fakeProtocol(options: {
  chunks?: readonly FakeChunk[];
  encode?: (module: LlmModule) => unknown;
  sendStream?: Protocol['sendStream'];
  emitToolCallEnd?: boolean;
  retryable?: boolean;
} = {}): Protocol {
  const chunks = options.chunks ?? [];
  const decode = (chunk: FakeChunk, sink: Parameters<Protocol['decoder']>[1]): void => {
    if (chunk.part !== undefined) sink.onDelta(chunk.part);
    if (chunk.tool !== undefined) {
      sink.onDelta(chunk.tool);
      if (options.emitToolCallEnd !== false) sink.onToolCallEnd(chunk.tool._streamIndex);
    }
    if (chunk.usage !== undefined) sink.onUsage(chunk.usage);
    if (chunk.finish !== undefined) sink.onFinish(chunk.finish);
  };
  return {
    media: { kinds: {} },
    encode: options.encode ?? ((module) => module.content.messages),
    client: () => null,
    send: async () => ({
      body: chunks,
      headers: { 'x-request-id': 'req-success' },
    }),
    sendStream: options.sendStream ?? (async () => ({
      body: asyncChunks(chunks),
      headers: { 'x-request-id': 'req-success' },
    })),
    decoder: (_module, sink) => ({
      push: (chunk) => {
        decode(chunk, sink);
      },
      end: () => {},
    }),
    replay: (response) => response,
    requestId: (headers) => headers['x-request-id'],
    decodeError: (error): LlmRemoteErrorMessage => ({
      kind: 'provider',
      message: error instanceof Error ? error.message : String(error),
      retryable: options.retryable ?? false,
    }),
  };
}

describe('tool argument settlement', () => {
  it('validates deferred tools and retries with a clean correction request', async () => {
    const encoded: (readonly Message[])[] = [];
    let attempts = 0;
    const protocol = fakeProtocol({
      encode: (module) => {
        encoded.push(module.content.messages);
        return module.content.messages;
      },
      sendStream: async () => {
        attempts += 1;
        const tool: ToolCall = {
          type: 'function',
          id: 'call-deferred',
          name: 'weather',
          arguments: attempts === 1 ? '{"city":' : '{"city":"sf"}',
        };
        return {
          body: asyncChunks([
            { tool },
            { finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
          ]),
        };
      },
    });
    const generated = await runGenerate(protocol, {
      module: testModule({
        profile: {
          tools: [{
            name: 'weather',
            description: 'Get weather',
            parameters: {
              type: 'object',
              properties: { city: { type: 'string' } },
              required: ['city'],
            },
            deferred: true,
          }],
        },
      }),
      maxAttemptsPerStep: 2,
    });

    expect(attempts).toBe(2);
    expect(doneOutcome(generated.outcome).message.toolCalls).toMatchObject([
      { name: 'weather', arguments: '{"city":"sf"}' },
    ]);
    expect(generated.events.find((event) => event.type === 'llm.retry')).toMatchObject({
      reason: 'invalid_tool_arguments',
      failedAttempt: 1,
      nextAttempt: 2,
      delayMs: 0,
      error: { kind: 'invalid_tool_arguments', retryable: true },
    });
    expect(encoded).toHaveLength(2);
    expect(encoded[1]?.at(-1)).toMatchObject({ role: 'assistant', toolCalls: [] });
    expect(JSON.stringify(encoded[1]?.at(-1))).toContain('not executed');
  });

  it('rejects non-object and unapproved empty arguments without executing or normalizing them', async () => {
    const run = (args: string | null, required = true, stream = true) => {
      const tool: ToolCall = {
        type: 'function',
        id: 'call-arguments',
        name: 'weather',
        arguments: args,
      };
      return runGenerate(fakeProtocol({
        chunks: [
          { tool },
          { finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
        ],
      }), {
        module: testModule({
          profile: {
            tools: [{
              name: 'weather',
              description: 'Get weather',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: required ? ['city'] : [],
              },
            }],
          },
        }),
        stream,
      });
    };

    for (const args of [null, '', 'null', '[]', '42', '"text"', '{"city":']) {
      const generated = await run(args);
      const failed = failedOutcome(generated.outcome);
      expect(failed.error).toMatchObject({ kind: 'invalid_tool_arguments', retryable: true });
      expect(failed.message?.toolCalls).toEqual([]);
      expect(failed.message?.content.at(-1)).toMatchObject({
        type: 'text',
        text: expect.stringContaining('not executed'),
      });
      expect(generated.events.some((event) => event.type === 'llm.delta.tool_call_end')).toBe(false);
    }

    const replayed = failedOutcome((await run('null', true, false)).outcome);
    expect(replayed.error.kind).toBe('invalid_tool_arguments');

    const empty = doneOutcome((await run('', false)).outcome);
    expect(empty.message.toolCalls[0]?.arguments).toBe('');
  });

  it('drops invalid historical calls and paired results while preserving valid content', async () => {
    const encoded: (readonly Message[])[] = [];
    const history: Message[] = [
      createAssistantMessage(
        [{ type: 'text', text: 'checking' }],
        [
          { type: 'function', id: 'good', name: 'weather', arguments: '{}' },
          { type: 'function', id: 'bad-wire', name: 'weather', arguments: 'null' },
          { type: 'function', id: 'bad-schema', name: 'required', arguments: '{}' },
        ],
      ),
      createToolMessage('good', 'sunny'),
      createToolMessage('bad-wire', 'invalid'),
      createToolMessage('bad-schema', 'invalid'),
      createUserMessage('continue'),
    ];
    const protocol = fakeProtocol({
      encode: (module) => {
        encoded.push(module.content.messages);
        return module.content.messages;
      },
      chunks: [
        { part: { type: 'text', text: 'done' }, finish: { finishReason: 'completed', rawFinishReason: 'stop' } },
      ],
    });
    await runGenerate(protocol, {
      module: testModule({
        messages: history,
        profile: {
          tools: [
            {
              name: 'weather',
              description: 'Get weather',
              parameters: { type: 'object', properties: { city: { type: 'string' } } },
            },
            {
              name: 'required',
              description: 'Requires city',
              parameters: {
                type: 'object',
                properties: { city: { type: 'string' } },
                required: ['city'],
              },
            },
          ],
        },
      }),
    });

    const messages = encoded[0]!;
    expect(messages[0]).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'checking' },
        { type: 'text', text: expect.stringContaining('A previous call') },
        { type: 'text', text: expect.stringContaining('A previous call') },
      ],
      toolCalls: [{ id: 'good', arguments: '{}' }],
    });
    expect(messages.filter((message) => message.role === 'tool')).toMatchObject([
      { toolCallId: 'good' },
    ]);
    expect(messages.at(-1)).toMatchObject({ role: 'user' });
  });
});
