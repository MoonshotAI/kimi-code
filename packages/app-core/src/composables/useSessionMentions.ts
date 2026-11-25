import { readonly, ref } from 'vue';
import { STORAGE_KEYS, safeGetString } from '../lib/storage';

const sessionMentionsState = ref(safeGetString(STORAGE_KEYS.sessionMentions) === '1');

export function setSessionMentions(on: boolean): void {
  sessionMentionsState.value = on;
}

export function useSessionMentions() {
  return {
    sessionMentions: readonly(sessionMentionsState),
    setSessionMentions,
  };
}
