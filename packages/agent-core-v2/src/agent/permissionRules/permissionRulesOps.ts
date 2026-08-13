/**
 * `permissionRules` domain — the `permissionRulesKey` state and the
 * `permission.rules.add` (`PermissionRulesAdd`, transient) /
 * `permission.record_approval_result` (`PermissionRecordApprovalResult`,
 * durable) events for the agent's permission rules and session-scoped approval
 * patterns.
 *
 * The state holds the rules list and the deduped session-approval patterns
 * (the full approval records are persisted as the log itself, not held as
 * state — only the derived `sessionApprovalRulePatterns` are). Each fold keeps
 * the same reference when nothing changes (empty rules / duplicate or
 * non-session approval) so the state's reference-equality stays quiet.
 * `permission.rules.add` is live-only because v1 does not persist permission
 * rules; hosts re-supply them on resume, while only
 * `permission.record_approval_result` rides the wire log. The legacy
 * `toReplay: approval_result` projection is dropped — only `message` records
 * feed the transcript. Scope-agnostic.
 */

/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */

import { z } from 'zod';

import { Event2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { PermissionApprovalResultRecord, PermissionRule } from './permissionRules';

export interface PermissionRulesModelState {
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
}

const permissionRulesAddSchema = z.object({ rules: z.custom<readonly PermissionRule[]>() });

export class PermissionRulesAdd extends Event2<z.infer<typeof permissionRulesAddSchema>> {
  static override readonly type = 'permission.rules.add';
}
export interface PermissionRulesAdd extends z.infer<typeof permissionRulesAddSchema> {}

const permissionRecordApprovalResultSchema = z.custom<PermissionApprovalResultRecord>();

export class PermissionRecordApprovalResult extends Event2<
  z.infer<typeof permissionRecordApprovalResultSchema>
> {
  static override readonly type = 'permission.record_approval_result';
  static override readonly durable = true;
  static override readonly schema = permissionRecordApprovalResultSchema;
}
export interface PermissionRecordApprovalResult
  extends z.infer<typeof permissionRecordApprovalResultSchema> {}

export const permissionRulesKey = defineState(
  'permissionRules',
  (): PermissionRulesModelState => ({
    rules: [],
    sessionApprovalRulePatterns: [],
  }),
).replayable({ schema: z.custom<PermissionRulesModelState>() })
  .on(PermissionRulesAdd, (s, e) => {
    if (e.rules.length === 0) return;
    s.rules = [...s.rules, ...e.rules];
  })
  .on(PermissionRecordApprovalResult, (s, e) => {
    const pattern = e.sessionApprovalRule;
    if (
      e.result.decision !== 'approved' ||
      e.result.scope !== 'session' ||
      pattern === undefined ||
      s.sessionApprovalRulePatterns.includes(pattern)
    ) {
      return;
    }
    s.sessionApprovalRulePatterns = [...s.sessionApprovalRulePatterns, pattern];
  });
