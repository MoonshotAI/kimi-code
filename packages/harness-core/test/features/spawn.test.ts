import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFeature,
  createUserMessage,
  extractText,
  MAIN_AGENT_ID,
  MemoryBackend,
  mountApp,
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
} from '@moonshot-ai/agent-core';

import {
  builtinSpawnCatalog,
  createSpawn,
  FORK_CONTEXT_NOTICE,
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_MODEL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  FORK_WITH_TYPE_UNAVAILABLE,
  planSpawn,
  RESUME_WITH_TYPE_UNAVAILABLE,
  validateSpawnArgs,
  type SpawnModelEntry,
  type SubagentCompletedEvent,
  type SubagentSpawnedEvent,
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
  if (call.systemPrompt === 'main-host') {
    if (text.startsWith('AGENT:')) {
      return { toolCall: { name: 'Agent', arguments: text.slice('AGENT:'.length) } };
    }
    return { text: 'parent done' };
  }
  return { text: `echo:${text}` };
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

async function startApp(opts?: { models?: readonly SpawnModelEntry[] }) {
  const env = await testStores();
  const { requester, calls } = createMockRequester(script);
  const spawn = createSpawn({ models: opts?.models });
  const app = mountApp({ features: [spawn, bindTestLlm(requester)] });
  const session = await app.create({ sessionId: 'sess', stores: env.stores });
  const main = await session.create({ agentId: MAIN_AGENT_ID, systemPrompt: 'main-host' });
  return { app, env, main, session, spawn, calls };
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

function toolResults(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function userTexts(stores: SessionStores, agentId: string): string[] {
  return (stores.get(agentId)?.getState().history ?? [])
    .filter((entry) => entry.message.role === 'user')
    .map((entry) => extractText(entry.message));
}

afterEach(() => {
  delete process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'];
  delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
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
  it('enforces delegation whitelist, known profiles, and model resolution', () => {
    const notAllowed = planSpawn(
      { callerAgentId: 'subagent-1', fork: false },
      { catalog: builtinSpawnCatalog, models: [] },
    );
    expect(notAllowed).toMatchObject({ ok: false });
    if (notAllowed.ok) throw new Error('unreachable');
    expect(notAllowed.error).toContain('not allowed');
    expect(notAllowed.error).toContain('Allowed subagent types: none.');

    const unknown = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, profileName: 'nope', fork: false },
      { catalog: builtinSpawnCatalog, models: [] },
    );
    if (unknown.ok) throw new Error('unreachable');
    expect(unknown.error).toBe('Unknown agent type: "nope".');

    const defaulted = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, fork: false },
      { catalog: builtinSpawnCatalog, models: [] },
    );
    if (!defaulted.ok) throw new Error('unreachable');
    expect(defaulted.profileName).toBe('coder');
    expect(defaulted.profile?.name).toBe('coder');
    expect(defaulted.model).toEqual({ kind: 'inherit' });

    const explore = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, profileName: 'explore', fork: false },
      { catalog: builtinSpawnCatalog, models: [] },
    );
    if (!explore.ok) throw new Error('unreachable');
    expect(explore.profile?.systemPrompt({ callerAgentId: MAIN_AGENT_ID })).toContain('exploration specialist');

    const primary = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, model: 'primary', fork: false },
      { catalog: builtinSpawnCatalog, models: [fastModel] },
    );
    if (!primary.ok) throw new Error('unreachable');
    expect(primary.model).toEqual({ kind: 'inherit' });

    const explicit = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, model: 'fast', fork: false },
      { catalog: builtinSpawnCatalog, models: [fastModel] },
    );
    if (!explicit.ok) throw new Error('unreachable');
    expect(explicit.model).toEqual({ kind: 'explicit', name: 'fast', model: fastModel.model });

    const invalidModel = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, model: 'slow', fork: false },
      { catalog: builtinSpawnCatalog, models: [fastModel] },
    );
    if (invalidModel.ok) throw new Error('unreachable');
    expect(invalidModel.error).toBe('Invalid model "slow". Available models: fast, primary.');

    const noPool = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, model: 'slow', fork: false },
      { catalog: builtinSpawnCatalog, models: [] },
    );
    if (noPool.ok) throw new Error('unreachable');
    expect(noPool.error).toContain('no subagent model pool is configured');

    const forked = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, fork: true },
      { catalog: builtinSpawnCatalog, models: [] },
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
    await plain.main.submit(createUserMessage('hello'));
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
    await rich.main.submit(createUserMessage('hello'));
    await second;
    const richTool = rich.calls[0]!.tools.find((tool) => tool.name === 'Agent');
    expect(richTool!.description).toContain('Available models (pass via model):');
    expect(richTool!.description).toContain('- fast: Fast test model');
    expect(richTool!.description).toContain('- primary (= test-model)');
    const richProperties = richTool!.parameters['properties'] as Record<string, unknown>;
    expect(Object.keys(richProperties)).toContain('fork');
    expect(Object.keys(richProperties)).toContain('model');
    await rich.app.disposeAsync();
    await rich.env.stores.dispose();
  });

  it('runs a foreground subagent to completion and mirrors spawned/completed events', async () => {
    const { app, env, main, session, spawn } = await startApp();
    const spawnedEvents: SubagentSpawnedEvent[] = [];
    const completedEvents: SubagentCompletedEvent[] = [];
    session.on(spawn, 'subagent.spawned', (event) => {
      spawnedEvents.push(event);
    });
    session.on(spawn, 'subagent.completed', (event) => {
      completedEvents.push(event);
    });
    const done = nextTurnDone(main);
    await main.submit(createUserMessage(agentCall({ prompt: 'do the task', description: 'run the task' })));
    await done;
    await env.stores.flush();

    expect(spawnedEvents).toHaveLength(1);
    expect(spawnedEvents[0]).toMatchObject({
      parentAgentId: MAIN_AGENT_ID,
      profile: 'coder',
      background: false,
    });
    const agentId = spawnedEvents[0]!.agentId;
    expect(agentId).toMatch(/^subagent-/);
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({ agentId, summary: 'echo:do the task' });
    expect(completedEvents[0]!.usage?.output).toBe(5);

    const results = toolResults(env.stores, MAIN_AGENT_ID);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain(`agent_id: ${agentId}`);
    expect(results[0]).toContain('actual_subagent_type: coder');
    expect(results[0]).toContain('status: completed');
    expect(results[0]).toContain('stop_reason: completed');
    expect(results[0]).toContain('[summary]');
    expect(results[0]).toContain('echo:do the task');
    expect(results[0]).toContain(`resume_hint: Continue with Agent(resume="${agentId}"`);

    expect(userTexts(env.stores, agentId)).toEqual(['do the task']);
    const history = env.stores.get(agentId)?.getState().history ?? [];
    expect(history.some((entry) => extractText(entry.message) === 'echo:do the task')).toBe(true);

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('forks the caller context with a snapshot notice and inherits history', async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    const { app, env, main, session, spawn } = await startApp();
    const spawnedEvents: SubagentSpawnedEvent[] = [];
    session.on(spawn, 'subagent.spawned', (event) => {
      spawnedEvents.push(event);
    });
    const first = nextTurnDone(main);
    await main.submit(createUserMessage('hello'));
    await first;
    const second = nextTurnDone(main);
    await main.submit(createUserMessage(agentCall({ prompt: 'continue it', description: 'fork task', fork: true })));
    await second;
    await env.stores.flush();

    expect(spawnedEvents).toHaveLength(1);
    expect(spawnedEvents[0]).toMatchObject({ profile: 'fork', background: false });
    const agentId = spawnedEvents[0]!.agentId;
    const results = toolResults(env.stores, MAIN_AGENT_ID);
    expect(results[0]).toContain('status: completed');
    expect(results[0]).toContain('actual_subagent_type: fork');

    const texts = userTexts(env.stores, agentId);
    expect(texts).toContain('hello');
    expect(texts).toContain('continue it');
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
    const { app, env, main, session, spawn } = await startApp();
    const spawnedEvents: SubagentSpawnedEvent[] = [];
    const completedEvents: SubagentCompletedEvent[] = [];
    session.on(spawn, 'subagent.spawned', (event) => {
      spawnedEvents.push(event);
    });
    session.on(spawn, 'subagent.completed', (event) => {
      completedEvents.push(event);
    });
    const done = nextTurnDone(main);
    await main.submit(
      createUserMessage(
        agentCall({ prompt: 'bg task', description: 'bg task', run_in_background: true }),
      ),
    );
    await done;
    await env.stores.flush();

    expect(spawnedEvents).toHaveLength(1);
    expect(spawnedEvents[0]).toMatchObject({ background: true });
    const agentId = spawnedEvents[0]!.agentId;
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
    expect(completedEvents).toHaveLength(1);
    expect(completedEvents[0]).toMatchObject({ agentId, summary: 'echo:bg task' });

    await app.disposeAsync();
    await env.stores.dispose();
  });

  it('resumes a live subagent and rejects unknown resume ids', async () => {
    const { app, env, main, session, spawn } = await startApp();
    const spawnedEvents: SubagentSpawnedEvent[] = [];
    session.on(spawn, 'subagent.spawned', (event) => {
      spawnedEvents.push(event);
    });
    const first = nextTurnDone(main);
    await main.submit(createUserMessage(agentCall({ prompt: 'first task', description: 'first task' })));
    await first;
    const agentId = spawnedEvents[0]!.agentId;

    const second = nextTurnDone(main);
    await main.submit(
      createUserMessage(agentCall({ resume: agentId, prompt: 'follow up', description: 'follow up' })),
    );
    await second;
    await env.stores.flush();
    expect(userTexts(env.stores, agentId)).toEqual(['first task', 'follow up']);
    const results = toolResults(env.stores, MAIN_AGENT_ID);
    expect(results[1]).toContain('status: completed');
    expect(results[1]).toContain('echo:follow up');

    const third = nextTurnDone(main);
    await main.submit(
      createUserMessage(
        agentCall({ resume: 'subagent-missing', prompt: 'x', description: 'x' }),
      ),
    );
    await third;
    await env.stores.flush();
    const afterResume = toolResults(env.stores, MAIN_AGENT_ID);
    expect(afterResume[2]).toContain('"subagent-missing" does not exist or is not running in this process');

    await app.disposeAsync();
    await env.stores.dispose();
  });
});
