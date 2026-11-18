import { ref } from 'vue';
import { useKimiWebClient as realClient } from '../../../../../packages/app-client/src/client/useKimiWebClient';
export * from '../../../../../packages/app-client/src/client/index';

export const turns = ref([]);
export const sessionId = ref('history-a');
export const active = ref(false);
export const hasMore = ref(false);
export const loadingMore = ref(false);
export let older = [];
export const timing = { olderDelayMs: 120 };
export function setOlder(value) { older = value; hasMore.value = true; }
export const status = { model: 'Replay', modelId: '', ctxUsed: 0, ctxMax: 128000, permission: 'manual', branch: '', cwd: '/tmp/history-replay', isGitRepo: false };

export function useKimiWebClient() {
  return {
    ...realClient(), turns, activeSessionId: sessionId, turnActive: active,
    hasMoreMessages: hasMore, loadingMoreMessages: loadingMore,
    sessionLoading: ref(false), status: ref(status),
    async loadOlderMessages() {
      loadingMore.value = true;
      await new Promise(resolve => setTimeout(resolve, timing.olderDelayMs));
      turns.value = [...older, ...turns.value];
      hasMore.value = false;
      loadingMore.value = false;
    },
  };
}
