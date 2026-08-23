import { createDecorator } from '#/_base/di/instantiation';
import type {
  ApprovalResponse,
  PermissionPolicyResolution,
  PermissionPolicyResult,
} from '#/agent/permissionPolicy/types';
import type {
  BeforeExecuteDecision,
  ResolvedToolExecutionHookContext,
} from '#/agent/toolExecutor/toolHooks';

export interface IAgentToolApprovalService {
  readonly _serviceBrand: undefined;

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
