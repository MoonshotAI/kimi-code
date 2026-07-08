import { Readable, type Writable } from 'node:stream';

import type { IAgentScopeHandle } from '#/_base/di/scope';
import { Event, type Event as KimiEvent } from '#/_base/event';
import { ILogService } from '#/_base/log/log';
import { toInputJsonSchema } from '#/_base/tools/support/input-schema';
import { userCancellationReason } from '#/_base/utils/abort';
import type { ToolCall } from '#/app/llmProtocol/message';
import type { TokenUsage } from '#/app/llmProtocol/usage';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { IAgentContextInjectorService } from '#/agent/contextInjector/contextInjector';
import { IAgentTaskService } from '#/agent/task/task';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { makeHookRunner } from '../externalHooks/runner-stub';
import { IAgentProfileService } from '#/agent/profile/profile';
import { ToolAccesses } from '#/agent/tool/tool-access';
import type { ExecutableTool } from '#/agent/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentUserToolService, type UserToolRegistration } from '#/agent/userTool/userTool';
import {
  AgentSwarmToolInputSchema,
  type AgentSwarmToolInput,
} from '#/agent/swarm/tools/agent-swarm';
import {
  AgentToolInputSchema,
  type AgentToolInput,
} from '#/session/agentLifecycle/tools/agent';
import {
  IAgentLifecycleService,
  type AgentRunHandle,
  type AgentRunRequest,
  type RunAgentOptions,
} from '#/session/agentLifecycle/agentLifecycle';
import { ISessionCronService } from '#/session/cron/sessionCronService';
import type {
  ISessionSwarmService,
  SessionSwarmRunArgs,
  SessionSwarmRunResult,
} from '#/session/swarm/sessionSwarm';
import type { IProcess, ISessionProcessRunner } from '#/session/process/processRunner';
import { IAgentWireService } from '#/wire/tokens';
import { createFakeProcessRunner } from '../tools/fixtures/fake-exec';
import {
  configServices,
  createCommandRunner,
  createTestAgent,
  execEnvServices,
  externalHookServices,
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

interface AgentLifecycleStub extends IAgentLifecycleService {
  readonly create: ReturnType<typeof vi.fn<IAgentLifecycleService['create']>>;
  readonly run: ReturnType<typeof vi.fn<IAgentLifecycleService['run']>>;
  readonly getHandle: ReturnType<typeof vi.fn<IAgentLifecycleService['getHandle']>>;
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
            isToolActive: () => false,
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
        if (serviceId === IAgentWireService) {
          return {
            _serviceBrand: undefined,
            dispatch: () => {},
            getModel: () => [],
            onRestored: () => ({ dispose: () => {} }),
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
      onDidStopAgentTask: hookSlot(),
    },
    onDidCreate: Event.None as KimiEvent<IAgentScopeHandle>,
    onDidCreateMain: Event.None as KimiEvent<IAgentScopeHandle>,
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
    ensureMcpReady: vi.fn(async () => {}),
    notifyMainCreated: vi.fn(),
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
    getHandle: vi.fn((agentId) => handles.get(agentId)),
    list: vi.fn(() => [...handles.values()]),
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

const cronStub = {
  _serviceBrand: undefined,
  list: () => [],
} as unknown as ISessionCronService;

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

    expect(description).toContain('fixed 30-minute timeout');
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
    expect(description).toContain('- coder: Good at general software engineering tasks.');
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
      sessionService(ISessionCronService, cronStub),
      ...extra,
    );
    lifecycle.addHandle('main', 'agent');
    return ctx;
  }

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
    expect(lifecycle.getHandle).toHaveBeenCalledWith('agent-existing');
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
    const context = createAgentToolContext(lifecycle);
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
      timeoutMs: 30 * 60 * 1000,
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
    expect(result.output).toContain('do NOT wait, poll, or call TaskOutput on it');
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
    expect(result.output).not.toContain('was stopped by the user');
    expect(result.output).toContain('not a system error');
    expect(result.output).toContain('capacity');
    expect(result.output).toContain('wait for the user');
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
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
    const result = await resultPromise;

    expect(result).toMatchObject({ isError: true });
    expect(result.output).toContain('agent_id: agent-child');
    expect(result.output).toContain('actual_subagent_type: coder');
    expect(result.output).toContain('status: failed');
    expect(result.output).toContain('subagent error: Agent timed out after 30 minutes.');
    expect(result.output).toContain('resume_hint:');
    expect(result.output).toContain('Agent(resume="agent-child", prompt="continue")');
    expect(result.output).toContain('do not set subagent_type');
    expect(result.output).toContain('retains its prior context');
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
          timeout: 30 * 60 * 1000,
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
          timeout: 30 * 60 * 1000,
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
          timeout: 30 * 60 * 1000,
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
          timeout: 30 * 60 * 1000,
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
          timeout: 30 * 60 * 1000,
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

  afterEach(async () => {
    try {
      await ctx.expectResumeMatches();
    } finally {
      await ctx.dispose();
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
        [wire] permission.set_mode        { "mode": "auto", "time": "<time>" }
        [emit] agent.status.updated       { "permission": "auto" }
        [wire] tools.register_user_tool   { "name": "Lookup", "description": "Look up a short test value.", "parameters": { "type": "object", "properties": { "query": { "type": "string" } }, "required": [ "query" ], "additionalProperties": false }, "time": "<time>" }
        [wire] context.splice             { "start": 0, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Look up moon" } ], "toolCalls": [], "id": "<msg-1>" } ], "time": "<time>" }
        [wire] turn.launch                { "turnId": 0, "origin": { "kind": "user" }, "time": "<time>" }
        [emit] turn.started               { "turnId": 0, "origin": { "kind": "user" } }
        [wire] context.splice             { "start": 1, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "<auto-mode-enter-reminder>" } ], "toolCalls": [], "origin": { "kind": "injection", "variant": "permission_mode" }, "id": "<msg-2>" } ], "time": "<time>" }
        [emit] turn.step.started          { "turnId": 0, "step": 1, "stepId": "<uuid-1>" }
        [emit] assistant.delta            { "turnId": 0, "delta": "I will look it up." }
        [emit] tool.call.delta            { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "argumentsPart": "{\\"query\\":\\"moon\\"}" }
        [wire] usage.record               { "model": "mock-model", "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
        [emit] agent.status.updated       { "usage": { "byModel": { "mock-model": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice             { "start": 2, "deleteCount": 0, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context.splice             { "start": 2, "deleteCount": 1, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ] } ], "time": "<time>" }
        [wire] context_size.measured      { "length": 3, "tokens": 104, "time": "<time>" }
        [emit] agent.status.updated       { "contextTokens": 104 }
        [emit] tool.call.started          { "turnId": 0, "toolCallId": "call_lookup", "name": "Lookup", "args": { "query": "moon" } }
        [emit] toolCall                   { "turnId": 0, "toolCallId": "call_lookup", "args": { "query": "moon" } }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        system: <system-prompt>
        tools: Agent, AgentSwarm, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, GetGoal, Glob, Grep, Lookup, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, UpdateGoal, Write
        messages:
          user: text "Look up moon"
          user: text <auto-mode-enter-reminder>
      `);

      ctx.mockNextResponse({ type: 'text', text: 'The lookup result is moon-result.' });
      expect(await ctx.untilTurnEnd()).toMatchInlineSnapshot(`
        [wire] context.splice          { "start": 3, "deleteCount": 0, "messages": [ { "role": "tool", "content": [ { "type": "text", "text": "moon-result" } ], "toolCalls": [], "toolCallId": "call_lookup", "id": "<msg-4>" } ], "time": "<time>" }
        [emit] tool.result             { "turnId": 0, "toolCallId": "call_lookup", "output": "moon-result" }
        [wire] context.splice          { "start": 2, "deleteCount": 1, "messages": [ { "id": "<msg-3>", "role": "assistant", "content": [ { "type": "text", "text": "I will look it up." } ], "toolCalls": [ { "type": "function", "id": "call_lookup", "name": "Lookup", "arguments": "{\\"query\\":\\"moon\\"}" } ], "providerMessageId": "mock-1" } ], "time": "<time>" }
        [emit] turn.step.completed     { "turnId": 0, "step": 1, "stepId": "<uuid-1>", "usage": { "inputOther": 88, "output": 16, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "tool_calls" }
        [emit] turn.step.started       { "turnId": 0, "step": 2, "stepId": "<uuid-2>" }
        [emit] assistant.delta         { "turnId": 0, "delta": "The lookup result is moon-result." }
        [wire] usage.record            { "model": "mock-model", "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 0 }, "time": "<time>" }
        [emit] agent.status.updated    { "usage": { "byModel": { "mock-model": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 196, "output": 28, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice          { "start": 4, "deleteCount": 0, "messages": [ { "id": "<msg-5>", "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is moon-result." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context_size.measured   { "length": 5, "tokens": 120, "time": "<time>" }
        [emit] agent.status.updated    { "contextTokens": 120 }
        [wire] context.splice          { "start": 4, "deleteCount": 1, "messages": [ { "id": "<msg-5>", "role": "assistant", "content": [ { "type": "text", "text": "The lookup result is moon-result." } ], "toolCalls": [], "providerMessageId": "mock-2" } ], "time": "<time>" }
        [emit] turn.step.completed     { "turnId": 0, "step": 2, "stepId": "<uuid-2>", "usage": { "inputOther": 108, "output": 12, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "completed" }
        [emit] turn.ended              { "turnId": 0, "reason": "completed" }
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
        [wire] tools.unregister_user_tool   { "name": "Lookup", "time": "<time>" }
        [wire] context.splice               { "start": 5, "deleteCount": 0, "messages": [ { "role": "user", "content": [ { "type": "text", "text": "Can you still use Lookup?" } ], "toolCalls": [], "id": "<msg-6>" } ], "time": "<time>" }
        [wire] turn.launch                  { "turnId": 1, "origin": { "kind": "user" }, "time": "<time>" }
        [emit] turn.started                 { "turnId": 1, "origin": { "kind": "user" } }
        [emit] turn.step.started            { "turnId": 1, "step": 1, "stepId": "<uuid-3>" }
        [emit] assistant.delta              { "turnId": 1, "delta": "No lookup tool is available." }
        [wire] usage.record                 { "model": "mock-model", "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "context": { "type": "turn", "turnId": 1 }, "time": "<time>" }
        [emit] agent.status.updated         { "usage": { "byModel": { "mock-model": { "inputOther": 324, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 } }, "total": { "inputOther": 324, "output": 38, "inputCacheRead": 0, "inputCacheCreation": 0 }, "currentTurn": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 } } }
        [wire] context.splice               { "start": 6, "deleteCount": 0, "messages": [ { "id": "<msg-7>", "role": "assistant", "content": [ { "type": "text", "text": "No lookup tool is available." } ], "toolCalls": [] } ], "time": "<time>" }
        [wire] context_size.measured        { "length": 7, "tokens": 138, "time": "<time>" }
        [emit] agent.status.updated         { "contextTokens": 138 }
        [wire] context.splice               { "start": 6, "deleteCount": 1, "messages": [ { "id": "<msg-7>", "role": "assistant", "content": [ { "type": "text", "text": "No lookup tool is available." } ], "toolCalls": [], "providerMessageId": "mock-3" } ], "time": "<time>" }
        [emit] turn.step.completed          { "turnId": 1, "step": 1, "stepId": "<uuid-3>", "usage": { "inputOther": 128, "output": 10, "inputCacheRead": 0, "inputCacheCreation": 0 }, "finishReason": "completed" }
        [emit] turn.ended                   { "turnId": 1, "reason": "completed" }
      `);
      expect(ctx.lastLlmInput()).toMatchInlineSnapshot(`
        tools: Agent, AgentSwarm, Bash, CreateGoal, CronCreate, CronDelete, CronList, Edit, EnterPlanMode, ExitPlanMode, GetGoal, Glob, Grep, Read, SetGoalBudget, Skill, TaskList, TaskOutput, TaskStop, UpdateGoal, Write
        messages:
          <last>
          assistant: text "The lookup result is moon-result."
          user: text "Can you still use Lookup?"
      `);
    });
  });
});

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
