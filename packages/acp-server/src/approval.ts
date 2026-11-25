import type {
  PermissionOption,
  RequestPermissionResponse,
  ToolCallContent,
  ToolCallUpdate,
} from '@agentclientprotocol/sdk';
import type {
  SessionApprovalRequest as ApprovalRequest,
  SessionApprovalResponse as ApprovalResponse,
} from '@moonshot-ai/agent-core-v2';

import { displayBlockToAcpContent } from './convert';
import { acpToolCallId, toolCallLocations } from './events-map';

export const APPROVE_ONCE_OPTION_ID = 'approve_once';
export const APPROVE_ALWAYS_OPTION_ID = 'approve_always';
export const REJECT_OPTION_ID = 'reject';

export const PLAN_APPROVE_OPTION_ID = 'plan_approve';
export const PLAN_REVISE_OPTION_ID = 'plan_revise';
export const PLAN_REJECT_AND_EXIT_OPTION_ID = 'plan_reject_and_exit';

function planOptOptionId(i: number): string {
  return `plan_opt_${i}`;
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
  req: ApprovalRequest,
): readonly PermissionOption[] {
  if (req.display.kind !== 'plan_review') {
    return CANONICAL_OPTIONS;
  }
  const display = req.display;
  const approveOptions: PermissionOption[] =
    display.options !== undefined && display.options.length >= 2
      ? display.options.map((opt, i) => ({
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
  req: ApprovalRequest,
  response: RequestPermissionResponse,
): ApprovalResponse {
  if (response.outcome.outcome === 'cancelled') {
    return { decision: 'cancelled' };
  }
  const optionId = response.outcome.optionId;
  if (req.display.kind === 'plan_review') {
    return mapPlanReviewOptionId(req.display, optionId);
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
  display: Extract<ApprovalRequest['display'], { kind: 'plan_review' }>,
  optionId: string,
): ApprovalResponse {
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
    const opts = display.options;
    if (opts !== undefined && Number.isInteger(i) && i >= 0 && i < opts.length) {
      return { decision: 'approved', selectedLabel: opts[i]!.label };
    }
    return { decision: 'rejected' };
  }
  return { decision: 'rejected' };
}

export function buildPermissionToolCallUpdate(req: ApprovalRequest): ToolCallUpdate {
  const rawId = req.toolCallId ?? req.toolName;
  const toolCallId = req.turnId !== undefined ? acpToolCallId(req.turnId, rawId) : rawId;
  const { display } = req;
  const content: ToolCallContent[] = [];
  const headlineEntry = displayBlockToAcpContent(display);
  if (headlineEntry !== null) {
    content.push(headlineEntry);
  }
  if (display.kind === 'command') {
    content.push({ type: 'content', content: { type: 'text', text: display.command } });
    if (display.cwd !== undefined) {
      content.push({ type: 'content', content: { type: 'text', text: `Working directory\n${display.cwd}` } });
    }
  }
  const review = req.approvalDetail;
  const prompt = review === undefined
    ? `Requesting approval to ${req.action}`
    : `${review.outcome === 'failed' ? "Auto Review couldn't finish" : `Auto Review recommends rejecting · ${review.risk ?? 'medium'} risk`}: ${review.reason}\n\nRequesting approval to ${req.action}`;
  content.push({
    type: 'content',
    content: { type: 'text', text: prompt },
  });
  const locations = toolCallLocations(req.toolName, undefined, display);
  return {
    toolCallId,
    title: req.toolName,
    content,
    ...(locations === undefined ? {} : { locations }),
  };
}

export function attachSelectedLabel(
  response: RequestPermissionResponse,
  approval: ApprovalResponse,
  options: readonly PermissionOption[],
): ApprovalResponse {
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
