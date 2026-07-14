// Uses fake scope handles shaped like the minimal v2 interface subset;
// does not bootstrap the real engine. Services are dispatched by the real
// service identifier objects so the implementation must ask for the exact
// tokens it documents.
import { describe, expect, it } from 'vitest';
import {
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentContextSizeService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentSwarmService,
  IAgentTaskService,
  IAgentToolRegistryService,
  IAgentUsageService,
  IAgentWireRecordService,
  ISessionMetadata,
  ISessionTodoService,
} from '@moonshot-ai/agent-core-v2';
import { buildResumedAgents, buildResumedSessionState } from '../../src/core/replay';

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

function makeFixture(metaOverrides?: Record<string, unknown>) {
  const history = [
    { role: 'user', content: [{ type: 'text', text: 'hello' }] },
    { role: 'assistant', content: [{ type: 'text', text: 'hi there' }] },
  ];
  // Wire log: the two live messages plus one pre-compaction exchange that the
  // folded context no longer carries. The transcript fold must recover all
  // of it, with a compaction card in between.
  const wireRecords = [
    {
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'before compaction' }], toolCalls: [] },
      time: 1,
    },
    {
      type: 'context.apply_compaction',
      summary: 'Compacted summary.',
      compactedCount: 1,
      tokensBefore: 500,
      tokensAfter: 120,
      time: 2,
    },
    {
      type: 'context.append_message',
      message: { role: 'user', content: [{ type: 'text', text: 'hello' }], toolCalls: [] },
      time: 3,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'step.begin', uuid: 's1' },
      time: 4,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'content.part', stepUuid: 's1', part: { type: 'text', text: 'hi there' } },
      time: 5,
    },
    {
      type: 'context.append_loop_event',
      event: { type: 'step.end', uuid: 's1' },
      time: 6,
    },
  ];
  const profileData = {
    cwd: '/work/dir',
    modelAlias: 'kimi-latest',
    modelCapabilities: { imageInput: true },
    profileName: 'agent',
    thinkingLevel: 'high',
    systemPrompt: 'be helpful',
  };
  const rules = [{ decision: 'allow', scope: 'session-runtime', pattern: 'Bash(ls *)' }];
  const plan = { id: 'plan-1', content: '# plan', path: '/tmp/plan.md' };
  const usage = { total: { inputTokens: 12, outputTokens: 34 } };
  const toolInfos = [
    { name: 'Bash', description: 'run commands', source: 'builtin' },
    { name: 'WebSearch', description: 'search the web', source: 'mcp' },
  ];
  const tasks = [{ taskId: 'task-1', status: 'running' }];
  const todos = [{ title: 'write tests', status: 'in_progress' }];
  const meta = {
    id: 'sess-1',
    version: 2,
    createdAt: Date.UTC(2024, 0, 2, 3, 4, 5), // 2024-01-02T03:04:05.000Z
    updatedAt: Date.UTC(2024, 0, 2, 3, 4, 6, 789), // 2024-01-02T03:04:06.789Z
    archived: false,
    agents: {
      main: { homedir: '/homes/main' },
      'sub-legacy': {
        homedir: '/homes/sub-legacy',
        type: 'sub',
        parentAgentId: 'main',
        swarmItem: 'legacy-item',
      },
      'sub-labels': {
        homedir: '/homes/sub-labels',
        labels: { parentAgentId: 'labels-parent', swarmItem: 'labels-item' },
        parentAgentId: 'legacy-parent',
        swarmItem: 'legacy-item',
      },
    },
    ...metaOverrides,
  };

  const isToolActiveCalls: Array<readonly [string, unknown]> = [];
  const taskListCalls: unknown[] = [];

  const mainAgent = {
    id: 'main',
    accessor: makeAccessor([
      [IAgentContextMemoryService, { get: () => history }],
      [IAgentContextSizeService, { get: () => ({ size: 1234, measured: 1000, estimated: 234 }) }],
      [
        IAgentProfileService,
        {
          data: () => profileData,
          isToolActive: (name: string, source?: unknown) => {
            isToolActiveCalls.push([name, source]);
            return name === 'Bash';
          },
        },
      ],
      [IAgentPermissionModeService, { mode: 'manual' }],
      [IAgentPermissionRulesService, { rules }],
      [IAgentPlanService, { status: async () => plan }],
      [IAgentSwarmService, { isActive: true }],
      [IAgentUsageService, { status: () => usage }],
      [IAgentToolRegistryService, { list: () => toolInfos }],
      [IAgentWireRecordService, { getRecords: () => wireRecords }],
      [IAgentBlobService, { loadParts: async (parts: readonly unknown[]) => parts }],
      [
        IAgentTaskService,
        {
          list: (activeOnly?: boolean) => {
            taskListCalls.push(activeOnly);
            return tasks;
          },
        },
      ],
    ]),
  };
  const session = {
    id: 'sess-1',
    accessor: makeAccessor([
      [ISessionTodoService, { getTodos: () => todos }],
      [ISessionMetadata, { read: async () => meta }],
    ]),
  };
  return {
    history,
    wireRecords,
    profileData,
    rules,
    plan,
    usage,
    toolInfos,
    tasks,
    todos,
    meta,
    mainAgent,
    session,
    isToolActiveCalls,
    taskListCalls,
  };
}

describe('buildResumedAgents', () => {
  it('returns a single main entry whose replay folds the full wire log', async () => {
    const fx = makeFixture();
    const agents = await buildResumedAgents(fx.session as never, fx.mainAgent as never);

    expect(Object.keys(agents)).toEqual(['main']);
    const main = agents['main']!;
    expect(main.type).toBe('main');
    // The replay recovers the pre-compaction message and the compaction card
    // from the wire log; `time` stays 0 (records carry no readable envelope
    // timestamp) and the TUI renders by position.
    expect(main.replay).toEqual([
      {
        time: 0,
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'before compaction' }],
          toolCalls: [],
          toolCallId: undefined,
          isError: undefined,
          origin: undefined,
        },
      },
      {
        time: 0,
        type: 'compaction',
        result: {
          summary: 'Compacted summary.',
          compactedCount: 1,
          tokensBefore: 500,
          tokensAfter: 120,
        },
        instruction: undefined,
      },
      {
        time: 0,
        type: 'message',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'hello' }],
          toolCalls: [],
          toolCallId: undefined,
          isError: undefined,
          origin: undefined,
        },
      },
      {
        time: 0,
        type: 'message',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'hi there' }],
          toolCalls: [],
          toolCallId: undefined,
          isError: undefined,
          origin: undefined,
        },
      },
    ]);
    // The model-facing context view is unaffected: still the folded history.
    expect(main.context).toEqual({ history: fx.history, tokenCount: 1234 });
  });

  it('maps profile data to config, renaming thinkingLevel and pinning provider undefined', async () => {
    const fx = makeFixture();
    const agents = await buildResumedAgents(fx.session as never, fx.mainAgent as never);

    const config = agents['main']!.config;
    expect(config.thinkingEffort).toBe('high');
    expect('thinkingLevel' in config).toBe(false);
    // v2 has no per-agent provider config DTO.
    expect(config.provider).toBeUndefined();
    expect(config).toEqual({
      cwd: '/work/dir',
      provider: undefined,
      modelAlias: 'kimi-latest',
      modelCapabilities: { imageInput: true },
      profileName: 'agent',
      thinkingEffort: 'high',
      systemPrompt: 'be helpful',
    });
  });

  it('reads permission, plan, swarm, usage and background through their services', async () => {
    const fx = makeFixture();
    const agents = await buildResumedAgents(fx.session as never, fx.mainAgent as never);

    const main = agents['main']!;
    expect(main.permission).toEqual({ mode: 'manual', rules: fx.rules });
    expect(main.plan).toEqual(fx.plan);
    expect(main.swarmMode).toBe(true);
    expect(main.usage).toEqual(fx.usage);
    expect(main.background).toEqual(fx.tasks);
    // Background must include finished tasks: list(activeOnly = false).
    expect(fx.taskListCalls).toEqual([false]);
  });

  it('marks each registry tool active via profile.isToolActive(name, source)', async () => {
    const fx = makeFixture();
    const agents = await buildResumedAgents(fx.session as never, fx.mainAgent as never);

    expect(agents['main']!.tools).toEqual([
      { name: 'Bash', description: 'run commands', source: 'builtin', active: true },
      { name: 'WebSearch', description: 'search the web', source: 'mcp', active: false },
    ]);
    expect(fx.isToolActiveCalls).toEqual([
      ['Bash', 'builtin'],
      ['WebSearch', 'mcp'],
    ]);
  });

  it('fills toolStore.todo from the session todo service', async () => {
    const fx = makeFixture();
    const agents = await buildResumedAgents(fx.session as never, fx.mainAgent as never);

    expect(agents['main']!.toolStore).toEqual({ todo: fx.todos });
  });
});

describe('buildResumedSessionState', () => {
  it('projects session metadata with ISO timestamps, defaults, and agent fallbacks', async () => {
    const fx = makeFixture();
    const state = await buildResumedSessionState(fx.session as never, fx.mainAgent as never);

    expect(Object.keys(state.agents)).toEqual(['main']);
    expect(state.agents['main']!.type).toBe('main');
    expect(state.warning).toBeUndefined();

    const metadata = state.sessionMetadata;
    expect(metadata.createdAt).toBe('2024-01-02T03:04:05.000Z');
    expect(metadata.updatedAt).toBe('2024-01-02T03:04:06.789Z');
    // Absent in the v2 document -> projected defaults.
    expect(metadata.title).toBe('');
    expect(metadata.isCustomTitle).toBe(false);

    expect(metadata.agents).toEqual({
      // No type/parent recorded: main falls back by id, parent to null.
      main: { homedir: '/homes/main', type: 'main', parentAgentId: null, swarmItem: undefined },
      // Legacy bare fields are used when labels are absent.
      'sub-legacy': {
        homedir: '/homes/sub-legacy',
        type: 'sub',
        parentAgentId: 'main',
        swarmItem: 'legacy-item',
      },
      // labels take precedence over the legacy bare fields; missing type on a
      // non-main id falls back to 'sub'.
      'sub-labels': {
        homedir: '/homes/sub-labels',
        type: 'sub',
        parentAgentId: 'labels-parent',
        swarmItem: 'labels-item',
      },
    });
  });

  it('passes an explicit title and isCustomTitle through unchanged', async () => {
    const fx = makeFixture({ title: 'My Session', isCustomTitle: true });
    const state = await buildResumedSessionState(fx.session as never, fx.mainAgent as never);

    expect(state.sessionMetadata.title).toBe('My Session');
    expect(state.sessionMetadata.isCustomTitle).toBe(true);
  });
});
