import { type IDisposable, toDisposable } from '#/_base/di/lifecycle';
import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionData } from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { runLegacyStarting } from '#/agent/toolExecutor/legacyHooks';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import { IAgentPermissionGate, type PermissionGateReviewer } from './permissionGate';

export class AgentPermissionGate extends Service implements IAgentPermissionGate {
  declare readonly _serviceBrand: undefined;
  private reviewer: PermissionGateReviewer | undefined;

  constructor(
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @IAgentPermissionPolicyService private readonly policyService: IAgentPermissionPolicyService,
    @IAgentToolApprovalService private readonly toolApproval: IAgentToolApprovalService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();

    this._register(toolExecutor.registerHook({
      permitting: async (context) => {
        const decision = await runLegacyStarting(context, (event) => this.adjudicate(event));
        return decision !== undefined && 'skipPermitting' in decision ? undefined : decision;
      },
    }));
  }

  data(): PermissionData {
    return {
      mode: this.modeService.mode,
      rules: [...this.rulesService.rules],
    };
  }

  registerReviewer(reviewer: PermissionGateReviewer): IDisposable {
    this.reviewer = reviewer;
    return toDisposable(() => {
      if (this.reviewer === reviewer) this.reviewer = undefined;
    });
  }

  private async adjudicate(event: BeforeToolExecuteEvent): Promise<void> {
    let evaluation: PermissionPolicyEvaluation | undefined;
    try {
      evaluation = await this.evaluatePolicy(event);
    } catch (error) {
      event.veto({
        output: `permitting hook failed for "${event.toolCall.name}": ${error instanceof Error ? error.message : String(error)}`,
        isError: true,
      });
      return;
    }
    if (evaluation === undefined) return;
    const deferredReview = this.reviewer?.review(event, evaluation);
    if (deferredReview !== undefined) {
      event.waitUntil(async () => {
        const resolved = await deferredReview();
        this.trackPolicyDecision(event, resolved);
        return this.toolApproval.resolvePermissionResolution(
          resolved.result,
          event,
          resolved.policyName,
        );
      });
      return;
    }
    this.trackPolicyDecision(event, evaluation);
    const { result, policyName } = evaluation;
    if (result.kind === 'ask') {
      event.waitUntil(() => this.toolApproval.requestToolApproval(event, result, policyName));
      return;
    }
    if (result.kind === 'approve') {
      event.pass(result.executionMetadata);
      return;
    }
    if (policyName === 'user-configured-deny') {
      event.waitUntil(() => this.toolApproval.resolvePermissionResolution(result, event, policyName));
      return;
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(result, event, policyName);
    if (resolved?.veto !== undefined) {
      event.veto(resolved.veto);
    }
  }

  private async evaluatePolicy(
    event: BeforeToolExecuteEvent,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    for (;;) {
      const mode = this.modeService.mode;
      const options = this.reviewer?.evaluateOptions?.();
      const evaluation = await this.policyService.evaluate(event, options);
      const nextOptions = this.reviewer?.evaluateOptions?.();
      if (
        this.modeService.mode === mode &&
        nextOptions?.includeUnderlying === options?.includeUnderlying &&
        nextOptions?.skipDangerousCommand === options?.skipDangerousCommand
      ) {
        return evaluation;
      }
    }
  }

  private trackPolicyDecision(
    event: BeforeToolExecuteEvent,
    evaluation: PermissionPolicyEvaluation,
  ): void {
    this.telemetry.track2('permission_policy_decision', {
      turn_id: event.turnId,
      tool_call_id: event.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: event.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  ScopeActivation.OnScopeCreated,
  'permissionGate',
);
