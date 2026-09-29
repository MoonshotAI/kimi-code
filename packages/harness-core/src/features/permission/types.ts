import type { RuntimeEvent } from '@moonshot-ai/agent-core/kernel/index';

export type PermissionMode = 'manual' | 'yolo' | 'auto';

export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface ApprovalResponse {
  readonly decision: 'approved' | 'rejected' | 'cancelled';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
}

export interface PermissionApprovalDisplay {
  readonly kind: 'generic';
  readonly summary: string;
  readonly detail: unknown;
}

export interface PermissionFileAccess {
  readonly operation: 'read' | 'write' | 'readwrite' | 'search';
  readonly path: string;
  readonly recursive?: boolean;
}

export interface PermissionApprovalRequestedEvent extends RuntimeEvent {
  readonly type: 'permission.approval.requested';
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: PermissionApprovalDisplay;
  readonly toolInput: unknown;
}

export interface PermissionApprovalResolvedEvent extends RuntimeEvent {
  readonly type: 'permission.approval.resolved';
  readonly id: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly display: PermissionApprovalDisplay;
  readonly toolInput: unknown;
  readonly decision: 'approved' | 'rejected' | 'cancelled' | 'error';
  readonly scope?: 'session';
  readonly feedback?: string;
  readonly selectedLabel?: string;
  readonly error?: string;
}

export type PermissionEvent = PermissionApprovalRequestedEvent | PermissionApprovalResolvedEvent;
