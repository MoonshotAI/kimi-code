
import { ref } from 'vue';

const KEY_ACTIVITY_RUN_FOLDING = 'kimi-web.activity-run-folding';

function storageGet(key: string): string | null {
  try {
    return globalThis.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    globalThis.localStorage.setItem(key, value);
  } catch {}
}

function loadActivityRunFolding(): boolean {
  return storageGet(KEY_ACTIVITY_RUN_FOLDING) !== '0';
}

const activityRunFolding = ref<boolean>(loadActivityRunFolding());

function setActivityRunFolding(on: boolean): void {
  activityRunFolding.value = on;
  storageSet(KEY_ACTIVITY_RUN_FOLDING, on ? '1' : '0');
}

export function useActivityRunFolding() {
  return {
    activityRunFolding,
    setActivityRunFolding,
  };
}
