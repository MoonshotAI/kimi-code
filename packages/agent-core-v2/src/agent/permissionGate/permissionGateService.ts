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
import { legacyExecutionContext, legacyStartingDecision } from '#/agent/toolExecutor/legacyHooks';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import { IAgentPermissionGate } from './permissionGate';

export class AgentPermissionGate extends Service implements IAgentPermissionGate {
  declare readonly _serviceBrand: undefined;
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
        const decision = await this.adjudicate(legacyExecutionContext(context));
        const mapped = legacyStartingDecision(context, decision);
        return mapped !== undefined && 'skipPermitting' in mapped ? undefined : mapped;
      },
    }));
  }

  data(): PermissionData {
    return {
      mode: this.modeService.mode,
      rules: [...this.rulesService.rules],
    };
  }

  private async evaluateAndTrack(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined> {
    const evaluation = await this.policyService.evaluate(context);
    if (evaluation === undefined) return undefined;
    this.telemetry.track2('permission_policy_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: context.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    return evaluation;
  }

  private async adjudicate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const evaluation = await this.evaluateAndTrack(context);
    if (evaluation === undefined) return undefined;
    const { result, policyName } = evaluation;
    if (result.kind === 'ask') {
      return this.toolApproval.requestToolApproval(context, result, policyName);
    }
    if (result.kind === 'approve') {
      return result.executionMetadata === undefined
        ? undefined
        : { executionMetadata: result.executionMetadata };
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(result, context, policyName);
    return resolved?.veto === undefined ? undefined : { veto: resolved.veto };
  }

  async authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const evaluation = await this.evaluateAndTrack(context);
    if (evaluation === undefined) return undefined;
    return this.toolApproval.resolvePermissionResolution(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  ScopeActivation.OnScopeCreated,
  'permissionGate',
);
