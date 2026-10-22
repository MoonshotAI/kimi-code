import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/runtime/index';

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

export interface PermissionSetModeEvent extends FeatureEvent {
  readonly type: typeof PERMISSION_SET_MODE;
  readonly mode: PermissionMode;
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

export type PermissionStoreEvent =
  | PermissionSetModeEvent
  | PermissionRulesAddEvent
  | PermissionRecordApprovalResultEvent;

export interface PermissionState {
  readonly mode: PermissionMode;
  readonly configured: boolean;
  readonly rules: readonly PermissionRule[];
  readonly sessionApprovalRulePatterns: readonly string[];
}

export const permissionProjection: Projection<PermissionState, PermissionStoreEvent> = {
  initial: () => ({ mode: 'manual', configured: false, rules: [], sessionApprovalRulePatterns: [] }),
  reduce: (state, entry) => {
    const event = entry.event;
    if (event.type === PERMISSION_SET_MODE) {
      return { ...state, mode: event.mode, configured: true };
    }
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
