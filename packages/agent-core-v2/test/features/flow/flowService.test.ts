import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import {
  ContextAppendMessage,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { SkillActivated } from '#/features/skill/skillOps';
import { ContextUndone } from '#/agent/undo/undoService';
import { IAgentScopeContext, makeAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISkillActivationDataService } from '#/features/skill/skillActivationData';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import type { ContextMessage } from '#/agent/contextMemory/types';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IConfigService, type ConfigChangedEvent } from '#/app/config/config';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus, type ISessionEventBus } from '#/app/event/eventBus';
import { IHostFileSystem } from '#/os/interface/hostFileSystem';
import { EventBusService } from '#/app/event/eventBusService';
import { IFlagService } from '#/app/flag/flag';
import { FLOW_FLAG_ID, IAgentFlowService, type FlowDefinition } from '#/features/flow/flow';
import { AgentFlowService } from '#/features/flow/flowService';
import { FlowVerdict, flowGatesKey, flowKey } from '#/features/flow/flowOps';
import type { ToolCall } from '#/kosong/contract/message';
import { AppendLogStore } from '#/persistence/backends/node-fs/appendLogStore';
import { InMemoryStorageService } from '#/persistence/backends/memory/inMemoryStorageService';
import { IAppendLogStore } from '#/persistence/interface/appendLogStore';
import { IFileSystemStorageService } from '#/persistence/interface/storage';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { stubToolExecutorEvents, type ToolExecutorEventStubs } from '../../agent/toolExecutor/stubs';
import { stubFlag } from '../../app/flag/stubs';
import {
  registerTestAgentWire,
  registerTestEventDispatcher,
  testWireScope,
} from '../../wire/stubs';

const signal = new AbortController().signal;

const DEFINITION: FlowDefinition = {
  id: 'issue-fix',
  stages: [
    { id: 'triage', objective: 'find root cause', completion: 'cause located', gate: 'human' },
    { id: 'implement', objective: 'fix it', completion: 'tests pass', gate: 'ai' },
  ],
};

const CRITERIA = [{ criterion: 'cause located', met: true, evidence: 'src/x.ts:12' }];

const DEFINITION_TEXT = `---
id: issue-fix
stages:
  - id: triage
    objective: find root cause
    completion: cause located
    gate: human
  - id: implement
    objective: fix it
    completion: tests pass
---
`;


describe('AgentFlowService', () => {
  let disposables: DisposableStore;
  let ix: TestInstantiationService;
  let executorEvents: ToolExecutorEventStubs;
  let flowFlagOn: boolean;
  let permissionMode: string;
  let requestToolApproval: Mock;
  let service: IAgentFlowService;
  let agentState: IAgentStateService;
  let dispatcher: IEventDispatcher;
  let agentId: string;
  let activationDataStore: Map<string, unknown>;
  let contextMessages: ContextMessage[];
  let configHandlers: ((e: ConfigChangedEvent) => void)[];
  let abortQueuedFlowPrompts: Mock;
  let flowToolSource: 'builtin' | 'user';
  let runtimeText: string | undefined;
  let hostFsText: string | undefined;
  let todoToolSource: 'builtin' | 'user';
  let scopeFor: (id: string) => ReturnType<typeof makeAgentScopeContext>;

  beforeEach(() => {
    disposables = new DisposableStore();
    ix = disposables.add(new TestInstantiationService());
    ix.stub(IFileSystemStorageService, new InMemoryStorageService());
    ix.set(IAppendLogStore, new SyncDescriptor(AppendLogStore));
    ix.set(IEventBus, new SyncDescriptor(EventBusService));
    executorEvents = stubToolExecutorEvents();
    ix.stub(IAgentToolExecutorService, executorEvents.executor);
    requestToolApproval = vi.fn(async () => undefined);
    ix.stub(IAgentToolApprovalService, {
      requestToolApproval,
      formatDenyMessage: (message: string) => message,
    } as unknown as IAgentToolApprovalService);
    ix.stub(ISessionWorkspaceContext, {
      workDir: '/ws',
      additionalDirs: [],
    } as unknown as ISessionWorkspaceContext);
    ix.stub(IBootstrapService, {
      homeDir: '/home/.kimi-code',
    } as unknown as IBootstrapService);
    runtimeText = DEFINITION_TEXT;
    hostFsText = undefined;
    ix.stub(IAgentRuntimeService, {
      acquire: () => ({
        runtime: {
          identity: { generation: 'g1' },
          fs: {
            readText: async (path: string) => {
              if (runtimeText !== undefined && path.endsWith('/issue-fix.md')) return runtimeText;
              throw new Error('not found');
            },
          },
        },
        dispose: () => {},
      }),
    } as unknown as IAgentRuntimeService);
    ix.stub(IHostFileSystem, {
      readText: async (path: string) => {
        if (hostFsText !== undefined && path.endsWith('/issue-fix.md')) return hostFsText;
        throw new Error('not found');
      },
    } as unknown as IHostFileSystem);
    ix.stub(IAgentToolRegistryService, {
      listReferences: () => [
        ...['FlowStart', 'FlowAdvance', 'FlowAbort', 'FlowJump'].map((name) => ({
          name,
          source: flowToolSource,
        })),
        { name: 'TodoList', source: todoToolSource },
      ],
    } as unknown as IAgentToolRegistryService);
    flowToolSource = 'builtin';
    todoToolSource = 'builtin';
    activationDataStore = new Map();
    contextMessages = [];
    configHandlers = [];
    ix.stub(ISkillActivationDataService, {
      put: (id: string, data: unknown) => activationDataStore.set(id, data),
      take: (id: string) => {
        const data = activationDataStore.get(id);
        activationDataStore.delete(id);
        return data;
      },
    } as unknown as ISkillActivationDataService);
    ix.stub(IAgentContextMemoryService, {
      get: () => contextMessages,
    } as unknown as IAgentContextMemoryService);
    ix.stub(IConfigService, {
      get: () => undefined,
      onDidChangeConfiguration: (handler: (e: ConfigChangedEvent) => void) => {
        configHandlers.push(handler);
        return { dispose: () => {} };
      },
    } as unknown as IConfigService);

    flowFlagOn = true;
    ix.stub(IFlagService, stubFlag((id) => flowFlagOn && id === FLOW_FLAG_ID));
    permissionMode = 'default';
    ix.stub(IAgentPermissionModeService, {
      get mode() {
        return permissionMode;
      },
      setMode: () => {},
      setModeAndBroadcast: () => {},
      onDidChangeMode: Event.None,
    } as unknown as IAgentPermissionModeService);
    abortQueuedFlowPrompts = vi.fn();
    ix.stub(IAgentLifecycleService, {
      resolve: () => ({ abortQueuedFlowPrompts }),
    } as unknown as IAgentLifecycleService);
    registerTestAgentWire(ix, testWireScope('wire', 'flow-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    agentId = 'main';
    const scopes = new Map<string, ReturnType<typeof makeAgentScopeContext>>();
    scopeFor = (id: string) => {
      let scope = scopes.get(id);
      if (scope === undefined) {
        scope = makeAgentScopeContext({ agentId: id, agentScope: '' });
        scopes.set(id, scope);
        (ix.get(IEventBus) as ISessionEventBus).activateAgent(scope.agentContext);
      }
      return scope;
    };
    ix.stub(
      IAgentScopeContext,
      new Proxy({} as IAgentScopeContext, {
        get: (_target, prop) => (scopeFor(agentId) as unknown as Record<string | symbol, unknown>)[prop],
      }),
    );
    dispatcher = registerTestEventDispatcher(ix);
    agentState = ix.get(IAgentStateService);
    ix.set(IAgentFlowService, new SyncDescriptor(AgentFlowService));
    service = ix.get(IAgentFlowService);
  });
  afterEach(() => disposables.dispose());

  it('refuses to start while a run is already active', () => {
    expect(service.start(DEFINITION, 'first')).toBe(true);
    expect(service.start({ ...DEFINITION, id: 'other-flow' }, 'second')).toBe(false);
    expect(service.run().flowId).toBe('issue-fix');
    expect(service.run().task).toBe('first');
  });

  it('start snapshots the definition and positions the run at the first stage', () => {
    expect(service.run().active).toBe(false);
    service.start(DEFINITION, 'fix #123');
    const run = service.run();
    expect(run.active).toBe(true);
    expect(run.flowId).toBe('issue-fix');
    expect(run.task).toBe('fix #123');
    expect(run.stages?.map((stage) => stage.id)).toEqual(['triage', 'implement']);
    expect(service.currentStage()?.id).toBe('triage');
    expect(service.gates().records).toHaveLength(0);
  });

  it('a pass verdict advances the stage pointer and appends a gate record', () => {
    service.start(DEFINITION, 'task');
    const outcome = service.advance({
      stage: 'triage',
      result: 'pass',
      decidedBy: 'human',
      criteria: CRITERIA,
    });
    expect(outcome).toEqual(
      expect.objectContaining({ recorded: true, runFinished: false }),
    );
    expect(outcome.nextStage?.id).toBe('implement');
    expect(service.currentStage()?.id).toBe('implement');
    expect(service.gates().records).toEqual([
      expect.objectContaining({ stage: 'triage', result: 'pass', decidedBy: 'human' }),
    ]);
  });

  it('a reject verdict keeps the pointer and records the rejection', () => {
    service.start(DEFINITION, 'task');
    const outcome = service.advance({
      stage: 'triage',
      result: 'reject',
      decidedBy: 'ai',
      criteria: [{ criterion: 'cause located', met: false, evidence: 'not found yet' }],
      feedback: 'root cause still unknown',
    });
    expect(outcome.recorded).toBe(true);
    expect(service.currentStage()?.id).toBe('triage');
    expect(service.gates().records).toEqual([
      expect.objectContaining({ stage: 'triage', result: 'reject', feedback: 'root cause still unknown' }),
    ]);
  });

  it('passing the last stage finishes the run', () => {
    service.start(DEFINITION, 'task');
    service.advance({ stage: 'triage', result: 'pass', decidedBy: 'human', criteria: CRITERIA });
    const outcome = service.advance({
      stage: 'implement',
      result: 'pass',
      decidedBy: 'ai',
      criteria: CRITERIA,
    });
    expect(outcome.runFinished).toBe(true);
    expect(service.run().active).toBe(false);
    expect(service.gates().records).toHaveLength(2);
  });

  it('rejects a verdict for a stage that is not current', () => {
    service.start(DEFINITION, 'task');
    const outcome = service.advance({
      stage: 'implement',
      result: 'pass',
      decidedBy: 'ai',
      criteria: CRITERIA,
    });
    expect(outcome.recorded).toBe(false);
    expect(service.currentStage()?.id).toBe('triage');
    expect(service.gates().records).toHaveLength(0);
  });

  it('start and advance are no-ops while the flow flag is off', () => {
    flowFlagOn = false;
    service.start(DEFINITION, 'task');
    expect(service.run().active).toBe(false);
    const outcome = service.advance({
      stage: 'triage',
      result: 'pass',
      decidedBy: 'ai',
      criteria: CRITERIA,
    });
    expect(outcome.recorded).toBe(false);
  });

  it('abort deactivates the run', () => {
    service.start(DEFINITION, 'task');
    service.abort('user stopped');
    expect(service.run().active).toBe(false);
  });

  it('emits flowRun status updates as the run starts, advances, and ends', () => {
    const seen: unknown[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          seen.push((e as AgentStatusUpdated).flowRun);
        }
      }),
    );

    service.start(DEFINITION, 'fix #123');
    service.advance({
      stage: 'triage',
      result: 'reject',
      decidedBy: 'ai',
      criteria: [{ criterion: 'cause located', met: false, evidence: 'not yet' }],
    });
    service.advance({ stage: 'triage', result: 'pass', decidedBy: 'human', criteria: CRITERIA });
    service.abort('stop');

    expect(seen).toEqual([
      { flowId: 'issue-fix', stageId: 'triage', stageIndex: 0, stageTotal: 2, gate: 'human' },
      { flowId: 'issue-fix', stageId: 'triage', stageIndex: 0, stageTotal: 2, gate: 'human' },
      { flowId: 'issue-fix', stageId: 'implement', stageIndex: 1, stageTotal: 2, gate: 'ai' },
      null,
    ]);
  });

  it('replays to an inactive run when only the final verdict record survived', () => {
    service.start(DEFINITION, 'task');
    service.advance({ stage: 'triage', result: 'pass', decidedBy: 'human', criteria: CRITERIA });
    void dispatcher.dispatch(
      new FlowVerdict({ stage: 'implement', result: 'pass', decidedBy: 'ai', criteria: CRITERIA }),
    );
    expect(service.run().active).toBe(false);
    expect(service.currentStage()).toBeUndefined();
    expect(service.run().endedReason).toBe('finished');
  });

  it('republishes the flow summary after a conversation undo', () => {
    const seen: unknown[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          seen.push((e as AgentStatusUpdated).flowRun);
        }
      }),
    );
    ix.get(IEventBus).publish(new ContextUndone({ agentId: 'main', turns: 1 }), scopeFor('main').agentContext);
    expect(seen).toEqual([null]);

    service.start(DEFINITION, 'fix #123');
    seen.length = 0;
    ix.get(IEventBus).publish(new ContextUndone({ agentId: 'main', turns: 1 }), scopeFor('main').agentContext);
    expect(seen).toEqual([
      { flowId: 'issue-fix', stageId: 'triage', stageIndex: 0, stageTotal: 2, gate: 'human' },
    ]);
  });

  it('does not publish a flow status for a worker-agent undo', () => {
    agentId = 'worker-1';
    const seen: unknown[] = [];
    disposables.add(
      ix.get(IEventBus).subscribe((e) => {
        if (e.type === 'agent.status.updated') {
          seen.push((e as AgentStatusUpdated).flowRun);
        }
      }),
    );
    ix.get(IEventBus).publish(
      new ContextUndone({ agentId: 'worker-1', turns: 1 }),
      scopeFor('worker-1').agentContext,
    );
    expect(seen).toEqual([]);
  });

  it('jump moves the pointer, records the audit entry, and bumps the epoch', () => {
    service.start(DEFINITION, 'task');
    const epochBefore = service.runEpoch();
    expect(service.jumpPolicy()).toBe('approval');
    const outcome = service.jump({ to: 'implement', reason: 'triage already known', decidedBy: 'human' });
    expect(outcome.recorded).toBe(true);
    expect(outcome.stage?.id).toBe('implement');
    expect(service.currentStage()?.id).toBe('implement');
    expect(service.runEpoch()).toBe(epochBefore + 1);
    const records = service.gates().records;
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      kind: 'jump',
      fromStage: 'triage',
      toStage: 'implement',
      reason: 'triage already known',
      decidedBy: 'human',
    });

    const back = service.jump({ to: 'triage', reason: 'implement invalidated triage', decidedBy: 'human' });
    expect(back.recorded).toBe(true);
    expect(service.currentStage()?.id).toBe('triage');
    expect(service.gates().records).toHaveLength(2);
  });

  it('jump rejects the current stage, unknown stages, and inactive runs', () => {
    expect(service.jump({ to: 'triage', reason: 'x', decidedBy: 'ai' }).recorded).toBe(false);
    service.start(DEFINITION, 'task');
    expect(service.jump({ to: 'triage', reason: 'x', decidedBy: 'ai' }).recorded).toBe(false);
    expect(service.jump({ to: 'missing', reason: 'x', decidedBy: 'ai' }).recorded).toBe(false);
    expect(service.gates().records).toHaveLength(0);
  });

  it('snapshots the definition jump policy at start', () => {
    service.start({ ...DEFINITION, jumps: 'free' }, 'task');
    expect(service.jumpPolicy()).toBe('free');
    expect(service.run().jumpPolicy).toBe('free');
  });

  it('starts a new audit segment when a restored run records a verdict over retained records', async () => {
    service.start(DEFINITION, 'task B');
    service.advance({ stage: 'triage', result: 'pass', decidedBy: 'human', criteria: CRITERIA });
    expect(agentState.get(flowGatesKey).flowId).toBe('issue-fix');
    expect(agentState.get(flowGatesKey).records).toHaveLength(1);

    await dispatcher.dispatch(
      new FlowVerdict({
        stage: 'triage',
        result: 'reject',
        decidedBy: 'human',
        criteria: [{ criterion: 'cause located', met: false, evidence: 'regressed' }],
        flowId: 'restored-flow',
        task: 'task A',
        runId: 'run-a',
      }),
    );
    const gates = agentState.get(flowGatesKey);
    expect(gates.flowId).toBe('restored-flow');
    expect(gates.task).toBe('task A');
    expect(gates.records).toHaveLength(1);
    expect(gates.records[0]).toMatchObject({ stage: 'triage', result: 'reject' });
  });

  it('segments repeated runs with the same flow id and task by their unique run id', async () => {
    service.start(DEFINITION, 'same task');
    const firstRunId = agentState.get(flowGatesKey).runId;
    expect(firstRunId).toBeDefined();
    service.advance({ stage: 'triage', result: 'pass', decidedBy: 'human', criteria: CRITERIA });
    expect(agentState.get(flowGatesKey).records).toHaveLength(1);

    await dispatcher.dispatch(
      new FlowVerdict({
        stage: 'triage',
        result: 'reject',
        decidedBy: 'human',
        criteria: [{ criterion: 'cause located', met: false, evidence: 'regressed' }],
        flowId: 'issue-fix',
        task: 'same task',
        runId: 'restored-run-id',
      }),
    );
    const gates = agentState.get(flowGatesKey);
    expect(gates.runId).toBe('restored-run-id');
    expect(gates.records).toHaveLength(1);
    expect(gates.records[0]).toMatchObject({ result: 'reject' });
  });

  it('conversation undo rolls back the stage pointer but keeps the gate audit trail', async () => {
    await dispatcher.dispatch(
      new ContextAppendMessage({
        agentId: 'main',
        message: {
          role: 'user',
          content: [{ type: 'text', text: 'anchor' }],
          toolCalls: [],
          origin: { kind: 'user' },
        },
      }),
    );
    service.start(DEFINITION, 'task');
    service.advance({ stage: 'triage', result: 'pass', decidedBy: 'human', criteria: CRITERIA });
    expect(service.currentStage()?.id).toBe('implement');
    expect(service.gates().records).toHaveLength(1);

    await dispatcher.dispatch(new ContextUndo({ agentId: 'main', count: 1 }));

    expect(agentState.get(flowKey)).toEqual({ active: false });
    expect(agentState.get(flowGatesKey).records).toHaveLength(1);
  });

  describe('flow skill activation auto-start', () => {
    interface ActivateOptions {
      activationId?: string;
      skillName?: string;
      task?: string;
      skillPath?: string;
      data?: unknown;
      appendPrompt?: boolean;
      reconcile?: boolean;
    }

    async function activateFlowSkill(options: ActivateOptions = {}): Promise<void> {
      const activationId = options.activationId ?? 'act-1';
      const skillName = options.skillName ?? 'issue-fix';
      const task = options.task ?? 'fix the paste bug';
      const skillPath = options.skillPath ?? `/ws/.kimi-code/flows/${skillName}.md`;
      if (!('data' in options)) {
        activationDataStore.set(activationId, { ...DEFINITION, id: skillName });
      } else if (options.data !== undefined) {
        activationDataStore.set(activationId, options.data);
      }
      const origin = {
        kind: 'skill_activation',
        activationId,
        skillName: `flow:${skillName}`,
        trigger: 'user-slash',
        skillType: 'flow',
        skillPath,
        skillArgs: task,
      } as const;
      await dispatcher.dispatch(
        new SkillActivated({
          agentId,
          activationId,
          skillName: `flow:${skillName}`,
          trigger: 'user-slash',
          skillType: 'flow',
          skillPath,
          skillArgs: task,
        }),
      );
      if (options.appendPrompt !== false) {
        contextMessages.push({
          role: 'user',
          content: [{ type: 'text', text: 'activation prompt' }],
          toolCalls: [],
          origin,
        } as unknown as ContextMessage);
      }
      if (options.reconcile !== false) service.reconcilePendingActivation();
    }

    it('reports a pending activation until it is consumed', async () => {
      expect(service.hasPendingActivation()).toBe(false);
      await activateFlowSkill({ appendPrompt: false, reconcile: false });
      expect(service.hasPendingActivation()).toBe(true);
      contextMessages.push({
        role: 'user',
        content: [{ type: 'text', text: 'activation prompt' }],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'act-1',
          skillName: 'flow:issue-fix',
          trigger: 'user-slash',
          skillType: 'flow',
          skillPath: '/ws/.kimi-code/flows/issue-fix.md',
          skillArgs: 'fix the paste bug',
        },
      } as unknown as ContextMessage);
      service.reconcilePendingActivation();
      expect(service.hasPendingActivation()).toBe(false);
      expect(service.run().active).toBe(true);
    });

    it('starts the run once the activation prompt is in context and a step reconciles', async () => {
      await activateFlowSkill();
      const run = service.run();
      expect(run.flowId).toBe('issue-fix');
      expect(run.task).toBe('fix the paste bug');
      expect(service.currentStage()?.id).toBe('triage');
    });

    it('does not start before the activation prompt lands in context', async () => {
      await activateFlowSkill({ appendPrompt: false });
      expect(service.run().active).toBe(false);
      contextMessages.push({
        role: 'user',
        content: [{ type: 'text', text: 'activation prompt' }],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'act-1',
          skillName: 'flow:issue-fix',
          trigger: 'user-slash',
          skillType: 'flow',
          skillPath: '/ws/.kimi-code/flows/issue-fix.md',
          skillArgs: 'fix the paste bug',
        },
      } as unknown as ContextMessage);
      service.reconcilePendingActivation();
      expect(service.run().active).toBe(true);
    });

    it('does not start when a different prompt is the latest in context', async () => {
      await activateFlowSkill({ appendPrompt: false });
      contextMessages.push({
        role: 'user',
        content: [{ type: 'text', text: 'unrelated prompt' }],
        toolCalls: [],
        origin: { kind: 'user' },
      } as unknown as ContextMessage);
      service.reconcilePendingActivation();
      expect(service.run().active).toBe(false);
    });

    it('starts a bundled activation from the user prompt entry', async () => {
      await activateFlowSkill({ appendPrompt: false, reconcile: false });
      contextMessages.push({
        role: 'user',
        content: [{ type: 'text', text: 'bundled prompt' }],
        toolCalls: [],
        origin: {
          kind: 'user',
          skillActivations: [{ activationId: 'act-1', skillName: 'issue-fix' }],
        },
      } as unknown as ContextMessage);
      service.reconcilePendingActivation();
      expect(service.run().active).toBe(true);
    });

    it('derives the task from the bundled prompt text for an argument-less inline activation', async () => {
      await activateFlowSkill({ task: '', appendPrompt: false, reconcile: false });
      contextMessages.push({
        role: 'user',
        content: [
          { type: 'text', text: 'bundled skill block' },
          { type: 'text', text: 'Fix the paste bug in the editor' },
        ],
        toolCalls: [],
        origin: {
          kind: 'user',
          skillActivations: [{ activationId: 'act-1', skillName: 'issue-fix' }],
        },
      } as unknown as ContextMessage);
      service.reconcilePendingActivation();
      expect(service.run().active).toBe(true);
      expect(service.run().task).toBe('Fix the paste bug in the editor');
    });

    it('does not start an argument-less single activation with no prompt text to derive from', async () => {
      await activateFlowSkill({ task: '' });
      expect(service.run().active).toBe(false);
    });

    it('starts only the first flow of a steered multi-activation prompt and clears the rest', async () => {
      await activateFlowSkill({ activationId: 'act-s1', appendPrompt: false, reconcile: false });
      await activateFlowSkill({
        activationId: 'act-s2',
        skillName: 'other-flow',
        appendPrompt: false,
        reconcile: false,
      });
      contextMessages.push({
        role: 'user',
        content: [{ type: 'text', text: 'merged steer prompt' }],
        toolCalls: [],
        origin: {
          kind: 'user',
          skillActivations: [
            { activationId: 'act-s1', skillName: 'flow:issue-fix' },
            { activationId: 'act-s2', skillName: 'flow:other-flow' },
          ],
        },
      } as unknown as ContextMessage);
      service.reconcilePendingActivation();
      expect(service.run().flowId).toBe('issue-fix');

      service.abort('stop');
      service.reconcilePendingActivation();
      expect(service.run().active).toBe(false);
    });

    it('preserves each queued flow activation until its own prompt lands', async () => {
      await activateFlowSkill({ activationId: 'act-q1', appendPrompt: false, reconcile: false });
      await activateFlowSkill({
        activationId: 'act-q2',
        skillName: 'flow:other-flow',
        appendPrompt: false,
        reconcile: false,
      });
      contextMessages.push({
        role: 'user',
        content: [{ type: 'text', text: 'first activation prompt' }],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'act-q1',
          skillName: 'flow:issue-fix',
          trigger: 'user-slash',
          skillType: 'flow',
          skillPath: '/ws/.kimi-code/flows/issue-fix.md',
          skillArgs: 'fix the paste bug',
        },
      } as unknown as ContextMessage);
      service.reconcilePendingActivation();
      expect(service.run().flowId).toBe('issue-fix');

      contextMessages.push({
        role: 'user',
        content: [{ type: 'text', text: 'second activation prompt' }],
        toolCalls: [],
        origin: {
          kind: 'skill_activation',
          activationId: 'act-q2',
          skillName: 'flow:other-flow',
          trigger: 'user-slash',
          skillType: 'flow',
          skillPath: '/ws/.kimi-code/flows/other-flow.md',
          skillArgs: 'task',
        },
      } as unknown as ContextMessage);
      service.reconcilePendingActivation();
      expect(service.run().flowId).toBe('issue-fix');
      service.reconcilePendingActivation();
      expect(service.run().flowId).toBe('issue-fix');
    });

    it('serves only the latest pending activation', async () => {
      await activateFlowSkill({ activationId: 'act-a' });
      expect(service.run().flowId).toBe('issue-fix');
      await activateFlowSkill({ activationId: 'act-b', skillName: 'other-flow' });
      expect(service.run().flowId).toBe('issue-fix');
    });

    it('ignores a flow activation on a non-main agent', async () => {
      agentId = 'agent-1';
      await activateFlowSkill({ activationId: 'act-worker', task: 'worker task' });
      expect(service.run().active).toBe(false);
    });

    it('does not auto-start an activation whose task is empty', async () => {
      await activateFlowSkill({ activationId: 'act-empty', task: '   ' });
      expect(service.run().active).toBe(false);
    });

    it('accepts an activation path that normalizes to the projected definition', async () => {
      await activateFlowSkill({
        activationId: 'act-lexical',
        skillPath: '/ws/./.kimi-code//flows/issue-fix.md',
      });
      expect(service.run().active).toBe(true);
      expect(service.run().flowId).toBe('issue-fix');
    });

    it('accepts an activation at the user-level flows definition path', async () => {
      await activateFlowSkill({
        activationId: 'act-user',
        skillPath: '/home/.kimi-code/flows/issue-fix.md',
      });
      expect(service.run().active).toBe(true);
      expect(service.run().flowId).toBe('issue-fix');
    });

    it('ignores a flow-typed activation whose path is not the projected flows definition', async () => {
      await activateFlowSkill({
        activationId: 'act-foreign',
        skillPath: '/ws/.kimi-code/skills/issue-fix/SKILL.md',
      });
      expect(service.run().active).toBe(false);
    });

    it('ignores an activation whose carried definition does not match the flow id', async () => {
      await activateFlowSkill({
        activationId: 'act-mismatch',
        data: { ...DEFINITION, id: 'other-flow' },
      });
      expect(service.run().active).toBe(false);
    });

    it('ignores an activation that carries no definition', async () => {
      await activateFlowSkill({ activationId: 'act-bare', data: undefined });
      expect(service.run().active).toBe(false);
    });

    it('starts from the activation-carried definition rather than any on-disk state', async () => {
      await activateFlowSkill({
        activationId: 'act-pinned',
        data: {
          id: 'issue-fix',
          stages: [{ id: 'solo', objective: 'do it', completion: 'done', gate: 'ai' }],
        },
      });
      expect(service.run().active).toBe(true);
      expect(service.currentStage()?.id).toBe('solo');
    });

    it('does not restart an already-active run', async () => {
      service.start(DEFINITION, 'original task');
      await activateFlowSkill({ activationId: 'act-2', task: 'another task' });
      expect(service.run().task).toBe('original task');
    });

    it('publishes a null flow status when the live flag turns off, and the summary when it returns', async () => {
      service.start(DEFINITION, 'task');
      const seen: unknown[] = [];
      const bus = ix.get(IEventBus);
      const sub = bus.subscribe(AgentStatusUpdated, (event) => {
        if (event.flowRun !== undefined) seen.push(event.flowRun);
      });
      flowFlagOn = false;
      for (const handler of configHandlers) handler({} as ConfigChangedEvent);
      expect(seen.at(-1)).toBeNull();
      flowFlagOn = true;
      for (const handler of configHandlers) handler({} as ConfigChangedEvent);
      expect(seen.at(-1)).toMatchObject({ flowId: 'issue-fix', stageId: 'triage' });
      sub.dispose();
    });

    it('clears pending activations and aborts queued flow prompts when the live flag turns off', async () => {
      await activateFlowSkill({ appendPrompt: false, reconcile: false });
      expect(service.hasPendingActivation()).toBe(true);
      flowFlagOn = false;
      for (const handler of configHandlers) handler({} as ConfigChangedEvent);
      expect(service.hasPendingActivation()).toBe(false);
      expect(abortQueuedFlowPrompts).toHaveBeenCalledTimes(1);
      flowFlagOn = true;
      for (const handler of configHandlers) handler({} as ConfigChangedEvent);
      expect(abortQueuedFlowPrompts).toHaveBeenCalledTimes(1);
    });


    it('vetoes TodoList batched with a FlowStart even before the run is active', async () => {
      const todoCall: ToolCall = {
        type: 'function',
        id: 'call_todo_batched',
        name: 'TodoList',
        arguments: '{}',
      };
      const startCall: ToolCall = {
        type: 'function',
        id: 'call_start',
        name: 'FlowStart',
        arguments: '{}',
      };
      const context: ResolvedToolExecutionHookContext = {
        turnId: 0,
        signal,
        toolCall: todoCall,
        toolCalls: [startCall, todoCall],
        args: {},
        execution: { approvalRule: 'TodoList', execute: async () => ({ output: '' }) },
      };
      const decision = await executorEvents.fireBeforeExecute(context);
      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('flow run');
    });

    it('vetoes TodoList while a run is active, and only then', async () => {
      const todoCall: ToolCall = {
        type: 'function',
        id: 'call_todo',
        name: 'TodoList',
        arguments: '{}',
      };
      const context: ResolvedToolExecutionHookContext = {
        turnId: 0,
        signal,
        toolCall: todoCall,
        toolCalls: [todoCall],
        args: {},
        execution: { approvalRule: 'TodoList', execute: async () => ({ output: '' }) },
      };
      expect(await executorEvents.fireBeforeExecute(context)).toBeUndefined();
      service.start(DEFINITION, 'task');
      const decision = await executorEvents.fireBeforeExecute(context);
      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('flow run');
    });

    it('leaves a shadowing TodoList registration alone during a run', async () => {
      todoToolSource = 'user';
      service.start(DEFINITION, 'task');
      const todoCall: ToolCall = {
        type: 'function',
        id: 'call_todo_shadow',
        name: 'TodoList',
        arguments: '{}',
      };
      const context: ResolvedToolExecutionHookContext = {
        turnId: 0,
        signal,
        toolCall: todoCall,
        toolCalls: [todoCall],
        args: {},
        execution: { approvalRule: 'TodoList', execute: async () => ({ output: '' }) },
      };
      expect(await executorEvents.fireBeforeExecute(context)).toBeUndefined();
    });

    it('ignores a shadowing FlowStart when judging a batched TodoList', async () => {
      flowToolSource = 'user';
      const todoCall: ToolCall = {
        type: 'function',
        id: 'call_todo_batch',
        name: 'TodoList',
        arguments: '{}',
      };
      const context: ResolvedToolExecutionHookContext = {
        turnId: 0,
        signal,
        toolCall: todoCall,
        toolCalls: [
          todoCall,
          { type: 'function', id: 'call_start_shadow', name: 'FlowStart', arguments: '{}' },
        ],
        args: {},
        execution: { approvalRule: 'TodoList', execute: async () => ({ output: '' }) },
      };
      expect(await executorEvents.fireBeforeExecute(context)).toBeUndefined();
    });
  });

  describe('FlowStart start review', () => {
    function startContext(args: unknown): ResolvedToolExecutionHookContext {
      const call: ToolCall = {
        type: 'function',
        id: 'call_start',
        name: 'FlowStart',
        arguments: '{}',
      };
      return {
        turnId: 0,
        signal,
        toolCall: call,
        toolCalls: [call],
        args,
        execution: {
          approvalRule: 'FlowStart',
          execute: async () => ({ output: '' }),
        },
      } as ResolvedToolExecutionHookContext;
    }

    it('raises a flow_start_review approval with the parsed blueprint', async () => {
      await executorEvents.fireBeforeExecute(
        startContext({ flow: 'issue-fix', task: 'fix the paste bug' }),
      );
      expect(requestToolApproval).toHaveBeenCalledTimes(1);
      const reviewContext = requestToolApproval.mock.calls[0]![0] as ResolvedToolExecutionHookContext;
      const display = reviewContext.execution.display;
      expect(display?.kind).toBe('flow_start_review');
      if (display?.kind === 'flow_start_review') {
        expect(display.flow_id).toBe('issue-fix');
        expect(display.task).toBe('fix the paste bug');
        expect(display.stages.map((stage) => stage.id)).toEqual(['triage', 'implement']);
        expect(display.source_path).toContain('.kimi-code/flows/issue-fix.md');
      }
    });

    it('skips the start review in auto mode, with an active run, and for an unknown flow', async () => {
      permissionMode = 'auto';
      await executorEvents.fireBeforeExecute(
        startContext({ flow: 'issue-fix', task: 'task' }),
      );
      expect(requestToolApproval).not.toHaveBeenCalled();

      permissionMode = 'default';
      service.start(DEFINITION, 'task');
      await executorEvents.fireBeforeExecute(
        startContext({ flow: 'issue-fix', task: 'task' }),
      );
      expect(requestToolApproval).not.toHaveBeenCalled();
    });

    it('falls back to a valid user-level definition when the project file is invalid, and still reviews', async () => {
      hostFsText = DEFINITION_TEXT;
      runtimeText = 'not a valid flow definition';
      await executorEvents.fireBeforeExecute(
        startContext({ flow: 'issue-fix', task: 'task' }),
      );
      expect(requestToolApproval).toHaveBeenCalledTimes(1);
      const reviewContext = requestToolApproval.mock.calls[0]![0] as ResolvedToolExecutionHookContext;
      const display = reviewContext.execution.display;
      expect(display?.kind).toBe('flow_start_review');
      if (display?.kind === 'flow_start_review') {
        expect(display.source_path).toBe('/home/.kimi-code/flows/issue-fix.md');
      }
    });

    it('vetoes a FlowStart batched with any sibling call', async () => {
      const context = startContext({ flow: 'issue-fix', task: 'task' });
      const sibling: ToolCall = {
        type: 'function',
        id: 'call_write',
        name: 'Write',
        arguments: '{}',
      };
      const batched = {
        ...context,
        toolCalls: [context.toolCall, sibling],
      } as ResolvedToolExecutionHookContext;
      const decision = await executorEvents.fireBeforeExecute(batched);
      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('Submit FlowStart alone');
      expect(requestToolApproval).not.toHaveBeenCalled();
    });

    it('snapshots the approved definition for one-shot consumption by the tool', async () => {
      requestToolApproval.mockImplementationOnce(
        async (
          _context: unknown,
          ask: { resolveApproval: (result: { decision: string }) => unknown },
        ) => {
          ask.resolveApproval({ decision: 'approved' });
          return undefined;
        },
      );
      await executorEvents.fireBeforeExecute(
        startContext({ flow: 'issue-fix', task: 'task' }),
      );
      const snapshot = service.consumeStartApproval('call_start');
      expect(snapshot?.id).toBe('issue-fix');
      expect(snapshot?.stages.map((stage) => stage.id)).toEqual(['triage', 'implement']);
      expect(service.consumeStartApproval('call_start')).toBeUndefined();
    });

    it('skips the start review when the definition does not declare the requested id', async () => {
      await executorEvents.fireBeforeExecute(
        startContext({ flow: 'other-flow', task: 'task' }),
      );
      expect(requestToolApproval).not.toHaveBeenCalled();
    });
  });

  describe('FlowAdvance human-gate guard', () => {
    const GATE_DISPLAY: ToolInputDisplay = {
      kind: 'flow_gate_review',
      flow_id: 'issue-fix',
      stage_id: 'triage',
      stage_index: 0,
      stage_total: 2,
      gate: 'human',
      objective: 'find it',
      completion: 'found',
      criteria: [{ criterion: 'found', met: true, evidence: 'yes' }],
    };

    function advanceContext(display?: ToolInputDisplay): ResolvedToolExecutionHookContext {
      const call: ToolCall = {
        type: 'function',
        id: 'call_advance',
        name: 'FlowAdvance',
        arguments: '{}',
      };
      return {
        turnId: 0,
        signal,
        toolCall: call,
        toolCalls: [call],
        args: { stage: 'triage', verdict: 'pass', criteria: CRITERIA },
        execution: {
          approvalRule: 'FlowAdvance',
          display,
          execute: async () => ({ output: '' }),
        },
      };
    }

    it('routes a flow_gate_review pass verdict through tool approval', async () => {
      service.start(DEFINITION, 'task');
      await executorEvents.fireBeforeExecute(
        advanceContext(GATE_DISPLAY),
      );
      expect(requestToolApproval).toHaveBeenCalledTimes(1);
    });

    it('vetoes a human-gated verdict batched with any sibling call', async () => {
      service.start(DEFINITION, 'task');
      const context = advanceContext(GATE_DISPLAY);
      const sibling: ToolCall = {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: '{}',
      };
      const batched = {
        ...context,
        toolCalls: [context.toolCall, sibling],
      } as ResolvedToolExecutionHookContext;
      const decision = await executorEvents.fireBeforeExecute(batched);
      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('Submit FlowAdvance alone');
      expect(requestToolApproval).not.toHaveBeenCalled();
    });

    it('ignores a shadowing registration of a flow tool name', async () => {
      flowToolSource = 'user';
      service.start(DEFINITION, 'task');
      const context = advanceContext(GATE_DISPLAY);
      const sibling: ToolCall = {
        type: 'function',
        id: 'call_other',
        name: 'Bash',
        arguments: '{}',
      };
      const batched = {
        ...context,
        toolCalls: [context.toolCall, sibling],
      } as ResolvedToolExecutionHookContext;
      const decision = await executorEvents.fireBeforeExecute(batched);
      expect(decision?.veto).toBeUndefined();
      expect(requestToolApproval).not.toHaveBeenCalled();
    });

    it('vetoes an AI-gated FlowAdvance batched with a non-flow sibling call', async () => {
      service.start(DEFINITION, 'task');
      const context = advanceContext(undefined);
      const sibling: ToolCall = {
        type: 'function',
        id: 'call_bash',
        name: 'Bash',
        arguments: '{}',
      };
      const batched = {
        ...context,
        toolCalls: [context.toolCall, sibling],
      } as ResolvedToolExecutionHookContext;
      const decision = await executorEvents.fireBeforeExecute(batched);
      expect(decision?.veto?.isError).toBe(true);
      expect(decision?.veto?.output).toContain('Submit FlowAdvance alone');
      expect(requestToolApproval).not.toHaveBeenCalled();
    });

    it('vetoes a flow call preceded by another flow call in the same batch', async () => {
      service.start(DEFINITION, 'task');
      const context = advanceContext(GATE_DISPLAY);
      const abortCall: ToolCall = {
        type: 'function',
        id: 'call_abort_second',
        name: 'FlowAbort',
        arguments: '{}',
      };
      const abortAfterStart = {
        ...advanceContext(undefined),
        toolCall: abortCall,
        toolCalls: [
          { type: 'function', id: 'call_start_first', name: 'FlowStart', arguments: '{}' } as ToolCall,
          abortCall,
        ],
      } as ResolvedToolExecutionHookContext;
      const abortDecision = await executorEvents.fireBeforeExecute(abortAfterStart);
      expect(abortDecision?.veto?.isError).toBe(true);
      for (const earlierName of ['FlowAdvance', 'FlowStart', 'FlowAbort']) {
        const earlier: ToolCall = {
          type: 'function',
          id: `call_${earlierName}_first`,
          name: earlierName,
          arguments: '{}',
        };
        const batched = {
          ...context,
          toolCalls: [earlier, context.toolCall],
        } as ResolvedToolExecutionHookContext;
        const decision = await executorEvents.fireBeforeExecute(batched);
        expect(decision?.veto?.isError).toBe(true);
        expect(decision?.veto?.output).toContain('one response at a time');
      }
      expect(requestToolApproval).not.toHaveBeenCalled();
    });

    it('skips approval when the live stage no longer matches the prepared display', async () => {
      service.start(DEFINITION, 'task');
      service.advance({ stage: 'triage', result: 'pass', decidedBy: 'human', criteria: CRITERIA });
      await executorEvents.fireBeforeExecute(advanceContext(GATE_DISPLAY));
      expect(requestToolApproval).not.toHaveBeenCalled();
    });

    it('skips approval without a flow_gate_review display, in auto mode, and while the flag is off', async () => {
      service.start(DEFINITION, 'task');
      await executorEvents.fireBeforeExecute(advanceContext(undefined));
      expect(requestToolApproval).not.toHaveBeenCalled();

      permissionMode = 'auto';
      await executorEvents.fireBeforeExecute(
        advanceContext(GATE_DISPLAY),
      );
      expect(requestToolApproval).not.toHaveBeenCalled();

      permissionMode = 'default';
      flowFlagOn = false;
      await executorEvents.fireBeforeExecute(
        advanceContext(GATE_DISPLAY),
      );
      expect(requestToolApproval).not.toHaveBeenCalled();
    });
  });

  describe('FlowJump review guard', () => {
    const JUMP_REASON = 'triage already established by the user report';
    const JUMP_DISPLAY: ToolInputDisplay = {
      kind: 'flow_jump_review',
      flow_id: 'issue-fix',
      from_stage_id: 'triage',
      to_stage_id: 'implement',
      from_index: 0,
      to_index: 1,
      stage_total: 2,
      reason: JUMP_REASON,
    };

    function jumpContext(display?: ToolInputDisplay): ResolvedToolExecutionHookContext {
      const call: ToolCall = {
        type: 'function',
        id: 'call_jump',
        name: 'FlowJump',
        arguments: '{}',
      };
      return {
        turnId: 0,
        signal,
        toolCall: call,
        toolCalls: [call],
        args: { to: 'implement', reason: JUMP_REASON },
        execution: {
          approvalRule: 'FlowJump',
          display,
          execute: async () => ({ output: '' }),
        },
      };
    }

    it('routes a displayed jump through tool approval under the approval policy', async () => {
      service.start(DEFINITION, 'task');
      await executorEvents.fireBeforeExecute(jumpContext(JUMP_DISPLAY));
      expect(requestToolApproval).toHaveBeenCalledTimes(1);
    });

    it('skips approval for a displayed jump under the free policy', async () => {
      service.start({ ...DEFINITION, jumps: 'free' }, 'task');
      const decision = await executorEvents.fireBeforeExecute(jumpContext(JUMP_DISPLAY));
      expect(decision?.veto).toBeUndefined();
      expect(requestToolApproval).not.toHaveBeenCalled();
    });

    it('skips approval for a displayed jump when jumps are disabled', async () => {
      service.start({ ...DEFINITION, jumps: 'disabled' }, 'task');
      await executorEvents.fireBeforeExecute(jumpContext(JUMP_DISPLAY));
      expect(requestToolApproval).not.toHaveBeenCalled();
    });
  });
});
