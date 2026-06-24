import type { ApprovalResponse } from '../../../../agent/permission';
import type { ResolvedToolExecutionHookContext } from '../../../../loop';
import { IPermissionModeService } from '../../permissionMode/permissionMode';
import { ITelemetryService } from '../../telemetry/telemetry';
import type {
  PermissionPolicy,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '../permissionPolicy';
import type { PermissionPolicyRuntime } from './runtime';

interface PlanReviewOption {
  readonly label: string;
  readonly description: string;
}

interface PlanReviewDisplay {
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly PlanReviewOption[] | undefined;
}

export class ExitPlanModeReviewAskPermissionPolicyService implements PermissionPolicy {
  readonly name = 'exit-plan-mode-review-ask';

  constructor(
    private readonly runtime: PermissionPolicyRuntime,
    @IPermissionModeService private readonly modeService: IPermissionModeService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  evaluate(context: ResolvedToolExecutionHookContext): PermissionPolicyResult | undefined {
    if (context.toolCall.name !== 'ExitPlanMode') return undefined;
    if (this.modeService.mode === 'auto') return undefined;
    if (!this.runtime.planModeActive()) return undefined;
    const display = context.execution.display;
    if (display?.kind !== 'plan_review') return undefined;
    if (display.plan.trim().length === 0) return undefined;
    this.trackPlanTelemetry('plan_submitted', {
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

  private exitPlanModeApprovalResult(
    result: ApprovalResponse,
    display: PlanReviewDisplay,
  ): PermissionPolicyResolution | undefined {
    if (result.decision !== 'approved') {
      return this.rejectedExitPlanModeApprovalResult(result);
    }

    const selected = selectedExitPlanModeOption(display.options, result.selectedLabel);
    const failed = this.runtime.exitPlanMode();
    if (failed !== undefined) {
      return { kind: 'result', syntheticResult: failed };
    }

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
      syntheticResult: {
        isError: false,
        output: `Exited plan mode. ${optionPrefix}${formattedPlan}`,
      },
    };
  }

  private rejectedExitPlanModeApprovalResult(
    result: ApprovalResponse,
  ): PermissionPolicyResolution {
    this.trackRejectedPlanResolution(result);

    if (result.decision === 'cancelled') {
      return {
        kind: 'result',
        syntheticResult: {
          isError: false,
          output: 'Plan approval dismissed. Plan mode remains active.',
        },
      };
    }

    if (result.selectedLabel === 'Reject and Exit') {
      const failed = this.runtime.exitPlanMode();
      return {
        kind: 'result',
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
        kind: 'result',
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
      kind: 'result',
      syntheticResult: {
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

  private trackPlanTelemetry(
    event: 'plan_submitted' | 'plan_resolved',
    properties: Record<string, string | number | boolean | undefined>,
  ): void {
    this.telemetry.track(event, properties);
  }
}

function selectedExitPlanModeOption(
  options: readonly PlanReviewOption[] | undefined,
  label: string | undefined,
): PlanReviewOption | undefined {
  if (options === undefined || label === undefined) return undefined;
  return options.find((option) => option.label === label);
}
