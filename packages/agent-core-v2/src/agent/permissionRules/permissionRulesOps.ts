/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { AgentEvent2 } from '#/app/event/event2';
import { defineState } from '#/state/state';

import type { PermissionApprovalResultRecord, PermissionRule } from './permissionRules';

export interface PermissionRulesModelState {
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
}

const permissionRulesAddSchema = z.object({
  agentId: z.string(),
  rules: z.custom<readonly PermissionRule[]>(),
});

export class PermissionRulesAdd extends AgentEvent2<z.infer<typeof permissionRulesAddSchema>> {
  static override readonly type = 'permission.rules.add';
}
export interface PermissionRulesAdd {
  readonly agentId: string;
  readonly rules: readonly PermissionRule[];
}

const permissionRecordApprovalResultSchema = z.object({
  agentId: z.string(),
  turnId: z.number(),
  toolCallId: z.string(),
  toolName: z.string(),
  action: z.string(),
  sessionApprovalRule: z.string().optional(),
  result: z.custom<PermissionApprovalResultRecord['result']>(),
});

export class PermissionRecordApprovalResult extends AgentEvent2<
  z.infer<typeof permissionRecordApprovalResultSchema>
> {
  static override readonly type = 'permission.record_approval_result';
  static override readonly durable = true;
  static override readonly schema = permissionRecordApprovalResultSchema;
}
export interface PermissionRecordApprovalResult extends PermissionApprovalResultRecord {
  readonly agentId: string;
}

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
