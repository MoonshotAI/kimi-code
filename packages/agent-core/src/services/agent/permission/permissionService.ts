import type {
  ApprovalResponse,
  PermissionData,
} from '../../../agent/permission';
import {
  Disposable,
  IInstantiationService,
  registerSingleton,
  SyncDescriptor,
} from '../../../di';
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '../../../loop';
import type { ToolInputDisplay } from '../../../tools/display';
import { IApprovalService } from '../../approval/approval';
import { IPermissionModeService } from '../permissionMode/permissionMode';
import {
  IPermissionPolicyService,
  type PermissionPolicyResolution,
  type PermissionPolicyResult,
} from '../permissionPolicy/permissionPolicy';
import { IPermissionRulesService } from '../permissionRules/permissionRules';
import { ITelemetryService } from '../telemetry/telemetry';
import {
  IPermissionService,
  type PermissionServiceOptions,
} from './permission';

export class PermissionService extends Disposable implements IPermissionService {
  constructor(
    private readonly options: PermissionServiceOptions = {},
    @IPermissionModeService private readonly modeService: IPermissionModeService,
    @IPermissionRulesService private readonly rulesService: IPermissionRulesService,
    @IPermissionPolicyService private readonly policyService: IPermissionPolicyService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    super();
    this.policyService.configure(options);
    if (options.initialMode !== undefined) {
      this.modeService.setMode(options.initialMode, { track: false });
    }
  }

  data(): PermissionData {
    return {
      mode: this.modeService.mode,
      rules: [...this.rulesService.rules],
    };
  }

  async authorize(
    context: ResolvedToolExecutionHookContext,
  ): Promise<AuthorizeToolExecutionResult | undefined> {
    const evaluation = await this.policyService.evaluate(context);
    if (evaluation === undefined) return undefined;
    this.telemetry.track('permission_policy_decision', {
      policy_name: evaluation.policyName,
      tool_name: context.toolCall.name,
      permission_mode: this.modeService.mode,
      decision: evaluation.result.kind,
      ...evaluation.result.reason,
    });
    return this.permissionPolicyResolutionToAuthorize(
      evaluation.result,
      context,
      evaluation.policyName,
    );
  }

  private async permissionPolicyResolutionToAuthorize(
    result: PermissionPolicyResolution,
    context: ResolvedToolExecutionHookContext,
    policyName?: string,
  ): Promise<AuthorizeToolExecutionResult | undefined> {
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
        const { kind: _kind, ...authorizeResult } = result;
        return authorizeResult;
      }
    }
  }

  private async requestToolApproval(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    policyName: string | undefined,
  ): Promise<AuthorizeToolExecutionResult | undefined> {
    const name = context.toolCall.name;
    const action = context.execution.description ?? `Approve ${name}`;
    const display =
      context.execution.display ??
      ({
        kind: 'generic',
        summary: action,
        detail: context.args,
      } as ToolInputDisplay);
    const startedAt = Date.now();

    let response: ApprovalResponse;
    const approvalService = this.tryApprovalService();
    if (approvalService === undefined) {
      response = { decision: 'approved' };
    } else {
      try {
        response = await approvalService.request({
          sessionId: this.options.sessionId ?? 'service-session',
          agentId: this.options.agentId ?? 'main',
          turnId: numericTurnId(context.turnId),
          toolCallId: context.toolCall.id,
          toolName: name,
          action,
          display,
        });
        context.signal.throwIfAborted();
      } catch (error) {
        this.telemetry.track('permission_approval_result', {
          policy_name: policyName ?? null,
          tool_name: name,
          permission_mode: this.modeService.mode,
          result: 'error',
          approval_surface: display.kind,
          duration_ms: Date.now() - startedAt,
          session_cache_written: false,
          has_feedback: false,
        });
        const resolved = result.resolveError?.(error);
        if (resolved !== undefined) {
          return this.permissionPolicyResolutionToAuthorize(resolved, context, policyName);
        }
        throw error;
      }
    }

    const sessionApprovalRule =
      response.decision === 'approved' && response.scope === 'session'
        ? context.execution.approvalRule
        : undefined;
    this.rulesService.recordApprovalResult({
      turnId: numericTurnId(context.turnId),
      toolCallId: context.toolCall.id,
      toolName: name,
      action,
      sessionApprovalRule,
      result: response,
    });
    this.telemetry.track('permission_approval_result', {
      policy_name: policyName ?? null,
      tool_name: name,
      permission_mode: this.modeService.mode,
      result:
        response.decision === 'approved' && response.scope === 'session'
          ? 'approved_for_session'
          : response.decision,
      approval_surface: display.kind,
      duration_ms: Date.now() - startedAt,
      session_cache_written: sessionApprovalRule !== undefined,
      has_feedback: response.feedback !== undefined && response.feedback.length > 0,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.permissionPolicyResolutionToAuthorize(resolved, context, policyName);
    }

    if (response.decision === 'approved') return undefined;
    return {
      block: true,
      reason: this.formatApprovalRejectionMessage(name, response),
    };
  }

  private tryApprovalService(): IApprovalService | undefined {
    try {
      return this.instantiation.invokeFunction(
        (accessor) => accessor.get(IApprovalService) as IApprovalService | undefined,
      );
    } catch {
      return undefined;
    }
  }

  private formatApprovalRejectionMessage(
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
    if (this.options.agentType === 'sub') {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatPolicyDenyMessage(toolName: string): string {
    const prefix = `Tool "${toolName}" was denied by permission policy.`;
    if (this.options.agentType === 'sub') {
      return `${prefix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return prefix;
  }
}

function numericTurnId(turnId: string): number {
  const numeric = Number(turnId);
  return Number.isFinite(numeric) ? numeric : 0;
}

registerSingleton(
  IPermissionService,
  new SyncDescriptor(PermissionService, [{}], true),
);
