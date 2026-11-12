import { createDecorator } from "#/_base/di/instantiation";
import type { IDisposable } from '#/_base/di/lifecycle';
import type {
  PermissionPolicyEvaluateOptions,
  PermissionPolicyEvaluation,
} from '#/agent/permissionPolicy/permissionPolicy';
import type {
  PermissionData
} from '#/agent/permissionPolicy/types';
import type { BeforeToolExecuteEvent } from '#/agent/toolExecutor/toolHooks';

export interface PermissionGateReviewer {
  evaluateOptions?(): PermissionPolicyEvaluateOptions | undefined;
  review(
    context: BeforeToolExecuteEvent,
    evaluation: PermissionPolicyEvaluation,
  ): (() => Promise<PermissionPolicyEvaluation>) | undefined;
}

export interface IAgentPermissionGate {
  readonly _serviceBrand: undefined;

  data(): PermissionData;
  registerReviewer(reviewer: PermissionGateReviewer): IDisposable;
}

export const IAgentPermissionGate =
  createDecorator<IAgentPermissionGate>('agentPermissionGate');
