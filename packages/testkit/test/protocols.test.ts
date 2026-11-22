import Anthropic, { APIError as AnthropicAPIError } from '@anthropic-ai/sdk';
import { GoogleGenAI, type GenerateContentResponse } from '@google/genai';
import OpenAI from 'openai';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakeModel, type FakeModel, type FakeModelOptions } from '#/model/fake-model';
import { call, httpError, say, streamError, think, thinkSigned, withUsage } from '#/model/steps';

const models: FakeModel[] = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  await Promise.all(models.splice(0).map((model) => model.close()));
});

function fakeModel(options: FakeModelOptions = {}): FakeModel {
  const model = createFakeModel(options);
  models.push(model);
  return model;
}

function anthropicClient(model: FakeModel): Anthropic {
  return new Anthropic({ apiKey: 'sk-test', baseURL: 'http://testkit.invalid', fetch: model.fetch, maxRetries: 0 });
}

const ANTHROPIC_TOOLS = [{ name: 'Bash', input_schema: { type: 'object' as const } }];

const GOOGLE_TOOLS = [{ functionDeclarations: [{ name: 'Bash' }] }];

it.each([
  {
    protocol: 'Anthropic',
    path: '/v1/messages',
    messageField: 'messages',
    tools: ANTHROPIC_TOOLS,
    calls: { role: 'assistant', content: [
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
      { type: 'tool_use', id: 't2', name: 'Bash', input: {} },
    ] },
    result: (id: string) => ({ role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: [] }] }),
    image: { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }] },
    text: (text: string) => ({ role: 'user', content: text }),
    empty: { role: 'user', content: [] },
  },
  {
    protocol: 'Google',
    path: '/v1beta/models/testkit-model:generateContent',
    messageField: 'contents',
    tools: GOOGLE_TOOLS,
    calls: { role: 'model', parts: [
      { functionCall: { id: 't1', name: 'Bash', args: {} } },
      { functionCall: { id: 't2', name: 'Bash', args: {} } },
    ] },
    result: (id: string) => ({ role: 'user', parts: [{ functionResponse: { id, name: 'Bash', response: {} } }] }),
    image: { role: 'user', parts: [{ inlineData: { mimeType: 'image/png', data: 'AAAA' } }] },
    text: (text: string) => ({ role: 'user', parts: [{ text }] }),
    empty: { role: 'user', parts: [] },
  },
])('preserves empty $protocol user messages for sequence verification', async ({ path, messageField, tools, calls, result, image, text, empty }) => {
  const model = fakeModel();
  const send = (messages: unknown[]): Promise<Response> => model.fetch(`http://testkit.invalid${path}`, {
    method: 'POST',
    body: JSON.stringify({ model: 'testkit-model', max_tokens: 10, tools, [messageField]: messages }),
  });

  model.script(say('ok'));
  await send([text('go'), calls, result('t1'), result('t2'), image, text('next')]);
  model.verify();
  expect(model.request(0).view.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'tool', 'user', 'user']);

  model.script(say('ok'));
  await send([text('go'), calls, result('t1'), empty, result('t2'), image, text(''), text('  ')]);
  expect(model.request(1).view.messages[3]).toEqual({ role: 'user', text: '', parts: [], calls: [] });
  expect(model.problems()).toEqual([
    'request #1 (main): messages[3] (user) is empty',
    'request #1 (main): messages[3] (user) arrives before the results of tool calls t2',
    'request #1 (main): messages[6] (user) is empty',
    'request #1 (main): messages[7] (user) is empty',
  ]);
  expect(() => model.verify()).toThrow(/messages\[3\] \(user\) is empty/);
});

describe('anthropic messages', () => {
  it('streams thinking with a signature, text and a tool call the SDK assembles', async () => {
    const model = fakeModel();
    model.script(
      withUsage(
        { input: 11, output: 4, cacheRead: 7, cacheWrite: 2 },
        thinkSigned('let me see', 'sig-1', call('Bash', { command: 'ls -la' }, { text: 'Running', argumentChunks: 3 })),
      ),
    );
    const message = await anthropicClient(model)
      .messages.stream({ model: 'testkit-model', max_tokens: 100, messages: [{ role: 'user', content: 'list' }], tools: ANTHROPIC_TOOLS })
      .finalMessage();
    expect(message.content).toEqual([
      { type: 'thinking', thinking: 'let me see', signature: 'sig-1' },
      { type: 'text', text: 'Running' },
      { type: 'tool_use', id: 'call_0_0', name: 'Bash', input: { command: 'ls -la' } },
    ]);
    expect(message.stop_reason).toBe('tool_use');
    expect(message.usage).toMatchObject({ input_tokens: 11, output_tokens: 4, cache_read_input_tokens: 7, cache_creation_input_tokens: 2 });
    model.verify();
  });

  it('answers non-streaming requests with a message object', async () => {
    const model = fakeModel();
    model.script(say('plain'));
    const message = await anthropicClient(model).messages.create({ model: 'testkit-model', max_tokens: 10, messages: [{ role: 'user', content: 'hi' }], tools: ANTHROPIC_TOOLS });
    expect(message.content).toEqual([{ type: 'text', text: 'plain' }]);
    expect(message.stop_reason).toBe('end_turn');
  });

  it('decodes system prompts, tool results and images into the request view', async () => {
    const model = fakeModel();
    model.script(say('ok'));
    await anthropicClient(model).messages.create({
      model: 'testkit-model',
      max_tokens: 10,
      system: [{ type: 'text', text: 'Be brief.' }],
      tools: ANTHROPIC_TOOLS,
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'pwd' } }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: '/tmp' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
          ],
        },
      ],
    });
    const view = model.request(0).view;
    expect(model.request(0).protocol).toBe('anthropic');
    expect(view.system).toBe('Be brief.');
    expect(view.tools.map((tool) => tool.name)).toEqual(['Bash']);
    expect(view.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(view.messages[1]?.calls).toEqual([{ id: 't1', name: 'Bash', arguments: '{"command":"pwd"}' }]);
    expect(view.messages[2]).toMatchObject({ callId: 't1', text: '/tmp' });
    expect(view.messages[3]?.parts).toEqual([{ type: 'image', url: 'data:image/png;base64,AAAA', mediaType: 'image/png' }]);
    model.verify();
  });

  it('keeps text placed before a tool result in wire order so the sequence check catches it', async () => {
    const model = fakeModel();
    model.script(say('ok'));
    await anthropicClient(model).messages.create({
      model: 'testkit-model',
      max_tokens: 10,
      tools: ANTHROPIC_TOOLS,
      messages: [
        { role: 'user', content: 'run' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'also this' }, { type: 'tool_result', tool_use_id: 't1', content: 'done' }] },
      ],
    });
    expect(model.request(0).view.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user', 'tool']);
    expect(() => model.verify()).toThrow(/messages\[2\] \(user\) arrives before the results of tool calls t1/);
  });

  it('carries raw arguments in non-streaming tool calls', async () => {
    const model = fakeModel();
    model.script(call('Bash', {}, { rawArguments: '{"command":"ls"}' }), call('Bash', {}, { rawArguments: '{"command": ' }));
    const client = anthropicClient(model);
    const request = { model: 'testkit-model', max_tokens: 10, messages: [{ role: 'user' as const, content: 'run' }], tools: ANTHROPIC_TOOLS };
    const message = await client.messages.create(request);
    expect(message.content).toEqual([{ type: 'tool_use', id: 'call_0_0', name: 'Bash', input: { command: 'ls' } }]);
    await expect(client.messages.create(request)).rejects.toMatchObject({ status: 400 });
    expect(() => model.verify()).toThrow(/carries tool arguments as a JSON object/);
  });

  it('returns typed errors before the stream and error events inside it', async () => {
    const model = fakeModel();
    model.script(httpError(529, { message: 'busy' }), streamError(think('half'), { message: 'boom', type: 'api_error' }));
    const client = anthropicClient(model);
    const first = await client.messages.create({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'a' }], tools: ANTHROPIC_TOOLS }).catch((error: unknown) => error);
    expect(first).toBeInstanceOf(AnthropicAPIError);
    expect((first as AnthropicAPIError).status).toBe(529);
    expect((first as AnthropicAPIError).error).toMatchObject({ type: 'error', error: { type: 'overloaded_error', message: 'busy' } });
    await expect(client.messages.stream({ model: 'm', max_tokens: 5, messages: [{ role: 'user', content: 'b' }], tools: ANTHROPIC_TOOLS }).finalMessage()).rejects.toThrow(/boom/);
  });
});

describe('google genai', () => {
  async function googleClient(model: FakeModel): Promise<GoogleGenAI> {
    await model.listen();
    return new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: model.origin } });
  }

  it('streams thoughts, text and function calls with usage metadata', async () => {
    const model = fakeModel();
    model.script(withUsage({ input: 9, output: 2, cacheRead: 3 }, think('hmm', call('Bash', { command: 'ls' }, { text: 'Calling' }))));
    const client = await googleClient(model);
    const chunks: GenerateContentResponse[] = [];
    for await (const chunk of await client.models.generateContentStream({
      model: 'testkit-model',
      contents: [{ role: 'user', parts: [{ text: 'list' }] }],
      config: { tools: GOOGLE_TOOLS },
    })) {
      chunks.push(chunk);
    }
    const parts = chunks.flatMap((chunk) => chunk.candidates?.[0]?.content?.parts ?? []);
    expect(parts).toEqual([
      { text: 'hmm', thought: true },
      { text: 'Calling' },
      { functionCall: { id: 'call_0_0', name: 'Bash', args: { command: 'ls' } } },
    ]);
    const last = chunks.at(-1);
    expect(last?.candidates?.[0]?.finishReason).toBe('STOP');
    expect(last?.usageMetadata).toMatchObject({ promptTokenCount: 12, candidatesTokenCount: 2, cachedContentTokenCount: 3 });
    expect(model.request(0).protocol).toBe('google');
    expect(model.request(0).view).toMatchObject({ model: 'testkit-model', stream: true, tools: [{ name: 'Bash' }] });
    model.verify();
  });

  it('answers generateContent with a single response and decodes function responses', async () => {
    const model = fakeModel();
    model.script(say('done'));
    const client = await googleClient(model);
    const response = await client.models.generateContent({
      model: 'testkit-model',
      contents: [
        { role: 'user', parts: [{ text: 'run' }] },
        { role: 'model', parts: [{ functionCall: { id: 'f1', name: 'Bash', args: { command: 'pwd' } } }] },
        { role: 'user', parts: [{ functionResponse: { id: 'f1', name: 'Bash', response: { output: '/tmp' } } }, { text: 'next' }] },
      ],
      config: { systemInstruction: 'Be brief.', tools: GOOGLE_TOOLS },
    });
    expect(response.text).toBe('done');
    const view = model.request(0).view;
    expect(view.stream).toBe(false);
    expect(view.system).toBe('Be brief.');
    expect(view.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'user']);
    expect(view.messages[2]).toMatchObject({ callId: 'f1', text: '{"output":"/tmp"}' });
    model.verify();
  });

  it('checks intervening Google user parts before and between parallel tool results in wire order', async () => {
    const model = fakeModel();
    model.script(say('ok'));
    const response = await model.fetch('http://testkit.invalid/v1beta/models/testkit-model:generateContent', {
      method: 'POST',
      body: JSON.stringify({
        tools: GOOGLE_TOOLS,
        contents: [
          { role: 'user', parts: [{ text: 'run' }] },
          { role: 'model', parts: [
            { functionCall: { id: 'f1', name: 'Bash', args: {} } },
            { functionCall: { id: 'f2', name: 'Bash', args: {} } },
          ] },
          { role: 'user', parts: [
            { text: 'before' },
            { functionResponse: { id: 'f1', name: 'Bash', response: { output: 'first' } } },
            { text: 'between' },
            { functionResponse: { id: 'f2', name: 'Bash', response: { output: 'second' } } },
            { text: 'after' },
          ] },
        ],
      }),
    });
    expect(response.status).toBe(200);
    expect(model.problems()).toEqual([
      'request #0 (main): messages[2] (user) arrives before the results of tool calls f1, f2',
      'request #0 (main): messages[4] (user) arrives before the results of tool calls f2',
    ]);
    expect(() => model.verify()).toThrow(/arrives before the results/);
    expect(model.request(0).texts('user')).toEqual(['run', 'before', 'between', 'after']);
  });

  describe('parallel Google function calls of the same name', () => {
    type IDs = (string | undefined)[];

    async function sendHistory(model: FakeModel, ...groups: { calls: IDs; results: IDs }[]): Promise<void> {
      const response = await model.fetch('http://testkit.invalid/v1beta/models/testkit-model:generateContent', {
        method: 'POST',
        body: JSON.stringify({
          tools: GOOGLE_TOOLS,
          contents: [
            { role: 'user', parts: [{ text: 'run both' }] },
            ...groups.flatMap(({ calls, results }) => [
              { role: 'model', parts: calls.map((id, index) => ({ functionCall: { id, name: 'Bash', args: { command: `echo ${index}` } } })) },
              { role: 'user', parts: results.map((id, index) => ({ functionResponse: { id, name: 'Bash', response: { output: String(index) } } })) },
            ]),
          ],
        }),
      });
      expect(response.status).toBe(200);
    }

    it('pairs each ID-less result in call order and preserves explicit IDs throughout the history', async () => {
      const model = fakeModel();
      model.script(say('done'));
      const anonymousPair = { calls: [undefined, undefined], results: [undefined, undefined] };
      await sendHistory(model, anonymousPair);
      model.verify();
      const previousCalls = model.request(0).view.messages.flatMap((message) => message.calls);
      const reservedId = previousCalls.find((invocation) => invocation.id !== 'Bash')?.id;
      expect(reservedId).toBeTypeOf('string');

      model.script(say('done'));
      await sendHistory(model, anonymousPair, {
        calls: [undefined, 'Bash', reservedId],
        results: [reservedId, 'Bash', undefined],
      });
      model.verify();
      const messages = model.request(1).view.messages;
      const ids = messages.flatMap((message) => message.calls.map((invocation) => invocation.id));
      expect(ids).toHaveLength(5);
      expect(new Set(ids).size).toBe(5);
      expect(ids.slice(3)).toEqual(['Bash', reservedId]);
      expect(messages.filter((message) => message.role === 'tool').map((message) => message.callId)).toEqual([
        ids[0], ids[1], reservedId, 'Bash', ids[2],
      ]);
    });

    it.each([
      { example: 'a missing ID-less result', calls: [undefined, undefined], results: [undefined], problems: [/tool call .+ has no result/] },
      { example: 'an extra ID-less result', calls: [undefined, undefined], results: [undefined, undefined, undefined], problems: [/messages\[4\].*answers unknown tool call/] },
      { example: 'a repeated explicit result ID', calls: ['first', 'second'], results: ['first', 'first'], problems: [/answers unknown tool call first/, /tool call second has no result/] },
      { example: 'an ID-less result for an explicit call', calls: [undefined, 'Bash'], results: [undefined, undefined], problems: [/answers unknown tool call/, /tool call Bash has no result/] },
      { example: 'an explicit result for an ID-less call', calls: ['Bash', undefined], results: ['Bash', 'Bash'], problems: [/answers unknown tool call Bash/, /tool call .+ has no result/] },
    ])('reports $example', async ({ calls, results, problems }) => {
      const model = fakeModel();
      model.script(say('done'));
      await sendHistory(model, { calls, results });
      expect(() => model.verify()).toThrow();
      expect(model.problems()).toEqual(problems.map((problem) => expect.stringMatching(problem)));
    });
  });

  it('ends a stream with an error chunk the SDK raises as an API error', async () => {
    const model = fakeModel();
    model.script(streamError(say('partial'), { status: 503, message: 'overloaded' }), httpError(429, { message: 'slow down', retryAfterSeconds: 2 }));
    vi.stubGlobal('fetch', model.fetch);
    const client = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: 'http://testkit.invalid' } });
    const texts: string[] = [];
    const streamed = async (): Promise<void> => {
      for await (const chunk of await client.models.generateContentStream({
        model: 'testkit-model',
        contents: [{ role: 'user', parts: [{ text: 'go' }] }],
        config: { tools: GOOGLE_TOOLS },
      })) {
        texts.push(chunk.text ?? '');
      }
    };
    await expect(streamed()).rejects.toMatchObject({ name: 'ApiError', status: 503, message: expect.stringContaining('overloaded') });
    expect(texts).toEqual(['partial']);
    const rejected = await client.models
      .generateContent({ model: 'testkit-model', contents: [{ role: 'user', parts: [{ text: 'again' }] }], config: { tools: GOOGLE_TOOLS } })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(rejected).toMatchObject({ status: 429 });
    expect(JSON.parse((rejected as Error).message.replace(/^[^{]*/, ''))).toMatchObject({
      error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [{ retryDelay: '2s' }] },
    });
    vi.unstubAllGlobals();
    model.verify();
  });

  it('reports raw arguments the protocol cannot carry', async () => {
    const model = fakeModel();
    model.script(call('Bash', {}, { rawArguments: '{"command": ' }));
    const client = await googleClient(model);
    await expect(
      client.models.generateContent({ model: 'testkit-model', contents: [{ role: 'user', parts: [{ text: 'x' }] }], config: { tools: GOOGLE_TOOLS } }),
    ).rejects.toThrow();
    expect(() => model.verify()).toThrow(/carries tool arguments as a JSON object/);
  });
});

it.each([
  {
    protocol: 'OpenAI', path: '/v1/chat/completions', field: 'messages', options: { model: 'testkit-model' },
    user: { role: 'user', content: 'run' },
    calls: (...ids: string[]) => ({ role: 'assistant', tool_calls: ids.map((id) => ({ type: 'function', id, function: { name: 'Bash', arguments: '{}' } })) }),
    result: { role: 'tool', tool_call_id: 'shared', content: 'done' },
  },
  {
    protocol: 'Anthropic', path: '/v1/messages', field: 'messages', options: { model: 'testkit-model', max_tokens: 10 },
    user: { role: 'user', content: 'run' },
    calls: (...ids: string[]) => ({ role: 'assistant', content: ids.map((id) => ({ type: 'tool_use', id, name: 'Bash', input: {} })) }),
    result: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'shared', content: 'done' }] },
  },
  {
    protocol: 'Google', path: '/v1beta/models/testkit-model:generateContent', field: 'contents', options: {},
    user: { role: 'user', parts: [{ text: 'run' }] },
    calls: (...ids: string[]) => ({ role: 'model', parts: ids.map((id) => ({ functionCall: { id, name: 'Bash', args: {} } })) }),
    result: { role: 'user', parts: [{ functionResponse: { id: 'shared', name: 'Bash', response: { output: 'done' } } }] },
  },
])('rejects a duplicate pending $protocol tool call ID and accepts reuse after a result', async ({ path, options, field, user, calls, result }) => {
  const model = fakeModel();
  const send = (messages: unknown[]): Promise<Response> => model.fetch(`http://testkit.invalid${path}`, {
    method: 'POST',
    body: JSON.stringify({ ...options, [field]: messages }),
  });

  expect((await send([user, calls('shared'), result, calls('shared'), result])).status).toBe(200);
  model.verify();

  expect((await send([user, calls('shared', 'shared'), result])).status).toBe(200);
  expect(() => model.verify()).toThrow(/messages\[1\].*shared/);
});

describe('random byte splitting', () => {
  const TEXT = '你好，世界🙂 done';
  const COMMAND = 'echo 你好🙂';
  const reply = () => think('想一想', call('Bash', { command: COMMAND }, { text: TEXT }));
  const chunking = { seed: 7, maxBytes: 3 };

  it('cuts the stream inside multi-byte characters and SSE events, and keeps the bytes intact', async () => {
    const read = async (model: FakeModel): Promise<Uint8Array[]> => {
      model.script(reply());
      const response = await model.fetch('http://testkit.invalid/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'testkit-model', stream: true, messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } }] }),
      });
      const chunks: Uint8Array[] = [];
      for await (const chunk of response.body!) chunks.push(chunk);
      return chunks;
    };
    const whole = await read(fakeModel());
    const split = await read(fakeModel({ chunking }));
    const joined = (chunks: Uint8Array[]): string => new TextDecoder().decode(Buffer.concat(chunks));
    expect(joined(split)).toBe(joined(whole));
    expect(split.length).toBeGreaterThan(whole.length * 10);
    expect(split.every((chunk) => chunk.length <= 3)).toBe(true);
    const fatal = new TextDecoder('utf-8', { fatal: true });
    expect(split.some((chunk) => { try { fatal.decode(chunk); return false; } catch { return true; } })).toBe(true);
    expect(split.some((chunk) => !new TextDecoder().decode(chunk).includes('\n'))).toBe(true);
  });

  it('keeps each lane on its own sequence, so concurrent lanes do not change how a request is cut', async () => {
    const sizesOf = async (order: readonly ('main' | 'side')[]): Promise<number[]> => {
      const model = fakeModel({ chunking });
      model.script(say(TEXT));
      model.lane('side').script(say('side reply'));
      const requests = order.map((lane) => model.fetch('http://testkit.invalid/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({
          model: 'testkit-model',
          stream: true,
          messages: [{ role: 'user', content: lane }],
          tools: lane === 'main' ? [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } }] : undefined,
        }),
      }));
      const responses = await Promise.all(requests);
      const main = responses[order.indexOf('main')]!;
      const sizes: number[] = [];
      for await (const chunk of main.body!) sizes.push(chunk.length);
      await Promise.all(responses.filter((response) => response !== main).map((response) => response.text()));
      return sizes;
    };
    expect(await sizesOf(['side', 'main'])).toEqual(await sizesOf(['main', 'side']));
  });

  it('rejects chunking options that would drop or garble data', () => {
    expect(() => createFakeModel({ chunking: { seed: 1, maxBytes: Number.NaN } })).toThrow(/chunking\.maxBytes must be a positive integer/);
    expect(() => createFakeModel({ chunking: { seed: 1, maxBytes: 0 } })).toThrow(/chunking\.maxBytes must be a positive integer/);
    expect(() => createFakeModel({ chunking: { seed: 1.5 } })).toThrow(/chunking\.seed must be an integer/);
  });

  it('is deterministic for a seed', async () => {
    const sizes = async (): Promise<number[]> => {
      const model = fakeModel({ chunking });
      model.script(say(TEXT));
      const response = await model.fetch('http://testkit.invalid/v1/chat/completions', {
        method: 'POST',
        body: JSON.stringify({ model: 'testkit-model', stream: true, messages: [{ role: 'user', content: 'go' }] }),
      });
      const result: number[] = [];
      for await (const chunk of response.body!) result.push(chunk.length);
      return result;
    };
    expect(await sizes()).toEqual(await sizes());
  });

  it('still parses into the same reasoning, text and tool call with the official OpenAI SDK', async () => {
    const model = fakeModel({ chunking });
    model.script(reply());
    const client = new OpenAI({ apiKey: 'sk-test', baseURL: 'http://testkit.invalid/v1', fetch: model.fetch, maxRetries: 0 });
    let text = '';
    let reasoning = '';
    let args = '';
    for await (const chunk of await client.chat.completions.create({ model: 'testkit-model', stream: true, messages: [{ role: 'user', content: 'go' }], tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } }] })) {
      const delta = chunk.choices[0]?.delta as { content?: string | null; reasoning_content?: string; tool_calls?: { function?: { arguments?: string } }[] } | undefined;
      text += delta?.content ?? '';
      reasoning += delta?.reasoning_content ?? '';
      args += delta?.tool_calls?.map((toolCall) => toolCall.function?.arguments ?? '').join('') ?? '';
    }
    expect({ text, reasoning, args: JSON.parse(args) as unknown }).toEqual({ text: TEXT, reasoning: '想一想', args: { command: COMMAND } });
    model.verify();
  });

  it('still parses with the official Anthropic SDK', async () => {
    const model = fakeModel({ chunking });
    model.script(reply());
    const message = await anthropicClient(model).messages.stream({ model: 'testkit-model', max_tokens: 100, messages: [{ role: 'user', content: 'go' }], tools: ANTHROPIC_TOOLS }).finalMessage();
    expect(message.content).toEqual([
      { type: 'thinking', thinking: '想一想', signature: '' },
      { type: 'text', text: TEXT },
      { type: 'tool_use', id: 'call_0_0', name: 'Bash', input: { command: COMMAND } },
    ]);
    model.verify();
  });

  it('still parses with the official Google SDK over HTTP', async () => {
    const model = fakeModel({ chunking });
    model.script(reply());
    await model.listen();
    const client = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: model.origin } });
    const parts = [];
    for await (const chunk of await client.models.generateContentStream({ model: 'testkit-model', contents: [{ role: 'user', parts: [{ text: 'go' }] }], config: { tools: GOOGLE_TOOLS } })) {
      parts.push(...(chunk.candidates?.[0]?.content?.parts ?? []));
    }
    expect(parts).toEqual([{ text: '想一想', thought: true }, { text: TEXT }, { functionCall: { id: 'call_0_0', name: 'Bash', args: { command: COMMAND } } }]);
    model.verify();
  });
});
