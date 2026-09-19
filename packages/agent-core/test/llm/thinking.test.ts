import { describe, expect, it } from 'vitest';

import { bindOpenAI } from '#/llm/builtin/protocol/openai/index';
import {
  createAssistantMessage,
  createMessageAccumulator,
  createUserMessage,
  type Message,
} from '#/llm/message';
import { UNKNOWN_CAPABILITY, type LlmModel } from '#/llm/model';
import { createRequesterFromHandle } from '#/llm/protocol/runner';
import type { LlmClientContext } from '#/llm/requester/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const messages: readonly Message[] = [createUserMessage('hi')];

function chatCompletionChunks(
  deltas: readonly Record<string, unknown>[] = [{ role: 'assistant', content: 'hi' }],
): Record<string, unknown>[] {
  return deltas.map((delta) => ({
    id: 'chatcmpl-1',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test-model',
    choices: [{ index: 0, delta, finish_reason: null }],
  }));
}

function createAsyncStream<T>(chunks: readonly T[]): AsyncIterable<T> {
  return {
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) {
        yield chunk;
      }
    },
  };
}

function openAIClient(
  chunks: readonly Record<string, unknown>[],
  captured?: Record<string, unknown>[],
): unknown {
  return {
    chat: {
      completions: {
        create: (params: Record<string, unknown>) => {
          captured?.push(params);
          return {
            withResponse: async () => ({
              data: createAsyncStream(chunks),
              response: new Response(null),
            }),
          };
        },
      },
    },
  };
}

function stubOpenAIClient(chunks: readonly Record<string, unknown>[]): {
  clientFactory: (request: LlmClientContext) => never;
  body: () => Record<string, unknown>;
} {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () => openAIClient(chunks, captured) as never,
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

function assistantOf(body: Record<string, unknown>): Record<string, unknown> {
  const assistant = (body['messages'] as Record<string, unknown>[] | undefined)?.[1];
  if (assistant === undefined) throw new Error('expected assistant message');
  return assistant;
}

describe('openai requester reasoning key', () => {
  it('stamps each inbound reasoning field and writes them back on the next request', async () => {
    const inbound = stubOpenAIClient(
      chatCompletionChunks([
        {
          reasoning_content: 'A',
          reasoning: 'B',
          reasoning_details: [
            { index: 0, type: 'summary', summary: '摘' },
            { index: 1, type: 'encrypted', encrypted: 'cipher' },
          ],
        },
        { content: 'ok' },
      ]),
    );
    const accumulator = createMessageAccumulator();
    await createRequesterFromHandle(
      bindOpenAI({ clientFactory: inbound.clientFactory }),
    ).generate(
      { model },
      { messages },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') accumulator.push(event.part);
        },
      },
    );
    const finished = accumulator.finish();
    expect(finished.content).toEqual([
      { type: 'think', think: 'A', reasoningKey: 'reasoning_content' },
      { type: 'think', think: 'B', reasoningKey: 'reasoning' },
      {
        type: 'think',
        think: '摘',
        detailsIndex: 0,
        hidden: true,
        reasoningKey: 'reasoning_details',
      },
      {
        type: 'think',
        think: '',
        encrypted: 'cipher',
        detailsIndex: 1,
        reasoningKey: 'reasoning_details',
      },
      { type: 'text', text: 'ok' },
    ]);

    const outbound = stubOpenAIClient(chatCompletionChunks());
    await createRequesterFromHandle(
      bindOpenAI({ clientFactory: outbound.clientFactory }),
    ).generate(
      { model, thinking: { effort: 'off' } },
      { messages: [createUserMessage('hi'), finished] },
      { signal: new AbortController().signal },
    );
    const replayed = assistantOf(outbound.body());
    expect(replayed['reasoning_content']).toBe('A');
    expect(replayed['reasoning']).toBe('B');
    expect(replayed['reasoning_details']).toEqual([
      { type: 'summary', summary: '摘' },
      { type: 'encrypted', encrypted: 'cipher' },
    ]);
    expect(replayed['content']).toBe('ok');

    const unstamped = stubOpenAIClient(chatCompletionChunks());
    await createRequesterFromHandle(
      bindOpenAI({ clientFactory: unstamped.clientFactory }),
    ).generate(
      { model, thinking: { effort: 'off' } },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage([{ type: 'think', think: 'abc' }, { type: 'text', text: 'hello' }]),
        ],
      },
      { signal: new AbortController().signal },
    );
    const fallback = assistantOf(unstamped.body());
    expect(fallback['reasoning_content']).toBe('abc');
    expect(fallback['reasoning']).toBeUndefined();

    let call = 0;
    const captured: Record<string, unknown>[] = [];
    const detectedRequester = createRequesterFromHandle(
      bindOpenAI({
        clientFactory: () => {
          call += 1;
          return openAIClient(
            call === 1
              ? chatCompletionChunks([{ reasoning: 'detected' }, { content: 'hi' }])
              : chatCompletionChunks(),
            captured,
          ) as never;
        },
      }),
    );
    await detectedRequester.generate(
      { model },
      { messages },
      { signal: new AbortController().signal },
    );
    await detectedRequester.generate(
      { model, thinking: { effort: 'off' } },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage([{ type: 'think', think: 'abc' }]),
        ],
      },
      { signal: new AbortController().signal },
    );
    const second = captured[1];
    if (second === undefined) throw new Error('expected second request');
    const detected = assistantOf(second);
    expect(detected['reasoning']).toBe('abc');
    expect('reasoning_content' in detected).toBe(false);

    const explicitParts: unknown[] = [];
    await createRequesterFromHandle(
      bindOpenAI({
        trait: { reasoningKey: 'reasoning' },
        clientFactory: stubOpenAIClient(
          chatCompletionChunks([
            {
              reasoning: 'declared',
              reasoning_details: [{ index: 0, type: 'summary', summary: 'kept' }],
            },
            { content: 'ok' },
          ]),
        ).clientFactory,
      }),
    ).generate(
      { model },
      { messages },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') explicitParts.push(event.part);
        },
      },
    );
    expect(explicitParts).toEqual([
      { type: 'think', think: 'declared', reasoningKey: 'reasoning' },
      { type: 'think', think: 'kept', detailsIndex: 0, reasoningKey: 'reasoning_details' },
      { type: 'text', text: 'ok' },
    ]);
  });
});
