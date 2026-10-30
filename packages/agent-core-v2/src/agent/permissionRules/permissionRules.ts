import { createDecorator } from "#/_base/di/instantiation";
import type { ApprovalResponse } from "#/agent/interaction/approval";
import type { EnvironmentTarget } from "#/environment/environment";

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly environmentId?: string;
  readonly result: ApprovalResponse;
}

export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface IAgentPermissionRulesService {
  readonly _serviceBrand: undefined;

  readonly rules: readonly PermissionRule[];
  sessionApprovalRulePatterns(environment?: EnvironmentTarget): readonly string[];
  addRules(rules: readonly PermissionRule[]): void;
  recordApprovalResult(record: PermissionApprovalResultRecord): void;
}

export const IAgentPermissionRulesService =
  createDecorator<IAgentPermissionRulesService>('agentPermissionRulesService');
