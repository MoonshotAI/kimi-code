import type { ToolCall } from '@moonshot-ai/agent-core';

import type { PathClass } from '#/features/os/path-access';

import type { PermissionConfig } from '../state/configSection';
import type { PermissionMode, PermissionRule } from '../types';

import { dangerousCommandAsk } from './dangerous';
import { defaultToolApprove, fallbackAsk, gitCwdWriteApprove } from './defaults';
import { sensitiveFileAccessAsk, gitControlPathAccessAsk } from './files';
import { autoModeApprove, autoModeAskUserQuestionDeny, yoloModeApprove } from './mode';
import {
  sessionApprovalHistory,
  userConfiguredAllow,
  userConfiguredAsk,
  userConfiguredDeny,
} from './user-rules';

export interface PermissionPolicyContext {
  readonly toolCall: ToolCall;
  readonly args: Record<string, unknown> | undefined;
  readonly interactive: boolean;
  readonly mode: PermissionMode;
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
  readonly config: PermissionConfig | undefined;
  readonly workDir: string | undefined;
  readonly additionalDirs: readonly string[];
  readonly pathClass: PathClass;
  readonly homeDir: string | undefined;
}

export type PermissionPolicyResult =
  | { readonly kind: 'approve' }
  | { readonly kind: 'deny'; readonly message: string }
  | { readonly kind: 'ask' };

export interface PermissionPolicyEvaluation {
  readonly policyName: string;
  readonly result: PermissionPolicyResult;
}

export interface PermissionPolicy {
  readonly name: string;
  evaluate(
    context: PermissionPolicyContext,
  ): PermissionPolicyResult | undefined | Promise<PermissionPolicyResult | undefined>;
}

export async function evaluatePermissionPolicies(
  context: PermissionPolicyContext,
): Promise<PermissionPolicyEvaluation | undefined> {
  const policies: readonly PermissionPolicy[] = [
    autoModeAskUserQuestionDeny,
    userConfiguredDeny,
    ...(context.interactive ? [dangerousCommandAsk] : []),
    autoModeApprove,
    sessionApprovalHistory,
    userConfiguredAsk,
    userConfiguredAllow,
    sensitiveFileAccessAsk,
    gitControlPathAccessAsk,
    yoloModeApprove,
    defaultToolApprove,
    gitCwdWriteApprove,
    fallbackAsk,
  ];
  for (const policy of policies) {
    const result = await policy.evaluate(context);
    if (result !== undefined) return { policyName: policy.name, result };
  }
  return undefined;
}
