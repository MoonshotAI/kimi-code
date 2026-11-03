import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IFlagService } from '#/app/flag/flag';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PermissionPolicy, PermissionPolicyResult } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

import { AUTO_REVIEW_FLAG_ID } from './flag';
import { IAutoReviewService } from './review';

const EXEMPT_TOOLS = new Set([
  'Read',
  'ReadMediaFile',
  'Grep',
  'Glob',
  'List',
  'TodoRead',
  'TodoList',
  'TaskList',
  'TaskOutput',
  'CronList',
  'GetGoal',
]);

export class AutoReviewPermissionPolicyService implements PermissionPolicy {
  readonly name = 'auto-review';

  constructor(
    @IFlagService private readonly flags: IFlagService,
    @IAgentPermissionModeService private readonly modes: IAgentPermissionModeService,
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IAutoReviewService private readonly reviewService: IAutoReviewService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async evaluate(context: ResolvedToolExecutionHookContext): Promise<PermissionPolicyResult | undefined> {
    if (!this.flags.enabled(AUTO_REVIEW_FLAG_ID) || this.modes.mode !== 'auto') return undefined;
    if (EXEMPT_TOOLS.has(context.toolCall.name)) return undefined;
    const startedAt = Date.now();
    const result = await this.reviewService.review(context);
    if (result.kind === 'failed') {
      this.track(context, 'failed', startedAt);
      if (this.bootstrap.args.nonInteractive) {
        return {
          kind: 'deny',
          message: `Auto Review could not complete; the tool was not executed: ${result.reason} Resolve the review error or ask the user for guidance.`,
          reason: { review_error: true },
        };
      }
      return {
        kind: 'ask',
        reason: { review_error: true },
        resolveError: () => ({
          kind: 'deny',
          message: 'Auto Review and the fallback approval both failed; the tool was not executed.',
          reason: { review_error: true },
        }),
      };
    }
    const { decision } = result;
    this.track(context, decision.decision, startedAt, decision.risk);
    if (decision.decision === 'allow') {
      return { kind: 'approve', reason: { review_risk: decision.risk } };
    }
    const suffix = decision.reason === undefined ? '' : ` ${decision.reason}`;
    if (this.bootstrap.args.nonInteractive) {
      return {
        kind: 'deny',
        message: `Auto Review denied tool "${context.toolCall.name}"; it was not executed.${suffix} Do not retry the same action or bypass the review.`,
        reason: { review_risk: decision.risk },
      };
    }
    return {
      kind: 'ask',
      reason: { review_risk: decision.risk },
      resolveApproval: (response) => response.decision === 'approved'
        ? undefined
        : {
            kind: 'deny',
            message: `Tool "${context.toolCall.name}" was not run after Auto Review denial.${suffix}`,
          },
    };
  }

  private track(
    context: ResolvedToolExecutionHookContext,
    decision: 'allow' | 'deny' | 'failed',
    startedAt: number,
    risk?: 'low' | 'medium' | 'high',
  ): void {
    this.telemetry.track2<'auto_review_decision', {
      turn_id: number;
      tool_call_id: string;
      tool_name: string;
      decision: 'allow' | 'deny' | 'failed';
      risk?: 'low' | 'medium' | 'high';
      duration_ms: number;
    }>('auto_review_decision', {
      turn_id: context.turnId,
      tool_call_id: context.toolCall.id,
      tool_name: context.toolCall.name,
      decision,
      risk,
      duration_ms: Date.now() - startedAt,
    });
  }
}
