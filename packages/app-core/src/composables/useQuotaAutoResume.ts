import { ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '../lib/storage';

const quotaAutoResumeEnabled = ref(safeGetJson<boolean>(STORAGE_KEYS.quotaAutoResume) === true);

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEYS.quotaAutoResume) return;
    if (event.newValue === null) {
      quotaAutoResumeEnabled.value = false;
      return;
    }
    try {
      quotaAutoResumeEnabled.value = JSON.parse(event.newValue) === true;
    } catch {
      quotaAutoResumeEnabled.value = false;
    }
  });
}

function setQuotaAutoResumeEnabled(enabled: boolean): void {
  quotaAutoResumeEnabled.value = enabled;
  safeSetJson(STORAGE_KEYS.quotaAutoResume, enabled);
}

export function useQuotaAutoResume() {
  return {
    quotaAutoResumeEnabled,
    setQuotaAutoResumeEnabled,
  };
}
