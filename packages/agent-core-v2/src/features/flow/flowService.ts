import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentRuntimeService } from '#/agent/runtimeBinding/agentRuntime';
import { SkillActivated } from '#/agent/skill/skillOps';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { DeepReadonly } from '#/state/state';

import { parseFlowDefinition } from './definition';

import {
  FLOW_ADVANCE_TOOL_NAME,
  FLOW_FLAG_ID,
  IAgentFlowService,
  type FlowAdvanceOutcome,
  type FlowAdvanceResult,
  type FlowDefinition,
  type FlowGatesState,
  type FlowRunState,
  type FlowStageDefinition,
} from './flow';
import { FlowGateReview } from './flowGateReview';
import { FlowRunEnded, FlowRunStarted, FlowVerdict, flowGatesKey, flowKey } from './flowOps';

export class AgentFlowService extends Disposable implements IAgentFlowService {
  declare readonly _serviceBrand: undefined;

  private readonly review: FlowGateReview;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IFlagService private readonly flags: IFlagService,
    @IEventBus eventBus: IEventBus,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
  ) {
    super();
    this.agentState.contributeState(flowKey);
    this.agentState.contributeState(flowGatesKey);
    this.review = new FlowGateReview(this, this.toolApproval);
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        if (event.toolCall.name !== FLOW_ADVANCE_TOOL_NAME) return;
        if (this.modeService.mode === 'auto') return;
        if (event.execution.display?.kind !== 'plan_review') return;
        event.waitUntil(() => this.review.requestApproval(event));
      }),
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        if (!this.run().active) return;
        if (event.toolCall.name !== 'TodoList') return;
        event.veto(
          denyToolExecution(
            this.toolApproval.formatDenyMessage(
              'TodoList is unavailable during a flow run — stage progress lives in the flow itself (the engine tracks it and the UI shows it). Dispatch and accept stages instead of mirroring them into todos.',
            ),
          ),
        );
      }),
    );
    this._register(
      eventBus.subscribe(SkillActivated, (event) => {
        if (event.skillType !== 'flow') return;
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        void this.startFromActivation(event.skillPath, event.skillArgs);
      }),
    );
  }

  private async startFromActivation(
    path: string | undefined,
    task: string | undefined,
  ): Promise<void> {
    if (path === undefined || this.run().active) return;
    let text: string;
    const lease = this.runtime.acquire(['fs']);
    try {
      text = await lease.runtime.fs!.readText(path);
    } catch {
      return;
    } finally {
      lease.dispose();
    }
    try {
      this.start(parseFlowDefinition(text), task?.trim() ?? '');
    } catch {
      return;
    }
  }

  run(): DeepReadonly<FlowRunState> {
    return this.agentState.get(flowKey);
  }

  gates(): DeepReadonly<FlowGatesState> {
    return this.agentState.get(flowGatesKey);
  }

  currentStage(): DeepReadonly<FlowStageDefinition> | undefined {
    const run = this.run();
    if (!run.active) return undefined;
    return run.stages?.[run.currentStageIndex ?? 0];
  }

  start(definition: FlowDefinition, task: string): boolean {
    if (!this.flags.enabled(FLOW_FLAG_ID)) return false;
    void this.dispatcher.dispatch(
      new FlowRunStarted({
        flowId: definition.id,
        task,
        stages: definition.stages.map((stage) => ({ ...stage })),
      }),
    );
    return this.run().active;
  }

  advance(outcome: FlowAdvanceOutcome): FlowAdvanceResult {
    if (!this.flags.enabled(FLOW_FLAG_ID)) return { recorded: false, runFinished: false };
    const current = this.currentStage();
    if (current === undefined || current.id !== outcome.stage) {
      return { recorded: false, runFinished: false };
    }
    void this.dispatcher.dispatch(
      new FlowVerdict({
        stage: outcome.stage,
        result: outcome.result,
        decidedBy: outcome.decidedBy,
        criteria: outcome.criteria.map((criterion) => ({ ...criterion })),
        feedback: outcome.feedback,
      }),
    );
    if (outcome.result !== 'pass') return { recorded: true, runFinished: false };
    const run = this.run();
    if (run.active && (run.currentStageIndex ?? 0) >= (run.stages?.length ?? 0)) {
      void this.dispatcher.dispatch(new FlowRunEnded({ reason: 'finished' }));
      return { recorded: true, runFinished: true };
    }
    return { recorded: true, runFinished: false, nextStage: this.currentStage() };
  }

  abort(note?: string): void {
    if (!this.run().active) return;
    void this.dispatcher.dispatch(new FlowRunEnded({ reason: 'aborted', note }));
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentFlowService,
  AgentFlowService,
  ScopeActivation.OnScopeCreated,
  'flow',
);
