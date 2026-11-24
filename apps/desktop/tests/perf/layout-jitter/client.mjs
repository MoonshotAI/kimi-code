import { ref } from 'vue';
import { useKimiWebClient as realClient } from '../../../../../packages/app-client/src/client/useKimiWebClient';
export * from '../../../../../packages/app-client/src/client/index';

export const turns = ref([]);
export const tasks = ref([]);
export const sessionId = ref('layout-jitter');
export const hasMore = ref(false);
export const loadingMore = ref(false);
export const loads = [];
let olderPages = [];
export function setOlderPages(pages) {
  olderPages = pages;
  hasMore.value = pages.length > 0;
}
export const status = { model: 'Replay', modelId: '', ctxUsed: 0, ctxMax: 128000, permission: 'manual', branch: '', cwd: '/tmp/layout-jitter', isGitRepo: false };

export function useKimiWebClient() {
  return {
    ...realClient(), turns, tasks, activeSessionId: sessionId, turnActive: ref(false),
    hasMoreMessages: hasMore, loadingMoreMessages: loadingMore,
    sessionLoading: ref(false), status: ref(status),
    async loadOlderMessages() {
      if (!olderPages.length) return;
      loadingMore.value = true;
      loads.push({ kind: 'start', scrollTop: document.querySelector('.panes')?.scrollTop });
      await new Promise(resolve => setTimeout(resolve, 250));
      const page = olderPages.shift() ?? [];
      if (page.length) turns.value = [...page, ...turns.value];
      hasMore.value = olderPages.length > 0;
      loadingMore.value = false;
      loads.push({ kind: 'end', scrollTop: document.querySelector('.panes')?.scrollTop, prepended: page.length });
    },
  };
}
