import { createDecorator } from "#/_base/di/instantiation";
import { type IDisposable } from "#/_base/di/lifecycle";
import type {
  ResolvedToolExecutionHookContext
} from '#/agent/toolExecutor/toolHooks';
import type { PermissionPolicy, PermissionPolicyResult } from './types';


export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export interface IAgentPermissionPolicyService {
  readonly _serviceBrand: undefined;

  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined>;
  registerPolicy(policy: PermissionPolicy): IDisposable;
}

export const IAgentPermissionPolicyService =
  createDecorator<IAgentPermissionPolicyService>('agentPermissionPolicyService');
