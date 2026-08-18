import { resolve } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SkillActivated } from '#/agent/skill/skillOps';
import { ContextUndone } from '#/agent/undo/undoService';
import { AgentStatusUpdated, type AgentFlowRunStatus } from '#/agent/usage/usageEvents';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { DeepReadonly } from '#/state/state';

import {
  FLOW_ADVANCE_TOOL_NAME,
  FLOW_FLAG_ID,
  FlowDefinitionSchema,
  IAgentFlowService,
  type FlowAdvanceOutcome,
  type FlowAdvanceResult,
  type FlowDefinition,
  type FlowGatesState,
  type FlowRunState,
  type FlowStageDefinition,
} from './flow';
import { FlowGateReview } from './flowGateReview';
import { flowDefinitionPath } from './flowsSkillSource';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { FlowRunEnded, FlowRunStarted, FlowVerdict, flowGatesKey, flowKey } from './flowOps';

const FLOW_TOOL_NAMES: ReadonlySet<string> = new Set(['FlowStart', 'FlowAdvance', 'FlowAbort']);

export class AgentFlowService extends Disposable implements IAgentFlowService {
  declare readonly _serviceBrand: undefined;

  private readonly review: FlowGateReview;
  private readonly approvedGateCalls = new Map<string, number>();
  private epoch = Date.now();

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IFlagService private readonly flags: IFlagService,
    @IEventBus eventBus: IEventBus,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    super();
    this.agentState.contributeState(flowKey);
    this.agentState.contributeState(flowGatesKey);
    this.review = new FlowGateReview(
      this,
      this.toolApproval,
      (toolCallId) => {
        this.approvedGateCalls.set(toolCallId, this.epoch);
      },
      () => this.epoch,
    );
    this._register(
      toolExecutor.onBeforeExecuteTool((event) => {
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        if (!FLOW_TOOL_NAMES.has(event.toolCall.name)) return;
        const firstFlowCall = event.toolCalls.find((call) => FLOW_TOOL_NAMES.has(call.name));
        if (firstFlowCall !== undefined && firstFlowCall !== event.toolCall) {
          event.veto(
            denyToolExecution(
              'Another flow call precedes this one in the same response, so this call was prepared against a stale run state. Submit flow calls one response at a time.',
            ),
          );
          return;
        }
        if (event.toolCall.name !== FLOW_ADVANCE_TOOL_NAME) return;
        if (event.toolCalls.length > 1) {
          event.veto(
            denyToolExecution(
              'A verdict must be the only call in its response: its evidence must come from work already completed and verified in earlier responses, and later siblings would run even after a rejection. Submit FlowAdvance alone.',
            ),
          );
          return;
        }
        if (event.execution.display?.kind !== 'flow_gate_review') return;
        if (this.modeService.mode === 'auto') return;
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
      eventBus.subscribe(ContextUndone, () => {
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        this.epoch += 1;
        void this.dispatcher.dispatch(new AgentStatusUpdated({ flowRun: this.summary() }));
      }),
    );
    this._register(
      eventBus.subscribe(SkillActivated, (event) => {
        if (event.skillType !== 'flow') return;
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        if (this.scopeContext.agentId !== 'main') return;
        this.startFromActivation(event.skillName, event.skillArgs, event.skillPath, event.skillData);
      }),
    );
  }

  private summary(): AgentFlowRunStatus | null {
    const run = this.run();
    const stage = this.currentStage();
    if (!run.active || run.flowId === undefined || stage === undefined) return null;
    return {
      flowId: run.flowId,
      stageId: stage.id,
      stageIndex: run.currentStageIndex ?? 0,
      stageTotal: run.stages?.length ?? 0,
      gate: stage.gate,
    };
  }

  private startFromActivation(
    flowId: string | undefined,
    task: string | undefined,
    skillPath: string | undefined,
    skillData: unknown,
  ): void {
    if (flowId === undefined || flowId.length === 0 || this.run().active) return;
    if (task === undefined || task.trim().length === 0) return;
    if (
      skillPath === undefined ||
      resolve(skillPath) !== resolve(flowDefinitionPath(this.workspaceCtx.workDir, flowId))
    ) {
      return;
    }
    const parsed = FlowDefinitionSchema.safeParse(skillData);
    if (!parsed.success || parsed.data.id !== flowId) return;
    this.start(parsed.data, task.trim());
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
    if (this.run().active) return false;
    void this.dispatcher.dispatch(
      new FlowRunStarted({
        flowId: definition.id,
        task,
        stages: definition.stages.map((stage) => ({ ...stage })),
      }),
    );
    this.epoch += 1;
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
    if ((run.currentStageIndex ?? 0) >= (run.stages?.length ?? 0)) {
      void this.dispatcher.dispatch(new FlowRunEnded({ reason: 'finished' }));
      return { recorded: true, runFinished: true };
    }
    return { recorded: true, runFinished: false, nextStage: this.currentStage() };
  }

  runEpoch(): number {
    return this.epoch;
  }

  consumeGateApproval(toolCallId: string): boolean {
    const approvedAt = this.approvedGateCalls.get(toolCallId);
    this.approvedGateCalls.delete(toolCallId);
    return approvedAt === this.epoch;
  }

  abort(note?: string): void {
    if (!this.run().active) return;
    this.epoch += 1;
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
