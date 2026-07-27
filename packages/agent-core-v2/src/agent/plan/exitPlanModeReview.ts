/**
 * `plan` domain (L3) — ExitPlanMode plan review.
 *
 * Owns the user-facing review that intercepts an `ExitPlanMode` call carrying
 * a non-empty `plan_review` display: emits `plan_submitted` / `plan_resolved`
 * through `telemetry`, drives the approval round-trip through `toolApproval`
 * (origin `exit-plan-mode-review-ask`, matching the legacy permission
 * policy's telemetry), and folds every approval outcome (approve with or
 * without a selected option, Revise with feedback, Reject and Exit, dismiss)
 * into a synthetic tool result, exiting plan mode through `plan` when the
 * outcome deactivates it. Consumed by `planService`'s plan-guard veto
 * listener through a cold `waitUntil` factory; the mode / plan-active gating
 * stays in the listener.
 */

import type {
  ApprovalResponse,
  PermissionPolicyResolution,
} from '#/agent/permissionPolicy/types';
import type { IAgentToolApprovalService } from '#/agent/toolApproval/toolApproval';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';
import type { PlanResolvedEvent, PlanSubmittedEvent } from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

import type { IAgentPlanService } from './plan';

type PlanReviewDisplay = Extract<ToolInputDisplay, { kind: 'plan_review' }>;
type PlanReviewOption = NonNullable<PlanReviewDisplay['options']>[number];

export class ExitPlanModeReview {
  constructor(
    private readonly plan: IAgentPlanService,
    private readonly toolApproval: IAgentToolApprovalService,
    private readonly telemetry: ITelemetryService,
  ) {}

  async requestApproval(
    context: ResolvedToolExecutionHookContext,
  ): Promise<BeforeExecuteDecision | undefined> {
    const display = context.execution.display;
    if (display?.kind !== 'plan_review') return undefined;
    if (display.plan.trim().length === 0) return undefined;
    this.trackPlanTelemetry('plan_submitted', {
      has_options: display.options !== undefined && display.options.length >= 2,
    });
    return this.toolApproval.requestToolApproval(
      context,
      {
        kind: 'ask',
        reason: {
          has_options: display.options !== undefined,
        },
        resolveApproval: (result) => this.approvalResult(result, display),
      },
      'exit-plan-mode-review-ask',
    );
  }

  private approvalResult(
    result: ApprovalResponse,
    display: PlanReviewDisplay,
  ): PermissionPolicyResolution | undefined {
    if (result.decision !== 'approved') {
      return this.rejectedApprovalResult(result);
    }

    const selected = selectedExitPlanModeOption(display.options, result.selectedLabel);
    this.plan.exit();

    if (result.selectedLabel !== undefined && result.selectedLabel.length > 0) {
      this.trackPlanTelemetry('plan_resolved', {
        outcome: 'approved',
        chosen_option: result.selectedLabel,
      });
    } else {
      this.trackPlanTelemetry('plan_resolved', { outcome: 'approved' });
    }

    const optionPrefix =
      selected === undefined
        ? ''
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    const savedTo = display.path !== undefined ? `Plan saved to: ${display.path}\n\n` : '';
    const formattedPlan = `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${display.plan}`;
    return {
      kind: 'result',
      result: {
        isError: false,
        output: `Exited plan mode. ${optionPrefix}${formattedPlan}`,
      },
    };
  }

  private rejectedApprovalResult(result: ApprovalResponse): PermissionPolicyResolution {
    this.trackRejectedPlanResolution(result);

    if (result.decision === 'cancelled') {
      return {
        kind: 'result',
        result: {
          isError: false,
          output: 'Plan approval dismissed. Plan mode remains active.',
        },
      };
    }

    if (result.selectedLabel === 'Reject and Exit') {
      this.plan.exit();
      return {
        kind: 'result',
        result: {
          isError: true,
          stopTurn: true,
          output: 'Plan rejected by user. Plan mode deactivated.',
        },
      };
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      return {
        kind: 'result',
        result: {
          isError: false,
          output:
            feedback.length > 0
              ? `User rejected the plan. Feedback:\n\n${feedback}`
              : 'User requested revisions. Plan mode remains active.',
        },
      };
    }

    return {
      kind: 'result',
      result: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    };
  }

  private trackRejectedPlanResolution(result: ApprovalResponse): void {
    if (result.decision === 'cancelled') {
      this.trackPlanTelemetry('plan_resolved', { outcome: 'dismissed' });
      return;
    }

    if (result.selectedLabel === 'Reject and Exit') {
      this.trackPlanTelemetry('plan_resolved', { outcome: 'rejected_and_exited' });
      return;
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      this.trackPlanTelemetry('plan_resolved', {
        outcome: 'revise',
        has_feedback: feedback.length > 0,
      });
      return;
    }

    this.trackPlanTelemetry('plan_resolved', { outcome: 'rejected' });
  }

  private trackPlanTelemetry(event: 'plan_submitted', properties: PlanSubmittedEvent): void;
  private trackPlanTelemetry(event: 'plan_resolved', properties: PlanResolvedEvent): void;
  private trackPlanTelemetry(
    event: 'plan_submitted' | 'plan_resolved',
    properties: PlanSubmittedEvent | PlanResolvedEvent,
  ): void {
    if (event === 'plan_submitted') {
      this.telemetry.track2('plan_submitted', properties as PlanSubmittedEvent);
    } else {
      this.telemetry.track2('plan_resolved', properties as PlanResolvedEvent);
    }
  }
}

function selectedExitPlanModeOption(
  options: readonly PlanReviewOption[] | undefined,
  label: string | undefined,
): PlanReviewOption | undefined {
  if (options === undefined || label === undefined) return undefined;
  return options.find((option) => option.label === label);
}
