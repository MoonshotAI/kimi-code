import { createFacadeToken, type ComputedRef } from '#/composition-api/index';

import type { PermissionApprovalResultRecord, PermissionPolicyState } from './state/projection';
import type { PermissionRule } from './types';

export interface PermissionPolicyFace {
  readonly state: ComputedRef<PermissionPolicyState>;
  recordApprovalResult(record: PermissionApprovalResultRecord): Promise<void>;
  addRules(rules: readonly PermissionRule[]): Promise<void>;
}

export const PermissionPolicyRef = createFacadeToken<PermissionPolicyFace>('permission.policy');
