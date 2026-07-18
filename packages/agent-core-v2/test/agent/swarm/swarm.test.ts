/**
 * Scenario: AgentSwarm collaboration behavior, including optional subagent model selection.
 * Responsibilities: validates tool exposure and forwards one resolved model alias to every swarm task.
 * Wiring: real tool formatting/task construction with stubbed swarm, model, profile, and flag boundaries.
 * Run: pnpm --filter @moonshot-ai/agent-core-v2 test -- test/agent/swarm/swarm.test.ts
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { DEFAULT_SUBAGENT_TIMEOUT_MS } from '#/session/subagent/configSection';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import {
  ISessionSwarmService,
  type SessionSwarmRunArgs,
  type SessionSwarmRunResult,
  type SessionSwarmTask,
} from '#/session/swarm/sessionSwarm';
import { IAgentSystemReminderService } from '#/agent/systemReminder/systemReminder';
import { AgentSystemReminderService } from '#/agent/systemReminder/systemReminderService';
import { IAgentSwarmService } from '#/agent/swarm/swarm';
import { AgentSwarmService } from '#/agent/swarm/swarmService';
import { SwarmModel } from '#/agent/swarm/swarmOps';
import { AgentSwarmTool, AgentSwarmToolInputSchema } from '#/agent/swarm/tools/agent-swarm';
import type { ExecutableToolContext } from '#/tool/toolContract';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { AgentToolRegistryService } from '#/agent/toolRegistry/toolRegistryService';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { type ModelConfig, IModelService } from '#/app/model/model';
import { IModelResolver } from '#/app/model/modelResolver';
import { IAgentProfileService } from '#/agent/profile/profile';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import { AGENT_WIRE_RECORD_KEY, type WireRecord } from '#/wire/record';
import { type DomainEvent, IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';

import { stubContextMemory } from '../contextMemory/stubs';
import { executeTool } from '../../tools/fixtures/execute-tool';
import { registerTestAgentWire, restoreTestAgentWire, testWireScope } from '../../wire/stubs';
import { stubLoopWithHooks } from '../loop/stubs';
import { stubFlag } from '../../app/flag/stubs';

const signal = new AbortController().signal;

function context<Input>(
  args: Input,
  toolCallId = 'call_swarm',
): ExecutableToolContext & { readonly args: Input } {
  return { turnId: 0, toolCallId, args, signal };
}

function mockSwarmHost({
  run = vi.fn().mockResolvedValue([]),
  getSwarmItem = vi.fn().mockResolvedValue(undefined),
}: {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly run?: (...args: any[]) => any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  readonly getSwarmItem?: (...args: any[]) => any;
} = {}) {
  const validatingRun = vi.fn(async (args: SessionSwarmRunArgs<unknown>) => {
    args.onValidated?.();
    return await run(args);
  });
  return {
    swarmService: {
      _serviceBrand: undefined,
      getSwarmItem,
      run: validatingRun,
      cancel: vi.fn(),
    },
    callerAgentId: 'main',
  };
}

function mockSwarmMode() {
  return { _serviceBrand: undefined, isActive: false, enter: vi.fn(), exit: vi.fn() };
}

function stubConfig(timeoutMs?: number): IConfigService {
  return {
    _serviceBrand: undefined,
    get: () => (timeoutMs === undefined ? undefined : { timeoutMs }),
  } as unknown as IConfigService;
}

interface AgentSwarmToolRigOptions {
  readonly timeoutMs?: number;
  readonly modelSelectionEnabled?: boolean | (() => boolean);
  readonly models?: Record<string, ModelConfig>;
  readonly currentModel?: string | (() => string);
  readonly resolveModel?: (alias: string) => unknown;
  readonly swarmMode?: ReturnType<typeof mockSwarmMode>;
}

function agentSwarmToolRig(
  host: ReturnType<typeof mockSwarmHost> = mockSwarmHost(),
  options: AgentSwarmToolRigOptions = {},
) {
  const models = options.models ?? {
    'main-model': {
      name: 'wire-main',
      displayName: 'Main model',
      capabilities: ['thinking', 'tool_use'],
      maxContextSize: 131_072,
    },
  };
  const currentModel = options.currentModel ?? 'main-model';
  const resolve = vi.fn(
    options.resolveModel ??
      ((alias: string) => {
        if (models[alias] === undefined) throw new Error(`Unknown model alias: ${alias}`);
        return {};
      }),
  );
  const modelService = {
    _serviceBrand: undefined,
    list: () => models,
  } as unknown as IModelService;
  const profile = {
    _serviceBrand: undefined,
    data: () => ({
      modelAlias: typeof currentModel === 'function' ? currentModel() : currentModel,
    }),
  } as unknown as IAgentProfileService;
  const resolver = {
    _serviceBrand: undefined,
    resolve,
    findByName: () => [],
  } as unknown as IModelResolver;
  const swarmMode = options.swarmMode ?? mockSwarmMode();
  const flags: IFlagService = stubFlag(options.modelSelectionEnabled ?? false);
  const tool = new AgentSwarmTool(
    host.swarmService,
    makeAgentScopeContext({ agentId: host.callerAgentId, agentScope: '' }),
    swarmMode,
    stubConfig(options.timeoutMs),
    modelService,
    profile,
    resolver,
    flags,
  );
  return { tool, resolve, swarmMode };
}

describe('AgentSwarmService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IAgentContextMemoryService, stubContextMemory());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    ix.stub(IAgentLoopService, stubLoopWithHooks());
    ix.set(IAgentToolRegistryService, new SyncDescriptor(AgentToolRegistryService));
    ix.stub(IAgentLifecycleService, {});
    ix.stub(ISessionSwarmService, {
      getSwarmItem: async () => undefined,
      run: async () => [],
      cancel: () => {},
    });
    registerTestAgentWire(ix, testWireScope('wire', 'swarm-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    ix.set(IAgentSystemReminderService, new SyncDescriptor(AgentSystemReminderService));
    ix.set(IAgentSwarmService, new SyncDescriptor(AgentSwarmService));
  });
  afterEach(() => disposables.dispose());

  it('enter / exit toggle isActive and emit agent.status.updated via wire', () => {
    const swarm = ix.get(IAgentSwarmService);
    const events: DomainEvent[] = [];
    disposables.add(ix.get(IEventBus).subscribe((e) => events.push(e)));

    expect(swarm.isActive).toBe(false);
    swarm.enter('manual');
    expect(swarm.isActive).toBe(true);
    swarm.exit();
    expect(swarm.isActive).toBe(false);

    expect(events).toEqual([
      { type: 'agent.status.updated', swarmMode: true },
      { type: 'agent.status.updated', swarmMode: false },
      { type: 'context.spliced', start: 0, deleteCount: 1, messages: [] },
    ]);
  });

  it('dispatch persists enter/exit records and replay rebuilds the trigger (silent)', async () => {
    const swarm = ix.get(IAgentSwarmService);
    swarm.enter('manual');

    const log = ix.get(IAppendLogStore);
    const records: WireRecord[] = [];
    for await (const record of log.read<WireRecord>(
      testWireScope('wire', 'swarm-test'),
      AGENT_WIRE_RECORD_KEY,
    )) {
      records.push(record);
    }
    expect(records).toEqual([
      { type: 'swarm_mode.enter', trigger: 'manual', time: expect.any(Number) },
    ]);

    const ix2 = disposables.add(new TestInstantiationService());
    ix2.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix2.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    const fresh = registerTestAgentWire(ix2, testWireScope('wire', 'swarm-replay'), {
      log: ix2.get(IAppendLogStore),
    });
    await restoreTestAgentWire(
      fresh,
      ix2.get(IAppendLogStore),
      testWireScope('wire', 'swarm-replay'),
      records,
    );
    expect(fresh.getModel(SwarmModel)).toBe('manual');
  });
});

describe('AgentSwarmTool', () => {
  it('applies one subagent_type across templated subagents', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockResolvedValue([
        {
          task: {
            kind: 'spawn',
            data: {
              kind: 'spawn',
              index: 1,
              item: 'src/a.ts',
              prompt: 'Review src/a.ts',
            },
            profileName: 'explore',
            parentToolCallId: 'call_swarm',
            prompt: 'Review src/a.ts',
            description: 'Review files #1 (explore)',
            runInBackground: false,
          },
          agentId: 'agent-explore-1',
          status: 'completed',
          result: 'explore result a',
        },
        {
          task: {
            kind: 'spawn',
            data: {
              kind: 'spawn',
              index: 2,
              item: 'src/b.ts',
              prompt: 'Review src/b.ts',
            },
            profileName: 'explore',
            parentToolCallId: 'call_swarm',
            prompt: 'Review src/b.ts',
            description: 'Review files #2 (explore)',
            runInBackground: false,
          },
          agentId: 'agent-explore-2',
          status: 'completed',
          result: 'explore result b',
        },
      ]),
    });
    const swarmMode = mockSwarmMode();
    const { tool } = agentSwarmToolRig(host, { swarmMode });
    const input = {
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
      subagent_type: 'explore',
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 128 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        ...input,
        items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
      }).success,
    ).toBe(false);
    expect(tool.parameters).toMatchObject({
      type: 'object',
      properties: {
        subagent_type: { type: 'string' },
      },
    });
    expect(
      (
        tool.parameters['properties'] as Record<
          string,
          { readonly description?: string }
        >
      )['subagent_type']?.description,
    ).toBe(
      'Subagent type used for every new subagent spawned from items; defaults to coder when omitted. Resumed subagents always keep their original type, so passing subagent_type together with resume_agent_ids is allowed — it only affects the item-based spawns.',
    );
    expect(Object.keys(tool.parameters['properties'] as Record<string, unknown>).at(-1)).toBe(
      'resume_agent_ids',
    );

    const result = await executeTool(tool, context(input));

    expect(swarmMode.enter).toHaveBeenCalledWith('tool');
    expect(host.swarmService.run).toHaveBeenCalledTimes(1);
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
      {
        kind: 'spawn',
        data: {
          kind: 'spawn',
          index: 1,
          item: 'src/a.ts',
          prompt: 'Review src/a.ts',
        },
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/a.ts',
        description: 'Review files #1 (explore)',
        modelAlias: 'main-model',
        swarmIndex: 1,
        swarmItem: 'src/a.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
      {
        kind: 'spawn',
        data: {
          kind: 'spawn',
          index: 2,
          item: 'src/b.ts',
          prompt: 'Review src/b.ts',
        },
        profileName: 'explore',
        parentToolCallId: 'call_swarm',
        prompt: 'Review src/b.ts',
        description: 'Review files #2 (explore)',
        modelAlias: 'main-model',
        swarmIndex: 2,
        swarmItem: 'src/b.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 2</summary>',
        '<subagent agent_id="agent-explore-1" item="src/a.ts" outcome="completed">explore result a</subagent>',
        '<subagent agent_id="agent-explore-2" item="src/b.ts" outcome="completed">explore result b</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('does not expose permission rule argument matching', () => {
    const host = mockSwarmHost();
    const { tool } = agentSwarmToolRig(host);
    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });

    expect(execution.isError).toBeUndefined();
    if (execution.isError === true) throw new Error('expected a successful execution');
    expect(execution.approvalRule).toBe('AgentSwarm');
    expect(execution.matchesRule).toBeUndefined();
  });

  it('description states the enforced input requirements', () => {
    const host = mockSwarmHost();
    const { tool } = agentSwarmToolRig(host);
    expect(tool.description).toContain('at least 2');
    expect(tool.description).toContain('{{item}}');
    expect(tool.description.toLowerCase()).toContain('distinct');
  });

  it('omits the model parameter when model selection is disabled', () => {
    const { tool } = agentSwarmToolRig();

    expect(tool.parameters['properties']).not.toHaveProperty('model');
  });

  it('omits the model directory when model selection is disabled', () => {
    const { tool } = agentSwarmToolRig(undefined, {
      models: {
        'private-model-alias': { name: 'wire-private-model' },
      },
      currentModel: 'private-model-alias',
    });

    expect(tool.description).not.toContain('Available configured models for subagents');
    expect(tool.description).not.toContain('private-model-alias');
  });

  it('exposes the model parameter when model selection is enabled', () => {
    const { tool } = agentSwarmToolRig(undefined, { modelSelectionEnabled: true });

    expect(tool.parameters['properties']).toMatchObject({
      model: {
        type: 'string',
        description: expect.stringContaining('Configured model alias'),
      },
    });
  });

  it('updates the model schema and directory when the feature flag changes live', () => {
    let enabled = false;
    const { tool } = agentSwarmToolRig(undefined, {
      modelSelectionEnabled: () => enabled,
    });

    expect(tool.parameters['properties']).not.toHaveProperty('model');
    expect(tool.description).not.toContain('"main-model"');

    enabled = true;
    expect(tool.parameters['properties']).toHaveProperty('model');
    expect(tool.description).toContain('"main-model"');

    enabled = false;
    expect(tool.parameters['properties']).not.toHaveProperty('model');
    expect(tool.description).not.toContain('"main-model"');
  });

  it('renders a live sanitized model directory when model selection is enabled', () => {
    const unsafeAlias = 'unsafe\u202Ealias';
    const models: Record<string, ModelConfig> = {
      'main-model': {
        name: 'wire-main-secret',
        baseUrl: 'https://private.example.test/v1',
        apiKey: 'SUPER_SECRET_API_KEY',
        displayName: 'Main model',
        capabilities: ['thinking', 'tool_use', 'ignore_prior_instructions'],
        maxContextSize: 131_072,
      },
      'invalid-model': { name: 'wire-invalid-secret' },
      [unsafeAlias]: { name: 'wire-unsafe-secret' },
    };
    const { tool } = agentSwarmToolRig(undefined, {
      modelSelectionEnabled: true,
      models,
      resolveModel: (alias) => {
        if (alias === 'invalid-model') throw new Error('invalid model configuration');
        return {};
      },
    });

    models['late-model'] = { name: 'wire-late-secret', displayName: 'Late model' };

    expect(tool.description).toContain('Available configured models for subagents');
    expect(tool.description).toContain('"main-model"');
    expect(tool.description).not.toContain('name="Main model"');
    expect(tool.description).toContain('capabilities=["thinking","tool_use"]');
    expect(tool.description).toContain('current=true');
    expect(tool.description).toContain('"late-model"');
    expect(tool.description).not.toContain('invalid-model');
    expect(tool.description).not.toContain('ignore_prior_instructions');
    expect(tool.description).not.toContain(unsafeAlias);
    expect(tool.description).not.toContain('wire-main-secret');
    expect(tool.description).not.toContain('private.example.test');
    expect(tool.description).not.toContain('SUPER_SECRET_API_KEY');
  });

  it('rejects a configured alias beyond the exposed model-directory limit', async () => {
    const models = Object.fromEntries(
      Array.from({ length: 65 }, (_, index) => [
        `model-${String(index).padStart(3, '0')}`,
        { name: `wire-${String(index)}` },
      ]),
    );
    const host = mockSwarmHost();
    const { tool } = agentSwarmToolRig(host, {
      modelSelectionEnabled: true,
      models,
      currentModel: 'model-000',
    });

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
        model: 'model-064',
      }),
    );

    expect(result).toMatchObject({
      isError: true,
      output:
        'Selected subagent model is unavailable. Refresh the model directory and choose an exact listed alias.',
    });
    expect(host.swarmService.run).not.toHaveBeenCalled();
  });

  it('preserves one explicit model alias exactly across spawned and resumed tasks', async () => {
    const host = mockSwarmHost();
    const { tool, resolve } = agentSwarmToolRig(host, {
      modelSelectionEnabled: true,
      models: {
        'main-model': { name: 'wire-main' },
        'Child.Model/fast': { name: 'wire-child' },
      },
    });

    const result = await executeTool(
      tool,
      context({
        description: 'Continue and review',
        model: 'Child.Model/fast',
        prompt_template: 'Review {{item}}',
        items: ['src/new.ts'],
        resume_agent_ids: { 'agent-old-1': 'Continue previous review' },
      }),
    );

    expect(resolve).toHaveBeenCalledWith('Child.Model/fast');
    expect(host.swarmService.run).toHaveBeenCalledWith({
      callerAgentId: 'main',
      onValidated: expect.any(Function),
      tasks: [
        expect.objectContaining({
          kind: 'resume',
          resumeAgentId: 'agent-old-1',
          modelAlias: 'Child.Model/fast',
        }),
        expect.objectContaining({
          kind: 'spawn',
          modelAlias: 'Child.Model/fast',
        }),
      ],
    });
    expect(result.isError).toBeUndefined();
  });

  it('shows and executes the inherited model approved before live config changes', async () => {
    let enabled = true;
    let currentModel = 'model-a';
    const host = mockSwarmHost();
    const { tool } = agentSwarmToolRig(host, {
      modelSelectionEnabled: () => enabled,
      currentModel: () => currentModel,
      models: {
        'model-a': { name: 'wire-a' },
        'model-b': { name: 'wire-b' },
      },
    });

    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
    });
    if (execution.isError === true) throw new Error('expected runnable execution');
    expect(execution.display).toMatchObject({
      kind: 'agent_call',
      agent_name: 'swarm (2 subagents) · model model-a',
    });

    currentModel = 'model-b';
    enabled = false;
    await execution.execute({ turnId: 0, toolCallId: 'call_swarm', signal });

    expect(host.swarmService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({ modelAlias: 'model-a' }),
          expect.objectContaining({ modelAlias: 'model-a' }),
        ],
      }),
    );
  });

  it('does not enter swarm mode after the tool call is cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    const host = mockSwarmHost();
    const swarmMode = mockSwarmMode();
    const { tool } = agentSwarmToolRig(host, { swarmMode });

    const result = await executeTool(tool, {
        ...context({
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['src/a.ts', 'src/b.ts'],
        }),
        signal: controller.signal,
      });

    expect(result).toMatchObject({ isError: true, output: 'This operation was aborted' });
    expect(swarmMode.enter).not.toHaveBeenCalled();
  });

  it('rejects an invalid explicit model before dispatching the swarm', async () => {
    const host = mockSwarmHost();
    const { tool, swarmMode } = agentSwarmToolRig(host, { modelSelectionEnabled: true });

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        model: 'missing-model',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(result).toMatchObject({
      output:
        'Selected subagent model is unavailable. Refresh the model directory and choose an exact listed alias.',
      isError: true,
    });
    expect(host.swarmService.run).not.toHaveBeenCalled();
    expect(swarmMode.enter).not.toHaveBeenCalled();
  });

  it('redacts resolver details when the approved model disappears before dispatch', async () => {
    let unavailable = false;
    const host = mockSwarmHost();
    const { tool } = agentSwarmToolRig(host, {
      modelSelectionEnabled: true,
      resolveModel: () => {
        if (unavailable) throw new Error('private provider endpoint and SECRET_API_KEY');
        return {};
      },
    });
    const execution = tool.resolveExecution({
      description: 'Review files',
      prompt_template: 'Review {{item}}',
      items: ['src/a.ts', 'src/b.ts'],
      model: 'main-model',
    });
    if (execution.isError === true) throw new Error('expected runnable execution');
    unavailable = true;

    const result = await execution.execute({ turnId: 0, toolCallId: 'call_swarm', signal });

    expect(result).toMatchObject({
      isError: true,
      output:
        'Selected subagent model is unavailable. Refresh the model directory and choose an exact listed alias.',
    });
    expect(result.output).not.toContain('SECRET_API_KEY');
    expect(result.output).not.toContain('private provider endpoint');
    expect(host.swarmService.run).not.toHaveBeenCalled();
  });

  it('rejects invalid launch shapes at execution time', async () => {
    const cases = [
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: Array.from({ length: 129 }, (_, index) => `src/${String(index + 1)}.ts`),
        },
        output: 'AgentSwarm supports at most 128 subagents.',
      },
      {
        input: {
          description: 'Review one file',
          prompt_template: 'Review {{item}}',
          items: ['src/only.ts'],
        },
        output: 'AgentSwarm requires at least 2 items unless resume_agent_ids is provided.',
      },
      {
        input: {
          description: 'Review files',
          items: ['src/a.ts', 'src/b.ts'],
        },
        output: 'prompt_template is required when items are provided.',
      },
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review files',
          items: ['src/a.ts', 'src/b.ts'],
        },
        output: 'prompt_template must include the {{item}} placeholder.',
      },
      {
        input: {
          description: 'Review files',
          prompt_template: 'Review {{item}}',
          items: ['same', 'same'],
        },
        output:
          'Duplicate subagent prompts from items 1 and 2. AgentSwarm requires distinct subagents.',
      },
    ];

    for (const testCase of cases) {
      const host = mockSwarmHost();
      const { tool, swarmMode } = agentSwarmToolRig(host);

      const result = await executeTool(tool, context(testCase.input));

      expect(result.output).toBe(testCase.output);
      expect(result.isError).toBe(true);
      expect(host.swarmService.run).not.toHaveBeenCalled();
      expect(swarmMode.enter).not.toHaveBeenCalled();
    }
  });

  it('resumes mapped agents before spawning item subagents', async () => {
    const run = vi.fn(
      async <T>({
        tasks,
      }: {
        tasks: readonly SessionSwarmTask<T>[];
      }): Promise<Array<SessionSwarmRunResult<T>>> => {
        return tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: `result ${String(index + 1)}`,
        }));
      },
    );
    const persistedItems: Record<string, string> = {
      'agent-old-1': 'src/old-a.ts',
      'agent-old-2': 'src/old-b.ts',
    };
    const getSwarmItem = vi.fn(
      async ({ agentId }: { readonly agentId: string }) => persistedItems[agentId],
    );
    const host = mockSwarmHost({ run, getSwarmItem });
    const { tool } = agentSwarmToolRig(host);
    const input = {
      description: 'Finish review',
      subagent_type: 'explore',
      prompt_template: 'Review {{item}}',
      items: ['src/new.ts'],
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
        'agent-old-2': 'Continue previous review B',
      },
    };

    expect(AgentSwarmToolInputSchema.safeParse(input).success).toBe(true);
    expect(
      AgentSwarmToolInputSchema.safeParse({
        description: 'Resume one agent',
        resume_agent_ids: { 'agent-old-1': 'Continue previous review A' },
      }).success,
    ).toBe(true);

    const result = await executeTool(tool, context(input));

    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-1',
    });
    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-2',
    });
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
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
        modelAlias: 'main-model',
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
        modelAlias: 'main-model',
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
        modelAlias: 'main-model',
        swarmIndex: 3,
        swarmItem: 'src/new.ts',
        runInBackground: false,
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 3</summary>',
        '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">result 1</subagent>',
        '<subagent mode="resume" agent_id="agent-old-2" item="src/old-b.ts" outcome="completed">result 2</subagent>',
        '<subagent agent_id="agent-new-3" item="src/new.ts" outcome="completed">result 3</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('allows a single resumed subagent without item subagents', async () => {
    const run = vi.fn(
      async <T>({
        tasks,
      }: {
        tasks: readonly SessionSwarmTask<T>[];
      }): Promise<Array<SessionSwarmRunResult<T>>> => {
        return tasks.map((task, index) => ({
          task,
          agentId: task.kind === 'resume' ? task.resumeAgentId : `agent-new-${String(index + 1)}`,
          status: 'completed' as const,
          result: 'resumed result',
        }));
      },
    );
    const getSwarmItem = vi.fn(async () => 'src/old-a.ts');
    const host = mockSwarmHost({ run, getSwarmItem });
    const { tool } = agentSwarmToolRig(host);
    const input = {
      description: 'Resume review',
      resume_agent_ids: {
        'agent-old-1': 'Continue previous review A',
      },
    };

    const result = await executeTool(tool, context(input));

    expect(getSwarmItem).toHaveBeenCalledWith({
      callerAgentId: 'main',
      agentId: 'agent-old-1',
    });
    expect(host.swarmService.run).toHaveBeenCalledWith(expect.objectContaining({ tasks: [
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
        description: 'Resume review #1 (resume)',
        modelAlias: 'main-model',
        swarmIndex: 1,
        swarmItem: 'src/old-a.ts',
        runInBackground: false,
        resumeAgentId: 'agent-old-1',
        signal,
        timeout: DEFAULT_SUBAGENT_TIMEOUT_MS,
      },
    ] }));
    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1</summary>',
        '<subagent mode="resume" agent_id="agent-old-1" item="src/old-a.ts" outcome="completed">resumed result</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
  });

  it('reports failed subagents inside the XML result without failing the tool', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          agentId: 'agent-coder-1',
          status: 'completed',
          result: 'imports are stable',
        },
        {
          task: tasks[1],
          agentId: 'agent-coder-2',
          status: 'failed',
          error: 'Agent timed out after 30s.',
        },
      ]),
    });
    const { tool } = agentSwarmToolRig(host);

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, failed: 1</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" outcome="failed">Agent timed out after 30s.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });

  it('passes the configured subagent timeout to swarm tasks', async () => {
    const host = mockSwarmHost();
    const { tool } = agentSwarmToolRig(host, { timeoutMs: 5_000 });

    await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(host.swarmService.run).toHaveBeenCalledWith(
      expect.objectContaining({
        tasks: [
          expect.objectContaining({ timeout: 5_000 }),
          expect.objectContaining({ timeout: 5_000 }),
        ],
      }),
    );
  });

  it('omits resume hint when incomplete subagents have no agent ids', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          status: 'failed',
          error: 'Agent did not start.',
        },
        {
          task: tasks[1],
          status: 'failed',
          error: 'Agent also did not start.',
        },
      ]),
    });
    const { tool } = agentSwarmToolRig(host);

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>failed: 2</summary>',
        '<subagent item="src/a.ts" outcome="failed">Agent did not start.</subagent>',
        '<subagent item="src/b.ts" outcome="failed">Agent also did not start.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
  });

  it('reports partial aborted subagents inside the XML result', async () => {
    const host = mockSwarmHost({
      run: vi.fn().mockImplementation(async ({ tasks }) => [
        {
          task: tasks[0],
          agentId: 'agent-coder-1',
          status: 'completed',
          result: 'imports are stable',
        },
        {
          task: tasks[1],
          agentId: 'agent-coder-2',
          status: 'aborted',
          state: 'started',
          error: 'The user manually interrupted this subagent batch before this subagent finished.',
        },
        {
          task: tasks[2],
          status: 'aborted',
          state: 'not_started',
          error:
            'The user manually interrupted this subagent batch before this subagent was started.',
        },
      ]),
    });
    const { tool } = agentSwarmToolRig(host);

    const result = await executeTool(
      tool,
      context({
        description: 'Review files',
        prompt_template: 'Review {{item}}',
        items: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
      }),
    );

    expect(result.output).toBe(
      [
        '<agent_swarm_result>',
        '<summary>completed: 1, aborted: 2</summary>',
        '<resume_hint>Call AgentSwarm with resume_agent_ids using the agent_id values in this result to continue unfinished work.</resume_hint>',
        '<subagent agent_id="agent-coder-1" item="src/a.ts" outcome="completed">imports are stable</subagent>',
        '<subagent agent_id="agent-coder-2" item="src/b.ts" state="started" outcome="aborted">The user manually interrupted this subagent batch before this subagent finished.</subagent>',
        '<subagent item="src/c.ts" state="not_started" outcome="aborted">The user manually interrupted this subagent batch before this subagent was started.</subagent>',
        '</agent_swarm_result>',
      ].join('\n'),
    );
    expect(result.isError).toBeUndefined();
  });
});
