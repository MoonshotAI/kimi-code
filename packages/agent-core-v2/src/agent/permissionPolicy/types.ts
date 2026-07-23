import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';
import type { ExecutableToolResult } from '#/tool/toolContract';
import type { ToolInputDisplay } from '#/tool/toolInputDisplay';
import type { PermissionRule } from '#/agent/permissionRules/permissionRules';

export type PermissionMode = 'manual' | 'yolo' | 'auto';


export interface ApprovalRequest {
  toolCallId: string;
  toolName: string;
  action: string;
  display: ToolInputDisplay;
}

export interface ApprovalResponse {
  decision: 'approved' | 'rejected' | 'cancelled';
  scope?: 'session';
  feedback?: string;
  selectedLabel?: string;
}

export interface PermissionData {
  mode: PermissionMode;
  rules: PermissionRule[];
}

export type PermissionDecision = 'approve' | 'deny' | 'ask';

export type PermissionReasonValue = string | number | boolean | null;

export type PermissionDecisionReason = Readonly<Record<string, PermissionReasonValue>>;

export type PermissionPolicyResolution =
  | PermissionPolicyResult
  | { readonly kind: 'result'; readonly result: ExecutableToolResult };

export interface PermissionPolicyContext extends ResolvedToolExecutionHookContext {}

export type PermissionPolicyResult =
  | {
      readonly kind: 'approve';
      readonly reason?: PermissionDecisionReason;
      readonly executionMetadata?: unknown;
    }
  | {
      readonly kind: 'deny';
      readonly reason?: PermissionDecisionReason;
      readonly message?: string;
    }
  | {
      readonly kind: 'ask';
      readonly reason?: PermissionDecisionReason;
      readonly resolveApproval?: (
        result: ApprovalResponse,
      ) => PermissionPolicyResolution | undefined;
      readonly resolveError?: (error: unknown) => PermissionPolicyResolution | undefined;
    };

export interface PermissionPolicy {
  readonly name: string;
  evaluate(
    context: PermissionPolicyContext,
  ): PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>;
}
