import { createDecorator } from "#/_base/di/instantiation";
import type {
  ResolvedToolExecutionHookContext
} from '#/agent/toolExecutor/toolHooks';
import type { PermissionPolicyResult } from './types';


export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
  readonly underlying?: PermissionPolicyEvaluation;
}

export interface IAgentPermissionPolicyService {
  readonly _serviceBrand: undefined;

  evaluate(
    context: ResolvedToolExecutionHookContext,
  ): Promise<PermissionPolicyEvaluation | undefined>;
}

export const IAgentPermissionPolicyService =
  createDecorator<IAgentPermissionPolicyService>('agentPermissionPolicyService');
