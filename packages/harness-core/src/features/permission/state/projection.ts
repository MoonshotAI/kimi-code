import type { BranchRef, Projection, RecordEvent } from '@moonshot-ai/agent-core';

import type { ApprovalResponse, PermissionMode, PermissionRule } from '../types';

export const PERMISSION_SET_MODE = 'permission.set_mode';
export const PERMISSION_RULES_ADD = 'permission.rules.add';
export const PERMISSION_RECORD_APPROVAL_RESULT = 'permission.record_approval_result';

export const PERMISSION_REMIND_KEY = 'permission-mode';

export interface PermissionApprovalResultRecord {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly action: string;
  readonly sessionApprovalRule?: string;
  readonly result: ApprovalResponse;
}

export interface PermissionState {
  readonly mode: PermissionMode;
  readonly configured: boolean;
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
}

export const permissionProjection: Projection<PermissionState, RecordEvent, BranchRef> = {
  initial: () => ({ mode: 'manual', configured: false, rules: [], sessionApprovalRulePatterns: [] }),
  reduce: (state, event) => {
    if (event.type === PERMISSION_SET_MODE) {
      return { ...state, mode: event['mode'] as PermissionMode, configured: true };
    }
    if (event.type === PERMISSION_RULES_ADD) {
      const rules = event['rules'] as readonly PermissionRule[];
      if (rules.length === 0) return state;
      return { ...state, rules: [...state.rules, ...rules] };
    }
    if (event.type === PERMISSION_RECORD_APPROVAL_RESULT) {
      const pattern = event['sessionApprovalRule'] as string | undefined;
      const result = event['result'] as ApprovalResponse;
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
