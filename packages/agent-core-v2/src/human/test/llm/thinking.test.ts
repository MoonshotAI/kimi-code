import { createServer } from 'node:http';

import { describe, expect, it } from 'vitest';

import { UNKNOWN_CAPABILITY, type ModelCapability } from '#/llm-requester/capability';
import {
  createAssistantMessage,
  createMessageAccumulator,
  createUserMessage,
  type Message,
} from '#/message';
import type { LlmModel } from '#/llm-requester/model';
import {
  defaultThinkingEffortForModel,
  modelSupportsThinking,
  resolveThinkingEffortForModel,
  resolveThinkingKeep,
  type ModelThinkingMetadata,
} from '#/llm-requester/thinking';
import { classifyKimiQuotaError } from '#/llm/builtin/provider/kimi/errors';
import { createKimiOpenAIRequester, createOpenAIRequester, kimiEndpoint } from '#/llm-requester/factories';
import type { LlmClientContext, LlmRequestEvent } from '#/llm-requester/requester';

const model: LlmModel = {
  provider: 'test',
  model: 'test-model',
  capability: UNKNOWN_CAPABILITY,
  baseUrl: 'https://example.test/v1',
};
const messages: readonly Message[] = [createUserMessage('hi')];

const kimiOpenAI = {
  endpoint: kimiEndpoint,
  classifyError: classifyKimiQuotaError,
} as const;

const THINKING_CAPABILITY: ModelCapability = {
  image_in: false,
  video_in: false,
  audio_in: false,
  thinking: true,
  tool_use: true,
};

function thinkingCapableModel(meta?: ModelThinkingMetadata): LlmModel {
  return { ...model, ...meta, capability: THINKING_CAPABILITY };
}

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

describe('kimi openai thinking', () => {
  it('encodes thinking configs and resolves thinking defaults and keep', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createKimiOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: client.clientFactory,
    });
    const signal = new AbortController().signal;
    await requester.generate(
      { model: thinkingCapableModel(), thinking: { effort: 'off' } },
      { messages },
      { signal },
    );
    expect(client.body()['thinking']).toEqual({ type: 'disabled' });
    await requester.generate(
      { model: thinkingCapableModel(), thinking: { effort: 'on' } },
      { messages },
      { signal },
    );
    expect(client.body()['thinking']).toEqual({ type: 'enabled' });
    await requester.generate(
      {
        model: thinkingCapableModel({ supportEfforts: ['low', 'medium', 'high'] }),
        thinking: { effort: 'high', keep: 'all' },
      },
      { messages },
      { signal },
    );
    expect(client.body()['thinking']).toEqual({ type: 'enabled', effort: 'high', keep: 'all' });

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

  it('preserves thinking only when keep is all and thinking is not disabled', async () => {
    const history: readonly Message[] = [
      createUserMessage('hi'),
      createAssistantMessage([{ type: 'text', text: 'hello' }]),
    ];
    const reasoningContentOf = async (thinking: {
      effort: 'off' | 'on';
      keep?: string;
    }): Promise<unknown> => {
      const client = stubOpenAIClient(chatCompletionChunks());
      const requester = createKimiOpenAIRequester({
        ...kimiOpenAI,
        clientFactory: client.clientFactory,
      });
      await requester.generate(
        { model: thinkingCapableModel(), thinking },
        { messages: history },
        { signal: new AbortController().signal },
      );
      const assistant = bodyMessages(client.body())[1]!;
      return 'reasoning_content' in assistant ? assistant['reasoning_content'] : undefined;
    };
    await expect(reasoningContentOf({ effort: 'on', keep: 'all' })).resolves.toBe('');
    await expect(reasoningContentOf({ effort: 'off', keep: 'all' })).resolves.toBeUndefined();
    await expect(reasoningContentOf({ effort: 'on' })).resolves.toBeUndefined();
    await expect(reasoningContentOf({ effort: 'on', keep: '1' })).resolves.toBeUndefined();
  });
});

describe('openai requester thinking', () => {
  it('sends kimi thinking params at the top level and flattens extra_body', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createKimiOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: client.clientFactory,
    });
    await requester.generate(
      {
        model: thinkingCapableModel({ supportEfforts: ['low', 'medium', 'high'] }),
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
    const requester = createKimiOpenAIRequester({
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

  it('falls back to reasoning_effort when the protocol has no thinking strategy', async () => {
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

  it('sends nothing for on without a thinking strategy', async () => {
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

  it('preserves on and concrete efforts in the kimi custom thinking path', async () => {
    const client = stubOpenAIClient(chatCompletionChunks());
    const requester = createKimiOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: client.clientFactory,
    });
    const signal = new AbortController().signal;
    const target = modelWith({ supportEfforts: ['low', 'high'] });
    await requester.generate(
      { model: target, thinking: { effort: 'on' } },
      { messages },
      { signal },
    );
    expect(client.body()['thinking']).toEqual({ type: 'enabled' });
    await requester.generate(
      { model: target, thinking: { effort: 'max' } },
      { messages },
      { signal },
    );
    expect(client.body()['thinking']).toEqual({ type: 'enabled', effort: 'max' });
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

    const inbound = stubOpenAIClient(
      chatCompletionChunks([
        { reasoning_content: '原文一' },
        { reasoning_content: '原文二' },
        {
          reasoning_details: [
            { index: 0, type: 'summary', summary: '摘' },
            { index: 1, type: 'encrypted', encrypted: 'cipher' },
          ],
        },
        { content: 'ok' },
      ]),
    );
    const inboundRequester = createKimiOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: inbound.clientFactory,
    });
    const accumulator = createMessageAccumulator();
    await inboundRequester.generate(
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
    const finished = accumulator.finish();
    expect(finished.content).toEqual([
      { type: 'think', think: '原文一原文二', reasoningKey: 'reasoning_content' },
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
    finished.content.splice(1, 0, { type: 'think', think: '续' });

    const outbound = stubOpenAIClient(chatCompletionChunks());
    const outboundRequester = createKimiOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: outbound.clientFactory,
    });
    await outboundRequester.generate(
      { model, thinking: { effort: 'off' } },
      { messages: [createUserMessage('hi'), finished] },
      { signal: new AbortController().signal },
    );
    const continued = bodyMessages(outbound.body())[1]!;
    expect(continued['reasoning_details']).toEqual([
      { type: 'summary', summary: '摘' },
      { type: 'encrypted', encrypted: 'cipher' },
    ]);
    expect(continued['reasoning_content']).toBe('原文一原文二续');
    expect(continued['content']).toBe('ok');

    const dual = stubOpenAIClient(
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
    const dualAccumulator = createMessageAccumulator();
    await createOpenAIRequester({
      clientFactory: dual.clientFactory,
    }).generate(
      { model },
      { messages },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') {
            dualAccumulator.push(event.part);
          }
        },
      },
    );
    const dualFinished = dualAccumulator.finish();
    expect(dualFinished.content).toEqual([
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
    dualFinished.content.splice(2, 0, { type: 'think', think: 'C' });
    const dualOutbound = stubOpenAIClient(chatCompletionChunks());
    await createOpenAIRequester({
      clientFactory: dualOutbound.clientFactory,
    }).generate(
      { model, thinking: { effort: 'off' } },
      { messages: [createUserMessage('hi'), dualFinished] },
      { signal: new AbortController().signal },
    );
    const dualReplayed = bodyMessages(dualOutbound.body())[1]!;
    expect(dualReplayed['reasoning_content']).toBe('A');
    expect(dualReplayed['reasoning']).toBe('BC');
    expect(dualReplayed['reasoning_details']).toEqual([
      { type: 'summary', summary: '摘' },
      { type: 'encrypted', encrypted: 'cipher' },
    ]);

    const openrouter = stubOpenAIClient(
      chatCompletionChunks([
        {
          reasoning: 'We',
          reasoning_details: [
            {
              index: 0,
              type: 'reasoning.text',
              text: 'We',
              format: 'unknown',
            },
          ],
        },
        { content: 'ok' },
      ]),
    );
    const openrouterAccumulator = createMessageAccumulator();
    await createOpenAIRequester({
      clientFactory: openrouter.clientFactory,
    }).generate(
      { model },
      { messages },
      {
        signal: new AbortController().signal,
        onEvent: (event) => {
          if (event.type === 'llm.streaming.part') {
            openrouterAccumulator.push(event.part);
          }
        },
      },
    );
    const openrouterFinished = openrouterAccumulator.finish();
    expect(openrouterFinished.content).toEqual([
      { type: 'think', think: 'We', reasoningKey: 'reasoning' },
      { type: 'text', text: 'ok' },
    ]);
    const openrouterOutbound = stubOpenAIClient(chatCompletionChunks());
    await createOpenAIRequester({
      clientFactory: openrouterOutbound.clientFactory,
    }).generate(
      { model, thinking: { effort: 'off' } },
      { messages: [createUserMessage('hi'), openrouterFinished] },
      { signal: new AbortController().signal },
    );
    const openrouterReplayed = bodyMessages(openrouterOutbound.body())[1]!;
    expect(openrouterReplayed['reasoning']).toBe('We');
    expect('reasoning_content' in openrouterReplayed).toBe(false);
    expect('reasoning_details' in openrouterReplayed).toBe(false);
  });

  it('echoes an empty reasoning_content on think-less assistant messages only when keeping all', async () => {
    const preserving = stubOpenAIClient(chatCompletionChunks());
    const preservingRequester = createKimiOpenAIRequester({
      ...kimiOpenAI,
      clientFactory: preserving.clientFactory,
    });
    await preservingRequester.generate(
      { model: thinkingCapableModel(), thinking: { effort: 'on', keep: 'all' } },
      { messages: [createUserMessage('hi'), createAssistantMessage([{ type: 'text', text: 'hello' }])] },
      { signal: new AbortController().signal },
    );
    expect(bodyMessages(preserving.body())[1]!['reasoning_content']).toBe('');

    const plain = stubOpenAIClient(chatCompletionChunks());
    const plainRequester = createKimiOpenAIRequester({
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

  it('selects the outbound reasoning key from the requester option or inbound detection', async () => {
    const mixedHistory = [
      createUserMessage('hi'),
      createAssistantMessage([
        { type: 'think', think: 'A', reasoningKey: 'reasoning_content' },
        { type: 'think', think: 'B' },
        { type: 'think', think: 'C', reasoningKey: 'reasoning' },
        { type: 'think', think: 'D', reasoningKey: 'reasoning_custom' },
      ]),
    ];
    const declared = stubOpenAIClient(chatCompletionChunks());
    const declaredRequester = createOpenAIRequester({
      reasoningKey: 'reasoning',
      clientFactory: declared.clientFactory,
    });
    await declaredRequester.generate(
      { model, thinking: { effort: 'off' } },
      { messages: mixedHistory },
      { signal: new AbortController().signal },
    );
    const inferred = stubOpenAIClient(chatCompletionChunks());
    const inferredRequester = createOpenAIRequester({ clientFactory: inferred.clientFactory });
    await inferredRequester.generate(
      { model, thinking: { effort: 'off' } },
      { messages: mixedHistory },
      { signal: new AbortController().signal },
    );
    for (const assistant of [bodyMessages(declared.body())[1], bodyMessages(inferred.body())[1]]) {
      expect(assistant['reasoning_content']).toBe('A');
      expect(assistant['reasoning']).toBe('BC');
      expect(assistant['reasoning_custom']).toBe('D');
    }

    const bodies: Record<string, unknown>[] = [];
    const server = createServer((request, response) => {
      void (async () => {
        let body = '';
        for await (const chunk of request) {
          body += String(chunk);
        }
        const parsed = JSON.parse(body) as Record<string, unknown>;
        bodies.push(parsed);
        const reasoningKey = parsed['model'] === 'other-model' ? 'reasoning_content' : 'reasoning';
        response.writeHead(200, { 'content-type': 'text/event-stream' });
        response.end(
          `data: ${JSON.stringify({
            id: 'chatcmpl-1',
            object: 'chat.completion.chunk',
            created: 0,
            model: 'test-model',
            choices: [
              {
                index: 0,
                delta: { role: 'assistant', content: 'hi', [reasoningKey]: 'detected' },
                finish_reason: 'stop',
              },
            ],
          })}\n\ndata: [DONE]\n\n`,
        );
      })().catch((error: unknown) => {
        response.destroy(error instanceof Error ? error : new Error(String(error)));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address === null || typeof address === 'string') {
      throw new Error('expected a TCP server');
    }
    const httpModel = { ...model, baseUrl: `http://127.0.0.1:${address.port}/v1` };
    const reasoningHistory = [
      createUserMessage('hi'),
      createAssistantMessage([{ type: 'think', think: 'cached' }]),
    ];
    const switchedHistory = [
      createUserMessage('hi'),
      createAssistantMessage([
        { type: 'think', think: 'from-b', reasoningKey: 'reasoning_content' },
        { type: 'think', think: 'unmarked' },
      ]),
    ];
    const requester = createOpenAIRequester();
    const kimiRequester = createKimiOpenAIRequester();
    try {
      await requester.generate(
        { model: httpModel },
        { messages },
        { signal: new AbortController().signal },
      );
      await requester.generate(
        { model: httpModel, thinking: { effort: 'off' } },
        { messages: reasoningHistory },
        { signal: new AbortController().signal },
      );
      await requester.generate(
        { model: { ...httpModel, model: 'other-model' }, thinking: { effort: 'off' } },
        { messages: reasoningHistory },
        { signal: new AbortController().signal },
      );
      await requester.generate(
        { model: httpModel, thinking: { effort: 'off' } },
        { messages: switchedHistory },
        { signal: new AbortController().signal },
      );
      await kimiRequester.generate(
        { model: httpModel },
        { messages },
        { signal: new AbortController().signal },
      );
      await kimiRequester.generate(
        { model: httpModel, thinking: { effort: 'off' } },
        { messages: reasoningHistory },
        { signal: new AbortController().signal },
      );
      const detectedAssistant = bodyMessages(bodies[1])[1];
      expect(detectedAssistant['reasoning']).toBe('cached');
      expect('reasoning_content' in detectedAssistant).toBe(false);
      const otherAssistant = bodyMessages(bodies[2])[1];
      expect(otherAssistant['reasoning_content']).toBe('cached');
      expect('reasoning' in otherAssistant).toBe(false);
      const switchedAssistant = bodyMessages(bodies[3])[1];
      expect(switchedAssistant['reasoning_content']).toBe('from-b');
      expect(switchedAssistant['reasoning']).toBe('unmarked');
      const kimiAssistant = bodyMessages(bodies[5])[1];
      expect(kimiAssistant['reasoning']).toBe('cached');
      expect('reasoning_content' in kimiAssistant).toBe(false);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) resolve();
          else reject(error);
        });
      });
    }

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
      reasoningKey: 'reasoning',
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
    ).resolves.toContainEqual({
      type: 'think',
      think: 'stream-think',
      reasoningKey: 'reasoning',
    });
    await expect(
      collect(chatCompletionChunks([{ reasoning: '' }, { content: 'hi' }])),
    ).resolves.toContainEqual({ type: 'think', think: '', reasoningKey: 'reasoning' });
    await expect(
      collect(
        chatCompletionChunks([
          { reasoning: '', content: 'hel' },
          { reasoning: '', content: 'lo' },
        ]),
      ),
    ).resolves.toEqual([
      { type: 'think', think: '', reasoningKey: 'reasoning' },
      { type: 'text', text: 'hello' },
    ]);
    await expect(
      collect(chatCompletionChunks([{ content: 'hi' }, { reasoning: '' }])),
    ).resolves.toEqual([
      { type: 'text', text: 'hi' },
      { type: 'think', think: '', reasoningKey: 'reasoning' },
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
      { type: 'think', think: '第一段', reasoningKey: 'reasoning_content' },
      {
        type: 'think',
        think: '第一段续',
        detailsIndex: 0,
        hidden: true,
        reasoningKey: 'reasoning_details',
      },
      {
        type: 'think',
        think: '第二段',
        detailsIndex: 1,
        hidden: true,
        reasoningKey: 'reasoning_details',
      },
      {
        type: 'think',
        think: '',
        encrypted: 'cipher',
        detailsIndex: 2,
        reasoningKey: 'reasoning_details',
      },
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
      { type: 'think', think: 'kept', detailsIndex: 1, reasoningKey: 'reasoning_details' },
      { type: 'text', text: 'ok' },
    ]);
    await expect(
      collect(
        chatCompletionChunks([
          {
            reasoning_content: '原文',
            reasoning_details: [
              { index: 0, type: 'summary', summary: '摘' },
              { index: 1, type: 'encrypted', encrypted: 'cipher' },
            ],
          },
          { content: 'ok' },
        ]),
      ),
    ).resolves.toEqual([
      { type: 'think', think: '原文', reasoningKey: 'reasoning_content' },
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
    await expect(
      collect(
        chatCompletionChunks([
          { reasoning_content: '原文一' },
          { reasoning_content: '原文二' },
          { reasoning_details: [{ index: 0, type: 'summary', summary: '摘一' }] },
          {
            reasoning_details: [
              { index: 0, type: 'summary', summary: '摘二' },
              { index: 1, type: 'encrypted', encrypted: 'cipher' },
            ],
          },
          { content: 'ok' },
        ]),
      ),
    ).resolves.toEqual([
      { type: 'think', think: '原文一原文二', reasoningKey: 'reasoning_content' },
      {
        type: 'think',
        think: '摘一摘二',
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
    await expect(
      collect(
        chatCompletionChunks([
          {
            reasoning_details: [
              { index: 0, type: 'summary', summary: '摘' },
              { index: 1, type: 'encrypted', encrypted: 'cipher' },
            ],
          },
          { content: 'ok' },
        ]),
      ),
    ).resolves.toEqual([
      { type: 'think', think: '摘', detailsIndex: 0, reasoningKey: 'reasoning_details' },
      {
        type: 'think',
        think: '',
        encrypted: 'cipher',
        detailsIndex: 1,
        reasoningKey: 'reasoning_details',
      },
      { type: 'text', text: 'ok' },
    ]);
    await expect(
      collect(
        chatCompletionChunks([
          {
            reasoning: 'We',
            reasoning_details: [
              { index: 0, type: 'reasoning.text', text: 'We', format: 'unknown' },
            ],
          },
          { content: 'ok' },
        ]),
      ),
    ).resolves.toEqual([
      { type: 'think', think: 'We', reasoningKey: 'reasoning' },
      { type: 'text', text: 'ok' },
    ]);
  });
});
