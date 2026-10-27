import { createFeature, type Feature, useFeatureStore } from '#/app/index';
import { computed, useExpose, useInject, type ComputedRef } from '#/composition-api/index';

import { useConfigSection } from '#/todo-features/config/index';

import { PermissionModeRef, type PermissionModeFace } from './ref';
import { defaultPermissionModeConfigSection } from './state/configSection';
import { PERMISSION_SET_MODE, permissionModeProjection } from './state/projection';
import type { PermissionMode } from './types';

export function usePermissionMode(): ComputedRef<PermissionMode> {
  const permissionMode = useInject(PermissionModeRef).value;
  if (permissionMode === undefined) {
    throw new Error('permission mode feature session slot is not installed');
  }
  return computed(() => permissionMode.state.value.mode);
}

export function createPermissionMode(): Feature<void> {
  return createFeature('permission.mode', {
    app() {
      useConfigSection(defaultPermissionModeConfigSection);
    },
    session() {
      const store = useFeatureStore('session', 'permission.mode', permissionModeProjection);
      const state = store.state;
      const face: PermissionModeFace = {
        state,
        mode: () => state.value.mode,
        setMode: async (mode) => {
          const current = state.value;
          if (mode === current.mode && current.configured) return;
          await store.dispatch([{ type: PERMISSION_SET_MODE, mode }]);
        },
      };
      useExpose(PermissionModeRef, face);
    },
  });
}
