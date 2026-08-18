import { Disposable } from '#/_base/di/lifecycle';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentRuntimeService, inspectAgentRuntime } from '#/agent/runtimeBinding/agentRuntime';
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

import { parseFlowDefinition } from './definition';

import {
  FLOW_ADVANCE_TOOL_NAME,
  FLOW_FLAG_ID,
  FLOWS_PROJECT_DIR,
  IAgentFlowService,
  type FlowAdvanceOutcome,
  type FlowAdvanceResult,
  type FlowDefinition,
  type FlowGatesState,
  type FlowRunState,
  type FlowStageDefinition,
} from './flow';
import { FlowGateReview } from './flowGateReview';
import { RuntimeWorkspaceView } from '#/runtime/runtimeWorkspaceView';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { FlowRunEnded, FlowRunStarted, FlowVerdict, flowGatesKey, flowKey } from './flowOps';

const FLOW_TOOL_NAMES: ReadonlySet<string> = new Set(['FlowStart', 'FlowAdvance', 'FlowAbort']);

export class AgentFlowService extends Disposable implements IAgentFlowService {
  declare readonly _serviceBrand: undefined;

  private readonly review: FlowGateReview;
  private activationInFlight = false;

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IFlagService private readonly flags: IFlagService,
    @IEventBus eventBus: IEventBus,
    @IAgentRuntimeService private readonly runtime: IAgentRuntimeService,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
  ) {
    super();
    this.agentState.contributeState(flowKey);
    this.agentState.contributeState(flowGatesKey);
    this.review = new FlowGateReview(this, this.toolApproval);
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
        if (this.modeService.mode === 'auto') return;
        if (event.execution.display?.kind !== 'flow_gate_review') return;
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
        void this.dispatcher.dispatch(new AgentStatusUpdated({ flowRun: this.summary() }));
      }),
    );
    this._register(
      eventBus.subscribe(SkillActivated, (event) => {
        if (event.skillType !== 'flow') return;
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        if (this.scopeContext.agentId !== 'main') return;
        void this.startFromActivation(event.skillName, event.skillArgs);
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

  private async startFromActivation(
    flowId: string | undefined,
    task: string | undefined,
  ): Promise<void> {
    if (flowId === undefined || flowId.length === 0 || this.run().active) return;
    if (task === undefined || task.trim().length === 0) return;
    if (this.activationInFlight) return;
    this.activationInFlight = true;
    try {
      await this.readAndStart(flowId, task);
    } finally {
      this.activationInFlight = false;
    }
  }

  private async readAndStart(flowId: string, task: string | undefined): Promise<void> {
    let text: string;
    try {
      const view = new RuntimeWorkspaceView(inspectAgentRuntime(this.runtime), {
        workDir: this.workspaceCtx.workDir,
        additionalDirs: [...this.workspaceCtx.additionalDirs],
      });
      const path = view.resolve(`${FLOWS_PROJECT_DIR}/${flowId}.md`);
      const lease = this.runtime.acquire(['fs']);
      try {
        text = await lease.runtime.fs!.readText(path);
      } finally {
        lease.dispose();
      }
    } catch {
      return;
    }
    try {
      const definition = parseFlowDefinition(text);
      if (definition.id !== flowId) return;
      this.start(definition, task?.trim() ?? '');
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
    if (this.run().active) return false;
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
