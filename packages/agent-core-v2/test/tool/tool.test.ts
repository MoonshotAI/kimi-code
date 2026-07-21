import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';

import { LifecycleScope, type IAgentScopeHandle } from '#/_base/di/scope';
import { Event, type Event as KimiEvent } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { toInputJsonSchema } from '#/tool/input-schema';
import { userCancellationReason } from '#/_base/utils/abort';
import { createHooks } from '#/hooks';
import type { ToolCall } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentContextSizeService } from '#/agent/contextSize/contextSize';
import { makeHookRunner } from '../agent/externalHooks/runner-stub';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { ToolAccesses, type ExecutableTool } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import {
  AgentSwarmToolInputSchema,
  type AgentSwarmToolInput,
} from '#/agent/swarm/tools/agent-swarm';
import {
  AgentToolInputSchema,
  type AgentToolInput,
} from '#/session/subagent/tools/agent';
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '#/session/subagent/configSection';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from '#/session/subagent/subagent';
import { IEventBus, type DomainEvent } from '#/app/event/eventBus';
import type { AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type {
  ISessionSwarmService,
  SessionSwarmRunArgs,
  SessionSwarmRunResult,
} from '#/session/swarm/sessionSwarm';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';
import { IWireService } from '#/wire/wire';
import { createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import {
  configServices,
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  externalHookServices,
  homeDirServices,
  sessionService,
  swarmServices,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../harness';
import { executeTool } from '../tools/fixtures/execute-tool';

const signal = new AbortController().signal;

function agentSchemaProperties<T = unknown>(): Record<string, T> {
  return (
    toInputJsonSchema(AgentToolInputSchema) as { properties: Record<string, T> }
  ).properties;
}

function agentSwarmSchemaProperties<T = unknown>(): Record<string, T> {
  return (
    toInputJsonSchema(AgentSwarmToolInputSchema) as { properties: Record<string, T> }
  ).properties;
}

const BACKGROUND_AGENT_NEXT_STEP =
  'next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)';

function deferred<T>(): {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason?: unknown): void;
} {
  let resolve: (value: T) => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface CapturedLogEntry {
  readonly level: 'error' | 'warn' | 'info' | 'debug';
  readonly message: string;
  readonly payload: unknown;
}

function captureLogs(): {
  readonly entries: CapturedLogEntry[];
  readonly logger: ILogService;
} {
  const entries: CapturedLogEntry[] = [];
  const capture =
    (level: CapturedLogEntry['level']) => (message: string, payload?: unknown) => {
      entries.push({ level, message, payload });
    };
  let logger: ILogService;
  logger = {
    _serviceBrand: undefined,
    level: 'off',
    setLevel: () => {},
    flush: async () => {},
    info: capture('info'),
    warn: capture('warn'),
    error: capture('error'),
    debug: capture('debug'),
    child: () => logger,
  };
  return { entries, logger };
}

function hookSlot<T>() {
  return {
    run: vi.fn(async (_input: T) => {}),
    register: () => ({ dispose: () => {} }),
    delete: () => false,
  };
}

function noopDisposable() {
  return { dispose: () => {} };
}

interface AgentLifecycleStubOptions {
  readonly createAgentIds?: readonly string[];
  readonly runCompletion?: (
    agentId: string,
    request: AgentRunRequest,
    options: RunAgentOptions,
  ) => Promise<{ readonly summary: string; readonly usage?: TokenUsage }>;
  readonly createError?: Error;
  readonly handleServices?: ReadonlyMap<string, ReadonlyMap<unknown, unknown>>;
}

interface AgentLifecycleStub extends IAgentLifecycleService, ISessionSubagentService {
  readonly create: ReturnType<typeof vi.fn<IAgentLifecycleService['create']>>;
  readonly run: ReturnType<typeof vi.fn<ISessionSubagentService['run']>>;
  readonly get: ReturnType<typeof vi.fn<IAgentLifecycleService['get']>>;
  addHandle(
    agentId: string,
    profileName: string,
    services?: ReadonlyMap<unknown, unknown>,
  ): void;
}

function createAgentLifecycleStub(options: AgentLifecycleStubOptions = {}): AgentLifecycleStub {
  let lifecycle: AgentLifecycleStub;
  let created = 0;
  const profileByAgentId = new Map<string, string>();
  const handles = new Map<string, IAgentScopeHandle>();
  const servicesByAgentId = new Map(options.handleServices);
  const handle = (agentId: string): IAgentScopeHandle => ({
    id: agentId,
    kind: 2,
    accessor: {
      get: (serviceId) => {
        const service = servicesByAgentId.get(agentId)?.get(serviceId);
        if (service !== undefined) return service as never;
        if (serviceId === IAgentLifecycleService) return lifecycle as never;
        if (serviceId === ISessionSubagentService) return lifecycle as never;
        if (serviceId === IAgentContextInjectorService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IAgentContextMemoryService) {
          return {
            _serviceBrand: undefined,
            get: () => [],
          } as never;
        }
        if (serviceId === IAgentProfileService) {
          return {
            _serviceBrand: undefined,
            data: () => ({ profileName: profileByAgentId.get(agentId) }),
            update: () => {},
            isToolActive: () => false,
          } as never;
        }
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            status: () => ({ state: 'idle', pendingTurnIds: [], hasPendingRequests: false }),
          } as never;
        }
        if (serviceId === IAgentPermissionModeService) {
          return {
            _serviceBrand: undefined,
            mode: 'manual',
            setMode: () => {},
            onDidChangeMode: Event.None,
          } as never;
        }
        if (serviceId === IAgentToolRegistryService) {
          return {
            _serviceBrand: undefined,
            register: () => ({ dispose: () => {} }),
          } as never;
        }
        if (serviceId === IAgentUserToolService) {
          return {
            _serviceBrand: undefined,
            list: () => [],
            inheritUserTools: () => {},
            register: () => {},
            unregister: () => {},
          } as never;
        }
        if (serviceId === IWireService) {
          return {
            _serviceBrand: undefined,
            hooks: createHooks(['onDidRestore']),
            dispatch: () => {},
            replay: async () => {},
            flush: async () => {},
            getModel: () => [],
            subscribe: () => noopDisposable(),
            onEmission: () => noopDisposable(),
          } as never;
        }
        return undefined as never;
      },
    },
    dispose: () => {},
  });
  lifecycle = {
    _serviceBrand: undefined,
    hooks: {
      onWillStartAgentTask: hookSlot(),
    },
    onDidStopAgentTask: Event.None as KimiEvent<AgentTaskStopHookContext>,
    onDidCreate: Event.None as KimiEvent<IAgentScopeHandle>,
    onDidDispose: Event.None as KimiEvent<string>,
    create: vi.fn(async (input = {}) => {
      if (options.createError !== undefined) throw options.createError;
      const agentId =
        input.agentId ??
        options.createAgentIds?.[created] ??
        `agent-child-${String(created + 1)}`;
      created += 1;
      const profileName = input.binding?.profile ?? 'coder';
      profileByAgentId.set(agentId, profileName);
      const createdHandle = handle(agentId);
      handles.set(agentId, createdHandle);
      return createdHandle;
    }),
    notifyAgentTaskStopped: vi.fn(),
    fork: vi.fn(async () => {
      throw new Error('unexpected fork');
    }),
    run: vi.fn(async (agentId, request, runOptions): Promise<AgentRunHandle> => {
      const completion =
        options.runCompletion?.(agentId, request, runOptions) ??
        Promise.resolve({ summary: 'child result' });
      return {
        agentId,
        turn: {} as AgentRunHandle['turn'],
        completion,
      };
    }),
    get: vi.fn((agentId) => handles.get(agentId)),
    list: vi.fn(() => [...handles.values()]),
    broadcastPermissionMode: vi.fn(),
    remove: vi.fn(async (agentId) => {
      handles.delete(agentId);
    }),
    addHandle: (agentId, profileName, services) => {
      profileByAgentId.set(agentId, profileName);
      if (services !== undefined) servicesByAgentId.set(agentId, services);
      handles.set(agentId, handle(agentId));
    },
  };
  return lifecycle;
}

function agentTool(ctx: TestAgentContext): ExecutableTool<AgentToolInput> {
  const tool = ctx.get(IAgentToolRegistryService).resolve('Agent');
  expect(tool).toBeDefined();
  return tool! as ExecutableTool<AgentToolInput>;
}

function agentSwarmTool(ctx: TestAgentContext): ExecutableTool<AgentSwarmToolInput> {
  const tool = ctx.get(IAgentToolRegistryService).resolve('AgentSwarm');
  expect(tool).toBeDefined();
  return tool! as ExecutableTool<AgentSwarmToolInput>;
}

function executeAgentTool(
  ctx: TestAgentContext,
  args: AgentToolInput,
  inputSignal: AbortSignal = signal,
) {
  return executeTool(agentTool(ctx), {
    turnId: 0,
    toolCallId: 'call_agent',
    args,
    signal: inputSignal,
  });
}

function currentAgentHandle(ctx: TestAgentContext, agentId: string): IAgentScopeHandle {
  return {
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get: ((serviceId: unknown) =>
        ctx.get(serviceId as never)) as IAgentScopeHandle['accessor']['get'],
    },
    dispose: () => {},
  };
}

const cronStub = {
  _serviceBrand: undefined,
  list: () => [],
} as unknown as ISessionCronService;

function sessionMetadataStub(agents: Readonly<Record<string, AgentMeta>>): ISessionMetadata {
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChangeMetadata: Event.None as ISessionMetadata['onDidChangeMetadata'],
    read: async () => ({
      id: 'test-session',
      createdAt: 0,
      updatedAt: 0,
      archived: false,
      agents,
    }),
    update: async () => {},
    setTitle: async () => {},
    setArchived: async () => {},
    registerAgent: async () => {},
  };
}

function subagentMeta(parentAgentId = 'main'): AgentMeta {
  return {
    labels: { parentAgentId },
  };
}

describe('AgentToolInputSchema', () => {
  it('accepts the snake_case background parameter', () => {
    const parsed = AgentToolInputSchema.parse({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });

    expect(parsed).toMatchObject({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      run_in_background: true,
    });
  });

  it('exposes run_in_background and not runInBackground in the JSON schema', () => {
    const properties = agentSchemaProperties();

    expect(properties).toHaveProperty('run_in_background');
    expect(properties).not.toHaveProperty('runInBackground');
  });

  it('describes subagent_type and run_in_background parameters', () => {
    const properties = agentSchemaProperties<{ description?: string }>();

    const subagentTypeDescription = properties['subagent_type']?.description ?? '';
    expect(subagentTypeDescription).toContain('coder');
    expect(subagentTypeDescription).not.toContain('registry');
    expect(subagentTypeDescription).toContain('agent type');
    expect(properties['run_in_background']?.description).toContain('false');
  });

  it('documents that resume excludes subagent_type', () => {
    const properties = agentSchemaProperties<{ description?: string }>();

    expect((properties['resume']?.description ?? '').toLowerCase()).toContain('subagent_type');
  });

  it('does not expose timeout or model parameters in the JSON schema', () => {
    const properties = agentSchemaProperties();

    expect(properties).not.toHaveProperty('timeout');
    expect(properties).not.toHaveProperty('model');
  });

  it('normalizes the default subagent type into tool args', () => {
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
      }).subagent_type,
    ).toBe('coder');
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }).subagent_type,
    ).toBe('coder');
    expect(
      AgentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }).subagent_type,
    ).toBeUndefined();
  });
});

describe('Agent tool description', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  function agentDescription(): string {
    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool).toBeDefined();
    return tool!.description;
  }

  it('explains the fixed background subagent timeout', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('fixed 2-hour timeout');
    expect(description).not.toContain('operator-configured background timeout');
    expect(description).not.toContain('no time limit');
    expect(description).toContain('Default to a foreground subagent');
  });

  it('renders the tool set for each subagent type', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL');
    expect(description).toContain('Tools: Agent, AgentSwarm, Bash');
  });

  it('renders global tool restrictions in subagent type descriptions', () => {
    ctx = createTestAgent(
      configServices(() => ({
        providers: {},
        tools: { disabled: ['Bash'] },
      })),
    );

    const description = agentDescription();
    const coderTools = description
      .split('\n')
      .find((line) => line.startsWith('  Tools:') && line.includes('ReadMediaFile'));

    expect(coderTools).toBeDefined();
    expect(coderTools).not.toContain('Bash');
  });

  it('renders effective tools after applying disallowedTools', () => {
    const restricted: AgentProfile = {
      name: 'restricted',
      description: 'Restricted agent',
      tools: ['Bash', 'Read', 'mcp__github__*'],
      disallowedTools: ['Bash', 'mcp__github__*'],
      systemPrompt: () => 'restricted',
    };
    const allowAllExcept: AgentProfile = {
      name: 'allow-all-except',
      description: 'Allow all except one',
      disallowedTools: ['Bash'],
      systemPrompt: () => 'allow all except',
    };
    const profiles = [restricted, allowAllExcept];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => restricted,
      list: () => profiles,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- restricted: Restricted agent\n  Tools: Read');
    expect(description).toContain('- allow-all-except: Allow all except one\n  Tools: all except Bash');
    expect(description).not.toContain('Tools: Bash, Read, mcp__github__*');
  });

  it('lists only subagent types allowed by the caller profile', () => {
    const caller: AgentProfile = {
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: ['explore'],
      systemPrompt: () => 'orchestrator',
    };
    const coder: AgentProfile = {
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    };
    const explore: AgentProfile = {
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    };
    const profiles = [caller, coder, explore];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- explore: Explorer');
    expect(description).not.toContain('- coder: Coder');
  });

  it('lists subagent types from the persisted binding instead of the current catalog profile', () => {
    const caller: AgentProfile = {
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: ['coder'],
      systemPrompt: () => 'orchestrator',
    };
    const coder: AgentProfile = {
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    };
    const explore: AgentProfile = {
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    };
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => [caller, coder, explore].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));
    ctx.get(IAgentProfileService).applyBindingSnapshot({
      cwd: '',
      profileName: 'deleted-profile',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
      subagents: ['explore'],
    });

    const description = agentDescription();

    expect(description).toContain('- explore: Explorer');
    expect(description).not.toContain('- coder: Coder');
  });

  it('mentions resume preference and result visibility', () => {
    ctx = createTestAgent();

    const description = agentDescription().toLowerCase();

    expect(description).toContain('resume');
    expect(description).toContain('only visible to you');
    expect(description).toContain('when not to');
    expect(description).toContain('out of your own context');
  });

  it('describes configured subagent types', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('Available agent types');
    expect(description).toContain('- explore: Fast codebase exploration');
    expect(description).toContain(
      '- coder: General software engineering agent — the only subagent type with file-editing tools',
    );
  });
});

describe('Agent tool execution contract', () => {
  let ctx: TestAgentContext | undefined;

  afterEach(async () => {
    vi.useRealTimers();
    await ctx?.dispose();
    ctx = undefined;
  });

  function createAgentToolContext(
    lifecycle: AgentLifecycleStub = createAgentLifecycleStub(),
    ...extra: readonly (TestAgentServiceOverride | TestAgentOptions)[]
  ): TestAgentContext {
    ctx = createTestAgent(
      sessionService(IAgentLifecycleService, lifecycle),
      sessionService(ISessionSubagentService, lifecycle),
      sessionService(ISessionCronService, cronStub),
      ...extra,
    );
    lifecycle.addHandle('main', 'agent');
    return ctx;
  }

  function allowlistCatalog(allowlist: readonly string[]): ISessionAgentProfileCatalog {
    const caller: AgentProfile = {
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: allowlist,
      systemPrompt: () => 'orchestrator',
    };
    const coder: AgentProfile = {
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    };
    const explore: AgentProfile = {
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    };
    const profiles = [caller, coder, explore];
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      load: async () => {},
      reload: async () => {},
    };
  }

  it('rejects a subagent type outside the caller allowlist', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['explore'])),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'coder',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Subagent type "coder" is not allowed for this agent');
    expect(result.output).toContain('explore');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('enforces the persisted subagent allowlist instead of the current catalog profile', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['coder'])),
    );
    context.get(IAgentProfileService).applyBindingSnapshot({
      cwd: '',
      profileName: 'deleted-profile',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
      subagents: ['explore'],
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'coder',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Subagent type "coder" is not allowed for this agent');
    expect(result.output).toContain('explore');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('spawns a subagent type inside the caller allowlist', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, allowlistCatalog(['explore'])),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'explore' }),
      }),
    );
    expect(result.output).toContain('actual_subagent_type: explore');
  });

  it('declares no resource accesses so concurrent Agent calls can run in parallel', async () => {
    const context = createAgentToolContext();

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.accesses).toEqual(ToolAccesses.none());
  });

  it('uses the resumed agent profile in the activity description', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    lifecycle.addHandle('agent-existing', 'explore');

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: ' agent-existing ',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching explore agent: Continue work');
    expect(lifecycle.get).toHaveBeenCalledWith('agent-existing');
  });

  it('returns an error when resuming with a subagent type', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
      subagent_type: 'explore',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('spawns a foreground subagent and returns its summary', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'explore' }),
        labels: expect.objectContaining({ parentAgentId: 'main' }),
      }),
    );
    expect(lifecycle.run).toHaveBeenCalledWith(
      'agent-child',
      { kind: 'prompt', prompt: expect.stringContaining('Investigate') },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('child result');
  });

  it('mirrors v1-compatible subagent lifecycle event fields', async () => {
    const lifecycle = createAgentLifecycleStub();
    const events: DomainEvent[] = [];
    const eventBus = {
      _serviceBrand: undefined,
      publish: vi.fn((event: DomainEvent) => {
        events.push(event);
      }),
      subscribe: vi.fn(() => noopDisposable()),
    } as IEventBus;
    lifecycle.addHandle(
      'agent-child',
      'explore',
      new Map([
        [
          IAgentContextSizeService,
          {
            _serviceBrand: undefined,
            get: () => ({ size: 321, measured: 300, estimated: 21 }),
            measured: () => {},
          },
        ],
      ]),
    );
    const telemetryRecords: Array<{ event: string; properties: unknown }> = [];
    const requester = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: ((serviceId: unknown) => {
          if (serviceId === IEventBus) return eventBus;
          if (serviceId === IAgentLifecycleService) return lifecycle;
          if (serviceId === ITelemetryService) {
            return {
              ...noopTelemetryService,
              track2: (event: string, properties: unknown) => {
                telemetryRecords.push({ event, properties });
              },
            };
          }
          return undefined;
        }) as IAgentScopeHandle['accessor']['get'],
      },
      dispose: () => {},
    } satisfies IAgentScopeHandle;

    emitAgentRunSpawned(requester, 'agent-child', {
      profileName: 'explore',
      parentToolCallId: 'call_agent',
      runInBackground: false,
    });
    await mirrorAgentRun(
      requester,
      {
        agentId: 'agent-child',
        turn: {} as AgentRunHandle['turn'],
        completion: Promise.resolve({ summary: 'child result' }),
      },
      {
        profileName: 'explore',
        prompt: 'Investigate',
        signal,
      },
    );

    expect(events.find((event) => event.type === 'subagent.spawned')).toMatchObject({
      parentAgentId: 'main',
      callerAgentId: 'main',
    });
    expect(telemetryRecords).toContainEqual({
      event: 'subagent_created',
      properties: {
        subagent_name: 'explore',
        run_in_background: false,
        agent_id: 'agent-child',
        parent_agent_id: 'main',
        parent_tool_call_id: 'call_agent',
      },
    });
    expect(events.find((event) => event.type === 'subagent.completed')).toMatchObject({
      subagentId: 'agent-child',
      resultSummary: 'child result',
      contextTokens: 321,
    });
  });

  it('inherits parent user tools when spawning a subagent', async () => {
    const lookupTool: UserToolRegistration = {
      name: 'Lookup',
      description: 'Look up a short test value.',
      parameters: { type: 'object', properties: { query: { type: 'string' } } },
    };
    const parentUserTools = {
      _serviceBrand: undefined,
      list: () => [lookupTool],
      inheritUserTools: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as IAgentUserToolService;
    const childUserTools = {
      _serviceBrand: undefined,
      list: () => [],
      inheritUserTools: vi.fn(),
      register: vi.fn(),
      unregister: vi.fn(),
    } as unknown as IAgentUserToolService;
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      handleServices: new Map([
        ['main', new Map([[IAgentUserToolService, parentUserTools]])],
        ['agent-child', new Map([[IAgentUserToolService, childUserTools]])],
      ]),
    });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Use the available lookup tool',
      description: 'Use lookup',
    });

    expect(childUserTools.inheritUserTools).toHaveBeenCalledWith(parentUserTools);
  });

  it('falls back to coder for an empty subagent type', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: '',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'coder' }),
      }),
    );
  });

  it('resumes a foreground subagent when resume is provided', async () => {
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta() }),
      ),
    );
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith(
      'agent-existing',
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('resumed result');
  });

  it('rejects direct resume of a non-subagent', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          main: { type: 'main' },
        }),
      ),
    );
    lifecycle.addHandle('main', 'agent');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue main',
      resume: 'main',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: Agent instance "main" is not a subagent',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects direct resume of another caller owned subagent', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta('other') }),
      ),
    );
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: Agent instance "agent-existing" does not belong to this parent agent',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects direct resume of an already running subagent before launching a turn', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta() }),
      ),
    );
    lifecycle.addHandle(
      'agent-existing',
      'explore',
      new Map([
        [
          IAgentLoopService,
          {
            _serviceBrand: undefined,
            status: () => ({ state: 'running', activeTurnId: 1, pendingTurnIds: [], hasPendingRequests: true }),
          },
        ],
      ]),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'subagent error: Agent instance "agent-existing" is already running and cannot run concurrently',
    });
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('realigns a directly resumed subagent to the caller current model', async () => {
    const targetProfile = {
      _serviceBrand: undefined,
      data: () => ({ profileName: 'explore', modelAlias: 'stale-model' }),
      update: vi.fn(),
      isToolActive: () => false,
    } as unknown as IAgentProfileService;
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta() }),
      ),
    );
    lifecycle.addHandle(
      'agent-existing',
      'explore',
      new Map([[IAgentProfileService, targetProfile]]),
    );

    await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(targetProfile.update).toHaveBeenCalledWith({ modelAlias: 'mock-model' });
    expect(lifecycle.run).toHaveBeenCalledWith(
      'agent-existing',
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it('registers background subagents with the task manager', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });

    expect(result.output).toContain('status: running');
    expect(result.output).toContain('agent_id: agent-child');
    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(context.get(IAgentTaskService).getTask(taskId!)).toMatchObject({
      status: 'running',
      description: 'Find cause',
      timeoutMs: DEFAULT_SUBAGENT_TIMEOUT_MS,
    });
    completion.resolve({ summary: 'finished later' });
  });

  it('rejects background subagents when background execution is disabled', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    context.get(IAgentProfileService).update({ activeToolNames: ['Agent'] });

    const description = context.toolsData().find((tool) => tool.name === 'Agent')?.description;
    expect(description).toContain('Background agent execution is disabled for this agent.');
    expect(description).not.toContain('the subagent runs detached from this turn');
    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });

    expect(result).toMatchObject({
      isError: true,
      output:
        'Background agent execution is not available for this agent because TaskList, TaskOutput, and TaskStop are not enabled.',
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('does not consume a background task slot when validation fails before launch', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
      })),
    );

    const invalid = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Invalid background resume',
      resume: 'agent-existing',
      subagent_type: 'explore',
      run_in_background: true,
    });
    const valid = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });

    expect(invalid).toMatchObject({
      isError: true,
      output: 'Cannot set subagent_type when resuming an existing agent. Resume by agent id only.',
    });
    expect(valid.output).toContain('status: running');
    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    completion.resolve({ summary: 'finished later' });
  });

  it('returns an error when background registration hits the task limit', async () => {
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener(
          'abort',
          () => {
            next.reject(options.signal.reason);
          },
          { once: true },
        );
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
      })),
    );

    const first = await executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      run_in_background: true,
    });
    const second = await executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      run_in_background: true,
    });

    expect(first.output).toContain('status: running');
    expect(second).toMatchObject({
      isError: true,
      output: 'Too many background tasks are already running.',
    });
    expect(lifecycle.create).toHaveBeenCalledTimes(2);
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('rejects one of two concurrent background subagents when the task limit is reached', async () => {
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener('abort', () => next.reject(options.signal.reason), {
          once: true,
        });
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
      })),
    );

    const first = executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      run_in_background: true,
    });
    const second = executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      run_in_background: true,
    });

    const results = await Promise.all([first, second]);

    expect(lifecycle.create).toHaveBeenCalledTimes(2);
    expect(results).toContainEqual(
      expect.objectContaining({ output: expect.stringContaining('status: running') }),
    );
    expect(results).toContainEqual(
      expect.objectContaining({
        isError: true,
        output: 'Too many background tasks are already running.',
      }),
    );
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('logs background registration failures', async () => {
    const { entries, logger } = captureLogs();
    const completions = [
      deferred<{ readonly summary: string }>(),
      deferred<{ readonly summary: string }>(),
    ];
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-first', 'agent-second'],
      runCompletion: (_agentId, _request, options) => {
        const next = completions.shift();
        if (next === undefined) throw new Error('unexpected run');
        options.signal.addEventListener('abort', () => next.reject(options.signal.reason), {
          once: true,
        });
        return next.promise;
      },
    });
    const context = createAgentToolContext(
      lifecycle,
      configServices(() => ({
        providers: {},
        task: { maxRunningTasks: 1 },
      })),
      sessionService(ILogService, logger),
    );

    await executeAgentTool(context, {
      prompt: 'Investigate first',
      description: 'Find first',
      run_in_background: true,
    });
    await executeAgentTool(context, {
      prompt: 'Investigate second',
      description: 'Find second',
      run_in_background: true,
    });

    expect(entries).toContainEqual({
      level: 'warn',
      message: 'background agent task registration failed',
      payload: expect.objectContaining({
        toolCallId: 'call_agent',
        agentId: 'agent-second',
        subagentType: 'coder',
        error: expect.any(Error),
      }),
    });
    completions[0]?.resolve({ summary: 'finished later' });
  });

  it('returns tool errors and logs when spawning fails', async () => {
    const error = new Error('missing subagent');
    const { entries, logger } = captureLogs();
    const lifecycle = createAgentLifecycleStub({ createError: error });
    const context = createAgentToolContext(lifecycle, sessionService(ILogService, logger));

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: missing subagent',
    });
    expect(entries).toContainEqual({
      level: 'warn',
      message: 'subagent launch failed',
      payload: expect.objectContaining({
        toolCallId: 'call_agent',
        runInBackground: false,
        operation: 'spawn',
        subagentType: 'coder',
        error,
      }),
    });
  });

  it('can detach a foreground subagent through the task manager', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);
    const tasks = context.get(IAgentTaskService);

    const running = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(tasks.list(false)).toHaveLength(1);
    });
    const task = tasks.list(false)[0]!;

    expect(task).toMatchObject({
      kind: 'agent',
      detached: false,
      agentId: 'agent-child',
    });

    tasks.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('automatic_notification: true');

    completion.resolve({ summary: 'finished later' });
    await expect(tasks.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('does not recommend disabled task tools when a foreground subagent is detached', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);
    context.get(IAgentProfileService).update({ activeToolNames: ['Agent'] });
    const tasks = context.get(IAgentTaskService);

    const running = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(tasks.list(false)).toHaveLength(1);
    });
    const task = tasks.list(false)[0]!;

    tasks.detach(task.taskId);
    const result = await running;

    expect(result.output).toContain(`task_id: ${task.taskId}`);
    expect(result.output).toContain('next_step: The completion arrives automatically');
    expect(result.output).not.toContain('TaskOutput');
    expect(result.output).not.toContain('TaskStop');

    completion.resolve({ summary: 'finished later' });
    await expect(tasks.wait(task.taskId)).resolves.toMatchObject({
      status: 'completed',
      detached: true,
    });
  });

  it('steers the AI away from waiting and gives a resume hint on background launch', async () => {
    const completion = deferred<{ readonly summary: string }>();
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: () => completion.promise,
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });

    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();
    expect(result.output).toContain('next_step:');
    expect(result.output).toContain(BACKGROUND_AGENT_NEXT_STEP);
    expect(result.output).not.toContain('block=false');
    expect(result.output).toContain('resume_hint:');
    expect(result.output).toContain('Agent(resume="agent-child"');
    expect(result.output).toMatch(/agent_id.*not.*task_id|task_id.*not.*agent_id/i);
    expect(result.output).toMatch(/task\.lost|task\.failed|task\.killed/);
    completion.resolve({ summary: 'finished later' });
  });

  it('reports a deliberate user interruption when a foreground subagent is cancelled by the user', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle);
    const controller = new AbortController();

    const resultPromise = executeAgentTool(
      context,
      { prompt: 'Investigate', description: 'Find cause' },
      controller.signal,
    );
    await vi.waitFor(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    controller.abort(userCancellationReason());
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('The subagent was stopped before it finished by user.');
  });

  it('reports the reason when a foreground subagent is stopped for another cause', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener('abort', () => reject(options.signal.reason), {
            once: true,
          });
        }),
    });
    const context = createAgentToolContext(lifecycle);

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    const [task] = context.get(IAgentTaskService).list(false);
    await context.get(IAgentTaskService).stop(task!.taskId, 'Session closed');
    const result = await resultPromise;

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'The subagent was stopped before it finished. Reason: Session closed',
    );
  });

  it('returns the spawned agent id when a foreground subagent times out', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle);

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(DEFAULT_SUBAGENT_TIMEOUT_MS);
    const result = await resultPromise;

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_subagent_type: coder');
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('subagent error: Agent timed out after 2 hours.');
    expect(result.output).toContain('resume_hint:');
    expect(result.output).toContain('Agent(resume="agent-child", prompt="continue")');
    expect(result.output).toContain('do not set subagent_type');
    expect(result.output).toContain('retains its prior context');
  });

  it('honours the configured subagent timeout over the default', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: (_agentId, _request, options) =>
        new Promise((_resolve, reject) => {
          options.signal.addEventListener(
            'abort',
            () => {
              reject(options.signal.reason);
            },
            { once: true },
          );
        }),
    });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: { subagent: { timeoutMs: 1000 } },
    });

    const resultPromise = executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    await vi.waitFor(() => {
      expect(context.get(IAgentTaskService).list(false)).toHaveLength(1);
    });
    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('subagent error: Agent timed out after 1 second.');
  });
});

describe('AgentSwarmToolInputSchema', () => {
  const spawnInput: AgentSwarmToolInput = {
    description: 'Review files',
    prompt_template: 'Review {{item}}',
    items: ['src/a.ts', 'src/b.ts'],
    subagent_type: 'explore',
  };

  it('accepts item-based swarms up to 128 subagents', () => {
    expect(AgentSwarmToolInputSchema.safeParse(spawnInput).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...spawnInput,
        items: Array.from({ length: 128 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(true);
  });

  it('rejects more than 128 item-based subagents in the JSON args schema', () => {
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...spawnInput,
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(false);
  });

  it('allows resumed subagents without item-based spawns', () => {
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume one agent',
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review',
        },
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume two agents',
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review A',
          'agent-old-2': 'Continue previous review B',
        },
      }).success,
    ).toBe(true);
  });

  it('exposes subagent_type and resume_agent_ids parameters', () => {
    const properties = agentSwarmSchemaProperties<{ description?: string }>();

    expect(properties['subagent_type']?.description).toContain('defaults to coder');
    expect(properties['resume_agent_ids']?.description).toContain('Map of existing subagent');
    expect(Object.keys(properties).at(-1)).toBe('resume_agent_ids');
    expect(properties).not.toHaveProperty('run_in_background');
    expect(properties).not.toHaveProperty('timeout');
    expect(properties).not.toHaveProperty('model');
  });
});

describe('AgentSwarm tool description', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  function agentSwarmDescription(): string {
    const tool = ctx.toolsData().find((entry) => entry.name === 'AgentSwarm');
    expect(tool).toBeDefined();
    return tool!.description;
  }

  it('states the enforced input requirements', () => {
    ctx = createTestAgent();

    const description = agentSwarmDescription();

    expect(description).toContain('at least 2');
    expect(description).toContain('{{item}}');
    expect(description.toLowerCase()).toContain('distinct');
    expect(description).toContain('128 subagents');
  });

  it('states AgentSwarm must be the only tool call in a response', () => {
    ctx = createTestAgent();

    expect(agentSwarmDescription()).toContain(
      'If `AgentSwarm` is called, that call must be the only tool call in the response.',
    );
  });
});

describe('AgentSwarm tool execution contract', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
  });

  it('runs item-based swarms through the session swarm service and renders XML results', async () => {
    const runSwarm = vi.fn(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => {
        return args.tasks.map((task, index) => ({
          task,
          agentId: `agent-explore-${String(index + 1)}`,
          status: 'completed' as const,
          result: index === 0 ? 'explore result a' : 'explore result b',
        }));
      },
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmTool(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
        subagent_type: 'explore',
      },
      signal,
    });

    expect(runSwarm).toHaveBeenCalledWith({
      callerAgentId: 'main',
      tasks: [
        {
          kind: 'spawn',
          data: { kind: 'spawn', index: 1, item: 'src/a.ts', prompt: 'Review src/a.ts' },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/a.ts',
          description: 'Review files #1 (explore)',
          swarmIndex: 1,
          swarmItem: 'src/a.ts',
          runInBackground: false,
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
        },
        {
          kind: 'spawn',
          data: { kind: 'spawn', index: 2, item: 'src/b.ts', prompt: 'Review src/b.ts' },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/b.ts',
          description: 'Review files #2 (explore)',
          swarmIndex: 2,
          swarmItem: 'src/b.ts',
          runInBackground: false,
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
        },
      ],
    });
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 2</summary>',
      '<subagent agent_id="agent-explore-1" item="src/a.ts" outcome="completed">explore result a</subagent>',
      '<subagent agent_id="agent-explore-2" item="src/b.ts" outcome="completed">explore result b</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('resumes mapped agents before spawning item subagents', async () => {
    const persistedItems: Record<string, string> = {
      'agent-old-1': 'src/old-a.ts',
      'agent-old-2': 'src/old-b.ts',
    };
    const getSwarmItem = vi.fn(
      async ({ agentId }: { readonly agentId: string }) => persistedItems[agentId],
    );
    const runSwarm = vi.fn(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => {
        return args.tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: `result ${String(index + 1)}`,
        }));
      },
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmTool(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Finish review',
        subagent_type: 'explore',
        prompt_template: 'Review {{item}}',
        items: ['src/new.ts'],
        resume_agent_ids: {
          'agent-old-1': 'Continue previous review A',
          'agent-old-2': 'Continue previous review B',
        },
      },
      signal,
    });

    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-1',
    });
    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-2',
    });
    expect(runSwarm).toHaveBeenCalledWith({
      callerAgentId: 'main',
      tasks: [
        {
          kind: 'resume',
          data: {
            kind: 'resume',
            index: 1,
            agentId: 'agent-old-1',
            item: 'src/old-a.ts',
            prompt: 'Continue previous review A',
          },
          profileName: 'subagent',
          parentToolCallId: 'call_swarm',
          prompt: 'Continue previous review A',
          description: 'Finish review #1 (resume)',
          swarmIndex: 1,
          swarmItem: 'src/old-a.ts',
          runInBackground: false,
          resumeAgentId: 'agent-old-1',
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
        },
        {
          kind: 'resume',
          data: {
            kind: 'resume',
            index: 2,
            agentId: 'agent-old-2',
            item: 'src/old-b.ts',
            prompt: 'Continue previous review B',
          },
          profileName: 'subagent',
          parentToolCallId: 'call_swarm',
          prompt: 'Continue previous review B',
          description: 'Finish review #2 (resume)',
          swarmIndex: 2,
          swarmItem: 'src/old-b.ts',
          runInBackground: false,
          resumeAgentId: 'agent-old-2',
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
        },
        {
          kind: 'spawn',
          data: {
            kind: 'spawn',
            index: 3,
            item: 'src/new.ts',
            prompt: 'Review src/new.ts',
          },
          profileName: 'explore',
          parentToolCallId: 'call_swarm',
          prompt: 'Review src/new.ts',
          description: 'Finish review #3 (explore)',
          swarmIndex: 3,
          swarmItem: 'src/new.ts',
          runInBackground: false,
          signal,
          timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
        },
      ],
    });
    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 3</summary>',
      '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">result 1</subagent>',
      '<subagent mode="resume" agent_id="agent-old-2" item="src/old-b.ts" outcome="completed">result 2</subagent>',
      '<subagent agent_id="agent-new-3" item="src/new.ts" outcome="completed">result 3</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('reports failed subagents inside the XML result without failing the tool', async () => {
    const runSwarm = vi.fn(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => [
        {
          task: args.tasks[0]!,
          agentId: 'agent-coder-1',
          status: 'completed' as const,
          result: 'imports are stable',
        },
        {
          task: args.tasks[1]!,
          agentId: 'agent-coder-2',
          status: 'failed' as const,
          error: 'Agent timed out after 30s.',
        },
      ],
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmTool(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      },
      signal,
    });

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 1, failed: 1</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
      '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('omits the resume hint when incomplete subagents have no agent ids', async () => {
    const runSwarm = vi.fn(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => [
        {
          task: args.tasks[0]!,
          status: 'failed' as const,
          error: 'Agent did not start.',
        },
        {
          task: args.tasks[1]!,
          status: 'failed' as const,
          error: 'Agent also did not start.',
        },
      ],
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmTool(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      },
      signal,
    });

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>failed: 2</summary>',
      '<subagent item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
      '<subagent item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.output).not.toContain('<resume_hint>');
    expect(result.isError).toBeUndefined();
  });

  it('reports partial aborted subagents inside the XML result', async () => {
    const runSwarm = vi.fn(
      async (
        args: SessionSwarmRunArgs<unknown>,
      ): Promise<readonly SessionSwarmRunResult<unknown>[]> => [
        {
          task: args.tasks[0]!,
          agentId: 'agent-coder-1',
          status: 'completed' as const,
          result: 'imports are stable',
        },
        {
          task: args.tasks[1]!,
          agentId: 'agent-coder-2',
          status: 'aborted' as const,
          state: 'started' as const,
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          task: args.tasks[2]!,
          status: 'aborted' as const,
          state: 'not_started' as const,
          error: 'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ],
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(swarmServices(swarmService));

    const result = await executeTool(agentSwarmTool(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      },
      signal,
    });

    expect(result.output).toBe([
      '<agent_swarm_result>',
      '<summary>completed: 1, aborted: 2</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
      '<subagent agent_id="agent-coder-2" item="src/b.ts" state="started" outcome="aborted">The user manually interrupted this subagent batch before this subagent finished.</subagent>',
      '<subagent item="src/c.ts" state="not_started" outcome="aborted">The user manually interrupted this subagent batch before this subagent was started.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
    expect(result.isError).toBeUndefined();
  });

  it('declares broad accesses and does not expose permission rule argument matching', async () => {
    ctx = createTestAgent();

    const execution = await agentSwarmTool(ctx).resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });

    if (execution.isError === true) throw new Error('AgentSwarm resolveExecution returned an error');
    expect(execution.accesses).toEqual(ToolAccesses.all());
    expect(execution.approvalRule).toBe('AgentSwarm');
    expect(execution.matchesRule).toBeUndefined();
    expect(execution.description).toBe('Launching agent swarm: Review files');
    expect(execution.display).toMatchObject({
      kind: 'agent_call',
      agent_name: 'swarm (2 subagents)',
      prompt: 'Review files',
    });
  });

  it('counts resumed and item-based subagents in the display name', async () => {
    ctx = createTestAgent();

    const execution = await agentSwarmTool(ctx).resolveExecution({
      description: 'Finish review',
      prompt_template: 'Review {{item}}',
      items: ['src/new.ts'],
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
        'agent-old-2': 'Continue previous review B',
      },
    });

    if (execution.isError === true) throw new Error('AgentSwarm resolveExecution returned an error');
    expect(execution.display).toMatchObject({
      agent_name: 'swarm (3 subagents)',
      prompt: 'Finish review',
    });
  });
});

describe('Agent tools', () => {
  let context: IAgentContextMemoryService;
  let ctx: TestAgentContext;
  let profile: IAgentProfileService;
  let tools: IAgentToolRegistryService;
  let tempHomeDirs: string[] = [];

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      try {
        await ctx.dispose();
      } finally {
        for (const dir of tempHomeDirs) {
          rmSync(dir, { recursive: true, force: true });
        }
        tempHomeDirs = [];
      }
    }
  });

  describe('PreToolUse blocking', () => {
    let exec: ReturnType<typeof vi.fn>;
    let triggered: Array<[string, string, number]>;

    beforeEach(() => {
      exec = vi.fn<ISessionProcessRunner['exec']>().mockRejectedValue(new Error('Bash should not execute'));
      triggered = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PreToolUse',
            matcher: 'Bash',
            command: "echo 'blocked by PreToolUse' >&2; exit 2",
          },
          {
            event: 'PostToolUseFailure',
            matcher: 'Bash',
            command: 'exit 0',
          },
        ],
        {
          onTriggered: (event, target, count) => {
            triggered.push([event, target, count]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({ processRunner: createFakeProcessRunner({ exec: exec as unknown as ISessionProcessRunner['exec'] }) }),
        externalHookServices(hookEngine),
      );
      context = ctx.get(IAgentContextMemoryService);
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
    });

    it('blocks tools before permission and emits PostToolUseFailure', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'The hook blocked Bash.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Try Bash' }] });

      await ctx.untilTurnEnd();

      expect(exec).not.toHaveBeenCalled();
      expect(triggered).toEqual([
        ['PreToolUse', 'Bash', 1],
        ['PostToolUseFailure', 'Bash', 1],
      ]);
      expect(JSON.stringify(context.get())).toContain('blocked by PreToolUse');
    });
  });

  describe('successful Bash hook flow', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PreToolUse',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PreToolUse',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
            }),
          },
          {
            event: 'PostToolUse',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PostToolUse',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
              toolOutput: 'hook-output',
            }),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({ processRunner: createCommandRunner('hook-output') }),
        externalHookServices(hookEngine),
      );
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
    });

    it('runs PreToolUse before successful tools and emits PostToolUse with output', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash returned hook-output.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

      await ctx.untilTurnEnd();

      await vi.waitFor(() => {
        expect(resolved).toEqual([
          ['PreToolUse', 'Bash', 'allow'],
          ['PostToolUse', 'Bash', 'allow'],
        ]);
      });
    });
  });

  describe('failed Bash hook flow', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PostToolUseFailure',
            matcher: 'Bash',
            command: hookPayloadAssertCommand({
              event: 'PostToolUseFailure',
              toolName: 'Bash',
              toolCallId: 'call_bash',
              toolInputCommand: 'printf hook-output',
              errorMessageIncludes: 'hook-output\nCommand failed with exit code: 2.',
            }),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(
        execEnvServices({ processRunner: createFailingCommandRunner('hook-output') }),
        externalHookServices(hookEngine),
      );
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'auto' });
    });

    it('emits PostToolUseFailure with payload when a builtin tool execution fails', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash failed.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });

      await ctx.untilTurnEnd();

      await vi.waitFor(() => {
        expect(resolved).toEqual([['PostToolUseFailure', 'Bash', 'allow']]);
      });
    });
  });

  describe('Bash tool call start event', () => {
    beforeEach(async () => {
      ctx = createTestAgent(execEnvServices({ processRunner: createCommandRunner('ok') }));
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Bash'] });
      await ctx.rpc.setPermission({ mode: 'yolo' });
    });

    it('uses builtin descriptions on tool call start events', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will run Bash.' }, bashCall());
      ctx.mockNextResponse({ type: 'text', text: 'Bash returned ok.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Run Bash' }] });
      await ctx.untilTurnEnd();

      const started = ctx.allEvents.find(
        (event) => event.type === '[rpc]' && event.event === 'tool.call.started',
      );
      expect(started?.args).toMatchObject({
        description: 'Running: printf hook-output',
      });
    });
  });

  describe('foreground Agent tool recovery', () => {
    beforeEach(() => {
      const lifecycle = createAgentLifecycleStub({
        createAgentIds: ['agent-child'],
        runCompletion: async () => {
          throw new Error('Subagent turn failed before completing its final summary: reason=max_tokens');
        },
      });
      ctx = createTestAgent(
        sessionService(IAgentLifecycleService, lifecycle),
        sessionService(ISessionSubagentService, lifecycle),
        sessionService(ISessionCronService, cronStub),
      );
      lifecycle.addHandle('main', 'agent');
    });

    it('continues after a foreground Agent tool returns a max_tokens failure', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will delegate.' }, agentCall());
      ctx.mockNextResponse({ type: 'text', text: 'I recovered from the subagent failure.' });

      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Use an agent' }] });
      await ctx.untilTurnEnd();

      expect(ctx.contextData().history).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            role: 'tool',
            toolCallId: 'call_agent',
            content: [
              expect.objectContaining({
                text: expect.stringContaining('reason=max_tokens'),
              }),
            ],
          }),
          expect.objectContaining({
            role: 'assistant',
            content: [
              expect.objectContaining({
                text: 'I recovered from the subagent failure.',
              }),
            ],
          }),
        ]),
      );
    });

    it('fails an agent run when the final summary is truncated', async () => {
      await ctx.dispose();
      ctx = createTestAgent();
      ctx.mockNextProviderResponse({
        parts: [{ type: 'text', text: 'partial summary' }],
        finishReason: 'truncated',
        rawFinishReason: 'length',
      });

      const run = await runAgentTurn(
        currentAgentHandle(ctx, 'agent-child'),
        { kind: 'prompt', prompt: 'Investigate' },
        { signal },
      );

      await expect(run.completion).rejects.toThrow(
        'Subagent turn failed before completing its final summary: reason=max_tokens',
      );
    });
  });

  describe('registered user tool failure hooks', () => {
    let resolved: Array<[string, string, string]>;

    beforeEach(async () => {
      const lookupCall: ToolCall = {
        type: 'function',
        id: 'call_lookup',
        name: 'Lookup',
        arguments: '{"query":"moon"}',
      };
      resolved = [];
      const hookEngine = makeHookRunner(
        [
          {
            event: 'PostToolUseFailure',
            matcher: 'Lookup',
            command: hookErrorMessageAssertCommand('rich failure text'),
          },
        ],
        {
          onResolved: (event, target, action) => {
            resolved.push([event, target, action]);
          },
        },
      );
      ctx = createTestAgent(externalHookServices(hookEngine));
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
    });

    it('passes text from content-part error outputs to PostToolUseFailure hooks', async () => {
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await ctx.untilToolCall({
        isError: true,
        output: [{ type: 'text', text: 'rich failure text' }],
      });

      ctx.mockNextResponse({ type: 'text', text: 'The lookup failed.' });
      await ctx.untilTurnEnd();

      await vi.waitFor(() => {
        expect(resolved).toEqual([['PostToolUseFailure', 'Lookup', 'allow']]);
      });
    });
  });

  describe('active builtin tool set', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['Write', 'Bash'] });
    });

    it('uses the active builtin tool set as the LLM visible tools', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'ready' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Which tools are active?' }] });

      await ctx.untilTurnEnd();
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      system: <system-prompt>
      tools: Bash, Write
      messages:
        user: text "Which tools are active?"
    `);
    });
  });

  describe('Bash background mode', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      tools = ctx.get(IAgentToolRegistryService);
      profile.update({ activeToolNames: ['Bash'] });
    });

    it('disables Bash background mode unless task management tools are active', async () => {
      const bashOnly = ctx.toolsData().find((tool) => tool.name === 'Bash');
      const bashTool = tools.resolve('Bash');
      expect(bashOnly).toBeDefined();
      expect(bashTool).toBeDefined();
      expect(bashOnly!.description).toContain('Background execution is disabled for this agent.');
      expect(bashOnly!.description).not.toContain('the command will be started as a background task');
      await expect(
        executeTool(bashTool!, {
          turnId: 0,
          toolCallId: 'call_bash',
          args: { command: 'sleep 10', run_in_background: true, description: 'watch' },
          signal,
        }),
      ).resolves.toMatchObject({
        isError: true,
        output:
          'Background execution is not available for this agent because TaskOutput and TaskStop are not enabled.',
      });

      await ctx.rpc.setActiveTools({ names: ['Bash', 'TaskList', 'TaskOutput', 'TaskStop'] });

      const managedBash = ctx.toolsData().find((tool) => tool.name === 'Bash');
      expect(managedBash).toBeDefined();
      expect(managedBash!.description).toContain('run_in_background=true');
    });
  });

  describe('AgentSwarm visibility', () => {
    beforeEach(() => {
      ctx = createTestAgent();
      profile = ctx.get(IAgentProfileService);
      profile.update({ activeToolNames: ['AgentSwarm'] });
    });

    it('exposes AgentSwarm by default', () => {
      expect(ctx.toolsData().some((tool) => tool.name === 'AgentSwarm')).toBe(true);
    });
  });

  describe('registered user tools', () => {
    const lookupCall: ToolCall = {
      type: 'function',
      id: 'call_lookup',
      name: 'Lookup',
      arguments: '{"query":"moon"}',
    };

    beforeEach(async () => {
      ctx = createTestAgent();
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a short test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });
    });

    it('routes registered user tools through tool.call request/response', async () => {
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      expect(
        await ctx.untilToolCall({
          content: 'moon-result',
          output: 'moon-result',
        }),
      ).toMatchInlineSnapshot(`
        [wire] permission.set_mode         { "mode": "auto", "time": "<time>" }
        [wire] tools.register_user_tool    { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "time": "<time>" }
        [wire] turn.prompt                 { "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "time": "<time>" }
        [emit] turn.started                { "turnId": 0, "origin": { "kind": "user" }, "prompt": "Look up moon" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.spliced             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" } ] }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-1>" }, "time": "<time>" }
        [emit] context.spliced             { "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } } ] }
        [wire] context.append_message      { "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
        [emit] turn.step.started           { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot          { "hash": "92a8bdb82c804599152bf21a019f2f310e632d9a9b3ee460565e76b5eee68774", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.\\n\\nWriting the prompt:\\n- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n- Subagents use a fixed 2-hour timeout. If one times out, resume the same agent instead of starting over.\\n\\nWhen NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nWhen \`run_in_background=true\`, the subagent runs detached from this turn. The completion arrives in a later turn as a synthetic user-role message containing its result — you do not need to poll, sleep, or check on its progress. Continue with other work or respond to the user. Never fabricate or predict what the result will say.\\n\\nDefault to a foreground subagent (omit \`run_in_background\`) when your next step needs its result — foreground hands the result straight back. Reach for \`run_in_background=true\` only when you have other work to do while it runs and do not need its result to proceed. Never launch in the background and then immediately wait on it (with \`TaskOutput block=true\`, sleeping, or otherwise): that just blocks the turn for no benefit — run it in the foreground instead.\\n\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL\\n- agent: Default Kimi Code agent\\n  Tools: Read, Write, Edit, Grep, Glob, Bash, TaskList, TaskOutput, TaskStop, CronCreate, CronList, CronDelete, ReadMediaFile, TodoList, Skill, WebSearch, Agent, AgentSwarm, FetchURL, AskUserQuestion, EnterPlanMode, ExitPlanMode, CreateGoal, GetGoal, SetGoalBudget, UpdateGoal, mcp__*\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Agent, AgentSwarm, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, ReadMediaFile, Skill, TaskList, TaskOutput, TaskStop, TodoList, WebSearch, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. \\"src/**/*.yaml\\"), search code for keywords (e.g. \\"database connection\\"), or answer questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.\\n  Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false } }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in \`items\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false } }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Users always have an \\"Other\\" option for custom input — don't create one yourself\\n- Use multi_select to allow multiple answers to be selected for a question\\n- Keep option labels concise (1-5 words), use descriptions for trade-offs and details\\n- Each question should have 2-4 meaningful, distinct options\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- You can ask 1-4 questions at a time; group related questions to minimize interruptions\\n- If you recommend a specific option, list it first and append \\"(Recommended)\\" to its label\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false } }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nIf \`run_in_background=true\`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short \`description\`. Background commands default to a 600s timeout and \`timeout\` is capped at 86400s; set \`disable_timeout=true\` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use \`TaskOutput\` only for a non-blocking status/output snapshot — do not set \`block=true\` to wait for a task you just launched, since its completion arrives automatically; reserve \`block=true\` for when the user explicitly asked you to wait. Use \`TaskStop\` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the \`/tasks\` command, which opens an interactive panel; it has no subcommands.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to 60s and allow up to 300s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Prefer \`run_in_background=true\` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } }, { "name": "CreateGoal", "description": "Create a durable, structured goal that the runtime will pursue across multiple turns.\\n\\nCall \`CreateGoal\` only when:\\n\\n- the user explicitly asks you to start a goal or work autonomously toward an outcome, or\\n- a host goal-intake prompt asks you to create one.\\n\\nDo NOT create a goal for greetings, ordinary questions, or vague requests that lack a\\nverifiable completion condition. A goal needs a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion before creating\\nthe goal. If the user clearly insists after you warn them that the wording is vague or risky,\\nrespect that and create the goal.\\n\\nInclude a \`completionCriterion\` when the user provides one, or when it can be stated without\\ninventing new requirements. Keep \`objective\` concise; reference long task descriptions by file\\npath rather than pasting them.\\n\\nCreating a goal fails if one already exists, so use \`replace: true\` only when the user explicitly\\nwants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false } }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash \`sed\`.\\n- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed \`old_string\`.\\n- Take \`old_string\` and \`new_string\` from the Read output view.\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context. Use \`replace_all\` only when every occurrence should change — for example, renaming a symbol throughout the file.\\n- Multiple Edit calls may run in one response only when they do not target the same file.\\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's \`old_string\`, causing \`old_string not found\`. Read the file again before the next Edit.\\n- A write lock serializes same-file edits in response order, but serialization does not make stale \`old_string\` valid.\\n- For pure CRLF files, Read shows LF; use LF in \`old_string\` and \`new_string\`, and Edit writes CRLF back.\\n- For mixed endings or lone carriage returns, Read shows carriage returns as \\\\r; include actual \\\\r escapes in those positions.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false } }, { "name": "EnterPlanMode", "description": "Use this tool proactively when you're about to start a non-trivial implementation task.\\nGetting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.\\n\\nUse it when ANY of these conditions apply:\\n\\n1. New Feature Implementation - e.g. \\"Add a caching layer to the API\\"\\n2. Multiple Valid Approaches - e.g. \\"Optimize database queries\\" (indexing vs rewrite vs caching)\\n3. Code Modifications - e.g. \\"Refactor auth module to support OAuth\\"\\n4. Architectural Decisions - e.g. \\"Add WebSocket support\\"\\n5. Multi-File Changes - involves more than 2-3 files\\n6. Unclear Requirements - need exploration to understand scope\\n7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision\\n\\nPermission mode notes:\\n- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.\\n- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.\\n- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, ExitPlanMode exits plan mode without asking the user.\\n- Use EnterPlanMode only when planning itself adds value.\\n\\nWhen NOT to use:\\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\\n- User gave very specific, detailed instructions\\n- Pure research/exploration tasks\\n\\nOnce you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → \`ExitPlanMode\`) and enforces read-only access. For non-trivial tasks where you are unsure of the codebase structure or relevant code paths, use \`Agent(subagent_type=\\"explore\\")\` to investigate first when the \`Agent\` tool is available.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "ExitPlanMode", "description": "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\\n\\n## How This Tool Works\\n- You should have already written your plan to the plan file specified in the plan mode reminder.\\n- This tool does NOT take the plan content as a parameter - it reads the plan from the file you wrote.\\n- The user will see the contents of your plan file when they review it. In auto permission mode, the tool reads the file and exits plan mode without asking the user.\\n\\n## When to Use\\nOnly use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.\\n\\n## What a good plan contains\\nList specific, verifiable steps grounded in the actual codebase — real files, functions, and commands, in a sensible order. Each step should be concrete enough to act on and to check. Avoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what to change and where.\\n\\n## Multiple Approaches\\nIf your plan offers multiple alternative approaches, pass them via the \`options\` parameter so the user can choose which one to execute — see the \`options\` parameter for the format, count, and reserved labels. In yolo and manual modes the user sees all options alongside the host's Reject and Revise controls.\\n\\n## Before Using\\n- In auto permission mode, do NOT use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, this tool exits plan mode without asking the user.\\n- In yolo and manual modes, this tool still presents the plan to the user for approval.\\n- If auto permission mode is not active and you have unresolved questions, use AskUserQuestion first.\\n- If auto permission mode is not active and you have multiple approaches and haven't narrowed down yet, consider using AskUserQuestion first to let the user choose, then write a plan for the chosen approach only.\\n- Once your plan is finalized, use THIS tool to request approval.\\n- Do NOT use AskUserQuestion to ask \\"Is this plan OK?\\" or \\"Should I proceed?\\" - that is exactly what ExitPlanMode does.\\n- If rejected, revise based on feedback and call ExitPlanMode again.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false } }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens,\\ntime, and how much of each remains). When the goal has stopped, it also reports the terminal reason.\\n\\nUse \`GetGoal\` before deciding whether to continue working, report completion, report a blocker,\\nor respect a pause. It returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Respects \`.gitignore\`, \`.ignore\`, and \`.rgignore\` by default — set \`include_ignored\` to also match ignored files (e.g. build outputs, \`node_modules\`). Sensitive files (such as \`.env\`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — all files matching an extension, at any depth below the search root (a bare pattern without \`/\` matches recursively)\\n- \`src/*.ts\` — files directly inside \`src/\` (one level, not recursive)\\n- \`src/**/*.ts\` — recursive walk with a subdirectory anchor and extension\\n- \`**/*.py\` — recursive walk from the search root for an extension\\n- \`*.{ts,tsx}\` — brace expansion is supported\\n- \`{src,test}/**/*.ts\` — cartesian brace expansion is supported too\\n\\nResults are capped at the first 100 matching paths. If a search would return more, a truncation marker is appended. Refine the pattern (extension, subdirectory) when 100 is not enough, or call again with a narrower anchor.\\n\\nLarge-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when \`include_ignored\` is set:\\n- \`node_modules/**/*.js\`, \`.venv/**/*.py\`, \`__pycache__/**\`, \`target/**\` can produce thousands of results that truncate at the match cap and waste context. Prefer specific subpaths like \`node_modules/react/src/**/*.js\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep when the task is to find unknown content or unknown file locations. Do not use shell \`grep\` or \`rg\` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.\\nALWAYS use Grep tool instead of running \`grep\` or \`rg\` from a shell — direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.\\nIf you already know a concrete file path and need to inspect its contents, use Read directly instead.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files (dotfiles such as \`.gitlab-ci.yml\` or \`.eslintrc.json\`) are searched by default. To also search files excluded by \`.gitignore\` (such as \`node_modules\` or build outputs), set \`include_ignored\` to \`true\`. Sensitive files (such as \`.env\`) are always skipped for safety, even when \`include_ignored\` is \`true\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false } }, { "name": "Read", "description": "Read a text file from the local filesystem.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use \`ls\` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use \`Grep\` only when the task is to search for unknown content or locations.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Returns up to 1000 lines or 100 KB per call, whichever comes first; lines longer than 2000 chars are truncated mid-line.\\n- Page larger files with \`line_offset\` (1-based start line) and \`n_lines\`. Omit \`n_lines\` to read up to the 1000-line cap.\\n- Sensitive files (\`.env\` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: \`.env.example\` / \`.env.sample\` / \`.env.template\` and public SSH keys such as \`id_rsa.pub\` read normally.\\n- Only UTF-8 text files can be read. Non-UTF-8 encodings, binary files, and files containing NUL bytes are refused; use \`ReadMediaFile\` for images or video, and Bash or an MCP tool for other binary formats.\\n- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed 1000.\\n- Output format: \`<line-number>\\\\t<content>\` per line.\\n- A \`<system>...</system>\` status block is appended after the file content; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.\\n- Pure CRLF files are displayed with LF line endings; \`Edit\` matches this output and preserves CRLF when writing back.\\n- Mixed or lone carriage-return line endings are shown as \`\\\\r\` and require exact \`Edit.old_string\` escapes.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -1000, "maximum": -1 } ] }, "n_lines": { "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false } }, { "name": "SetGoalBudget", "description": "Set a hard budget limit for the current goal.\\n\\nUse this only when the user clearly gives a runtime limit, such as:\\n\\n- \\"stop after 20 turns\\"\\n- \\"use no more than 500k tokens\\"\\n- \\"finish within 30 minutes\\"\\n\\nDo not invent limits. Do not call this for vague wording such as \\"spend some time\\" or\\n\\"try to be quick\\".\\n\\nIf the user gives a compound time, convert it to one supported unit before calling this tool.\\nFor example, \\"2 hours and 3 minutes\\" can be set as \`value: 123, unit: \\"minutes\\"\`.\\n\\nA time budget must be between 1 second and 24 hours — the tool rejects anything shorter or\\nlonger, telling the user it is not a reasonable goal budget. Turn and token budgets are not\\nbounded this way; they must be positive and are rounded to the nearest whole number (minimum 1).\\n\\nSupported units:\\n\\n- \`turns\`\\n- \`tokens\`\\n- \`milliseconds\`\\n- \`seconds\`\\n- \`minutes\`\\n- \`hours\`\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false } }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<kimi-skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, spelled as it appears in the current skill listing (e.g. \\"commit\\", \\"pdf\\")." }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false } }, { "name": "TaskList", "description": "List background tasks and their current status.\\n\\nUse this tool to discover which background tasks exist and where each one\\nstands. It is the entry point for inspecting background work: it returns a\\ntask ID, status, and description for every task it reports, plus the command,\\nPID, and (once finished) exit code for shell tasks, and a stop reason for any\\ntask that ended early.\\n\\nGuidelines:\\n\\n- After a context compaction, or whenever you are unsure which background\\n  tasks are running or what their task IDs are, call this tool to\\n  re-enumerate them instead of guessing a task ID.\\n- Prefer the default \`active_only=true\`, which lists only non-terminal tasks.\\n  Pass \`active_only=false\` only when you specifically need to see tasks that\\n  have already finished. With \`active_only=false\` the result may also include\\n  \`lost\` tasks — tasks left over from a previous process that can no longer be\\n  inspected or controlled; treat them as already terminated.\\n- \`limit\` caps how many tasks are returned. It accepts a value between 1 and\\n  100 and defaults to 20 when omitted.\\n- This tool only lists tasks; it does not return their output. Use it first\\n  to locate the task ID you need, then call \`TaskOutput\` with that ID to read\\n  the task's output and details.\\n- This tool is read-only and does not change any state, so it is always safe\\n  to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "TaskOutput", "description": "Retrieve a snapshot of a running or completed background task.\\n\\nUse this after \`Bash(run_in_background=true)\` or \`Agent(run_in_background=true)\` to check progress, or to read the output of a task that has already completed.\\n\\nGuidelines:\\n- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.\\n- By default this tool is non-blocking and returns a current status/output snapshot — that is the normal way to use it.\\n- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.\\n- Use block=true only when the user explicitly asked you to wait for the task. Never block on a task you launched in the current turn — if you need its result right away, it should have been a foreground call.\\n- If a block=true call returns \`retrieval_status: timeout\` (the task is still running), do not block on the same task again. Continue with other work or hand back to the user — the completion notification arrives on its own.\\n- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.\\n- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports \`status: completed\` on a zero exit, or \`status: failed\` with its non-zero \`exit_code\` — judge that failure from the \`exit_code\`, because a plain command failure carries no \`stop_reason\` and no \`terminal_reason\`. \`terminal_reason\` is a categorical label emitted only when the end is not an ordinary exit: \`timed_out\` when the deadline aborted it, \`stopped\` when it was explicitly stopped, or \`failed\` when it errored without producing an exit code; the \`stopped\` and \`failed\` cases also carry a human-readable \`stop_reason\`. A task that finished on its own with a clean exit carries neither \`stop_reason\` nor \`terminal_reason\`.\\n- The full, never-truncated log is always available at output_path; use the \`Read\` tool with that path to page through it, whether or not the preview was truncated.\\n- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." }, "block": { "default": false, "description": "Whether to wait for the task to finish before returning. Discouraged — background tasks notify automatically on completion; use only when the user explicitly asked you to wait.", "type": "boolean" }, "timeout": { "default": 30, "description": "Maximum number of seconds to wait when block=true.", "type": "integer", "minimum": 0, "maximum": 3600 } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n- Before starting a tracked task, mark exactly one item as \`in_progress\`\\n- Immediately after finishing a tracked task, mark it \`done\`; do not batch completions at the end\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Avoid churn:**\\n- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.\\n- When unsure of the current state, call query mode first (omit \`todos\`) to check the list before deciding what to update.\\n- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Update statuses as you make progress.\\n- When work is underway, keep exactly one task \`in_progress\`.\\n- Only mark a task \`done\` when it is fully accomplished.\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "UpdateGoal", "description": "Set the status of the current goal. This is how you resume, complete, or block an autonomous goal.\\n\\n- \`active\` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.\\n- \`complete\` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded. Before using this, verify the current state against the actual objective and every explicit requirement. Treat weak or indirect evidence as not complete. Do not use \`complete\` merely because a budget is nearly exhausted or you want to stop.\\n- \`blocked\` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, do not use \`blocked\` the first time you hit the blocker. The same blocking condition must repeat for at least 3 consecutive goal turns before you call \`blocked\`, counting the original/user-triggered turn and automatic continuations. If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call \`blocked\` in the same turn instead of running more goal turns. Do not use \`blocked\` because the work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns. Once the 3-turn threshold is met and you cannot make meaningful progress without user input or an external-state change, call \`blocked\` instead of leaving the goal active.\\n\\nMost active goal turns should not call this tool. If you complete one useful slice of work and material work remains, end the turn normally without calling UpdateGoal; the runtime will prompt you to continue in the next goal turn. Call \`complete\` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call \`complete\` after only producing a plan, summary, first pass, or partial result. Call \`blocked\` only after the blocked audit threshold is met. If you call \`blocked\`, you will be prompted to explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false } }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Missing parent directories are created automatically (like \`mkdir(parents=True, exist_ok=True)\`).\\n- Mode defaults to overwrite; append adds content at EOF without adding a newline.\\n- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead.\\n- Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old contents.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false } } ], "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "92a8bdb82c804599152bf21a019f2f310e632d9a9b3ee460565e76b5eee68774", "messageCount": 2, "turnStep": "0.1", "time": "<time>" }
        [emit] assistant.delta             { "turnId": 0, "delta": "I will look it up." }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] tool.call.delta             { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "contextTokens": 160 }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
        [emit] tool.call.started           { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "tool_call", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [ { "toolCallId": "call_lookup", "name": "Lookup", "since": "<time>" } ], "since": "<time>" }, "background": [] }
        [emit] toolCall                    { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        system: <system-prompt>
        tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Lookup, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, Write
        messages:
          user: text "Look up moon"
          user: text <auto-mode-enter-reminder>
      `);

      ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [wire] context.append_loop_event   { "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
        [emit] tool.result                 { "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_lookup", "result": { "output": "moon-result" } }, "time": "<time>" }
        [emit] turn.step.completed         { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 144, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [wire] llm.request                 { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "92a8bdb82c804599152bf21a019f2f310e632d9a9b3ee460565e76b5eee68774", "messageCount": 4, "turnStep": "0.2", "time": "<time>" }
        [emit] assistant.delta             { "turnId": 0, "delta": "The lookup result is moon-result." }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                { "model": "mock-model", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated        { "usage": { "byModel": { "mock-model": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 308, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated        { "contextTokens": 176 }
        [emit] turn.step.completed         { "turnId": 0, "step": 2, "stepId": "<uuid-4>", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated      { "lifecycle": "ready", "turn": { "turnId": 0, "origin": { "kind": "user" }, "phase": "running", "step": 2, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event   { "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The lookup result is moon-result." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 164, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [emit] turn.ended                  { "turnId": 0, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
      messages:
        <last>
        assistant: text "I will look it up."  calls call_lookup:Lookup { "query": "moon" }
        tool[call_lookup]: text "moon-result"
    `);
      await ctx.rpc.unregisterTool({ name: 'Lookup' });
      ctx.mockNextResponse({ type: 'text', text: 'No lookup tool is available.' });
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Can you still use Lookup?' }] });

      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [emit] agent.activity.updated       { "lifecycle": "ready", "lastTurn": { "turnId": 0, "reason": "completed", "at": "<time>" }, "background": [] }
        [wire] tools.unregister_user_tool   { "name": "Lookup", "time": "<time>" }
        [emit] prompt.completed             { "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed" }
        [wire] turn.prompt                  { "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "time": "<time>" }
        [emit] turn.started                 { "turnId": 1, "origin": { "kind": "user" }, "prompt": "Can you still use Lookup?" }
        [emit] agent.activity.updated       { "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 0, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [emit] context.spliced              { "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-2>" } ] }
        [wire] context.append_message       { "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "origin": { "kind": "user" }, "id": "<msg-2>" }, "time": "<time>" }
        [emit] turn.step.started            { "turnId": 1, "step": 1, "stepId": "<uuid-6>" }
        [emit] agent.activity.updated       { "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event    { "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "1", "step": 1 }, "time": "<time>" }
        [wire] llm.tools_snapshot           { "hash": "a76c3f1cc39da5735f85181eba5c128cd06001982f440e6721aaa8bf750c13d8", "tools": [ { "name": "Agent", "description": "Launch a subagent to handle a task. The subagent runs as a same-process loop instance with its own context and wire file. Delegating also keeps the bulk of intermediate file contents out of your own context — you get a conclusion back instead of a pile of dumps.\\n\\nWriting the prompt:\\n- The subagent starts with zero context — it has not seen this conversation. Brief it like a colleague who just walked into the room: state the goal, list what you already know, hand over the specifics.\\n- Lookups (read this file, run that test): put the exact path or command in the prompt. The subagent should not have to search for things you already know.\\n- Investigations (figure out X, find why Y): give the question, not prescribed steps — fixed steps become dead weight when the premise is wrong.\\n- Do not delegate understanding. If the task hinges on a file path or line number, find it yourself first and write it into the prompt.\\n\\nUsage notes:\\n- When the task continues earlier work a subagent already did, prefer resuming that agent (pass its \`resume\` id) over spawning a fresh instance — the resumed agent keeps its prior context.\\n- A subagent's result is only visible to you, not to the user. When the user needs to see what a subagent produced, summarize the relevant parts yourself in your own reply.\\n- Subagents use a fixed 2-hour timeout. If one times out, resume the same agent instead of starting over.\\n\\nWhen NOT to use Agent: skip delegation for trivial work you can do directly — reading a file whose path you already know, searching a small known set of files, or any task that takes only a step or two. Delegation has a context-handoff cost; it pays off only when the task is substantial enough to outweigh it.\\n\\nOnce a subagent is running, leave that scope to it: do not redo its searches or reads in parallel, and do not abandon it midway and finish the job manually. Both undo the context savings the delegation was meant to buy.\\n\\n\\nWhen \`run_in_background=true\`, the subagent runs detached from this turn. The completion arrives in a later turn as a synthetic user-role message containing its result — you do not need to poll, sleep, or check on its progress. Continue with other work or respond to the user. Never fabricate or predict what the result will say.\\n\\nDefault to a foreground subagent (omit \`run_in_background\`) when your next step needs its result — foreground hands the result straight back. Reach for \`run_in_background=true\` only when you have other work to do while it runs and do not need its result to proceed. Never launch in the background and then immediately wait on it (with \`TaskOutput block=true\`, sleeping, or otherwise): that just blocks the turn for no benefit — run it in the foreground instead.\\n\\n\\nAvailable agent types (pass via subagent_type):\\n- plan: Read-only implementation planning and architecture design. Use this agent when the parent agent needs a step-by-step implementation plan, key file identification, and architectural trade-off analysis before code changes are made.\\n  Tools: Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL\\n- agent: Default Kimi Code agent\\n  Tools: Read, Write, Edit, Grep, Glob, Bash, TaskList, TaskOutput, TaskStop, CronCreate, CronList, CronDelete, ReadMediaFile, TodoList, Skill, WebSearch, Agent, AgentSwarm, FetchURL, AskUserQuestion, EnterPlanMode, ExitPlanMode, CreateGoal, GetGoal, SetGoalBudget, UpdateGoal, mcp__*\\n- coder: General software engineering agent — the only subagent type with file-editing tools; use it for any delegated task that must modify code. Use this agent for non-trivial software engineering work that may require reading files, editing code, running commands, and returning a compact but technically complete summary to the parent agent.\\n  Tools: Agent, AgentSwarm, Bash, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, Glob, Grep, Read, ReadMediaFile, Skill, TaskList, TaskOutput, TaskStop, TodoList, WebSearch, FetchURL, Write, mcp__*\\n- explore: Fast codebase exploration with prompt-enforced read-only behavior. Fast agent specialized for exploring codebases. Use this when you need to quickly find files by patterns (e.g. \\"src/**/*.yaml\\"), search code for keywords (e.g. \\"database connection\\"), or answer questions about the codebase (e.g. \\"how does the auth module work?\\"). When calling this agent, specify the desired thoroughness level: \\"quick\\" for basic searches, \\"medium\\" for moderate exploration, or \\"thorough\\" for comprehensive analysis across multiple locations and naming conventions. Use this agent for any read-only exploration that will clearly require more than 3 search queries. Prefer launching multiple explore agents concurrently when investigating independent questions.\\n  Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "prompt": { "type": "string", "description": "Full task prompt for the subagent" }, "description": { "type": "string", "description": "Short task description (3-5 words) for UI display" }, "subagent_type": { "description": "One of the available agent types (see \\"Available agent types\\" in this tool description). Defaults to \\"coder\\" when omitted.", "type": "string" }, "resume": { "description": "Optional agent ID to resume instead of creating a new instance. When set, do not also pass subagent_type — the resumed agent keeps its own type, and supplying both is rejected.", "type": "string" }, "run_in_background": { "description": "If true, return immediately without waiting for completion. Prefer false unless the task can run independently and there is a clear benefit to not waiting.", "type": "boolean" } }, "required": [ "prompt", "description" ], "additionalProperties": false } }, { "name": "AgentSwarm", "description": "Launch multiple subagents from one prompt template, existing agent resumes, or both.\\n\\nUse AgentSwarm when many subagents should run the same kind of task over different inputs. The placeholder is exactly \`{{item}}\`. For example, with \`prompt_template\` set to \`Review {{item}} for likely regressions.\` and \`items\` set to \`[\\"src/a.ts\\", \\"src/b.ts\\"]\`, AgentSwarm launches two new subagents with those two concrete prompts. For a few differently-shaped tasks, make separate \`Agent\` calls in one message instead.\\n\\nUse \`resume_agent_ids\` to continue subagents that already exist from earlier work, such as ones that failed or timed out: map each agent id to the prompt for that resumed subagent (usually \`continue\` if no extra information is needed). You may combine \`resume_agent_ids\` with \`items\` in the same call to resume existing subagents and launch new ones. Do not duplicate resumed work in \`items\`.\\n\\nEach of these is enforced — a violation is rejected before any subagent starts: provide at least 2 \`items\` unless you pass \`resume_agent_ids\`; whenever \`items\` are present, \`prompt_template\` is required and must contain \`{{item}}\`; and the filled-in prompts must be distinct (two items that expand to the same prompt are rejected).\\n\\nUse enough subagents to keep the work focused and parallel. AgentSwarm supports up to 128 subagents, and launches are queued automatically, so it is safe to split large tasks into many clear, independent items.\\n\\nIf \`AgentSwarm\` is called, that call must be the only tool call in the response.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "description": { "type": "string", "minLength": 1, "description": "Short description for the whole swarm." }, "subagent_type": { "description": "Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.", "type": "string", "minLength": 1 }, "prompt_template": { "description": "Prompt template for each subagent. The {{item}} placeholder is replaced with each item value.", "type": "string", "minLength": 1 }, "items": { "description": "Values used to fill {{item}}. Each item launches one new subagent.", "maxItems": 128, "type": "array", "items": { "type": "string", "minLength": 1 } }, "resume_agent_ids": { "description": "Map of existing subagent agent_id to the prompt used to resume that subagent. These resumed subagents are launched before new item-based subagents.", "type": "object", "propertyNames": { "type": "string", "minLength": 1 }, "additionalProperties": { "type": "string", "minLength": 1 } } }, "required": [ "description" ], "additionalProperties": false } }, { "name": "AskUserQuestion", "description": "Use this tool when you need to ask the user questions with structured options during execution. This allows you to:\\n1. Collect user preferences or requirements before proceeding\\n2. Resolve ambiguous or underspecified instructions\\n3. Let the user decide between implementation approaches as you work\\n4. Present concrete options when multiple valid directions exist\\n\\n**When NOT to use:**\\n- When you can infer the answer from context — be decisive and proceed\\n- Trivial decisions that don't materially affect the outcome\\n\\nOverusing this tool interrupts the user's flow. Only use it when the user's input genuinely changes your next action.\\n\\n**Usage notes:**\\n- Users always have an \\"Other\\" option for custom input — don't create one yourself\\n- Use multi_select to allow multiple answers to be selected for a question\\n- Keep option labels concise (1-5 words), use descriptions for trade-offs and details\\n- Each question should have 2-4 meaningful, distinct options\\n- Question texts must be unique across the call, and option labels must be unique within each question\\n- You can ask 1-4 questions at a time; group related questions to minimize interruptions\\n- If you recommend a specific option, list it first and append \\"(Recommended)\\" to its label\\n- The result is JSON with an \`answers\` object keyed by question text; each value is the chosen option's label (comma-separated labels for multi_select, or the user's own words if they picked \\"Other\\"); if \`answers\` is empty and a \`note\` says the user dismissed it, they chose not to answer — do not treat this as selecting the recommended option; decide based on context and do not re-ask the same question\\n- Set background=true when you can keep working without the answer. This starts a background question task and returns a task_id immediately. The answer arrives automatically in a later turn — you do not need to poll, sleep, or check on it. Continue with other work; never fabricate or predict the answer.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "questions": { "minItems": 1, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "question": { "type": "string", "minLength": 1, "description": "A specific, actionable question. End with '?'." }, "header": { "default": "", "description": "Short category tag (max 12 chars, e.g. 'Auth', 'Style').", "type": "string" }, "options": { "minItems": 2, "maxItems": 4, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "description": "Concise display text (1-5 words). If recommended, append '(Recommended)'." }, "description": { "default": "", "description": "Brief explanation of trade-offs or implications.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false }, "description": "2-4 meaningful, distinct options. Do NOT include an 'Other' option — the system adds one automatically." }, "multi_select": { "default": false, "description": "Whether the user can select multiple options.", "type": "boolean" } }, "required": [ "question", "options" ], "additionalProperties": false }, "description": "The questions to ask the user (1-4 questions)." }, "background": { "default": false, "description": "Set true to ask in the background and return immediately with a background task_id; you are notified automatically when the user answers — do not poll with TaskOutput while the question is pending.", "type": "boolean" } }, "required": [ "questions" ], "additionalProperties": false } }, { "name": "Bash", "description": "Execute a \`bash\` command. Use this for shell semantics — pipes, env, processes, git, package managers, build/test runners, anything genuinely interactive or multi-step.\\n\\n**Translate these to a dedicated tool instead:**\\n- \`cat\` / \`head\` / \`tail\` (known path) → \`Read\`\\n- \`sed\` / \`awk\` (in-place edit) → \`Edit\`\\n- \`echo > file\` / \`cat <<EOF\` → \`Write\`\\n- \`find\` / recursive \`ls\` to locate files by name pattern → \`Glob\` (plain \`ls <known-directory>\` is fine for listing a directory)\\n- \`grep\` / \`rg\` (search file contents) → \`Grep\`\\n- \`echo\` / \`printf\` (talk to the user) → just output text directly\\n\\nThe dedicated tools render in the per-tool permission UI and keep raw stdout out of the conversation; that is why they are worth reaching for whenever one fits.\\n\\n**Output:**\\nThe stdout and stderr will be combined and returned as a string. The output may be truncated if it is too long. If the command exits non-zero, the output ends with a \`Command failed with exit code: N\` line; a command killed by its timeout or interrupted by the user ends with its own message instead.\\n\\nIf \`run_in_background=true\`, the command will be started as a background task and this tool will return a task ID instead of waiting for command completion. When doing that, you must provide a short \`description\`. Background commands default to a 600s timeout and \`timeout\` is capped at 86400s; set \`disable_timeout=true\` only when the task should run without a timeout. You will be automatically notified when the task completes. After starting one, default to returning control to the user instead of immediately waiting on it. Use \`TaskOutput\` only for a non-blocking status/output snapshot — do not set \`block=true\` to wait for a task you just launched, since its completion arrives automatically; reserve \`block=true\` for when the user explicitly asked you to wait. Use \`TaskStop\` only if the task must be cancelled. If a human user wants to inspect background tasks themselves, point them to the \`/tasks\` command, which opens an interactive panel; it has no subcommands.\\n\\n**Guidelines for safety and security:**\\n- Each shell tool call will be executed in a fresh shell environment. The shell variables, current working directory changes, and the shell history is not preserved between calls. To run a command in a particular directory, pass the \`cwd\` argument (or use absolute paths) rather than relying on a \`cd\` from an earlier call.\\n- The tool call will return after the command is finished. You shall not use this tool to execute an interactive command or a command that may run forever. For possibly long-running foreground commands, set the \`timeout\` argument in seconds. Foreground commands default to 60s and allow up to 300s. When a foreground command hits its timeout it is moved to the background instead of being killed, and you will be automatically notified when it completes.\\n- Avoid using \`..\` to access files or directories outside of the working directory.\\n- Avoid modifying files outside of the working directory unless explicitly instructed to do so.\\n- Never run commands that require superuser privileges unless explicitly instructed to do so.\\n\\n**Guidelines for efficiency:**\\n- Use \`&&\` to chain commands that genuinely depend on each other, e.g. \`npm install && npm test\`. Independent read-only commands (separate \`git show\`, \`ls\`, or status checks) should be issued as separate parallel Bash calls in one response, not chained into a single call — chaining serializes their execution and mixes their output. Do not stitch outputs together with \`echo\` separators.\\n- Use \`;\` to run commands sequentially regardless of success/failure\\n- Use \`||\` for conditional execution (run second command only if first fails)\\n- Use pipe operations (\`|\`) and redirections (\`>\`, \`>>\`) to chain input and output between commands\\n- Always quote file paths containing spaces with double quotes (e.g., cd \\"/path with spaces/\\")\\n- Compose multi-step logic in a single call with \`if\` / \`case\` / \`for\` / \`while\` control flows.\\n- Prefer \`run_in_background=true\` for long-running builds, tests, watchers, or servers when you need the conversation to continue before the command finishes.\\n\\n**Commands available:**\\nThe following common command categories are usually available. Availability still depends on the host, so when in doubt run \`which <command>\` first to confirm a command exists before relying on it.\\n- Navigation and inspection: \`ls\`, \`pwd\`, \`cd\`, \`stat\`, \`file\`, \`du\`, \`df\`, \`tree\`\\n- File and directory management: \`cp\`, \`mv\`, \`rm\`, \`mkdir\`, \`touch\`, \`ln\`, \`chmod\`, \`chown\`\\n- Text and data processing: \`wc\`, \`sort\`, \`uniq\`, \`cut\`, \`tr\`, \`diff\`, \`xargs\`\\n- Archives and compression: \`tar\`, \`gzip\`, \`gunzip\`, \`zip\`, \`unzip\`\\n- Networking and transfer: \`curl\`, \`wget\`, \`ping\`, \`ssh\`, \`scp\`\\n- Version control: \`git\`; for GitHub-hosted work (PRs, issues, CI runs, API queries) prefer the \`gh\` CLI when installed — it carries the user's GitHub auth and can return structured JSON\\n- Process and system: \`ps\`, \`kill\`, \`top\`, \`env\`, \`date\`, \`uname\`, \`whoami\`\\n- Language and package toolchains: \`node\`, \`npm\`, \`pnpm\`, \`yarn\`, \`python\`, \`pip\` (use whichever the project actually relies on)\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "command": { "type": "string", "minLength": 1, "description": "The command to execute." }, "cwd": { "description": "The working directory in which to run the command. When omitted, the command runs in the session's working directory.", "type": "string" }, "timeout": { "default": 60, "description": "Optional timeout in seconds for the command to execute. Foreground default 60s, max 300s. Background default 600s, max 86400s. Ignored for background commands when disable_timeout=true.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 }, "description": { "description": "A short description for the background task. Required when run_in_background is true.", "type": "string" }, "run_in_background": { "description": "Whether to run the command as a background task.", "type": "boolean" }, "disable_timeout": { "description": "If true, do not apply a timeout to the command. Only applies when run_in_background is true.", "type": "boolean" } }, "required": [ "command" ], "additionalProperties": false } }, { "name": "CreateGoal", "description": "Create a durable, structured goal that the runtime will pursue across multiple turns.\\n\\nCall \`CreateGoal\` only when:\\n\\n- the user explicitly asks you to start a goal or work autonomously toward an outcome, or\\n- a host goal-intake prompt asks you to create one.\\n\\nDo NOT create a goal for greetings, ordinary questions, or vague requests that lack a\\nverifiable completion condition. A goal needs a checkable end state.\\n\\nWhen the request is vague, ask the user for the missing completion criterion before creating\\nthe goal. If the user clearly insists after you warn them that the wording is vague or risky,\\nrespect that and create the goal.\\n\\nInclude a \`completionCriterion\` when the user provides one, or when it can be stated without\\ninventing new requirements. Keep \`objective\` concise; reference long task descriptions by file\\npath rather than pasting them.\\n\\nCreating a goal fails if one already exists, so use \`replace: true\` only when the user explicitly\\nwants to abandon the current goal and start a new one.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "objective": { "type": "string", "minLength": 1, "description": "The objective to pursue. Must have a verifiable end state." }, "completionCriterion": { "description": "How to verify the goal is complete. Include when the user provides one.", "type": "string" }, "replace": { "description": "Replace an existing active, paused, or blocked goal instead of failing.", "type": "boolean" } }, "required": [ "objective" ], "additionalProperties": false } }, { "name": "Edit", "description": "Perform exact replacements in existing files.\\n\\n- Edit is mandatory for every incremental change, especially small edits. DO NOT use Write or Bash \`sed\`.\\n- Read the target file before every Edit. DO NOT call Edit from memory, stale context, or a guessed \`old_string\`.\\n- Take \`old_string\` and \`new_string\` from the Read output view.\\n- Drop the line-number prefix and tab; match only file content.\\n- \`old_string\` must be unique unless \`replace_all\` is set.\\n- If \`old_string\` is ambiguous, add surrounding context. Use \`replace_all\` only when every occurrence should change — for example, renaming a symbol throughout the file.\\n- Multiple Edit calls may run in one response only when they do not target the same file.\\n- DO NOT issue consecutive Edit calls on the same file. A previous Edit can invalidate a later Edit's \`old_string\`, causing \`old_string not found\`. Read the file again before the next Edit.\\n- A write lock serializes same-file edits in response order, but serialization does not make stale \`old_string\` valid.\\n- For pure CRLF files, Read shows LF; use LF in \`old_string\` and \`new_string\`, and Edit writes CRLF back.\\n- For mixed endings or lone carriage returns, Read shows carriage returns as \\\\r; include actual \\\\r escapes in those positions.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the text file to edit. Relative paths resolve against the working directory; a path outside the working directory must be absolute." }, "old_string": { "type": "string", "minLength": 1, "description": "Exact content to replace from the Read output view, without the line-number prefix. Use LF for pure CRLF files; use actual \\\\r escapes where Read shows \\\\r." }, "new_string": { "type": "string", "description": "Replacement text in the same Read output view. LF is written back as CRLF only for pure CRLF files." }, "replace_all": { "description": "Set true only when every occurrence of old_string should be replaced.", "type": "boolean" } }, "required": [ "path", "old_string", "new_string" ], "additionalProperties": false } }, { "name": "EnterPlanMode", "description": "Use this tool proactively when you're about to start a non-trivial implementation task.\\nGetting user sign-off on your approach via ExitPlanMode before writing code prevents wasted effort.\\n\\nUse it when ANY of these conditions apply:\\n\\n1. New Feature Implementation - e.g. \\"Add a caching layer to the API\\"\\n2. Multiple Valid Approaches - e.g. \\"Optimize database queries\\" (indexing vs rewrite vs caching)\\n3. Code Modifications - e.g. \\"Refactor auth module to support OAuth\\"\\n4. Architectural Decisions - e.g. \\"Add WebSocket support\\"\\n5. Multi-File Changes - involves more than 2-3 files\\n6. Unclear Requirements - need exploration to understand scope\\n7. User Preferences Matter - if user input would materially change the implementation approach, use EnterPlanMode to structure the decision\\n\\nPermission mode notes:\\n- EnterPlanMode enters plan mode automatically without an approval prompt in all permission modes.\\n- In yolo and manual modes, ExitPlanMode still presents the plan to the user for approval.\\n- In auto permission mode, do not use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, ExitPlanMode exits plan mode without asking the user.\\n- Use EnterPlanMode only when planning itself adds value.\\n\\nWhen NOT to use:\\n- Single-line or few-line fixes (typos, obvious bugs, small tweaks)\\n- User gave very specific, detailed instructions\\n- Pure research/exploration tasks\\n\\nOnce you are in plan mode, a reminder walks you through the workflow (explore → design → write the plan file → \`ExitPlanMode\`) and enforces read-only access. For non-trivial tasks where you are unsure of the codebase structure or relevant code paths, use \`Agent(subagent_type=\\"explore\\")\` to investigate first when the \`Agent\` tool is available.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "ExitPlanMode", "description": "Use this tool when you are in plan mode and have finished writing your plan to the plan file and are ready for user approval.\\n\\n## How This Tool Works\\n- You should have already written your plan to the plan file specified in the plan mode reminder.\\n- This tool does NOT take the plan content as a parameter - it reads the plan from the file you wrote.\\n- The user will see the contents of your plan file when they review it. In auto permission mode, the tool reads the file and exits plan mode without asking the user.\\n\\n## When to Use\\nOnly use this tool for tasks that require planning implementation steps. For research tasks (searching files, reading code, understanding the codebase), do NOT use this tool.\\n\\n## What a good plan contains\\nList specific, verifiable steps grounded in the actual codebase — real files, functions, and commands, in a sensible order. Each step should be concrete enough to act on and to check. Avoid vague filler like \\"improve performance\\" or \\"add tests\\"; say what to change and where.\\n\\n## Multiple Approaches\\nIf your plan offers multiple alternative approaches, pass them via the \`options\` parameter so the user can choose which one to execute — see the \`options\` parameter for the format, count, and reserved labels. In yolo and manual modes the user sees all options alongside the host's Reject and Revise controls.\\n\\n## Before Using\\n- In auto permission mode, do NOT use AskUserQuestion; make the best decision from available context.\\n- In auto permission mode, this tool exits plan mode without asking the user.\\n- In yolo and manual modes, this tool still presents the plan to the user for approval.\\n- If auto permission mode is not active and you have unresolved questions, use AskUserQuestion first.\\n- If auto permission mode is not active and you have multiple approaches and haven't narrowed down yet, consider using AskUserQuestion first to let the user choose, then write a plan for the chosen approach only.\\n- Once your plan is finalized, use THIS tool to request approval.\\n- Do NOT use AskUserQuestion to ask \\"Is this plan OK?\\" or \\"Should I proceed?\\" - that is exactly what ExitPlanMode does.\\n- If rejected, revise based on feedback and call ExitPlanMode again.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "options": { "description": "When the plan contains multiple alternative approaches, list them here so the user can choose which one to execute. Provide up to 3 options; 2-3 distinct approaches work best when the plan offers a real choice. Passing a single option is allowed and is equivalent to a plain plan approval. Each option represents a distinct approach from the plan. Do not use \\"Reject\\", \\"Revise\\", \\"Approve\\", or \\"Reject and Exit\\" as labels.", "minItems": 1, "maxItems": 3, "type": "array", "items": { "type": "object", "properties": { "label": { "type": "string", "minLength": 1, "maxLength": 80, "description": "Short name for this option (1-8 words). Append \\"(Recommended)\\" if you recommend this option." }, "description": { "default": "", "description": "Brief summary of this approach and its trade-offs.", "type": "string" } }, "required": [ "label" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "FetchURL", "description": "Fetch content from a URL. The content is returned either as the main text extracted from the page, or as the full response body verbatim; a note at the top of the result states which of the two you received, so you can judge how complete it is. Use this when you need to read a specific web page.\\n\\nOnly fully-formed public \`http\`/\`https\` URLs are supported; other schemes and private or loopback addresses are not fetched. Very large pages may be truncated or refused. The fetch carries no login or session for the target site, so pages behind authentication (private repositories, internal dashboards) return a login page or an error instead of the real content — if the text you get back looks like a generic landing or sign-in page, treat that as the login wall, not the answer, and reach the content through a credentialed route (an authenticated CLI or MCP tool) instead.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "url": { "type": "string", "description": "The URL to fetch content from." } }, "required": [ "url" ], "additionalProperties": false } }, { "name": "GetGoal", "description": "Read the current goal: its objective, completion criterion, status, and budgets (turns, tokens,\\ntime, and how much of each remains). When the goal has stopped, it also reports the terminal reason.\\n\\nUse \`GetGoal\` before deciding whether to continue working, report completion, report a blocker,\\nor respect a pause. It returns \`{ \\"goal\\": null }\` when there is no current goal.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": {}, "additionalProperties": false } }, { "name": "Glob", "description": "Find files by glob pattern, sorted by modification time (most recent first).\\n\\nPowered by ripgrep. Respects \`.gitignore\`, \`.ignore\`, and \`.rgignore\` by default — set \`include_ignored\` to also match ignored files (e.g. build outputs, \`node_modules\`). Sensitive files (such as \`.env\`) are always filtered out. Matches are files only — directories themselves are never listed; to find a directory, glob for a file inside it (e.g. \`**/fixtures/**\`).\\n\\nGood patterns:\\n- \`*.ts\` — all files matching an extension, at any depth below the search root (a bare pattern without \`/\` matches recursively)\\n- \`src/*.ts\` — files directly inside \`src/\` (one level, not recursive)\\n- \`src/**/*.ts\` — recursive walk with a subdirectory anchor and extension\\n- \`**/*.py\` — recursive walk from the search root for an extension\\n- \`*.{ts,tsx}\` — brace expansion is supported\\n- \`{src,test}/**/*.ts\` — cartesian brace expansion is supported too\\n\\nResults are capped at the first 100 matching paths. If a search would return more, a truncation marker is appended. Refine the pattern (extension, subdirectory) when 100 is not enough, or call again with a narrower anchor.\\n\\nLarge-directory caveat — avoid recursing into dependency / build output even with an anchor, especially when \`include_ignored\` is set:\\n- \`node_modules/**/*.js\`, \`.venv/**/*.py\`, \`__pycache__/**\`, \`target/**\` can produce thousands of results that truncate at the match cap and waste context. Prefer specific subpaths like \`node_modules/react/src/**/*.js\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Glob pattern to match files." }, "path": { "description": "Directory to search. Accepts an absolute path, or a path relative to the current working directory. Defaults to the current working directory.", "type": "string" }, "include_ignored": { "description": "Also match files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" }, "include_dirs": { "description": "Deprecated and ignored. Results are always files-only — directories are never listed. Accepted only so older calls that still pass this flag are not rejected by parameter validation.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Grep", "description": "Search file contents using regular expressions (powered by ripgrep).\\n\\nUse Grep when the task is to find unknown content or unknown file locations. Do not use shell \`grep\` or \`rg\` directly; this tool applies workspace path policy, output limits, and sensitive-file filtering.\\nALWAYS use Grep tool instead of running \`grep\` or \`rg\` from a shell — direct shell calls bypass workspace policy, output limits, and sensitive-file filtering.\\nIf you already know a concrete file path and need to inspect its contents, use Read directly instead.\\n\\nWrite patterns in ripgrep regex syntax, which differs from POSIX \`grep\` syntax. For example, braces are special, so escape them as \`\\\\{\` to match a literal \`{\`.\\n\\nHidden files (dotfiles such as \`.gitlab-ci.yml\` or \`.eslintrc.json\`) are searched by default. To also search files excluded by \`.gitignore\` (such as \`node_modules\` or build outputs), set \`include_ignored\` to \`true\`. Sensitive files (such as \`.env\`) are always skipped for safety, even when \`include_ignored\` is \`true\`.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "pattern": { "type": "string", "description": "Regular expression to search for." }, "path": { "description": "File or directory to search. Accepts an absolute path, or a path relative to the current working directory. Omit to search the current working directory. Use Read instead when you already know a concrete file path and need its contents.", "type": "string" }, "glob": { "description": "Optional glob filter for which files to search, e.g. \`*.ts\`. Matched against each file's full absolute path, so a path-anchored pattern like \`src/**/*.ts\` silently matches nothing — use a basename pattern (\`*.ts\`), or anchor with \`**/\` (\`**/src/**/*.ts\`). To scope the search to a directory, use \`path\` instead.", "type": "string" }, "type": { "description": "Optional ripgrep file type filter, such as ts or py. Prefer this over \`glob\` when filtering by language or file kind: it is more efficient and less error-prone than an equivalent glob pattern.", "type": "string" }, "output_mode": { "description": "Shape of the result. \`content\` shows matching lines (honors \`-A\`, \`-B\`, \`-C\`, \`-n\`, and \`head_limit\`); \`files_with_matches\` shows only the paths of files that contain a match, most-recently-modified first (honors \`head_limit\`); \`count_matches\` shows per-file match counts as \`path:count\` lines, preceded by an aggregate total line. Defaults to \`files_with_matches\`.", "type": "string", "enum": [ "content", "files_with_matches", "count_matches" ] }, "-i": { "description": "Perform a case-insensitive search. Defaults to false.", "type": "boolean" }, "-n": { "description": "Prefix each matching line with its line number. Applies only when \`output_mode\` is \`content\`. Defaults to true.", "type": "boolean" }, "-A": { "description": "Number of lines to show after each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-B": { "description": "Number of lines to show before each match. Applies only when \`output_mode\` is \`content\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "-C": { "description": "Number of lines to show before and after each match. Applies only when \`output_mode\` is \`content\`; takes precedence over \`-A\` and \`-B\`.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "head_limit": { "description": "Limit output to the first N lines/entries after offset. Defaults to 250. Pass 0 for unlimited.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "offset": { "description": "Number of leading lines/entries to skip before applying \`head_limit\`. Use it together with \`head_limit\` to page through large result sets. Defaults to 0.", "type": "integer", "minimum": 0, "maximum": 9007199254740991 }, "multiline": { "description": "Enable multiline matching, where the pattern can span line boundaries and \`.\` also matches newlines. Defaults to false.", "type": "boolean" }, "include_ignored": { "description": "Also search files excluded by ignore files such as \`.gitignore\`, \`.ignore\`, and \`.rgignore\` (for example \`node_modules\` or build outputs). Sensitive files (such as \`.env\`) remain filtered out for safety. VCS metadata directories (\`.git\` and similar) are always skipped, even when this is true. Defaults to false.", "type": "boolean" } }, "required": [ "pattern" ], "additionalProperties": false } }, { "name": "Read", "description": "Read a text file from the local filesystem.\\n\\nIf the user provides a concrete file path to a text file, call Read directly. Do not \`Glob\`, \`ls\`, or otherwise pre-check known text file paths; missing or invalid file paths return errors you can handle. Do not use Read for directories; use \`ls\` via Bash for a known directory, or Glob when you need files matching a name pattern (Glob lists files only, never directories). Use \`Grep\` only when the task is to search for unknown content or locations.\\n\\nWhen you need several files, prefer to read them in parallel: emit multiple \`Read\` calls in a single response instead of reading one file per turn.\\n\\n- Relative paths resolve against the working directory; a path outside the working directory must be absolute.\\n- Returns up to 1000 lines or 100 KB per call, whichever comes first; lines longer than 2000 chars are truncated mid-line.\\n- Page larger files with \`line_offset\` (1-based start line) and \`n_lines\`. Omit \`n_lines\` to read up to the 1000-line cap.\\n- Sensitive files (\`.env\` files, credential stores, SSH private keys, and similar secrets) are refused to protect secrets; do not attempt to read them. Templates and public keys are exempt: \`.env.example\` / \`.env.sample\` / \`.env.template\` and public SSH keys such as \`id_rsa.pub\` read normally.\\n- Only UTF-8 text files can be read. Non-UTF-8 encodings, binary files, and files containing NUL bytes are refused; use \`ReadMediaFile\` for images or video, and Bash or an MCP tool for other binary formats.\\n- Negative line_offset reads from the end of the file (for example, -100 reads the last 100 lines); the absolute value cannot exceed 1000.\\n- Output format: \`<line-number>\\\\t<content>\` per line.\\n- A \`<system>...</system>\` status block is appended after the file content; it summarizes how much was read (line and byte counts, truncation, line-ending notes) and is not part of the file itself.\\n- Pure CRLF files are displayed with LF line endings; \`Edit\` matches this output and preserves CRLF when writing back.\\n- Mixed or lone carriage-return line endings are shown as \`\\\\r\` and require exact \`Edit.old_string\` escapes.\\n- After a successful \`Edit\`/\`Write\`, do not re-read solely to prove the write landed. When the task depends on an exact file, API, or output shape, inspect the final external contract before finishing.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to a text file. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Directories are not supported; use \`ls\` via Bash for a known directory, or Glob for pattern search." }, "line_offset": { "description": "The line number to start reading from. Omit to start at line 1. Negative values read from the end of the file; the absolute value cannot exceed 1000.", "anyOf": [ { "type": "integer", "minimum": 1, "maximum": 9007199254740991 }, { "type": "integer", "minimum": -1000, "maximum": -1 } ] }, "n_lines": { "description": "The number of lines to read; the tool also applies its internal cap. Omit to read up to the internal cap of 1000 lines.", "type": "integer", "exclusiveMinimum": 0, "maximum": 9007199254740991 } }, "required": [ "path" ], "additionalProperties": false } }, { "name": "SetGoalBudget", "description": "Set a hard budget limit for the current goal.\\n\\nUse this only when the user clearly gives a runtime limit, such as:\\n\\n- \\"stop after 20 turns\\"\\n- \\"use no more than 500k tokens\\"\\n- \\"finish within 30 minutes\\"\\n\\nDo not invent limits. Do not call this for vague wording such as \\"spend some time\\" or\\n\\"try to be quick\\".\\n\\nIf the user gives a compound time, convert it to one supported unit before calling this tool.\\nFor example, \\"2 hours and 3 minutes\\" can be set as \`value: 123, unit: \\"minutes\\"\`.\\n\\nA time budget must be between 1 second and 24 hours — the tool rejects anything shorter or\\nlonger, telling the user it is not a reasonable goal budget. Turn and token budgets are not\\nbounded this way; they must be positive and are rounded to the nearest whole number (minimum 1).\\n\\nSupported units:\\n\\n- \`turns\`\\n- \`tokens\`\\n- \`milliseconds\`\\n- \`seconds\`\\n- \`minutes\`\\n- \`hours\`\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "value": { "type": "number", "exclusiveMinimum": 0, "description": "The positive numeric budget value." }, "unit": { "type": "string", "enum": [ "turns", "tokens", "milliseconds", "seconds", "minutes", "hours" ] } }, "required": [ "value", "unit" ], "additionalProperties": false } }, { "name": "Skill", "description": "Invoke a registered skill from the current skill listing. BLOCKING REQUIREMENT: when a skill from the listing matches the user's request, you MUST call this tool (not free-form text). Do not re-invoke a skill to repeat work already done: if a \`<kimi-skill-loaded>\` block for it with the same \`args\` is already present in the conversation, follow those instructions directly instead of calling the tool again. Do call the tool again when you need the skill with different arguments — the loaded block was expanded with the earlier \`args\` and will not reflect new inputs.", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "skill": { "type": "string", "description": "The exact name of the skill to invoke, spelled as it appears in the current skill listing (e.g. \\"commit\\", \\"pdf\\")." }, "args": { "description": "Optional argument string for the skill, written like a command line (e.g. \`-m \\"fix bug\\"\`, \`123\`, a file path). It is split on whitespace (quotes group a token) and expanded into the skill's placeholders ($NAME, $1, $ARGUMENTS); if the skill body has no placeholders, the whole string is still appended as a trailing \`ARGUMENTS:\` line. Omit it only when there is nothing to pass.", "type": "string" } }, "required": [ "skill" ], "additionalProperties": false } }, { "name": "TaskList", "description": "List background tasks and their current status.\\n\\nUse this tool to discover which background tasks exist and where each one\\nstands. It is the entry point for inspecting background work: it returns a\\ntask ID, status, and description for every task it reports, plus the command,\\nPID, and (once finished) exit code for shell tasks, and a stop reason for any\\ntask that ended early.\\n\\nGuidelines:\\n\\n- After a context compaction, or whenever you are unsure which background\\n  tasks are running or what their task IDs are, call this tool to\\n  re-enumerate them instead of guessing a task ID.\\n- Prefer the default \`active_only=true\`, which lists only non-terminal tasks.\\n  Pass \`active_only=false\` only when you specifically need to see tasks that\\n  have already finished. With \`active_only=false\` the result may also include\\n  \`lost\` tasks — tasks left over from a previous process that can no longer be\\n  inspected or controlled; treat them as already terminated.\\n- \`limit\` caps how many tasks are returned. It accepts a value between 1 and\\n  100 and defaults to 20 when omitted.\\n- This tool only lists tasks; it does not return their output. Use it first\\n  to locate the task ID you need, then call \`TaskOutput\` with that ID to read\\n  the task's output and details.\\n- This tool is read-only and does not change any state, so it is always safe\\n  to call, including in plan mode.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "active_only": { "default": true, "description": "Whether to list only non-terminal background tasks.", "type": "boolean" }, "limit": { "default": 20, "description": "Maximum number of tasks to return.", "type": "integer", "minimum": 1, "maximum": 100 } }, "additionalProperties": false } }, { "name": "TaskOutput", "description": "Retrieve a snapshot of a running or completed background task.\\n\\nUse this after \`Bash(run_in_background=true)\` or \`Agent(run_in_background=true)\` to check progress, or to read the output of a task that has already completed.\\n\\nGuidelines:\\n- Prefer relying on automatic completion notifications. Use this tool only when you need task output before the automatic notification arrives.\\n- By default this tool is non-blocking and returns a current status/output snapshot — that is the normal way to use it.\\n- Do not use TaskOutput to wait for a result you need before continuing — if your next step depends on the task's result, run that task in the foreground instead. TaskOutput is for a deliberate progress check you will act on without blocking, not a way to sit and wait for a background task you just launched.\\n- Use block=true only when the user explicitly asked you to wait for the task. Never block on a task you launched in the current turn — if you need its result right away, it should have been a foreground call.\\n- If a block=true call returns \`retrieval_status: timeout\` (the task is still running), do not block on the same task again. Continue with other work or hand back to the user — the completion notification arrives on its own.\\n- This tool returns structured task metadata, a fixed-size output preview, and an output_path for the full log.\\n- For a terminal task, the metadata also explains why it ended. A shell command that runs to completion reports \`status: completed\` on a zero exit, or \`status: failed\` with its non-zero \`exit_code\` — judge that failure from the \`exit_code\`, because a plain command failure carries no \`stop_reason\` and no \`terminal_reason\`. \`terminal_reason\` is a categorical label emitted only when the end is not an ordinary exit: \`timed_out\` when the deadline aborted it, \`stopped\` when it was explicitly stopped, or \`failed\` when it errored without producing an exit code; the \`stopped\` and \`failed\` cases also carry a human-readable \`stop_reason\`. A task that finished on its own with a clean exit carries neither \`stop_reason\` nor \`terminal_reason\`.\\n- The full, never-truncated log is always available at output_path; use the \`Read\` tool with that path to page through it, whether or not the preview was truncated.\\n- This tool works with the generic background task system and should remain the primary read path for future task types, not just bash.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to inspect." }, "block": { "default": false, "description": "Whether to wait for the task to finish before returning. Discouraged — background tasks notify automatically on completion; use only when the user explicitly asked you to wait.", "type": "boolean" }, "timeout": { "default": 30, "description": "Maximum number of seconds to wait when block=true.", "type": "integer", "minimum": 0, "maximum": 3600 } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TaskStop", "description": "Stop a running background task.\\n\\nOnly use this when a task must genuinely be cancelled — for a task that is\\nfinishing normally, wait for its completion notification or inspect it with\\n\`TaskOutput\` instead of stopping it.\\n\\nGuidelines:\\n- This is a general-purpose stop capability for any background task. It is not\\n  a bash-specific kill.\\n- Stopping a task is destructive: it may leave partial side effects behind.\\n  Use it with care.\\n- If the task has already finished, this tool simply returns its current\\n  status.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "task_id": { "type": "string", "description": "The background task ID to stop." }, "reason": { "default": "Stopped by TaskStop", "description": "Short reason recorded when the task is stopped.", "type": "string" } }, "required": [ "task_id" ], "additionalProperties": false } }, { "name": "TodoList", "description": "Use this tool to maintain a structured TODO list as you work through a multi-step task. Use it proactively and often when progress tracking helps the current work. This is especially useful in long-running investigations and implementation tasks with several tool calls; in plan mode, write the plan to the plan file rather than tracking it here.\\n\\n**When to use:**\\n- Multi-step tasks that span several tool calls\\n- Tracking investigation progress across a large codebase search\\n- Planning a sequence of edits before making them\\n- After receiving new multi-step instructions, capture the requirements as todos\\n- Before starting a tracked task, mark exactly one item as \`in_progress\`\\n- Immediately after finishing a tracked task, mark it \`done\`; do not batch completions at the end\\n\\n**When NOT to use:**\\n- Single-shot answers that complete in one or two tool calls\\n- Trivial requests where tracking adds no clarity\\n- Purely conversational or informational replies\\n\\n**Avoid churn:**\\n- Do not re-call this tool when nothing meaningful has changed since the last call — update the list only after real progress.\\n- When unsure of the current state, call query mode first (omit \`todos\`) to check the list before deciding what to update.\\n- If no available tool can move any task forward, tell the user where you are stuck instead of repeatedly re-ordering the same todos.\\n\\n**How to use:**\\n- Call with \`todos: [...]\` to replace the full list. Statuses: pending / in_progress / done.\\n- Call with no \`todos\` argument to retrieve the current list without changing it.\\n- Call with \`todos: []\` to clear the list.\\n- Keep titles short and actionable (e.g. \\"Read session-control.ts\\", \\"Add planMode flag to TurnManager\\").\\n- Update statuses as you make progress.\\n- When work is underway, keep exactly one task \`in_progress\`.\\n- Only mark a task \`done\` when it is fully accomplished.\\n- Never mark a task \`done\` if tests are failing, implementation is partial, unresolved errors remain, or required files/dependencies could not be found.\\n- If you encounter a blocker, keep the blocked task \`in_progress\` or add a new pending task describing what must be resolved.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "todos": { "description": "The updated todo list. Omit to read the current todo list without making changes. Pass an empty array to clear the list.", "type": "array", "items": { "type": "object", "properties": { "title": { "type": "string", "minLength": 1, "description": "Short, actionable title for the todo." }, "status": { "type": "string", "enum": [ "pending", "in_progress", "done" ], "description": "Current status of the todo." } }, "required": [ "title", "status" ], "additionalProperties": false } } }, "additionalProperties": false } }, { "name": "UpdateGoal", "description": "Set the status of the current goal. This is how you resume, complete, or block an autonomous goal.\\n\\n- \`active\` — resume a paused or blocked goal when the user explicitly asks you to work on that goal.\\n- \`complete\` — the objective is satisfied and any stated validation has passed. The goal ends and a completion summary is recorded. Before using this, verify the current state against the actual objective and every explicit requirement. Treat weak or indirect evidence as not complete. Do not use \`complete\` merely because a budget is nearly exhausted or you want to stop.\\n- \`blocked\` — a genuine impasse prevents useful progress: an external condition, required user input, missing credentials or permissions, a persistent technical failure, or an impossible, unsafe, or contradictory objective. For non-terminal blockers, do not use \`blocked\` the first time you hit the blocker. The same blocking condition must repeat for at least 3 consecutive goal turns before you call \`blocked\`, counting the original/user-triggered turn and automatic continuations. If a previously blocked goal is resumed, treat the resumed run as a fresh blocked audit. If the objective itself is impossible, unsafe, or contradictory, call \`blocked\` in the same turn instead of running more goal turns. Do not use \`blocked\` because the work is large, hard, slow, uncertain, incomplete, still needs validation, would benefit from clarification, or needs more goal turns. Once the 3-turn threshold is met and you cannot make meaningful progress without user input or an external-state change, call \`blocked\` instead of leaving the goal active.\\n\\nMost active goal turns should not call this tool. If you complete one useful slice of work and material work remains, end the turn normally without calling UpdateGoal; the runtime will prompt you to continue in the next goal turn. Call \`complete\` only when all required work is done, any stated validation has passed, and there is no useful next action. Do not call \`complete\` after only producing a plan, summary, first pass, or partial result. Call \`blocked\` only after the blocked audit threshold is met. If you call \`blocked\`, you will be prompted to explain the blocker in your next message. Setting the status is the machine-readable signal; the completion summary or blocker explanation is yours to write in the following message.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "status": { "type": "string", "enum": [ "active", "complete", "blocked" ], "description": "The lifecycle status to set for the current goal. Use \`blocked\` for impossible, unsafe, or contradictory objectives, or after the same non-terminal blocking condition repeats for at least 3 consecutive goal turns." } }, "required": [ "status" ], "additionalProperties": false } }, { "name": "Write", "description": "Create, append to, or replace a file entirely.\\n\\n- Missing parent directories are created automatically (like \`mkdir(parents=True, exist_ok=True)\`).\\n- Mode defaults to overwrite; append adds content at EOF without adding a newline.\\n- Write is NOT ALLOWED for incremental changes to existing files, including trivial, one-line, quick, or cosmetic edits. Use Edit instead.\\n- Use Write only when the file does not exist, you intend a complete replacement, or the new contents have little continuity with the old contents.\\n- Do not create unsolicited documentation files (\`*.md\` write-ups, \`README\`s, summaries) just because a task finished — write one only when the user asks for it, or when a task or project instruction requires it (e.g. the plan-mode plan file, created with Write when plan mode directs you to, or a changeset the repo mandates).\\n- Read before overwriting an existing file.\\n- Write ignores the Read/Edit line-number view. NEVER include line prefixes.\\n- Write outputs content literally, including supplied line endings: \\\\n stays LF, \\\\r\\\\n stays CRLF.\\n- For new content too large for one call, overwrite the first chunk, then append subsequent chunks. Never chunk Write to modify an existing file.\\n", "parameters": { "$schema": "http://json-schema.org/draft-07/schema#", "type": "object", "properties": { "path": { "type": "string", "description": "Path to the file to create, append to, or completely overwrite. Relative paths resolve against the working directory; a path outside the working directory must be absolute. Missing parent directories are created automatically." }, "content": { "type": "string", "description": "Raw full file content to write exactly as provided. This does not use the Read/Edit text view." }, "mode": { "description": "Write mode. Defaults to overwrite. append adds content to the end exactly as provided and does not add a newline.", "type": "string", "enum": [ "overwrite", "append" ] } }, "required": [ "path", "content" ], "additionalProperties": false } } ], "time": "<time>" }
        [wire] llm.request                  { "kind": "loop", "provider": "openai", "model": "mock-model", "modelAlias": "mock-model", "thinkingEffort": "off", "maxTokens": 1000000, "toolSelect": false, "systemPromptHash": "ec9c34379c88babbc468ef2f3e0e08cd2f422c8c4a910664fb8bb394d703a575", "toolsHash": "a76c3f1cc39da5735f85181eba5c128cd06001982f440e6721aaa8bf750c13d8", "messageCount": 6, "turnStep": "1.1", "time": "<time>" }
        [emit] assistant.delta              { "turnId": 1, "delta": "No lookup tool is available." }
        [emit] agent.activity.updated       { "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "streaming", "stream": "assistant", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "usageScope": "turn", "time": "<time>" }
        [emit] agent.status.updated         { "usage": { "byModel": { "mock-model": { "inputOther": 492, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 492, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [emit] agent.status.updated         { "contextTokens": 194 }
        [emit] turn.step.completed          { "turnId": 1, "step": 1, "stepId": "<uuid-6>", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "end_turn", "providerFinishReason": "completed", "rawFinishReason": "stop" }
        [emit] agent.activity.updated       { "lifecycle": "ready", "turn": { "turnId": 1, "origin": { "kind": "user" }, "phase": "running", "step": 1, "ending": false, "pendingApprovals": [], "activeToolCalls": [], "since": "<time>" }, "background": [] }
        [wire] context.append_loop_event    { "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "1", "step": 1, "stepUuid": "<uuid-6>", "part": { "type": "text", "text": "No lookup tool is available." } }, "time": "<time>" }
        [wire] context.append_loop_event    { "event": { "type": "step.end", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 184, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [emit] turn.ended                   { "turnId": 1, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, Write
        messages:
          <last>
          assistant: text "The lookup result is moon-result."
          user: text "Can you still use Lookup?"
      `);
    });

    it('persists oversized registered user tool results before adding them to context', async () => {
      await ctx.dispose();
      const homeDir = mkdtempSync(join(tmpdir(), 'tool-result-truncation-'));
      tempHomeDirs.push(homeDir);
      ctx = createTestAgent(homeDirServices(homeDir));
      await ctx.rpc.setPermission({ mode: 'auto' });
      await ctx.rpc.registerTool({
        name: 'Lookup',
        description: 'Look up a long test value.',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string' },
          },
          required: ['query'],
          additionalProperties: false,
        },
      });

      const fullOutput = `${'x'.repeat(50_001)}tail survives on disk`;
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      await ctx.untilToolCall({
        content: fullOutput,
        output: fullOutput,
      });
      ctx.mockNextResponse({ type: 'text', text: 'The lookup output was saved.' });
      await ctx.untilTurnEnd();

      const toolMessage = ctx.compactHistory().find((message) => message.role === 'tool')?.text;
      expect(toolMessage).toContain('Tool output exceeded 50000 characters');
      expect(toolMessage).toContain('tool_name: Lookup');
      expect(toolMessage).toContain('tool_call_id: call_lookup');
      expect(toolMessage).not.toContain('tail survives on disk');

      const outputPath = renderedOutputPath(toolMessage);
      expect(outputPath).toContain(
        join(homeDir, 'sessions/test-workspace/test-session/agents/main/tool-results/Lookup-call_lookup-'),
      );
      expect(readFileSync(outputPath, 'utf8')).toBe(fullOutput);
    });
  });
});

function renderedOutputPath(output: string | undefined): string {
  if (output === undefined) throw new Error('expected tool output');
  const match = /^output_path: (.+)$/m.exec(output);
  if (match === null) throw new Error('expected tool output to include output_path');
  return match[1]!;
}

function bashCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_bash',
    name: 'Bash',
    arguments: '{"command":"printf hook-output","timeout":60}',
  };
}

function createFailingCommandRunner(stdout: string): ISessionProcessRunner {
  function createProcess(): IProcess {
    return {
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 2,
      wait: vi.fn().mockResolvedValue(2) as IProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IProcess['dispose'],
    };
  }
  return createFakeProcessRunner({
    exec: vi.fn().mockImplementation(async () => createProcess()),
  });
}

function agentCall(): ToolCall {
  return {
    type: 'function',
    id: 'call_agent',
    name: 'Agent',
    arguments: JSON.stringify({
      prompt: 'Investigate deeply',
      description: 'Investigate deeply',
      subagent_type: 'coder',
    }),
  };
}

function hookErrorMessageAssertCommand(expected: string): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.error?.message === ${JSON.stringify(expected)}) process.exit(0);`,
    "  console.error(payload.error?.message ?? '<missing>');",
    '  process.exit(2);',
    '});',
  ].join('');
  return `node -e ${JSON.stringify(script)}`;
}

function hookPayloadAssertCommand(expected: {
  readonly event: 'PreToolUse' | 'PostToolUse' | 'PostToolUseFailure';
  readonly toolName: string;
  readonly toolCallId: string;
  readonly toolInputCommand: string;
  readonly toolOutput?: string;
  readonly errorMessageIncludes?: string;
}): string {
  const script = [
    "let input = '';",
    "process.stdin.on('data', (chunk) => { input += chunk; });",
    "process.stdin.on('end', () => {",
    '  const payload = JSON.parse(input);',
    `  if (payload.hook_event_name !== ${JSON.stringify(expected.event)}) throw new Error('bad event: ' + payload.hook_event_name);`,
    `  if (payload.tool_name !== ${JSON.stringify(expected.toolName)}) throw new Error('bad tool_name: ' + payload.tool_name);`,
    `  if (payload.tool_call_id !== ${JSON.stringify(expected.toolCallId)}) throw new Error('bad tool_call_id: ' + payload.tool_call_id);`,
    `  if (payload.tool_input?.command !== ${JSON.stringify(expected.toolInputCommand)}) throw new Error('bad command: ' + payload.tool_input?.command);`,
    expected.toolOutput === undefined
      ? ''
      : `  if (payload.tool_output !== ${JSON.stringify(expected.toolOutput)}) throw new Error('bad tool_output: ' + payload.tool_output);`,
    expected.toolOutput === undefined
      ? ''
      : "  if (payload.error !== undefined) throw new Error('unexpected error payload');",
    expected.errorMessageIncludes === undefined
      ? ''
      : `  if (typeof payload.error?.message !== 'string' || !payload.error.message.includes(${JSON.stringify(expected.errorMessageIncludes)})) throw new Error('bad error: ' + payload.error?.message);`,
    expected.errorMessageIncludes === undefined
      ? ''
      : "  if (payload.tool_output !== undefined) throw new Error('unexpected tool_output: ' + payload.tool_output);",
    '  process.exit(0);',
    '});',
    "process.on('uncaughtException', (error) => { console.error(error.message); process.exit(2); });",
  ].filter((line) => line.length > 0).join('');
  return `node -e ${JSON.stringify(script)}`;
}
