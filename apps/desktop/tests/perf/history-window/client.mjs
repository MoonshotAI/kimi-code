import { ref, watch } from 'vue';
import { sessionReadScope } from '../../../../../packages/app-client/src/client/observationScope';
import { useKimiWebClient as realClient } from '../../../../../packages/app-client/src/client/useKimiWebClient';
export * from '../../../../../packages/app-client/src/client/index';

export const turns = ref([]);
export const sessionId = ref('history-a');
watch(sessionId, id => sessionReadScope.activate(id), { immediate: true, flush: 'sync' });
export const active = ref(false);
export const hasMore = ref(false);
export const loadingMore = ref(false);
export let older = [];
export const timing = { olderDelayMs: 120 };
export function setOlder(value) { older = value; hasMore.value = true; }
export const status = { model: 'Replay', modelId: '', ctxUsed: 0, ctxMax: 128000, permission: 'manual', branch: '', cwd: '/tmp/history-replay', isGitRepo: false };

export function useKimiWebClient() {
  return {
    ...realClient(),
    resolveImageUrl: src => (globalThis.__resolveImageUrl ? globalThis.__resolveImageUrl(src) : Promise.resolve(src)),
    turns, activeSessionId: sessionId, turnActive: active,
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
