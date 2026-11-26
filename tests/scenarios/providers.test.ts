import { bash, fakeModelConfig, say, think, withUsage, type FakeProviderType, type ProtocolName } from '@moonshot-ai/testkit/model';
import { test as base, describe, expect } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures } from './support/scenario';

const test = base.extend<ScenarioFixtures>(scenarioFixtures());

test('exposes the configured model alias and sends the wire model name through its provider', async ({ kap, model }) => {
  expect(await kap.rest.get('/api/v1/providers/testkit')).toMatchObject({ id: 'testkit', models: ['testkit'] });
  await kap.writeConfig(fakeModelConfig(model, {
    type: 'openai',
    alias: 'e2e/stub',
    providerAlias: 'e2e',
    modelName: 'stub',
    maxContextSize: 128_000,
    apiKey: 'test-key',
  }));
  await kap.restart();

  expect(await kap.rest.get('/api/v1/providers/e2e')).toMatchObject({ id: 'e2e', type: 'openai', models: ['e2e/stub'] });
  expect(await kap.rest.get('/api/v1/config')).toMatchObject({ default_model: 'e2e/stub' });
  model.script(say('ready'));
  const session = await kap.createSession();
  await kap.prompt(session.id, 'check the selected model');
  await kap.waitIdle(session.id);
  expect(model.requests('main')).toMatchObject([{ authorization: 'Bearer test-key', view: { model: 'stub' } }]);
  expect((await kap.turns(session.id))[0]).toMatchObject({ outcome: 'completed' });
});

const PROVIDERS: ReadonlyArray<{ readonly type: FakeProviderType; readonly protocol: ProtocolName; readonly path: RegExp }> = [
  { type: 'kimi', protocol: 'openai', path: /^\/v1\/chat\/completions$/ },
  { type: 'openai', protocol: 'openai', path: /^\/v1\/chat\/completions$/ },
  { type: 'anthropic', protocol: 'anthropic', path: /^\/v1\/messages/ },
  { type: 'google-genai', protocol: 'google', path: /^\/v1beta\/models\/testkit-model:streamGenerateContent/ },
];

describe.each(PROVIDERS)('the engine talking to a $type provider', ({ type, protocol, path }) => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ provider: type }));

  test('decodes thinking, a tool call, its result and the final answer', async ({ kap, model }) => {
    model.script(
      withUsage({ input: 40, output: 8, cacheRead: 10 }, think('plan the call', bash(`echo via-${type}`, { text: 'Checking.' }))),
      say('all done'),
    );
    const session = await kap.createSession();

    await kap.prompt(session.id, 'go');
    await kap.waitIdle(session.id);

    const [first, second] = model.requests('main');
    expect(first).toMatchObject({ protocol, firstUserText: 'go' });
    expect(first?.path).toMatch(path);
    expect(first?.tools).toContain('Bash');
    const toolResult = second?.view.messages.find((message) => message.role === 'tool');
    expect(toolResult?.text).toContain(`via-${type}`);
    const [turn] = await kap.turns(session.id);
    expect(turn?.['outcome']).toBe('completed');
    const items = turn?.items ?? [];
    expect(items.find((item) => item.type === 'tool_call')).toMatchObject({ name: 'Bash', outcome: 'completed' });
    expect(items.filter((item) => item.type === 'assistant_message').map((item) => item['text'])).toEqual(['Checking.', 'all done']);
    expect(items.find((item) => item.type === 'reasoning')).toMatchObject({ text: 'plan the call' });
    expect(turn?.['steps']).toEqual(
      expect.arrayContaining([expect.objectContaining({ index: 1, usage: expect.objectContaining({ input_cache_read: 10, output: 8 }) })]),
    );
  });
});

describe.each(PROVIDERS)('the engine reading a $type stream split at random byte boundaries', ({ type }) => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ provider: type, modelOptions: { chunking: { seed: 20_261_119, maxBytes: 5 } } }));

  test('rebuilds multi-byte text, reasoning and tool arguments exactly', async ({ kap, model }) => {
    model.script(think('想一想🙂', bash('echo 你好，世界🙂', { text: '先检查一下。' })), say('完成了 ✅'));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'go');
    await kap.waitIdle(session.id);

    const [turn] = await kap.turns(session.id);
    expect(turn?.['outcome']).toBe('completed');
    const items = turn?.items ?? [];
    expect(items.find((item) => item.type === 'reasoning')).toMatchObject({ text: '想一想🙂' });
    expect(items.find((item) => item.type === 'tool_call')).toMatchObject({ name: 'Bash', outcome: 'completed' });
    expect(model.requests('main')[1]?.view.messages.find((message) => message.role === 'tool')?.text).toContain('你好，世界🙂');
    expect(items.filter((item) => item.type === 'assistant_message').map((item) => item['text'])).toEqual(['先检查一下。', '完成了 ✅']);
  });
});

describe.each(PROVIDERS)('the engine keeping one prompt cache prefix with a $type provider', ({ type }) => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ provider: type, modelOptions: { checkPromptCache: true, reportCachedTokens: true } }));

  test('extends the previous request on every step and turn and records the cached tokens', async ({ kap, model }) => {
    model.script(bash(`echo cache-${type}`), say('first answer'), say('second answer'));
    const session = await kap.createSession();

    await kap.prompt(session.id, 'run it');
    await kap.waitIdle(session.id);
    await kap.prompt(session.id, 'run it again');
    await kap.waitIdle(session.id);

    const main = model.promptCache().filter((entry) => entry.role === 'main');
    expect(main.map(({ request, baseline, reusedFrom }) => ({ request, baseline, reusedFrom }))).toEqual([
      { request: main[0]?.request, baseline: undefined, reusedFrom: undefined },
      { request: main[1]?.request, baseline: main[0]?.request, reusedFrom: main[0]?.request },
      { request: main[2]?.request, baseline: main[1]?.request, reusedFrom: main[1]?.request },
    ]);
    expect(main.map((entry) => entry.break)).toEqual([undefined, undefined, undefined]);
    const [, second] = await kap.turns(session.id);
    expect(second?.['steps']).toEqual([expect.objectContaining({ usage: expect.objectContaining({ input_cache_read: main[2]?.reusedTokens }) })]);
    expect(main[2]?.reusedTokens).toBeGreaterThan(0);
  });
});
