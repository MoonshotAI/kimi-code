/**
 * `permissionGate` domain (L3) — `IAgentPermissionGate` implementation.
 *
 * Runs the `permissionPolicy` chain for every tool execution as an
 * `onBeforeExecuteTool` veto listener: `deny` / `result` resolutions veto,
 * `approve` passes with its `executionMetadata`, and `ask` defers to a cold
 * `waitUntil` factory so the approval round-trip only starts once no other
 * listener vetoed or allowed the call. Reports `permission_policy_decision`
 * through `telemetry`, and delegates the ask round-trip (broker, events,
 * session-rule recording) to `toolApproval`. Harness constraints (plan
 * guard, swarm exclusivity, btw deny) live in their own domains as veto
 * listeners — this gate only adjudicates risk. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionData } from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import type {
  BeforeExecuteDecision,
  BeforeToolExecuteEvent,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import { IAgentPermissionGate } from './permissionGate';

export class AgentPermissionGate extends Disposable implements IAgentPermissionGate {
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
    this._register(toolExecutor.onBeforeExecuteTool((event) => this.adjudicate(event)));
  }

  data(): PermissionData {
    return {
      mode: this.modeService.mode,
      rules: [...this.rulesService.rules],
    };
  }

  private async adjudicate(event: BeforeToolExecuteEvent): Promise<void> {
    const evaluation = await this.policyService.evaluate(event);
    if (evaluation === undefined) return;
    this.telemetry.track2('permission_policy_decision', {
      turn_id: event.turnId,
      tool_call_id: event.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: event.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    const { result, policyName } = evaluation;
    if (result.kind === 'ask') {
      event.waitUntil(() => this.toolApproval.requestToolApproval(event, result, policyName));
      return;
    }
    if (result.kind === 'approve') {
      event.pass(result.executionMetadata);
      return;
    }
    const resolved = await this.toolApproval.resolvePermissionResolution(result, event, policyName);
    if (resolved?.veto !== undefined) {
      event.veto(resolved.veto);
    }
  }

  async authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
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
  InstantiationType.Eager,
  'permissionGate',
);
