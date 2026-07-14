import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from "#/_base/di/instantiation";
import { Disposable } from "#/_base/di/lifecycle";
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { abortable, isUserCancellation } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import { IAgentPermissionPolicyService } from '#/agent/permissionPolicy/permissionPolicy';
import type {
  ApprovalRequest,
  ApprovalResponse,
  PermissionData,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type {
  AuthorizeToolExecutionResult,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionApprovalService } from "#/session/approval/approval";
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ToolInputDisplay } from '@moonshot-ai/protocol';
import {
  IAgentPermissionGate,
} from './permissionGate';

export type PermissionApprovalRequestContext = ApprovalRequest & {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId: number;
  readonly toolInput: unknown;
};

export type PermissionApprovalResultContext = PermissionApprovalRequestContext &
  (
    | ApprovalResponse
    | {
        readonly decision: 'error';
        readonly error: string;
      }
  );

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'permission.approval.requested': PermissionApprovalRequestContext;
    'permission.approval.resolved': PermissionApprovalResultContext;
  }
}

export class AgentPermissionGate extends Disposable implements IAgentPermissionGate {
  declare readonly _serviceBrand: undefined;
  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @IAgentPermissionPolicyService private readonly policyService: IAgentPermissionPolicyService,
    @ISessionContext private readonly session: ISessionContext,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    toolExecutor.hooks.onBeforeExecuteTool.register('permission', async (ctx, next) => {
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
    this.telemetry.track2('permission_policy_decision', {
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
    const approvalRequest = {
      sessionId: this.session.sessionId,
      agentId: this.scopeContext.agentId,
      turnId: context.turnId,
      toolCallId: context.toolCall.id,
      toolName: name,
      action,
      display,
    };
    const approvalContext = {
      ...approvalRequest,
      toolInput: context.args,
    } satisfies PermissionApprovalRequestContext;
    const startedAt = Date.now();

    let response: ApprovalResponse;
    const approvalService = this.tryApprovalService();
    if (approvalService === undefined) {
      response = { decision: 'approved' };
    } else {
      this.eventBus.publish({ type: 'permission.approval.requested', ...approvalContext });
      try {
        response = await abortable(
          approvalService.request(approvalRequest),
          context.signal,
        );
        context.signal.throwIfAborted();
      } catch (error) {
        if (isUserCancellation(error)) throw error;
        this.telemetry.track2('permission_approval_result', {
          policy_name: policyName ?? null,
          tool_name: name,
          permission_mode: this.modeService.mode,
          result: 'error',
          approval_surface: display.kind,
          duration_ms: Date.now() - startedAt,
          session_cache_written: false,
          has_feedback: false,
        });
        this.eventBus.publish({
          type: 'permission.approval.resolved',
          ...approvalContext,
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
      this.eventBus.publish({
        type: 'permission.approval.resolved',
        ...approvalContext,
        ...response,
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
    this.telemetry.track2('permission_approval_result', {
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
    if (this.usesWorkerRejectionGuidance()) {
      return `${prefix}${suffix} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return `${prefix}${suffix}`;
  }

  private formatDenyMessage(message: string): string {
    if (this.usesWorkerRejectionGuidance()) {
      return `${message} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return message;
  }

  private usesWorkerRejectionGuidance(): boolean {
    return this.scopeContext.agentId !== 'main';
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentPermissionGate,
  AgentPermissionGate,
  InstantiationType.Delayed,
  'permissionGate',
);
