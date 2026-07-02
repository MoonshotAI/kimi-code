import type {
  ApprovalResponse,
  PermissionData,
} from '#/agent/permissionPolicy';
import {
  Disposable,
  IInstantiationService,
} from "#/_base/di";
import { abortable, isUserCancellation } from '#/_base/utils/abort';
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '#/agent/tool';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import { ISessionApprovalService } from "#/session/approval/approval";
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import { IAgentPermissionModeService } from '#/agent/permissionMode';
import {
  IAgentPermissionPolicyService,
  type PermissionPolicyResolution,
  type PermissionPolicyResult,
} from '#/agent/permissionPolicy';
import { IAgentPermissionRulesService } from '#/agent/permissionRules';
import { ISessionContext } from '#/session/session-context';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import {
  IAgentPermissionGate,
  type PermissionGateOptions,
} from './permissionGate';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';

export class AgentPermissionGate extends Disposable implements IAgentPermissionGate {
  declare readonly _serviceBrand: undefined;
  constructor(
    private readonly options: PermissionGateOptions = {},
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @IAgentPermissionPolicyService private readonly policyService: IAgentPermissionPolicyService,
    @IAgentExternalHooksService private readonly externalHooks: IAgentExternalHooksService,
    @ISessionContext private readonly session: ISessionContext,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    toolExecutor.hooks.onWillExecuteTool.register('permission', async (ctx, next) => {
      const result = await this.authorize(ctx);
      if (result !== undefined) {
        ctx.decision = result;
      }
      if (result?.block === true || result?.syntheticResult !== undefined) {
        return;
      }
      await next();
    });
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
          reason: this.formatDenyMessage(
            result.message ?? `Tool "${context.toolCall.name}" was denied by permission policy.`,
          ),
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
      this.externalHooks.triggerPermissionRequest({
        turnId: context.turnId,
        toolCallId: context.toolCall.id,
        toolName: name,
        action,
        toolInput: context.args,
        display,
      });
      try {
        response = await abortable(
          approvalService.request({
            sessionId: this.session.sessionId,
            agentId: this.options.agentId ?? 'main',
            turnId: context.turnId,
            toolCallId: context.toolCall.id,
            toolName: name,
            action,
            display,
          }),
          context.signal,
        );
        context.signal.throwIfAborted();
      } catch (error) {
        if (isUserCancellation(error)) throw error;
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
        this.externalHooks.triggerPermissionResult({
          turnId: context.turnId,
          toolCallId: context.toolCall.id,
          toolName: name,
          action,
          decision: 'error',
          error: error instanceof Error ? error.message : String(error),
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
    if (approvalService !== undefined) {
      this.externalHooks.triggerPermissionResult({
        turnId: context.turnId,
        toolCallId: context.toolCall.id,
        toolName: name,
        action,
        decision: response.decision,
        scope: response.scope,
        feedback: response.feedback,
        selectedLabel: response.selectedLabel,
      });
    }
    this.rulesService.recordApprovalResult({
      turnId: context.turnId,
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

  private tryApprovalService(): ISessionApprovalService | undefined {
    try {
      return this.instantiation.invokeFunction(
        (accessor) => accessor.get(ISessionApprovalService) as ISessionApprovalService | undefined,
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
    if (this.isSubagent()) {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatDenyMessage(message: string): string {
    if (this.isSubagent()) {
      return `${message} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return message;
  }

  private isSubagent(): boolean {
    return this.options.agentId !== undefined && this.options.agentId !== 'main';
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  InstantiationType.Delayed,
  'permissionGate',
);
