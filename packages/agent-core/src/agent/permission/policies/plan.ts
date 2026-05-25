import type { Agent } from '../..';
import type { ExecutableToolResult } from '../../../loop';
import type { PermissionPolicy, PermissionPolicyContext, PermissionPolicyResult } from '../policy';
import type { ApprovalResponse } from '../types';
import { readStringField } from './utils';

interface ExitPlanModeOption {
  readonly label: string;
  readonly description: string;
}

interface ExitPlanModeExecutionMetadata {
  readonly selectedOption?: ExitPlanModeOption | undefined;
  readonly planTelemetrySubmitted: true;
  readonly planTelemetryResolved: true;
}

export class EnterPlanModePermissionPolicy implements PermissionPolicy {
  readonly name = 'plan.enter-plan-mode';

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    if (context.toolCall.function.name !== 'EnterPlanMode') return undefined;
    return { kind: 'allow' };
  }
}

export class ExitPlanModePermissionPolicy implements PermissionPolicy {
  readonly name = 'plan.exit-plan-mode';

  constructor(private readonly agent: Agent) {}

  async evaluate(context: PermissionPolicyContext): Promise<PermissionPolicyResult | undefined> {
    const agent = this.agent;
    if (context.toolCall.function.name !== 'ExitPlanMode') return undefined;
    if (agent.permission.mode === 'auto') return { kind: 'allow' };

    const review = await resolveExitPlanModeReview(agent, context);
    if (review === null) return { kind: 'allow' };

    const action = exitPlanModeAction(review.options);
    agent.telemetry.track('plan_submitted', {
      has_options: review.options !== undefined,
    });
    let result: ApprovalResponse;
    try {
      result = await agent.rpc.requestApproval(
        {
          turnId: Number(context.turnId),
          toolCallId: context.toolCall.id,
          toolName: 'ExitPlanMode',
          action,
          display: {
            kind: 'plan_review',
            plan: review.plan,
            path: review.path,
            options: review.options,
          },
        },
        { signal: context.signal },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Plan approval failed.';
      return {
        kind: 'result',
        syntheticResult: {
          isError: true,
          output: `Plan approval failed: ${message}`,
        },
      };
    }

    agent.permission.recordApprovalResult({
      turnId: Number(context.turnId),
      toolCallId: context.toolCall.id,
      toolName: 'ExitPlanMode',
      action,
      result,
    });

    trackExitPlanModeResolution(agent, result);
    return exitPlanModeApprovalResult(agent, result, review.options);
  }
}

export class PlanModeGuardPermissionPolicy implements PermissionPolicy {
  readonly name = 'plan.mode-guard';

  constructor(private readonly agent: Agent) {}

  evaluate(context: PermissionPolicyContext): PermissionPolicyResult | undefined {
    const agent = this.agent;
    if (!agent.planMode.isActive) return undefined;

    const name = context.toolCall.function.name;
    const args = context.args;

    if (name === 'Write' || name === 'Edit') {
      const path = readStringField(args, 'path');
      if (path === undefined) return undefined;
      const planFilePath = agent.planMode.planFilePath;
      if (planFilePath !== null && path === planFilePath) return { kind: 'allow' };
      return {
        kind: 'result',
        block: true,
        reason:
          `Plan mode is active. You may only write to the current plan file: ${planFilePath ?? '(no plan file selected yet)'}. ` +
          'Call ExitPlanMode to exit plan mode before editing other files.',
      };
    }

    if (name === 'TaskStop') {
      return {
        kind: 'result',
        block: true,
        reason:
          'TaskStop is not available in plan mode. ' +
          'Call ExitPlanMode to exit plan mode before stopping a background task.',
      };
    }

    return undefined;
  }
}

export function createPlanPermissionPolicies(agent: Agent): readonly PermissionPolicy[] {
  return [
    new EnterPlanModePermissionPolicy(),
    new ExitPlanModePermissionPolicy(agent),
    new PlanModeGuardPermissionPolicy(agent),
  ];
}

async function resolveExitPlanModeReview(agent: Agent, context: PermissionPolicyContext): Promise<{
  readonly plan: string;
  readonly path?: string | undefined;
  readonly options?: readonly ExitPlanModeOption[] | undefined;
} | null> {
  if (!agent.planMode.isActive) return null;

  let data: Awaited<ReturnType<Agent['planMode']['data']>>;
  try {
    data = await agent.planMode.data();
  } catch {
    return null;
  }
  if (data === null || data.content.trim().length === 0) return null;

  return {
    plan: data.content,
    path: data.path,
    options: exitPlanModeOptions(context.args),
  };
}

function exitPlanModeApprovalResult(
  agent: Agent,
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
      syntheticResult: {
        isError: false,
        output: 'Plan approval dismissed. Plan mode remains active.',
      },
    };
  }

  if (result.selectedLabel === 'Reject and Exit') {
    const failed = exitPlanModeForRejectedPlan(agent);
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

function exitPlanModeExecutionMetadata(
  selectedOption: ExitPlanModeOption | undefined,
): ExitPlanModeExecutionMetadata {
  return {
    selectedOption,
    planTelemetrySubmitted: true,
    planTelemetryResolved: true,
  };
}

function trackExitPlanModeResolution(agent: Agent, result: ApprovalResponse): void {
  const selectedLabel = result.selectedLabel ?? '';
  const normalizedSelectedLabel = normalizeOptionLabel(selectedLabel);
  const feedback = result.feedback ?? '';
  const hasFeedback = feedback.length > 0;

  if (result.decision === 'cancelled') {
    agent.telemetry.track('plan_resolved', { outcome: 'dismissed' });
    return;
  }

  if (result.decision === 'approved') {
    if (selectedLabel.length > 0) {
      agent.telemetry.track('plan_resolved', {
        outcome: 'approved',
        chosen_option: selectedLabel,
      });
      return;
    }
    agent.telemetry.track('plan_resolved', { outcome: 'approved' });
    return;
  }

  if (normalizedSelectedLabel === 'reject and exit') {
    agent.telemetry.track('plan_resolved', { outcome: 'rejected_and_exited' });
    return;
  }

  if (normalizedSelectedLabel === 'revise' || hasFeedback) {
    agent.telemetry.track('plan_resolved', {
      outcome: 'revise',
      has_feedback: hasFeedback,
    });
    return;
  }

  agent.telemetry.track('plan_resolved', { outcome: 'rejected' });
}

function exitPlanModeForRejectedPlan(agent: Agent): ExecutableToolResult | undefined {
  try {
    agent.planMode.exit();
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
