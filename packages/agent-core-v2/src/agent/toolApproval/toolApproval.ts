/**
 * `toolApproval` domain (L3) — `IAgentToolApprovalService` contract.
 *
 * Shared approval round-trip for tool executions: builds the approval request,
 * drives the `session/approval` broker, emits the `permission.approval.*`
 * events, records session-scope approval rules through `permissionRules`, and
 * resolves ask continuations. Consumed by `permissionGate` (policy-chain asks)
 * and by Harness domains such as `plan` / `goal` that run product reviews
 * outside the permission chain. Bound at Agent scope.
 */

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
