// Default-target persistence for the Open In menu: the user's settings choice
// mirrored in a module-level reactive ref, so every consumer (header pill,
// settings dialog) sees a change in the same tick — localStorage alone is not
// reactive. Storage key unchanged from the original desktop implementation.

import { ref, type Ref } from 'vue';
import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

/** The persisted default app id; null means "auto" (first available). */
export function loadDefaultOpenInTarget(): string | null {
  const value = safeGetString(STORAGE_KEYS.openInDefaultTarget);
  return value !== null && value !== '' ? value : null;
}

const defaultTarget: Ref<string | null> = ref(loadDefaultOpenInTarget());

/** Shared reactive default-target (settings choice; null = auto). */
export function useDefaultOpenInTarget(): Ref<string | null> {
  return defaultTarget;
}

/** Persists the settings choice; '' clears it back to "auto". */
export function saveDefaultOpenInTarget(appId: string): void {
  if (appId === '') {
    safeRemove(STORAGE_KEYS.openInDefaultTarget);
  } else {
    safeSetString(STORAGE_KEYS.openInDefaultTarget, appId);
  }
  defaultTarget.value = appId === '' ? null : appId;
}

/**
 * Pure selected-target resolution: the chosen app when still installed,
 * otherwise the first available one. Single source of truth — a menu pick in
 * the header and the settings dropdown write the same storage key.
 */
export function resolveOpenInTarget(availableIds: string[], selectedId: string | null): string | null {
  if (selectedId !== null && availableIds.includes(selectedId)) return selectedId;
  return availableIds[0] ?? null;
}
