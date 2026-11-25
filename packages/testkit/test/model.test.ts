import { execFile } from 'node:child_process';
import { once } from 'node:events';
import { promisify } from 'node:util';

import OpenAI, { APIError } from 'openai';
import type { ChatCompletionChunk, ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeModelClosedError, FakeModelVerificationError, TestkitError } from '#/errors';
import { deferred } from '#/fixtures/wait';
import { createFakeModel, type FakeModel } from '#/model/fake-model';
import {
  after,
  batch,
  call,
  disconnect,
  finishWith,
  held,
  httpError,
  interleave,
  networkError,
  paced,
  rawResponse,
  say,
  streamError,
  think,
  thinkSigned,
  withUsage,
} from '#/model/steps';
import { agent, bash, exitPlanMode, read, taskStop, todoList, updateGoal } from '#/model/tools';
import type { ModelRequest, ReplyStep, StepContext } from '#/model/types';

const models: FakeModel[] = [];

afterEach(async () => {
  await Promise.all(models.splice(0).map((model) => model.close()));
});

function fakeModel(options: Parameters<typeof createFakeModel>[0] = {}): FakeModel {
  const model = createFakeModel(options);
  models.push(model);
  return model;
}

function clientOf(model: FakeModel, headers: Record<string, string> = {}): OpenAI {
  return new OpenAI({ apiKey: 'sk-test', baseURL: 'http://testkit.invalid/v1', fetch: model.fetch, maxRetries: 0, defaultHeaders: headers });
}

const TOOLS = [{ type: 'function' as const, function: { name: 'Bash', parameters: { type: 'object' } } }];

async function collect(
  client: OpenAI,
  messages: ChatCompletionMessageParam[] = [{ role: 'user', content: 'hello' }],
  options: { tools?: boolean; signal?: AbortSignal } = {},
): Promise<ChatCompletionChunk[]> {
  const stream = await client.chat.completions.create(
    { model: 'testkit-model', messages, stream: true, tools: options.tools === false ? undefined : TOOLS },
    { signal: options.signal },
  );
  const chunks: ChatCompletionChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function contentOf(chunks: readonly ChatCompletionChunk[]): string {
  return chunks.map((chunk) => chunk.choices[0]?.delta.content ?? '').join('');
}

describe('replies', () => {
  it('streams text chunks with a stop finish reason and usage', async () => {
    const model = fakeModel();
    model.script(withUsage({ input: 7, output: 3, cacheRead: 5 }, say(['Hel', 'lo'])));
    const chunks = await collect(clientOf(model));
    expect(contentOf(chunks)).toBe('Hello');
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('stop');
    expect(chunks.at(-1)?.usage).toMatchObject({
      prompt_tokens: 12,
      completion_tokens: 3,
      total_tokens: 15,
      prompt_tokens_details: { cached_tokens: 5 },
    });
    expect(model.request(0).state).toBe('finished');
    model.verify();
  });

  it('streams reasoning before text and tool calls with deterministic ids', async () => {
    const model = fakeModel();
    model.script(think('pondering', call('Bash', { command: 'ls' }, { text: 'Running', argumentChunks: 3 })));
    const chunks = await collect(clientOf(model));
    const deltas = chunks.map((chunk) => chunk.choices[0]?.delta as Record<string, unknown> | undefined);
    expect(deltas[0]).toMatchObject({ role: 'assistant', reasoning_content: 'pondering' });
    expect(contentOf(chunks)).toBe('Running');
    const calls = chunks.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []);
    expect(calls[0]).toMatchObject({ index: 0, id: 'call_0_0', function: { name: 'Bash', arguments: '' } });
    expect(calls.slice(1).map((piece) => piece.function?.arguments).join('')).toBe('{"command":"ls"}');
    expect(calls).toHaveLength(4);
    expect(chunks.at(-1)?.choices[0]?.finish_reason).toBe('tool_calls');
    expect(model.callId(0, 0)).toBe('call_0_0');
  });

  it.each([true, false])('returns the scripted request ID with stream=%s', async (stream) => {
    const model = fakeModel();
    model.script({ ...say('done'), headers: { 'x-request-id': 'example-request' } });
    const response = await clientOf(model).chat.completions.create({
      model: 'testkit-model',
      messages: [{ role: 'user', content: 'hello' }],
      tools: TOOLS,
      stream,
    }).asResponse();
    expect(response.headers.get('x-request-id')).toBe('example-request');
    expect(response.headers.get('content-type')).toContain(stream ? 'text/event-stream' : 'application/json');
    expect(await response.text()).toContain('done');
    model.verify();
  });

  it('emits parallel calls in order, or interleaves their argument pieces', async () => {
    const model = fakeModel();
    const parallel = batch(call('Bash', { command: 'a' }, { argumentChunks: 2 }), call('Bash', { command: 'b' }, { argumentChunks: 2 }));
    model.script(parallel, interleave(parallel));
    const order = (chunks: ChatCompletionChunk[]): string =>
      chunks
        .flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? [])
        .map((piece) => `${piece.index}${piece.id === undefined ? 'a' : 's'}`)
        .join(' ');
    expect(order(await collect(clientOf(model)))).toBe('0s 0a 0a 1s 1a 1a');
    expect(order(await collect(clientOf(model)))).toBe('0s 1s 0a 1a 0a 1a');
  });

  it('sends raw arguments untouched and honours explicit finish reasons', async () => {
    const model = fakeModel();
    model.script(finishWith('truncated', call('Bash', {}, { rawArguments: '{"command": "ls"' })), finishWith({ raw: 'weird' }, say('x')));
    const first = await collect(clientOf(model));
    expect(first.flatMap((chunk) => chunk.choices[0]?.delta.tool_calls ?? []).map((piece) => piece.function?.arguments).join('')).toBe(
      '{"command": "ls"',
    );
    expect(first.at(-1)?.choices[0]?.finish_reason).toBe('length');
    const second = await collect(clientOf(model));
    expect(second.at(-1)?.choices[0]?.finish_reason).toBe('weird');
  });

  it('answers non-streaming requests with a chat completion object', async () => {
    const model = fakeModel();
    model.script(think('why', call('Bash', { command: 'pwd' }, { text: 'Sure' })));
    const completion = await clientOf(model).chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS });
    const message = completion.choices[0]?.message as unknown as Record<string, unknown>;
    expect(message).toMatchObject({ content: 'Sure', reasoning_content: 'why' });
    expect(completion.choices[0]?.message.tool_calls?.[0]).toMatchObject({ id: 'call_0_0', function: { name: 'Bash', arguments: '{"command":"pwd"}' } });
    expect(completion.choices[0]?.finish_reason).toBe('tool_calls');
  });
});

describe('disconnects', () => {
  it('can report usage before dropping the connection', async () => {
    const model = fakeModel();
    model.script(disconnect(withUsage({ input: 4, output: 2 }, say('partial')), { afterUsage: true }));
    const chunks: ChatCompletionChunk[] = [];
    await expect(async () => {
      for await (const chunk of await clientOf(model).chat.completions.create({ model: 'testkit-model', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, stream: true })) chunks.push(chunk);
    }).rejects.toThrow();
    expect(contentOf(chunks)).toBe('partial');
    expect(chunks.at(-1)).toMatchObject({ choices: [{ finish_reason: null }], usage: { prompt_tokens: 4, completion_tokens: 2 } });
    expect(model.request(0).state).toBe('cut');
  });
});

describe('file uploads', () => {
  it('stores an uploaded file, answers with a ready file object and serves it back by ID', async () => {
    const model = fakeModel();
    const client = clientOf(model);
    const uploaded = await client.files.create({
      file: new File([new Uint8Array([1, 2, 3])], 'clip.mp4', { type: 'video/mp4' }),
      purpose: 'video' as never,
    });
    expect(uploaded).toMatchObject({ id: 'file-0', object: 'file', filename: 'clip.mp4', purpose: 'video', status: 'ok' });
    expect(model.uploads()).toEqual([
      expect.objectContaining({ index: 0, id: 'file-0', filename: 'clip.mp4', purpose: 'video', fileContentType: 'video/mp4', state: 'stored' }),
    ]);
    expect(model.uploads()[0]?.contentType).toContain('multipart/form-data');
    expect(await client.files.retrieve('file-0')).toMatchObject({ id: 'file-0', status: 'ok' });
    model.verify();
  });

  it('keeps a held upload open until the client gives up, and records it as aborted', async () => {
    const model = fakeModel();
    model.holdUploads();
    const controller = new AbortController();
    const upload = clientOf(model).files.create(
      { file: new File([new Uint8Array([1])], 'clip.mp4', { type: 'video/mp4' }), purpose: 'video' as never },
      { signal: controller.signal },
    );
    await expect.poll(() => model.uploads()[0]?.state).toBe('held');
    controller.abort();
    await expect(upload).rejects.toThrow();
    await expect.poll(() => model.uploads()[0]?.state).toBe('aborted');
  });

  it('reports a request for a file that was never uploaded', async () => {
    const model = fakeModel();
    await expect(clientOf(model).files.retrieve('file-7')).rejects.toThrow();
    expect(() => model.verify()).toThrow(/asked for a file that was never uploaded/);
  });
});

describe('strictness', () => {
  it('fails an unscripted main request with a non-retryable error and reports it', async () => {
    const model = fakeModel();
    await expect(collect(clientOf(model), [{ role: 'user', content: 'who answers?' }])).rejects.toMatchObject({ status: 400 });
    expect(model.request(0).state).toBe('failed');
    expect(() => model.verify()).toThrow(FakeModelVerificationError);
    expect(() => model.verify()).toThrow(/request #0 on lane "main" had no scripted step \(first user text: "who answers\?"\)/);
  });

  it('reports unused steps by their labels', () => {
    const model = fakeModel();
    model.script(say('never sent'), after(5, httpError(503)));
    expect(() => model.verify()).toThrow(/lane "main" has 2 unused step\(s\): say\("never sent"\), after\(5, httpError\(503\)\)/);
    model.lane('main').clear();
    expect(() => model.verify()).not.toThrow();
  });

  it('answers side requests without tools from their own lane and keeps the main script intact', async () => {
    const model = fakeModel({ sideReply: 'A title' });
    model.script(say('main reply'));
    const side = await collect(clientOf(model), [{ role: 'user', content: 'title this' }], { tools: false });
    expect(contentOf(side)).toBe('A title');
    expect(contentOf(await collect(clientOf(model)))).toBe('main reply');
    expect(model.requests('side')).toHaveLength(1);
    expect(model.requests('main')).toHaveLength(1);
    model.verify();
  });

  it('can hang unscripted requests until they are released', async () => {
    const model = fakeModel();
    model.lane('main').unscripted('hang');
    const pending = collect(clientOf(model));
    await model.waitForHeldTurn();
    expect(model.heldTurns()).toBe(1);
    model.releaseHeld();
    expect(contentOf(await pending)).toBe('Working on it');
    model.verify();
  });
});

describe('holds', () => {
  it('pauses before a chunk, reports the request that reached it, and resumes on release', async () => {
    const model = fakeModel();
    model.script(held('mid', say(['one', 'two']), 1));
    const seen: string[] = [];
    const reading = (async () => {
      const stream = await clientOf(model).chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'go' }], tools: TOOLS, stream: true });
      for await (const chunk of stream) seen.push(chunk.choices[0]?.delta.content ?? '');
    })();
    const request = await model.hold('mid').reached();
    expect(request.firstUserText).toBe('go');
    expect(request.state).toBe('held');
    await expect.poll(() => seen.join('')).toBe('one');
    model.hold('mid').release();
    await reading;
    expect(seen.join('')).toBe('onetwo');
    expect(model.request(0).state).toBe('finished');
  });

  it('fails before the headers with the requested status', async () => {
    const model = fakeModel();
    model.script(held('gate', say('never')));
    model.hold('gate').fail(429);
    await expect(collect(clientOf(model))).rejects.toMatchObject({ status: 429 });
    expect(model.request(0).state).toBe('failed');
  });

  it('cuts the stream after the headers', async () => {
    const model = fakeModel();
    model.script(held('cut', say(['a', 'b']), 1));
    const reading = collect(clientOf(model));
    await model.hold('cut').reached();
    model.hold('cut').cut();
    await expect(reading).rejects.toThrow();
    expect(model.request(0).state).toBe('cut');
    model.verify();
  });

  it('releases only the holds that requests are waiting at', async () => {
    const model = fakeModel();
    model.script(held('first', say('one')), held('later', say('two')));
    const client = clientOf(model);
    const first = collect(client);
    await model.hold('first').reached();
    model.releaseHeld();
    expect(contentOf(await first)).toBe('one');
    const second = collect(client).then(
      () => 'completed',
      () => 'failed',
    );
    await model.hold('later').reached();
    model.hold('later').cut();
    await expect(second).resolves.toBe('failed');
    expect(model.request(1).state).toBe('cut');
    model.verify();
  });

  it('rejects holds that cannot work', () => {
    const model = fakeModel();
    expect(() => held('far', say('x'), 2)).toThrow(TestkitError);
    model.script(held('late', say(['a', 'b']), 1));
    expect(() => model.hold('late').fail(500)).toThrow(/cannot send an error status/);
    expect(() => model.script(held('late', say('again')))).toThrow(/already used/);
    model.lane('main').clear();
  });

  it('marks a request aborted when the client gives up at a hold, without a verify complaint', async () => {
    const model = fakeModel();
    model.script(held('wait', say('late')));
    const controller = new AbortController();
    const reading = collect(clientOf(model), undefined, { signal: controller.signal });
    await model.hold('wait').reached();
    controller.abort();
    await expect(reading).rejects.toThrow();
    await expect.poll(() => model.request(0).state).toBe('aborted');
    model.verify();
  });

  it('reports a hold that was reached but never settled', async () => {
    const model = fakeModel();
    model.script(held('forgotten', say('x')));
    void collect(clientOf(model)).catch(() => undefined);
    await model.hold('forgotten').reached();
    expect(() => model.verify()).toThrow(/hold "forgotten" was reached by request #0 but never released/);
    model.hold('forgotten').release();
  });
});

describe('failures', () => {
  it('returns HTTP errors with the scripted headers and body', async () => {
    const model = fakeModel();
    model.script(httpError(429, { message: 'slow down', retryAfterMs: 1500, requestId: 'req-1', code: 'rate_limited' }));
    const error = await collect(clientOf(model)).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(APIError);
    const apiError = error as APIError;
    expect(apiError.status).toBe(429);
    expect(apiError.headers?.get('retry-after-ms')).toBe('1500');
    expect(apiError.headers?.get('x-request-id')).toBe('req-1');
    expect(apiError.error).toMatchObject({ message: 'slow down', code: 'rate_limited' });
  });

  it('sends a custom error body verbatim', async () => {
    const model = fakeModel();
    model.script(httpError(400, { body: { error: { message: 'context too long', type: 'context_length_exceeded' } } }));
    const error = (await collect(clientOf(model)).catch((caught: unknown) => caught)) as APIError;
    expect(error.error).toEqual({ message: 'context too long', type: 'context_length_exceeded' });
  });

  it('fails mid-stream with an error event after the scripted text', async () => {
    const model = fakeModel();
    model.script(streamError(say('partial'), { message: 'upstream reset', status: 500 }));
    const seen: string[] = [];
    const error = await (async () => {
      const stream = await clientOf(model).chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'go' }], tools: TOOLS, stream: true });
      for await (const chunk of stream) seen.push(chunk.choices[0]?.delta.content ?? '');
    })().catch((caught: unknown) => caught);
    expect(seen.join('')).toBe('partial');
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).message).toMatch(/upstream reset/);
  });

  it('drops the connection mid-stream or before responding', async () => {
    const model = fakeModel();
    model.script(disconnect(say('half')), networkError());
    await expect(collect(clientOf(model))).rejects.toThrow();
    expect(model.request(0).state).toBe('cut');
    await expect(collect(clientOf(model))).rejects.toThrow();
    expect(model.request(1).state).toBe('failed');
  });

  it('sends raw bytes for malformed streams', async () => {
    const model = fakeModel();
    model.script(rawResponse({ chunks: ['data: {not json}\n\n'] }));
    await expect(collect(clientOf(model))).rejects.toThrow();
  });
});

describe('routing', () => {
  const metadata = (fields: Record<string, string>): Record<string, string> => ({ 'X-Msh-Client-Metadata': JSON.stringify(fields) });

  it('routes requests by the client metadata header', async () => {
    const model = fakeModel();
    model.script(say('main'));
    model.lane('compaction').script(say('summary'));
    model.lane('subagent').script(say('sub'));
    expect(contentOf(await collect(clientOf(model, metadata({ agent_role: 'subagent', step_reason: 'turn_start' }))))).toBe('sub');
    expect(contentOf(await collect(clientOf(model, metadata({ agent_role: 'main', step_reason: 'compact' }))))).toBe('summary');
    expect(contentOf(await collect(clientOf(model, metadata({ agent_role: 'main', step_reason: 'turn_start' }))))).toBe('main');
    expect(model.request(0).metadata).toEqual({ agentRole: 'subagent', stepReason: 'turn_start' });
    expect(model.requests().map((request) => request.lane)).toEqual(['subagent', 'compaction', 'main']);
  });

  it('routes by first user text and by custom predicates before the built-in lanes', async () => {
    const model = fakeModel();
    model.scriptFor('helper task', say('helper'));
    model.route('by model', (request) => request.view.model === 'special').script(say('special'));
    model.script(say('main'));
    expect(contentOf(await collect(clientOf(model), [{ role: 'user', content: '<system-reminder>x</system-reminder>do the helper task' }]))).toBe('helper');
    const special = await clientOf(model).chat.completions.create({ model: 'special', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, stream: true });
    const specialChunks: ChatCompletionChunk[] = [];
    for await (const chunk of special) specialChunks.push(chunk);
    expect(contentOf(specialChunks)).toBe('special');
    expect(contentOf(await collect(clientOf(model)))).toBe('main');
    expect(() => model.route('main', () => true)).toThrow(/already exists/);
    expect(() => model.lane('nope')).toThrow(/Unknown lane "nope"/);
  });

  it('lets a step be computed from the request and its position in the lane', async () => {
    const model = fakeModel();
    const contexts: StepContext[] = [];
    const answer = (request: ModelRequest, context: StepContext): ReturnType<typeof say> => {
      contexts.push(context);
      return say(`echo ${request.userTextsSinceReply.join(' ')} #${context.call}`);
    };
    model.script(answer, answer);
    expect(contentOf(await collect(clientOf(model), [{ role: 'user', content: 'first' }]))).toBe('echo first #0');
    expect(contentOf(await collect(clientOf(model), [{ role: 'user', content: 'second' }]))).toBe('echo second #1');
    expect(contexts).toEqual([
      { lane: 'main', call: 0, signal: expect.any(AbortSignal) },
      { lane: 'main', call: 1, signal: expect.any(AbortSignal) },
    ]);
  });

  it('reports a step function that throws', async () => {
    const model = fakeModel();
    model.script(() => {
      throw new Error('bad factory');
    });
    await expect(collect(clientOf(model))).rejects.toMatchObject({ status: 400 });
    expect(() => model.verify()).toThrow(/threw: Error: bad factory/);
  });

  it('reports a route matcher that throws and fails the request without inviting a retry', async () => {
    const model = fakeModel();
    model.route('broken', () => {
      throw new Error('matcher bug');
    });
    await expect(collect(clientOf(model))).rejects.toMatchObject({ status: 400 });
    expect(model.problems()).toEqual([expect.stringContaining('the matcher of lane "broken" threw: matcher bug')]);
  });
});

describe('requests', () => {
  it('records a normalized view and the helper fields', async () => {
    const model = fakeModel();
    model.script(say('ok'));
    await collect(clientOf(model), [
      { role: 'system', content: 'You are a test.' },
      { role: 'system', content: '' },
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file.txt' },
      { role: 'assistant', content: 'done' },
      {
        role: 'user',
        content: [
          { type: 'text', text: 'next <system-reminder>stay focused</system-reminder>' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ],
      },
    ]);
    const request = model.request(0);
    expect(request.protocol).toBe('openai');
    expect(request.path).toBe('/v1/chat/completions');
    expect(request.authorization).toBe('Bearer sk-test');
    expect(request.view.system).toBe('You are a test.');
    expect(request.tools).toEqual(['Bash']);
    expect(request.view.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect(request.view.messages[1]?.calls).toEqual([{ id: 'c1', name: 'Bash', arguments: '{"command":"ls"}' }]);
    expect(request.view.messages[4]?.parts[1]).toEqual({ type: 'image', url: 'data:image/png;base64,AAAA' });
    expect(request.userTextsSinceReply).toEqual(['next']);
    expect(request.remindersSinceReply).toEqual(['stay focused']);
    expect(request.texts('assistant')).toEqual(['', 'done']);
    model.verify();
  });

  it('checks every request for malformed message sequences', async () => {
    const model = fakeModel();
    model.script(say('ok'));
    await collect(clientOf(model), [
      { role: 'user', content: 'run it' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
      { role: 'user', content: 'too early' },
    ]);
    expect(() => model.verify()).toThrow(/messages\[2\] \(user\) arrives before the results of tool calls c1/);
  });

  it.each(['system', 'developer'] as const)('reports an intervening %s message before a tool result', async (role) => {
    const model = fakeModel();
    model.script(say('ok'));
    await collect(clientOf(model), [
      { role: 'user', content: 'run' },
      { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'Bash', arguments: '{}' } }] },
      { role, content: 'An instruction.' },
      { role: 'tool', tool_call_id: 'c1', content: 'done' },
    ]);
    expect(() => model.verify()).toThrow(/messages\[2\] \(system\) arrives before the results of tool calls c1/);
    expect(model.request(0).view.system).toBe('An instruction.');
    expect(model.request(0).view.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('allows repeated user text separated by a developer instruction', async () => {
    const model = fakeModel();
    model.script(say('ok'));
    await collect(clientOf(model), [
      { role: 'system', content: 'Initial instruction.' },
      { role: 'user', content: 'run' },
      { role: 'developer', content: 'Later instruction.' },
      { role: 'user', content: 'run' },
    ]);
    model.verify();
    expect(model.request(0).view.system).toBe('Initial instruction.\nLater instruction.');
    expect(model.request(0).texts('user')).toEqual(['run', 'run']);
  });

  it('checks scripted calls against the tools the request offered', async () => {
    const model = fakeModel();
    const strictTools = [
      {
        type: 'function' as const,
        function: {
          name: 'Bash',
          parameters: {
            type: 'object',
            properties: { command: { type: 'string' }, timeout: { type: 'integer' }, mode: { type: 'string', enum: ['fast', 'slow'] } },
            required: ['command'],
            additionalProperties: false,
          },
        },
      },
    ];
    const send = (): Promise<unknown> =>
      clientOf(model).chat.completions.create({ model: 'testkit-model', messages: [{ role: 'user', content: 'go' }], tools: strictTools });
    model.script(
      batch(call('Bash', { cmd: 'ls' }), call('Missing', {}), call('Bash', { command: 'ls', timeout: '5', mode: 'warp' })),
      batch(call('Bash', { cmd: 'ls' }, { invalid: true }), call('Bash', {}, { rawArguments: '{"command":' }), bash({ command: 'ls', timeout: 5 })),
    );
    await send();
    await send();
    const problems = model.problems().join('\n');
    expect(problems).toContain('scripted call "Bash" does not match the schema the request offered: missing required argument command; unknown argument cmd (allowed: command, timeout, mode)');
    expect(problems).toContain('scripted call "Missing" names a tool the request did not offer (the request offered Bash)');
    expect(problems).toContain('argument timeout should be integer, got "5"; argument mode should be one of "fast", "slow", got "warp"');
    expect(model.problems()).toHaveLength(3);
    expect(problems).not.toContain('request #1');
  });

  it('builds tool calls in the wire shape of the engine tools', () => {
    const argsOf = (step: ReplyStep): unknown => (step.parts[0]?.type === 'call' ? step.parts[0].call.args : undefined);
    expect(argsOf(bash('ls'))).toEqual({ command: 'ls' });
    expect(argsOf(bash({ command: 'sleep 9', run_in_background: true, description: 'nap' }))).toEqual({
      command: 'sleep 9',
      run_in_background: true,
      description: 'nap',
    });
    expect(argsOf(read('a.txt'))).toEqual({ path: 'a.txt' });
    expect(argsOf(taskStop('task-1'))).toEqual({ task_id: 'task-1' });
    expect(argsOf(todoList())).toEqual({});
    expect(argsOf(todoList([{ title: 'ship', status: 'done' }]))).toEqual({ todos: [{ title: 'ship', status: 'done' }] });
    expect(argsOf(exitPlanMode([{ label: 'Go' }]))).toEqual({ options: [{ label: 'Go' }] });
    expect(argsOf(updateGoal('complete'))).toEqual({ status: 'complete' });
    expect(agent({ prompt: 'look', description: 'scout' }, { text: 'Delegating' }).parts).toEqual([
      { type: 'text', text: 'Delegating' },
      { type: 'call', call: { name: 'Agent', args: { prompt: 'look', description: 'scout' } } },
    ]);
  });

  it('waits for requests by index or predicate with a clear timeout', async () => {
    const model = fakeModel();
    model.script(say('a'));
    const waiting = model.waitForRequest((request) => request.firstUserText === 'hello');
    await collect(clientOf(model));
    await expect(waiting).resolves.toMatchObject({ index: 0 });
    await expect(model.waitForRequest(5, { timeoutMs: 20 })).rejects.toThrow(/Timed out after 20 ms waiting for request 5; received 1 request\(s\)/);
  });

  it('lists models and enforces the API key when one is configured', async () => {
    const model = fakeModel({ apiKey: 'sk-good', models: ['alpha', 'beta'] });
    const good = new OpenAI({ apiKey: 'sk-good', baseURL: 'http://testkit.invalid/v1', fetch: model.fetch, maxRetries: 0 });
    const listed = await good.models.list();
    expect(listed.data.map((entry) => entry.id)).toEqual(['alpha', 'beta']);
    await expect(collect(clientOf(model))).rejects.toMatchObject({ status: 401 });
    expect(() => model.verify()).toThrow(/used the wrong API key/);
  });
});

describe('closing and unsendable responses', () => {
  const chatUrl = 'http://testkit.invalid/v1/chat/completions';

  function postChat(fetchImpl: typeof fetch, url: string, stream = false, signal?: AbortSignal): Promise<Response> {
    return fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'testkit-model', stream, messages: [{ role: 'user', content: 'hi' }], tools: TOOLS }),
      signal,
    });
  }

  it('passes the fetch cancellation reason to a pending scripted reply', async () => {
    const model = fakeModel();
    const entered = deferred<AbortSignal>();
    model.script(async (_request, { signal }) => {
      entered.resolve(signal);
      await once(signal, 'abort');
      signal.throwIfAborted();
      return say('too late');
    });
    const controller = new AbortController();
    const response = postChat(model.fetch, chatUrl, false, controller.signal);
    const signal = await entered.promise;
    expect(signal).toBeInstanceOf(AbortSignal);
    const reason = new Error('cancel this turn');
    controller.abort(reason);
    await expect(response).rejects.toBe(reason);
    expect(signal.reason).toBe(reason);
    await expect.poll(() => model.request(0).state).toBe('aborted');
    model.verify();
  });

  it('closes a request even while its script is waiting on unrelated work', async () => {
    const model = fakeModel();
    const lateReply = deferred<ReplyStep>();
    model.script(() => lateReply.promise);
    const response = postChat(model.fetch, chatUrl);
    await model.waitForRequest(0);
    const closed = expect(response).rejects.toThrow('fetch failed');
    await model.close();
    await closed;
    await expect.poll(() => model.request(0).state).toBe('aborted');
    lateReply.reject(new Error('late reply'));
    await expect(lateReply.promise).rejects.toThrow('late reply');
    expect(model.request(0).step).toBeNull();
    model.verify();
  });

  it('stops in-process playback when the model closes mid-stream', async () => {
    const model = fakeModel();
    model.script(paced(20, say(['a', 'b', 'c', 'd', 'e'])));
    const response = await postChat(model.fetch, chatUrl, true);
    await expect.poll(() => model.request(0).state).toBe('streaming');
    await model.close();
    await expect(response.text()).rejects.toThrow('terminated');
    await expect.poll(() => model.request(0).state).toBe('aborted');
  });

  it('rejects lane waits once the model closes', async () => {
    const model = fakeModel();
    const waiting = model.lane('subagent').waitForRequest(0, { timeoutMs: 5_000 });
    await model.close();
    await expect(waiting).rejects.toBeInstanceOf(FakeModelClosedError);
    await expect(model.lane('subagent').waitForRequest(1)).rejects.toBeInstanceOf(FakeModelClosedError);
  });

  it('lets callers observe closed waits on a later event-loop turn without an unhandled rejection', async () => {
    const probe = `
      import { rejects } from 'node:assert/strict';
      import { setImmediate } from 'node:timers/promises';
      import { createFakeModel, FakeModelClosedError } from '@moonshot-ai/testkit/model';

      const model = createFakeModel();
      const waits = new Map();
      const unhandled = [];
      process.on('unhandledRejection', (reason, promise) => {
        unhandled.push(waits.get(promise) ?? String(reason));
      });
      process.on('rejectionHandled', () => {});

      function startWaits(phase) {
        const options = { timeoutMs: 2000 };
        const requests = {
          index: model.waitForRequest(0, options),
          predicate: model.waitForRequest(() => false, options),
          lane: model.lane('subagent').waitForRequest(0, options),
          hold: model.hold('unreached').reached(options),
          heldTurn: model.waitForHeldTurn(options),
        };
        for (const [name, promise] of Object.entries(requests)) waits.set(promise, phase + ': ' + name);
      }

      startWaits('before close');
      await model.close();
      startWaits('after close');
      await setImmediate();
      for (const [promise, label] of waits) await rejects(promise, FakeModelClosedError, label);
      process.stdout.write(JSON.stringify(unhandled));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--unhandled-rejections=throw', '--import', 'tsx', '--input-type=module', '-e', probe], {
      cwd: new URL('../', import.meta.url),
    });
    expect(JSON.parse(stdout)).toEqual([]);
  });

  it('answers null-body statuses and fails fast on responses a transport cannot send', async () => {
    const model = fakeModel();
    model.script(
      rawResponse({ status: 304, chunks: ['ignored'] }),
      httpError(500, { requestId: '请求-1' }),
      rawResponse({ status: 304, chunks: ['ignored'] }),
      httpError(500, { requestId: '请求-2' }),
    );
    expect((await postChat(model.fetch, chatUrl)).status).toBe(304);
    const unsendable = await postChat(model.fetch, chatUrl);
    expect(unsendable.status).toBe(400);
    expect(await unsendable.text()).toContain('testkit fake model crashed');
    const overHttp = `${await model.listen()}/chat/completions`;
    expect((await postChat(fetch, overHttp)).status).toBe(304);
    expect((await postChat(fetch, overHttp)).status).toBe(400);
    expect(model.problems().filter((problem) => problem.includes('could not play httpError(500)'))).toHaveLength(2);
  });
});

describe('http transport', () => {
  it('serves the same script over a real port', async () => {
    const model = fakeModel();
    const baseURL = await model.listen();
    expect(baseURL).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    model.script(say(['over ', 'http']), held('h', say(['x', 'y']), 1));
    const client = new OpenAI({ apiKey: 'sk-test', baseURL, maxRetries: 0 });
    const stream = await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, stream: true });
    const text: string[] = [];
    for await (const chunk of stream) text.push(chunk.choices[0]?.delta.content ?? '');
    expect(text.join('')).toBe('over http');
    const cutting = (async () => {
      const second = await client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, stream: true });
      for await (const chunk of second) text.push(chunk.choices[0]?.delta.content ?? '');
    })();
    await model.hold('h').reached();
    model.hold('h').cut();
    await expect(cutting).rejects.toThrow();
    expect(model.request(1).state).toBe('cut');
    model.verify();
  });

  it('resets the connection for network errors and closes cleanly while a turn hangs', async () => {
    const model = fakeModel();
    const baseURL = await model.listen();
    model.script(networkError());
    model.lane('main').unscripted('hang');
    const client = new OpenAI({ apiKey: 'sk-test', baseURL, maxRetries: 0 });
    await expect(client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS })).rejects.toThrow();
    const hanging = client.chat.completions.create({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools: TOOLS, stream: true });
    await model.waitForHeldTurn();
    await model.close();
    await expect(
      (async () => {
        for await (const chunk of await hanging) expect(chunk).toBeDefined();
      })(),
    ).rejects.toThrow();
  });
});

describe('non-streaming OpenAI reasoning', () => {
  it('returns each signed reasoning block in order alongside the full reasoning text', async () => {
    const model = fakeModel();
    model.script(thinkSigned('first', 'sig-a', think(' then ', thinkSigned('second', 'sig-b', say('done')))));
    const completion = await clientOf(model).chat.completions.create({
      model: 'm', messages: [{ role: 'user', content: 'think' }], tools: TOOLS, stream: false,
    });
    expect(completion.choices[0]?.message).toMatchObject({
      content: 'done',
      reasoning_content: 'first then second',
      reasoning_details: [
        { type: 'summary', index: 0, summary: 'first' },
        { type: 'encrypted', index: 0, encrypted: 'sig-a' },
        { type: 'summary', index: 1, summary: 'second' },
        { type: 'encrypted', index: 1, encrypted: 'sig-b' },
      ],
    });
  });

  it('omits reasoning details for ordinary thinking', async () => {
    const model = fakeModel();
    model.script(think('unsigned', say('done')));
    const completion = await clientOf(model).chat.completions.create({
      model: 'm', messages: [{ role: 'user', content: 'think' }], tools: TOOLS, stream: false,
    });
    const message = completion.choices[0]?.message;
    expect(message).toMatchObject({ content: 'done', reasoning_content: 'unsigned' });
    expect(message).not.toHaveProperty('reasoning_details');
  });
});

it('keeps OpenAI system and developer instructions in order for routing and request assertions', async () => {
  const model = fakeModel();
  const workspace = 'Workspace: example-project';
  model.route('workspace', (request) => request.texts('system').includes(workspace)).script(say('workspace reply'));
  const chunks = await collect(clientOf(model), [
    { role: 'system', content: 'First line\nSecond line' },
    { role: 'developer', content: '' },
    { role: 'user', content: 'hello' },
    { role: 'developer', content: workspace },
  ], { tools: false });

  const request = model.request(0);
  expect(request.texts('system')).toEqual(['First line\nSecond line', '', workspace]);
  expect(request.view.system).toBe(`First line\nSecond line\n${workspace}`);
  expect(request.view.messages.map((message) => message.role)).toEqual(['user']);
  expect(contentOf(chunks)).toBe('workspace reply');
  model.verify();
});
