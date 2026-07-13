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
  /**
   * Register an additional policy that takes precedence over the built-in
   * policies. Returns a disposable that removes it. Used by callers that need
   * to tighten an agent's posture at runtime (e.g. side-question agents that
   * must deny every tool call).
   */
  registerPolicy(policy: PermissionPolicy): IDisposable;
}

export const IAgentPermissionPolicyService =
  createDecorator<IAgentPermissionPolicyService>('agentPermissionPolicyService');
