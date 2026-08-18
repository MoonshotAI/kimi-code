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
import { AgentStatusUpdated } from '#/agent/usage/usageEvents';
import { IEventBus } from '#/app/event/eventBus';
import { EventBusService } from '#/app/event/eventBusService';
import { IFlagService } from '#/app/flag/flag';
import { FLOW_FLAG_ID, IAgentFlowService, type FlowDefinition } from '#/features/flow/flow';
import { AgentFlowService } from '#/features/flow/flowService';
import { flowGatesKey, flowKey } from '#/features/flow/flowOps';
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
    } as unknown as IAgentToolApprovalService);
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
    dispatcher = registerTestEventDispatcher(ix);
    agentState = ix.get(IAgentStateService);
    ix.set(IAgentFlowService, new SyncDescriptor(AgentFlowService));
    service = ix.get(IAgentFlowService);
  });
  afterEach(() => disposables.dispose());

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

  describe('FlowAdvance human-gate guard', () => {
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

    it('routes a plan_review pass verdict through tool approval', async () => {
      service.start(DEFINITION, 'task');
      await executorEvents.fireBeforeExecute(
        advanceContext({ kind: 'plan_review', plan: 'criteria verdicts' }),
      );
      expect(requestToolApproval).toHaveBeenCalledTimes(1);
    });

    it('skips approval without a plan_review display, in auto mode, and while the flag is off', async () => {
      service.start(DEFINITION, 'task');
      await executorEvents.fireBeforeExecute(advanceContext(undefined));
      expect(requestToolApproval).not.toHaveBeenCalled();

      permissionMode = 'auto';
      await executorEvents.fireBeforeExecute(
        advanceContext({ kind: 'plan_review', plan: 'criteria verdicts' }),
      );
      expect(requestToolApproval).not.toHaveBeenCalled();

      permissionMode = 'default';
      flowFlagOn = false;
      await executorEvents.fireBeforeExecute(
        advanceContext({ kind: 'plan_review', plan: 'criteria verdicts' }),
      );
      expect(requestToolApproval).not.toHaveBeenCalled();
    });
  });
});
