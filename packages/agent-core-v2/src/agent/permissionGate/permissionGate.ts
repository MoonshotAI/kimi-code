import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from '#/_base/di/lifecycle';
import type { PermissionPolicyEvaluation } from '#/agent/permissionPolicy/permissionPolicy';
import type { PermissionData } from '#/agent/permissionPolicy/types';
import type { ResolvedToolExecutionHookContext } from '#/agent/toolExecutor/toolHooks';

export type PermissionGateReviewer = (
  context: ResolvedToolExecutionHookContext,
  evaluation: PermissionPolicyEvaluation,
) => PermissionPolicyEvaluation | undefined | Promise<PermissionPolicyEvaluation | undefined>;

export interface IAgentPermissionGate {
  readonly _serviceBrand: undefined;

  data(): PermissionData;
  registerReviewer(reviewer: PermissionGateReviewer): IDisposable;
}

export const IAgentPermissionGate =
  createDecorator<IAgentPermissionGate>('agentPermissionGate');
