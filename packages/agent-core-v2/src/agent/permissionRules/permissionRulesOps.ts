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
 * reference-equality gate stays quiet. `permission.rules.add` is live-only
 * because v1 does not persist permission rules; hosts re-supply them on resume,
 * while only `permission.record_approval_result` rides the wire log. The
 * legacy `toReplay: approval_result` projection is dropped — only `message`
 * records feed the transcript. Consumed by the Agent-scope
 * `permissionRulesService`.
 */

import { z } from 'zod';

import { defineModel } from '#/wire/model';

import type { PermissionApprovalResultRecord, PermissionRule } from './permissionRules';

export interface PermissionRulesModelState {
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
}

export const PermissionRulesModel = defineModel<PermissionRulesModelState>('permissionRules', () => ({
  rules: [],
  sessionApprovalRulePatterns: [],
}));

declare module '#/wire/types' {
  interface PersistedOpMap {
    'permission.record_approval_result': typeof recordApprovalResult;
  }

  interface TransientOpMap {
    'permission.rules.add': typeof addPermissionRules;
  }
}

export const addPermissionRules = PermissionRulesModel.defineOp('permission.rules.add', {
  schema: z.object({ rules: z.custom<readonly PermissionRule[]>() }),
  persist: false,
  apply: (s, p) => {
    if (p.rules.length === 0) return s;
    return { ...s, rules: [...s.rules, ...p.rules] };
  },
});

export const recordApprovalResult = PermissionRulesModel.defineOp(
  'permission.record_approval_result',
  {
    schema: z.custom<PermissionApprovalResultRecord>(),
    apply: (s, p) => {
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
