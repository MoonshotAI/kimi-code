import { readonly, ref } from 'vue';

const sessionMentionsState = ref(false);

export function setSessionMentions(on: boolean): void {
  sessionMentionsState.value = on;
}

export function useSessionMentions() {
  return {
    sessionMentions: readonly(sessionMentionsState),
    setSessionMentions,
  };
}
