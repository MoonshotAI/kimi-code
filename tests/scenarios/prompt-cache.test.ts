import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { fakeMcpServer } from '@moonshot-ai/testkit/fixtures';
import { agent, bash, call, held, httpError, say, think, withUsage, type FakeModel, type ModelRequest, type ReplyStep } from '@moonshot-ai/testkit/model';
import { describe, expect, test as base } from 'vitest';

import { scenarioFixtures, type ScenarioFixtures, type ScenarioOptions } from './support/scenario';

type Kap = ScenarioFixtures['kap'];

interface Profile {
  readonly name: string;
  readonly options: ScenarioOptions;
  readonly roleMetadata: boolean;
  readonly mcp?: 'listed' | 'deferred';
  readonly takesEffect: (first: ModelRequest) => void;
}

const MCP_SEARCH = 'mcp__docs__search';
const DOCS = fakeMcpServer('docs', {
  tools: [{ name: 'search', description: 'Search the docs.', inputSchema: { properties: { query: { type: 'string' } }, required: ['query'] }, reply: 'found 2 pages' }],
});

function withCapabilities(...capabilities: readonly string[]): ScenarioOptions {
  return {
    config: {
      models: { testkit: { provider: 'testkit', model: 'testkit-model', maxContextSize: 262_144, capabilities } },
    },
  };
}

const PROFILES: readonly Profile[] = [
  {
    name: 'the default setup',
    options: {},
    roleMetadata: true,
    takesEffect: (first) => expect(first.protocol).toBe('openai'),
  },
  {
    name: 'every experimental feature on',
    options: {
      env: {
        KIMI_CODE_EXPERIMENTAL_FLAG: '1',
        KIMI_CODE_EXPERIMENTAL_NOTIFY_USER: '1',
        KIMI_CODE_EXPERIMENTAL_NOTIFY_USER_APP: '1',
        KIMI_CODE_EXPERIMENTAL_SESSION_MENTIONS: '1',
        KIMI_CODE_EXPERIMENTAL_SIDEBAR_MULTI_TAB: '1',
        KIMI_CODE_EXPERIMENTAL_WAIT_FOR: '1',
        KIMI_CODE_EXPERIMENTAL_TOWER: '1',
      },
    },
    roleMetadata: true,
    takesEffect: (first) => expect(first.tools).toEqual(expect.arrayContaining(['NotifyUser', 'WaitFor'])),
  },
  {
    name: 'progressive tool loading',
    options: withCapabilities('tool_use', 'dynamically_loaded_tools'),
    roleMetadata: true,
    takesEffect: (first) => expect(first.tools).toContain('select_tools'),
  },
  {
    name: 'thinking',
    options: withCapabilities('tool_use', 'thinking'),
    roleMetadata: true,
    takesEffect: (first) => expect(first.body).toMatchObject({ thinking: { type: 'enabled' } }),
  },
  {
    name: 'an MCP server',
    options: { mcpServers: { docs: DOCS } },
    roleMetadata: true,
    mcp: 'listed',
    takesEffect: (first) => expect(first.tools).toContain(MCP_SEARCH),
  },
  {
    name: 'a deferred MCP server behind progressive tool loading',
    options: { ...withCapabilities('tool_use', 'dynamically_loaded_tools'), mcpServers: { docs: { ...DOCS, deferred: true } } },
    roleMetadata: true,
    mcp: 'deferred',
    takesEffect: (first) => {
      expect(first.tools).toContain('select_tools');
      expect(first.tools).not.toContain(MCP_SEARCH);
    },
  },
  {
    name: 'an anthropic provider',
    options: { provider: 'anthropic' },
    roleMetadata: false,
    takesEffect: (first) => expect(first.protocol).toBe('anthropic'),
  },
  {
    name: 'a google-genai provider',
    options: { provider: 'google-genai' },
    roleMetadata: false,
    takesEffect: (first) => expect(first.protocol).toBe('google'),
  },
];

const AUTO_COMPACTION_RATIO = 0.5;
const PAST_THE_TRIGGER = { input: 160_000, output: 1 };

function withAutoCompaction(options: ScenarioOptions): ScenarioOptions {
  return { ...options, config: { ...options.config, loopControl: { compaction_trigger_ratio: AUTO_COMPACTION_RATIO } } };
}

function answer(text: string): ReplyStep {
  return think(`planning: ${text}`, say(text));
}

async function turn(kap: Kap, sessionId: string, text: string): Promise<void> {
  await kap.prompt(sessionId, text);
  await kap.waitIdle(sessionId);
}

async function searchDocs(kap: Kap, model: FakeModel, sessionId: string, mcp: Profile['mcp']): Promise<void> {
  if (mcp === undefined) return;
  const loaded = mcp === 'deferred' ? [call('select_tools', { names: [MCP_SEARCH] })] : [];
  model.script(...loaded, call(MCP_SEARCH, { query: 'prompt cache' }, { invalid: mcp === 'deferred' }), answer('the docs have two pages'));
  await turn(kap, sessionId, 'Search the docs for the prompt cache.');
  expect(model.requests('main').at(-1)?.texts('tool').join('\n')).toContain('found 2 pages');
}

async function runPastTheCompactionTrigger(kap: Kap, model: FakeModel, sessionId: string, roleMetadata: boolean): Promise<void> {
  const summary = say('Summary: four commands ran.');
  if (roleMetadata) model.lane('compaction').script(summary);
  else model.expectCacheBreak('without role metadata the request after compaction cannot be told apart from a rewritten history', { at: 'history' });
  model.script(withUsage(PAST_THE_TRIGGER, bash('echo four')), ...(roleMetadata ? [] : [summary]), answer('fourth answer'), answer('continued after compacting'));
  await turn(kap, sessionId, 'Run one more command.');
  await turn(kap, sessionId, 'Carry on.');
  expect(model.requests('main').at(-1)?.texts('user').join('\n')).toContain('Summary: four commands ran.');
}

async function compact(kap: Kap, model: FakeModel, sessionId: string, summary: string, roleMetadata: boolean): Promise<void> {
  if (!roleMetadata) model.expectCacheBreak('without role metadata the request after compaction cannot be told apart from a rewritten history', { at: 'history' });
  model.lane(roleMetadata ? 'compaction' : 'main').script(say(summary));
  await kap.compact(sessionId);
  await kap.waitIdle(sessionId);
}

describe.each(PROFILES)('one session with $name', ({ options, roleMetadata, mcp, takesEffect }) => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ ...withAutoCompaction(options), modelOptions: { reportCachedTokens: true } }));

  test('keeps every main request and every request of a subagent on the prompt cache prefix through a retry, compaction, a restart, an automatic compaction and a subagent', async ({ kap, model }) => {
    const session = await kap.createSession();

    model.script(think('planning the first command', bash('echo one')), answer('first answer'));
    await turn(kap, session.id, 'Run the first command.');
    takesEffect(model.request(0));
    model.script(httpError(503, { message: 'overloaded' }), bash('echo two'), answer('second answer'));
    await turn(kap, session.id, 'Run the second command.');
    await searchDocs(kap, model, session.id, mcp);
    await compact(kap, model, session.id, 'Summary: two commands ran.', roleMetadata);
    model.script(answer('third answer'));
    await turn(kap, session.id, 'What happened so far?');

    await kap.restart();
    await runPastTheCompactionTrigger(kap, model, session.id, roleMetadata);
    await searchDocs(kap, model, session.id, mcp);
    if (roleMetadata) {
      model.script(agent({ prompt: 'look around the workspace', description: 'scout' }), answer('fifth answer'));
      model.lane('subagent').script(bash('echo scouting'), say('nothing unusual'));
      await turn(kap, session.id, 'Ask a helper to look around.');
    }
    await compact(kap, model, session.id, 'Summary: the commands ran.', roleMetadata);
    model.script(answer('last answer'));
    await turn(kap, session.id, 'Anything else?');

    const ledger = model.promptCache();
    const main = ledger.filter((entry) => entry.role === 'main' && !entry.rejected);
    expect(new Set(main.map((entry) => entry.cacheKey)).size).toBe(1);
    expect(main.slice(1).every((entry) => entry.reusedTokens > 0)).toBe(true);
    const subagent = ledger.filter((entry) => entry.role === 'subagent' && !entry.rejected);
    expect(subagent.map((entry) => entry.baseline)).toEqual(roleMetadata ? [undefined, subagent[0]?.request] : []);
    expect(model.promptCacheProblems()).toEqual([]);
  });
});

interface Change {
  readonly name: string;
  readonly options?: ScenarioOptions;
  readonly prepare?: (kap: Kap) => Promise<void>;
  readonly apply: (kap: Kap, sessionId: string) => Promise<unknown>;
  readonly takesEffect: (applied: unknown, next: ModelRequest, first: ModelRequest) => void;
}

function agentConfig(config: Readonly<Record<string, unknown>>): Change['apply'] {
  return (kap, sessionId) => kap.rest.post(`/api/v1/sessions/${sessionId}/profile`, { agent_config: config });
}

const PLUGIN = 'cache-plugin';

async function installDisabledPlugin(kap: Kap): Promise<void> {
  const source = join(kap.home.root, PLUGIN);
  await mkdir(join(source, 'skills', 'cache-skill'), { recursive: true });
  await writeFile(
    join(source, 'kimi.plugin.json'),
    JSON.stringify({ name: PLUGIN, version: '1.0.0', description: 'Adds a prompt section and a skill.', systemPrompt: 'Mention the cache plugin.', skills: './skills/' }),
  );
  await writeFile(join(source, 'skills', 'cache-skill', 'SKILL.md'), '---\nname: cache-skill\ndescription: Check the cache.\n---\n\nCheck the cache.\n');
  await kap.rest.post('/api/v1/plugins', { source });
  await kap.rest.post(`/api/v1/plugins/${PLUGIN}:disable`);
}

const CHANGES: readonly Change[] = [
  {
    name: 'turning plan mode on',
    apply: agentConfig({ plan_mode: true }),
    takesEffect: (_applied, next) => expect(next.remindersSinceReply.join('\n')).toContain('Plan mode is active'),
  },
  {
    name: 'turning swarm mode on',
    apply: agentConfig({ swarm_mode: true }),
    takesEffect: (applied, next) => {
      expect(applied).toMatchObject({ agent: { swarm_mode: true } });
      expect(next.remindersSinceReply.join('\n')).not.toContain('Swarm Mode');
    },
  },
  {
    name: 'turning tower mode on',
    options: { env: { KIMI_CODE_EXPERIMENTAL_TOWER: '1' } },
    apply: agentConfig({ tower_mode: true }),
    takesEffect: (_applied, next) => expect(next.remindersSinceReply.join('\n')).toMatch(/<tools_added>[\s\S]*TowerInit/),
  },
  {
    name: 'switching to manual approvals',
    apply: agentConfig({ permission_mode: 'manual' }),
    takesEffect: (applied) => expect(applied).toMatchObject({ agent: { permission_mode: 'manual' } }),
  },
  {
    name: 'turning an experimental feature off and reloading the session',
    prepare: async (kap) => {
      await kap.rest.post('/api/v1/config', { experimental: { wait_for: true } });
    },
    apply: async (kap, sessionId) => {
      await kap.rest.post('/api/v1/config', { experimental: { wait_for: false } });
      return kap.rest.post(`/api/v1/sessions/${sessionId}:reload`);
    },
    takesEffect: (_applied, next) => expect(next.remindersSinceReply.join('\n')).toMatch(/<tools_removed>\s*WaitFor\s*<\/tools_removed>/),
  },
  {
    name: 'enabling a plugin',
    prepare: installDisabledPlugin,
    apply: (kap) => kap.rest.post(`/api/v1/plugins/${PLUGIN}:enable`),
    takesEffect: (_applied, next) => expect(next.remindersSinceReply.join('\n')).toContain(`Plugin "${PLUGIN}" was enabled.`),
  },
  {
    name: 'writing AGENTS.md into the workspace',
    apply: (kap) => writeFile(join(kap.home.workspace, 'AGENTS.md'), '# Rules\n\nAlways answer in one line.\n'),
    takesEffect: (_applied, next, first) => expect(next.view.system).toBe(first.view.system),
  },
];

describe.each(CHANGES)('a session $name between two turns', ({ options, prepare, apply, takesEffect }) => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ ...options, modelOptions: { reportCachedTokens: true } }));

  test('sends the next request on the same prompt cache prefix', async ({ kap, model }) => {
    model.script(answer('first answer'), answer('second answer'));
    await prepare?.(kap);
    const session = await kap.createSession();
    await turn(kap, session.id, 'First question.');
    const applied = await apply(kap, session.id);
    await turn(kap, session.id, 'Second question.');

    const [first, next] = model.requests('main');
    takesEffect(applied, next!, first!);
    expect(model.promptCache().filter((entry) => entry.role === 'main').map(({ baseline, reusedFrom }) => ({ baseline, reusedFrom }))).toEqual([
      { baseline: undefined, reusedFrom: undefined },
      { baseline: 0, reusedFrom: 0 },
    ]);
    expect(model.promptCacheProblems()).toEqual([]);
  });
});

describe('a goal started between two turns', () => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ modelOptions: { reportCachedTokens: true } }));

  test('keeps the goal turn on the same prompt cache prefix', async ({ kap, model }) => {
    model.script(answer('first answer'), call('UpdateGoal', { status: 'complete' }), answer('the goal is complete'));
    const session = await kap.createSession();
    await turn(kap, session.id, 'First question.');
    await kap.rest.post(`/api/v1/sessions/${session.id}/profile`, { agent_config: { goal_objective: 'Write one haiku about caches.' } });
    await turn(kap, session.id, 'Work on the goal.');

    const goalTurn = model.requests('main')[1];
    expect(goalTurn?.remindersSinceReply.join('\n')).toMatch(/active goal[\s\S]*Write one haiku about caches\./);
    expect(model.promptCache().filter((entry) => entry.role === 'main').map(({ baseline }) => baseline)).toEqual([undefined, 0, 1]);
    expect(model.promptCacheProblems()).toEqual([]);
  });
});

describe('a message steered into a running reply', () => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ modelOptions: { reportCachedTokens: true } }));

  test('resends the interrupted request on the same prompt cache prefix', async ({ kap, model }) => {
    model.script(held('mid-reply', say(['part one ', 'part two']), 1), answer('short answer'));
    const session = await kap.createSession();
    await kap.prompt(session.id, 'Start a long answer.');
    await model.hold('mid-reply').reached();
    await kap.steer(session.id, 'Actually, keep it short.');
    model.hold('mid-reply').release();
    await kap.waitIdle(session.id);

    expect(model.requests('main').at(-1)?.userTextsSinceReply.at(-1)).toBe('Actually, keep it short.');
    expect(model.promptCache().filter((entry) => entry.role === 'main').map(({ baseline }) => baseline)).toEqual([undefined, 0]);
    expect(model.promptCacheProblems()).toEqual([]);
  });
});

describe('two clients following the same session', () => {
  const test = base.extend<ScenarioFixtures>(scenarioFixtures({ modelOptions: { reportCachedTokens: true } }));

  test('keeps the next request on the same prompt cache prefix when a second client subscribes in the middle of the session', async ({ kap, model }) => {
    model.script(answer('first answer'), answer('second answer'));
    const session = await kap.createSession();
    const first = await kap.connect();
    await first.subscribe(session.id);
    await turn(kap, session.id, 'First question.');
    const second = await kap.connect();
    await second.subscribe(session.id);
    await turn(kap, session.id, 'Second question.');

    const lastAnswer = (socket: typeof first): unknown => socket.turns(session.id).at(-1)?.items.find((item) => item.type === 'assistant_message')?.['text'];
    await expect.poll(() => lastAnswer(first)).toBe('second answer');
    await expect.poll(() => lastAnswer(second)).toBe('second answer');
    expect(model.promptCache().filter((entry) => entry.role === 'main').map(({ baseline, reusedFrom }) => ({ baseline, reusedFrom }))).toEqual([
      { baseline: undefined, reusedFrom: undefined },
      { baseline: 0, reusedFrom: 0 },
    ]);
    expect(model.promptCacheProblems()).toEqual([]);
  });
});
