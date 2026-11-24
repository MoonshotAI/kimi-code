import { Service } from '#/_base/di/service';
import { ILogService } from '#/_base/log/log';
import { IAgentFullCompactionService } from '#/agent/fullCompaction/fullCompaction';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentPermissionGate } from '#/agent/permissionGate/permissionGate';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';

import {
  AutoReviewCompleted,
  AutoReviewStarted,
  autoReviewApprovedCallsKey,
} from './autoReviewEvents';
import { createAutoReviewReviewer } from './autoReviewGate';
import {
  IAutoReviewService,
  ISessionAutoReviewService,
  type AutoReviewOutcome,
} from './review';

export class AutoReviewService extends Service implements IAutoReviewService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IFlagService flags: IFlagService,
    @IAgentPermissionModeService modeService: IAgentPermissionModeService,
    @IAgentPermissionPolicyService policyService: IAgentPermissionPolicyService,
    @IAgentPermissionGate permissionGate: IAgentPermissionGate,
    @IAgentStateService private readonly states: IAgentStateService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentFullCompactionService private readonly compaction: IAgentFullCompactionService,
    @ISessionAutoReviewService private readonly sessionReview: ISessionAutoReviewService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this._register(this.states.contributeState(autoReviewApprovedCallsKey));
    this._register(this.sessionReview.snapshotParentInstructions(scopeContext));
    this._register(
      permissionGate.registerReviewer(
        createAutoReviewReviewer(flags, modeService, policyService, this),
      ),
    );
  }

  async review(
    context: ResolvedToolExecutionHookContext,
    trigger: string,
  ): Promise<AutoReviewOutcome> {
    const startedAt = Date.now();
    void this.dispatcher.dispatch(new AutoReviewStarted({
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
    }));
    const { modelAlias, outcome } = await this.sessionReview.execute({
      agentContext: this.scopeContext.agentContext,
      scopeContext: this.scopeContext,
      mainModelAlias: this.profile.resolveModelContext().modelAlias,
      readHistory: () => this.loop.history(),
      readApprovedIds: () => new Set(this.states.get(autoReviewApprovedCallsKey)),
      context,
    });
    if (outcome.decision === 'failed' && outcome.contextOverflow === true) {
      this.compaction.begin({ source: 'auto' });
    }
    const durationMs = Date.now() - startedAt;
    const risk = 'risk' in outcome ? outcome.risk : undefined;
    const reason = 'reason' in outcome ? outcome.reason : undefined;
    void this.dispatcher.dispatch(new AutoReviewCompleted({
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: context.toolCall.name,
      triggerPolicy: trigger,
      model: modelAlias,
      decision: outcome.decision,
      ...(risk === undefined ? {} : { risk }),
      ...(reason === undefined ? {} : { reason }),
      durationMs,
    }));
    if (outcome.decision === 'failed') {
      this.log.warn('auto review failed', { model: modelAlias, tool: context.toolCall.name, reason: outcome.reason });
    }
    this.telemetry.track2('auto_review_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      tool_name: context.toolCall.name,
      trigger_policy: trigger,
      model: modelAlias,
      decision: outcome.decision,
      ...(risk === undefined ? {} : { risk }),
      duration_ms: durationMs,
    });
    return outcome;
  }
}
