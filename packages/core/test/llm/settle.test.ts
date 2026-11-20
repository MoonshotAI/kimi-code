import { describe, expect, it } from 'vitest';

import {
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
    const module = testModule({
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
    });
    const generated = await runGenerate(protocol, {
      module,
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
    expect(encoded[1]?.at(-1)).toMatchObject({ role: 'system' });
    expect(JSON.stringify(encoded[1]?.at(-1))).toContain('not executed');

    attempts = 0;
    const infinite = await runGenerate(protocol, { module, infiniteRetry: true });
    expect(doneOutcome(infinite.outcome).message.toolCalls).toMatchObject([
      { name: 'weather', arguments: '{"city":"sf"}' },
    ]);
    const infiniteDelays = infinite.events.flatMap((event) =>
      event.type === 'llm.retry' && event.reason === 'invalid_tool_arguments'
        ? [event.delayMs]
        : []
    );
    expect(infiniteDelays).toHaveLength(1);
    expect(infiniteDelays[0]).toBeGreaterThan(0);
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
      expect(failed.message).toBeUndefined();
      expect(generated.events.some((event) => event.type === 'llm.delta.tool_call_end')).toBe(false);
    }

    const replayed = failedOutcome((await run('null', true, false)).outcome);
    expect(replayed.error.kind).toBe('invalid_tool_arguments');

    const empty = doneOutcome((await run('', false)).outcome);
    expect(empty.message.toolCalls[0]?.arguments).toBe('');
  });

  it('preserves correction feedback across transient retries', async () => {
    const encoded: (readonly Message[])[] = [];
    let attempts = 0;
    const profile = {
      tools: [{
        name: 'weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      }],
    };
    const protocol = fakeProtocol({
      retryable: true,
      encode: (module) => {
        encoded.push(module.content.messages);
        return module.content.messages;
      },
      sendStream: async () => {
        attempts += 1;
        if (attempts === 2) throw new Error('temporary 429');
        const tool: ToolCall = {
          type: 'function',
          id: 'call-weather',
          name: 'weather',
          arguments: attempts === 1 ? '{"city":' : '{"city":"sf"}',
        };
        return {
          body: asyncChunks([
            { tool },
            { usage: attempts === 1 ? { inputOther: 2, output: 1 } : { inputOther: 4, output: 3 } },
            { finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
          ]),
        };
      },
    });
    const generated = await runGenerate(protocol, {
      module: testModule({ profile }),
      maxAttemptsPerStep: 3,
    });

    expect(attempts).toBe(3);
    expect(doneOutcome(generated.outcome).usage).toMatchObject({ inputOther: 4, output: 3 });
    expect(doneOutcome(generated.outcome).message.attributes?.usage).toMatchObject({ inputOther: 4, output: 3 });
    expect(generated.events.filter((event) => event.type === 'llm.retry').map((event) => event.reason)).toEqual([
      'invalid_tool_arguments',
      'backoff',
    ]);
    expect(encoded[2]?.at(-1)).toMatchObject({ role: 'system' });
    expect(JSON.stringify(encoded[2]?.at(-1))).toContain('not executed');

    const rejected = failedOutcome((await runGenerate(fakeProtocol({
      chunks: [
        { part: { type: 'text', text: 'I will call weather' } },
        { tool: { type: 'function', id: 'call-rejected', name: 'weather', arguments: '{"city":' } },
        { usage: { inputOther: 2, output: 1 } },
        { finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
      ],
    }), {
      module: testModule({ profile }),
      maxAttemptsPerStep: 1,
    })).outcome);
    expect(rejected.message).toBeUndefined();
  });

  it('validates finalized calls when tool-call-end is missing or arrives before later deltas', async () => {
    const profile = {
      tools: [{
        name: 'weather',
        description: 'Get weather',
        parameters: {
          type: 'object',
          properties: { city: { type: 'string' } },
          required: ['city'],
        },
      }],
    };
    const missingBoundary = failedOutcome((await runGenerate(fakeProtocol({
      emitToolCallEnd: false,
      chunks: [
        { tool: { type: 'function', id: 'call-missing', name: 'weather', arguments: 'null' } },
        { finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
      ],
    }), { module: testModule({ profile }) })).outcome);
    expect(missingBoundary.error.kind).toBe('invalid_tool_arguments');

    const completed = doneOutcome((await runGenerate(fakeProtocol({
      chunks: [
        { tool: { type: 'function', id: 'call-interleaved', name: 'weather', arguments: '{"city":', _streamIndex: 0 } },
        { part: { type: 'tool_call_part', argumentsPart: '"sf"}', index: 0 } },
        { finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
      ],
    }), { module: testModule({ profile }) })).outcome);
    expect(completed.message.toolCalls).toMatchObject([
      { id: 'call-interleaved', arguments: '{"city":"sf"}' },
    ]);
  });

  it('treats schema compilation failures as deterministic configuration errors', async () => {
    const generated = await runGenerate(fakeProtocol({
      chunks: [
        { tool: { type: 'function', id: 'call-broken', name: 'broken', arguments: '{}' } },
        { finish: { finishReason: 'tool_calls', rawFinishReason: 'stop' } },
      ],
    }), {
      module: testModule({
        profile: {
          tools: [{
            name: 'broken',
            description: 'Broken schema',
            parameters: { $ref: '#/definitions/missing' },
          }],
        },
      }),
      maxAttemptsPerStep: 2,
    });

    expect(failedOutcome(generated.outcome).error).toMatchObject({
      kind: 'syntax',
      code: 'request_format',
    });
    expect(generated.events.some((event) => event.type === 'llm.retry')).toBe(false);
  });
});
