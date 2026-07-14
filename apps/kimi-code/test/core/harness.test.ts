// Uses a fake App scope shaped like the minimal v2 interface subset; does not
// bootstrap the real engine (`createCoreHarness` is covered by the Task 5
// smoke run instead). Services are dispatched by the real service identifier
// objects (same accessor pattern as session.test.ts), so the harness must ask
// for the exact tokens it documents. `ensureMainAgent` is exercised through
// its "already exists" branch: each fake session lifecycle's `getHandle('main')`
// returns that session's fake main handle.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import {
  IAgentBlobService,
  IAgentContextMemoryService,
  IAgentContextSizeService,
  IAgentLifecycleService,
  IAgentPermissionModeService,
  IAgentPermissionRulesService,
  IAgentPlanService,
  IAgentProfileService,
  IAgentSwarmService,
  IAgentTaskService,
  IAgentToolRegistryService,
  IAgentUsageService,
  IAgentWireRecordService,
  IBootstrapService,
  IBuiltinSkillSource,
  IConfigService,
  IEventBus,
  IEventService,
  IFlagService,
  IModelResolver,
  IPluginService,
  IProviderService,
  ISessionActivity,
  ISessionApprovalService,
  ISessionContext,
  ISessionCronService,
  ISessionExportService,
  ISessionIndex,
  ISessionInteractionService,
  ISessionLifecycleService,
  ISessionMetadata,
  ISessionQuestionService,
  ISessionTodoService,
  ISessionWorkspaceContext,
  ISkillCatalogRuntimeOptions,
  ISkillDiscovery,
  IUserFileSkillSource,
  IWorkspaceRegistry,
} from '@moonshot-ai/agent-core-v2';
import { CoreErrorCodes, isCoreError } from '../../src/core/errors';
import { CoreHarness } from '../../src/core/harness';
import type { SessionEvent, TelemetryProperties } from '../../src/core/types';

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
    count: () => listeners.size,
  };
}

function makeFakeInteractionKernel() {
  return {
    listPending: () => [],
    onDidChangePending: () => ({ dispose: () => {} }),
    onDidResolve: () => ({ dispose: () => {} }),
  };
}

interface TrackedEvent {
  readonly event: string;
  readonly properties: TelemetryProperties | undefined;
  readonly context: Record<string, string | null> | undefined;
}

function makeFixture(options?: {
  configPath?: string;
  activityStatus?: 'idle' | 'running';
  setModelError?: Error;
  planEnterError?: Error;
  closeSessionError?: Error;
  disposeError?: Error;
  resolverError?: Error;
  explicitSkillDirs?: readonly string[];
}) {
  const calls: Record<string, unknown[]> = {};
  const order: string[] = [];
  const record = (name: string) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    order.push(name);
  };
  const recordReturning = <T,>(name: string, value: T) => (...args: unknown[]) => {
    (calls[name] ??= []).push(args);
    order.push(name);
    return value;
  };

  const telemetryEvents: TrackedEvent[] = [];
  const contextPatches: Array<Record<string, string | null>> = [];
  const telemetry = {
    track: (event: string, properties?: TelemetryProperties) => {
      telemetryEvents.push({ event, properties, context: undefined });
    },
    setContext: (patch: Record<string, string | null>) => {
      contextPatches.push(patch);
    },
    withContext: (patch: Record<string, string | null>) => ({
      track: (event: string, properties?: TelemetryProperties) => {
        telemetryEvents.push({ event, properties, context: patch });
      },
    }),
  };

  const usage = { total: { inputTokens: 1, outputTokens: 2 } };
  const planData = { id: 'plan-1', content: '# plan' };

  const makeAgentServices = (sid: string) => {
    const bus = makeFakeBus();
    const setModel = (...args: unknown[]) => {
      (calls[`${sid}.setModel`] ??= []).push(args);
      order.push(`${sid}.setModel`);
      if (options?.setModelError !== undefined) return Promise.reject(options.setModelError);
      return Promise.resolve({ model: 'kimi-latest', providerName: 'kimi' });
    };
    return {
      bus,
      entries: [
        [IEventBus, bus],
        [
          IAgentProfileService,
          {
            setModel,
            setThinking: record(`${sid}.setThinking`),
            data: () => ({
              cwd: '/work',
              modelAlias: 'kimi-latest',
              modelCapabilities: {},
              thinkingLevel: 'high',
              systemPrompt: 'sp',
            }),
            isToolActive: () => true,
          },
        ],
        [IAgentPermissionModeService, { mode: 'auto', setMode: record(`${sid}.setMode`) }],
        [
          IAgentPlanService,
          {
            enter: (...args: unknown[]) => {
              (calls[`${sid}.plan.enter`] ??= []).push(args);
              order.push(`${sid}.plan.enter`);
              if (options?.planEnterError !== undefined) return Promise.reject(options.planEnterError);
              return Promise.resolve();
            },
            cancel: record(`${sid}.plan.cancel`),
            status: () => Promise.resolve(planData),
          },
        ],
        [IAgentContextMemoryService, { get: () => [] }],
        [IAgentContextSizeService, { get: () => ({ size: 42 }) }],
        [IAgentPermissionRulesService, { rules: [] }],
        [IAgentSwarmService, { isActive: false }],
        [IAgentUsageService, { status: () => usage }],
        [IAgentToolRegistryService, { list: () => [] }],
        [IAgentTaskService, { list: () => [] }],
        [IAgentWireRecordService, { getRecords: () => [] }],
        [IAgentBlobService, { loadParts: async (parts: readonly unknown[]) => parts }],
      ] as ReadonlyArray<readonly [unknown, unknown]>,
    };
  };

  const makeSessionHandle = (sid: string, workDir: string) => {
    const agent = makeAgentServices(sid);
    const main = { id: 'main', kind: 'agent', accessor: makeAccessor(agent.entries) };
    const lifecycleAgents = {
      list: () => [main],
      getHandle: (id: string) => (id === 'main' ? main : undefined),
      whenReady: async (id: string) => (id === 'main' ? main : undefined),
      onDidCreate: () => ({ dispose: () => {} }),
      onDidDispose: () => ({ dispose: () => {} }),
    };
    const meta = {
      id: sid,
      version: 2,
      title: 'Old Title',
      lastPrompt: 'last words',
      createdAt: 100,
      updatedAt: 200,
      archived: false,
      cwd: workDir,
      custom: { origin: 'test' },
      agents: { main: { homedir: `/homes/${sid}/main` } },
    };
    return {
      id: sid,
      kind: 'session',
      accessor: makeAccessor([
        [IAgentLifecycleService, lifecycleAgents],
        [ISessionCronService, { _serviceBrand: undefined }],
        [ISessionInteractionService, makeFakeInteractionKernel()],
        [ISessionApprovalService, { decide: () => {} }],
        [ISessionQuestionService, { answer: () => {}, dismiss: () => {} }],
        [ISessionContext, { sessionId: sid, workspaceId: 'ws-1', sessionDir: `/sessions/ws-1/${sid}`, cwd: workDir }],
        [
          ISessionMetadata,
          {
            read: () => Promise.resolve(meta),
            setTitle: record(`${sid}.setTitle`),
            update: record(`${sid}.meta.update`),
          },
        ],
        [
          ISessionWorkspaceContext,
          { workDir, additionalDirs: ['/extra'], addAdditionalDir: record(`${sid}.addAdditionalDir`) },
        ],
        [ISessionActivity, { status: () => options?.activityStatus ?? 'idle' }],
        [ISessionTodoService, { getTodos: () => [] }],
      ]),
    };
  };

  // App scope: lifecycle owns fake session handles; `resume` only knows the
  // ids this fixture created (mirrors the persisted index).
  const persisted = new Set<string>();
  const lifecycle = {
    create: (opts: { sessionId: string; workDir: string }) => {
      (calls['lifecycle.create'] ??= []).push([opts]);
      order.push('lifecycle.create');
      persisted.add(opts.sessionId);
      return Promise.resolve(makeSessionHandle(opts.sessionId, opts.workDir));
    },
    resume: (id: string) => {
      (calls['lifecycle.resume'] ??= []).push([id]);
      order.push('lifecycle.resume');
      if (!persisted.has(id)) return Promise.resolve(undefined);
      return Promise.resolve(makeSessionHandle(id, '/work'));
    },
    fork: (opts: { sourceSessionId: string; newSessionId?: string; title?: string }) => {
      (calls['lifecycle.fork'] ??= []).push([opts]);
      order.push('lifecycle.fork');
      const id = opts.newSessionId ?? 'fork-generated';
      persisted.add(id);
      return Promise.resolve(makeSessionHandle(id, '/work'));
    },
    close: (id: string) => {
      (calls['lifecycle.close'] ??= []).push([id]);
      order.push('lifecycle.close');
      if (options?.closeSessionError !== undefined) return Promise.reject(options.closeSessionError);
      return Promise.resolve();
    },
  };

  const configAll = { defaultModel: 'kimi-latest', providers: { kimi: {} } };
  const configValues: Record<string, unknown> = {
    defaultModel: 'kimi-latest',
    defaultPermissionMode: 'auto',
    defaultPlanMode: true,
    thinking: { enabled: true, effort: 'high' },
  };
  const resolverModel = {
    capabilities: { max_context_tokens: 200_000 },
    alwaysThinking: false,
    supportEfforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  };
  const diagnostics = [{ severity: 'warning' as const, message: 'unknown key' }];
  const flags = [{ id: 'my-flag', enabled: true }];
  const pluginInfo = { id: 'known', name: 'Known Plugin', enabled: true };
  const pluginSummaries = [{ id: 'known', name: 'Known Plugin', enabled: true }];
  const pluginCommands = [{ pluginId: 'known', name: 'cmd' }];
  const reloadSummary = { loaded: 1, failed: 0 };
  const exportResult = {
    zipPath: '/tmp/out.zip',
    entries: ['manifest.json'],
    sessionDir: '/sessions/ws-1/sess-1',
    manifest: { sessionId: 'sess-1' },
  };
  const indexItems = [
    {
      id: 'sess-a',
      workspaceId: 'ws-1',
      cwd: '/work',
      title: 'A',
      lastPrompt: 'p',
      createdAt: 1,
      updatedAt: 2,
      archived: false,
      custom: { k: 'v' },
    },
    {
      id: 'sess-b',
      workspaceId: 'ws-2',
      createdAt: 3,
      updatedAt: 4,
      archived: true,
    },
  ];

  const skillDef = (name: string, source: string, description: string) => ({
    name,
    description,
    path: `/skills/${name}/SKILL.md`,
    dir: `/skills/${name}`,
    content: '',
    metadata: { type: 'general', disableModelInvocation: false, isSubSkill: false },
    source,
  });
  const builtinSkills = [skillDef('dup', 'builtin', 'builtin dup'), skillDef('builtin-only', 'builtin', 'b')];
  const userSkills = [skillDef('user-only', 'user', 'u')];
  const workspaceSkills = [skillDef('dup', 'project', 'workspace dup wins')];

  let disposeCalls = 0;
  const appEventBus = makeFakeBus();
  const app = {
    accessor: makeAccessor([
      [IEventService, appEventBus],
      [IWorkspaceRegistry, {
        createOrTouch: recordReturning(
          'registry.createOrTouch',
          Promise.resolve({ id: 'ws-1', root: '/work', name: 'work', createdAt: 1, lastOpenedAt: 2 }),
        ),
      }],
      [ISessionLifecycleService, lifecycle],
      [ISessionIndex, { list: recordReturning('index.list', Promise.resolve({ items: indexItems })) }],
      [IBootstrapService, { sessionDir: (ws: string, id: string) => `/sessions/${ws}/${id}` }],
      [
        IConfigService,
        {
          ready: Promise.resolve(),
          reload: recordReturning('config.reload', Promise.resolve()),
          getAll: recordReturning('config.getAll', configAll),
          get: (domain: string) => configValues[domain],
          set: recordReturning('config.set', Promise.resolve()),
          diagnostics: () => diagnostics,
        },
      ],
      [
        IModelResolver,
        {
          resolve: (...args: unknown[]) => {
            (calls['resolver.resolve'] ??= []).push(args);
            if (options?.resolverError !== undefined) throw options.resolverError;
            return resolverModel;
          },
        },
      ],
      [IProviderService, { delete: recordReturning('provider.delete', Promise.resolve()) }],
      [IFlagService, { explainAll: () => flags }],
      [IBuiltinSkillSource, { load: recordReturning('skills.builtin', Promise.resolve({ skills: builtinSkills })) }],
      [IUserFileSkillSource, { load: recordReturning('skills.user', Promise.resolve({ skills: userSkills })) }],
      [
        ISkillDiscovery,
        { discover: recordReturning('skills.discover', Promise.resolve({ skills: workspaceSkills })) },
      ],
      [ISkillCatalogRuntimeOptions, { explicitDirs: options?.explicitSkillDirs }],
      [ISessionExportService, { export: recordReturning('export.export', Promise.resolve(exportResult)) }],
      [
        IPluginService,
        {
          listPlugins: recordReturning('plugins.list', Promise.resolve(pluginSummaries)),
          installPlugin: recordReturning('plugins.install', Promise.resolve(pluginSummaries[0])),
          setPluginEnabled: recordReturning('plugins.setEnabled', Promise.resolve()),
          setPluginMcpServerEnabled: recordReturning('plugins.setMcpServerEnabled', Promise.resolve()),
          removePlugin: recordReturning('plugins.remove', Promise.resolve()),
          reloadPlugins: recordReturning('plugins.reload', Promise.resolve(reloadSummary)),
          getPluginInfo: (input: { id: string }) => {
            (calls['plugins.getInfo'] ??= []).push([input]);
            order.push('plugins.getInfo');
            return Promise.resolve(input.id === 'known' ? pluginInfo : undefined);
          },
          listPluginCommands: recordReturning('plugins.listCommands', Promise.resolve(pluginCommands)),
        },
      ],
    ]),
    dispose: () => {
      disposeCalls += 1;
      if (options?.disposeError !== undefined) throw options.disposeError;
    },
  };

  const harness = new CoreHarness({
    app: app as never,
    homeDir: '/home/.kimi-code',
    configPath: options?.configPath ?? '/home/.kimi-code/config.toml',
    identity: { userAgentProduct: 'KimiCodeTest', version: '1.2.3' },
    uiMode: 'test-ui',
    telemetry: telemetry as never,
    auth: { marker: 'auth' } as never,
    sessionStartedProperties: { base: 'prop' },
  });

  return {
    harness,
    calls,
    order,
    telemetryEvents,
    contextPatches,
    configAll,
    configValues,
    diagnostics,
    flags,
    pluginInfo,
    pluginSummaries,
    pluginCommands,
    reloadSummary,
    exportResult,
    indexItems,
    getDisposeCalls: () => disposeCalls,
    appEventListenerCount: () => appEventBus.count(),
  };
}

const rejected = async (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => undefined,
    (error: unknown) => error,
  );

describe('CoreHarness createSession', () => {
  it('registers the workspace before creating, then binds main and applies options in order', async () => {
    const fx = makeFixture();
    const session = await fx.harness.createSession({
      id: 'sess-1',
      workDir: '/work',
      model: 'kimi-latest',
      thinking: 'high',
      permission: 'auto',
      metadata: { source: 'test' },
      additionalDirs: ['/extra'],
    });

    expect(session.id).toBe('sess-1');
    expect(fx.calls['registry.createOrTouch']).toEqual([['/work']]);
    expect(fx.calls['lifecycle.create']).toEqual([[{ sessionId: 'sess-1', workDir: '/work' }]]);
    expect(fx.order.indexOf('registry.createOrTouch')).toBeLessThan(fx.order.indexOf('lifecycle.create'));
    expect(fx.order.indexOf('lifecycle.create')).toBeLessThan(fx.order.indexOf('sess-1.setModel'));
    expect(fx.calls['sess-1.setModel']).toEqual([['kimi-latest']]);
    expect(fx.calls['sess-1.setThinking']).toEqual([['high']]);
    expect(fx.calls['sess-1.setMode']).toEqual([['auto']]);
    expect(fx.calls['sess-1.meta.update']).toEqual([[{ custom: { source: 'test' } }]]);
    expect(fx.calls['sess-1.addAdditionalDir']).toEqual([['/extra']]);
    // Live summary snapshot is projected from session metadata + context.
    expect(session.summary).toEqual({
      id: 'sess-1',
      title: 'Old Title',
      lastPrompt: 'last words',
      workDir: '/work',
      sessionDir: '/sessions/ws-1/sess-1',
      createdAt: 100,
      updatedAt: 200,
      archived: false,
      metadata: { origin: 'test' },
      additionalDirs: ['/extra'],
    });
  });

  it('enters plan mode on the main agent when planMode is set', async () => {
    const fx = makeFixture();
    await fx.harness.createSession({ id: 'sess-1', workDir: '/work', planMode: true });
    expect(fx.calls['sess-1.plan.enter']).toEqual([[]]);
  });

  it('tracks session_started (resumed:false, canonical fields win) and session_new', async () => {
    const fx = makeFixture();
    await fx.harness.createSession({
      id: 'sess-1',
      workDir: '/work',
      sessionStartedProperties: { extra: 'scoped', client_name: 'hijack' },
    });

    expect(fx.telemetryEvents).toEqual([
      {
        event: 'session_started',
        context: { sessionId: 'sess-1' },
        properties: {
          base: 'prop',
          extra: 'scoped',
          client_id: null,
          client_name: 'KimiCodeTest',
          client_version: '1.2.3',
          ui_mode: 'test-ui',
          resumed: false,
        },
      },
      { event: 'session_new', context: { sessionId: 'sess-1' }, properties: undefined },
    ]);
  });

  it('rolls the lifecycle back when a post-create step fails', async () => {
    const boom = new Error('setModel exploded');
    const fx = makeFixture({ setModelError: boom });
    const error = await rejected(
      fx.harness.createSession({ id: 'sess-1', workDir: '/work', model: 'kimi-latest' }),
    );
    expect(error).toBe(boom);
    expect(fx.calls['lifecycle.close']).toEqual([['sess-1']]);
    expect(fx.telemetryEvents).toEqual([]);
  });

  it('closes the registered session when a post-registration step fails', async () => {
    const boom = new Error('plan enter exploded');
    const fx = makeFixture({ planEnterError: boom });
    const error = await rejected(
      fx.harness.createSession({ id: 'sess-1', workDir: '/work', planMode: true }),
    );
    expect(error).toBe(boom);
    // The registered CoreSession owned an App-scope IEventService subscription;
    // the rollback must release it through CoreSession.close(), not just drop
    // the registry entry.
    expect(fx.appEventListenerCount()).toBe(0);
    expect(fx.calls['lifecycle.close']).toEqual([['sess-1']]);
    expect(fx.telemetryEvents).toEqual([]);
    // The registry entry is gone: a subsequent resume takes the cold path
    // instead of returning a cached live instance.
    await fx.harness.resumeSession({ id: 'sess-1' }).catch(() => {});
    expect(fx.calls['lifecycle.resume']).toHaveLength(1);
  });
});

describe('CoreHarness resumeSession', () => {
  it('returns the live instance on cache hit without re-tracking session_started', async () => {
    const fx = makeFixture();
    const created = await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    fx.telemetryEvents.length = 0;

    const resumed = await fx.harness.resumeSession({ id: 'sess-1' });
    expect(resumed).toBe(created);
    expect(fx.calls['lifecycle.resume']).toBeUndefined();
    expect(fx.telemetryEvents).toEqual([]);
  });

  it('cold-resumes through the lifecycle and injects the rebuilt resume state', async () => {
    const fx = makeFixture();
    await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    await fx.harness.closeSession('sess-1');
    fx.telemetryEvents.length = 0;

    const session = await fx.harness.resumeSession({ id: 'sess-1', additionalDirs: ['/more'] });
    expect(fx.calls['lifecycle.resume']).toEqual([['sess-1']]);
    expect(fx.calls['sess-1.addAdditionalDir']).toEqual([['/more']]);
    const resumeState = session.getResumeState();
    expect(resumeState).toBeDefined();
    expect(Object.keys(resumeState!.agents)).toEqual(['main']);
    expect(fx.telemetryEvents).toEqual([
      {
        event: 'session_started',
        context: { sessionId: 'sess-1' },
        properties: {
          base: 'prop',
          client_id: null,
          client_name: 'KimiCodeTest',
          client_version: '1.2.3',
          ui_mode: 'test-ui',
          resumed: true,
        },
      },
      { event: 'session_resume', context: { sessionId: 'sess-1' }, properties: undefined },
    ]);
  });

  it('rejects an unknown id with SESSION_NOT_FOUND', async () => {
    const fx = makeFixture();
    const error = await rejected(fx.harness.resumeSession({ id: 'ghost' }));
    expect(isCoreError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(CoreErrorCodes.SESSION_NOT_FOUND);
  });

  it('normalizes the session id (empty and non-string rejected)', async () => {
    const fx = makeFixture();
    const empty = await rejected(fx.harness.resumeSession({ id: '   ' }));
    expect((empty as { code: string }).code).toBe(CoreErrorCodes.SESSION_ID_EMPTY);
    const missing = await rejected(fx.harness.resumeSession({ id: 123 as never }));
    expect((missing as { code: string }).code).toBe(CoreErrorCodes.SESSION_ID_REQUIRED);
  });
});

describe('CoreHarness reloadSession', () => {
  it('rejects with TURN_AGENT_BUSY while the live session is not idle', async () => {
    const fx = makeFixture({ activityStatus: 'running' });
    await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    const error = await rejected(fx.harness.reloadSession({ id: 'sess-1' }));
    expect(isCoreError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(CoreErrorCodes.TURN_AGENT_BUSY);
    expect(fx.calls['plugins.reload']).toBeUndefined();
  });

  it('reloads plugins, closes and resumes the session, then tracks session_reload', async () => {
    const fx = makeFixture();
    const original = await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    fx.telemetryEvents.length = 0;

    const reloaded = await fx.harness.reloadSession({
      id: 'sess-1',
      forcePluginSessionStartReminder: true, // TODO(v2-gap): G-5 — accepted and ignored.
    });
    expect(reloaded).not.toBe(original);
    expect(reloaded.id).toBe('sess-1');
    expect(fx.calls['plugins.reload']).toHaveLength(1);
    expect(fx.order.indexOf('plugins.reload')).toBeLessThan(fx.order.indexOf('lifecycle.close'));
    expect(fx.order.indexOf('lifecycle.close')).toBeLessThan(fx.order.indexOf('lifecycle.resume'));
    expect(fx.telemetryEvents).toEqual([
      { event: 'session_reload', context: { sessionId: 'sess-1' }, properties: undefined },
    ]);
  });
});

describe('CoreHarness forkSession', () => {
  it('forwards forkId as newSessionId and tracks session_fork on the fork product', async () => {
    const fx = makeFixture();
    await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    fx.telemetryEvents.length = 0;

    const fork = await fx.harness.forkSession({ id: 'sess-1', forkId: 'fork-1', title: 'Fork!' });
    expect(fork.id).toBe('fork-1');
    expect(fx.calls['lifecycle.fork']).toEqual([
      [{ sourceSessionId: 'sess-1', newSessionId: 'fork-1', title: 'Fork!' }],
    ]);
    expect(fork.getResumeState()).toBeDefined();
    expect(fx.telemetryEvents).toEqual([
      {
        event: 'session_started',
        context: { sessionId: 'fork-1' },
        properties: {
          base: 'prop',
          client_id: null,
          client_name: 'KimiCodeTest',
          client_version: '1.2.3',
          ui_mode: 'test-ui',
          resumed: true,
        },
      },
      { event: 'session_fork', context: { sessionId: 'fork-1' }, properties: undefined },
    ]);
  });
});

describe('CoreHarness renameSession', () => {
  it('renames a live session via setTitle and re-emits session.meta.updated locally', async () => {
    const fx = makeFixture();
    const session = await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    const events: SessionEvent[] = [];
    session.onEvent((event) => events.push(event));

    await fx.harness.renameSession({ id: 'sess-1', title: 'New Title' });
    expect(fx.calls['sess-1.setTitle']).toEqual([['New Title']]);
    expect(events).toEqual([
      { type: 'session.meta.updated', title: 'New Title', agentId: 'main', sessionId: 'sess-1' },
    ]);
    // The injected event flows through the same delivery path, so the
    // synchronous summary snapshot follows.
    expect(session.summary.title).toBe('New Title');
  });

  it('renames a cold session by resuming, retitling and closing it again', async () => {
    const fx = makeFixture();
    await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    await fx.harness.closeSession('sess-1');
    fx.calls['lifecycle.close'] = [];

    await fx.harness.renameSession({ id: 'sess-1', title: 'Cold Title' });
    expect(fx.calls['lifecycle.resume']).toEqual([['sess-1']]);
    expect(fx.calls['sess-1.setTitle']).toEqual([['Cold Title']]);
    expect(fx.calls['lifecycle.close']).toEqual([['sess-1']]);
  });

  it('rejects an unknown cold id with SESSION_NOT_FOUND', async () => {
    const fx = makeFixture();
    const error = await rejected(fx.harness.renameSession({ id: 'ghost', title: 'X' }));
    expect((error as { code: string }).code).toBe(CoreErrorCodes.SESSION_NOT_FOUND);
  });
});

describe('CoreHarness listSessions and exportSession', () => {
  it('lists via the session index, filters by workDir, and projects summaries', async () => {
    const fx = makeFixture();
    const all = await fx.harness.listSessions();
    expect(all).toEqual([
      {
        id: 'sess-a',
        title: 'A',
        lastPrompt: 'p',
        workDir: '/work',
        sessionDir: '/sessions/ws-1/sess-a',
        createdAt: 1,
        updatedAt: 2,
        archived: false,
        metadata: { k: 'v' },
      },
      {
        id: 'sess-b',
        title: undefined,
        lastPrompt: undefined,
        // TODO note: sessions predating the persisted cwd project an empty workDir.
        workDir: '',
        sessionDir: '/sessions/ws-2/sess-b',
        createdAt: 3,
        updatedAt: 4,
        archived: true,
        metadata: undefined,
      },
    ]);

    const filtered = await fx.harness.listSessions({ workDir: '/work' });
    expect(filtered.map((s) => s.id)).toEqual(['sess-a']);
    const byId = await fx.harness.listSessions({ sessionId: 'sess-b' });
    expect(byId.map((s) => s.id)).toEqual(['sess-b']);
  });

  it('exports through the session export service and tracks export', async () => {
    const fx = makeFixture();
    const result = await fx.harness.exportSession({
      id: 'sess-1',
      outputPath: '/tmp/out.zip',
      includeGlobalLog: true,
      version: '9.9.9',
      installSource: 'npm-global',
    });
    expect(result).toBe(fx.exportResult);
    expect(fx.calls['export.export']).toEqual([
      [
        {
          sessionId: 'sess-1',
          outputPath: '/tmp/out.zip',
          includeGlobalLog: true,
          version: '9.9.9',
          installSource: 'npm-global',
          shellEnv: undefined,
        },
      ],
    ]);
    expect(fx.telemetryEvents).toEqual([
      { event: 'export', context: { sessionId: 'sess-1' }, properties: undefined },
    ]);
  });
});

describe('CoreHarness getStartupState', () => {
  it('resolves config defaults and the default model without creating a session', async () => {
    const fx = makeFixture();
    const state = await fx.harness.getStartupState();
    expect(state).toEqual({
      model: 'kimi-latest',
      maxContextTokens: 200_000,
      permissionMode: 'auto',
      planMode: true,
      thinkingEffort: 'high',
    });
    expect(fx.calls['resolver.resolve']).toEqual([['kimi-latest']]);
    expect(fx.calls['lifecycle.create']).toBeUndefined();
  });

  it('keeps the alias but degrades to a zero context window when resolution fails', async () => {
    const fx = makeFixture({ resolverError: new Error('auth not ready') });
    const state = await fx.harness.getStartupState();
    expect(state.model).toBe('kimi-latest');
    expect(state.maxContextTokens).toBe(0);
    // The thinking default comes from config and survives a failed resolve.
    expect(state.thinkingEffort).toBe('high');
  });

  it('reports empty defaults when nothing is configured', async () => {
    const fx = makeFixture();
    for (const key of Object.keys(fx.configValues)) delete fx.configValues[key];
    const state = await fx.harness.getStartupState();
    expect(state).toEqual({
      model: '',
      maxContextTokens: 0,
      permissionMode: 'manual',
      planMode: false,
      thinkingEffort: 'off',
    });
    expect(fx.calls['resolver.resolve']).toBeUndefined();
  });

  it('falls back to manual for an invalid permission mode', async () => {
    const fx = makeFixture();
    fx.configValues['defaultPermissionMode'] = 'bogus';
    expect((await fx.harness.getStartupState()).permissionMode).toBe('manual');
  });
});

describe('CoreHarness config domain', () => {
  it('getConfig awaits readiness and only reloads when asked', async () => {
    const fx = makeFixture();
    expect(await fx.harness.getConfig()).toBe(fx.configAll);
    expect(fx.calls['config.reload']).toBeUndefined();
    expect(await fx.harness.getConfig({ reload: true })).toBe(fx.configAll);
    expect(fx.calls['config.reload']).toHaveLength(1);
  });

  it('setConfig writes each domain then returns the resolved config', async () => {
    const fx = makeFixture();
    const result = await fx.harness.setConfig({ defaultModel: 'other', telemetry: { enabled: false } });
    expect(fx.calls['config.set']).toEqual([
      ['defaultModel', 'other'],
      ['telemetry', { enabled: false }],
    ]);
    expect(result).toBe(fx.configAll);
  });

  it('exposes diagnostics, provider removal and experimental flags', async () => {
    const fx = makeFixture();
    expect(await fx.harness.getConfigDiagnostics()).toBe(fx.diagnostics);
    expect(await fx.harness.removeProvider('kimi')).toBe(fx.configAll);
    expect(fx.calls['provider.delete']).toEqual([['kimi']]);
    expect(await fx.harness.getExperimentalFeatures()).toBe(fx.flags);
  });
});

describe('CoreHarness plugins', () => {
  it('forwards the plugin surface to IPluginService', async () => {
    const fx = makeFixture();
    expect(await fx.harness.listPlugins()).toBe(fx.pluginSummaries);
    expect(await fx.harness.installPlugin({ source: 'github:me/plugin' })).toBe(fx.pluginSummaries[0]);
    await fx.harness.setPluginEnabled({ id: 'known', enabled: false });
    await fx.harness.setPluginMcpServerEnabled({ id: 'known', server: 'srv', enabled: true });
    await fx.harness.removePlugin({ id: 'known' });
    expect(await fx.harness.reloadPlugins()).toBe(fx.reloadSummary);
    expect(await fx.harness.listPluginCommands()).toBe(fx.pluginCommands);
    expect(fx.calls['plugins.install']).toEqual([[{ source: 'github:me/plugin' }]]);
    expect(fx.calls['plugins.setEnabled']).toEqual([[{ id: 'known', enabled: false }]]);
    expect(fx.calls['plugins.setMcpServerEnabled']).toEqual([[{ id: 'known', server: 'srv', enabled: true }]]);
    expect(fx.calls['plugins.remove']).toEqual([[{ id: 'known' }]]);
  });

  it('getPluginInfo returns the info and rejects unknown ids with PLUGIN_NOT_FOUND', async () => {
    const fx = makeFixture();
    expect(await fx.harness.getPluginInfo({ id: 'known' })).toBe(fx.pluginInfo);
    const error = await rejected(fx.harness.getPluginInfo({ id: 'ghost' }));
    expect(isCoreError(error)).toBe(true);
    expect((error as { code: string }).code).toBe(CoreErrorCodes.PLUGIN_NOT_FOUND);
  });
});

describe('CoreHarness telemetry passthrough and close', () => {
  it('track and setTelemetryContext forward to the client', () => {
    const fx = makeFixture();
    fx.harness.track('custom_event', { a: 1 });
    fx.harness.setTelemetryContext({ sessionId: 'sess-1' });
    expect(fx.telemetryEvents).toEqual([{ event: 'custom_event', properties: { a: 1 }, context: undefined }]);
    expect(fx.contextPatches).toEqual([{ sessionId: 'sess-1' }]);
  });

  it('closes every live session and disposes the app scope', async () => {
    const fx = makeFixture();
    await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    await fx.harness.createSession({ id: 'sess-2', workDir: '/work' });
    await fx.harness.close();
    expect(fx.calls['lifecycle.close']).toEqual(expect.arrayContaining([['sess-1'], ['sess-2']]));
    expect(fx.getDisposeCalls()).toBe(1);
  });

  it('swallows session-close and dispose failures on the exit path', async () => {
    const fx = makeFixture({ closeSessionError: new Error('close boom'), disposeError: new Error('dispose boom') });
    await fx.harness.createSession({ id: 'sess-1', workDir: '/work' });
    await expect(fx.harness.close()).resolves.toBeUndefined();
    expect(fx.getDisposeCalls()).toBe(1);
  });
});

describe('CoreHarness ensureConfigFile', () => {
  const tempDirs: string[] = [];
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('creates the default stub once and leaves an existing file untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'core-harness-'));
    tempDirs.push(dir);
    const configPath = join(dir, 'nested', 'config.toml');
    const fx = makeFixture({ configPath });

    await fx.harness.ensureConfigFile();
    const created = await readFile(configPath, 'utf-8');
    expect(created).toBe(
      '# ~/.kimi-code/config.toml\n' +
        '# Runtime settings for Kimi Code.\n' +
        '# This file starts empty so built-in defaults can apply.\n' +
        '# Login will populate managed Kimi provider and model entries.\n',
    );

    await writeFile(configPath, 'user content', 'utf-8');
    await fx.harness.ensureConfigFile();
    expect(await readFile(configPath, 'utf-8')).toBe('user content');
  });


  it('listStartupSkills merges builtin + user + workspace with workspace winning conflicts', async () => {
    const fx = makeFixture();
    const skills = await fx.harness.listStartupSkills('/work');

    const names = skills.map((s) => s.name).toSorted();
    expect(names).toEqual(['builtin-only', 'dup', 'user-only']);
    // Same name from builtin and workspace: the higher-priority workspace
    // contribution replaces the builtin one.
    expect(skills.find((s) => s.name === 'dup')?.description).toBe('workspace dup wins');
    expect(fx.calls['skills.builtin']).toHaveLength(1);
    expect(fx.calls['skills.user']).toHaveLength(1);
    expect(fx.calls['skills.discover']).toHaveLength(1);
  });

  it('listStartupSkills skips workspace discovery when explicit skill dirs are set', async () => {
    const fx = makeFixture({ explicitSkillDirs: ['/explicit'] });
    const skills = await fx.harness.listStartupSkills('/work');

    expect(skills.map((s) => s.name).toSorted()).toEqual(['builtin-only', 'dup', 'user-only']);
    expect(fx.calls['skills.discover']).toBeUndefined();
  });
});
