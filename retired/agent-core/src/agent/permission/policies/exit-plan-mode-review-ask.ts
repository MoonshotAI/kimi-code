import type { Agent } from '../..';
import type { ApprovalResponse, PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

interface ExitPlanModeOption {
  readonly label: string;
  readonly description: string;
}

interface PlanReviewDisplay {
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly ExitPlanModeOption[] | undefined;
}

export class ExitPlanModeReviewAskPermissionPolicy implements PermissionPolicy {
  readonly name = 'exit-plan-mode-review-ask';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'ExitPlanMode') return;
    if (this.agent.permission.mode === 'auto') return;
    if (!this.agent.planMode.isActive) return;
    const display = context.execution.display;
    if (display?.kind !== 'plan_review') return;
    if (display.plan.trim().length === 0) return;
    this.agent.telemetry.track('plan_submitted', {
      has_options: display.options !== undefined && display.options.length >= 2,
    });
    return {
      kind: 'ask',
      reason: {
        has_options: display.options !== undefined,
      },
      resolveApproval: (result) =>
        this.exitPlanModeApprovalResult(result, {
          plan: display.plan,
          path: display.path,
          options: display.options,
        }),
    };
  }

  private exitPlanModeApprovalResult(result: ApprovalResponse, display: PlanReviewDisplay) {
    if (result.decision !== 'approved') {
      return this.rejectedExitPlanModeApprovalResult(result);
    }

    const selected = selectedExitPlanModeOption(display.options, result.selectedLabel);

    const failed = this.exitPlanMode();
    if (failed !== undefined) {
      return { kind: 'result' as const, syntheticResult: failed };
    }

    if (result.selectedLabel !== undefined && result.selectedLabel.length > 0) {
      this.agent.telemetry.track('plan_resolved', {
        outcome: 'approved',
        chosen_option: result.selectedLabel,
      });
    } else {
      this.agent.telemetry.track('plan_resolved', { outcome: 'approved' });
    }

    const optionPrefix =
      selected === undefined
        ? ''
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    const savedTo = display.path !== undefined ? `Plan saved to: ${display.path}\n\n` : '';
    const formattedPlan = `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${display.plan}`;
    return {
      kind: 'result' as const,
      syntheticResult: {
        isError: false,
        output: `Exited plan mode. ${optionPrefix}${formattedPlan}`,
      },
    };
  }

  private rejectedExitPlanModeApprovalResult(result: ApprovalResponse) {
    this.trackRejectedPlanResolution(result);

    if (result.decision === 'cancelled') {
      return {
        kind: 'result' as const,
        syntheticResult: {
          isError: false,
          output: 'Plan approval dismissed. Plan mode remains active.',
        },
      };
    }

    if (result.selectedLabel === 'Reject and Exit') {
      const failed = this.exitPlanMode();
      return {
        kind: 'result' as const,
        syntheticResult:
          failed ?? {
            isError: true,
            stopTurn: true,
            output: 'Plan rejected by user. Plan mode deactivated.',
          },
      };
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      return {
        kind: 'result' as const,
        syntheticResult: {
          isError: false,
          output:
            feedback.length > 0
              ? `User rejected the plan. Feedback:\n\n${feedback}`
              : 'User requested revisions. Plan mode remains active.',
        },
      };
    }

    return {
      kind: 'result' as const,
      syntheticResult: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    };
  }

  private exitPlanMode(): { isError: true; output: string } | undefined {
    try {
      this.agent.planMode.exit();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
      return {
        isError: true,
        output: `Failed to exit plan mode: ${message}`,
      };
    }
  }

  private trackRejectedPlanResolution(result: ApprovalResponse): void {
    if (result.decision === 'cancelled') {
      this.agent.telemetry.track('plan_resolved', { outcome: 'dismissed' });
      return;
    }

    if (result.selectedLabel === 'Reject and Exit') {
      this.agent.telemetry.track('plan_resolved', { outcome: 'rejected_and_exited' });
      return;
    }

    const feedback = result.feedback ?? '';
    if (result.selectedLabel === 'Revise' || feedback.length > 0) {
      this.agent.telemetry.track('plan_resolved', {
        outcome: 'revise',
        has_feedback: feedback.length > 0,
      });
      return;
    }

    this.agent.telemetry.track('plan_resolved', { outcome: 'rejected' });
  }
}

function selectedExitPlanModeOption(
  options: readonly ExitPlanModeOption[] | undefined,
  label: string | undefined,
): ExitPlanModeOption | undefined {
  if (options === undefined || label === undefined) return;
  return options.find((option) => option.label === label);
}
