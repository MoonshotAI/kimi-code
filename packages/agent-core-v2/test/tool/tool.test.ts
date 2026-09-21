import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, type Writable } from 'node:stream';
import { createControlledPromise } from '@antfu/utils';
import { LifecycleScope } from '#/app/scopes';
import { type IAgentScopeHandle } from '#/_base/di/scope';
import { Event, type Event as KimiEvent } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { toInputJsonSchema } from '#/tool/input-schema';
import { userCancellationReason } from '#/_base/utils/abort';
import { createHooks } from '#/hooks';
import type { ToolCall } from '#human/llm/message';
import type { TokenUsage } from '#human/llm/usage';
import { IModelCatalog, type Model } from '#/llm-adapter/model/catalog';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentTaskService } from '#/agent/task/task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ISessionTokenCountingService } from '#/session/tokenCounting/sessionTokenCounting';
import { makeHookRunner } from '../features/externalHooks/runner-stub';
import { IAgentProfileService, type ProfileData } from '#/agent/profile/profile';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { ToolAccesses, type ExecutableTool } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentLoopService } from '#/agent/loop/loop';
import { agentContextOf, IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { createActor } from '#human/xstate2';
import { createAgentMachine } from '#human/agent/machine';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import {
  AgentSwarmToolInputSchema,
  type AgentSwarmToolInput,
} from '#/features/swarm/tools/agent-swarm/agent-swarm';
import {
  SubagentToolInputSchema,
  type SubagentToolInput,
} from '#/agent/tools/agent/agent';
import {
  FORK_EXPERIMENTAL_UNAVAILABLE,
  FORK_WITH_MODEL_UNAVAILABLE,
  FORK_WITH_RESUME_UNAVAILABLE,
  FORK_WITH_TYPE_UNAVAILABLE,
} from '#/session/subagent/spawn';
import { IAgentReminderService } from '#/features/reminder/reminderService';
import { DEFAULT_SUBAGENT_TIMEOUT_MS, SECONDARY_MODEL_SECTION, SUBAGENT_SECTION } from '#/session/subagent/configSection';
import { SUBAGENT_FORK_FLAG_ID } from '#/session/subagent/flag';
import { Error2, ErrorCodes } from '#/errors';
import { SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV } from '#/session/subagent/subagentScopeCache';
import type { AgentTaskSettlement } from '#/agent/task/types';
import { SubagentTask } from '#/agent/tools/agent/subagent-task';
import { runAgentTurn } from '#/session/subagent/runAgentTurn';
import { emitAgentRunSpawned, mirrorAgentRun } from '#/session/subagent/mirrorAgentRun';
import type { AgentContext } from '#/agent/agentContext/agentContext';
import {
  IAgentLifecycleService,
  type AgentScopeCreatedEvent,
} from '#/session/agentLifecycle/agentLifecycle';
import {
  type AgentRunCompletion,
  type AgentRunHandle,
  type AgentRunRequest,
  type AgentTaskStopHookContext,
  ISessionSubagentService,
  type RunAgentOptions,
} from '#/session/subagent/subagent';
import { IEventBus } from '#/app/event/eventBus';
import type { Event2 } from '#/app/event/event2';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { normalizeAgentProfile, type AgentProfile } from '#/app/agentProfileCatalog/agentProfileCatalog';
import { ITelemetryService, noopTelemetryService } from '#/app/telemetry/telemetry';
import { ISessionMetadata, type AgentMeta } from '#/session/sessionMetadata/sessionMetadata';
import { ISessionAgentProfileCatalog } from '#/session/sessionAgentProfileCatalog/sessionAgentProfileCatalog';
import type {
  ISessionSwarmService,
  SessionSwarmRunArgs,
  SessionSwarmRunResult,
} from '#/features/swarm/session/sessionSwarm';
import type { IHostProcess, IHostProcessService } from '#/os/interface/hostProcess';
import { IWireService } from '#/wire/wire';
import { IAgentStateService } from '#/agent/state/agentState';
import { AgentStateService } from '#/agent/state/agentStateService';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import { StubConfigService } from '../stubs';
import { stubFlag } from '../app/flag/stubs';
import {
  agentService,
  appService,
  configServices,
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  externalHookServices,
  homeDirServices,
  modelProviderServices,
  sessionService,
  swarmServices,
  type TestAgentContext,
  type TestAgentOptions,
  type TestAgentServiceOverride,
} from '../harness';
import { executeTool } from '../tools/fixtures/execute-tool';
import { stubAgentContext } from '../agent/agentContext/stubs';
import { TOWER_WORKER_PROFILE } from '#/features/tower/tower';

const signal = new AbortController().signal;

function forkFlags(enabled = true): TestAgentServiceOverride {
  return appService(
    IFlagService,
    stubFlag((id) => enabled && id === SUBAGENT_FORK_FLAG_ID),
  );
}

function agentSchemaProperties<T = unknown>(): Record<string, T> {
  return (
    toInputJsonSchema(SubagentToolInputSchema) as { properties: Record<string, T> }
  ).properties;
}

function agentSwarmSchemaProperties<T = unknown>(): Record<string, T> {
  return (
    toInputJsonSchema(AgentSwarmToolInputSchema) as { properties: Record<string, T> }
  ).properties;
}

const BACKGROUND_AGENT_NEXT_STEP =
  'next_step: The completion arrives automatically in a later turn — do NOT wait, poll, or call TaskOutput on it; continue with other work or hand back to the user. (If you have nothing to do until it finishes, run such tasks in the foreground next time.)';

const POOL_MODEL_ENTRIES = {
  'provider/fast': { provider: 'test-provider', model: 'fast-model', maxContextSize: 262_144 },
  'provider/smart': { provider: 'test-provider', model: 'smart-model', maxContextSize: 262_144 },
};

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

function modelCatalogResolving(...aliases: readonly string[]): IModelCatalog {
  return {
    _serviceBrand: undefined,
    get: (alias: string) => {
      if (!aliases.includes(alias)) {
        throw new Error2(
          ErrorCodes.CONFIG_INVALID,
          `Model "${alias}" is not configured in config.toml.`,
          { details: { model: alias } },
        );
      }
      return { id: alias } as Model;
    },
    getRequester: (alias: string) => ({
      model: { id: alias } as Model,
      request: async function* () {},
    }),
    notifyConfigChanged: () => {},
  } as unknown as IModelCatalog;
}

interface AgentLifecycleStubOptions {
  readonly createAgentIds?: readonly string[];
  readonly runCompletion?: (
    agentId: string,
    request: AgentRunRequest,
    options: RunAgentOptions,
  ) => Promise<AgentRunCompletion>;
  readonly createError?: Error;
  readonly handleServices?: ReadonlyMap<string, ReadonlyMap<unknown, unknown>>;
}

interface AgentLifecycleStub extends IAgentLifecycleService, ISessionSubagentService {
  readonly create: ReturnType<typeof vi.fn<IAgentLifecycleService['create']>>;
  readonly fork: ReturnType<typeof vi.fn<IAgentLifecycleService['fork']>>;
  readonly run: ReturnType<typeof vi.fn<ISessionSubagentService['run']>>;
  readonly get: ReturnType<typeof vi.fn<IAgentLifecycleService['get']>>;
  readonly publishedEvents: Event2[];
  addHandle(
    agentId: string,
    profileName: string,
    services?: ReadonlyMap<unknown, unknown>,
    context?: AgentContext,
  ): void;
}

function createAgentLifecycleStub(options: AgentLifecycleStubOptions = {}): AgentLifecycleStub {
  let lifecycle: AgentLifecycleStub;
  let created = 0;
  const stateByAgentId = new Map<string, AgentStateService>();
  const profileByAgentId = new Map<string, string>();
  const handles = new Map<string, IAgentScopeHandle>();
  const servicesByAgentId = new Map(options.handleServices);
  const contextsByAgentId = new Map<string, AgentContext>();
  const publishedEvents: Event2[] = [];
  const contextFor = (agentId: string): AgentContext => {
    let context = contextsByAgentId.get(agentId);
    if (context === undefined) {
      context = stubAgentContext(agentId, 1);
      contextsByAgentId.set(agentId, context);
    }
    return context;
  };
  const handle = (agentId: string): IAgentScopeHandle => ({
    id: agentId,
    kind: LifecycleScope.Agent,
    accessor: {
      get: (serviceId) => {
        const service = servicesByAgentId.get(agentId)?.get(serviceId);
        if (service !== undefined) return service as never;
        if (serviceId === IAgentLifecycleService) return lifecycle as never;
        if (serviceId === ISessionSubagentService) return lifecycle as never;
        if (serviceId === IAgentScopeContext) {
          return {
            _serviceBrand: undefined,
            agentId,
            agentContext: contextFor(agentId),
            scope: (subKey?: string) => subKey ?? '',
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
            republishStatus: () => {},
            getEffectiveThinkingLevel: () => 'off',
            getActiveToolNames: () => [],
            isToolActive: () => false,
          } as never;
        }
        if (serviceId === IAgentLoopService) {
          return {
            _serviceBrand: undefined,
            snapshot: () => ({ state: 'idle' }),
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
        if (serviceId === IAgentReminderService) {
          return {
            _serviceBrand: undefined,
            register: () => noopDisposable(),
            notify: () => {},
            reconcileWhenIdle: () => Promise.resolve(),
          } as never;
        }
        if (serviceId === IEventBus) {
          return {
            _serviceBrand: undefined,
            publish: (event: Event2) => {
              publishedEvents.push(event);
            },
            subscribe: () => noopDisposable(),
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
        if (serviceId === IEventDispatcher) {
          return {
            _serviceBrand: undefined,
            hooks: createHooks(['onDidRestore']),
            dispatch: (event: Event2) => {
              publishedEvents.push(event);
              return Promise.resolve();
            },
            restore: () => Promise.resolve(),
            flush: () => Promise.resolve(),
          } as never;
        }
        if (serviceId === IAgentStateService) {
          let state = stateByAgentId.get(agentId);
          if (state === undefined) {
            state = new AgentStateService();
            stateByAgentId.set(agentId, state);
          }
          return state as never;
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
    onDidCreate: Event.None as KimiEvent<AgentContext>,
    onDidCreateScope: Event.None as KimiEvent<AgentScopeCreatedEvent>,
    onWillClose: Event.None as KimiEvent<AgentContext>,
    onDidClose: Event.None as KimiEvent<AgentContext>,
    create: vi.fn(async (input = {}) => {
      if (options.createError !== undefined) throw options.createError;
      const agentId =
        input.agentId ??
        options.createAgentIds?.[created] ??
        `agent-child-${String(created + 1)}`;
      created += 1;
      const profileName = input.binding?.profile ?? 'coder';
      profileByAgentId.set(agentId, profileName);
      handles.set(agentId, handle(agentId));
      return contextFor(agentId);
    }),
    notifyAgentTaskStopped: vi.fn(),
    planSpawn: vi.fn(async () => {
      throw new Error('unexpected planSpawn');
    }),
    spawn: vi.fn(async () => {
      throw new Error('unexpected spawn');
    }),
    fork: vi.fn(async (source, input = {}) => {
      if (options.createError !== undefined) throw options.createError;
      const agentId =
        input.agentId ??
        options.createAgentIds?.[created] ??
        `agent-child-${String(created + 1)}`;
      created += 1;
      profileByAgentId.set(agentId, profileByAgentId.get(source.agentId) ?? 'coder');
      const createdHandle = handle(agentId);
      handles.set(agentId, createdHandle);
      return contextFor(agentId);
    }),
    run: vi.fn(async (agent, request, runOptions): Promise<AgentRunHandle> => {
      const completion =
        options.runCompletion?.(agent.agentId, request, runOptions) ??
        Promise.resolve({ summary: 'child result' });
      return {
        agentId: agent.agentId,
        turn: {} as AgentRunHandle['turn'],
        completion,
      };
    }),
    get: vi.fn((agentId: string) => contextsByAgentId.get(agentId)),
    handleOf: vi.fn((agentId: string) => handles.get(agentId)),
    list: vi.fn(() => [...handles.keys()].map((agentId) => contextFor(agentId))),
    adopt: vi.fn((adopted) => {
      const adoptedHandle = adopted as IAgentScopeHandle;
      handles.set(adoptedHandle.id, adoptedHandle);
      const loop = adoptedHandle.accessor.get(IAgentLoopService);
      const bundle = loop.buildAttachBundle();
      const ref = createActor(createAgentMachine({}), {
        input: {
          request: bundle.request,
          scopeFactory: () =>
            Promise.resolve({
              store: bundle.store,
              turnLogic: bundle.turnLogic,
              toolLogic: bundle.toolLogic,
              tools: bundle.tools,
              request: bundle.request,
            }),
        },
      });
      ref.start();
      loop.attachEngine(ref, bundle);
      return agentContextOf(adoptedHandle);
    }),
    broadcastPermissionMode: vi.fn(),
    remove: vi.fn(async (agent) => {
      handles.delete(agent.agentId);
    }),
    addHandle: (agentId, profileName, services, context) => {
      profileByAgentId.set(agentId, profileName);
      if (services !== undefined) {
        const existing = servicesByAgentId.get(agentId);
        servicesByAgentId.set(
          agentId,
          existing === undefined ? new Map(services) : new Map([...existing, ...services]),
        );
      }
      if (context !== undefined) contextsByAgentId.set(agentId, context);
      handles.set(agentId, handle(agentId));
    },
    publishedEvents,
  };
  return lifecycle;
}

function wireRealSubagentService(ctx: TestAgentContext, lifecycle: AgentLifecycleStub): void {
  const subagents = ctx.get(ISessionSubagentService);
  vi.spyOn(subagents, 'run').mockImplementation(lifecycle.run);
  lifecycle.addHandle(
    'main',
    'agent',
    new Map<unknown, unknown>([
      [IAgentProfileService, ctx.get(IAgentProfileService)],
      [IAgentRuntimeService, ctx.get(IAgentRuntimeService)],
    ]),
    ctx.get(IAgentScopeContext).agentContext,
  );
}

function agentTool(ctx: TestAgentContext): ExecutableTool<SubagentToolInput> {
  const tool = ctx.get(IAgentToolRegistryService).resolve('Agent');
  expect(tool).toBeDefined();
  return tool! as ExecutableTool<SubagentToolInput>;
}

function agentSwarmTool(ctx: TestAgentContext): ExecutableTool<AgentSwarmToolInput> {
  const tool = ctx.get(IAgentToolRegistryService).resolve('AgentSwarm');
  expect(tool).toBeDefined();
  return tool! as ExecutableTool<AgentSwarmToolInput>;
}

function executeAgentTool(
  ctx: TestAgentContext,
  args: SubagentToolInput,
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
    setGeneratedTitleIfUncustomized: async () => false,
    setArchived: async () => {},
    registerAgent: async () => {},
  };
}

function subagentMeta(parentAgentId = 'main'): AgentMeta {
  return {
    labels: { parentAgentId },
  };
}

function discoveredCatalog(): ISessionAgentProfileCatalog {
  const agent = normalizeAgentProfile({
    name: 'agent',
    description: 'Default agent',
    subagents: ['coder', 'explore', 'plan'],
    systemPrompt: () => 'agent',
  });
  const coder = normalizeAgentProfile({
    name: 'coder',
    description: 'Coder',
    systemPrompt: () => 'coder',
  });
  const reviewer = normalizeAgentProfile({
    name: 'reviewer',
    description: 'Reviewer',
    systemPrompt: () => 'reviewer',
  });
  const profiles = [agent, coder, reviewer];
  return {
    _serviceBrand: undefined,
    ready: Promise.resolve(),
    onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
    get: (name) => profiles.find((profile) => profile.name === name),
    getDefault: () => agent,
    list: () => [...profiles],
    inspect: (name) => {
      const profile = profiles.find((candidate) => candidate.name === name);
      if (profile === undefined) return undefined;
      return {
        name,
        profile,
        sourceId: name === 'reviewer' ? 'workspace' : 'builtin',
        priority: 0,
        suppressed: [],
      };
    },
    load: async () => {},
    reload: async () => {},
  };
}

describe('SubagentToolInputSchema', () => {
  it('accepts the snake_case background parameter', () => {
    const parsed = SubagentToolInputSchema.parse({
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

  it('does not expose the timeout parameter in the JSON schema', () => {
    const properties = agentSchemaProperties();

    expect(properties).not.toHaveProperty('timeout');
  });

  it('exposes the model parameter as a free-form string in the JSON schema', () => {
    const properties = agentSchemaProperties<{ description?: string; type?: string; enum?: string[] }>();

    expect(properties['model']?.type).toBe('string');
    expect(properties['model']?.enum).toBeUndefined();
    expect(properties['model']?.description).toContain('Available models');
  });

  it('normalizes the default subagent type into tool args', () => {
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
      }).subagent_type,
    ).toBe('coder');
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Investigate',
        description: 'Find cause',
        subagent_type: '',
      }).subagent_type,
    ).toBe('coder');
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        resume: 'agent-existing',
      }).subagent_type,
    ).toBeUndefined();
  });

  it('exposes the fork parameter in the JSON schema', () => {
    const properties = agentSchemaProperties<{ type?: string }>();

    expect(properties).toHaveProperty('fork');
    expect(properties['fork']?.type).toBe('boolean');
  });

  it('does not default subagent_type when forking', () => {
    expect(
      SubagentToolInputSchema.parse({
        prompt: 'Continue',
        description: 'Continue work',
        fork: true,
      }).subagent_type,
    ).toBeUndefined();
  });
});

describe('Agent tool description', () => {
  let ctx: TestAgentContext;

  afterEach(async () => {
    await ctx.dispose();
    vi.unstubAllEnvs();
  });

  function agentDescription(): string {
    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool).toBeDefined();
    return tool!.description;
  }

  it('renders the tool set for each subagent type', async () => {
    ctx = createTestAgent();
    ctx.configure({
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 0,
      },
    });
    await ctx.get(IEventDispatcher).flush();

    const description = agentDescription();

    expect(description).toContain('Tools: Bash, Read, ReadMediaFile, Glob, Grep, WebSearch, FetchURL');
    expect(description).toContain('Tools: Bash, CronCreate, CronDelete, CronList, Edit');
  });

  it('omits unregistered tools from subagent type descriptions', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('Available agent types');
    expect(description).not.toContain('ReadMediaFile');
    expect(description).toContain('Tools: Bash, Read, Glob, Grep, WebSearch, FetchURL');
  });

  it('lists ReadMediaFile when a selectable pool model has image input even if the primary model does not', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/vision',
          models: { 'provider/vision': 'vision-capable model' },
        },
        models: {
          'provider/vision': {
            provider: 'test-provider',
            model: 'vision-model',
            maxContextSize: 262_144,
            capabilities: ['image_in'],
          },
        },
      },
    });

    const description = agentDescription();

    expect(description).toContain('ReadMediaFile');
  });

  it('omits ReadMediaFile when the tool policy disables it even with a vision-capable pool model', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/vision',
          models: { 'provider/vision': 'vision-capable model' },
        },
        models: {
          'provider/vision': {
            provider: 'test-provider',
            model: 'vision-model',
            maxContextSize: 262_144,
            capabilities: ['image_in'],
          },
        },
        tools: { disabled: ['ReadMediaFile'] },
      },
    });

    const description = agentDescription();

    expect(description).not.toContain('ReadMediaFile');
  });

  it('omits ReadMediaFile when secondary models are forced to a text-only model even if the primary model has image input', async () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: { force: true, defaultModel: 'provider/text' },
        models: {
          'provider/text': {
            provider: 'test-provider',
            model: 'text-model',
            maxContextSize: 262_144,
          },
        },
      },
    });
    ctx.configure({
      modelCapabilities: {
        image_in: true,
        video_in: false,
        audio_in: false,
        thinking: false,
        tool_use: true,
        max_context_tokens: 0,
      },
    });
    await ctx.get(IEventDispatcher).flush();

    const description = agentDescription();

    expect(description).not.toContain('ReadMediaFile');
  });

  it('preserves glob tool patterns that do not end with an asterisk', () => {
    const caller = normalizeAgentProfile({
      name: 'caller',
      description: 'Caller',
      systemPrompt: () => 'caller',
    });
    const globber = normalizeAgentProfile({
      name: 'globber',
      description: 'Globber',
      tools: ['Read', 'mcp__server__get_?_details'],
      systemPrompt: () => 'globber',
    });
    const profiles = [caller, globber];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => profiles,
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- globber: Globber');
    expect(description).toContain('mcp__server__get_?_details');
  });

  it('preserves extglob tool patterns', () => {
    const caller = normalizeAgentProfile({
      name: 'caller',
      description: 'Caller',
      systemPrompt: () => 'caller',
    });
    const globber = normalizeAgentProfile({
      name: 'globber',
      description: 'Globber',
      tools: ['Read', 'mcp__server__@(read|write)'],
      systemPrompt: () => 'globber',
    });
    const profiles = [caller, globber];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => profiles,
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- globber: Globber');
    expect(description).toContain('mcp__server__@(read|write)');
  });

  it('omits the fork parameter and guidance while the subagent_fork flag is off', () => {
    ctx = createTestAgent(forkFlags(false));

    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool).toBeDefined();
    expect(tool!.description).not.toContain('Context forking');
    const properties = (tool!.parameters as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(properties).toBeDefined();
    expect(properties).not.toHaveProperty('fork');
  });

  it('exposes the fork parameter and guidance when the subagent_fork flag is on', () => {
    ctx = createTestAgent(forkFlags());

    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool).toBeDefined();
    expect(tool!.description).toContain('Context forking');
    const properties = (tool!.parameters as { properties?: Record<string, unknown> } | undefined)
      ?.properties;
    expect(properties).toHaveProperty('fork');
  });

  it('does not offer the default agent type to the builtin default caller', () => {
    ctx = createTestAgent();

    const description = agentDescription();

    expect(description).toContain('- coder:');
    expect(description).toContain('- explore:');
    expect(description).not.toContain('- agent:');
  });

  it('lists discovered custom agents for the main agent alongside the builtin allowlist', () => {
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, discoveredCatalog()));
    ctx.get(IAgentProfileService).applyBindingSnapshot({
      modelAlias: 'mock-model',
      profileName: 'agent',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
      subagents: ['coder', 'explore', 'plan'],
    });

    const description = agentDescription();

    expect(description).toContain('- reviewer: Reviewer');
    expect(description).toContain('- coder: Coder');
    expect(description).not.toContain('- agent: Default agent');
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
      .find((line) => line.startsWith('  Tools:') && line.includes('CronCreate'));

    expect(coderTools).toBeDefined();
    expect(coderTools).not.toContain('Bash');
  });

  it('lists contributed tools the caller profile does not activate', () => {
    const callerData = {
      profileName: 'orchestrator',
      activeToolNames: ['Agent', 'Bash', 'Read'],
      disallowedTools: [],
      subagents: ['agent'],
    } as unknown as ProfileData;
    ctx = createTestAgent(
      { autoConfigure: false },
      agentService(IAgentProfileService, {
        _serviceBrand: undefined,
        data: () => callerData,
        getModelCapabilities: () => ({}),
        onDidChange: Event.None,
      } as unknown as IAgentProfileService),
      configServices(() => ({
        providers: {},
        tools: { disabled: ['Write'] },
      })),
    );

    const description = agentDescription();
    const agentTools = description.match(/- agent: [^\n]*\n  Tools: ([^\n]*)/)?.[1];

    expect(agentTools).toBeDefined();
    expect(agentTools).toContain('AgentSwarm');
    expect(agentTools).not.toContain('Write');
  });

  it('renders effective tools after applying disallowedTools', () => {
    const restricted: AgentProfile = normalizeAgentProfile({
      name: 'restricted',
      description: 'Restricted agent',
      tools: ['Bash', 'Read', 'mcp__github__*'],
      disallowedTools: ['Bash', 'mcp__github__*'],
      systemPrompt: () => 'restricted',
    });
    const allowAllExcept: AgentProfile = normalizeAgentProfile({
      name: 'allow-all-except',
      description: 'Allow all except one',
      disallowedTools: ['Bash'],
      systemPrompt: () => 'allow all except',
    });
    const profiles = [restricted, allowAllExcept];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => restricted,
      list: () => profiles,
      inspect: () => undefined,
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
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: ['explore'],
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      tools: ['Read'],
      systemPrompt: () => 'explore',
    });
    const profiles = [caller, coder, explore];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    const description = agentDescription();

    expect(description).toContain('- explore: Explorer');
    expect(description).not.toContain('- coder: Coder');
  });

  it('lists subagent types from the persisted binding instead of the current catalog profile', () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: ['coder'],
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => [caller, coder, explore].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));
    ctx.get(IAgentProfileService).applyBindingSnapshot({
      profileName: 'deleted-profile',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
      subagents: ['explore'],
    });

    const description = agentDescription();

    expect(description).toContain('- explore: Explorer');
    expect(description).not.toContain('- coder: Coder');
  });

  it('freezes the subagent type list once the profile catalog is ready', async () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const profiles = [coder];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => [caller, ...profiles].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [...profiles],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));
    expect(agentDescription()).toContain('- coder: Coder');
    await Promise.resolve();

    const frozen = agentDescription();
    expect(frozen).toContain('- coder: Coder');

    profiles.push(explore);
    const after = agentDescription();
    expect(after).toBe(frozen);
    expect(after).not.toContain('- explore: Explorer');
  });

  it('reflects the current catalog list in the description before the catalog is ready', async () => {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      systemPrompt: () => 'explore',
    });
    const profiles = [coder];
    let resolveReady!: () => void;
    const ready = new Promise<void>((resolve) => {
      resolveReady = resolve;
    });
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready,
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => [caller, ...profiles].find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [...profiles],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    ctx = createTestAgent(sessionService(ISessionAgentProfileCatalog, catalog));

    expect(agentDescription()).toContain('- coder: Coder');
    profiles.push(explore);
    expect(agentDescription()).toContain('- explore: Explorer');

    resolveReady();
    await ready;
  });

  it('renders the available agent types section', () => {
    ctx = createTestAgent();

    expect(agentDescription()).toContain('Available agent types');
  });

  it('omits the models section when no [secondary_model.models] pool is configured', () => {
    ctx = createTestAgent();

    expect(agentDescription()).not.toContain('Available models');
  });

  it('renders the pool in config order with the default first and the caller alias on the primary line', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: {
            'provider/fast': 'fast and cheap',
            'provider/smart': 'hard tasks',
          },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const description = agentDescription();

    expect(description).toContain('Available models');
    const defaultIndex = description.indexOf('- provider/fast [default]: fast and cheap');
    const smartIndex = description.indexOf('- provider/smart: hard tasks');
    const primaryIndex = description.indexOf(
      '- primary (= mock-model): your current model and thinking level\n',
    );
    expect(defaultIndex).toBeGreaterThanOrEqual(0);
    expect(smartIndex).toBeGreaterThan(defaultIndex);
    expect(primaryIndex).toBeGreaterThan(smartIndex);
  });

  it('renders the caller-in-pool alias as a plain entry and renders empty descriptions bare', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: {
            'provider/fast': 'fast and cheap',
            'mock-model': 'the main model, great at hard things',
            'provider/smart': '',
          },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const description = agentDescription();

    expect(description).toContain('- provider/fast [default]: fast and cheap');
    expect(description).toContain('- mock-model: the main model, great at hard things');
    expect(description).toContain('- provider/smart\n');
    expect(description).toContain('- primary (= mock-model): your current model and thinking level\n');
  });

  it('marks the default alias with [default]', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'mock-model',
          models: {
            'mock-model': 'the main model, great at hard things',
            'provider/fast': 'fast and cheap',
          },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const description = agentDescription();

    const defaultIndex = description.indexOf(
      '- mock-model [default]: the main model, great at hard things',
    );
    const fastIndex = description.indexOf('- provider/fast: fast and cheap');
    expect(defaultIndex).toBeGreaterThanOrEqual(0);
    expect(fastIndex).toBeGreaterThan(defaultIndex);
    expect(description).toContain('- primary (= mock-model): your current model and thinking level\n');
  });

  function agentParameters(): Record<string, unknown> {
    const tool = ctx.toolsData().find((entry) => entry.name === 'Agent');
    expect(tool?.parameters).toBeDefined();
    return tool!.parameters!;
  }

  it('strips the model parameter from the advertised schema when no pool is configured', () => {
    ctx = createTestAgent();

    const properties = agentParameters()['properties'] as Record<string, unknown>;

    expect(properties).not.toHaveProperty('model');
    expect(properties).toHaveProperty('prompt');
  });

  it('advertises the model parameter when a pool is configured', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap' },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentParameters()['properties'] as Record<
      string,
      { type?: string; enum?: unknown }
    >;

    expect(properties['model']?.type).toBe('string');
    expect(properties['model']?.enum).toBeUndefined();
  });

  it('strips the model parameter and pool description when no pool is configured', () => {
    ctx = createTestAgent({
      initialConfig: {
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentParameters()['properties'] as Record<string, unknown>;
    expect(properties).not.toHaveProperty('model');
    expect(agentDescription()).not.toContain('Available models');
  });

  it('treats a pool-less default_model as an implicit single-entry pool', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: { defaultModel: 'provider/fast' },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentParameters()['properties'] as Record<string, unknown>;
    expect(properties).toHaveProperty('model');

    const description = agentDescription();
    expect(description).toContain('- provider/fast [default]\n');
    expect(description).toContain('- primary (= mock-model): your current model and thinking level\n');
  });

  it('hides the model parameter and the pool description when force is set', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: { defaultModel: 'provider/fast', force: true },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentParameters()['properties'] as Record<string, unknown>;
    expect(properties).not.toHaveProperty('model');
    expect(agentDescription()).not.toContain('Available models');
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
      modelProviderServices(
        modelCatalogResolving('mock-model', 'provider/fast', 'provider/smart'),
      ),
      ...extra,
    );
    wireRealSubagentService(ctx, lifecycle);
    return ctx;
  }

  function allowlistCatalog(allowlist: readonly string[]): ISessionAgentProfileCatalog {
    const caller: AgentProfile = normalizeAgentProfile({
      name: 'orchestrator',
      description: 'Orchestrator',
      subagents: allowlist,
      systemPrompt: () => 'orchestrator',
    });
    const coder: AgentProfile = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      tools: ['Bash', 'Read'],
      systemPrompt: () => 'coder',
    });
    const explore: AgentProfile = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      tools: ['Read'],
      systemPrompt: () => 'explore',
    });
    const profiles = [caller, coder, explore];
    return {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => caller,
      list: () => [coder, explore],
      inspect: () => undefined,
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

  it('blocks fallback delegation to profiles that can themselves delegate', async () => {
    const agent = normalizeAgentProfile({
      name: 'agent',
      description: 'Default agent',
      subagents: ['coder', 'explore'],
      systemPrompt: () => 'agent',
    });
    const coder = normalizeAgentProfile({
      name: 'coder',
      description: 'Coder',
      tools: ['Agent', 'Read'],
      systemPrompt: () => 'coder',
    });
    const explore = normalizeAgentProfile({
      name: 'explore',
      description: 'Explorer',
      tools: ['Read'],
      systemPrompt: () => 'explore',
    });
    const profiles: AgentProfile[] = [agent, coder, explore];
    const catalog: ISessionAgentProfileCatalog = {
      _serviceBrand: undefined,
      ready: Promise.resolve(),
      onDidChange: Event.None as ISessionAgentProfileCatalog['onDidChange'],
      get: (name) => profiles.find((profile) => profile.name === name),
      getDefault: () => agent,
      list: () => [...profiles],
      inspect: () => undefined,
      load: async () => {},
      reload: async () => {},
    };
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionAgentProfileCatalog, catalog),
    );
    context.get(IAgentProfileService).applyBindingSnapshot({
      modelAlias: 'mock-model',
      profileName: 'coder',
      thinkingLevel: 'off',
      systemPrompt: 'persisted prompt',
    });

    const blocked = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'coder',
    });
    expect(blocked.isError).toBe(true);
    expect(blocked.output).toContain('Subagent type "coder" is not allowed for this agent');
    expect(blocked.output).toContain('explore');

    const allowed = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });
    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ profile: 'explore' }),
      }),
    );
    expect(allowed.output).toContain('actual_subagent_type: explore');
  });

  it('does not create a subagent when process disappears after tool activation', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle);
    vi.spyOn(context.get(IAgentRuntimeService), 'acquire').mockImplementation(() => {
      throw new Error('process capability is no longer available');
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    expect(result).toEqual({
      output: 'subagent error: process capability is no longer available',
      isError: true,
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
    expect(lifecycle.list()).toHaveLength(1);
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

  it('reports a normal completion with stop_reason and a resume hint', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('status: completed');
    expect(result.output).toContain('stop_reason: completed');
    expect(result.output).toContain('[summary]\nchild result');
    expect(result.output).toContain('resume_hint: Continue with Agent(resume="agent-child"');
    expect(result.output).not.toContain('notice:');
    expect(result.output).not.toContain('next_step:');
  });

  it('reports a repeat-breaker handoff as completed with stop_reason repeat_breaker', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({
        summary: 'Stuck: the same grep keeps returning nothing.',
        stopReason: 'repeat_breaker',
      }),
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBeUndefined();
    expect(result.output).toContain('status: completed');
    expect(result.output).toContain('stop_reason: repeat_breaker');
    expect(result.output).toContain('notice: The subagent was stopped by the repeat breaker');
    expect(result.output).toContain('[summary]\nStuck: the same grep keeps returning nothing.');
    expect(result.output).toContain('next_step: The subagent was stuck on one tool call.');
  });

  it('settles a repeat-breaker completion with a stop code and a task reason', async () => {
    const task = new SubagentTask(
      {
        agentId: 'agent-child',
        profileName: 'coder',
        completion: Promise.resolve({ result: 'handoff', stopReason: 'repeat_breaker' }),
      },
      'Find cause',
      new AbortController(),
    );
    const settlements: AgentTaskSettlement[] = [];
    const output: string[] = [];
    await task.start({
      signal: new AbortController().signal,
      appendOutput: (chunk) => {
        output.push(chunk);
      },
      settle: async (settlement) => {
        settlements.push(settlement);
        return true;
      },
    });

    expect(output).toEqual(['handoff']);
    expect(settlements).toEqual([
      { status: 'completed', stopReason: expect.stringContaining('repeat breaker') },
    ]);
    const info = task.toInfo({
      taskId: 'agent-1',
      description: 'Find cause',
      status: 'completed',
      startedAt: 0,
      endedAt: 1,
    });
    expect(info.stopCode).toBe('repeat_breaker');
  });

  it('derives the stop code from the stop reason of a missing-handoff failure', async () => {
    const task = new SubagentTask(
      {
        agentId: 'agent-child',
        profileName: 'coder',
        completion: Promise.reject(
          new Error2(ErrorCodes.AGENT_NO_FINAL_MESSAGE, 'no handoff', {
            details: { stopReason: 'repeat_breaker' },
          }),
        ),
      },
      'Find cause',
      new AbortController(),
    );
    const settlements: AgentTaskSettlement[] = [];
    await task.start({
      signal: new AbortController().signal,
      appendOutput: () => {},
      settle: async (settlement) => {
        settlements.push(settlement);
        return true;
      },
    });

    expect(settlements).toEqual([{ status: 'failed', stopReason: 'no handoff' }]);
    const info = task.toInfo({
      taskId: 'agent-1',
      description: 'Find cause',
      status: 'failed',
      startedAt: 0,
      endedAt: 1,
    });
    expect(info.stopCode).toBe('repeat_breaker');
  });

  it('reports a missing final message as a failure with stop_reason no_final_message', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error2(
          ErrorCodes.AGENT_NO_FINAL_MESSAGE,
          'Subagent turn ended without a final message (stop reason: repeat_breaker).',
        );
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('stop_reason: no_final_message');
    expect(result.output).toContain(
      'subagent error: The subagent was stopped before it finished. Reason: Subagent turn ended without a final message (stop reason: repeat_breaker).',
    );
    expect(result.output).toContain('resume_hint: Continue with Agent(resume="agent-child", prompt="continue")');
    expect(result.output).toContain('next_step: Resume to continue where it stopped');
  });

  it('keeps the repeat_breaker classification when the handoff produced no text', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error2(
          ErrorCodes.AGENT_NO_FINAL_MESSAGE,
          'Subagent turn ended without a final message (stop reason: repeat_breaker).',
          { details: { stopReason: 'repeat_breaker' } },
        );
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('stop_reason: repeat_breaker');
    expect(result.output).toContain('Reason: Subagent turn ended without a final message');
    expect(result.output).toContain('resume_hint: Continue with Agent(resume="agent-child", prompt="continue")');
    expect(result.output).toContain('next_step: The subagent was stuck on one tool call.');
    expect(result.output).not.toContain('[summary]');
  });

  it('maps a step-cap failure to stop_reason max_steps without config advice', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error2(
          ErrorCodes.LOOP_MAX_STEPS_EXCEEDED,
          'Subagent hit the per-turn step cap (maxSteps=5) before finishing its handoff.',
        );
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('stop_reason: max_steps');
    expect(result.output).toContain('maxSteps=5');
    expect(result.output).not.toContain('config.toml');
    expect(result.output).toContain('resume_hint:');
  });

  it('maps a provider filter failure to stop_reason filtered with a rephrase hint', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error2(ErrorCodes.PROVIDER_FILTERED, 'Provider safety policy blocked the response.');
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('stop_reason: filtered');
    expect(result.output).toContain('next_step: Resuming is unlikely to help');
  });

  it('truncates an oversized failure reason', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => {
        throw new Error('x'.repeat(5000));
      },
    });
    const context = createAgentToolContext(lifecycle);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('stop_reason: error');
    expect(result.output).toContain('[truncated]');
    expect((result.output as string).length).toBeLessThan(3000);
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
    expect(lifecycle.list).toHaveBeenCalled();
  });

  it('uses the persisted profile of an offline subagent for display and approval rules', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': { labels: { parentAgentId: 'main', profileName: 'explore' } },
        }),
      ),
    );

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching explore agent: Continue work');
    expect(execution.matchesRule?.('explore')).toBe(true);
    expect(execution.matchesRule?.('coder')).toBe(false);
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('falls back to the generic label when an offline subagent has no persisted profile', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
    );

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching subagent agent: Continue work');
  });

  it('labels fork launches with the caller profile for display and approval rules', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags());
    context.get(IAgentProfileService).update({ profileName: 'orchestrator' });

    const execution = await agentTool(context).resolveExecution({
      prompt: 'Continue',
      description: 'Continue work',
      fork: true,
    });

    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.description).toBe('Launching orchestrator agent: Continue work');
    expect(execution.matchesRule?.('orchestrator')).toBe(true);
    expect(execution.matchesRule?.('coder')).toBe(false);
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

  it('rejects fork combined with resume', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags());
    lifecycle.addHandle('agent-existing', 'explore');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
      fork: true,
    });

    expect(result).toMatchObject({ isError: true, output: FORK_WITH_RESUME_UNAVAILABLE });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects fork with a different subagent type', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags());
    context.get(IAgentProfileService).update({ profileName: 'coder' });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
      fork: true,
    });

    expect(result).toMatchObject({ isError: true, output: FORK_WITH_TYPE_UNAVAILABLE });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('rejects fork with a model override', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags());

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'provider/smart',
      fork: true,
    });

    expect(result).toMatchObject({ isError: true, output: FORK_WITH_MODEL_UNAVAILABLE });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('accepts fork with the primary model choice', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle, forkFlags());

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      model: 'primary',
      fork: true,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('child result');
    expect(lifecycle.fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main' }), {
      labels: expect.objectContaining({ parentAgentId: 'main' }),
    });
  });

  it('launches a fork through the agent lifecycle with subagent labels', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle, forkFlags());
    context.get(IAgentProfileService).update({ profileName: 'coder' });

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      fork: true,
    });

    expect(result.output).toContain('child result');
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main' }), {
      labels: expect.objectContaining({ parentAgentId: 'main' }),
    });
    expect(lifecycle.run).toHaveBeenCalledOnce();
    const [runAgent, runRequest] = lifecycle.run.mock.calls[0]!;
    expect(runAgent).toMatchObject({ agentId: 'agent-child' });
    const runPrompt = runRequest.kind === 'prompt' ? runRequest.prompt : '';
    expect(runPrompt).toBe('Continue the analysis');
  });

  it('forks without requiring the caller profile in the catalog', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle, forkFlags());
    context.get(IAgentProfileService).update({ profileName: 'withdrawn-profile' });

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      fork: true,
    });

    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('child result');
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.fork).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'main' }), {
      labels: expect.objectContaining({ parentAgentId: 'main' }),
    });
  });

  it('rejects fork while the subagent_fork experimental flag is off', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(lifecycle, forkFlags(false));

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      fork: true,
    });

    expect(result).toMatchObject({ isError: true, output: FORK_EXPERIMENTAL_UNAVAILABLE });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.fork).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('marks fork consistently in every subagent_created telemetry emission', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const telemetryRecords: { event: string; properties: unknown }[] = [];
    const context = createAgentToolContext(lifecycle, forkFlags());
    lifecycle.addHandle(
      'main',
      'agent',
      new Map<unknown, unknown>([
        [
          ITelemetryService,
          {
            ...noopTelemetryService,
            track2: (event: string, properties: unknown) => {
              telemetryRecords.push({ event, properties });
            },
          },
        ],
      ]),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue the analysis',
      description: 'Fork context',
      fork: true,
    });

    expect(result.isError).not.toBe(true);
    const created = telemetryRecords.filter((record) => record.event === 'subagent_created');
    expect(created.length).toBeGreaterThan(0);
    for (const record of created) {
      expect(record.properties).toMatchObject({ fork: true, model_source: 'inherited' });
    }
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
      expect.objectContaining({ agentId: 'agent-child' }),
      { kind: 'prompt', prompt: expect.stringContaining('Investigate') },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('child result');
  });

  it('emits subagent.spawned exactly once, after task registration, carrying the task id', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child'],
      runCompletion: async () => ({ summary: 'child result' }),
    });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      subagent_type: 'explore',
    });

    const spawned = lifecycle.publishedEvents.filter(
      (event) => event.type === 'subagent.spawned',
    );
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      subagentId: 'agent-child',
      taskId: expect.any(String),
    });
  });

  it('spawns the subagent on the pool default model when the tool call omits model', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
      },
    });

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          model: 'provider/fast',
          thinking: undefined,
        }),
      }),
    );
    expect(lifecycle.publishedEvents).toContainEqual(
      expect.objectContaining({
        type: 'subagent.spawned',
        subagentId: 'agent-child',
        model: 'provider/fast',
      }),
    );
  });

  it('spawns on the caller model when the tool call opts into "primary"', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap' },
        },
      },
    });

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'primary',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          model: 'mock-model',
          thinking: 'off',
        }),
      }),
    );
  });

  it('binds the caller-in-pool alias without thinking, unlike "primary"', async () => {
    const lifecycle = createAgentLifecycleStub({
      createAgentIds: ['agent-child', 'agent-child-2'],
    });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'mock-model': 'the main model' },
        },
      },
    });

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'mock-model',
    });
    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'primary',
    });

    expect(lifecycle.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        binding: expect.objectContaining({ model: 'mock-model', thinking: undefined }),
      }),
    );
    expect(lifecycle.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        binding: expect.objectContaining({ model: 'mock-model', thinking: 'off' }),
      }),
    );
  });

  it('spawns on the pool alias chosen via the model parameter', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
      },
    });

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'provider/smart',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          model: 'provider/smart',
          thinking: undefined,
        }),
      }),
    );
  });

  it('rejects a model choice outside the pool, listing the available models', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
      },
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'provider/typo',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain(
      'Invalid model "provider/typo". Available models: provider/fast, provider/smart, primary.',
    );
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('inherits the caller model when no pool is configured', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle);

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({
          model: 'mock-model',
          thinking: 'off',
        }),
      }),
    );
  });

  it('binds the forced default_model and rejects any explicit choice, "primary" included', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: { defaultModel: 'provider/fast', force: true },
      },
    });

    const rejected = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'primary',
    });
    expect(rejected.isError).toBe(true);
    expect(rejected.output).toContain('[secondary_model].force is set');
    expect(lifecycle.create).not.toHaveBeenCalled();

    await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });
    expect(lifecycle.create).toHaveBeenCalledWith(
      expect.objectContaining({
        binding: expect.objectContaining({ model: 'provider/fast', thinking: undefined }),
      }),
    );
  });

  it('rejects a pool that gained the reserved "primary" key through a runtime config edit', async () => {
    const lifecycle = createAgentLifecycleStub({ createAgentIds: ['agent-child'] });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap' },
        },
      },
    });
    await (context.get(IConfigService) as StubConfigService).replace(SECONDARY_MODEL_SECTION, {
      defaultModel: 'primary',
      models: { primary: 'reserved word' },
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('[secondary_model.models] key "primary" is reserved');
    expect(lifecycle.create).not.toHaveBeenCalled();
  });

  it('points at the [secondary_model.models] config when the bound alias stops resolving', async () => {
    const lifecycle = createAgentLifecycleStub({
      createError: new Error2(
        ErrorCodes.CONFIG_INVALID,
        'Model "provider/bad" is not configured in config.toml.',
        { details: { model: 'provider/bad' } },
      ),
    });
    const context = createAgentToolContext(
      lifecycle,
      modelProviderServices(modelCatalogResolving('mock-model', 'provider/bad')),
      {
        initialConfig: {
          secondaryModel: { defaultModel: 'provider/bad', models: { 'provider/bad': 'broken' } },
        },
      },
    );

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('Model "provider/bad" is not configured in config.toml.');
    expect(result.output).toContain('comes from [secondary_model.models]');
  });

  it('does not rewrite spawn failures unrelated to the model config', async () => {
    const lifecycle = createAgentLifecycleStub({
      createError: new Error('MCP server failed to start'),
    });
    const context = createAgentToolContext(lifecycle, {
      initialConfig: {
        secondaryModel: { defaultModel: 'provider/fast', models: { 'provider/fast': 'fast and cheap' } },
      },
    });

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      model: 'primary',
    });

    expect(result.isError).toBe(true);
    expect(result.output).toContain('MCP server failed to start');
    expect(result.output).not.toContain('[secondary_model.models]');
  });

  it('mirrors v1-compatible subagent lifecycle event fields', async () => {
    const lifecycle = createAgentLifecycleStub();
    const events: Event2[] = [];
    let agentStateService: AgentStateService | undefined;
    const eventBus = {
      _serviceBrand: undefined,
      publish: vi.fn((event: Event2) => {
        events.push(event);
      }),
      subscribe: vi.fn(() => noopDisposable()),
    } as IEventBus;
    lifecycle.addHandle(
      'agent-child',
      'explore',
      new Map([
        [
          ISessionTokenCountingService,
          {
            _serviceBrand: undefined,
            get: () => ({ size: 321, measured: 300, estimated: 21 }),
            measured: () => {},
            statusSize: () => 321,
          },
        ],
      ]),
    );
    const telemetryRecords: Array<{ event: string; properties: unknown }> = [];
    const dispatcher = {
      _serviceBrand: undefined,
      dispatch: async (event: Event2) => {
        eventBus.publish(event);
      },
    } as unknown as IEventDispatcher;
    const requester = {
      id: 'main',
      kind: LifecycleScope.Agent,
      accessor: {
        get: ((serviceId: unknown) => {
          if (serviceId === IEventBus) return eventBus;
          if (serviceId === IEventDispatcher) return dispatcher;
          if (serviceId === IAgentStateService) {
            agentStateService ??= new AgentStateService();
            return agentStateService;
          }
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
      model: 'provider/secondary',
      modelSource: 'secondary_pool',
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
      model: 'provider/secondary',
      thinkingEffort: 'off',
    });
    expect(telemetryRecords).toContainEqual({
      event: 'subagent_created',
      properties: {
        subagent_name: 'explore',
        run_in_background: false,
        fork: false,
        agent_id: 'agent-child',
        model: 'provider/secondary',
        model_source: 'secondary_pool',
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
      expect.objectContaining({ agentId: 'agent-existing' }),
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('actual_subagent_type: explore');
    expect(result.output).toContain('resumed result');
  });

  it('rebuilds a persisted subagent that is not live before resuming it', async () => {
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed after restart' }),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': {
            type: 'sub',
            parentAgentId: 'main',
            forkedFrom: 'main',
            labels: { parentAgentId: 'main' },
          },
        }),
      ),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    expect(lifecycle.create).toHaveBeenCalledWith({
      agentId: 'agent-existing',
      labels: { parentAgentId: 'main' },
      forkedFrom: 'main',
    });
    expect(lifecycle.run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-existing' }),
      { kind: 'prompt', prompt: 'Continue' },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('agent_id: agent-existing');
    expect(result.output).toContain('resumed after restart');
  });

  it('re-acquires the resume target after the metadata read and rebuilds it when it was evicted meanwhile', async () => {
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed after eviction' }),
    });
    const metadata = sessionMetadataStub({ 'agent-existing': subagentMeta() });
    const snapshot = await metadata.read();
    const readGate = createControlledPromise<typeof snapshot>();
    let armGate = false;
    let gatedReadStarted = false;
    metadata.read = vi.fn(async () => {
      if (!armGate) return snapshot;
      gatedReadStarted = true;
      return readGate;
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, metadata),
    );
    lifecycle.addHandle('agent-existing', 'explore');

    armGate = true;
    const resultPromise = executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });
    await vi.waitFor(() => {
      expect(gatedReadStarted).toBe(true);
    });
    await lifecycle.remove(stubAgentContext('agent-existing', 1));
    readGate.resolve(snapshot);
    const result = await resultPromise;

    expect(lifecycle.create).toHaveBeenCalledTimes(1);
    expect(lifecycle.create).toHaveBeenCalledWith({
      agentId: 'agent-existing',
      labels: { parentAgentId: 'main' },
      forkedFrom: undefined,
    });
    expect(result.isError).not.toBe(true);
    expect(result.output).toContain('resumed after eviction');
  });

  it('stops rebuilding an evicted resume target once the caller aborts', async () => {
    vi.stubEnv(SUBAGENT_SCOPE_EVICT_TIMEOUT_ENV, '1000');
    try {
      const lifecycle = createAgentLifecycleStub({
        createError: new Error2(ErrorCodes.AGENT_ALREADY_EXISTS, 'still closing'),
      });
      const context = createAgentToolContext(
        lifecycle,
        sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
      );
      const controller = new AbortController();

      const resultPromise = executeAgentTool(
        context,
        { prompt: 'Continue', description: 'Continue work', resume: 'agent-existing' },
        controller.signal,
      );
      await vi.waitFor(() => {
        expect(lifecycle.create).toHaveBeenCalled();
      });
      controller.abort(userCancellationReason());
      const createCallsAtAbort = lifecycle.create.mock.calls.length;
      const abortedAt = Date.now();
      const result = await resultPromise;

      expect(result.isError).toBe(true);
      expect(Date.now() - abortedAt).toBeLessThan(500);
      expect(lifecycle.create.mock.calls.length).toBe(createCallsAtAbort);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('keeps rejecting resume of an agent id that was never persisted', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({})),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-missing',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: Agent instance "agent-missing" does not exist',
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('does not rebuild a persisted subagent owned by another parent', async () => {
    const lifecycle = createAgentLifecycleStub();
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({ 'agent-existing': subagentMeta('other') }),
      ),
    );

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toMatchObject({
      isError: true,
      output: 'subagent error: Agent instance "agent-existing" does not belong to this parent agent',
    });
    expect(lifecycle.create).not.toHaveBeenCalled();
    expect(lifecycle.run).not.toHaveBeenCalled();
  });

  it('syncs a rebuilt subagent to the caller permission mode before resuming it', async () => {
    const setMode = vi.fn();
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'resumed after restart' }),
      handleServices: new Map<string, ReadonlyMap<unknown, unknown>>([
        [
          'agent-existing',
          new Map<unknown, unknown>([
            [
              IAgentPermissionModeService,
              { _serviceBrand: undefined, mode: 'yolo', setMode, onDidChangeMode: Event.None },
            ],
          ]),
        ],
      ]),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(ISessionMetadata, sessionMetadataStub({ 'agent-existing': subagentMeta() })),
    );
    context.get(IAgentPermissionModeService).setMode('auto');
    expect(context.get(IAgentPermissionModeService).mode).toBe('auto');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result.isError).not.toBe(true);
    expect(setMode).toHaveBeenCalledWith('auto');
    expect(setMode.mock.invocationCallOrder[0]).toBeLessThan(
      lifecycle.run.mock.invocationCallOrder[0]!,
    );
  });

  it('keeps a rebuilt tower worker on its pinned permission mode', async () => {
    const setMode = vi.fn();
    const lifecycle = createAgentLifecycleStub({
      runCompletion: async () => ({ summary: 'worker resumed' }),
      handleServices: new Map<string, ReadonlyMap<unknown, unknown>>([
        [
          'agent-existing',
          new Map<unknown, unknown>([
            [
              IAgentProfileService,
              {
                _serviceBrand: undefined,
                data: () => ({ profileName: TOWER_WORKER_PROFILE }),
                update: () => {},
                republishStatus: () => {},
                getEffectiveThinkingLevel: () => 'off',
                getActiveToolNames: () => [],
                isToolActive: () => false,
              },
            ],
            [
              IAgentPermissionModeService,
              { _serviceBrand: undefined, mode: 'auto', setMode, onDidChangeMode: Event.None },
            ],
          ]),
        ],
      ]),
    });
    const context = createAgentToolContext(
      lifecycle,
      sessionService(
        ISessionMetadata,
        sessionMetadataStub({
          'agent-existing': { labels: { parentAgentId: 'main', profileName: TOWER_WORKER_PROFILE } },
        }),
      ),
    );
    context.get(IAgentPermissionModeService).setMode('manual');

    const result = await executeAgentTool(context, {
      prompt: 'Continue',
      description: 'Continue work',
      resume: 'agent-existing',
    });

    expect(result).toEqual({ output: expect.stringContaining(`actual_subagent_type: ${TOWER_WORKER_PROFILE}`) });
    expect(setMode).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledOnce();
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
            snapshot: () => ({ state: 'running' }),
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

  it('keeps a directly resumed subagent on its own recorded model', async () => {
    const targetProfile = {
      _serviceBrand: undefined,
      data: () => ({ profileName: 'explore', modelAlias: 'stale-model' }),
      update: vi.fn(),
      republishStatus: vi.fn(),
      getEffectiveThinkingLevel: () => 'medium',
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

    expect(targetProfile.update).not.toHaveBeenCalled();
    expect(lifecycle.run).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-existing' }),
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
    expect(result.output).toContain('note: The user moved this subagent to the background.');

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

  it('reports a background subagent stopped by the task manager as cancelled, not failed', async () => {
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
    const tasks = context.get(IAgentTaskService);

    const result = await executeAgentTool(context, {
      prompt: 'Investigate',
      description: 'Find cause',
      run_in_background: true,
    });
    if (typeof result.output !== 'string') throw new TypeError('expected string output');
    const taskId = result.output.match(/task_id: (agent-[0-9a-z]{8})/)?.[1];
    expect(taskId).toBeDefined();

    await expect(tasks.stop(taskId!, 'no longer needed')).resolves.toMatchObject({
      status: 'killed',
    });

    const terminal = lifecycle.publishedEvents
      .filter((event) => event.type === 'subagent.failed' || event.type === 'subagent.cancelled')
      .map((event) => event.type);
    expect(terminal).toEqual(['subagent.cancelled']);
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
    expect(result.output).toContain('stop_reason: cancelled');
    expect(result.output).toContain('The subagent was stopped before it finished by user.');
    expect(result.output).not.toContain('resume_hint:');
    expect(result.output).toContain('next_step: The user stopped this subagent.');
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
    expect(result.output).toContain('stop_reason: stopped');
    expect(result.output).toContain(
      'The subagent was stopped before it finished. Reason: Session closed',
    );
    expect(result.output).toContain('resume_hint: Continue with Agent(resume="agent-child"');
    expect(result.output).not.toContain('The user stopped this subagent');
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

  it('references the models section and omits background and timeout parameters', () => {
    const properties = agentSwarmSchemaProperties<{ description?: string }>();

    expect(properties['model']?.description).toContain('Available models');
    expect(properties).not.toHaveProperty('run_in_background');
    expect(properties).not.toHaveProperty('timeout');
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

  it('documents the {{item}} placeholder', () => {
    ctx = createTestAgent();

    expect(agentSwarmDescription()).toContain('{{item}}');
  });

  it('omits the models section when no [secondary_model.models] pool is configured', () => {
    ctx = createTestAgent();

    expect(agentSwarmDescription()).not.toContain('Available models');
  });

  it('renders the configured pool as a compact one-line summary', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const description = agentSwarmDescription();

    expect(description).toContain(
      'Available models (pass via model): provider/fast [default], provider/smart, primary (your current model and thinking level).',
    );
  });

  function agentSwarmParameters(): Record<string, unknown> {
    const tool = ctx.toolsData().find((entry) => entry.name === 'AgentSwarm');
    expect(tool?.parameters).toBeDefined();
    return tool!.parameters!;
  }

  it('strips the model parameter from the advertised schema when no pool is configured', () => {
    ctx = createTestAgent();

    const properties = agentSwarmParameters()['properties'] as Record<string, unknown>;

    expect(properties).not.toHaveProperty('model');
    expect(properties).toHaveProperty('prompt_template');
  });

  it('advertises the model parameter when a pool is configured', () => {
    ctx = createTestAgent({
      initialConfig: {
        secondaryModel: {
          defaultModel: 'provider/fast',
          models: { 'provider/fast': 'fast and cheap' },
        },
        models: POOL_MODEL_ENTRIES,
      },
    });

    const properties = agentSwarmParameters()['properties'] as Record<
      string,
      { type?: string; enum?: unknown }
    >;

    expect(properties['model']?.type).toBe('string');
    expect(properties['model']?.enum).toBeUndefined();
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
          plan: { profileName: 'explore', model: 'mock-model', modelSource: 'inherited', thinking: 'off', fork: false },
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
          plan: { profileName: 'explore', model: 'mock-model', modelSource: 'inherited', thinking: 'off', fork: false },
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

  it('threads the pool default model into spawn task plans', async () => {
    const runSwarm = vi.fn(
      async (
        args: SessionSwarmRunArgs,
      ): Promise<readonly SessionSwarmRunResult[]> => {
        return args.tasks.map((task, index) => ({
          task,
          agentId: `agent-explore-${String(index + 1)}`,
          status: 'completed' as const,
          result: 'ok',
        }));
      },
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(
      swarmServices(swarmService),
      {
        initialConfig: {
          secondaryModel: {
            defaultModel: 'provider/fast',
            models: { 'provider/fast': 'fast and cheap', 'provider/smart': 'hard tasks' },
          },
          models: POOL_MODEL_ENTRIES,
        },
      },
    );

    await executeTool(agentSwarmTool(ctx), {
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

    expect(runSwarm).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({
            kind: 'spawn',
            plan: { profileName: 'explore', model: 'provider/fast', modelSource: 'secondary_pool', thinking: undefined, fork: false },
          }),
          expect.objectContaining({
            kind: 'spawn',
            plan: { profileName: 'explore', model: 'provider/fast', modelSource: 'secondary_pool', thinking: undefined, fork: false },
          }),
        ],
      }),
    );
  });

  it('threads the caller model into spawn task plans when the tool call opts into "primary"', async () => {
    const runSwarm = vi.fn(
      async (
        args: SessionSwarmRunArgs,
      ): Promise<readonly SessionSwarmRunResult[]> => {
        return args.tasks.map((task, index) => ({
          task,
          agentId: `agent-explore-${String(index + 1)}`,
          status: 'completed' as const,
          result: 'ok',
        }));
      },
    );
    const swarmService: ISessionSwarmService = {
      _serviceBrand: undefined,
      getSwarmItem: async () => undefined,
      run: runSwarm as ISessionSwarmService['run'],
      cancel: () => {},
    };
    ctx = createTestAgent(
      swarmServices(swarmService),
      {
        initialConfig: {
          secondaryModel: {
            defaultModel: 'provider/fast',
            models: { 'provider/fast': 'fast and cheap' },
          },
          models: POOL_MODEL_ENTRIES,
        },
      },
    );

    await executeTool(agentSwarmTool(ctx), {
      turnId: 0,
      toolCallId: 'call_swarm',
      args: {
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
        subagent_type: 'explore',
        model: 'primary',
      },
      signal,
    });

    expect(runSwarm).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({
            kind: 'spawn',
            plan: { profileName: 'explore', model: 'mock-model', modelSource: 'primary_override', thinking: 'off', fork: false },
          }),
          expect.objectContaining({
            kind: 'spawn',
            plan: { profileName: 'explore', model: 'mock-model', modelSource: 'primary_override', thinking: 'off', fork: false },
          }),
        ],
      }),
    );
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
          plan: { profileName: 'explore', model: 'mock-model', modelSource: 'inherited', thinking: 'off', fork: false },
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

  it('renders a handoff stop reason on a completed subagent and offers a resume hint', async () => {
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
          status: 'completed' as const,
          result: 'Stuck: the same grep keeps returning nothing.',
          stopReason: 'repeat_breaker',
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
      '<summary>completed: 2</summary>',
      '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
      '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
      '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="completed" stop_reason="repeat_breaker">Stuck: the same grep keeps returning nothing.</subagent>',
      '</agent_swarm_result>',
    ].join('\n'));
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
      exec = vi.fn<IHostProcessService['spawn']>().mockRejectedValue(new Error('Bash should not execute'));
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
        execEnvServices({ processRunner: createFakeProcessRunner({ spawn: exec as unknown as IHostProcessService['spawn'] }) }),
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
        );
      wireRealSubagentService(ctx, lifecycle);
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
      await ctx.restorePersisted();
      ctx.mockNextResponse({ type: 'text', text: 'I will look it up.' }, lookupCall);
      await ctx.rpc.prompt({ input: [{ type: 'text', text: 'Look up moon' }] });
      expect(
        await ctx.untilToolCall({
          content: 'moon-result',
          output: 'moon-result',
        }),
      ).toMatchInlineSnapshot(`
        [wire] permission.set_mode         { "agentId": "main", "mode": "auto", "time": "<time>" }
        [wire] tools.register_user_tool    { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "agentId": "main", "time": "<time>" }
        [emit] prompt.submitted            { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "userMessageId": "<msg-1>", "status": "running", "content": [ { "type": "text", "text": "Look up moon" } ], "createdAt": "<time>" }
        [wire] turn.prompt                 { "agentId": "main", "input": [ { "type": "text", "text": "Look up moon" } ], "origin": { "kind": "user" }, "promptId": "<msg-1>", "turnId": 0, "time": "<time>" }
        [emit] turn.started                { "time": "<time>", "agentId": "main", "turnId": 0, "promptId": "<msg-1>", "origin": { "kind": "user" }, "prompt": "Look up moon" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } } ] }
        [emit] prompt.started              { "time": "<time>", "agentId": "main", "promptId": "<msg-1>" }
        [emit] context.spliced             { "time": "<time>", "agentId": "main", "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } } ] }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "id": "<msg-1>", "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
        [wire] agent.message.appended      { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ] }, "meta": { "source": "input", "promptId": "<msg-1>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-1>" } }, "time": "<time>", "kind": "event" }
        [wire] context.append_message      { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" } }, "time": "<time>" }
        [wire] agent.turn.started          { "turnId": 0, "queueItemId": "<msg-1>", "time": "<time>", "kind": "event" }
        [wire] plugin.session_start        { "agentId": "main", "content": null, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-1>", "turnId": "0", "step": 1 }, "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "I will look it up." }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-2>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "part": { "type": "text", "text": "I will look it up." } }, "time": "<time>" }
        [emit] tool.call.started           { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
        [emit] toolCall                    { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        system: <system-prompt>
        tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Lookup, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, WaitFor, Write
        messages:
          user: text "Look up moon"
          user: text <auto-mode-enter-reminder>
      `);

      ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.call", "uuid": "<uuid-3>", "turnId": "0", "step": 1, "stepUuid": "<uuid-1>", "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
        [wire] interaction.request         { "agentId": "main", "id": "<user_tool-1>", "kind": "user_tool", "toolCallId": "call_lookup", "request": { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }, "time": "<time>" }
        [wire] interaction.resolved        { "agentId": "main", "id": "<user_tool-1>", "response": { "content": "moon-result", "output": "moon-result" }, "time": "<time>" }
        [emit] tool.result                 { "time": "<time>", "agentId": "main", "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "tool.result", "parentUuid": "<uuid-3>", "toolCallId": "call_lookup", "result": { "output": "moon-result" } }, "time": "<time>" }
        [emit] turn.step.completed         { "time": "<time>", "agentId": "main", "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 133, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_use", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-1>", "turnId": "0", "step": 1, "finishReason": "tool_use", "usage": { "inputOther": 133, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-1", "providerFinishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "time": "<time>" }
        [emit] turn.step.started           { "time": "<time>", "agentId": "main", "turnId": 0, "step": 2, "stepId": "<uuid-4>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-4>", "turnId": "0", "step": 2 }, "time": "<time>" }
        [emit] assistant.delta             { "time": "<time>", "agentId": "main", "turnId": 0, "delta": "The lookup result is moon-result." }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-5>", "turnId": "0", "step": 2, "stepUuid": "<uuid-4>", "part": { "type": "text", "text": "The lookup result is moon-result." } }, "time": "<time>" }
        [wire] context.append_loop_event   { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-4>", "turnId": "0", "step": 2, "finishReason": "end_turn", "usage": { "inputOther": 153, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-2", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 133, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "tool_calls", "rawFinishReason": "tool_calls" }, "messageId": "mock-1" } }, "time": "<time>", "kind": "event" }
        [wire] agent.message.appended      { "message": { "message": { "role": "tool", "content": [ { "type": "text", "text": "moon-result" } ], "toolCallId": "call_lookup" }, "meta": { "source": "tool" } }, "time": "<time>", "kind": "event" }
        [wire] agent.message.appended      { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is moon-result." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 153, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-2" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.ended            { "turnId": 0, "outcome": "done", "time": "<time>", "kind": "event" }
        [wire] turn.ended                  { "agentId": "main", "turnId": 0, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                  { "time": "<time>", "agentId": "main", "turnId": 0, "reason": "completed" }
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
        [wire] token_counting.turn_recorded   { "agentId": "main", "turnId": 0, "length": 5, "tokens": 165, "time": "<time>" }
        [emit] agent.status.updated           { "time": "<time>", "agentId": "main", "contextTokens": 165 }
        [wire] tools.unregister_user_tool     { "agentId": "main", "name": "Lookup", "time": "<time>" }
        [wire] prompt.completed               { "agentId": "main", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed", "time": "<time>" }
        [emit] prompt.completed               { "time": "<time>", "agentId": "main", "promptId": "<msg-1>", "finishedAt": "<time>", "reason": "completed" }
        [emit] prompt.submitted               { "time": "<time>", "agentId": "main", "promptId": "<msg-2>", "userMessageId": "<msg-2>", "status": "running", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "createdAt": "<time>" }
        [wire] turn.prompt                    { "agentId": "main", "input": [ { "type": "text", "text": "Can you still use Lookup?" } ], "origin": { "kind": "user" }, "promptId": "<msg-2>", "turnId": 1, "time": "<time>" }
        [emit] turn.started                   { "time": "<time>", "agentId": "main", "turnId": 1, "promptId": "<msg-2>", "origin": { "kind": "user" }, "prompt": "Can you still use Lookup?" }
        [emit] context.spliced                { "time": "<time>", "agentId": "main", "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "id": "<msg-2>", "toolCalls": [], "origin": { "kind": "user" } } ] }
        [emit] prompt.started                 { "time": "<time>", "agentId": "main", "promptId": "<msg-2>" }
        [wire] context.append_message         { "agentId": "main", "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "id": "<msg-2>", "toolCalls": [], "origin": { "kind": "user" } }, "time": "<time>" }
        [wire] agent.message.appended         { "message": { "message": { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ] }, "meta": { "source": "input", "promptId": "<msg-2>", "origin": { "kind": "user" }, "tracked": true, "createdAt": "<time>", "userMessageId": "<msg-2>" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.started             { "turnId": 1, "queueItemId": "<msg-2>", "time": "<time>", "kind": "event" }
        [emit] turn.step.started              { "time": "<time>", "agentId": "main", "turnId": 1, "step": 1, "stepId": "<uuid-6>" }
        [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "step.begin", "uuid": "<uuid-6>", "turnId": "1", "step": 1 }, "time": "<time>" }
        [emit] assistant.delta                { "time": "<time>", "agentId": "main", "turnId": 1, "delta": "No lookup tool is available." }
        [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "content.part", "uuid": "<uuid-7>", "turnId": "1", "step": 1, "stepUuid": "<uuid-6>", "part": { "type": "text", "text": "No lookup tool is available." } }, "time": "<time>" }
        [wire] context.append_loop_event      { "agentId": "main", "event": { "type": "step.end", "uuid": "<uuid-6>", "turnId": "1", "step": 1, "finishReason": "end_turn", "usage": { "inputOther": 173, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "messageId": "mock-3", "providerFinishReason": "completed", "rawFinishReason": "stop" }, "time": "<time>" }
        [wire] agent.message.appended         { "message": { "message": { "role": "assistant", "content": [ { "type": "text", "text": "No lookup tool is available." } ], "toolCalls": [] }, "meta": { "model": { "provider": "agent-loop", "model": "agent-loop" }, "source": "llm", "usage": { "inputOther": 173, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finish": { "finishReason": "completed", "rawFinishReason": "stop" }, "messageId": "mock-3" } }, "time": "<time>", "kind": "event" }
        [wire] agent.turn.ended               { "turnId": 1, "outcome": "done", "time": "<time>", "kind": "event" }
        [wire] turn.ended                     { "agentId": "main", "turnId": 1, "reason": "completed", "time": "<time>" }
        [emit] turn.ended                     { "time": "<time>", "agentId": "main", "turnId": 1, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        tools: Agent, AgentSwarm, AskUserQuestion, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, FetchURL, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, TodoList, UpdateGoal, WaitFor, Write
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

      const fullOutput =
        `${'x'.repeat(99)}\n`.repeat(500) +
        'middle elided from preview\n' +
        `${'x'.repeat(99)}\n`.repeat(10);
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
      expect(toolMessage).not.toContain('middle elided from preview');

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

function createFailingCommandRunner(stdout: string): IHostProcessService {
  function createProcess(): IHostProcess {
    return {
      _serviceBrand: undefined,
      stdin: { write: vi.fn(), end: vi.fn() } as unknown as Writable,
      stdout: Readable.from([stdout]),
      stderr: Readable.from(['']),
      pid: 42,
      exitCode: 2,
      wait: vi.fn().mockResolvedValue(2) as IHostProcess['wait'],
      kill: vi.fn().mockResolvedValue(undefined) as IHostProcess['kill'],
      dispose: vi.fn().mockResolvedValue(undefined) as IHostProcess['dispose'],
    };
  }
  return createFakeProcessRunner({
    spawn: vi.fn().mockImplementation(async () => createProcess()),
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
