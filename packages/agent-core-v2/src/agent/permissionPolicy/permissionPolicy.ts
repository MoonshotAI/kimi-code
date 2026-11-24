import { createDecorator } from "#/_base/di/instantiation";
import type {
  ResolvedToolExecutionHookContext
} from '#/agent/toolExecutor/toolHooks';
import type { PermissionMode, PermissionPolicyResult } from './types';


export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export interface PermissionPolicyEvaluateOptions {
  readonly mode?: PermissionMode;
}

export interface IAgentPermissionPolicyService {
  readonly _serviceBrand: undefined;

  evaluate(
    context: ResolvedToolExecutionHookContext,
    options?: PermissionPolicyEvaluateOptions,
  ): Promise<PermissionPolicyEvaluation | undefined>;
}

export const IAgentPermissionPolicyService =
  createDecorator<IAgentPermissionPolicyService>('agentPermissionPolicyService');
