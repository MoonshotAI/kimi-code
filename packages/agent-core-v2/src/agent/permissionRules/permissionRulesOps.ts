/**
 * `permissionRules` domain (L3) — wire Model (`PermissionRulesModel`) and the
 * `permission.rules.add` (`addPermissionRules`) / `permission.record_approval_result`
 * (`recordApprovalResult`) Ops for the agent's permission rules and session-scoped
 * approval patterns.
 *
 * Declares the rules list and the deduped session-approval patterns as one wire
 * Model (the full approval records are persisted as the log itself, not held as
 * model state — only the derived `sessionApprovalRulePatterns` are), plus the two
 * Ops whose `apply` functions are the pure extraction of the former live
 * `applyAddRules` / `applyApprovalResult` and their `record.define(...resume...)`
 * facets (their common transition). Each returns the same reference when nothing
 * changes (empty rules / duplicate or non-session approval) so the wire's
 * reference-equality gate stays quiet. The legacy `toReplay: approval_result`
 * projection is dropped — only `message` records feed the transcript. Consumed by
 * the Agent-scope `permissionRulesService`.
 */

import { defineModel, defineOp } from '#/wire';

import type { PermissionApprovalResultRecord, PermissionRule } from './permissionRules';

export interface PermissionRulesModelState {
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
}

export const PermissionRulesModel = defineModel<PermissionRulesModelState>('permissionRules', () => ({
  rules: [],
  sessionApprovalRulePatterns: [],
}));

export const addPermissionRules = defineOp(PermissionRulesModel, 'permission.rules.add', {
  apply: (s, p: { rules: readonly PermissionRule[] }): PermissionRulesModelState => {
    if (p.rules.length === 0) return s;
    return { ...s, rules: [...s.rules, ...p.rules] };
  },
});

export const recordApprovalResult = defineOp(
  PermissionRulesModel,
  'permission.record_approval_result',
  {
    apply: (s, p: PermissionApprovalResultRecord): PermissionRulesModelState => {
      const pattern = p.sessionApprovalRule;
      if (
        p.result.decision !== 'approved' ||
        p.result.scope !== 'session' ||
        pattern === undefined ||
        s.sessionApprovalRulePatterns.includes(pattern)
      ) {
        return s;
      }
      return { ...s, sessionApprovalRulePatterns: [...s.sessionApprovalRulePatterns, pattern] };
    },
  },
);
