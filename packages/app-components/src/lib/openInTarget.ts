
import { ref, type Ref } from 'vue';
import { safeGetString, safeRemove, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';

export function loadDefaultOpenInTarget(): string | null {
  const value = safeGetString(STORAGE_KEYS.openInDefaultTarget);
  return value !== null && value !== '' ? value : null;
}

const defaultTarget: Ref<string | null> = ref(loadDefaultOpenInTarget());

export function useDefaultOpenInTarget(): Ref<string | null> {
  return defaultTarget;
}

export function saveDefaultOpenInTarget(appId: string): void {
  if (appId === '') {
    safeRemove(STORAGE_KEYS.openInDefaultTarget);
  } else {
    safeSetString(STORAGE_KEYS.openInDefaultTarget, appId);
  }
  defaultTarget.value = appId === '' ? null : appId;
}

export function resolveOpenInTarget(availableIds: string[], selectedId: string | null): string | null {
  if (selectedId !== null && availableIds.includes(selectedId)) return selectedId;
  return availableIds[0] ?? null;
}

export function resolvePreferredOpenInTarget(
  targets: ReadonlyArray<{ id: string; preferred?: boolean }>,
  sessionId: string | null,
  defaultId: string | null,
): string | null {
  const ids = targets.map((target) => target.id);
  if (sessionId !== null && ids.includes(sessionId)) return sessionId;
  const preferredIds = targets.filter((target) => target.preferred === true).map((target) => target.id);
  if (preferredIds.length > 0) {
    if (defaultId !== null && preferredIds.includes(defaultId)) return defaultId;
    return preferredIds[0]!;
  }
  return resolveOpenInTarget(ids, defaultId);
}
