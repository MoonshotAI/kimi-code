import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFeature, type Feature } from '@moonshot-ai/agent-core/app/index';
import { createUserEntry, type ToolMeta, type UserMeta } from '@moonshot-ai/agent-core/history/index';
import {
  createAssistantMessage,
  createUserMessage,
  extractText,
  type Message,
  type ToolCall,
  type ToolDescription,
} from '@moonshot-ai/agent-core/llm/message';
import type { LlmRequest } from '@moonshot-ai/agent-core/llm/request';
import type { LlmOutcome } from '@moonshot-ai/agent-core/llm/response';
import { mergeFields, type LlmRequestPart } from '@moonshot-ai/agent-core/llm/requester';
import type { LoopLlmRequester } from '@moonshot-ai/agent-core/loop/index';
import { MAIN_AGENT_ID, type Agent, type Session } from '@moonshot-ai/agent-core/session/index';
import type { ToolDefinition } from '@moonshot-ai/agent-core/tool/index';

import {
  createSpawn,
  createStaticProfileCatalog,
  FORK_CONTEXT_NOTICE,
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_REMIND_KEY,
  FORK_WITH_MODEL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  FORK_WITH_TYPE_UNAVAILABLE,
  normalizeAgentProfile,
  planSpawn,
  RESUME_WITH_TYPE_UNAVAILABLE,
  SUBAGENT_UPDATE_KEY,
  validateSpawnArgs,
  type ProfileCatalog,
  type SpawnModelEntry,
} from '#/features/spawn/index';
import {
  createHarness,
  harnessInternals,
  memoryHarnessSpace,
  useAgentTools,
  type Harness,
} from '#/runtime/index';

const fastModel: SpawnModelEntry = {
  name: 'fast',
  description: 'Fast test model',
  model: { provider: 'test', name: 'fast-model' },
};

interface LlmCall {
  readonly systemPrompt?: string;
  readonly modelName?: string;
  readonly messages: readonly Message[];
  readonly tools: readonly ToolDescription[];
}

type LlmScript = (call: LlmCall) => { text: string } | { toolCall: { name: string; arguments: string } };

function textOutcome(text: string, toolCalls: ToolCall[] = []): LlmOutcome {
  return { type: 'done', message: createAssistantMessage([{ type: 'text', text }], toolCalls) };
}

function createMockRequester(
  script: LlmScript,
  filled: LlmRequestPart = {},
): { requester: LoopLlmRequester; calls: LlmCall[] } {
  const calls: LlmCall[] = [];
  const make = (acc: Readonly<Record<string, unknown>>): LoopLlmRequester => ({
    with: (part) => make(mergeFields(acc, part as Readonly<Record<string, unknown>>) ?? {}),
    request: (rest) =>
      mergeFields(acc, rest as Readonly<Record<string, unknown>>) as unknown as LlmRequest,
    generate: async (rest) => {
      const merged = mergeFields(acc, rest as Readonly<Record<string, unknown>>) as unknown as LlmRequest;
      const call: LlmCall = {
        systemPrompt: merged.profile?.systemPrompt,
        modelName: merged.model?.spec.name,
        messages: merged.content?.messages ?? [],
        tools: merged.profile?.tools ?? [],
      };
      calls.push(call);
      const out = script(call);
      if ('toolCall' in out) {
        return textOutcome('', [
          {
            type: 'function',
            id: `call-${calls.length}`,
            name: out.toolCall.name,
            arguments: out.toolCall.arguments,
          },
        ]);
      }
      return textOutcome(out.text);
    },
  });
  return { calls, requester: make(filled as Readonly<Record<string, unknown>>) };
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
  if (text === FORK_CONTEXT_NOTICE) {
    const task = call.messages.findLast(
      (message) => message.role === 'user' && extractText(message).startsWith('SUB:'),
    );
    return { text: `echo:${(task !== undefined ? extractText(task) : '').slice('SUB:'.length)}` };
  }
  return { text: 'parent done' };
};

const DUMMY_TOOL_NAMES = ['Bash', 'Read', 'Write', 'Glob', 'Grep'] as const;

function bindDummyTools(): Feature<void> {
  return createFeature('test-tools', {
    agent() {
      useAgentTools(
        ...DUMMY_TOOL_NAMES.map(
          (name): ToolDefinition => ({
            name,
            description: `dummy ${name}`,
            parameters: { type: 'object', properties: {} },
            execute: async () => ({ content: [{ type: 'text', text: `${name} output` }] }),
          }),
        ),
      );
    },
  });
}

function testCatalog(): ProfileCatalog {
  return createStaticProfileCatalog([
    normalizeAgentProfile({
      name: 'agent',
      description: 'Default agent',
      tools: ['Agent', 'Bash', 'Read'],
      subagents: ['coder', 'explore', 'plan'],
      systemPrompt: () => 'default agent prompt',
    }),
    normalizeAgentProfile({
      name: 'coder',
      description: 'General software engineering agent',
      whenToUse: 'Use this agent for non-trivial software engineering work.',
      tools: ['Agent', 'Bash', 'Read', 'Write'],
      subagents: ['coder', 'explore', 'plan'],
      systemPrompt: () => 'coder system prompt',
    }),
    normalizeAgentProfile({
      name: 'explore',
      description: 'Fast codebase exploration with prompt-enforced read-only behavior.',
      whenToUse: 'Fast agent specialized for exploring codebases.',
      tools: ['Read', 'Glob', 'Grep'],
      systemPrompt: () => 'explore system prompt',
      promptPrefix: async () => '<git-context>\nfake git context',
    }),
    normalizeAgentProfile({
      name: 'plan',
      description: 'Read-only implementation planning and architecture design.',
      whenToUse: 'Use this agent when the parent agent needs a step-by-step implementation plan',
      tools: ['Read', 'Glob'],
      systemPrompt: () => 'plan system prompt',
    }),
  ]);
}

const tmpDirs: string[] = [];

afterEach(async () => {
  delete process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'];
  delete process.env['KIMI_CODE_EXPERIMENTAL_FLAG'];
  while (tmpDirs.length > 0) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true });
  }
});

interface SpawnTestEnv {
  readonly harness: Harness;
  readonly session: Session;
  readonly main: Agent;
  readonly calls: LlmCall[];
}

async function startApp(
  space = memoryHarnessSpace(),
  opts?: {
    models?: readonly SpawnModelEntry[];
    withCatalog?: boolean;
    requesterFilled?: LlmRequestPart;
  },
): Promise<SpawnTestEnv> {
  const workDir = await mkdtemp(join(tmpdir(), 'spawn-work-'));
  tmpDirs.push(workDir);
  const { requester, calls } = createMockRequester(script, opts?.requesterFilled ?? {});
  const harness = createHarness({ space });
  await harness.app.features.add(
    createSpawn({
      catalog: opts?.withCatalog === false ? undefined : testCatalog(),
      models: opts?.models,
      workDir,
    }),
  );
  await harness.app.features.add(bindDummyTools());
  const session = await harness.app.create({ sessionId: 'sess' });
  const main = await harness.ensureAgent(session, MAIN_AGENT_ID, { systemPrompt: 'main-host' });
  setRequester(harness, 'sess', MAIN_AGENT_ID, requester);
  return { harness, session, main, calls };
}

function setRequester(
  harness: Harness,
  sessionId: string,
  agentId: string,
  requester: LoopLlmRequester,
): void {
  const session = harness.app.sessions.get(sessionId);
  const runtime =
    session !== undefined ? harnessInternals(harness.app).agents.get(session)?.get(agentId) : undefined;
  if (runtime === undefined) throw new Error(`no runtime for agent '${agentId}'`);
  runtime.requester = requester;
}

function user(text: string) {
  return createUserEntry(createUserMessage(text), { source: 'input' });
}

function agentCall(args: unknown): string {
  return `AGENT:${JSON.stringify(args)}`;
}

function trackSubagentIds(agent: Agent): string[] {
  const ids: string[] = [];
  agent.loop.subscribe((event) => {
    if (event.type === 'tool.delta' && event.update.key === SUBAGENT_UPDATE_KEY) {
      ids.push(event.update.text);
    }
  });
  return ids;
}

function toolResults(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'tool')
    .map((entry) => extractText(entry.message));
}

function toolResultIsErrors(agent: Agent): boolean[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'tool')
    .map((entry) => (entry.meta as ToolMeta | undefined)?.isError === true);
}

function userTexts(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter((entry) => entry.message.role === 'user')
    .map((entry) => extractText(entry.message));
}

function asyncToolTexts(agent: Agent): string[] {
  return agent.view
    .getState()
    .messages.filter((entry) => (entry.meta as UserMeta | undefined)?.source === 'async-tool')
    .map((entry) => extractText(entry.message));
}

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
  const catalog = testCatalog();

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
    expect(explore.profile?.systemPrompt({})).toContain('explore system prompt');

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

  it('lets main delegate to discovered workspace profiles but not other agents', () => {
    const base = createStaticProfileCatalog([
      normalizeAgentProfile({
        name: 'agent',
        subagents: ['coder'],
        systemPrompt: () => 'default agent prompt',
      }),
      normalizeAgentProfile({
        name: 'coder',
        subagents: ['coder'],
        systemPrompt: () => 'coder system prompt',
      }),
      normalizeAgentProfile({
        name: 'custom-x',
        description: 'Custom X agent',
        systemPrompt: () => 'custom x prompt',
      }),
    ]);
    const discoveredCatalog: ProfileCatalog = {
      ...base,
      inspect: (name) => {
        const hit = base.inspect(name);
        if (hit === undefined) return undefined;
        return name === 'custom-x' ? { ...hit, sourceId: 'workspace' } : hit;
      },
    };
    const delegated = planSpawn(
      { callerAgentId: MAIN_AGENT_ID, profileName: 'custom-x', fork: false },
      { catalog: discoveredCatalog, models: [] },
    );
    if (!delegated.ok) throw new Error('unreachable');
    expect(delegated.profileName).toBe('custom-x');

    const denied = planSpawn(
      { callerAgentId: 'subagent-1', callerProfileName: 'coder', profileName: 'custom-x', fork: false },
      { catalog: discoveredCatalog, models: [] },
    );
    if (denied.ok) throw new Error('unreachable');
    expect(denied.error).toBe(
      'Subagent type "custom-x" is not allowed for this agent. Allowed subagent types: coder.',
    );
  });
});

describe('spawn tool', () => {
  it('lists catalog profiles in the tool description and gates schema parameters', async () => {
    const plain = await startApp();
    await plain.main.loop.runTurn(user('hello'));
    const agentTool = plain.calls[0]!.tools.find((tool) => tool.name === 'Agent');
    expect(agentTool).toBeDefined();
    expect(agentTool!.description).toContain('Available agent types (pass via subagent_type):');
    expect(agentTool!.description).toContain('- coder: General software engineering agent');
    expect(agentTool!.description).toContain(
      '- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases.',
    );
    expect(agentTool!.description).toContain(
      '- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan',
    );
    expect(agentTool!.description).toContain('Tools: Read, Glob, Grep');
    expect(agentTool!.description).not.toContain('- agent:');
    expect(agentTool!.description).not.toContain('Available models');
    const properties = agentTool!.parameters['properties'] as Record<string, unknown>;
    expect(Object.keys(properties)).not.toContain('fork');
    expect(Object.keys(properties)).not.toContain('model');
    await plain.harness.close();

    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    const rich = await startApp(memoryHarnessSpace(), { models: [fastModel] });
    await rich.main.loop.runTurn(user('hello'));
    const richTool = rich.calls[0]!.tools.find((tool) => tool.name === 'Agent');
    expect(richTool!.description).toContain('Available models (pass via model):');
    expect(richTool!.description).toContain('- fast: Fast test model');
    expect(richTool!.description).toContain('- primary: your current model and thinking level');
    const richProperties = richTool!.parameters['properties'] as Record<string, unknown>;
    expect(Object.keys(richProperties)).toContain('fork');
    expect(Object.keys(richProperties)).toContain('model');
    await rich.harness.close();
  });

  it('runs a foreground subagent to completion and reports the child through tool updates', async () => {
    const { harness, session, main } = await startApp();
    const subagentIds = trackSubagentIds(main);
    await main.loop.runTurn(user(agentCall({ prompt: 'SUB:do the task', description: 'run the task' })));
    await main.flush();

    expect(subagentIds).toHaveLength(1);
    const agentId = subagentIds[0]!;
    expect(agentId).toMatch(/^subagent-/);
    expect(session.roster.getState().agents[agentId]?.source).toBe(`spawn:${MAIN_AGENT_ID}:coder`);

    const results = toolResults(main);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain(`agent_id: ${agentId}`);
    expect(results[0]).toContain('actual_subagent_type: coder');
    expect(results[0]).toContain('status: completed');
    expect(results[0]).toContain('stop_reason: completed');
    expect(results[0]).toContain('[summary]');
    expect(results[0]).toContain('echo:do the task');
    expect(results[0]).toContain(`resume_hint: Continue with Agent(resume="${agentId}"`);

    const child = session.agents.get(agentId);
    expect(child).toBeDefined();
    expect(userTexts(child!)).toEqual(['SUB:do the task']);
    expect(
      child!.view
        .getState()
        .messages.some((entry) => extractText(entry.message) === 'echo:do the task'),
    ).toBe(true);
    expect(child!.loop.state.profile.systemPrompt).toBe('coder system prompt');
    expect(child!.loop.state.profile.tools?.map((tool) => tool.name)).toEqual([
      'Agent',
      'Bash',
      'Read',
      'Write',
    ]);

    await harness.close();
  });

  it('trims the subagent tool surface to the profile whitelist', async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    const { harness, session, main } = await startApp();
    const subagentIds = trackSubagentIds(main);
    await main.loop.runTurn(
      user(agentCall({ prompt: 'SUB:explore it', description: 'explore task', subagent_type: 'explore' })),
    );
    await main.flush();

    expect(subagentIds).toHaveLength(1);
    const agentId = subagentIds[0]!;
    expect(session.roster.getState().agents[agentId]?.source).toBe(`spawn:${MAIN_AGENT_ID}:explore`);
    const child = session.agents.get(agentId)!;
    expect(child.loop.state.profile.tools?.map((tool) => tool.name)).toEqual(['Read', 'Glob', 'Grep']);
    const texts = userTexts(child);
    expect(texts[0]).toContain('<git-context>');
    expect(texts[0]).toContain('SUB:explore it');

    await main.loop.runTurn(
      user(agentCall({ prompt: 'SUB:fork it', description: 'fork task', fork: true })),
    );
    await main.flush();
    expect(subagentIds).toHaveLength(2);
    const forkId = subagentIds[1]!;
    const forkChild = session.agents.get(forkId)!;
    expect(forkChild.loop.state.profile.tools?.map((tool) => tool.name)).toEqual([
      'Agent',
      'Bash',
      'Read',
      'Write',
      'Glob',
      'Grep',
    ]);
    expect(userTexts(forkChild).some((text) => text.includes('<git-context>'))).toBe(false);

    await harness.close();
  });

  it('forks the caller context with a snapshot notice and inherits history', async () => {
    process.env['KIMI_CODE_EXPERIMENTAL_SUBAGENT_FORK'] = 'true';
    const { harness, session, main } = await startApp();
    const subagentIds = trackSubagentIds(main);
    await main.loop.runTurn(user('hello'));
    await main.loop.runTurn(
      user(agentCall({ prompt: 'SUB:continue it', description: 'fork task', fork: true })),
    );
    await main.flush();

    expect(subagentIds).toHaveLength(1);
    const agentId = subagentIds[0]!;
    expect(session.roster.getState().agents[agentId]?.source).toBe(`spawn:${MAIN_AGENT_ID}:fork`);
    const results = toolResults(main);
    expect(results[0]).toContain('status: completed');
    expect(results[0]).toContain('actual_subagent_type: fork');

    const child = session.agents.get(agentId)!;
    const texts = userTexts(child);
    expect(texts).toContain('hello');
    expect(texts).toContain('SUB:continue it');
    const history = child.view.getState().messages;
    expect(history.some((entry) => extractText(entry.message) === 'parent done')).toBe(true);
    expect(history.some((entry) => extractText(entry.message) === 'echo:continue it')).toBe(true);
    const notice = history.find((entry) => entry.meta?.key === FORK_REMIND_KEY);
    expect(notice).toBeDefined();
    expect(extractText(notice!.message)).toBe(FORK_CONTEXT_NOTICE);

    await harness.close();
  });

  it('detaches a background subagent and delivers the completion as a later notification', async () => {
    const { harness, main } = await startApp();
    const subagentIds = trackSubagentIds(main);
    await main.loop.runTurn(
      user(agentCall({ prompt: 'SUB:bg task', description: 'bg task', run_in_background: true })),
    );
    await main.flush();

    expect(subagentIds).toHaveLength(1);
    const agentId = subagentIds[0]!;
    const results = toolResults(main);
    expect(results).toHaveLength(1);
    expect(results[0]).toContain('task_id: call-');
    expect(results[0]).toContain('status: running');
    expect(results[0]).toContain(`agent_id: ${agentId}`);
    expect(results[0]).toContain('automatic_notification: true');
    expect(results[0]).toContain('do NOT wait, poll');

    await vi.waitFor(async () => {
      await main.flush();
      const notification = asyncToolTexts(main).find((text) =>
        text.includes('[async tool completed]'),
      );
      expect(notification).toBeDefined();
      expect(notification).toContain('status: completed');
      expect(notification).toContain('echo:bg task');
    });

    await harness.close();
  });

  it('resumes a live subagent and rejects unknown resume ids', async () => {
    const { harness, session, main } = await startApp();
    const subagentIds = trackSubagentIds(main);
    await main.loop.runTurn(user(agentCall({ prompt: 'SUB:first task', description: 'first task' })));
    const agentId = subagentIds[0]!;

    await main.loop.runTurn(
      user(agentCall({ resume: agentId, prompt: 'SUB:follow up', description: 'follow up' })),
    );
    await main.flush();
    const child = session.agents.get(agentId)!;
    expect(userTexts(child)).toEqual(['SUB:first task', 'SUB:follow up']);
    const results = toolResults(main);
    expect(results[1]).toContain('status: completed');
    expect(results[1]).toContain('echo:follow up');

    await main.loop.runTurn(
      user(agentCall({ resume: 'subagent-missing', prompt: 'x', description: 'x' })),
    );
    await main.flush();
    const afterResume = toolResults(main);
    expect(afterResume[2]).toContain('"subagent-missing" does not exist or is not a subagent');
    expect(toolResultIsErrors(main)).toEqual([false, false, true]);

    await harness.close();
  });

  it('inherits the caller model when the tool call omits model', async () => {
    const { harness, main, calls } = await startApp(memoryHarnessSpace(), {
      models: [fastModel],
      requesterFilled: { model: { spec: fastModel.model } },
    });
    const subagentIds = trackSubagentIds(main);
    await main.loop.runTurn(user(agentCall({ prompt: 'SUB:inherit', description: 'inherit model' })));
    await main.flush();
    expect(subagentIds).toHaveLength(1);
    const childCalls = calls.filter((call) => call.systemPrompt === 'coder system prompt');
    expect(childCalls.length).toBeGreaterThan(0);
    expect(childCalls[0]!.modelName).toBe('fast-model');

    await harness.close();
  });

  it('resumes a non-live subagent by reopening it from the persisted roster', async () => {
    const space = memoryHarnessSpace();
    const first = await startApp(space);
    const subagentIds = trackSubagentIds(first.main);
    await first.main.loop.runTurn(
      user(agentCall({ prompt: 'SUB:first task', description: 'first task' })),
    );
    await first.main.flush();
    const agentId = subagentIds[0]!;
    expect(first.session.roster.getState().agents[agentId]?.source).toBe(
      `spawn:${MAIN_AGENT_ID}:coder`,
    );
    await first.harness.close();

    const second = await startApp(space);
    expect(second.session.agents.get(agentId)).toBeUndefined();
    await second.main.loop.runTurn(
      user(agentCall({ resume: agentId, prompt: 'SUB:follow up', description: 'follow up' })),
    );
    await second.main.flush();

    const child = second.session.agents.get(agentId);
    expect(child).toBeDefined();
    expect(userTexts(child!)).toEqual(['SUB:first task', 'SUB:follow up']);
    const results = toolResults(second.main);
    expect(results.at(-1)).toContain('status: completed');
    expect(results.at(-1)).toContain('echo:follow up');

    await second.harness.close();
  });

  it('does not register the Agent tool when no catalog is available', async () => {
    const plain = await startApp(memoryHarnessSpace(), { withCatalog: false });
    await plain.main.loop.runTurn(user('hello'));
    expect(plain.calls[0]!.tools.find((tool) => tool.name === 'Agent')).toBeUndefined();
    await plain.harness.close();
  });
});
