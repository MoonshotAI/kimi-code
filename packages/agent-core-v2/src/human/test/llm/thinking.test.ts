import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/llm/capability';
import {
  createAssistantMessage,
  createMessageAccumulator,
  createUserMessage,
  type Message,
} from '#/llm/message';
import type { LlmModel } from '#/llm/model';
import type { TraitContext } from '#/llm/protocol/base';
import {
  defaultThinkingEffortForModel,
  modelSupportsThinking,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
  type ModelThinkingMetadata,
} from '#/llm/thinking';
import { kimiConnection, kimiOpenAITrait } from '#/llm-kimi/trait';
import { classifyKimiQuotaError } from '#/llm-kimi/errors';
import { createOpenAIRequester } from '#/llm/requester/bases/openai/requester';
import type { LlmClientContext, LlmRequestEvent } from '#/llm/requester/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const ctx: TraitContext = { model };
const messages: readonly Message[] = [createUserMessage('hi')];

const kimiOpenAI = {
  connection: kimiConnection,
  trait: kimiOpenAITrait,
  convertError: classifyKimiQuotaError,
} as const;

function modelWith(meta: ModelThinkingMetadata): LlmModel {
  return { ...model, ...meta };
}

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

function bodyMessages(body: Record<string, unknown>): Record<string, unknown>[] {
  return body['messages'] as Record<string, unknown>[];
}

describe('kimiOpenAITrait thinking', () => {
  it('encodes thinking configs and resolves thinking defaults and keep', () => {
    expect(kimiOpenAITrait.strictThinkingValidation).toBe(true);
    expect(kimiOpenAITrait.thinking?.({ effort: 'off' }, ctx)).toEqual({
      kwargs: { thinking: { type: 'disabled' } },
    });
    expect(kimiOpenAITrait.thinking?.({ effort: 'on' }, ctx)).toEqual({
      kwargs: { thinking: { type: 'enabled' } },
    });
    expect(kimiOpenAITrait.thinking?.({ effort: 'high', keep: 'all' }, ctx)).toEqual({
      kwargs: { thinking: { type: 'enabled', effort: 'high', keep: 'all' } },
      preserveThinking: true,
    });

    const thinkingCapability: ModelCapability = {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: true,
      tool_use: true,
    };
    const thinkingModel = (meta: ModelThinkingMetadata): LlmModel => ({
      ...modelWith(meta),
      capability: thinkingCapability,
    });
    const declared = thinkingModel({
      supportEfforts: ['low', 'medium', 'high'],
      defaultEffort: 'high',
    });
    expect(modelSupportsThinking(declared)).toBe(true);
    expect(modelSupportsThinking(model)).toBe(false);
    expect(defaultThinkingEffortForModel(declared)).toBe('high');
    expect(
      defaultThinkingEffortForModel(thinkingModel({ supportEfforts: ['low', 'medium', 'high'] })),
    ).toBe('medium');
    expect(defaultThinkingEffortForModel(model)).toBe('off');

    expect(resolveThinkingEffortForModel(' Max ', undefined, declared)).toBe('max');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false }, declared)).toBe('off');
    expect(resolveThinkingEffortForModel(undefined, { effort: 'low' }, declared)).toBe('low');
    expect(resolveThinkingEffortForModel('high', { enabled: false }, declared)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, undefined, declared)).toBe('high');
    expect(
      resolveThinkingEffortForModel(
        undefined,
        undefined,
        thinkingModel({ supportEfforts: ['low', 'medium', 'high'] }),
      ),
    ).toBe('medium');
    expect(resolveThinkingEffortForModel('max', undefined, declared, true)).toBe('high');
    expect(resolveThinkingEffortForModel('on', undefined, declared, true)).toBe('high');
    expect(resolveThinkingEffortForModel('off', undefined, declared, true)).toBe('off');

    const always = thinkingModel({ supportEfforts: ['low', 'high'], alwaysThinking: true });
    expect(resolveThinkingEffortForModel('off', undefined, always)).toBe('high');
    expect(resolveThinkingEffortForModel(undefined, { enabled: false, effort: 'low' }, always)).toBe(
      'low',
    );

    expect(resolveThinkingKeep(undefined, undefined, 'high')).toBe('all');
    expect(resolveThinkingKeep(undefined, undefined, 'off')).toBeUndefined();
    expect(resolveThinkingKeep('0', 'all', 'high')).toBeUndefined();
    expect(resolveThinkingKeep(undefined, 'none', 'high')).toBeUndefined();
    expect(resolveThinkingKeep('2', 'all', 'high')).toBe('2');
    expect(resolveThinkingKeep(undefined, '1', 'high')).toBe('1');
  });

  it('preserves thinking only when keep is all and thinking is not disabled', () => {
    expect(kimiOpenAITrait.thinking?.({ effort: 'on', keep: 'all' }, ctx)?.preserveThinking).toBe(
      true,
    );
    expect(
      kimiOpenAITrait.thinking?.({ effort: 'off', keep: 'all' }, ctx)?.preserveThinking,
    ).toBeUndefined();
    expect(
      kimiOpenAITrait.thinking?.({ effort: 'on' }, ctx)?.preserveThinking,
    ).toBeUndefined();
    expect(
      kimiOpenAITrait.thinking?.({ effort: 'on', keep: '1' }, ctx)?.preserveThinking,
    ).toBeUndefined();
  });
});

describe('openai requester thinking', () => {
  it('sends kimi thinking params at the top level and flattens extra_body', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      {
        model,
        thinking: { effort: 'high', keep: 'all' },
        extraParams: { openai: { extra_body: { trace_id: 't1' } } },
      },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['thinking']).toEqual({ type: 'enabled', effort: 'high', keep: 'all' });
    expect(client.body()['trace_id']).toBe('t1');
    expect(client.body()['reasoning_effort']).toBeUndefined();
  });

  it('sends disabled thinking for off', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      { model, thinking: { effort: 'off' } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['thinking']).toEqual({ type: 'disabled' });
  });

  it('falls back to reasoning_effort when no trait handles thinking', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model, thinking: { effort: 'high' } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['reasoning_effort']).toBe('high');
    expect(client.body()['thinking']).toBeUndefined();

    await requester.generate(
      { model: modelWith({ supportEfforts: ['low', 'high'] }), thinking: { effort: 'max' } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['reasoning_effort']).toBe('max');
  });

  it('sends nothing for on without a trait', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model, thinking: { effort: 'on' } },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['reasoning_effort']).toBeUndefined();
    expect(client.body()['thinking']).toBeUndefined();
  });

  it('sends the configured offEffort when thinking is off', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      {
        model: modelWith({ supportEfforts: ['low', 'high'], offEffort: 'none' }),
        thinking: { effort: 'off' },
      },
      { messages },
      { signal: new AbortController().signal },
    );
    expect(client.body()['reasoning_effort']).toBe('none');
  });

  it('rejects unsatisfiable off requests with guidance', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    const failing = async (target: LlmModel): Promise<LlmRequestEvent[]> => {
      const events: LlmRequestEvent[] = [];
      await requester.generate(
        { model: target, thinking: { effort: 'off' } },
        { messages },
        { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
      );
      expect(events.some((event) => event.type === 'llm.sent')).toBe(false);
      return events;
    };
    const syntaxError = (events: LlmRequestEvent[]) => {
      const failed = events.find((event) => event.type === 'llm.failed.syntax');
      if (failed?.type !== 'llm.failed.syntax') throw new Error('expected llm.failed.syntax');
      expect(failed.error.code).toBe('thinking_config');
      return failed.error.message;
    };

    const alwaysThinking = await failing(
      modelWith({ supportEfforts: ['low', 'high'], alwaysThinking: true }),
    );
    expect(syntaxError(alwaysThinking)).toContain('always reasons');

    const noOffEffort = await failing(modelWith({ supportEfforts: ['low', 'high'] }));
    expect(syntaxError(noOffEffort)).toContain('offEffort');
  });

  it('rejects an effort outside the supported list under strict validation', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({
      trait: { strictThinkingValidation: true },
      clientFactory: client.clientFactory,
    });
    const events: LlmRequestEvent[] = [];
    await requester.generate(
      { model: modelWith({ supportEfforts: ['low', 'high'] }), thinking: { effort: 'max' } },
      { messages },
      { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
    );
    const failed = events.find((event) => event.type === 'llm.failed.syntax');
    if (failed?.type !== 'llm.failed.syntax') throw new Error('expected llm.failed.syntax');
    expect(failed.error.code).toBe('thinking_config');
    expect(failed.error.message).toContain("'max'");
    expect(failed.error.message).toContain('low, high');
    expect(events.some((event) => event.type === 'llm.sent')).toBe(false);
  });

  it('rejects thinking efforts for a model known not to think', async () => {
    const capability: ModelCapability = {
      image_in: false,
      video_in: false,
      audio_in: false,
      thinking: false,
      tool_use: true,
    };
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    const events: LlmRequestEvent[] = [];
    await requester.generate(
      { model: { ...model, capability }, thinking: { effort: 'high' } },
      { messages },
      { signal: new AbortController().signal, onEvent: (event) => events.push(event) },
    );
    const failed = events.find((event) => event.type === 'llm.failed.syntax');
    if (failed?.type !== 'llm.failed.syntax') throw new Error('expected llm.failed.syntax');
    expect(failed.error.code).toBe('thinking_config');
    expect(failed.error.message).toContain('does not support thinking');
    expect(events.some((event) => event.type === 'llm.sent')).toBe(false);
  });

  it('keeps reasoning alive with medium effort when history has think parts', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage([{ type: 'think', think: 'abc' }, { type: 'text', text: 'hello' }]),
        ],
      },
      { signal: new AbortController().signal },
    );
    expect(client.body()['reasoning_effort']).toBe('medium');
  });

  it('echoes think parts under reasoning_content by default and restores marked reasoning_details', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
    await requester.generate(
      { model, thinking: { effort: 'off' } },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage([{ type: 'think', think: 'abc' }, { type: 'text', text: 'hello' }]),
        ],
      },
      { signal: new AbortController().signal },
    );
    const assistant = bodyMessages(client.body())[1]!;
    expect(assistant['reasoning_content']).toBe('abc');
    expect(assistant['content']).toBe('hello');

    const marked = stubOpenAIClient(chatCompletionChunks());
    const markedRequester = createOpenAIRequester({
      clientFactory: marked.clientFactory,
    });
    await markedRequester.generate(
      { model, thinking: { effort: 'off' } },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage([
            { type: 'think', think: '第一段续', detailsIndex: 0 },
            { type: 'think', think: '第二段', detailsIndex: 1 },
            { type: 'think', think: '', encrypted: 'cipher', detailsIndex: 2 },
            { type: 'text', text: 'ok' },
          ]),
        ],
      },
      { signal: new AbortController().signal },
    );
    const markedAssistant = bodyMessages(marked.body())[1]!;
    expect(markedAssistant['reasoning_details']).toEqual([
      { type: 'summary', summary: '第一段续' },
      { type: 'summary', summary: '第二段' },
      { type: 'encrypted', encrypted: 'cipher' },
    ]);
    expect(markedAssistant['reasoning_content']).toBe('第一段续第二段');
  });

  it('echoes an empty reasoning_content on think-less assistant messages only when keeping all', async () => {
    const preserving = stubOpenAIClient(chatCompletionChunks());
    const preservingRequester = createOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: preserving.clientFactory,
    });
    await preservingRequester.generate(
      { model, thinking: { effort: 'on', keep: 'all' } },
      { messages: [createUserMessage('hi'), createAssistantMessage([{ type: 'text', text: 'hello' }])] },
      { signal: new AbortController().signal },
    );
    expect(bodyMessages(preserving.body())[1]!['reasoning_content']).toBe('');

    const plain = stubOpenAIClient(chatCompletionChunks());
    const plainRequester = createOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: plain.clientFactory,
    });
    await plainRequester.generate(
      { model, thinking: { effort: 'on' } },
      { messages: [createUserMessage('hi'), createAssistantMessage([{ type: 'text', text: 'hello' }])] },
      { signal: new AbortController().signal },
    );
    expect('reasoning_content' in bodyMessages(plain.body())[1]!).toBe(false);
  });

  it('selects the outbound reasoning key from the trait declaration or inbound detection', async () => {
    const declared = stubOpenAIClient(chatCompletionChunks());
    const declaredRequester = createOpenAIRequester({
      trait: { reasoningKey: 'reasoning' },
      clientFactory: declared.clientFactory,
    });
    await declaredRequester.generate(
      { model, thinking: { effort: 'off' } },
      {
        messages: [
          createUserMessage('hi'),
          createAssistantMessage([{ type: 'think', think: 'abc' }]),
        ],
      },
      { signal: new AbortController().signal },
    );
    const declaredAssistant = bodyMessages(declared.body())[1]!;
    expect(declaredAssistant['reasoning']).toBe('abc');
    expect('reasoning_content' in declaredAssistant).toBe(false);

    let call = 0;
    const captured: Record<string, unknown>[] = [];
    const clientFactory = () => {
      call += 1;
      const chunks =
        call === 1
          ? chatCompletionChunks([{ role: 'assistant', content: 'hi', reasoning: 'detected' }])
          : chatCompletionChunks();
      return openAIClient(chunks, captured) as never;
    };
    const detectedRequester = createOpenAIRequester({ clientFactory });
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
    const detectedAssistant = bodyMessages(captured[1]!)[1]!;
    expect(detectedAssistant['reasoning']).toBe('abc');
    expect('reasoning_content' in detectedAssistant).toBe(false);

    const explicit = stubOpenAIClient(
      chatCompletionChunks([
        {
          reasoning_details: [
            { index: 0, type: 'summary', summary: 'ignored' },
            { index: 1, type: 'encrypted', encrypted: 'cipher' },
          ],
        },
        { content: 'ok' },
      ]),
    );
    const explicitRequester = createOpenAIRequester({
      trait: { reasoningKey: 'reasoning' },
      clientFactory: explicit.clientFactory,
    });
    const explicitParts: unknown[] = [];
    await explicitRequester.generate(
      { model },
      { messages },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') explicitParts.push(event.part);
        },
      },
    );
    expect(explicitParts).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('parses reasoning from stream deltas', async () => {
    const collect = async (chunks: Record<string, unknown>[]) => {
      const client = stubOpenAIClient(chunks);
      const requester = createOpenAIRequester({ clientFactory: client.clientFactory });
      const accumulator = createMessageAccumulator();
      await requester.generate(
        { model },
        { messages },
        {
          signal: new AbortController().signal,
          onEvent: (event) => {
            if (event.type === 'llm.streaming.part') {
              accumulator.push(event.part);
            }
          },
        },
      );
      return accumulator.finish().content;
    };
    await expect(
      collect(chatCompletionChunks([{ reasoning: 'stream-think' }, { content: 'hi' }])),
    ).resolves.toContainEqual({ type: 'think', think: 'stream-think' });
    await expect(
      collect(chatCompletionChunks([{ reasoning: '' }, { content: 'hi' }])),
    ).resolves.toContainEqual({ type: 'think', think: '' });
    await expect(
      collect(
        chatCompletionChunks([
          { reasoning: '', content: 'hel' },
          { reasoning: '', content: 'lo' },
        ]),
      ),
    ).resolves.toEqual([
      { type: 'think', think: '' },
      { type: 'text', text: 'hello' },
    ]);
    await expect(
      collect(chatCompletionChunks([{ content: 'hi' }, { reasoning: '' }])),
    ).resolves.toEqual([
      { type: 'text', text: 'hi' },
      { type: 'think', think: '' },
    ]);
    await expect(
      collect(
        chatCompletionChunks([
          {
            reasoning_content: '第一段',
            reasoning_details: [{ index: 0, type: 'summary', summary: '第一段' }],
          },
          {
            reasoning_details: [
              { index: 0, summary: '续' },
              { index: 1, type: 'summary', summary: '第二段' },
            ],
          },
          { reasoning_details: [{ index: 2, type: 'encrypted', encrypted: 'cipher' }] },
          { content: 'ok' },
        ]),
      ),
    ).resolves.toEqual([
      { type: 'think', think: '第一段续', detailsIndex: 0 },
      { type: 'think', think: '第二段', detailsIndex: 1 },
      { type: 'think', think: '', encrypted: 'cipher', detailsIndex: 2 },
      { type: 'text', text: 'ok' },
    ]);
    await expect(
      collect(
        chatCompletionChunks([
          {
            reasoning_details: [
              { index: 0, type: 'reasoning.text', text: 'foreign', format: 'unknown' },
              { index: 1, type: 'summary', summary: 'kept' },
            ],
          },
          { content: 'ok' },
        ]),
      ),
    ).resolves.toEqual([
      { type: 'think', think: 'kept', detailsIndex: 1 },
      { type: 'text', text: 'ok' },
    ]);
  });
});
