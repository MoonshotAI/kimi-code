import { describe, expect, it } from 'vitest';

import {
  createAssistantMessage,
  createMessageAccumulator,
  createToolMessage,
  createUserMessage,
  type AssistantMessage,
  type StreamedMessagePart,
  type ToolCall,
} from '#/llm/message';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { SyntaxRequestFormatError } from '#/llm/protocol/errors';
import type { LlmModule, Protocol } from '#/llm/protocol/protocol';
import { emptyResponseError } from '#/llm/policy/settle';
import type { LlmModelSpec } from '#/llm/request';
import {
  NO_FINISH,
  type FinishInfo,
  type LlmRemoteErrorMessage,
  type TokenUsage,
} from '#/llm/response';

import {
  asyncChunks,
  doneOutcome,
  failedOutcome,
  runGenerate,
  testModule,
} from './harness';

interface FakeChunk {
  readonly id?: string;
  readonly text?: string;
  readonly tool?: ToolCall;
  readonly usage?: Partial<TokenUsage>;
  readonly finish?: FinishInfo;
}

function fakeProtocol(
  options: {
    chunks?: readonly FakeChunk[];
    encode?: (module: LlmModule) => unknown;
    sendStream?: Protocol['sendStream'];
  } = {},
): Protocol {
  const chunks = options.chunks ?? [];
  const decode = (chunk: FakeChunk, sink: Parameters<Protocol['decoder']>[1]): void => {
    if (chunk.id !== undefined) sink.onMessageId(chunk.id);
    if (chunk.text !== undefined) sink.onDelta({ type: 'text', text: chunk.text });
    if (chunk.tool !== undefined) {
      sink.onDelta(chunk.tool);
      sink.onToolCallEnd(chunk.tool._streamIndex);
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
      retryable: false,
    }),
  };
}

function accumulatedMessage(parts: readonly StreamedMessagePart[]): AssistantMessage {
  const accumulator = createMessageAccumulator();
  for (const part of parts) accumulator.push(part);
  return accumulator.finish();
}

describe('LLM request settlement', () => {
  it('emits ordered facts and gives streaming and replay the same final Message semantics', async () => {
    const finish = { finishReason: 'tool_calls', rawFinishReason: 'stop' } as const;
    const tool: ToolCall = {
      type: 'function',
      id: 'call_1',
      name: 'weather',
      arguments: '{}',
      _streamIndex: 0,
    };
    const protocol = fakeProtocol({
      chunks: [
        { id: 'msg-1', text: 'hello' },
        { tool },
        {
          usage: { inputOther: 8, output: 2, inputCacheCreation: 0 },
          finish,
        },
      ],
    });

    const streamed = await runGenerate(protocol, { module: testModule() });
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
      'llm.sent',
      'llm.streaming.headers',
      'llm.streaming.request_id',
      'llm.streaming.message_id',
      'llm.streaming.part',
      'llm.streaming.part',
      'llm.streaming.tool_call_end',
      'llm.streaming.usage',
      'llm.streaming.finish',
      'llm.timing',
      'llm.ended',
    ]);
    expect(streamed.events.at(-1)).toMatchObject({ type: 'llm.ended', outcome: done });

    const replayed = doneOutcome((await runGenerate(protocol, {
      module: testModule(),
      stream: false,
    })).outcome);
    expect(replayed.message).toEqual(done.message);
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

  it('classifies empty and thinking-only responses without rejecting visible output', () => {
    const model: LlmModelSpec = { provider: 'test', name: 'test-model' };
    const empty = accumulatedMessage([]);
    expect(emptyResponseError(empty, model, NO_FINISH)).toMatchObject({
      kind: 'empty_response',
      finishReason: null,
      rawFinishReason: null,
      retryable: true,
    });
    expect(emptyResponseError(empty, model, {
      finishReason: 'filtered',
      rawFinishReason: 'content_filter',
    })).toMatchObject({ kind: 'empty_response', retryable: false });
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'think', think: 'reasoning' }]), model, NO_FINISH)
        ?.message,
    ).toContain('only thinking content');
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: '  \n' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([
          { type: 'think', think: 'reasoning' },
          { type: 'text', text: ' ' },
        ]),
        model,
        NO_FINISH,
      )?.message,
    ).toContain('only thinking content');
    expect(
      emptyResponseError(accumulatedMessage([{ type: 'text', text: 'hi' }]), model, NO_FINISH),
    ).toBeNull();
    expect(
      emptyResponseError(
        accumulatedMessage([{ type: 'function', id: 'call_1', name: 'tool', arguments: '{}' }]),
        model,
        NO_FINISH,
      ),
    ).toBeNull();
  });

  it('returns syntax and provider failures and preserves partial Message output on abort', async () => {
    const syntax = failedOutcome((await runGenerate(fakeProtocol({
      encode: () => {
        throw new SyntaxRequestFormatError('bad request');
      },
    }), { module: testModule() })).outcome);
    expect(syntax.error).toMatchObject({ kind: 'syntax', code: 'request_format' });

    const provider = failedOutcome((await runGenerate(fakeProtocol({
      sendStream: async () => {
        throw new Error('provider unavailable');
      },
    }), { module: testModule() })).outcome);
    expect(provider.error).toMatchObject({
      kind: 'provider',
      message: 'provider unavailable',
      retryable: false,
    });

    const controller = new AbortController();
    const aborted = await runGenerate(fakeProtocol({
      sendStream: async () => ({
        body: (async function* () {
          yield { text: 'partial' };
          controller.abort();
          throw new DOMException('The operation was aborted.', 'AbortError');
        })(),
      }),
    }), { module: testModule(), signal: controller.signal });
    expect(aborted.outcome).toMatchObject({
      type: 'aborted',
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial' }],
        toolCalls: [],
        attributes: { source: 'salvaged' },
      },
      reason: { kind: 'abort' },
    });
    expect(aborted.events.at(-1)).toMatchObject({
      type: 'llm.ended',
      outcome: { type: 'aborted' },
    });
  });
});
