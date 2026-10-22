import { createFacadeToken, type ComputedRef } from '#/kernel/index';

import type { PermissionApprovalResultRecord, PermissionState } from './state/projection';
import type { PermissionMode, PermissionRule } from './types';

export interface PermissionFace {
  readonly state: ComputedRef<PermissionState>;
  mode(): PermissionMode;
  setMode(mode: PermissionMode): Promise<void>;
  recordApprovalResult(record: PermissionApprovalResultRecord): Promise<void>;
  addRules(rules: readonly PermissionRule[]): Promise<void>;
}

export const PermissionRef = createFacadeToken<PermissionFace>('permission');
