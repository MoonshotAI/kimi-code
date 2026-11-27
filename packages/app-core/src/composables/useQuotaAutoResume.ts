import { ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '../lib/storage';

const quotaAutoResumeEnabled = ref(safeGetJson<boolean>(STORAGE_KEYS.quotaAutoResume) === true);
const quotaAutoContinueEnabled = ref(safeGetJson<boolean>(STORAGE_KEYS.quotaAutoContinue) !== false);

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key === STORAGE_KEYS.quotaAutoResume) {
      if (event.newValue === null) {
        quotaAutoResumeEnabled.value = false;
        return;
      }
      try {
        quotaAutoResumeEnabled.value = JSON.parse(event.newValue) === true;
      } catch {
        quotaAutoResumeEnabled.value = false;
      }
      return;
    }
    if (event.key !== STORAGE_KEYS.quotaAutoContinue) return;
    if (event.newValue === null) {
      quotaAutoContinueEnabled.value = true;
      return;
    }
    try {
      quotaAutoContinueEnabled.value = JSON.parse(event.newValue) !== false;
    } catch {
      quotaAutoContinueEnabled.value = true;
    }
  });
}

function setQuotaAutoResumeEnabled(enabled: boolean): void {
  quotaAutoResumeEnabled.value = enabled;
  safeSetJson(STORAGE_KEYS.quotaAutoResume, enabled);
}

function setQuotaAutoContinueEnabled(enabled: boolean): void {
  quotaAutoContinueEnabled.value = enabled;
  safeSetJson(STORAGE_KEYS.quotaAutoContinue, enabled);
}

export function useQuotaAutoResume() {
  return {
    quotaAutoResumeEnabled,
    setQuotaAutoResumeEnabled,
    quotaAutoContinueEnabled,
    setQuotaAutoContinueEnabled,
  };
}
