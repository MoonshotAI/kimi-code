import type { Agent } from '..';
import type { PrepareToolExecutionResult } from '../../loop';
import type { TelemetryProperties } from '../../telemetry';
import type { ToolInputDisplay } from '../../tools/display';
import { createPermissionDecisionPolicies } from './policies';
import type {
  ApprovalResponse,
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
  PermissionPolicy,
  PermissionPolicyContext,
  PermissionPolicyResolution,
  PermissionPolicyResult,
  PermissionRule
} from './types';

export * from './types';

export interface PermissionManagerOptions {
  readonly initialRules?: readonly PermissionRule[];
  readonly parent?: PermissionManager;
}

interface PolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export class PermissionManager {
  rules: PermissionRule[] = [];
  private modeOverride: PermissionMode | undefined;
  private readonly parent: PermissionManager | undefined;
  private readonly localSessionApprovalRulePatterns = new Set<string>();
  private readonly policies: readonly PermissionPolicy[];

  constructor(
    protected readonly agent: Agent,
    options: PermissionManagerOptions = {},
  ) {
    this.rules = [...(options.initialRules ?? [])];
    this.parent = options.parent;
    this.policies = createPermissionDecisionPolicies(this.agent);
  }

  get mode(): PermissionMode {
    return this.modeOverride ?? this.parent?.mode ?? 'manual';
  }

  set mode(mode: PermissionMode) {
    this.modeOverride = mode;
  }

  data(): PermissionData {
    return {
      mode: this.mode,
      rules: this.effectiveRules(),
    };
  }

  setMode(mode: PermissionMode): void {
    this.agent.records.logRecord({
      type: 'permission.set_mode',
      mode,
    });
    this.agent.replayBuilder.push({
      type: 'permission_updated',
      mode,
    });
    this.modeOverride = mode;
    this.agent.emitStatusUpdated();
  }

  recordApprovalResult(record: PermissionApprovalResultRecord): void {
    this.agent.records.logRecord({
      type: 'permission.record_approval_result',
      ...record,
    });
    this.agent.replayBuilder.push({
      type: 'approval_result',
      record,
    });
    if (record.result.decision !== 'approved' || record.result.scope !== 'session') {
      return;
    }
    const pattern = record.sessionApprovalRule;
    if (pattern === undefined) return;
    this.addSessionApprovalRule(pattern);
  }

  sessionApprovalRulePatterns(): readonly string[] {
    return [
      ...this.localSessionApprovalRulePatterns,
      ...(this.parent?.sessionApprovalRulePatterns() ?? []),
    ];
  }

  async beforeToolCall(
    context: PermissionPolicyContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const evaluation = await this.evaluatePolicies(context);
    if (evaluation === undefined) return undefined;

    this.trackPolicyDecision(evaluation.policyName, context, evaluation.result);
    return this.permissionPolicyResolutionToPrepare(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  private async requestToolApproval(
    context: PermissionPolicyContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    policyName: string | undefined,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const { signal } = context;
    const id = context.toolCall.id;
    const name = context.toolCall.name;
    const display = approvalDisplayForExecution(name, context.execution);
    const action = approvalActionForExecution(name, context.execution);
    const startedAt = Date.now();

    let response: ApprovalResponse;
    try {
      response = await this.agent.rpc.requestApproval(
        {
          turnId: Number(context.turnId),
          toolCallId: id,
          toolName: name,
          action,
          display,
        },
        { signal },
      );
    } catch (error) {
      this.trackApprovalResult({
        policyName,
        toolName: name,
        display,
        result: 'error',
        durationMs: Date.now() - startedAt,
        sessionCacheWritten: false,
      });
      const resolved = result.resolveError?.(error);
      return resolved === undefined
        ? Promise.reject(error)
        : this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;

    this.recordApprovalResult({
      turnId: Number(context.turnId),
      toolCallId: id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });
    this.trackApprovalResult({
      policyName,
      toolName: name,
      display,
      result: approvalTelemetryResult(response),
      durationMs: Date.now() - startedAt,
      sessionCacheWritten: sessionApprovalRule !== undefined,
      hasFeedback: response.feedback !== undefined && response.feedback.length > 0,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.permissionPolicyResolutionToPrepare(resolved, context, policyName);
    }

    if (response.decision === 'approved') {
      return undefined;
    }

    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, response),
    };
  }

  private async evaluatePolicies(
    context: PermissionPolicyContext,
  ): Promise<PolicyEvaluation | undefined> {
    for (const policy of this.policies) {
      const result = await policy.evaluate(context);
      if (result !== undefined) {
        return { policyName: policy.name, result };
      }
    }
    return undefined;
  }

  private effectiveRules(): PermissionRule[] {
    return [...this.rules, ...(this.parent?.effectiveRules() ?? [])];
  }

  private addSessionApprovalRule(pattern: string): void {
    this.localSessionApprovalRulePatterns.add(pattern);
  }

  private permissionPolicyResolutionToPrepare(
    result: PermissionPolicyResolution,
    context: PermissionPolicyContext,
    policyName?: string,
  ): Promise<PrepareToolExecutionResult | undefined> | PrepareToolExecutionResult | undefined {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          block: true,
          reason: result.message ?? this.formatPolicyDenyMessage(context.toolCall.name),
        };
      case 'ask':
        return this.requestToolApproval(context, result, policyName);
      case 'result': {
        const { kind: _kind, ...prepareResult } = result;
        return prepareResult;
      }
    }
  }

  protected formatApprovalRejectionMessage(
    toolName: string,
    result: { decision: 'approved' | 'rejected' | 'cancelled'; feedback?: string },
  ): string {
    const suffix =
      result.feedback !== undefined && result.feedback.length > 0
        ? ` Reason: ${result.feedback}`
        : '';
    const prefix =
      result.decision === 'cancelled'
        ? `Tool "${toolName}" was not run because the approval request was cancelled.`
        : `Tool "${toolName}" was not run because the user rejected the approval request.`;
    if (this.agent.type === 'sub') {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatPolicyDenyMessage(toolName: string): string {
    const prefix = `Tool "${toolName}" was denied by permission policy.`;
    if (this.agent.type === 'sub') {
      return `${prefix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return prefix;
  }

  private trackPolicyDecision(
    policyName: string,
    context: PermissionPolicyContext,
    result: PermissionPolicyResult,
  ): void {
    this.agent.telemetry.track('permission_policy_decision', {
      policy_name: policyName,
      tool_name: context.toolCall.name,
      permission_mode: this.mode,
      decision: result.kind,
      ...result.reason,
    });
  }

  private trackApprovalResult(input: {
    readonly policyName: string | undefined;
    readonly toolName: string;
    readonly display: ToolInputDisplay;
    readonly result: 'approved' | 'approved_for_session' | 'rejected' | 'cancelled' | 'error';
    readonly durationMs: number;
    readonly sessionCacheWritten: boolean;
    readonly hasFeedback?: boolean;
  }): void {
    const properties: Record<string, TelemetryProperties[string]> = {
      policy_name: input.policyName ?? null,
      tool_name: input.toolName,
      permission_mode: this.mode,
      result: input.result,
      approval_surface: input.display.kind,
      duration_ms: input.durationMs,
      session_cache_written: input.sessionCacheWritten,
      has_feedback: input.hasFeedback === true,
    };
    this.agent.telemetry.track('permission_approval_result', properties);
  }
}

function approvalDisplayForExecution(
  toolName: string,
  execution: PermissionPolicyContext['execution'],
): ToolInputDisplay {
  return (
    execution.display ?? {
      kind: 'generic',
      summary: execution.description ?? `Approve ${toolName}`,
    }
  );
}

function approvalActionForExecution(
  toolName: string,
  execution: PermissionPolicyContext['execution'],
): string {
  return execution.description ?? `Call ${toolName}`;
}

function approvalTelemetryResult(
  result: ApprovalResponse,
): 'approved' | 'approved_for_session' | 'rejected' | 'cancelled' {
  if (result.decision === 'approved' && result.scope === 'session') return 'approved_for_session';
  return result.decision;
}
