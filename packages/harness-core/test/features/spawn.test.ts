import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  createHarness,
  openBlobs,
  openSessionStores,
  Trees,
  UNKNOWN_CAPABILITY,
  useAgent,
  type AgentHandle,
  type FeatureSpec,
  type LlmModel,
  type LlmRequester,
  type Message,
  type SessionStores,
  type ToolDescription,
  type ToolMeta,
} from '@moonshot-ai/agent-core';

import {
  BUILTIN_PROFILES,
  createProfiles,
  createStaticProfileCatalog,
  normalizeAgentProfile,
  ProfileCatalogRef,
} from '#/features/profiles/index';
import { createNodeOsHost } from '#/features/os/host/index';
import {
  createSpawn,
  FORK_CONTEXT_NOTICE,
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_MODEL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  FORK_WITH_TYPE_UNAVAILABLE,
  planSpawn,
  RESUME_WITH_TYPE_UNAVAILABLE,
  SUBAGENT_UPDATE_KEY,
  validateSpawnArgs,
  type SpawnModelEntry,
} from '#/features/spawn/index';

const model: LlmModel = { provider: 'test', model: 'test-model', capability: UNKNOWN_CAPABILITY };

const fastModel: SpawnModelEntry = {
  name: 'fast',
  description: 'Fast test model',
  model: { provider: 'test', model: 'fast-model', capability: UNKNOWN_CAPABILITY },
};

interface LlmCall {
  readonly systemPrompt?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function createMockRequester(script: LlmScript): { requester: LlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  return {
    calls,
    requester: {
      generate: async (_config, content, { onEvent }) => {
        const call: LlmCall = {
          systemPrompt: content.systemPrompt,
          messages: content.messages,
          tools: content.tools ?? [],
        };
        calls.push(call);
        const out = script(call);
        if ('toolCall' in out) {
          onEvent?.({
            type: 'llm.streaming.part',
            part: { type: 'function', id: `call-${calls.length}`, name: out.toolCall.name, arguments: out.toolCall.arguments },
          });
        } else {
          onEvent?.({ type: 'llm.streaming.part', part: { type: 'text', text: out.text } });
        }
        onEvent?.({
          type: 'llm.streaming.usage',
          usage: { inputOther: 10, output: 5, inputCacheRead: 0, inputCacheCreation: 0 },
        });
        onEvent?.({ type: 'llm.done' });
      },
    },
  };
}

const script: LlmScript = (call) => {
  const last = call.messages.at(-1);
  const text = last !== undefined && last.role === 'user' ? extractText(last) : '';
  if (text.startsWith('AGENT:')) {
    return { toolCall: { name: 'Agent', arguments: text.slice('AGENT:'.length) } };
  }
  if (text.startsWith('SUB:')) {
    return { text: `echo:${text.slice('SUB:'.length)}` };
  }
  return { text: 'parent done' };
};

function bindTestLlm(requester: LlmRequester): FeatureSpec {
  return createFeature('test-llm', {
    agent() {
      const agent = useAgent();
      agent.setConfig({ model });
      agent.setRequester(requester);
    },
  });
}

async function testStores(): Promise<{ stores: SessionStores }> {
  const backend = new MemoryBackend();
  const trees = await Trees.open(backend.trees, {});
  const tree = await trees.tree('sess');
  return { stores: await openSessionStores(tree, openBlobs(backend.blobs)) };
}

const tmpDirs: string[] = [];

async function startApp(opts?: {
  models?: readonly SpawnModelEntry[];
  workDir?: string;
  withProfiles?: boolean;
}) {
  const env = await testStores();
  const workDir = opts?.workDir ?? (await mkdtemp(join(tmpdir(), 'spawn-work-')));
  const homeDir = await mkdtemp(join(tmpdir(), 'spawn-home-'));
  tmpDirs.push(workDir, homeDir);
  const { requester, calls } = createMockRequester(script);
  const host = createNodeOsHost();
  const spawn = createSpawn({ models: opts?.models, workDir, host });
  const features: FeatureSpec[] = [spawn, bindTestLlm(requester)];
  if (opts?.withProfiles !== false) {
    features.unshift(createProfiles({ workDir, host, home: homeDir }));
  }
  const app = createHarness({ features });
  await app.ready();
  const session = await app.create({ sessionId: 'sess', stores: env.stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  return { app, env, main, session, spawn, calls, workDir, homeDir };
}

function nextTurnDone(agent: AgentHandle): Promise<void> {
  return new Promise((resolve) => {
    agent.on('turn.done', () => {
      resolve();
    });
  });
}

function agentCall(args: unknown): string {
  return `AGENT:${JSON.stringify(args)}`;
}

function trackSubagentIds(agent: AgentHandle): string[] {
  const ids: string[] = [];
  agent.on('tool.update', (event) => {
    if (event.update.key === SUBAGENT_UPDATE_KEY) ids.push(event.update.text);
  });
  return ids;
}

function toolResults(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(stores: SessionStores, agentId: string): boolean[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function userTexts(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'user')
    .map((entry) => extractText(entry.message));
}

afterEach(async () => {
  delete process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'];
  delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

describe('spawn static validation', () => {
  it('rejects mutually exclusive argument combinations before any spawn', () => {
    expect(
      validateSpawnArgs({ prompt: 'x', resume: 'subagent-1', subagent_type: 'coder' }, {}, false),
    ).toBe(RESUME_WITH_TYPE_UNAVAILABLE);
    expect(validateSpawnArgs({ prompt: 'x', fork: true }, {}, false)).toBe(FORK_EXPERIMENTAL_UNAVAILABLE);
    expect(validateSpawnArgs({ prompt: 'x', fork: true, resume: 'subagent-1' }, {}, true)).toBe(
      FORK_WITH_RESUME_UNAVAILABLE,
    );
    expect(validateSpawnArgs({ prompt: 'x', fork: true, subagent_type: 'explore' }, {}, true)).toBe(
      FORK_WITH_TYPE_UNAVAILABLE,
    );
    expect(validateSpawnArgs({ prompt: 'x', fork: true, model: 'fast' }, { modelAlias: 'test-model' }, true)).toBe(
      FORK_WITH_MODEL_UNAVAILABLE,
    );
    expect(validateSpawnArgs({ prompt: 'x', fork: true, model: 'primary' }, {}, true)).toBeUndefined();
    expect(validateSpawnArgs({ prompt: 'x', fork: true }, {}, true)).toBeUndefined();
    expect(validateSpawnArgs({ prompt: 'x' }, {}, false)).toBeUndefined();
    expect(validateSpawnArgs({ description: 'x' }, {}, false)).toMatch(/prompt/);
  });
});

describe('spawn plan', () => {
  const catalog = createStaticProfileCatalog(BUILTIN_PROFILES);

  it('enforces delegation whitelist, known profiles, and model resolution', () => {
    const notAllowed = planSpawn(
      { callerAgentId: 'subagent-1', callerProfileName: 'coder', profileName: 'agent', fork: false },
      { catalog, models: [] },
    );
    expect(notAllowed).toMatchObject({ ok: false });
    if (notAllowed.ok) throw new Error('unreachable');
    expect(notAllowed.error).toBe(
      'Subagent type "agent" is not allowed for this agent. Allowed subagent types: coder, explore, plan.',
    );

    const wildCatalog = createStaticProfileCatalog([
      normalizeAgentProfile({ name: 'agent', subagents: ['*'], systemPrompt: () => 'x' }),
    ]);
    const unknown = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, profileName: 'nope', fork: false },
      { catalog: wildCatalog, models: [] },
    );
    if (unknown.ok) throw new Error('unreachable');
    expect(unknown.error).toBe('Unknown agent profile: "nope". Available profiles: agent');

    const defaulted = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, fork: false },
      { catalog, models: [] },
    );
    if (!defaulted.ok) throw new Error('unreachable');
    expect(defaulted.profileName).toBe('coder');
    expect(defaulted.profile?.name).toBe('coder');
    expect(defaulted.model).toEqual({ kind: 'inherit' });

    const explore = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, profileName: 'explore', fork: false },
      { catalog, models: [] },
    );
    if (!explore.ok) throw new Error('unreachable');
    expect(explore.profile?.systemPrompt({})).toContain('exploration specialist');

    const primary = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, model: 'primary', fork: false },
      { catalog, models: [fastModel] },
    );
    if (!primary.ok) throw new Error('unreachable');
    expect(primary.model).toEqual({ kind: 'inherit' });

    const explicit = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, model: 'fast', fork: false },
      { catalog, models: [fastModel] },
    );
    if (!explicit.ok) throw new Error('unreachable');
    expect(explicit.model).toEqual({ kind: 'explicit', name: 'fast', model: fastModel.model });

    const invalidModel = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, model: 'slow', fork: false },
      { catalog, models: [fastModel] },
    );
    if (invalidModel.ok) throw new Error('unreachable');
    expect(invalidModel.error).toBe('Invalid model "slow". Available models: fast, primary.');

    const noPool = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, model: 'slow', fork: false },
      { catalog, models: [] },
    );
    if (noPool.ok) throw new Error('unreachable');
    expect(noPool.error).toContain('no subagent model pool is configured');

    const forked = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, fork: true },
      { catalog, models: [] },
    );
    if (!forked.ok) throw new Error('unreachable');
    expect(forked.fork).toBe(true);
    expect(forked.profileName).toBe('fork');
    expect(forked.model).toEqual({ kind: 'inherit' });
  });
});

describe('spawn tool', () => {
  it('lists catalog profiles in the tool description and gates schema parameters', async () => {
    const plain = await startApp();
    const first = nextTurnDone(plain.main);
    plain.main.submit(createUserMessage('hello'));
    await first;
    const agentTool = plain.calls[0]!.tools.find((tool) => tool.name === 'Agent');
    expect(agentTool).toBeDefined();
    expect(agentTool!.description).toContain('Available agent types (pass via subagent_type):');
    expect(agentTool!.description).toContain('- coder:');
    expect(agentTool!.description).toContain('- explore:');
    expect(agentTool!.description).not.toContain('Available models');
    const properties = agentTool!.parameters['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).not.toContain('fork');
    expect(Object.keys(properties)).not.toContain('model');
    await plain.app.disposeAsync();
    await plain.env.stores.dispose();

    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    const rich = await startApp({ models: [fastModel] });
    const second = nextTurnDone(rich.main);
    rich.main.submit(createUserMessage('hello'));
    await second;
    const richTool = rich.calls[0]!.tools.find((tool) => tool.name === 'Agent');
    expect(richTool!.description).toContain('Available models (pass via model):');
    expect(richTool!.description).toContain('- fast: Fast test model');
    expect(richTool!.description).toContain('- primary: your current model and thinking level');
    const richProperties = richTool!.parameters['properties'] as Record<string, unknown>;
    expect(Object.keys(richProperties)).toContain('fork');
    expect(Object.keys(richProperties)).toContain('model');
    await rich.app.disposeAsync();
    await rich.env.stores.dispose();
  });

  it('runs a foreground subagent to completion and reports the child through tool updates', async () => {
    const { app, env, main } = await startApp();
    const subagentIds = trackSubagentIds(main);
    const done = nextTurnDone(main);
    main.submit(createUserMessage(agentCall({ prompt: 'SUB:do the task', description: 'run the task' })));
    await done;
    await env.stores.flush();

    expect(subagentIds).toHaveLength(1);
    const agentId = subagentIds[0]!;
    expect(agentId).toMatch(/^subagent-/);
    expect(env.stores.session.getState().roster.agents[agentId]?.source).toBe(
      `spawn:${MAIN_AGENT_ID}:coder`,
    );

    const results = toolResults(env.stores, MAIN_AGENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain(`agent_id: ${agentId}`);
    expect(results[0]).toContain('actual_subagent_type: coder');
    expect(results[0]).toContain('status: completed');
    expect(results[0]).toContain('stop_reason: completed');
    expect(results[0]).toContain('[summary]');
    expect(results[0]).toContain('echo:do the task');
    expect(results[0]).toContain(`resume_hint: Continue with Agent(resume="${agentId}"`);

    expect(userTexts(env.stores, agentId)).toEqual(['SUB:do the task']);
    const history = env.stores.get(agentId)?.getState().history ?? [];
    expect(history.some((entry) => extractText(entry.message) === 'echo:do the task')).toBe(true);

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('forks the caller context with a snapshot notice and inherits history', async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    const { app, env, main, session } = await startApp();
    const subagentIds = trackSubagentIds(main);
    const first = nextTurnDone(main);
    main.submit(createUserMessage('hello'));
    await first;
    const second = nextTurnDone(main);
    main.submit(createUserMessage(agentCall({ prompt: 'SUB:continue it', description: 'fork task', fork: true })));
    await second;
    await env.stores.flush();

    expect(subagentIds).toHaveLength(1);
    const agentId = subagentIds[0]!;
    expect(env.stores.session.getState().roster.agents[agentId]?.source).toBe(
      `spawn:${MAIN_AGENT_ID}:fork`,
    );
    const results = toolResults(env.stores, MAIN_AGENT_ID);
    expect(results[0]).toContain('status: completed');
    expect(results[0]).toContain('actual_subagent_type: fork');

    const texts = userTexts(env.stores, agentId);
    expect(texts).toContain('hello');
    expect(texts).toContain('SUB:continue it');
    const history = env.stores.get(agentId)?.getState().history ?? [];
    expect(history.some((entry) => extractText(entry.message) === 'parent done')).toBe(true);
    expect(history.some((entry) => extractText(entry.message) === 'echo:continue it')).toBe(true);

    const forkHandle = session.get(agentId);
    const reminders = forkHandle?.snapshot.value?.context.reminders ?? [];
    expect(reminders.map((entry) => extractText(entry.message))).toContain(FORK_CONTEXT_NOTICE);

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('detaches a background subagent and delivers the completion as a later notification', async () => {
    const { app, env, main } = await startApp();
    const subagentIds = trackSubagentIds(main);
    const done = nextTurnDone(main);
    main.submit(
      createUserMessage(
        agentCall({ prompt: 'SUB:bg task', description: 'bg task', run_in_background: true }),
      ),
    );
    await done;
    await env.stores.flush();

    expect(subagentIds).toHaveLength(1);
    const agentId = subagentIds[0]!;
    const results = toolResults(env.stores, MAIN_AGENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('task_id: call-');
    expect(results[0]).toContain('status: running');
    expect(results[0]).toContain(`agent_id: ${agentId}`);
    expect(results[0]).toContain('automatic_notification: true');
    expect(results[0]).toContain('do NOT wait, poll');

    await vi.waitFor(async () => {
      await env.stores.flush();
      const notification = userTexts(env.stores, MAIN_AGENT_ID).find((text) =>
        text.includes('[async tool completed]'),
      );
      expect(notification).toBeDefined();
      expect(notification).toContain('status: completed');
      expect(notification).toContain('echo:bg task');
    });

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('resumes a live subagent and rejects unknown resume ids', async () => {
    const { app, env, main } = await startApp();
    const subagentIds = trackSubagentIds(main);
    const first = nextTurnDone(main);
    main.submit(createUserMessage(agentCall({ prompt: 'SUB:first task', description: 'first task' })));
    await first;
    const agentId = subagentIds[0]!;

    const second = nextTurnDone(main);
    main.submit(
      createUserMessage(agentCall({ resume: agentId, prompt: 'SUB:follow up', description: 'follow up' })),
    );
    await second;
    await env.stores.flush();
    expect(userTexts(env.stores, agentId)).toEqual(['SUB:first task', 'SUB:follow up']);
    const results = toolResults(env.stores, MAIN_AGENT_ID);
    expect(results[1]).toContain('status: completed');
    expect(results[1]).toContain('echo:follow up');

    const third = nextTurnDone(main);
    main.submit(
      createUserMessage(
        agentCall({ resume: 'subagent-missing', prompt: 'x', description: 'x' }),
      ),
    );
    await third;
    await env.stores.flush();
    const afterResume = toolResults(env.stores, MAIN_AGENT_ID);
    expect(afterResume[2]).toContain('"subagent-missing" does not exist or is not a subagent');
    expect(toolResultIsErrors(env.stores, MAIN_AGENT_ID)).toEqual([false, false, true]);

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('inherits the caller model when the tool call omits model', async () => {
    const { app, env, main, session } = await startApp({ models: [fastModel] });
    main.setConfig({ model: fastModel.model });
    const subagentIds = trackSubagentIds(main);
    const done = nextTurnDone(main);
    main.submit(createUserMessage(agentCall({ prompt: 'SUB:inherit', description: 'inherit model' })));
    await done;
    const agentId = subagentIds[0]!;
    expect(session.get(agentId)?.config?.model.model).toBe('fast-model');

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('resumes a non-live subagent by reopening it from the persisted roster', async () => {
    const backend = new MemoryBackend();
    const openStores = async (): Promise<SessionStores> => {
      const trees = await Trees.open(backend.trees, {});
      const tree = await trees.tree('sess');
      return openSessionStores(tree, openBlobs(backend.blobs));
    };
    const { requester } = createMockRequester(script);
    const workDir = await mkdtemp(join(tmpdir(), 'spawn-work-'));
    const homeDir = await mkdtemp(join(tmpdir(), 'spawn-home-'));
    tmpDirs.push(workDir, homeDir);
    const host = createNodeOsHost();
    const spawn = createSpawn({ workDir, host });
    const features: FeatureSpec[] = [
      createProfiles({ workDir, host, home: homeDir }),
      spawn,
      bindTestLlm(requester),
    ];

    const firstStores = await openStores();
    const firstApp = createHarness({ features });
    await firstApp.ready();
    const firstSession = await firstApp.create({ sessionId: 'sess', stores: firstStores });
    const firstMain = await firstSession.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    const subagentIds = trackSubagentIds(firstMain);
    const firstTurn = nextTurnDone(firstMain);
    firstMain.submit(createUserMessage(agentCall({ prompt: 'SUB:first task', description: 'first task' })));
    await firstTurn;
    const agentId = subagentIds[0]!;
    expect(firstStores.session.getState().roster.agents[agentId]?.source).toBe(`spawn:${MAIN_AGENT_ID}:coder`);
    await firstApp.disposeAsync();
    await firstStores.flush();
    await firstStores.dispose();

    const secondStores = await openStores();
    const secondApp = createHarness({ features });
    await secondApp.ready();
    const secondSession = await secondApp.create({ sessionId: 'sess', stores: secondStores });
    const secondMain = await secondSession.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
    expect(secondSession.get(agentId)).toBeUndefined();
    const secondTurn = nextTurnDone(secondMain);
    secondMain.submit(
      createUserMessage(agentCall({ resume: agentId, prompt: 'SUB:follow up', description: 'follow up' })),
    );
    await secondTurn;
    await secondStores.flush();

    expect(userTexts(secondStores, agentId)).toEqual(['SUB:first task', 'SUB:follow up']);
    const results = toolResults(secondStores, MAIN_AGENT_ID);
    expect(results.at(-1)).toContain('status: completed');
    expect(results.at(-1)).toContain('echo:follow up');

    await secondApp.disposeAsync();
    await secondStores.dispose();
  });

  it('does not register the Agent tool when no catalog is available', async () => {
    const plain = await startApp({ withProfiles: false });
    const done = nextTurnDone(plain.main);
    plain.main.submit(createUserMessage('hello'));
    await done;
    expect(plain.calls[0]!.tools.find((tool) => tool.name === 'Agent')).toBeUndefined();
    await plain.app.disposeAsync();
    await plain.env.stores.dispose();
  });

  it('lists allowlisted profiles with whenToUse joined in the tool description', async () => {
    const { app, env, main, calls } = await startApp();
    const done = nextTurnDone(main);
    main.submit(createUserMessage('hello'));
    await done;
    const agentTool = calls[0]!.tools.find((tool) => tool.name === 'Agent');
    expect(agentTool).toBeDefined();
    expect(agentTool!.description).toContain('- coder: General software engineering agent');
    expect(agentTool!.description).toContain(
      '- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases.',
    );
    expect(agentTool!.description).toContain(
      '- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan',
    );
    expect(agentTool!.description).toContain(
      'Tools: NotifyUser, Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL',
    );
    expect(agentTool!.description).not.toContain('- agent:');
    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('lets main delegate to discovered workspace profiles', async () => {
    const workDir = await mkdtemp(join(tmpdir(), 'spawn-work-'));
    await mkdir(join(workDir, '.kimi-code', 'agents'), { recursive: true });
    await writeFile(
      join(workDir, '.kimi-code', 'agents', 'custom-x.md'),
      '---\nname: custom-x\ndescription: Custom X agent\n---\nCustom body.\n',
    );
    const { app, env } = await startApp({ workDir });
    try {
      const face = app.resolve(ProfileCatalogRef);
      const plan = planSpawn(
        { callerAgentId: MAIN_AGENT_ID, profileName: 'custom-x', fork: false },
        { catalog: face, models: [] },
      );
      if (!plan.ok) throw new Error('unreachable');
      expect(plan.profileName).toBe('custom-x');
    } finally {
      await app.disposeAsync();
      await env.stores.dispose();
    }
  });

  it('applies the explore promptPrefix with git context and skips it for forks', async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    const workDir = await mkdtemp(join(tmpdir(), 'spawn-work-'));
    execFileSync('git', ['init', '-q'], { cwd: workDir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: workDir });
    execFileSync('git', ['config', 'user.name', 'test'], { cwd: workDir });
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'initial commit'], { cwd: workDir });
    const { app, env, main } = await startApp({ workDir });
    const subagentIds = trackSubagentIds(main);

    const first = nextTurnDone(main);
    main.submit(
      createUserMessage(
        agentCall({ prompt: 'SUB:explore it', description: 'explore task', subagent_type: 'explore' }),
      ),
    );
    await first;
    await env.stores.flush();
    expect(env.stores.session.getState().roster.agents[subagentIds[0]!]?.source).toBe(
      `spawn:${MAIN_AGENT_ID}:explore`,
    );
    const exploreTexts = userTexts(env.stores, subagentIds[0]!);
    expect(exploreTexts[0]).toContain('<git-context>');
    expect(exploreTexts[0]).toContain('SUB:explore it');

    const second = nextTurnDone(main);
    main.submit(
      createUserMessage(agentCall({ prompt: 'SUB:fork it', description: 'fork task', fork: true })),
    );
    await second;
    await env.stores.flush();
    const forkTexts = userTexts(env.stores, subagentIds[1]!);
    expect(forkTexts.some((text) => text.includes('<git-context>'))).toBe(false);

    await app.disposeAsync();
    await env.stores.dispose();
  });
});
