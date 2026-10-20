import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';

export const APPROVE_ONCE_OPTION_ID = 'approve_once';
export const APPROVE_ALWAYS_OPTION_ID = 'approve_always';
export const REJECT_OPTION_ID = 'reject';

export const PLAN_APPROVE_OPTION_ID = 'plan_approve';
export const PLAN_REVISE_OPTION_ID = 'plan_revise';
export const PLAN_REJECT_AND_EXIT_OPTION_ID = 'plan_reject_and_exit';

function planOptOptionId(i: number): string {
  return `plan_opt_${i}`;
}

export interface AcpApprovalDisplayOption {
  readonly label: string;
  readonly description?: string;
}

export interface AcpApprovalRequestView {
  readonly toolName: string;
  readonly action: string;
  readonly planReview?: {
    readonly plan: string;
    readonly path: string;
    readonly options?: readonly AcpApprovalDisplayOption[];
  };
  readonly args?: Record<string, unknown>;
}

export interface AcpApprovalResponse {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session';
  readonly selectedLabel?: string;
  readonly feedback?: string;
}

const CANONICAL_OPTIONS: readonly PermissionOption[] = [
  { optionId: APPROVE_ONCE_OPTION_ID, name: 'Approve once', kind: 'allow_once' },
  {
    optionId: APPROVE_ALWAYS_OPTION_ID,
    name: 'Approve for this session',
    kind: 'allow_always',
  },
  { optionId: REJECT_OPTION_ID, name: 'Reject', kind: 'reject_once' },
];

export function approvalRequestToPermissionOptions(
  req: AcpApprovalRequestView,
): readonly PermissionOption[] {
  const planReview = req.planReview;
  if (planReview === undefined) {
    return CANONICAL_OPTIONS;
  }
  const approveOptions: PermissionOption[] =
    planReview.options !== undefined && planReview.options.length >= 2
      ? planReview.options.map((opt, i) => ({
          optionId: planOptOptionId(i),
          name: opt.label,
          kind: 'allow_once' as const,
        }))
      : [{ optionId: PLAN_APPROVE_OPTION_ID, name: 'Approve', kind: 'allow_once' as const }];
  return [
    ...approveOptions,
    { optionId: PLAN_REVISE_OPTION_ID, name: 'Revise', kind: 'reject_once' as const },
    {
      optionId: PLAN_REJECT_AND_EXIT_OPTION_ID,
      name: 'Reject and Exit',
      kind: 'reject_once' as const,
    },
  ];
}

export function permissionResponseToApprovalResponse(
  req: AcpApprovalRequestView,
  response: RequestPermissionResponse,
): AcpApprovalResponse {
  if (response.outcome.outcome === 'cancelled') {
    return { decision: 'cancelled' };
  }
  const optionId = response.outcome.optionId;
  if (req.planReview !== undefined) {
    return mapPlanReviewOptionId(req.planReview.options, optionId);
  }
  switch (optionId) {
    case APPROVE_ONCE_OPTION_ID:
    case 'approve':
      return { decision: 'approved' };
    case APPROVE_ALWAYS_OPTION_ID:
    case 'approve_for_session':
      return { decision: 'approved', scope: 'session' };
    case REJECT_OPTION_ID:
      return { decision: 'rejected' };
    default:
      return { decision: 'rejected' };
  }
}

function mapPlanReviewOptionId(
  options: readonly AcpApprovalDisplayOption[] | undefined,
  optionId: string,
): AcpApprovalResponse {
  if (optionId === PLAN_APPROVE_OPTION_ID) {
    return { decision: 'approved' };
  }
  if (optionId === PLAN_REVISE_OPTION_ID) {
    return { decision: 'rejected', selectedLabel: 'Revise' };
  }
  if (optionId === PLAN_REJECT_AND_EXIT_OPTION_ID) {
    return { decision: 'rejected', selectedLabel: 'Reject and Exit' };
  }
  const match = /^plan_opt_(\d+)$/.exec(optionId);
  if (match) {
    const i = Number(match[1]);
    if (options !== undefined && Number.isInteger(i) && i >= 0 && i < options.length) {
      return { decision: 'approved', selectedLabel: options[i]!.label };
    }
    return { decision: 'rejected' };
  }
  return { decision: 'rejected' };
}

export function buildPermissionToolCallUpdate(
  req: AcpApprovalRequestView,
  toolCallId: string,
  diff?: ToolCallContent | null,
): ToolCallUpdate {
  const content: ToolCallContent[] = [];
  if (diff !== null && diff !== undefined) {
    content.push(diff);
  }
  if (req.planReview !== undefined && req.planReview.plan.trim().length > 0) {
    content.push({
      type: 'content',
      content: { type: 'text', text: `Plan saved to: ${req.planReview.path}\n\n${req.planReview.plan}` },
    });
  }
  content.push({
    type: 'content',
    content: { type: 'text', text: `Requesting approval to ${req.action}` },
  });
  return {
    toolCallId,
    title: req.toolName,
    content,
  };
}

export function attachSelectedLabel(
  response: RequestPermissionResponse,
  approval: AcpApprovalResponse,
  options: readonly PermissionOption[],
): AcpApprovalResponse {
  const outcome = response.outcome;
  if (outcome.outcome !== 'selected') return approval;
  if (
    outcome.optionId.startsWith('plan_opt_') ||
    outcome.optionId === PLAN_APPROVE_OPTION_ID ||
    outcome.optionId === PLAN_REVISE_OPTION_ID ||
    outcome.optionId === PLAN_REJECT_AND_EXIT_OPTION_ID
  ) {
    return approval;
  }
  const matched = options.find((o) => o.optionId === outcome.optionId);
  if (!matched) return approval;
  return { ...approval, selectedLabel: matched.name };
}
