
import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppSession } from '@moonshot-ai/app-core/api';
import {
  insertSessionByRecency,
  loadPinnedSessions,
  pinSessionId,
  pinnedSessionKey,
  savePinnedSessions,
  unpinSessionId,
  type PinnedInsertTarget,
} from '@moonshot-ai/app-core/lib';
import { clientPinia } from './pinia';
import { pinnedOrderStore } from './pinnedOrder';

export const useSessionsStore = defineStore('kimi.sessions', () => {
  const sessions = ref<AppSession[]>([]);
  const activeSessionId = ref<string | undefined>(undefined);
  const pinnedSessionIds = ref<string[]>(loadPinnedSessions());

  function setSessions(next: AppSession[]): void {
    sessions.value = next;
  }
  function updateSession(id: string, update: (session: AppSession) => AppSession): void {
    sessions.value = sessions.value.map((s) => (s.id === id ? update(s) : s));
  }
  function upsertSessionSorted(session: AppSession): void {
    sessions.value = insertSessionByRecency(sessions.value, session);
  }
  function appendSession(session: AppSession): void {
    sessions.value = [...sessions.value, session];
  }
  function removeSession(id: string): void {
    sessions.value = sessions.value.filter((s) => s.id !== id);
  }

  function setActiveSessionId(id: string | undefined): void {
    activeSessionId.value = id;
  }

  function pinSession(id: string, target?: PinnedInsertTarget): void {
    if (!target && pinnedSessionIds.value.includes(id)) return;
    const next = pinSessionId(pinnedSessionIds.value, id);
    if (next !== pinnedSessionIds.value) {
      pinnedSessionIds.value = next;
      savePinnedSessions(next);
    }
    pinnedOrderStore().placeKey(pinnedSessionKey(id), target);
  }

  function unpinSession(id: string): void {
    const next = unpinSessionId(pinnedSessionIds.value, id);
    pinnedOrderStore().removeKeys([pinnedSessionKey(id)]);
    if (next === pinnedSessionIds.value) return;
    pinnedSessionIds.value = next;
    savePinnedSessions(next);
  }

  function unpinSessions(ids: string[]): void {
    const stale = new Set(ids);
    pinnedOrderStore().removeKeys(ids.map((id) => pinnedSessionKey(id)));
    const next = pinnedSessionIds.value.filter((id) => !stale.has(id));
    if (next.length === pinnedSessionIds.value.length) return;
    pinnedSessionIds.value = next;
    savePinnedSessions(next);
  }

  function togglePinSession(id: string): void {
    if (pinnedSessionIds.value.includes(id)) unpinSession(id);
    else pinSession(id);
  }

  return {
    sessions,
    activeSessionId,
    pinnedSessionIds,
    setSessions,
    updateSession,
    upsertSessionSorted,
    appendSession,
    removeSession,
    setActiveSessionId,
    pinSession,
    unpinSession,
    unpinSessions,
    togglePinSession,
  };
});

export function sessionsStore() {
  return useSessionsStore(clientPinia);
}
