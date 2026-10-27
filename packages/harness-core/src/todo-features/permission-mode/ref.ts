import { createFacadeToken, type ComputedRef } from '#/composition-api/index';

import type { PermissionModeState } from './state/projection';
import type { PermissionMode } from './types';

export interface PermissionModeFace {
  readonly state: ComputedRef<PermissionModeState>;
  mode(): PermissionMode;
  setMode(mode: PermissionMode): Promise<void>;
}

export const PermissionModeRef = createFacadeToken<PermissionModeFace>('permission.mode');
