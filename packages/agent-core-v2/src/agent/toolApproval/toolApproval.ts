import { createDecorator } from '#/_base/di/instantiation';
import type { OrderedHookSlot } from '#/hooks';
import type {
  ApprovalRequest,
  ApprovalResponse,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';

export type PermissionDecisionSource = 'native' | 'external_hook' | 'implicit_no_broker';

export type PermissionApprovalRequestContext = ApprovalRequest & {
  readonly sessionId?: string;
  readonly agentId?: string;
  readonly turnId: number;
  readonly toolInput: unknown;
  readonly permissionRequestId?: string;
};

export type PermissionDecisionRequestContext = PermissionApprovalRequestContext & {
  readonly id: string;
  readonly permissionRequestId: string;
};

export interface ToolApprovalRequestHookContext {
  readonly request: PermissionDecisionRequestContext;
  readonly signal: AbortSignal;
  response?: ApprovalResponse;
  decisionSource: PermissionDecisionSource;
}

export interface IAgentToolApprovalService {
  readonly _serviceBrand: undefined;
  readonly hooks: {
    readonly onWillRequestApproval: OrderedHookSlot<ToolApprovalRequestHookContext>;
  };

  resolvePermissionResolution(
    result: PermissionPolicyResolution,
    context: ResolvedToolExecutionHookContext,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined>;

  requestToolApproval(
    context: ResolvedToolExecutionHookContext,
    result: Extract<PermissionPolicyResult, { kind: 'ask' }>,
    origin: string,
  ): Promise<BeforeExecuteDecision | undefined>;

  formatDenyMessage(message: string): string;

  formatApprovalRejectionMessage(
    toolName: string,
    result: Pick<ApprovalResponse, 'decision' | 'feedback'>,
    source?: PermissionDecisionSource,
  ): string;
}

export const IAgentToolApprovalService = createDecorator<IAgentToolApprovalService>(
  'agentToolApprovalService',
);
