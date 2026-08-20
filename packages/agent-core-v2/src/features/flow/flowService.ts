import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

import { Disposable } from '#/_base/di/lifecycle';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { SkillActivated } from '#/agent/skill/skillOps';
import { ISkillActivationDataService } from '#/agent/skill/skillActivationData';
import { ContextUndone } from '#/agent/undo/undoService';
import { AgentStatusUpdated, type AgentFlowRunStatus } from '#/agent/usage/usageEvents';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IEventBus } from '#/app/event/eventBus';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { LifecycleScope } from '#/app/scopes';
import { IEventDispatcher } from '#/state/eventDispatcher';
import type { DeepReadonly } from '#/state/state';

import {
  DEFAULT_FLOW_JUMP_POLICY,
  FLOW_ADVANCE_TOOL_NAME,
  FLOW_FLAG_ID,
  FLOW_JUMP_TOOL_NAME,
  FLOW_START_TOOL_NAME,
  FLOW_TOOL_NAMES,
  FlowDefinitionSchema,
  IAgentFlowService,
  type FlowAdvanceOutcome,
  type FlowAdvanceResult,
  type FlowJumpOutcome,
  type FlowJumpPolicy,
  type FlowJumpResult,
  type FlowDefinition,
  type FlowGatesState,
  type FlowRunState,
  type FlowStageDefinition,
} from './flow';
import { FlowGateReview } from './flowGateReview';
import {
  FLOW_SKILL_NAME_PREFIX,
  flowDefinitionPath,
  userFlowDefinitionPath,
} from './flowsSkillSource';
import { ISessionWorkspaceContext } from '#/session/workspaceContext/workspaceContext';

import { FlowJumped, FlowRunEnded, FlowRunStarted, FlowVerdict, flowGatesKey, flowKey } from './flowOps';

export class AgentFlowService extends Disposable implements IAgentFlowService {
  declare readonly _serviceBrand: undefined;

  private readonly review: FlowGateReview;
  private readonly approvedGateCalls = new Map<string, number>();
  private readonly preparedEpochs = new WeakMap<object, number>();
  private readonly pendingActivations = new Map<
    string,
    { definition: FlowDefinition; task: string }
  >();
  private epoch = Date.now();

  constructor(
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentStateService private readonly agentState: IAgentStateService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IFlagService private readonly flags: IFlagService,
    @IEventBus eventBus: IEventBus,
    @ISessionWorkspaceContext private readonly workspaceCtx: ISessionWorkspaceContext,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ISkillActivationDataService private readonly activationData: ISkillActivationDataService,
    @IAgentContextMemoryService private readonly contextMemory: IAgentContextMemoryService,
    @IConfigService config: IConfigService,
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
        if (!this.isBuiltinFlowTool(event.toolCall.name)) return;
        const firstFlowCall = event.toolCalls.find((call) => this.isBuiltinFlowTool(call.name));
        if (firstFlowCall !== undefined && firstFlowCall !== event.toolCall) {
          event.veto(
            denyToolExecution(
              'Another flow call precedes this one in the same response, so this call was prepared against a stale run state. Submit flow calls one response at a time.',
            ),
          );
          return;
        }
        if (event.toolCall.name === FLOW_JUMP_TOOL_NAME) {
          if (event.toolCalls.length > 1) {
            event.veto(
              denyToolExecution(
                'A stage jump must be the only call in its response: siblings would run against a stage the jump is about to leave. Submit FlowJump alone.',
              ),
            );
            return;
          }
          if (event.execution.display?.kind !== 'flow_jump_review') return;
          if (this.jumpPolicy() !== 'approval') return;
          if (this.modeService.mode === 'auto') return;
          event.waitUntil(() => this.review.requestJumpApproval(event));
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
        if (event.toolCall.name !== 'TodoList' || !this.isBuiltinTool('TodoList')) return;
        const startsInBatch = event.toolCalls.some(
          (call) => call.name === FLOW_START_TOOL_NAME && this.isBuiltinFlowTool(call.name),
        );
        if (!this.run().active && !startsInBatch) return;
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
        this.epoch += 1;
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        if (this.scopeContext.agentId !== 'main') return;
        void this.dispatcher.dispatch(new AgentStatusUpdated({ flowRun: this.summary() }));
      }),
    );
    this._register(
      eventBus.subscribe(SkillActivated, (event) => {
        if (event.skillType !== 'flow') return;
        if (!this.flags.enabled(FLOW_FLAG_ID)) return;
        if (this.scopeContext.agentId !== 'main') return;
        this.prepareActivationStart(event.activationId, event.skillName, event.skillArgs, event.skillPath);
      }),
    );
    let flagWas = this.flags.enabled(FLOW_FLAG_ID);
    this._register(
      config.onDidChangeConfiguration(() => {
        const flagNow = this.flags.enabled(FLOW_FLAG_ID);
        if (flagNow === flagWas) return;
        flagWas = flagNow;
        if (!flagNow) this.pendingActivations.clear();
        if (this.scopeContext.agentId !== 'main') return;
        void this.dispatcher.dispatch(
          new AgentStatusUpdated({ flowRun: flagNow ? this.summary() : null }),
        );
      }),
    );
  }

  private isBuiltinFlowTool(name: string): boolean {
    if (!FLOW_TOOL_NAMES.has(name)) return false;
    return this.isBuiltinTool(name);
  }

  private isBuiltinTool(name: string): boolean {
    return this.toolRegistry
      .listReferences()
      .some((reference) => reference.name === name && reference.source === 'builtin');
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

  private prepareActivationStart(
    activationId: string,
    skillName: string | undefined,
    task: string | undefined,
    skillPath: string | undefined,
  ): void {
    if (skillName === undefined || !skillName.startsWith(FLOW_SKILL_NAME_PREFIX)) return;
    const flowId = skillName.slice(FLOW_SKILL_NAME_PREFIX.length);
    if (flowId.length === 0 || this.run().active) return;
    if (skillPath === undefined) return;
    const resolvedSkillPath = resolve(skillPath);
    if (
      resolvedSkillPath !== resolve(flowDefinitionPath(this.workspaceCtx.workDir, flowId)) &&
      resolvedSkillPath !== resolve(userFlowDefinitionPath(this.bootstrap.homeDir, flowId))
    ) {
      return;
    }
    const parsed = FlowDefinitionSchema.safeParse(this.activationData.take(activationId));
    if (!parsed.success || parsed.data.id !== flowId) return;
    this.pendingActivations.set(activationId, { definition: parsed.data, task: task?.trim() ?? '' });
  }

  reconcilePendingActivation(): void {
    if (this.pendingActivations.size === 0) return;
    if (!this.flags.enabled(FLOW_FLAG_ID)) return;
    const last = this.contextMemory
      .get()
      .findLast((message) => message.role === 'user' && message.origin?.kind !== 'injection');
    const origin = last?.origin;
    if (origin === undefined) return;
    const promptActivationIds =
      origin.kind === 'skill_activation'
        ? [origin.activationId]
        : origin.kind === 'user'
          ? (origin.skillActivations ?? []).map((entry) => entry.activationId)
          : [];
    const matchedIds = promptActivationIds.filter((id) => this.pendingActivations.has(id));
    const firstMatch = matchedIds[0];
    if (firstMatch === undefined) return;
    const pending = this.pendingActivations.get(firstMatch);
    for (const id of matchedIds) this.pendingActivations.delete(id);
    if (pending === undefined) return;
    if (this.run().active) return;
    let task = pending.task;
    if (task.length === 0 && origin.kind === 'user' && last !== undefined) {
      task = last.content
        .slice((origin.skillActivations ?? []).length)
        .filter((part) => part.type === 'text')
        .map((part) => part.text)
        .join('\n')
        .trim();
    }
    if (task.length === 0) return;
    this.start(pending.definition, task);
  }

  hasPendingActivation(): boolean {
    return this.pendingActivations.size > 0;
  }

  discardPendingActivation(activationId: string): void {
    this.pendingActivations.delete(activationId);
  }

  stampPreparedEpoch(args: object): void {
    this.preparedEpochs.set(args, this.epoch);
  }

  preparedEpochOf(args: object): number | undefined {
    return this.preparedEpochs.get(args);
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
        runId: randomUUID(),
        jumpPolicy: definition.jumps ?? DEFAULT_FLOW_JUMP_POLICY,
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
    const activeRun = this.run();
    void this.dispatcher.dispatch(
      new FlowVerdict({
        stage: outcome.stage,
        result: outcome.result,
        decidedBy: outcome.decidedBy,
        criteria: outcome.criteria.map((criterion) => ({ ...criterion })),
        feedback: outcome.feedback,
        flowId: activeRun.flowId,
        task: activeRun.task,
        runId: activeRun.runId,
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

  jump(outcome: FlowJumpOutcome): FlowJumpResult {
    if (!this.flags.enabled(FLOW_FLAG_ID)) return { recorded: false };
    const run = this.run();
    const current = this.currentStage();
    if (!run.active || current === undefined) return { recorded: false };
    if (outcome.to === current.id) return { recorded: false };
    if (!(run.stages ?? []).some((stage) => stage.id === outcome.to)) return { recorded: false };
    void this.dispatcher.dispatch(
      new FlowJumped({
        fromStage: current.id,
        toStage: outcome.to,
        reason: outcome.reason,
        decidedBy: outcome.decidedBy,
        flowId: run.flowId,
        task: run.task,
        runId: run.runId,
      }),
    );
    this.epoch += 1;
    return { recorded: true, stage: this.currentStage() };
  }

  jumpPolicy(): FlowJumpPolicy {
    return this.run().jumpPolicy ?? DEFAULT_FLOW_JUMP_POLICY;
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
