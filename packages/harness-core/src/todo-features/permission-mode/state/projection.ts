import type { Projection } from '@moonshot-ai/agent-core/store/index';

import type { FeatureEvent } from '#/app/index';

import type { PermissionMode } from '../types';

export const PERMISSION_SET_MODE = 'permission.set_mode';

export interface PermissionSetModeEvent extends FeatureEvent {
  readonly type: typeof PERMISSION_SET_MODE;
  readonly mode: PermissionMode;
}

export type PermissionModeStoreEvent = PermissionSetModeEvent;

export interface PermissionModeState {
  readonly mode: PermissionMode;
  readonly configured: boolean;
}

export const permissionModeProjection: Projection<PermissionModeState, PermissionModeStoreEvent> = {
  initial: () => ({ mode: 'manual', configured: false }),
  reduce: (state, entry) => {
    if (entry.event.type === PERMISSION_SET_MODE) {
      return { ...state, mode: entry.event.mode, configured: true };
    }
    return state;
  },
};
