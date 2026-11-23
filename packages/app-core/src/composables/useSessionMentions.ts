import { ref } from 'vue';
import { STORAGE_KEYS, safeGetString, safeSetString } from '../lib/storage';

const sessionMentions = ref<boolean>(safeGetString(STORAGE_KEYS.sessionMentions) === '1');

function setSessionMentions(on: boolean): void {
  sessionMentions.value = on;
  safeSetString(STORAGE_KEYS.sessionMentions, on ? '1' : '0');
}

export function useSessionMentions() {
  return {
    sessionMentions,
    setSessionMentions,
  };
}
