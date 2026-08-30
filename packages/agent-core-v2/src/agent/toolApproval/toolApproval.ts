import { createDecorator } from '#/_base/di/instantiation';
import type { Event } from '#/_base/event';
import type {
  ApprovalResponse,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/actor/toolExecutor/permissionTypes';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/actor/toolExecutor/toolHooks';

export interface PendingToolApproval {
  readonly approvalId: string;
  readonly toolCallId?: string;
  readonly since: number;
}

export interface IAgentToolApprovalService {
  readonly _serviceBrand: undefined;

  pendingApprovals(): readonly PendingToolApproval[];

  readonly onDidChangePending: Event<void>;

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
  ): string;
}

export const IAgentToolApprovalService = createDecorator<IAgentToolApprovalService>(
  'agentToolApprovalService',
);
