import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { SyncDescriptor } from '#/_base/di/descriptors';
import { DisposableStore } from '#/_base/di/lifecycle';
import { TestInstantiationService } from '#/_base/di/test';
import { Event } from '#/_base/event';
import {
  ContextAppendMessage,
  ContextUndo,
} from '#/agent/contextMemory/contextEvents';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { SkillActivate, skillKey } from '#/agent/skill/skillOps';
import { ContextUndone } from '#/agent/undo/undoService';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
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
    registerTestAgentWire(ix, testWireScope('wire', 'flow-test'), {
      log: ix.get(IAppendLogStore),
      eventBus: ix.get(IEventBus),
    });
    agentId = 'main';
    ix.stub(IAgentScopeContext, {
      get agentId() {
        return agentId;
      },
    } as unknown as IAgentScopeContext);
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
    ix.get(IEventBus).publish(new ContextUndone({ turns: 1 }));
    expect(seen).toEqual([null]);

    service.start(DEFINITION, 'fix #123');
    seen.length = 0;
    ix.get(IEventBus).publish(new ContextUndone({ turns: 1 }));
    expect(seen).toEqual([
      { flowId: 'issue-fix', stageId: 'triage', stageIndex: 0, stageTotal: 2, gate: 'human' },
    ]);
  });

  it('conversation undo rolls back the stage pointer but keeps the gate audit trail', async () => {
    await dispatcher.dispatch(
      new ContextAppendMessage({
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

    await dispatcher.dispatch(new ContextUndo({ count: 1 }));

    expect(agentState.get(flowKey)).toEqual({ active: false });
    expect(agentState.get(flowGatesKey).records).toHaveLength(1);
  });

  describe('flow skill activation auto-start', () => {
    async function activateFlowSkill(): Promise<void> {
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-1',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/.kimi-code/flows/issue-fix.md',
            skillArgs: 'fix the paste bug',
            skillData: DEFINITION,
          },
        }),
      );
      await vi.waitFor(() => expect(service.run().active).toBe(true));
    }

    it('starts the run from a flow-typed skill activation', async () => {
      await activateFlowSkill();
      const run = service.run();
      expect(run.flowId).toBe('issue-fix');
      expect(run.task).toBe('fix the paste bug');
      expect(service.currentStage()?.id).toBe('triage');
    });

    it('starts only the first flow when two activations land together', async () => {
      agentState.contributeState(skillKey);
      const activate = (activationId: string, skillName: string) =>
        dispatcher.dispatch(
          new SkillActivate({
            origin: {
              kind: 'skill_activation',
              activationId,
              skillName,
              trigger: 'user-slash',
              skillType: 'flow',
              skillPath: `/ws/.kimi-code/flows/${skillName}.md`,
              skillArgs: 'task',
              skillData: { ...DEFINITION, id: skillName },
            },
          }),
        );
      await Promise.all([activate('act-a', 'issue-fix'), activate('act-b', 'other-flow')]);
      await vi.waitFor(() => expect(service.run().active).toBe(true));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.run().flowId).toBe('issue-fix');
    });

    it('ignores a flow activation on a non-main agent', async () => {
      agentId = 'agent-1';
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-worker',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/.kimi-code/flows/issue-fix.md',
            skillArgs: 'worker task',
            skillData: DEFINITION,
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.run().active).toBe(false);
    });

    it('does not auto-start an activation whose task is empty', async () => {
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-empty',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/.kimi-code/flows/issue-fix.md',
            skillArgs: '   ',
            skillData: DEFINITION,
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.run().active).toBe(false);
    });

    it('ignores a flow-typed activation whose path is not the projected flows definition', async () => {
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-foreign',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/.kimi-code/skills/issue-fix/SKILL.md',
            skillArgs: 'task',
            skillData: DEFINITION,
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.run().active).toBe(false);
    });

    it('accepts an activation path that normalizes to the projected definition', async () => {
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-lexical',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/./.kimi-code//flows/issue-fix.md',
            skillArgs: 'task',
            skillData: DEFINITION,
          },
        }),
      );
      await vi.waitFor(() => {
        expect(service.run().active).toBe(true);
      });
      expect(service.run().flowId).toBe('issue-fix');
    });

    it('ignores an activation whose carried definition does not match the flow id', async () => {
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-mismatch',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/.kimi-code/flows/issue-fix.md',
            skillArgs: 'task',
            skillData: { ...DEFINITION, id: 'other-flow' },
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.run().active).toBe(false);
    });

    it('ignores an activation that carries no definition', async () => {
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-bare',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/.kimi-code/flows/issue-fix.md',
            skillArgs: 'task',
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.run().active).toBe(false);
    });

    it('starts from the activation-carried definition rather than any on-disk state', async () => {
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-pinned',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/.kimi-code/flows/issue-fix.md',
            skillArgs: 'task',
            skillData: {
              id: 'issue-fix',
              stages: [{ id: 'solo', objective: 'do it', completion: 'done', gate: 'ai' }],
            },
          },
        }),
      );
      await vi.waitFor(() => {
        expect(service.run().active).toBe(true);
      });
      expect(service.currentStage()?.id).toBe('solo');
    });

    it('does not restart an already-active run', async () => {
      service.start(DEFINITION, 'original task');
      agentState.contributeState(skillKey);
      await dispatcher.dispatch(
        new SkillActivate({
          origin: {
            kind: 'skill_activation',
            activationId: 'act-2',
            skillName: 'issue-fix',
            trigger: 'user-slash',
            skillType: 'flow',
            skillPath: '/ws/.kimi-code/flows/issue-fix.md',
            skillArgs: 'another task',
            skillData: DEFINITION,
          },
        }),
      );
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(service.run().task).toBe('original task');
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
});
