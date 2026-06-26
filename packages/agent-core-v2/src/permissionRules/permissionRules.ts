import { createDecorator } from "#/_base/di";
import type { ApprovalResponse } from "@moonshot-ai/protocol";

import type { Hooks } from '../hooks';

export interface PermissionApprovalResultRecord {
  readonly turnId: number;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export interface PermissionRulesChangedContext {
  readonly rules: readonly PermissionRule[];
}

export interface PermissionApprovalRecordedContext {
  readonly record: PermissionApprovalResultRecord;
}

export interface PermissionRulesServiceOptions {
  readonly initialRules?: readonly PermissionRule[];
  readonly parent?: IPermissionRulesService;
}

export type PermissionRuleDecision = 'allow' | 'deny' | 'ask';

/**
 * Rule provenance. `session-runtime` stores rules produced by
 * "approve for session"; `turn-override`, `project`, and `user` are
 * reserved for static-loaded rules surfaced by external callers.
 */
export type PermissionRuleScope = 'turn-override' | 'session-runtime' | 'project' | 'user';

/**
 * A single permission rule. `pattern` is the DSL form (`Read(/etc/**)`,
 * `Bash(rm *)`, or bare `Write`). Rule arguments are interpreted only by
 * tools that provide a matcher; other tools match by name only.
 */
export interface PermissionRule {
  readonly decision: PermissionRuleDecision;
  readonly scope: PermissionRuleScope;
  readonly pattern: string;
  readonly reason?: string;
}

export interface IPermissionRulesService {
  readonly _serviceBrand: undefined;
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];

  addRules(rules: readonly PermissionRule[]): void;
  recordApprovalResult(record: PermissionApprovalResultRecord): void;

  readonly hooks: Hooks<{
    onChanged: PermissionRulesChangedContext;
    onApprovalRecorded: PermissionApprovalRecordedContext;
  }>;
}

// eslint-disable-next-line @typescript-eslint/no-redeclare
export const IPermissionRulesService =
  createDecorator<IPermissionRulesService>('agentPermissionRulesService');
