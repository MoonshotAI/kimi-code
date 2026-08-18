import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { DeepReadonly } from '#/state/state';

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
    @IAgentToolApprovalService toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IFlagService private readonly flags: IFlagService,
  ) {
    super();
    this.agentState.contributeState(flowKey);
    this.agentState.contributeState(flowGatesKey);
    this.review = new FlowGateReview(this, toolApproval);
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        if (event.toolCall.name !== FLOW_ADVANCE_TOOL_NAME) return;
        if (this.modeService.mode === 'auto') return;
        if (event.execution.display?.kind !== 'plan_review') return;
        event.waitUntil(() => this.review.requestApproval(event));
      }),
    );
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

  start(definition: FlowDefinition, task: string): void {
    if (!this.flags.enabled(FLOW_FLAG_ID)) return;
    void this.dispatcher.dispatch(
      new FlowRunStarted({
        flowId: definition.id,
        task,
        stages: definition.stages.map((stage) => ({ ...stage })),
      }),
    );
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
