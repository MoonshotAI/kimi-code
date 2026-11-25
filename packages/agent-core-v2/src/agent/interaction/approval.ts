import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalReviewDetail {
  readonly outcome: 'denied' | 'failed';
  readonly risk?: 'low' | 'medium' | 'high';
  readonly reason: string;
}

export function formatApprovalReviewTitle(review: ApprovalReviewDetail): string {
  return review.outcome === 'failed'
    ? "Auto Review couldn't finish"
    : `Auto Review didn't approve · ${review.risk ?? 'medium'} risk`;
}

export interface ApprovalRequest {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
  readonly approvalDetail?: ApprovalReviewDetail;
}

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}
