import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import OpenAI from 'openai';
import type { ChatCompletionCreateParamsNonStreaming, ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { afterEach, describe, expect, it } from 'vitest';

import { FakeModelVerificationError, TestkitError } from '#/errors';
import { createFakeModel, type FakeModel, type FakeModelOptions } from '#/model/fake-model';
import { held, httpError, say, withUsage } from '#/model/steps';

const models: FakeModel[] = [];

afterEach(async () => {
  await Promise.all(models.splice(0).map((model) => model.close()));
});

const CHECKED: FakeModelOptions = { checkPromptCache: true, reportCachedTokens: true };

function fakeModel(options: FakeModelOptions = CHECKED): FakeModel {
  const model = createFakeModel(options);
  model.route('every request', () => true).unscripted({ reply: say('ok') });
  models.push(model);
  return model;
}

function problemsOf(model: FakeModel): readonly string[] {
  try {
    model.verify();
    return [];
  } catch (error) {
    if (error instanceof FakeModelVerificationError) return error.problems;
    throw error;
  }
}

const SYSTEM: ChatCompletionMessageParam = { role: 'system', content: 'You are a careful agent.' };
const READ: ChatCompletionTool = {
  type: 'function',
  function: { name: 'Read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } } } },
};
const BASH: ChatCompletionTool = {
  type: 'function',
  function: { name: 'Bash', description: 'Run a command.', parameters: { type: 'object', properties: { command: { type: 'string' } } } },
};
const FIRST_TURN: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Read notes.txt.' }];
const SECOND_TURN: ChatCompletionMessageParam[] = [...FIRST_TURN, { role: 'assistant', content: 'It says launch on friday.' }, { role: 'user', content: 'And then?' }];

interface Ask {
  readonly messages: ChatCompletionMessageParam[];
  readonly tools?: ChatCompletionTool[];
  readonly key?: string;
  readonly role?: 'main' | 'compaction' | 'subagent' | 'subagent-compaction';
  readonly step?: 'turn_start' | 'tool_results';
  readonly parent?: string;
  readonly model?: string;
}

function openai(model: FakeModel) {
  const client = new OpenAI({ apiKey: 'sk-test', baseURL: 'http://testkit.invalid/v1', fetch: model.fetch, maxRetries: 0 });
  return async ({ messages, tools = [READ, BASH], key = 'session-1', role, step = 'turn_start', parent = 'request-main', model: name = 'testkit-model' }: Ask) => {
    const body: ChatCompletionCreateParamsNonStreaming = { model: name, messages, tools, prompt_cache_key: key };
    const metadata = role === undefined
      ? undefined
      : role === 'subagent'
        ? { agent_role: 'explore', step_reason: step, parent_request_id: parent }
        : { agent_role: role === 'subagent-compaction' ? 'explore' : 'main', step_reason: role === 'main' ? 'tool_use' : 'compact' };
    return client.chat.completions.create(body, metadata === undefined ? {} : { headers: { 'x-msh-client-metadata': JSON.stringify(metadata) } });
  };
}

describe('prompt cache ledger', () => {
  it('counts the previous request as a cached prefix and reports it in usage', async () => {
    const model = fakeModel();
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    const second = await ask({ messages: SECOND_TURN });

    const [first, next] = model.promptCache();
    expect(first).toMatchObject({ request: 0, role: 'main', cacheKey: 'session-1', reusedTokens: 0 });
    expect(first?.baseline).toBeUndefined();
    expect(next).toMatchObject({ request: 1, baseline: 0, reusedFrom: 0, reusedTokens: first?.totalTokens });
    expect(next?.break).toBeUndefined();
    expect(second.usage?.prompt_tokens_details?.cached_tokens).toBe(next?.reusedTokens);
    expect(problemsOf(model)).toEqual([]);
  });

  it('reports a request that stops offering a tool the previous request offered', async () => {
    const model = fakeModel();
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    await ask({ messages: SECOND_TURN, tools: [READ] });

    expect(model.promptCache()[1]?.break).toMatchObject({ region: 'tools', part: 'header', previous: 'tools[1] Bash', next: 'messages[1] user' });
    expect(problemsOf(model)).toEqual([
      expect.stringMatching(/^request #1 \(every request\) does not extend request #0 under prompt cache key "session-1": tools\[1\] Bash is missing\. It reuses \d+ of \d+ estimated tokens\./),
    ]);
  });

  it('reports a tool schema serialized with its keys in another order', async () => {
    const model = fakeModel();
    const ask = openai(model);
    const reordered: ChatCompletionTool = {
      type: 'function',
      function: { name: 'Read', description: 'Read a file.', parameters: { properties: { path: { type: 'string' } }, type: 'object' } },
    };

    await ask({ messages: FIRST_TURN });
    await ask({ messages: SECOND_TURN, tools: [reordered, BASH] });

    expect(model.promptCache()[1]?.break).toMatchObject({ region: 'tools', previous: 'tools[0] Read', next: 'tools[0] Read' });
    expect(problemsOf(model)[0]).toContain('tools[0] Read changed from');
  });

  it('accepts a rewritten history only when the test declares the break', async () => {
    const model = fakeModel();
    const ask = openai(model);
    model.expectCacheBreak('undo rewrites the last answer', { at: 'history' });

    await ask({ messages: SECOND_TURN });
    await ask({ messages: [...FIRST_TURN, { role: 'assistant', content: 'It says launch on monday.' }, { role: 'user', content: 'Check again.' }] });

    expect(model.promptCache()[1]).toMatchObject({
      break: { region: 'messages', part: 'history', previous: 'messages[2] assistant' },
      explanation: 'undo rewrites the last answer',
    });
    expect(problemsOf(model)).toEqual([]);
  });

  it('fails on a declared break that did not happen and on a break the declaration does not cover', async () => {
    const model = fakeModel();
    const ask = openai(model);
    model.expectCacheBreak('switching models', { at: 'header' });

    await ask({ messages: SECOND_TURN });
    await ask({ messages: [SYSTEM, { role: 'user', content: 'Something else.' }] });

    expect(problemsOf(model)).toEqual([
      expect.stringContaining('request #1 (every request) does not extend request #0'),
      'expected a prompt cache break in the header (switching models), but no request made one',
    ]);
  });

  it('lets the history restart after a compaction request but still checks the header', async () => {
    const model = fakeModel();
    const ask = openai(model);
    const summary: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Summary: the notes say launch on friday.' }];

    await ask({ messages: SECOND_TURN, role: 'main' });
    await ask({ messages: [...SECOND_TURN, { role: 'assistant', content: 'Noted.' }, { role: 'user', content: 'Summarize the conversation.' }], role: 'compaction' });
    await ask({ messages: summary, role: 'main' });
    await ask({ messages: [...summary, { role: 'assistant', content: 'Ready.' }, { role: 'user', content: 'Go on.' }], tools: [READ], role: 'main' });

    const entries = model.promptCache();
    expect(entries.map(({ role, baseline }) => ({ role, baseline }))).toEqual([
      { role: 'main', baseline: undefined },
      { role: 'compaction', baseline: 0 },
      { role: 'main', baseline: 0 },
      { role: 'main', baseline: 2 },
    ]);
    expect(entries[1]?.break).toBeUndefined();
    expect(entries[2]).toMatchObject({ break: { part: 'history' }, explanation: 'the history restarts after compaction' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #3 (every request) does not extend request #2 under prompt cache key "session-1": tools[1] Bash is missing')]);
  });

  it('reports a compaction request that drops the oldest messages', async () => {
    const model = fakeModel();
    const ask = openai(model);

    await ask({ messages: SECOND_TURN, role: 'main' });
    await ask({ messages: [SYSTEM, { role: 'user', content: 'And then?' }, { role: 'user', content: 'Summarize the conversation.' }], role: 'compaction' });

    expect(model.promptCache()[1]?.break).toMatchObject({ region: 'messages', previous: 'messages[1] user' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #1 (every request) does not extend request #0')]);
  });

  it("compares a subagent's next step with that subagent's previous request and reports a subagent that changed its tools", async () => {
    const model = fakeModel();
    const ask = openai(model);
    const explore: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Explore the repository.' }];
    const check: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Check the tests.' }];

    await ask({ messages: SECOND_TURN, role: 'main' });
    await ask({ messages: explore, role: 'subagent' });
    await ask({ messages: check, role: 'subagent' });
    await ask({ messages: [...explore, { role: 'assistant', content: 'Found two packages.' }, { role: 'user', content: 'Keep going.' }], role: 'subagent', step: 'tool_results' });
    await ask({ messages: [...check, { role: 'assistant', content: 'Found one test.' }, { role: 'user', content: 'Keep going.' }], tools: [READ], role: 'subagent', step: 'tool_results' });

    const entries = model.promptCache();
    expect(entries.map(({ role, baseline, break: found }) => ({ role, baseline, region: found?.region }))).toEqual([
      { role: 'main', baseline: undefined, region: undefined },
      { role: 'subagent', baseline: undefined, region: undefined },
      { role: 'subagent', baseline: undefined, region: undefined },
      { role: 'subagent', baseline: 1, region: undefined },
      { role: 'subagent', baseline: 2, region: 'tools' },
    ]);
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #4 (every request) does not extend request #2')]);
  });

  it('checks only the next steps of a subagent run, and only against requests under the same parent request', async () => {
    const model = fakeModel();
    const ask = openai(model);
    const opening: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Today is Thursday.' }];

    await ask({ messages: [...opening, { role: 'user', content: 'Explore the repository.' }], role: 'subagent', parent: 'request-1' });
    await ask({ messages: [...opening, { role: 'user', content: 'Check the tests.' }], role: 'subagent', parent: 'request-2' });
    await ask({ messages: [...opening, { role: 'user', content: 'Check the tests.' }, { role: 'assistant', content: 'One test.' }], role: 'subagent', parent: 'request-2', step: 'tool_results' });
    await ask({ messages: [SYSTEM, { role: 'user', content: 'Explore the docs.' }, { role: 'assistant', content: 'Two pages.' }], role: 'subagent', parent: 'request-3', step: 'tool_results' });

    expect(model.promptCache().map((entry) => entry.baseline)).toEqual([undefined, undefined, 1, undefined]);
    expect(problemsOf(model)).toEqual([]);
  });

  it('tells apart two subagents a parent started with the same task', async () => {
    const model = fakeModel();
    const ask = openai(model);
    const task: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Count the files.' }];

    await ask({ messages: task, role: 'subagent' });
    await ask({ messages: task, role: 'subagent' });
    await ask({ messages: [...task, { role: 'assistant', content: 'Counting src.' }, { role: 'user', content: 'src has 4 files.' }], role: 'subagent', step: 'tool_results' });
    await ask({ messages: [...task, { role: 'assistant', content: 'Counting test.' }, { role: 'user', content: 'test has 2 files.' }], role: 'subagent', step: 'tool_results' });

    expect(model.promptCache().map((entry) => entry.baseline)).toEqual([undefined, undefined, 1, 0]);
    expect(problemsOf(model)).toEqual([]);
  });

  it("compares a subagent's third step with its second, so an earlier step cannot hide a rewrite", async () => {
    const model = fakeModel();
    const ask = openai(model);
    const task: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Count the files.' }];

    await ask({ messages: task, role: 'subagent' });
    await ask({ messages: [...task, { role: 'assistant', content: 'Counting src.' }, { role: 'user', content: 'src has 4 files.' }], role: 'subagent', step: 'tool_results' });
    await ask({ messages: [...task, { role: 'assistant', content: 'Counting test.' }, { role: 'user', content: 'test has 2 files.' }], role: 'subagent', step: 'tool_results' });

    expect(model.promptCache().map((entry) => entry.baseline)).toEqual([undefined, 0, 1]);
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #1')]);
  });

  it("accepts a declared break in a subagent's own history", async () => {
    const model = fakeModel();
    const ask = openai(model);
    const explore: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Explore the repository.' }];

    await ask({ messages: [...explore, { role: 'assistant', content: 'Found two packages.' }, { role: 'user', content: 'Keep going.' }], role: 'subagent' });
    await ask({ messages: [...explore, { role: 'assistant', content: 'Found three packages.' }, { role: 'user', content: 'Keep going.' }], role: 'subagent', step: 'tool_results' });
    model.expectCacheBreak('the subagent rewrote its own answer', { at: 'history' });

    expect(model.promptCache()[1]).toMatchObject({ baseline: 0, explanation: 'the subagent rewrote its own answer' });
    expect(problemsOf(model)).toEqual([]);
  });

  it('keeps a subagent compaction out of the main thread, so it neither fails nor lets the main history restart', async () => {
    const model = fakeModel();
    const ask = openai(model);
    const explored: ChatCompletionMessageParam[] = [SYSTEM, { role: 'user', content: 'Explore the repository.' }, { role: 'user', content: 'Summarize the conversation.' }];

    await ask({ messages: SECOND_TURN, role: 'main' });
    await ask({ messages: explored, role: 'subagent-compaction' });
    await ask({ messages: [SYSTEM, { role: 'user', content: 'Summary: the notes say launch on friday.' }], role: 'main' });

    const entries = model.promptCache();
    expect(entries.map(({ role, baseline }) => ({ role, baseline }))).toEqual([
      { role: 'main', baseline: undefined },
      { role: 'subagent', baseline: undefined },
      { role: 'main', baseline: 0 },
    ]);
    expect(entries[2]?.explanation).toBeUndefined();
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #0')]);
  });

  const ANSWER_SCHEMA = { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] };
  const SCORE_SCHEMA = { type: 'object', properties: { score: { type: 'number' } }, required: ['score'] };
  const STRUCTURED_OUTPUT: ReadonlyArray<{ readonly protocol: string; readonly path: string; readonly body: (schema: object) => object }> = [
    {
      protocol: 'openai',
      path: '/v1/chat/completions',
      body: (schema) => ({
        model: 'testkit-model',
        messages: [{ role: 'user', content: 'Read notes.txt.' }],
        tools: [{ type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } }],
        response_format: { type: 'json_schema', json_schema: { name: 'reply', schema } },
      }),
    },
    {
      protocol: 'openai-responses',
      path: '/v1/responses',
      body: (schema) => ({
        model: 'testkit-model',
        input: [{ role: 'user', content: 'Read notes.txt.' }],
        tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object' } }],
        text: { format: { type: 'json_schema', name: 'reply', schema } },
      }),
    },
    {
      protocol: 'anthropic',
      path: '/v1/messages',
      body: (schema) => ({
        model: 'testkit-model',
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Read notes.txt.' }],
        tools: [{ name: 'Bash', input_schema: { type: 'object' } }],
        output_config: { format: { type: 'json_schema', schema } },
      }),
    },
    {
      protocol: 'google',
      path: '/v1beta/models/testkit-model:generateContent',
      body: (schema) => ({
        contents: [{ role: 'user', parts: [{ text: 'Read notes.txt.' }] }],
        tools: [{ functionDeclarations: [{ name: 'Bash' }] }],
        generationConfig: { responseMimeType: 'application/json', responseJsonSchema: schema },
      }),
    },
  ];

  it.for(STRUCTURED_OUTPUT)('reports a $protocol request whose structured output schema changed', async ({ path, body }) => {
    const model = fakeModel();
    const send = (schema: object) =>
      model.fetch(`http://testkit.invalid${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(schema)) });

    expect((await send(ANSWER_SCHEMA)).status).toBe(200);
    expect((await send(ANSWER_SCHEMA)).status).toBe(200);
    expect((await send(SCORE_SCHEMA)).status).toBe(200);

    const [, same, changed] = model.promptCache();
    expect(same).toMatchObject({ baseline: 0 });
    expect(same?.break).toBeUndefined();
    expect(changed?.break).toMatchObject({ region: 'params', part: 'header', previous: 'params' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #1')]);
  });

  it('keeps requests with different cache keys apart', async () => {
    const model = fakeModel();
    const ask = openai(model);

    await ask({ messages: SECOND_TURN, key: 'session-1' });
    await ask({ messages: FIRST_TURN, key: 'session-2' });

    expect(model.promptCache()[1]).toMatchObject({ cacheKey: 'session-2', reusedTokens: 0 });
    expect(model.promptCache()[1]?.baseline).toBeUndefined();
    expect(problemsOf(model)).toEqual([]);
  });

  it('starts a new baseline for another model and returns to the earlier one', async () => {
    const model = fakeModel();
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    await ask({ messages: [SYSTEM, { role: 'user', content: 'Pick a file.' }], tools: [READ], model: 'small-model' });
    await ask({ messages: SECOND_TURN });

    expect(model.promptCache().map(({ model: name, baseline, reusedFrom }) => ({ name, baseline, reusedFrom }))).toEqual([
      { name: 'testkit-model', baseline: undefined, reusedFrom: undefined },
      { name: 'small-model', baseline: undefined, reusedFrom: undefined },
      { name: 'testkit-model', baseline: 0, reusedFrom: 0 },
    ]);
    expect(problemsOf(model)).toEqual([]);
  });

  it('neither checks, compares with nor reuses a request the provider rejected', async () => {
    const model = fakeModel();
    model.lane('every request').script(say('first'), httpError(400, { message: 'image rejected' }), say('recovered'));
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    await expect(ask({ messages: SECOND_TURN, tools: [READ] })).rejects.toThrow('image rejected');
    await ask({ messages: [...FIRST_TURN, { role: 'assistant', content: 'It says launch on friday.' }, { role: 'user', content: 'And then, briefly?' }] });

    expect(model.promptCache().map(({ rejected, baseline, reusedFrom }) => ({ rejected, baseline, reusedFrom }))).toEqual([
      { rejected: false, baseline: undefined, reusedFrom: undefined },
      { rejected: true, baseline: 0, reusedFrom: 0 },
      { rejected: false, baseline: 0, reusedFrom: 0 },
    ]);
    expect(problemsOf(model)).toEqual([]);
  });

  it('compares a request only with requests the provider accepted, even when the rejection comes after it', async () => {
    const model = fakeModel();
    let rejectFirst = (): void => {};
    const rejection = new Promise<void>((resolve) => {
      rejectFirst = resolve;
    });
    model.lane('every request').script(
      say('first'),
      async () => {
        await rejection;
        return httpError(400, { message: 'image rejected' });
      },
      say('second'),
    );
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    const rejected = ask({ messages: SECOND_TURN, tools: [READ] });
    await model.waitForRequest(1);
    await ask({ messages: SECOND_TURN });
    rejectFirst();
    await expect(rejected).rejects.toThrow('image rejected');

    expect(model.promptCache().map(({ rejected: isRejected, baseline }) => ({ rejected: isRejected, baseline }))).toEqual([
      { rejected: false, baseline: undefined },
      { rejected: true, baseline: 0 },
      { rejected: false, baseline: 0 },
    ]);
    expect(problemsOf(model)).toEqual([]);
  });

  it('treats a request whose hold failed before the headers as rejected', async () => {
    const model = fakeModel();
    model.lane('every request').script(say('first'), held('refuse', say('never sent')), say('recovered'));
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    const refused = ask({ messages: SECOND_TURN, tools: [READ] });
    await model.hold('refuse').reached();
    model.hold('refuse').fail(400);
    await expect(refused).rejects.toThrow();
    await ask({ messages: SECOND_TURN });

    expect(model.promptCache().map(({ rejected, baseline }) => ({ rejected, baseline }))).toEqual([
      { rejected: false, baseline: undefined },
      { rejected: true, baseline: 0 },
      { rejected: false, baseline: 0 },
    ]);
    expect(problemsOf(model)).toEqual([]);
  });

  it('checks the prefix by default and reports cached tokens only when asked', async () => {
    const model = fakeModel({});
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    const second = await ask({ messages: SECOND_TURN, tools: [READ] });

    expect(second.usage?.prompt_tokens_details?.cached_tokens).toBe(0);
    expect(problemsOf(model)).toEqual([expect.stringContaining('tools[1] Bash is missing')]);
  });

  it('records breaks without failing when a test turns the check off', async () => {
    const model = fakeModel({ checkPromptCache: false });
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    await ask({ messages: SECOND_TURN, tools: [READ] });

    expect(model.promptCache()[1]?.break).toMatchObject({ previous: 'tools[1] Bash' });
    expect(problemsOf(model)).toEqual([]);
    expect(() => model.expectCacheBreak('anything')).toThrow(TestkitError);
  });

  it('reports the scripted usage of a step instead of the simulated cache', async () => {
    const model = fakeModel();
    model.lane('every request').script(say('first'), withUsage({ input: 100 }, say('second')));
    const ask = openai(model);

    await ask({ messages: FIRST_TURN });
    const second = await ask({ messages: SECOND_TURN });

    expect(model.promptCache()[1]?.reusedTokens).toBeGreaterThan(0);
    expect(second.usage).toMatchObject({ prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 0 } });
  });

  it('ignores moved Anthropic cache breakpoints and string content, and reports Anthropic cache reads', async () => {
    const model = fakeModel();
    const client = new Anthropic({ apiKey: 'sk-test', baseURL: 'http://testkit.invalid', fetch: model.fetch, maxRetries: 0 });
    const ephemeral = { type: 'ephemeral' } as const;
    const bash = { name: 'Bash', description: 'Run a command.', input_schema: { type: 'object' as const } };
    const ask = (request: Pick<Anthropic.MessageCreateParamsNonStreaming, 'system' | 'tools' | 'messages'>) =>
      client.messages.create({ model: 'testkit-model', max_tokens: 64, metadata: { user_id: 'session-a' }, ...request });

    await ask({
      system: 'You are a careful agent.',
      tools: [{ ...bash, cache_control: ephemeral }],
      messages: [{ role: 'user', content: [{ type: 'text', text: 'Read notes.txt.', cache_control: ephemeral }] }],
    });
    const second = await ask({
      system: [{ type: 'text', text: 'You are a careful agent.', cache_control: ephemeral }],
      tools: [bash],
      messages: [
        { role: 'user', content: 'Read notes.txt.' },
        { role: 'assistant', content: 'It says launch on friday.' },
        { role: 'user', content: [{ type: 'text', text: 'And then?', cache_control: ephemeral }] },
      ],
    });
    await ask({ system: 'You are a terse agent.', tools: [bash], messages: [{ role: 'user', content: 'Read notes.txt.' }] });

    const [, extended, changed] = model.promptCache();
    expect(extended).toMatchObject({ cacheKey: 'session-a', baseline: 0, reusedFrom: 0 });
    expect(extended?.break).toBeUndefined();
    expect(second.usage.cache_read_input_tokens).toBe(extended?.reusedTokens);
    expect(changed?.break).toMatchObject({ region: 'system', part: 'header', previous: 'system[0]' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #1 under prompt cache key "session-a": system[0] changed')]);
  });

  it('ignores Anthropic cache markers only where the protocol puts them, not a schema property of the same name', async () => {
    const model = fakeModel();
    const client = new Anthropic({ apiKey: 'sk-test', baseURL: 'http://testkit.invalid', fetch: model.fetch, maxRetries: 0 });
    const ephemeral = { type: 'ephemeral' } as const;
    const toolWith = (type: string): Anthropic.Tool => ({
      name: 'Cache',
      description: 'Tune the cache.',
      input_schema: { type: 'object', properties: { cache_control: { type } } },
    });
    const ask = (tool: Anthropic.Tool, messages: Anthropic.MessageParam[]) =>
      client.messages.create({ model: 'testkit-model', max_tokens: 64, metadata: { user_id: 'session-a' }, tools: [tool], messages });
    const called: Anthropic.MessageParam[] = [
      { role: 'user', content: 'Tune it.' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'call-1', name: 'Cache', input: { cache_control: 'off' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'done' }] }] },
    ];
    const marked: Anthropic.MessageParam[] = [
      called[0]!,
      called[1]!,
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call-1', content: [{ type: 'text', text: 'done', cache_control: ephemeral }], cache_control: ephemeral }] },
    ];

    await ask(toolWith('string'), called);
    await ask({ ...toolWith('string'), cache_control: ephemeral }, marked);
    await ask(toolWith('number'), marked);

    const [, moved, changed] = model.promptCache();
    expect(moved?.break).toBeUndefined();
    expect(changed?.break).toMatchObject({ region: 'tools', part: 'header', previous: 'tools[0] Cache' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #1 under prompt cache key "session-a": tools[0] Cache changed')]);
  });

  it('takes a block appended to the last Anthropic user message as an extension, and still reports a changed block', async () => {
    const model = fakeModel();
    const client = new Anthropic({ apiKey: 'sk-test', baseURL: 'http://testkit.invalid', fetch: model.fetch, maxRetries: 0 });
    const ask = (content: Anthropic.TextBlockParam[]) =>
      client.messages.create({
        model: 'testkit-model',
        max_tokens: 64,
        metadata: { user_id: 'session-a' },
        system: 'You are a careful agent.',
        tools: [{ name: 'Bash', description: 'Run a command.', input_schema: { type: 'object' } }],
        messages: [{ role: 'user', content }],
      });
    const read: Anthropic.TextBlockParam = { type: 'text', text: 'Read notes.txt.' };

    await ask([read]);
    await ask([read, { type: 'text', text: 'Also read todo.txt.' }]);
    await ask([{ type: 'text', text: 'Read todo.txt.' }, { type: 'text', text: 'Also read todo.txt.' }]);

    const [, appended, changed] = model.promptCache();
    expect(appended).toMatchObject({ baseline: 0, reusedFrom: 0 });
    expect(appended?.break).toBeUndefined();
    expect(changed?.break).toMatchObject({ region: 'messages', part: 'history', previous: 'messages[0] user content[0]' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #1 under prompt cache key "session-a": messages[0] user content[0] changed')]);
  });

  it('reads OpenAI Responses instructions, tools and input items', async () => {
    const model = fakeModel();
    const client = new OpenAI({ apiKey: 'sk-test', baseURL: 'http://testkit.invalid/v1', fetch: model.fetch, maxRetries: 0 });
    const tools = [{ type: 'function' as const, name: 'Bash', description: 'Run a command.', parameters: { type: 'object', properties: {} }, strict: false }];
    const first = [{ role: 'user' as const, content: 'Read notes.txt.' }];
    const ask = (instructions: string, input: typeof first) =>
      client.responses.create({ model: 'testkit-model', instructions, input, tools, prompt_cache_key: 'session-r' });

    await ask('You are a careful agent.', first);
    const second = await ask('You are a careful agent.', [...first, { role: 'assistant' as const, content: 'Done.' }, { role: 'user' as const, content: 'And then?' }] as typeof first);
    await ask('You are a terse agent.', first);

    const [, extended, changed] = model.promptCache();
    expect(extended).toMatchObject({ cacheKey: 'session-r', baseline: 0, reusedFrom: 0 });
    expect(extended?.break).toBeUndefined();
    expect(second.usage?.input_tokens_details.cached_tokens).toBe(extended?.reusedTokens);
    expect(changed?.break).toMatchObject({ region: 'system', previous: 'instructions' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #1 under prompt cache key "session-r": instructions changed')]);
  });

  it('takes a part appended to the last Google user content as an extension, and still reports a part put before it', async () => {
    const model = fakeModel();
    await model.listen();
    const client = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: model.origin } });
    const ask = (parts: { text: string }[]) =>
      client.models.generateContent({
        model: 'testkit-model',
        contents: [{ role: 'user', parts }],
        config: { systemInstruction: 'You are a careful agent.', tools: [{ functionDeclarations: [{ name: 'Bash', description: 'Run a command.' }] }] },
      });

    await ask([{ text: 'Read notes.txt.' }]);
    await ask([{ text: 'Read notes.txt.' }, { text: 'Also read todo.txt.' }]);
    await ask([{ text: 'First, read todo.txt.' }, { text: 'Read notes.txt.' }, { text: 'Also read todo.txt.' }]);

    const [, appended, prepended] = model.promptCache();
    expect(appended).toMatchObject({ baseline: 0, reusedFrom: 0 });
    expect(appended?.break).toBeUndefined();
    expect(prepended?.break).toMatchObject({ region: 'messages', part: 'history', previous: 'contents[0] user parts[0]' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #1 without a prompt cache key: contents[0] user parts[0] changed')]);
  });

  it('reads Google system instructions, function declarations and contents', async () => {
    const model = fakeModel();
    await model.listen();
    const client = new GoogleGenAI({ apiKey: 'test-key', httpOptions: { baseUrl: model.origin } });
    const tools = [{ functionDeclarations: [{ name: 'Bash', description: 'Run a command.' }] }];
    const ask = (systemInstruction: string, contents: { role: string; parts: { text: string }[] }[]) =>
      client.models.generateContent({ model: 'testkit-model', contents, config: { systemInstruction, tools } });
    const first = [{ role: 'user', parts: [{ text: 'Read notes.txt.' }] }];

    await ask('You are a careful agent.', first);
    const second = await ask('You are a careful agent.', [...first, { role: 'model', parts: [{ text: 'Done.' }] }, { role: 'user', parts: [{ text: 'And then?' }] }]);
    await ask('You are a terse agent.', first);

    const [, extended, changed] = model.promptCache();
    expect(extended).toMatchObject({ baseline: 0, reusedFrom: 0 });
    expect(extended?.cacheKey).toBeUndefined();
    expect(extended?.break).toBeUndefined();
    expect(second.usageMetadata?.cachedContentTokenCount).toBe(extended?.reusedTokens);
    expect(changed?.break).toMatchObject({ region: 'system', previous: 'systemInstruction' });
    expect(problemsOf(model)).toEqual([expect.stringContaining('request #2 (every request) does not extend request #1 without a prompt cache key: systemInstruction changed')]);
  });
});
