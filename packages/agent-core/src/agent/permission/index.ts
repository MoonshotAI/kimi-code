import type { Agent } from '..';
import type { PrepareToolExecutionResult, ToolExecutionHookContext } from '../../loop';
import type { TelemetryPropertyValue } from '../../telemetry';
import { isDefaultAutoAllowTool } from '../../tools/policies/default-permissions';
import type { ToolInputDisplay } from '../../tools/display';
import { actionToRulePattern, describeApprovalAction } from './action-label';
import { checkMatchingRules, type CheckRulesResult } from './check-rules';
import type { PermissionPathMatchOptions } from './path-glob-match';
import { createPermissionDecisionPolicies } from './policies';
import type { PermissionPolicy, PermissionPolicyResult } from './policy';
import type {
  PermissionApprovalResultRecord,
  PermissionData,
  PermissionMode,
  PermissionRule,
} from './types';
export * from './policy';
export * from './types';

type ApprovalTelemetryMode = 'manual' | 'yolo' | 'afk' | 'auto_session' | 'cancelled';

export interface PermissionManagerOptions {
  readonly initialRules?: readonly PermissionRule[] | undefined;
  readonly policies?: readonly PermissionPolicy[] | undefined;
  readonly parent?: PermissionManager | undefined;
}

export class PermissionManager {
  rules: PermissionRule[] = [];
  private modeOverride: PermissionMode | undefined;
  private readonly parent: PermissionManager | undefined;
  private readonly sessionApprovedActions = new Set<string>();
  private readonly policies: readonly PermissionPolicy[];

  constructor(
    protected readonly agent: Agent,
    options: PermissionManagerOptions = {},
  ) {
    this.rules = [...(options.initialRules ?? [])];
    this.parent = options.parent;
    this.policies = options.policies ?? createPermissionDecisionPolicies(this.agent);
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
    if (this.sessionApprovedActions.has(record.action)) return;

    const pattern = actionToRulePattern(record.action, record.toolName);
    this.sessionApprovedActions.add(record.action);
    if (pattern === undefined) return;

    const rule: PermissionRule = {
      decision: 'allow',
      scope: 'session-runtime',
      pattern,
      reason: `approve_for_session: ${record.action}`,
    };
    if (!this.hasRule(rule)) {
      this.rules.push(rule);
    }
  }

  async beforeToolCall(
    context: ToolExecutionHookContext,
  ): Promise<PrepareToolExecutionResult | undefined> {
    const name = context.toolCall.function.name;
    const args = context.args;

    const mode = this.mode;
    const { decision, matchedRule } = this.checkPermission(name, args, mode);
    if (decision === 'deny') {
      return {
        block: true,
        reason: this.formatMessage(name, matchedRule?.reason),
      };
    }

    const policyResult = await this.evaluatePolicies(context, matchedRule);
    if (policyResult !== undefined) {
      return this.permissionPolicyResultToPrepare(policyResult, context);
    }

    if (mode === 'auto') {
      if (this.wouldAskInManualMode(name, args)) {
        this.trackToolApproved(name, 'afk');
      }
      return undefined;
    }
    if (mode === 'yolo') {
      if (this.wouldAskInManualMode(name, args)) {
        this.trackToolApproved(name, 'yolo');
      }
      return undefined;
    }

    if (decision === 'allow') {
      if (matchedRule?.scope === 'session-runtime') {
        this.trackToolApproved(name, 'auto_session', 'session');
      }
      return undefined;
    }

    // decision === 'ask' → bounce through ApprovalRuntime.
    return this.requestToolApproval(context);
  }

  private async requestToolApproval(
    context: ToolExecutionHookContext,
    options: {
      readonly action?: string | undefined;
      readonly display?: ToolInputDisplay | undefined;
    } = {},
  ): Promise<PrepareToolExecutionResult | undefined> {
    const { signal } = context;
    const id = context.toolCall.id;
    const name = context.toolCall.function.name;
    const args = context.args;
    const display =
      options.display ?? ({
        kind: 'generic',
        summary: `Approve ${name}`,
        detail: args,
      } satisfies ToolInputDisplay);
    const action = options.action ?? describeApprovalAction(name, args, display);
    if (this.sessionApprovedActions.has(action)) {
      this.trackToolApproved(name, 'auto_session', 'session');
      return undefined;
    }

    const result = await this.agent.rpc.requestApproval(
      {
        turnId: Number(context.turnId),
        toolCallId: id,
        toolName: name,
        action,
        display,
      },
      { signal },
    );
    this.recordApprovalResult({
      turnId: Number(context.turnId),
      toolCallId: id,
      toolName: name,
      action,
      result,
    });

    if (result.decision === 'approved') {
      this.trackToolApproved(
        name,
        approvalTelemetryMode(this.mode),
        result.scope === 'session' ? 'session' : 'once',
      );
      return undefined;
    }

    this.agent.telemetry.track('tool_rejected', {
      tool_name: name,
      approval_mode:
        result.decision === 'cancelled' ? 'cancelled' : approvalTelemetryMode(this.mode),
      decision: result.decision,
      has_feedback: result.feedback !== undefined && result.feedback.length > 0,
    });

    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, result),
    };
  }

  private async evaluatePolicies(
    context: ToolExecutionHookContext,
    matchedRule: PermissionRule | undefined,
  ): Promise<PermissionPolicyResult | undefined> {
    for (const policy of this.policies) {
      const result = await policy.evaluate({
        ...context,
        matchedRule,
      });
      if (result !== undefined) return result;
    }
    return undefined;
  }

  private checkPermission(
    toolName: string,
    toolInput: unknown,
    mode: PermissionMode = this.mode,
  ): CheckRulesResult {
    const matched = this.checkMatchingPermissionRules(toolName, toolInput, mode);
    if (matched !== undefined) return matched;
    if (isDefaultAutoAllowTool(toolName)) return { decision: 'allow' };
    if (mode === 'yolo' || mode === 'auto') return { decision: 'allow' };
    return { decision: 'ask' };
  }

  private checkMatchingPermissionRules(
    toolName: string,
    toolInput: unknown,
    mode: PermissionMode,
  ): CheckRulesResult | undefined {
    return (
      checkMatchingRules(this.rules, toolName, toolInput, mode, this.pathMatchOptions()) ??
      this.parent?.checkMatchingPermissionRules(toolName, toolInput, mode)
    );
  }

  private effectiveRules(): PermissionRule[] {
    return [...this.rules, ...(this.parent?.effectiveRules() ?? [])];
  }

  private wouldAskInManualMode(toolName: string, toolInput: unknown): boolean {
    return this.checkPermission(toolName, toolInput, 'manual').decision === 'ask';
  }

  private permissionPolicyResultToPrepare(
    result: PermissionPolicyResult,
    context: ToolExecutionHookContext,
  ): Promise<PrepareToolExecutionResult | undefined> | PrepareToolExecutionResult | undefined {
    switch (result.kind) {
      case 'allow':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'ask':
        return this.requestToolApproval(context, result);
      case 'result': {
        const { kind: _kind, ...prepareResult } = result;
        return prepareResult;
      }
    }
  }

  private hasRule(target: PermissionRule): boolean {
    return this.rules.some((rule) => {
      return (
        rule.decision === target.decision &&
        rule.scope === target.scope &&
        rule.pattern === target.pattern &&
        rule.reason === target.reason
      );
    });
  }

  protected formatMessage(toolName: string, reason?: string): string {
    const suffix = reason !== undefined && reason.length > 0 ? ` Reason: ${reason}` : '';
    if (this.agent.type === 'sub') {
      return `Tool "${toolName}" was denied.${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `Tool "${toolName}" was denied by permission rule.${suffix}`;
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

  private pathMatchOptions(): PermissionPathMatchOptions {
    return {
      cwd: this.agent.config.cwd,
      pathClass: this.agent.runtime.kaos.pathClass(),
      homeDir: this.agent.runtime.kaos.gethome(),
    };
  }

  private trackToolApproved(
    toolName: string,
    approvalMode: Exclude<ApprovalTelemetryMode, 'cancelled'>,
    scope?: 'once' | 'session',
  ): void {
    const properties: Record<string, TelemetryPropertyValue> = {
      tool_name: toolName,
      approval_mode: approvalMode,
    };
    if (scope !== undefined) {
      properties['scope'] = scope;
    }
    this.agent.telemetry.track('tool_approved', properties);
  }
}

function approvalTelemetryMode(
  mode: PermissionMode,
): Extract<ApprovalTelemetryMode, 'manual' | 'yolo' | 'afk'> {
  return mode === 'auto' ? 'afk' : mode;
}
