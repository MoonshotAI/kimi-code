import { IAgentPlanService, type IAgentPlanService as AgentPlanService } from '#/agent/plan/plan';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import { IAgentPermissionModeService } from '#/agent/permissionMode/permissionMode';
import type { PlanResolvedEvent, PlanSubmittedEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type {
  PermissionPolicy,
  PermissionPolicyResolution,
  PermissionPolicyResult,
  ApprovalResponse,
} from '#/agent/permissionPolicy/types';

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
    @IAgentPlanService private readonly plan: AgentPlanService,
    @IAgentPermissionModeService private readonly modeService: IAgentPermissionModeService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {}

  async evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyResult | undefined> {
    if (context.toolCall.name !== 'ExitPlanMode') return undefined;
    if (this.modeService.mode === 'auto') return undefined;
    if (await this.plan.status() === null) return undefined;
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
      this.plan.exit();
      return {
        kind: 'result',
        syntheticResult: {
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
