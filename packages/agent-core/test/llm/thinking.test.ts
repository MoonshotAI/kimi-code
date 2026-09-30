import { describe, expect, it } from 'vitest';

import { anthropicProtocol } from '#/llm/builtin/protocol/anthropic/index';
import { openAIProtocol } from '#/llm/builtin/protocol/openai/index';
import { kimiOpenAIProtocol } from '#/llm/builtin/provider/kimi/index';
import { createAssistantMessage, createUserMessage, type AssistantMessage, type Message } from '#/llm/message';
import { createMessageAccumulator } from '#/llm/policy/settle';
import type { LlmModelSpec } from '#/llm/request';
import { createRequester } from '#/llm/requester';
import type { LlmNotice } from '#/llm/response';

const spec: LlmModelSpec = {
  provider: 'test',
  name: 'test-model',
};
const messages: readonly Message[] = [createUserMessage('hi')];
const openAI = createRequester().with({ protocol: { base: openAIProtocol }, model: { spec } });
const kimi = createRequester().with({ protocol: { base: kimiOpenAIProtocol }, model: { spec } });
const thinkingOff = { spec, thinking: { effort: 'off' } } as const;

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

function stubOpenAIClient(chunks: readonly Record<string, unknown>[]): {
  clientFactory: () => unknown;
  body: () => Record<string, unknown>;
} {
  const captured: Record<string, unknown>[] = [];
  return {
    clientFactory: () => ({
      chat: {
        completions: {
          create: (params: Record<string, unknown>) => {
            captured.push(params);
            return {
              withResponse: async () => ({
                data: createAsyncStream(chunks),
                response: new Response(null),
              }),
            };
          },
        },
      },
    }),
    body: () => {
      const last = captured.at(-1);
      if (last === undefined) throw new Error('expected client to be called');
      return last;
    },
  };
}

function nativeMessageAt(body: Record<string, unknown>, index: number): Record<string, unknown> {
  const message = (body['messages'] as Record<string, unknown>[] | undefined)?.[index];
  if (message === undefined) throw new Error(`expected message ${index}`);
  return message;
}

async function roundTrip(
  requester: typeof openAI,
  deltas: readonly Record<string, unknown>[],
): Promise<{ readonly finished: AssistantMessage; readonly replayed: Record<string, unknown> }> {
  const inbound = stubOpenAIClient(chatCompletionChunks(deltas));
  const accumulator = createMessageAccumulator();
  await requester.generate(
    { endpoint: { clientFactory: inbound.clientFactory }, content: { messages } },
    {
      signal: new AbortController().signal,
      onEvent: (event) => {
        if (event.type === 'llm.streaming.part') accumulator.push(event.part);
      },
    },
  );
  const finished = accumulator.finish();
  const outbound = stubOpenAIClient(chatCompletionChunks());
  await requester.generate(
    {
      endpoint: { clientFactory: outbound.clientFactory },
      model: thinkingOff,
      content: { messages: [createUserMessage('hi'), finished] },
    },
    { signal: new AbortController().signal },
  );
  return { finished, replayed: nativeMessageAt(outbound.body(), 1) };
}

describe('openai requester reasoning key', () => {
  it('stamps each inbound reasoning field, leaves reasoning_details to kimi and writes them back on the next request', async () => {
    const dualDeltas = [
      {
        reasoning_content: 'A',
        reasoning: 'B',
        reasoning_details: [
          { index: 0, type: 'summary', summary: '摘' },
          { index: 1, type: 'encrypted', encrypted: 'cipher' },
        ],
      },
      { content: 'ok' },
    ];
    const standard = await roundTrip(openAI, dualDeltas);
    expect(standard.finished.content).toEqual([
      { type: 'think', think: 'A', reasoningKey: 'reasoning_content' },
      { type: 'think', think: 'B', reasoningKey: 'reasoning' },
      { type: 'text', text: 'ok' },
    ]);
    expect(standard.replayed).toMatchObject({ reasoning_content: 'A', reasoning: 'B', content: 'ok' });
    expect('reasoning_details' in standard.replayed).toBe(false);

    const dual = await roundTrip(kimi, dualDeltas);
    expect(dual.finished.content).toEqual([
      { type: 'think', think: '摘', detailsIndex: 0, hidden: true, reasoningKey: 'reasoning_details' },
      { type: 'think', think: '', encrypted: 'cipher', detailsIndex: 1, reasoningKey: 'reasoning_details' },
      { type: 'think', think: 'A', reasoningKey: 'reasoning_content' },
      { type: 'think', think: 'B', reasoningKey: 'reasoning' },
      { type: 'text', text: 'ok' },
    ]);
    expect(dual.replayed).toMatchObject({
      reasoning_content: 'A',
      reasoning: 'B',
      reasoning_details: [
        { type: 'summary', summary: '摘' },
        { type: 'encrypted', encrypted: 'cipher' },
      ],
    });

    const interleaved = await roundTrip(kimi, [
      { reasoning_content: 'a', reasoning_details: [{ index: 0, type: 'summary', summary: 'x' }] },
      { reasoning_content: 'b', reasoning_details: [{ index: 0, type: 'summary', summary: 'y' }] },
      { reasoning_details: [{ index: 1, type: 'encrypted', encrypted: 'cipher' }] },
      { content: 'ok' },
    ]);
    expect(interleaved.replayed).toMatchObject({
      reasoning_content: 'ab',
      reasoning_details: [
        { type: 'summary', summary: 'xy' },
        { type: 'encrypted', encrypted: 'cipher' },
      ],
    });

    const detailsOnly = await roundTrip(kimi, [
      { reasoning_details: [{ index: 0, type: 'summary', summary: '第一段' }] },
      { reasoning_details: [{ index: 0, summary: '续' }, { index: 1, type: 'summary', summary: '第二段' }] },
      { reasoning_details: [{ index: 2, type: 'encrypted', encrypted: 'cipher' }] },
      { content: 'ok' },
    ]);
    expect(detailsOnly.finished.content.filter((part) => part.type === 'think' && part.hidden === true)).toEqual([]);
    expect(detailsOnly.replayed).toMatchObject({
      reasoning_content: '第一段续第二段',
      reasoning_details: [
        { type: 'summary', summary: '第一段续' },
        { type: 'summary', summary: '第二段' },
        { type: 'encrypted', encrypted: 'cipher' },
      ],
    });

    const unstamped = stubOpenAIClient(chatCompletionChunks());
    await openAI.generate(
      {
        endpoint: { clientFactory: unstamped.clientFactory },
        model: thinkingOff,
        content: {
          messages: [
            createUserMessage('hi'),
            createAssistantMessage([{ type: 'think', think: 'abc' }, { type: 'text', text: 'hello' }]),
          ],
        },
      },
      { signal: new AbortController().signal },
    );
    const fallback = nativeMessageAt(unstamped.body(), 1);
    expect(fallback['reasoning_content']).toBe('abc');
    expect(fallback['reasoning']).toBeUndefined();

    const detected = stubOpenAIClient(chatCompletionChunks());
    await openAI.generate(
      {
        endpoint: { clientFactory: detected.clientFactory },
        model: thinkingOff,
        content: {
          messages: [
            createUserMessage('hi'),
            createAssistantMessage([
              { type: 'think', think: 'detected', reasoningKey: 'reasoning' },
              { type: 'text', text: 'hi' },
            ]),
            createUserMessage('again'),
            createAssistantMessage([{ type: 'think', think: 'abc' }]),
          ],
        },
      },
      { signal: new AbortController().signal },
    );
    const derived = nativeMessageAt(detected.body(), 3);
    expect(derived['reasoning']).toBe('abc');
    expect('reasoning_content' in derived).toBe(false);

    const explicitParts: unknown[] = [];
    await openAI.generate(
      {
        endpoint: {
          clientFactory: stubOpenAIClient(
            chatCompletionChunks([
              {
                reasoning: 'declared',
                reasoning_details: [{ index: 0, type: 'summary', summary: 'kept' }],
              },
              { content: 'ok' },
            ]),
          ).clientFactory,
        },
        content: { messages },
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') explicitParts.push(event.part);
        },
      },
    );
    expect(explicitParts).toEqual([
      { type: 'think', think: 'declared', reasoningKey: 'reasoning' },
      { type: 'text', text: 'ok' },
    ]);

    const configured = openAI.with({ protocol: { options: { reasoningKey: 'reasoning' } } });
    const configuredParts: unknown[] = [];
    const configuredOutbound = stubOpenAIClient(
      chatCompletionChunks([{ reasoning_content: 'ignored', reasoning: 'picked' }, { content: 'ok' }]),
    );
    await configured.generate(
      {
        endpoint: { clientFactory: configuredOutbound.clientFactory },
        model: thinkingOff,
        content: {
          messages: [
            createUserMessage('hi'),
            createAssistantMessage([
              { type: 'think', think: 'old', reasoningKey: 'reasoning_content' },
              { type: 'text', text: 'hi' },
            ]),
            createUserMessage('again'),
          ],
        },
      },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') configuredParts.push(event.part);
        },
      },
    );
    expect(configuredParts).toEqual([
      { type: 'think', think: 'picked', reasoningKey: 'reasoning' },
      { type: 'text', text: 'ok' },
    ]);
    const restamped = nativeMessageAt(configuredOutbound.body(), 1);
    expect(restamped['reasoning']).toBe('old');
    expect('reasoning_content' in restamped).toBe(false);
  });
});

describe('thinking effort legalization', () => {
  it('normalizes efforts for strict protocols, passes them through otherwise and flags unlisted anthropic efforts', () => {
    const listed: LlmModelSpec = {
      provider: 'kimi',
      name: 'kimi-k2',
      capability: { thinking: true },
      thinking: { supportEfforts: ['low', 'medium', 'high'], defaultEffort: 'medium' },
    };
    const moduleOf = (modelSpec: LlmModelSpec, effort: string) => ({
      model: { spec: modelSpec, thinking: { effort } },
      profile: {},
      content: { messages },
      options: undefined,
    });
    const kimiThinking = (modelSpec: LlmModelSpec, effort: string) =>
      (kimiOpenAIProtocol.encode(moduleOf(modelSpec, effort)).params as { thinking?: unknown })
        .thinking;
    expect(kimiThinking(listed, 'xhigh')).toMatchObject({ type: 'enabled', effort: 'medium' });
    expect(kimiThinking(listed, 'high')).toMatchObject({ type: 'enabled', effort: 'high' });
    expect(kimiThinking(listed, 'on')).toMatchObject({ type: 'enabled', effort: 'medium' });
    expect(kimiThinking(listed, 'off')).toMatchObject({ type: 'disabled' });
    expect(
      kimiThinking({ ...listed, thinking: { alwaysThinking: true, supportEfforts: ['low', 'high'] } }, 'off'),
    ).toMatchObject({ type: 'enabled', effort: 'high' });
    expect(kimiThinking({ provider: 'kimi', name: 'plain' }, 'high')).toMatchObject({ type: 'disabled' });
    expect(openAIProtocol.encode(moduleOf(listed, 'xhigh')).params).toMatchObject({ reasoning_effort: 'xhigh' });

    const notices: LlmNotice[] = [];
    anthropicProtocol.encode(
      {
        model: {
          spec: { provider: 'anthropic', name: 'claude-opus-4-7', thinking: { supportEfforts: ['low', 'high'] } },
          thinking: { effort: 'max' },
        },
        profile: {},
        content: { messages },
        options: undefined,
      },
      { report: (notice) => notices.push(notice) },
    );
    expect(notices).toMatchObject([
      { source: 'legalize-model', code: 'anthropic-thinking-effort-not-listed', data: { effort: 'max' } },
    ]);
  });
});
