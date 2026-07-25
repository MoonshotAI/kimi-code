/**
 * `toolApproval` domain (L3) — `IAgentToolApprovalService` implementation.
 *
 * Owns the approval round-trip extracted from `permissionGate`: publishes
 * `permission.approval.requested/resolved` through `eventBus`, awaits the
 * `session/approval` broker (absent broker = auto-approve), records
 * session-scope approval rules through `permissionRules`, reports
 * `permission_approval_result` through `telemetry`, and folds ask
 * continuations back into authorize results. Bound at Agent scope.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { IInstantiationService } from '#/_base/di/instantiation';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { abortable, isUserCancellation } from '#/_base/utils/abort';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type {
  ApprovalRequest,
  ApprovalResponse,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import { IAgentPermissionRulesService } from '#/agent/permissionRules/permissionRules';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { denyToolExecution } from '#/agent/toolExecutor/beforeToolExecuteEvent';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import { IEventBus } from '#/app/event/eventBus';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { ISessionApprovalService } from '#/session/approval/approval';
import { ISessionContext } from '#/session/sessionContext/sessionContext';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import { IAgentToolApprovalService } from './toolApproval';

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

export class AgentToolApprovalService extends Disposable implements IAgentToolApprovalService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @IAgentPermissionRulesService private readonly rulesService: IAgentPermissionRulesService,
    @ISessionContext private readonly session: ISessionContext,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
  }

  async resolvePermissionResolution(
    result: PermissionPolicyResolution,
    context: ResolvedToolExecutionHookContext,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined> {
    switch (result.kind) {
      case 'approve':
        return result.executionMetadata === undefined
          ? undefined
          : { executionMetadata: result.executionMetadata };
      case 'deny':
        return {
          veto: denyToolExecution(
            this.formatDenyMessage(
              result.message ?? `Tool "${context.toolCall.name}" was denied by permission policy.`,
            ),
          ),
        };
      case 'ask':
        return this.requestToolApproval(context, result, origin);
      case 'result':
        return { veto: result.result };
    }
  }

  async requestToolApproval(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined> {
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
          turn_id: context.turnId,
          tool_call_id: context.toolCall.id,
          policy_name: origin,
          tool_name: name,
          permission_mode: this.modeService.mode,
          result: 'error',
          approval_surface: display.kind,
          duration_ms: Date.now() - startedAt,
          session_cache_written: false,
          has_feedback: false,
          trace_id: context.trace?.traceId,
        });
        this.eventBus.publish({
          type: 'permission.approval.resolved',
          ...approvalContext,
          decision: 'error',
          error: error instanceof Error ? error.message : String(error),
        });
        const resolved = result.resolveError?.(error);
        if (resolved !== undefined) {
          return this.resolvePermissionResolution(resolved, context, origin);
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
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      policy_name: origin,
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
      trace_id: context.trace?.traceId,
    });

    const resolved = result.resolveApproval?.(response);
    if (resolved !== undefined) {
      return this.resolvePermissionResolution(resolved, context, origin);
    }

    if (response.decision === 'approved') return undefined;
    return {
      veto: denyToolExecution(this.formatApprovalRejectionMessage(name, response)),
    };
  }

  formatApprovalRejectionMessage(
    toolName: string,
    result: Pick<ApprovalResponse, 'decision' | 'feedback'>,
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

  formatDenyMessage(message: string): string {
    if (this.usesWorkerRejectionGuidance()) {
      return `${message} Try a different approach — don't retry the same call, don't attempt to bypass the restriction.`;
    }
    return message;
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

  private usesWorkerRejectionGuidance(): boolean {
    return this.scopeContext.agentId !== 'main';
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolApprovalService,
  AgentToolApprovalService,
  InstantiationType.Eager,
  'toolApproval',
);
