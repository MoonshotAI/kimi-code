import type { ToolBeforeDecision } from '@moonshot-ai/agent-core/agent-machine/tool';

import {
  isInteractionCancellation,
  type InteractionTags,
  type Interactions,
} from '#/features/interaction/index';

import type { ExitPlanModeOption } from './tools/exit-plan-mode';

export interface PlanReviewPayload {
  readonly plan: string;
  readonly path: string;
  readonly options?: readonly ExitPlanModeOption[];
}

export interface PlanApprovalResponse {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly selectedLabel?: string;
  readonly feedback?: string;
}

export async function requestExitPlanModeApproval(
  interactions: Interactions,
  plan: { exit(): Promise<void> },
  payload: PlanReviewPayload,
  tags: InteractionTags,
): Promise<ToolBeforeDecision> {
  const response = await interactions.request<PlanReviewPayload, PlanApprovalResponse>({
    kind: 'approval',
    payload,
    tags,
  });
  if (isInteractionCancellation(response) || response.decision === 'cancelled') {
    return deniedWith('Plan approval dismissed. Plan mode remains active.');
  }
  if (response.decision === 'approved') {
    const selected = selectedExitPlanModeOption(payload.options, response.selectedLabel);
    await plan.exit();
    const optionPrefix =
      selected === undefined
        ? ''
        : `Selected approach: ${selected.label}\nExecute ONLY the selected approach. Do not execute any unselected alternatives.\n\n`;
    return deniedWith(
      `Exited plan mode. ${optionPrefix}${formatPlanForOutput(payload.plan, payload.path)}`,
    );
  }
  if (response.selectedLabel === 'Reject and Exit') {
    await plan.exit();
    return deniedWith('Plan rejected by user. Plan mode deactivated.', true);
  }
  const feedback = response.feedback ?? '';
  if (response.selectedLabel === 'Revise' || feedback.length > 0) {
    return deniedWith(
      feedback.length > 0
        ? `User rejected the plan. Feedback:\n\n${feedback}`
        : 'User requested revisions. Plan mode remains active.',
    );
  }
  return deniedWith('Plan rejected by user. Plan mode remains active.', true);
}

export function formatPlanForOutput(plan: string, path: string | undefined): string {
  const savedTo = path !== undefined ? `Plan saved to: ${path}\n\n` : '';
  return `Plan mode deactivated. All tools are now available.\n${savedTo}## Approved Plan:\n${plan}`;
}

export function formatAutoApprovedPlanForOutput(plan: string, path: string | undefined): string {
  const savedTo = path !== undefined ? `Plan saved to: ${path}\n\n` : '';
  return `Plan mode deactivated. All tools are now available.\nNote: this plan was auto-approved without user review — the user has NOT explicitly approved it. Follow the user's original instructions on whether to proceed with execution; if they asked you to stop, wait, or only summarize after planning, do not start executing.\n${savedTo}## Plan (auto-approved, not user-reviewed):\n${plan}`;
}

function deniedWith(text: string, stopTurn?: boolean): ToolBeforeDecision {
  return { type: 'denied', result: { content: [{ type: 'text', text }], stopTurn } };
}

function selectedExitPlanModeOption(
  options: readonly ExitPlanModeOption[] | undefined,
  label: string | undefined,
): ExitPlanModeOption | undefined {
  if (options === undefined || label === undefined) return undefined;
  return options.find((option) => option.label === label);
}
