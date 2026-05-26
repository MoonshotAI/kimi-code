import type { ExecutableToolResult } from '../../../loop';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';
import type { ApprovalResponse } from '../types';

interface ExitPlanModeOption {
  readonly label: string;
  readonly description: string;
}

interface ExitPlanModeExecutionMetadata {
  readonly selectedOption?: ExitPlanModeOption | undefined;
  readonly planTelemetrySubmitted: true;
  readonly planTelemetryResolved: true;
}

export const EnterPlanModePermissionPolicy: PermissionPolicy = {
  name: 'plan.enter-plan-mode',
  evaluate({ toolCallContext }) {
    if (toolCallContext.toolCall.name !== 'EnterPlanMode') return undefined;
    return { kind: 'allow' };
  },
};

export const ExitPlanModePermissionPolicy: PermissionPolicy = {
  name: 'plan.exit-plan-mode',
  async evaluate(context) {
    if (context.toolCallContext.toolCall.name !== 'ExitPlanMode') return undefined;
    if (context.mode === 'auto') return { kind: 'allow' };

    const review = await resolveExitPlanModeReview(context);
    if (review === null) return { kind: 'allow' };

    const action = exitPlanModeAction(review.options);
    context.agent.telemetry.track('plan_submitted', {
      has_options: review.options !== undefined,
    });
    let result: ApprovalResponse;
    try {
      result = await context.agent.rpc.requestApproval(
        {
          turnId: Number(context.toolCallContext.turnId),
          toolCallId: context.toolCallContext.toolCall.id,
          toolName: 'ExitPlanMode',
          action,
          display: {
            kind: 'plan_review',
            plan: review.plan,
            path: review.path,
            options: review.options,
          },
        },
        { signal: context.toolCallContext.signal },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Plan approval failed.';
      return {
        kind: 'result',
        result: {
          syntheticResult: {
            isError: true,
            output: `Plan approval failed: ${message}`,
          },
        },
      };
    }

    context.recordApprovalResult({
      turnId: Number(context.toolCallContext.turnId),
      toolCallId: context.toolCallContext.toolCall.id,
      toolName: 'ExitPlanMode',
      action,
      result,
    });

    trackExitPlanModeResolution(context, result);
    return exitPlanModeApprovalResult(context, result, review.options);
  },
};

export const PlanModeGuardPermissionPolicy: PermissionPolicy = {
  name: 'plan.mode-guard',
  evaluate({ agent, toolCallContext }) {
    if (!agent.planMode.isActive) return undefined;

    const name = toolCallContext.toolCall.name;
    const args = toolCallContext.args;

    if (name === 'Write' || name === 'Edit') {
      const path = readStringField(args, 'path');
      if (path === undefined) return undefined;
      const planFilePath = agent.planMode.planFilePath;
      if (planFilePath !== null && path === planFilePath) return { kind: 'allow' };
      return {
        kind: 'result',
        result: {
          block: true,
          reason:
            `Plan mode is active. You may only write to the current plan file: ${planFilePath ?? '(no plan file selected yet)'}. ` +
            'Call ExitPlanMode to exit plan mode before editing other files.',
        },
      };
    }

    if (name === 'TaskStop') {
      return {
        kind: 'result',
        result: {
          block: true,
          reason:
            'TaskStop is not available in plan mode. ' +
            'Call ExitPlanMode to exit plan mode before stopping a background task.',
        },
      };
    }

    return undefined;
  },
};

export function createPlanPermissionPolicies(): readonly PermissionPolicy[] {
  return [
    EnterPlanModePermissionPolicy,
    ExitPlanModePermissionPolicy,
    PlanModeGuardPermissionPolicy,
  ];
}

async function resolveExitPlanModeReview(context: PermissionPolicyContext): Promise<{
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly ExitPlanModeOption[] | undefined;
} | null> {
  if (!context.agent.planMode.isActive) return null;

  let data: Awaited<ReturnType<PermissionPolicyContext['agent']['planMode']['data']>>;
  try {
    data = await context.agent.planMode.data();
  } catch {
    return null;
  }
  if (data === null || data.content.trim().length === 0) return null;

  return {
    plan: data.content,
    path: data.path,
    options: exitPlanModeOptions(context.toolCallContext.args),
  };
}

function exitPlanModeApprovalResult(
  context: PermissionPolicyContext,
  result: ApprovalResponse,
  options: readonly ExitPlanModeOption[] | undefined,
): PermissionPolicyResult {
  if (result.decision === 'approved') {
    const selected = selectedExitPlanModeOption(options, result.selectedLabel);
    return {
      kind: 'allow',
      executionMetadata: exitPlanModeExecutionMetadata(selected),
    };
  }

  if (result.decision === 'cancelled') {
    return {
      kind: 'result',
      result: {
        syntheticResult: {
          isError: false,
          output: 'Plan approval dismissed. Plan mode remains active.',
        },
      },
    };
  }

  if (result.selectedLabel === 'Reject and Exit') {
    const failed = exitPlanModeForRejectedPlan(context);
    return {
      kind: 'result',
      result: {
        syntheticResult:
          failed ?? {
            isError: true,
            stopTurn: true,
            output: 'Plan rejected by user. Plan mode deactivated.',
          },
      },
    };
  }

  const feedback = result.feedback ?? '';
  if (result.selectedLabel === 'Revise' || feedback.length > 0) {
    return {
      kind: 'result',
      result: {
        syntheticResult: {
          isError: false,
          output:
            feedback.length > 0
              ? `User rejected the plan. Feedback:\n\n${feedback}`
              : 'User requested revisions. Plan mode remains active.',
        },
      },
    };
  }

  return {
    kind: 'result',
    result: {
      syntheticResult: {
        isError: true,
        stopTurn: true,
        output: 'Plan rejected by user. Plan mode remains active.',
      },
    },
  };
}

function exitPlanModeExecutionMetadata(
  selectedOption: ExitPlanModeOption | undefined,
): ExitPlanModeExecutionMetadata {
  return {
    selectedOption,
    planTelemetrySubmitted: true,
    planTelemetryResolved: true,
  };
}

function trackExitPlanModeResolution(
  context: PermissionPolicyContext,
  result: ApprovalResponse,
): void {
  const selectedLabel = result.selectedLabel ?? '';
  const normalizedSelectedLabel = normalizeOptionLabel(selectedLabel);
  const feedback = result.feedback ?? '';
  const hasFeedback = feedback.length > 0;

  if (result.decision === 'cancelled') {
    context.agent.telemetry.track('plan_resolved', { outcome: 'dismissed' });
    return;
  }

  if (result.decision === 'approved') {
    if (selectedLabel.length > 0) {
      context.agent.telemetry.track('plan_resolved', {
        outcome: 'approved',
        chosen_option: selectedLabel,
      });
      return;
    }
    context.agent.telemetry.track('plan_resolved', { outcome: 'approved' });
    return;
  }

  if (normalizedSelectedLabel === 'reject and exit') {
    context.agent.telemetry.track('plan_resolved', { outcome: 'rejected_and_exited' });
    return;
  }

  if (normalizedSelectedLabel === 'revise' || hasFeedback) {
    context.agent.telemetry.track('plan_resolved', {
      outcome: 'revise',
      has_feedback: hasFeedback,
    });
    return;
  }

  context.agent.telemetry.track('plan_resolved', { outcome: 'rejected' });
}

function exitPlanModeForRejectedPlan(
  context: PermissionPolicyContext,
): ExecutableToolResult | undefined {
  try {
    context.agent.planMode.exit();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Failed to exit plan mode.';
    return {
      isError: true,
      output: `Failed to exit plan mode: ${message}`,
    };
  }
}

function exitPlanModeOptions(args: unknown): readonly ExitPlanModeOption[] | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const options = (args as { readonly options?: unknown }).options;
  if (!Array.isArray(options) || options.length < 2) return undefined;
  const parsed: ExitPlanModeOption[] = [];
  for (const option of options) {
    if (option === null || typeof option !== 'object') return undefined;
    const label = (option as { readonly label?: unknown }).label;
    if (typeof label !== 'string') return undefined;
    // `description` is optional in the ExitPlanMode schema (defaults to ''),
    // so an option that omits it is still valid.
    const description = (option as { readonly description?: unknown }).description;
    if (description !== undefined && typeof description !== 'string') return undefined;
    parsed.push({ label, description: description ?? '' });
  }
  return parsed;
}

function selectedExitPlanModeOption(
  options: readonly ExitPlanModeOption[] | undefined,
  label: string | undefined,
): ExitPlanModeOption | undefined {
  if (options === undefined || label === undefined) return undefined;
  return options.find((option) => option.label === label);
}

function exitPlanModeAction(options: readonly ExitPlanModeOption[] | undefined): string {
  return options !== undefined && options.length >= 2
    ? 'Review plan and choose an option'
    : 'Review plan';
}

function normalizeOptionLabel(label: string): string {
  return label.trim().toLowerCase();
}

function readStringField(args: unknown, key: string): string | undefined {
  if (args === null || typeof args !== 'object') return undefined;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}
