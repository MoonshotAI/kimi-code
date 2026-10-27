import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/app/index';

import type { ApprovalResponse, PermissionRule } from '../types';

export const PERMISSION_RULES_ADD = 'permission.rules.add';
export const PERMISSION_RECORD_APPROVAL_RESULT = 'permission.record_approval_result';

export interface PermissionApprovalResultRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export interface PermissionRulesAddEvent extends FeatureEvent {
  readonly type: typeof PERMISSION_RULES_ADD;
  readonly rules: readonly PermissionRule[];
}

export interface PermissionRecordApprovalResultEvent extends FeatureEvent {
  readonly type: typeof PERMISSION_RECORD_APPROVAL_RESULT;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export type PermissionStoreEvent = PermissionRulesAddEvent | PermissionRecordApprovalResultEvent;

export interface PermissionPolicyState {
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
}

export const permissionPolicyProjection: Projection<PermissionPolicyState, PermissionStoreEvent> = {
  initial: () => ({ rules: [], sessionApprovalRulePatterns: [] }),
  reduce: (state, entry) => {
    const event = entry.event;
    if (event.type === PERMISSION_RULES_ADD) {
      if (event.rules.length === 0) return state;
      return { ...state, rules: [...state.rules, ...event.rules] };
    }
    if (event.type === PERMISSION_RECORD_APPROVAL_RESULT) {
      const pattern = event.sessionApprovalRule;
      const result = event.result;
      if (
        result.decision !== 'approved' ||
        result.scope !== 'session' ||
        pattern === undefined ||
        state.sessionApprovalRulePatterns.includes(pattern)
      ) {
        return state;
      }
      return { ...state, sessionApprovalRulePatterns: [...state.sessionApprovalRulePatterns, pattern] };
    }
    return state;
  },
};
