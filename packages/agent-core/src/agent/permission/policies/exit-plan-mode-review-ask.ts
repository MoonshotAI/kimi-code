import type { Agent } from '../..';
import type { ApprovalResponse, PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../types';

interface ExitPlanModeOption {
  readonly label: string;
  readonly description: string;
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
    return {
      kind: 'ask',
      reason: {
        has_options: display.options !== undefined,
      },
      resolveApproval: (result) => this.exitPlanModeApprovalResult(result, display.options),
      resolveError: (error) => {
        const message = error instanceof Error ? error.message : 'Plan approval failed.';
        return {
          kind: 'result',
          syntheticResult: {
            isError: true,
            output: `Plan approval failed: ${message}`,
          },
        };
      },
    };
  }

  private exitPlanModeApprovalResult(
    result: ApprovalResponse,
    options: readonly ExitPlanModeOption[] | undefined,
  ) {
    const selected = selectedExitPlanModeOption(options, result.selectedLabel);
    if (result.decision !== 'approved') {
      return this.rejectedExitPlanModeApprovalResult(result);
    }

    return {
      kind: 'approve' as const,
      executionMetadata: {
        planApproval: approvalMetadata(result),
        selectedOption: selected,
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
      const failed = this.exitPlanModeForRejectedPlan();
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

  private exitPlanModeForRejectedPlan(): { isError: true; output: string } | undefined {
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

function approvalMetadata(result: ApprovalResponse) {
  return {
    decision: result.decision,
    selectedLabel: result.selectedLabel,
    feedback: result.feedback,
  };
}

function selectedExitPlanModeOption(
  options: readonly ExitPlanModeOption[] | undefined,
  label: string | undefined,
): ExitPlanModeOption | undefined {
  if (options === undefined || label === undefined) return;
  return options.find((option) => option.label === label);
}
