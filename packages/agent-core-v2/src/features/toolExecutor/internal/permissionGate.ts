import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import type { BeforeToolExecuteEvent } from '#/features/toolExecutor/toolHooks';
import type { PermissionMode } from '#/features/toolExecutor/permissionTypes';
import { AgentPermissionMode } from '#/features/permissionMode/permissionModeAgentRuntime';
import { toWireMode } from '#/features/permissionMode/internal/modeMapping';
import { ITelemetryService } from '#/app/telemetry/telemetry';

import type { ToolExecutionPermissionPolicyChain } from '#/features/toolExecutor/internal/permissionPolicy';

export class ToolExecutionPermissionGatePolicy {
  constructor(
    private readonly runtime: AgentRuntimeContext<unknown>,
    private readonly policyChain: ToolExecutionPermissionPolicyChain,
  ) {}

  private get manager(): IAgentLifecycleService {
    return this.runtime.get(IAgentLifecycleService);
  }

  private get toolApproval(): IAgentToolApprovalService {
    return this.runtime.get(IAgentToolApprovalService);
  }

  private get telemetry(): ITelemetryService {
    return this.runtime.get(ITelemetryService);
  }

  async adjudicate(event: BeforeToolExecuteEvent): Promise<void> {
    const evaluation = await this.policyChain.evaluate(event);
    if (evaluation === undefined) return;
    this.telemetry.track2('permission_policy_decision', {
      turn_id: event.turnId,
      tool_call_id: event.toolCall.id,
      policy_name: evaluation.policyName,
      tool_name: event.toolCall.name,
      permission_mode: this.mode(),
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

  private mode(): PermissionMode {
    return toWireMode(this.manager.resolve(this.runtime.agent, AgentPermissionMode).mode());
  }
}
