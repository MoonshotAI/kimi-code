import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentTaskService } from '#/agent/task/task';
import { TowerStore } from '#/features/tower/protocol/index';
import { IAgentTowerService } from '#/features/tower/tower';
import { ITowerRateLimitService } from '#/features/tower/towerRateLimit';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { ITowerSpawnTool, type TowerSpawnToolInput } from '#/features/tower/tools/spawn/spawn';
import { TowerSpawnTool } from '#/features/tower/tools/spawn/spawnTool';
import { TOWER_MODE_USER_ENABLED_ONLY } from '#/features/tower/tools/support';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { UNKNOWN_CAPABILITY } from '#/llm-adapter/contract/capability';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import {
  DEFAULT_SUBAGENT_TIMEOUT_MS,
  SECONDARY_MODEL_SECTION,
  SUBAGENT_SECTION,
} from '#/session/subagent/configSection';
import {
  ISessionSubagentService,
  type AgentRunHandle,
} from '#/session/subagent/subagent';
import type { AgentTaskInfo } from '#/agent/task/types';
import type { ExecutableToolResult } from '#/tool/toolContract';

import { executeTool } from '../../../tools/fixtures/execute-tool';
import { stubAgentContext } from '../../../agent/agentContext/stubs';

const execFileAsync = promisify(execFile);
const signal = new AbortController().signal;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('TowerSpawnTool', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let repo: string;
  let store: TowerStore;

  let towerActive: boolean;
  let gate: { readonly ok: true } | { readonly ok: false; readonly reason: string };
  let release: Mock<() => void>;
  let createAgent: Mock<IAgentLifecycleService['create']>;
  let runAgent: Mock<ISessionSubagentService['run']>;
  let registerTask: Mock<IAgentTaskService['registerTask']>;
  let taskInfoLookup: (taskId: string) => AgentTaskInfo | undefined;
  let completion: Deferred<{ readonly summary: string }>;
  let secondaryModel:
    | { readonly model: string; readonly defaultEffort?: string; readonly force?: boolean }
    | undefined;
  let subagentTimeoutMs: number | undefined;
  let thinkingEnabled: boolean | undefined;
  let modelMeta: Record<string, Partial<Model>>;
  let createdSetMode: Mock<(mode: PermissionMode) => void>;
  let createdThinkingEffort: string;

  async function git(cwd: string, ...args: string[]): Promise<void> {
    await execFileAsync('git', args, { cwd });
  }

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), 'tower-spawn-test-'));
    await git(repo, 'init', '-b', 'main');
    await git(repo, 'config', 'user.email', 'tower-test@example.com');
    await git(repo, 'config', 'user.name', 'Tower Test');
    await writeFile(join(repo, 'README.md'), '# fixture\n');
    await git(repo, 'add', 'README.md');
    await git(repo, 'commit', '-m', 'initial');
    store = new TowerStore(repo);
    await store.init();
    await store.plan([{ title: 'Build gemm', scope: ['src/**'] }]);

    towerActive = true;
    gate = { ok: true };
    release = vi.fn();
    completion = deferred();
    secondaryModel = undefined;
    subagentTimeoutMs = undefined;
    thinkingEnabled = undefined;
    modelMeta = {};
    createdSetMode = vi.fn();
    createdThinkingEffort = 'off';
    createAgent = vi.fn(async () => stubAgentContext('agent-7', 1));
    runAgent = vi.fn(
      async (agent: AgentContext) =>
        ({
          agentId: agent.agentId,
          turn: undefined,
          completion: completion.promise,
        }) as unknown as AgentRunHandle,
    );
    registerTask = vi.fn(() => 'task-1');
    taskInfoLookup = () => undefined;

    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IAgentTowerService, {
      get isActive() {
        return towerActive;
      },
      get requestedBase() {
        return undefined;
      },
      enter: () => Promise.resolve({ entered: true as const }),
      exit: () => {},
    } as unknown as IAgentTowerService);
    ix.stub(ITowerRateLimitService, {
      acquire: () => gate,
      release,
    } as unknown as ITowerRateLimitService);
    ix.stub(ISessionContext, { cwd: repo, sessionId: 'session-spawn-test' } as unknown as ISessionContext);
    ix.stub(IAgentScopeContext, { agentId: 'main', scope: (subKey?: string) => subKey ?? '' });
    const createdHandle = {
      id: 'agent-7',
      accessor: {
        get: (id: unknown) => {
          if (id === (IAgentPermissionModeService as unknown)) {
            return { setMode: createdSetMode };
          }
          if (id === (IAgentProfileService as unknown)) {
            return { getEffectiveThinkingLevel: () => createdThinkingEffort };
          }
          if (id === (IAgentScopeContext as unknown)) {
            return {
              agentId: 'agent-7',
              agentContext: stubAgentContext('agent-7', 1),
            };
          }
          return undefined;
        },
      },
    } as never;
    const mainHandle = {
      id: 'main',
      accessor: {
        get: (id: unknown) =>
          id === (IEventBus as unknown)
            ? ix.get(IEventBus)
            : id === (IAgentLifecycleService as unknown)
              ? { list: () => [], handleOf: () => undefined }
              : undefined,
      },
    } as never;
    ix.stub(IAgentLifecycleService, {
      handleOf: (agentId: string) => {
        if (agentId === 'main') return mainHandle;
        if (agentId === 'agent-7') return createdHandle;
        return undefined;
      },
      create: createAgent,
    } as unknown as IAgentLifecycleService);
    ix.stub(ISessionSubagentService, { run: runAgent } as unknown as ISessionSubagentService);
    ix.stub(IAgentTaskService, { registerTask, getTask: (taskId: string) => taskInfoLookup(taskId) } as unknown as IAgentTaskService);
    ix.stub(IAgentProfileService, {
      data: () => ({ profileName: 'agent', modelAlias: 'kimi-code', thinkingLevel: 'off' }),
    } as unknown as IAgentProfileService);
    ix.stub(IConfigService, {
      get: ((domain: string) =>
        domain === SECONDARY_MODEL_SECTION
          ? secondaryModel
          : domain === SUBAGENT_SECTION && subagentTimeoutMs !== undefined
            ? { timeoutMs: subagentTimeoutMs }
            : domain === 'thinking' && thinkingEnabled !== undefined
              ? { enabled: thinkingEnabled }
              : undefined) as IConfigService['get'],
    });
    ix.stub(IModelCatalog, {
      get: (alias: string) => ({ id: alias, ...modelMeta[alias] }) as Model,
    } as unknown as IModelCatalog);
    ix.set(ITowerSpawnTool, new SyncDescriptor(TowerSpawnTool));
  });

  afterEach(async () => {
    disposables.dispose();
    await rm(repo, { recursive: true, force: true });
  });

  function execute(args: TowerSpawnToolInput): Promise<ExecutableToolResult> {
    return executeTool(ix.get(ITowerSpawnTool), {
      args,
      turnId: 0,
      toolCallId: 'call_spawn',
      signal,
    });
  }

  const WORKER_ARGS: TowerSpawnToolInput = {
    name: 'agent-build',
    kind: 'worker',
    mission_id: 'M1',
  };

  it('refuses when tower mode is not active', async () => {
    towerActive = false;

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({
      output: TOWER_MODE_USER_ENABLED_ONLY,
      isError: true,
    });
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('records the death of a worker whose task settled before roster registration finished', async () => {
    taskInfoLookup = () => ({
      taskId: 'task-1',
      kind: 'agent',
      description: 'tower worker agent-build: Build gemm',
      status: 'failed',
      stopReason: 'provider blew up',
      startedAt: 1,
      endedAt: 2,
      agentId: 'agent-7',
      subagentType: 'tower-worker',
    });

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeFalsy();
    const state = await store.load();
    const entry = state.roster.agents.find((agent) => agent.agentId === 'agent-7');
    expect(entry?.deathStatus).toBe('failed');
    expect(entry?.deathReason).toBe('provider blew up');
  });

  it('rejects non-main callers with the main-agent-only error before any work', async () => {
    ix.stub(IAgentScopeContext, { agentId: 'agent-w1', scope: (subKey?: string) => subKey ?? '' });

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({
      output: 'Tower orchestration tools are only supported by the main agent.',
      isError: true,
    });
    expect(createAgent).not.toHaveBeenCalled();
    expect(registerTask).not.toHaveBeenCalled();
  });

  it('surfaces the rate-limit reason as an error result', async () => {
    gate = { ok: false, reason: 'tower spawn paused: provider is rate-limiting' };

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({ output: gate.ok === false ? gate.reason : '', isError: true });
    expect(createAgent).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();

    const mission = (await store.load()).missions.find((m) => m.id === 'M1');
    expect(mission?.status).toBe('planned');
    expect(mission?.owner).toBeUndefined();
  });

  it('leaves the mission untouched when the launch fails', async () => {
    createAgent.mockRejectedValue(new Error('provider unavailable'));

    const result = await execute(WORKER_ARGS);

    expect(result).toEqual({ output: 'tower spawn failed: provider unavailable', isError: true });
    const state = await store.load();
    const mission = state.missions.find((m) => m.id === 'M1');
    expect(mission?.status).toBe('planned');
    expect(mission?.owner).toBeUndefined();
    expect(state.roster.agents).toHaveLength(0);
  });

  it('spawns a detached tower-worker, registers the roster entry, and releases the slot on settle', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    const worktreeAbs = join(repo, '.tower/worktrees/wt-1');
    expect(result.output).toContain('agent_id: agent-7');
    expect(result.output).toContain('task_id: task-1');
    expect(result.output).toContain('status: running');
    expect(result.output).toContain(`worktree: ${worktreeAbs}`);

    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'kimi-code', thinking: 'off' },
      labels: { parentAgentId: 'main' },
    });
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-7' }),
      { kind: 'prompt', prompt: expect.stringContaining(worktreeAbs) },
      { signal: expect.any(AbortSignal) },
    );
    expect(registerTask).toHaveBeenCalledWith(expect.any(SubagentTask), {
      detached: true,
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      signal: undefined,
    });

    const state = await store.load();
    const entry = state.roster.agents.find((agent) => agent.name === 'agent-build');
    expect(entry).toMatchObject({
      agentId: 'agent-7',
      sessionId: 'session-spawn-test',
      kind: 'worker',
      missionId: 'M1',
      worktree: 'wt-1',
      branch: 'feat/build-gemm',
    });
    const mission = state.missions.find((m) => m.id === 'M1');
    expect(mission?.status).toBe('active');
    expect(mission?.owner).toBe('agent-build');

    expect(release).not.toHaveBeenCalled();
    completion.resolve({ summary: 'worker done' });
    await vi.waitFor(() => {
      expect(release).toHaveBeenCalledTimes(1);
    });
  });

  it('honors the configured [subagent].timeout_ms for the registered task', async () => {
    subagentTimeoutMs = 30 * 60 * 1000;

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(registerTask).toHaveBeenCalledWith(expect.any(SubagentTask), {
      detached: true,
      timeoutMs: 30 * 60 * 1000,
      signal: undefined,
    });
  });

  it('falls back to the 2h default timeout when no subagent timeout is configured', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(registerTask).toHaveBeenCalledWith(expect.any(SubagentTask), {
      detached: true,
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
      signal: undefined,
    });
  });

  it('pins the spawned agent to the auto permission mode', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(createdSetMode).toHaveBeenCalledWith('auto');
  });

  it('carries the bound model and the spawned agent thinking effort into the registered task info', async () => {
    createdThinkingEffort = 'high';

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    const task = registerTask.mock.calls[0]?.[0] as SubagentTask;
    const info = task.toInfo({
      taskId: 'task-1',
      description: task.description,
      status: 'running',
      startedAt: 1,
      endedAt: null,
    });
    expect(info).toMatchObject({
      kind: 'agent',
      agentId: 'agent-7',
      subagentType: 'tower-worker',
      model: 'kimi-code',
      thinkingEffort: 'high',
    });
  });

  it('carries the configured secondary model into the registered task info', async () => {
    secondaryModel = { model: 'cheap/fast' };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    const task = registerTask.mock.calls[0]?.[0] as SubagentTask;
    expect(task.model).toBe('cheap/fast');
  });

  it('binds the configured secondary model and reports it in the output and activity log', async () => {
    secondaryModel = { model: 'cheap/fast' };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('model: cheap/fast');
    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'cheap/fast', thinking: undefined },
      labels: { parentAgentId: 'main' },
    });
    const activityLog = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(activityLog).toMatch(/spawn .*model=cheap\/fast/);
  });

  it('passes [secondary_model].default_effort to the spawned worker', async () => {
    secondaryModel = { model: 'cheap/fast', defaultEffort: 'low' };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'cheap/fast', thinking: 'low' },
      labels: { parentAgentId: 'main' },
    });
  });

  it('falls back to the bound model default_effort when the section declares none', async () => {
    secondaryModel = { model: 'cheap/fast' };
    modelMeta['cheap/fast'] = {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'cheap/fast', thinking: 'max' },
      labels: { parentAgentId: 'main' },
    });
  });

  it('leaves thinking unset for global resolution when thinking is disabled', async () => {
    secondaryModel = { model: 'cheap/fast' };
    thinkingEnabled = false;
    modelMeta['cheap/fast'] = {
      capabilities: { ...UNKNOWN_CAPABILITY, thinking: true },
      supportEfforts: ['low', 'high', 'max'],
      defaultEffort: 'max',
    };

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'cheap/fast', thinking: undefined },
      labels: { parentAgentId: 'main' },
    });
  });

  it('inherits the tower model when no secondary model is configured', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('model: kimi-code');
    const activityLog = await readFile(join(repo, '.tower/comms/log/activity.log'), 'utf8');
    expect(activityLog).toMatch(/spawn .*model=kimi-code/);
  });

  it('binds reviewers to the tower model even when the secondary model is configured', async () => {
    secondaryModel = { model: 'cheap/fast' };

    const result = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/build-gemm',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('model: kimi-code');
    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'kimi-code', thinking: 'off' },
      labels: { parentAgentId: 'main' },
    });
  });

  it('binds reviewers to the forced secondary model when it is configured', async () => {
    secondaryModel = { model: 'cheap/fast', force: true };

    const result = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/build-gemm',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('model: cheap/fast');
    expect(createAgent).toHaveBeenCalledWith({
      binding: { profile: 'tower-worker', model: 'cheap/fast', thinking: undefined },
      labels: { parentAgentId: 'main' },
    });
  });

  it('registers a reviewer without a worktree', async () => {
    const result = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/build-gemm',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('review_target: feat/build-gemm');
    const state = await store.load();
    const entry = state.roster.agents.find((agent) => agent.name === 'reviewer-a');
    expect(entry).toMatchObject({
      agentId: 'agent-7',
      kind: 'reviewer',
      reviewTarget: 'feat/build-gemm',
    });
    expect(entry?.worktree).toBeUndefined();
  });

  it('refuses a duplicate name and points at resume', async () => {
    await store.registerAgent({
      name: 'agent-build',
      agentId: 'agent-old',
      kind: 'worker',
      missionId: 'M1',
      worktree: 'wt-1',
      branch: 'feat/build-gemm',
      spawnedAt: new Date().toISOString(),
    });

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBe(true);
    expect(result.output).toContain('already registered');
    expect(result.output).toContain('Agent(resume="agent-old"');
    expect(createAgent).not.toHaveBeenCalled();
  });

  it('snapshots base WIP into the worker branch and records the spawn base', async () => {
    await writeFile(join(repo, 'wip.ts'), 'export const wip = 1;\n');

    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('base snapshot:');
    const worktreeAbs = join(repo, '.tower/worktrees/wt-1');
    expect(await readFile(join(worktreeAbs, 'wip.ts'), 'utf8')).toBe('export const wip = 1;\n');
    expect(runAgent).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-7' }),
      { kind: 'prompt', prompt: expect.stringContaining('snapshot commit') },
      { signal: expect.any(AbortSignal) },
    );
    const mission = (await store.load()).missions.find((m) => m.id === 'M1');
    expect(mission?.spawnBase).toBeDefined();
  });

  it('bases the reviewer prompt on the base branch once a rebase drops the snapshot', async () => {
    await writeFile(join(repo, 'wip.ts'), 'export const wip = 1;\n');
    const workerResult = await execute(WORKER_ARGS);
    expect(workerResult.isError).toBeUndefined();
    const snapshot = (await store.load()).missions.find((m) => m.id === 'M1')?.spawnBase;
    expect(snapshot).toBeDefined();
    const worktreeAbs = join(repo, '.tower/worktrees/wt-1');

    await git(repo, 'add', 'wip.ts');
    await git(repo, 'commit', '-m', 'commit my wip');
    await git(worktreeAbs, 'rebase', 'main');
    await expect(
      git(worktreeAbs, 'merge-base', '--is-ancestor', snapshot!, 'feat/build-gemm'),
    ).rejects.toThrow();

    const result = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/build-gemm',
    });

    expect(result.isError).toBeUndefined();
    expect(runAgent).toHaveBeenLastCalledWith(
      expect.objectContaining({ agentId: 'agent-7' }),
      { kind: 'prompt', prompt: expect.stringContaining('against base "main"') },
      { signal: expect.any(AbortSignal) },
    );
  });

  it('records no spawn base when the base checkout is clean', async () => {
    const result = await execute(WORKER_ARGS);

    expect(result.isError).toBeUndefined();
    expect(result.output).not.toContain('base snapshot:');
    const mission = (await store.load()).missions.find((m) => m.id === 'M1');
    expect(mission?.spawnBase).toBeUndefined();
  });

  it('briefs the worker with the mission context and the clarify-first discipline', async () => {
    const [docs] = await store.plan([
      {
        title: 'Docs polish',
        scope: ['docs/**'],
        tasks: ['rewrite the intro'],
        context: 'Keep the tone friendly. Do not document internals.',
      },
    ]);

    const result = await execute({ name: 'agent-docs', kind: 'worker', mission_id: docs!.id });

    expect(result.isError).toBeUndefined();
    const prompt = (runAgent.mock.calls.at(-1)?.[1] as { prompt: string }).prompt;
    expect(prompt).toContain("## Context — the user's own words, verbatim");
    expect(prompt).toContain('Keep the tone friendly. Do not document internals.');
    expect(prompt).toContain('Ambiguity is escalated, not guessed');
    expect(prompt).toContain('subject="clarify-request"');
  });

  it('briefs the reviewer with the mission text and the worker self-report', async () => {
    const [docs] = await store.plan([
      {
        title: 'Docs polish',
        scope: ['docs/**'],
        tasks: ['rewrite the intro'],
        context: 'Keep the tone friendly. Do not document internals.',
      },
    ]);
    const workerResult = await execute({ name: 'agent-docs', kind: 'worker', mission_id: docs!.id });
    expect(workerResult.isError).toBeUndefined();
    await store.send('agent-docs', {
      to: 'tower',
      subject: 'review-request',
      body: 'Rewrote the intro; tone kept friendly, internals left out.',
    });

    const result = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: docs!.branch,
    });

    expect(result.isError).toBeUndefined();
    const prompt = (runAgent.mock.calls.at(-1)?.[1] as { prompt: string }).prompt;
    expect(prompt).toContain('# Mission under review');
    expect(prompt).toContain('# Mission M2: Docs polish');
    expect(prompt).toContain('- [ ] rewrite the intro');
    expect(prompt).toContain('Keep the tone friendly. Do not document internals.');
    expect(prompt).toContain("# The author's own account");
    expect(prompt).toContain('Rewrote the intro; tone kept friendly, internals left out.');
    expect(prompt).toContain('1. Intent');
  });

  it('falls back to the generic checklist when the review target owns no mission', async () => {
    const result = await execute({
      name: 'reviewer-a',
      kind: 'reviewer',
      review_target: 'feat/orphan-branch',
    });

    expect(result.isError).toBeUndefined();
    const prompt = (runAgent.mock.calls.at(-1)?.[1] as { prompt: string }).prompt;
    expect(prompt).not.toContain('# Mission under review');
    expect(prompt).toContain('1. Security\n2. Data integrity');
  });
});
