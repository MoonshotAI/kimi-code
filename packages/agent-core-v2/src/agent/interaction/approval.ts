import type { ToolInputDisplay } from '#/tool/toolInputDisplay';

export type ApprovalDecision = 'approved' | 'rejected' | 'cancelled';

export interface ApprovalRequest {
  readonly id?: string;
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId?: number;
  readonly toolCallId?: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: ToolInputDisplay;
}

export interface ApprovalResponse {
  readonly decision: ApprovalDecision;
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}
