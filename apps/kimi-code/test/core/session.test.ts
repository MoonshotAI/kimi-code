// Uses fake scope handles shaped like the minimal v2 interface subset;
// does not bootstrap the real engine. Services are dispatched by the real
// service identifier objects (same pattern as replay.test.ts), so the
// implementation must ask for the exact tokens it documents. `ensureMainAgent`
// is exercised through its "already exists" branch: the fake lifecycle's
// `getHandle('main')` returns the fake main handle.
import { describe, expect, it } from 'vitest';
import {
  IAgentContextSizeService,
  IAgentFullCompactionService,
  IAgentGoalService,
  IAgentLifecycleService,
  IAgentMcpService,
  IAgentPermissionModeService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentPromptService,
  IAgentRPCService,
  IAgentSwarmService,
  IAgentSystemReminderService,
  IAgentTaskService,
  IAgentUsageService,
  IBootstrapService,
  IEventBus,
  IEventService,
  IHostEnvironment,
  IHostFileSystem,
  ISessionApprovalService,
  ISessionBtwService,
  ISessionContext,
  ISessionCronService,
  ISessionInitService,
  ISessionInteractionService,
  ISessionMetadata,
  ISessionQuestionService,
  ISessionSkillCatalog,
  ISessionSwarmService,
  ISessionWorkspaceCommandService,
} from '@moonshot-ai/agent-core-v2';
import { CoreErrorCodes, isCoreError } from '../../src/core/errors';
import { CoreSession } from '../../src/core/session';
import type { CoreSessionSummary, ResumedSessionState, SessionEvent } from '../../src/core/types';

// -- Minimal fakes: token-dispatching accessor keyed by real identifiers --

function makeAccessor(entries: ReadonlyArray<readonly [unknown, unknown]>) {
  const services = new Map<unknown, unknown>(entries);
  return {
    get: (token: unknown) => {
      if (!services.has(token)) throw new Error(`fake accessor: unexpected service ${String(token)}`);
      return services.get(token);
    },
  };
}

function makeFakeBus() {
  const listeners = new Set<(e: unknown) => void>();
  return {
    subscribe: (h: (e: unknown) => void) => { listeners.add(h); return { dispose: () => listeners.delete(h) }; },
    publish: (e: unknown) => { for (const l of [...listeners]) l(e); },
  };
}

interface FakeInteraction {
  readonly id: string;
  readonly kind: 'approval' | 'question' | 'user_tool';
  readonly payload: unknown;
  readonly origin: { readonly agentId?: string };
  readonly createdAt: number;
}

function makeFakeInteractionKernel(pending: FakeInteraction[]) {
  const changeListeners = new Set<(e: { pending: readonly string[] }) => void>();
  const resolveListeners = new Set<(e: { id: string; response: unknown }) => void>();
  return {
    listPending: (kind?: string) => (kind === undefined ? pending : pending.filter((i) => i.kind === kind)),
    onDidChangePending: (l: (e: { pending: readonly string[] }) => void) => {
      changeListeners.add(l);
      return { dispose: () => changeListeners.delete(l) };
    },
    onDidResolve: (l: (e: { id: string; response: unknown }) => void) => {
      resolveListeners.add(l);
      return { dispose: () => resolveListeners.delete(l) };
    },
    _fireChange: () => { for (const l of [...changeListeners]) l({ pending: pending.map((i) => i.id) }); },
    _fireResolve: (id: string, response: unknown) => { for (const l of [...resolveListeners]) l({ id, response }); },
  };
}

function makeFixture(options?: {
  resumeState?: ResumedSessionState;
  pendingInteractions?: FakeInteraction[];
  agentsMdWarning?: string;
  swarmRunStatus?: 'completed' | 'failed';
}) {
  const calls: Record<string, unknown[]> = {};
  const record = (name: string) => (...args: unknown[]) => { (calls[name] ??= []).push(args); };
  const recordReturning = <T,>(name: string, value: T) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    return value;
  };

  const usage = { total: { inputTokens: 10, outputTokens: 20 } };
  const planData = { id: 'plan-1', content: '# plan' };
  const goalResult = { goal: { id: 'g1', objective: 'ship', status: 'active' } };
  const goalSnapshot = { id: 'g1', objective: 'ship', status: 'paused' };
  const tasks = [{ taskId: 't1', status: 'running' }];
  const taskInfo = { taskId: 't1', status: 'stopped' };
  const shellResult = { stdout: 'ok', stderr: '', isError: false };
  const mcpServers = [{ name: 'srv', transport: 'stdio', status: 'connected', toolCount: 2 }];
  const skillDefinitions = [
    {
      name: 'write-tui',
      description: 'TUI skill',
      path: '/skills/write-tui',
      source: 'project',
      metadata: { type: 'general', disableModelInvocation: false, isSubSkill: false },
    },
  ];
  const sessionMeta = { id: 'sess-1', version: 2, createdAt: 1, updatedAt: 2, archived: false, agents: {} };
  const addDirResult = { projectRoot: '/work', configPath: '/work/.kimi-code/config.toml', additionalDirs: ['/extra'], persisted: true };

  const makeAgentServices = (id: string) => {
    const bus = makeFakeBus();
    return {
      bus,
      entries: [
        [IEventBus, bus],
        [
          IAgentPromptService,
          {
            enqueue: recordReturning(`${id}.enqueue`, Promise.resolve({})),
            inject: recordReturning(`${id}.inject`, Promise.resolve(undefined)),
          },
        ],
        [
          IAgentRPCService,
          {
            cancel: record(`${id}.cancel`),
            runShellCommand: recordReturning(`${id}.runShellCommand`, shellResult),
            cancelShellCommand: record(`${id}.cancelShellCommand`),
            undoHistory: recordReturning(`${id}.undoHistory`, 2),
            activateSkill: record(`${id}.activateSkill`),
            activatePluginCommand: record(`${id}.activatePluginCommand`),
            setPermission: record(`${id}.setPermission`),
            cancelCompaction: record(`${id}.cancelCompaction`),
            getContext: recordReturning(`${id}.getContext`, { history: [{ role: 'user', content: 'hi' }], tokenCount: 42 }),
          },
        ],
        [
          IAgentProfileService,
          {
            setModel: recordReturning(`${id}.setModel`, Promise.resolve({ model: 'kimi-latest', providerName: 'kimi' })),
            setThinking: record(`${id}.setThinking`),
            getAgentsMdWarning: () => options?.agentsMdWarning,
            getModel: () => 'kimi-latest',
            getModelCapabilities: () => ({ max_context_tokens: 1000 }),
            data: () => ({ cwd: '/work', thinkingLevel: 'high', systemPrompt: 'sp', modelCapabilities: {} }),
          },
        ],
        [
          IAgentPlanService,
          {
            enter: record(`${id}.plan.enter`),
            cancel: record(`${id}.plan.cancel`),
            clear: record(`${id}.plan.clear`),
            status: recordReturning(`${id}.plan.status`, Promise.resolve(planData)),
          },
        ],
        [
          IAgentSwarmService,
          { enter: record(`${id}.swarm.enter`), exit: record(`${id}.swarm.exit`), isActive: false },
        ],
        [IAgentFullCompactionService, { begin: recordReturning(`${id}.compaction.begin`, true) }],
        [
          IAgentGoalService,
          {
            getGoal: recordReturning(`${id}.getGoal`, goalResult),
            createGoal: recordReturning(`${id}.createGoal`, Promise.resolve(goalSnapshot)),
            pauseGoal: recordReturning(`${id}.pauseGoal`, Promise.resolve(goalSnapshot)),
            resumeGoal: recordReturning(`${id}.resumeGoal`, Promise.resolve(goalSnapshot)),
            cancelGoal: recordReturning(`${id}.cancelGoal`, Promise.resolve(goalSnapshot)),
          },
        ],
        [IAgentUsageService, { status: () => usage }],
        [IAgentContextSizeService, { get: () => ({ size: 100 }) }],
        [IAgentPermissionModeService, { mode: 'auto' }],
        [
          IAgentMcpService,
          { initialLoadDurationMs: () => 123, list: () => mcpServers },
        ],
        [
          IAgentTaskService,
          {
            list: recordReturning(`${id}.tasks.list`, tasks),
            readOutput: recordReturning(`${id}.tasks.readOutput`, Promise.resolve('output text')),
            stop: recordReturning(`${id}.tasks.stop`, Promise.resolve(taskInfo)),
            detach: recordReturning(`${id}.tasks.detach`, taskInfo),
          },
        ],
        [IAgentSystemReminderService, { appendSystemReminder: record(`${id}.appendSystemReminder`) }],
      ] as ReadonlyArray<readonly [unknown, unknown]>,
    };
  };

  const mainServices = makeAgentServices('main');
  const btwServices = makeAgentServices('btw-1');
  const mainAgent = { id: 'main', kind: 'agent', accessor: makeAccessor(mainServices.entries) };
  const btwAgent = { id: 'btw-1', kind: 'agent', accessor: makeAccessor(btwServices.entries) };
  const handles = new Map<string, unknown>([
    ['main', mainAgent],
    ['btw-1', btwAgent],
  ]);

  const getHandleCalls: string[] = [];
  const lifecycle = {
    list: () => [mainAgent],
    getHandle: (id: string) => {
      getHandleCalls.push(id);
      return handles.get(id);
    },
    whenReady: async (id: string) => {
      getHandleCalls.push(id);
      return handles.get(id);
    },
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDispose: () => ({ dispose: () => {} }),
  };

  const kernel = makeFakeInteractionKernel(options?.pendingInteractions ?? []);
  const swarmRunCalls: unknown[] = [];
  const sessionSwarm = {
    run: (args: { tasks: readonly unknown[] }) => {
      swarmRunCalls.push(args);
      return Promise.resolve([
        options?.swarmRunStatus === 'failed'
          ? { task: args.tasks[0], status: 'failed', error: 'boom' }
          : { task: args.tasks[0], status: 'completed', result: 'done' },
      ]);
    },
  };

  const session = {
    id: 'sess-1',
    kind: 'session',
    accessor: makeAccessor([
      [IAgentLifecycleService, lifecycle],
      [ISessionCronService, { _serviceBrand: undefined }],
      [ISessionInteractionService, kernel],
      [ISessionApprovalService, { decide: record('approvals.decide') }],
      [ISessionQuestionService, { answer: record('questions.answer'), dismiss: record('questions.dismiss') }],
      [ISessionBtwService, { start: () => Promise.resolve('btw-1') }],
      [ISessionSwarmService, sessionSwarm],
      [ISessionSkillCatalog, { ready: Promise.resolve(), catalog: { listSkills: () => skillDefinitions } }],
      [ISessionInitService, { generateAgentsMd: record('generateAgentsMd'), cancelInit: record('cancelInit') }],
      [ISessionWorkspaceCommandService, { addAdditionalDir: recordReturning('addAdditionalDir', Promise.resolve(addDirResult)) }],
      [ISessionContext, { cwd: '/work' }],
      [ISessionMetadata, { read: () => Promise.resolve(sessionMeta) }],
    ]),
  };

  // App scope: global event bus; the remaining host services are pre-wired fakes.
  const appBus = makeFakeBus();
  const files = new Map<string, string>([['/work/AGENTS.md', 'PROJECT RULES']]);
  const fakeFs = {
    stat: (path: string) => {
      if (!files.has(path)) return Promise.reject(new Error(`ENOENT: ${path}`));
      return Promise.resolve({ isFile: true, isDirectory: false });
    },
    readText: (path: string) => Promise.resolve(files.get(path) ?? ''),
  };
  const app = {
    accessor: makeAccessor([
      [IEventService, appBus],
      [IHostFileSystem, fakeFs],
      [IHostEnvironment, { ready: Promise.resolve(), homeDir: '/os-home' }],
      [IBootstrapService, { homeDir: '/kimi-home' }],
    ]),
  };

  const summary: CoreSessionSummary = {
    id: 'sess-1',
    title: 'Old Title',
    workDir: '/work',
    sessionDir: '/sessions/sess-1',
    createdAt: 1,
    updatedAt: 2,
    archived: false,
    additionalDirs: ['/extra'],
  };

  let onCloseCalls = 0;
  const core = new CoreSession({
    id: 'sess-1',
    handle: session as never,
    app: app as never,
    summary,
    resumeState: options?.resumeState,
    onClose: () => {
      onCloseCalls += 1;
      return Promise.resolve();
    },
  });

  return {
    core,
    calls,
    summary,
    usage,
    planData,
    goalResult,
    goalSnapshot,
    tasks,
    taskInfo,
    shellResult,
    mcpServers,
    sessionMeta,
    addDirResult,
    mainBus: mainServices.bus,
    btwBus: btwServices.bus,
    appBus,
    kernel,
    swarmRunCalls,
    getHandleCalls,
    getOnCloseCalls: () => onCloseCalls,
  };
}

const parts = [{ type: 'text' as const, text: 'hello' }];

/** The ContextMessage the facade builds for a text-only prompt/steer. */
const promptMessage = (content: unknown) => ({
  role: 'user',
  content,
  toolCalls: [],
  origin: { kind: 'user' },
});

describe('CoreSession conversation flow and agent routing', () => {
  it('prompt routes to the main agent prompt service by default', async () => {
    const fx = makeFixture();
    await fx.core.prompt(parts);
    expect(fx.calls['main.enqueue']).toEqual([[{ message: promptMessage(parts) }]]);
    // ensureMainAgent resolves main through the lifecycle's existing handle.
    expect(fx.getHandleCalls).toContain('main');
  });

  it('prompt with an explicit agentId routes to that agent', async () => {
    const fx = makeFixture();
    await fx.core.prompt(parts, { agentId: 'btw-1' });
    expect(fx.calls['btw-1.enqueue']).toEqual([[{ message: promptMessage(parts) }]]);
    expect(fx.calls['main.enqueue']).toBeUndefined();
  });

  it('prompt with an unknown agentId rejects with AGENT_NOT_FOUND', async () => {
    const fx = makeFixture();
    const error = await fx.core.prompt(parts, { agentId: 'ghost' }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(isCoreError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(CoreErrorCodes.AGENT_NOT_FOUND);
  });

  it('steer/cancel/shell/undo/skill/plugin-command/permission/compaction-cancel forward to the RPC facade', async () => {
    const fx = makeFixture();
    await fx.core.steer(parts);
    await fx.core.cancel();
    const shell = await fx.core.runShellCommand('ls', { commandId: 'c1' });
    await fx.core.cancelShellCommand('c1');
    const undone = await fx.core.undoHistory(2);
    await fx.core.activateSkill({ name: 'write-tui', args: 'now' });
    await fx.core.activatePluginCommand({ pluginId: 'p1', commandName: 'cmd', args: 'a' });
    await fx.core.setPermission('auto');
    await fx.core.cancelCompaction();

    expect(fx.calls['main.inject']).toEqual([[promptMessage(parts)]]);
    expect(fx.calls['cancelInit']).toEqual([[]]);
    expect(fx.calls['main.cancel']).toEqual([[{}]]);
    expect(fx.calls['main.runShellCommand']).toEqual([[{ command: 'ls', commandId: 'c1' }]]);
    expect(shell).toEqual(fx.shellResult);
    expect(fx.calls['main.cancelShellCommand']).toEqual([[{ commandId: 'c1' }]]);
    expect(fx.calls['main.undoHistory']).toEqual([[{ count: 2 }]]);
    expect(undone).toBe(2);
    expect(fx.calls['main.activateSkill']).toEqual([[{ name: 'write-tui', args: 'now' }]]);
    expect(fx.calls['main.activatePluginCommand']).toEqual([[{ pluginId: 'p1', commandName: 'cmd', args: 'a' }]]);
    expect(fx.calls['main.setPermission']).toEqual([[{ mode: 'auto' }]]);
    expect(fx.calls['main.cancelCompaction']).toEqual([[{}]]);
  });
});

describe('CoreSession modes', () => {
  it('setModel/setThinking forward to the profile service', async () => {
    const fx = makeFixture();
    const result = await fx.core.setModel('kimi-latest');
    await fx.core.setThinking('high');
    expect(fx.calls['main.setModel']).toEqual([['kimi-latest']]);
    expect(result).toEqual({ model: 'kimi-latest', providerName: 'kimi' });
    expect(fx.calls['main.setThinking']).toEqual([['high']]);
  });

  it('setPlanMode enters/cancels plan mode and plan queries forward', async () => {
    const fx = makeFixture();
    await fx.core.setPlanMode(true);
    await fx.core.setPlanMode(false);
    const plan = await fx.core.getPlan();
    await fx.core.clearPlan();
    expect(fx.calls['main.plan.enter']).toEqual([[]]);
    expect(fx.calls['main.plan.cancel']).toEqual([[]]);
    expect(plan).toEqual(fx.planData);
    expect(fx.calls['main.plan.clear']).toEqual([[]]);
  });

  it('setSwarmMode enters with the trigger (default manual) and exits', async () => {
    const fx = makeFixture();
    await fx.core.setSwarmMode(true);
    await fx.core.setSwarmMode(true, { trigger: 'task' });
    await fx.core.setSwarmMode(false);
    expect(fx.calls['main.swarm.enter']).toEqual([['manual'], ['task']]);
    expect(fx.calls['main.swarm.exit']).toEqual([[]]);
  });

  it('compact begins a manual full compaction with the instruction', async () => {
    const fx = makeFixture();
    await fx.core.compact('keep decisions');
    expect(fx.calls['main.compaction.begin']).toEqual([[{ source: 'manual', instruction: 'keep decisions' }]]);
  });
});

describe('CoreSession queries', () => {
  it('getStatus aggregates the main agent native services with usage', async () => {
    const fx = makeFixture();
    const status = await fx.core.getStatus();
    expect(status).toEqual({
      model: 'kimi-latest',
      thinkingEffort: 'high',
      permission: 'auto',
      planMode: true,
      swarmMode: false,
      contextTokens: 100,
      maxContextTokens: 1000,
      contextUsage: 0.1,
      usage: fx.usage,
    });
  });

  it('getContext returns the agent history and getUsage the usage snapshot', async () => {
    const fx = makeFixture();
    expect(await fx.core.getContext()).toEqual([{ role: 'user', content: 'hi' }]);
    expect(await fx.core.getUsage()).toEqual(fx.usage);
  });

  it('getSessionWarnings projects the AGENTS.md size warning when present', async () => {
    const warned = makeFixture({ agentsMdWarning: 'AGENTS.md too large' });
    expect(await warned.core.getSessionWarnings()).toEqual([
      { code: 'agents-md-oversized', message: 'AGENTS.md too large', severity: 'warning' },
    ]);
    const clean = makeFixture();
    expect(await clean.core.getSessionWarnings()).toEqual([]);
  });

  it('exposes MCP metrics/list, skills, metadata and workDir/summary', async () => {
    const fx = makeFixture();
    expect(await fx.core.getMcpStartupMetrics()).toEqual({ durationMs: 123 });
    expect(await fx.core.listMcpServers()).toEqual(fx.mcpServers);
    expect(await fx.core.listSkills()).toEqual([
      {
        name: 'write-tui',
        description: 'TUI skill',
        path: '/skills/write-tui',
        source: 'project',
        type: 'general',
        disableModelInvocation: false,
        isSubSkill: false,
      },
    ]);
    expect(await fx.core.getSessionMetadata()).toEqual(fx.sessionMeta);
    expect(fx.core.workDir).toBe('/work');
    expect(fx.core.summary).toEqual(fx.summary);
  });

  it('getResumeState returns the harness-injected snapshot', () => {
    const resumeState = { sessionMetadata: {}, agents: {} } as never;
    expect(makeFixture({ resumeState }).core.getResumeState()).toBe(resumeState);
    expect(makeFixture().core.getResumeState()).toBeUndefined();
  });

  it('summary follows session.meta.updated events for this session', () => {
    const fx = makeFixture();
    fx.appBus.publish({
      type: 'session.meta.updated',
      payload: { sessionId: 'sess-1', agentId: 'main', title: 'New Title', patch: { title: 'New Title', lastPrompt: 'hi' } },
    });
    expect(fx.core.summary.title).toBe('New Title');
    expect(fx.core.summary.lastPrompt).toBe('hi');
    // Unrelated sessions leave the snapshot untouched.
    fx.appBus.publish({
      type: 'session.meta.updated',
      payload: { sessionId: 'other', title: 'X', patch: { title: 'X' } },
    });
    expect(fx.core.summary.title).toBe('New Title');
  });
});

describe('CoreSession goal and background tasks', () => {
  it('getGoal forwards and mutators wrap snapshots into GoalToolResult', async () => {
    const fx = makeFixture();
    expect(await fx.core.getGoal()).toEqual(fx.goalResult);
    expect(await fx.core.createGoal({ objective: 'ship' })).toEqual({ goal: fx.goalSnapshot });
    expect(await fx.core.pauseGoal()).toEqual({ goal: fx.goalSnapshot });
    expect(await fx.core.resumeGoal()).toEqual({ goal: fx.goalSnapshot });
    expect(await fx.core.cancelGoal()).toEqual({ goal: fx.goalSnapshot });
    expect(fx.calls['main.createGoal']).toEqual([[{ objective: 'ship' }]]);
    expect(fx.calls['main.pauseGoal']).toEqual([[]]);
  });

  it('task list/output/stop/detach forward to the agent task service', async () => {
    const fx = makeFixture();
    expect(await fx.core.listBackgroundTasks()).toEqual(fx.tasks);
    expect(await fx.core.listBackgroundTasks({ activeOnly: false, limit: 5 })).toEqual(fx.tasks);
    expect(await fx.core.getBackgroundTaskOutput('t1', { tail: 100 })).toBe('output text');
    expect(await fx.core.stopBackgroundTask('t1', 'user stop')).toEqual(fx.taskInfo);
    expect(await fx.core.detachBackgroundTask('t1')).toEqual(fx.taskInfo);
    expect(fx.calls['main.tasks.list']).toEqual([
      [undefined, undefined],
      [false, 5],
    ]);
    expect(fx.calls['main.tasks.readOutput']).toEqual([['t1', 100]]);
    expect(fx.calls['main.tasks.stop']).toEqual([['t1', 'user stop']]);
    expect(fx.calls['main.tasks.detach']).toEqual([['t1']]);
  });

  it('routes task queries to an explicit agent', async () => {
    const fx = makeFixture();
    await fx.core.listBackgroundTasks({ agentId: 'btw-1' });
    expect(fx.calls['btw-1.tasks.list']).toEqual([[undefined, undefined]]);
    expect(fx.calls['main.tasks.list']).toBeUndefined();
  });
});

describe('CoreSession orchestration', () => {
  it('startBtw returns the side-question agent id', async () => {
    const fx = makeFixture();
    expect(await fx.core.startBtw()).toBe('btw-1');
  });

  it('addAdditionalDir forwards to the workspace command service', async () => {
    const fx = makeFixture();
    expect(await fx.core.addAdditionalDir({ path: '/extra', persist: true })).toEqual(fx.addDirResult);
    expect(fx.calls['addAdditionalDir']).toEqual([[{ path: '/extra', persist: true }]]);
  });

  it('generateAgentsMd forwards to the session init service', async () => {
    const fx = makeFixture();
    await fx.core.generateAgentsMd();
    expect(fx.calls['generateAgentsMd']).toEqual([[]]);
  });
});

describe('CoreSession events and close', () => {
  it('fans events out to every listener and honors unsubscribe', () => {
    const fx = makeFixture();
    const first: SessionEvent[] = [];
    const second: SessionEvent[] = [];
    const offFirst = fx.core.onEvent((e) => first.push(e));
    fx.core.onEvent((e) => second.push(e));

    fx.mainBus.publish({ type: 'turn.started', turnId: 1 });
    expect(first).toEqual([{ type: 'turn.started', turnId: 1, agentId: 'main', sessionId: 'sess-1' }]);
    expect(second).toEqual(first);

    offFirst();
    fx.mainBus.publish({ type: 'turn.ended', turnId: 1 });
    expect(first).toHaveLength(1);
    expect(second).toHaveLength(2);
  });

  it('close is idempotent and detaches the event pipeline', async () => {
    const fx = makeFixture();
    const seen: SessionEvent[] = [];
    fx.core.onEvent((e) => seen.push(e));

    await fx.core.close();
    await fx.core.close();
    expect(fx.getOnCloseCalls()).toBe(1);

    fx.mainBus.publish({ type: 'turn.started', turnId: 2 });
    expect(seen).toHaveLength(0);
  });
});

describe('CoreSession interactions', () => {
  const pendingInteractions: FakeInteraction[] = [
    {
      id: 'a1',
      kind: 'approval',
      payload: { toolName: 'Bash', action: 'run', display: {}, agentId: 'payload-agent' },
      origin: { agentId: 'origin-agent' },
      createdAt: 1,
    },
    {
      id: 'a2',
      kind: 'approval',
      payload: { toolName: 'Edit', action: 'edit', display: {}, agentId: 'payload-agent' },
      origin: {},
      createdAt: 2,
    },
    {
      id: 'a3',
      kind: 'approval',
      payload: { toolName: 'Read', action: 'read', display: {} },
      origin: {},
      createdAt: 3,
    },
    {
      id: 'q1',
      kind: 'question',
      payload: { questions: [{ question: 'Which?', options: [] }] },
      origin: { agentId: 'asker' },
      createdAt: 4,
    },
    {
      id: 'q2',
      kind: 'question',
      payload: { questions: [{ question: 'Sure?', options: [] }] },
      origin: {},
      createdAt: 5,
    },
  ];

  it('approvals.list projects id, agentId fallback chain and the raw request', () => {
    const fx = makeFixture({ pendingInteractions });
    expect(fx.core.approvals.list()).toEqual([
      { id: 'a1', agentId: 'origin-agent', request: pendingInteractions[0]!.payload },
      { id: 'a2', agentId: 'payload-agent', request: pendingInteractions[1]!.payload },
      { id: 'a3', agentId: 'main', request: pendingInteractions[2]!.payload },
    ]);
  });

  it('questions.list projects only question interactions with the origin fallback', () => {
    const fx = makeFixture({ pendingInteractions });
    expect(fx.core.questions.list()).toEqual([
      { id: 'q1', agentId: 'asker', request: pendingInteractions[3]!.payload },
      { id: 'q2', agentId: 'main', request: pendingInteractions[4]!.payload },
    ]);
  });

  it('decide/answer/dismiss write through to the session brokers', () => {
    const fx = makeFixture({ pendingInteractions });
    fx.core.approvals.decide('a1', { decision: 'approved' });
    fx.core.questions.answer('q1', { item0: 'yes' });
    fx.core.questions.dismiss('q2');
    expect(fx.calls['approvals.decide']).toEqual([['a1', { decision: 'approved' }]]);
    expect(fx.calls['questions.answer']).toEqual([['q1', { item0: 'yes' }]]);
    expect(fx.calls['questions.dismiss']).toEqual([['q2']]);
  });

  it('onDidChangePending and onDidResolve subscribe to the kernel and unsubscribe cleanly', () => {
    const fx = makeFixture({ pendingInteractions });
    let changes = 0;
    const resolved: string[] = [];
    const offChange = fx.core.approvals.onDidChangePending(() => { changes += 1; });
    const offResolve = fx.core.questions.onDidResolve((id) => resolved.push(id));

    fx.kernel._fireChange();
    fx.kernel._fireResolve('q1', { item0: 'yes' });
    expect(changes).toBe(1);
    expect(resolved).toEqual(['q1']);

    offChange();
    offResolve();
    fx.kernel._fireChange();
    fx.kernel._fireResolve('q2', null);
    expect(changes).toBe(1);
    expect(resolved).toEqual(['q1']);
  });
});
