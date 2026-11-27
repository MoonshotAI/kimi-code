import { ref } from 'vue';
import { STORAGE_KEYS, safeGetJson, safeSetJson } from '../lib/storage';

const quotaAutoResumeEnabled = ref(safeGetJson<boolean>(STORAGE_KEYS.quotaAutoResume) === true);

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
