// Sessions domain store — the first Pinia domain store (P8).
//
// Truth source for the session list, the active session id, and the pinned-id
// list. All writes funnel through the actions below (the facade's former
// rawState mutation helpers, moved verbatim). The facade bridges its rawState
// `sessions` / `activeSessionId` accessors to this store so legacy read sites
// keep working during the P9–P15 teardown; new code must use the store
// directly (see docs/specs/2026-08-01-renderer-architecture.md §5).

import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppSession } from '@moonshot-ai/app-core/api';
import {
  insertSessionByRecency,
  loadPinnedSessions,
  pinSessionId,
  savePinnedSessions,
  unpinSessionId,
} from '@moonshot-ai/app-core/lib';
import { clientPinia } from './pinia';

export const useSessionsStore = defineStore('kimi.sessions', () => {
  const sessions = ref<AppSession[]>([]);
  const activeSessionId = ref<string | undefined>(undefined);
  // Pinned sessions (sidebar section above all workspace groups). The id list
  // is the single source of truth: persisted to localStorage, ordered by the
  // user's drag arrangement, per-device by design (no server sync). Pin state
  // never lives on the session objects — every view derives it from this list.
  const pinnedSessionIds = ref<string[]>(loadPinnedSessions());

  // ---------------------------------------------------------------------------
  // sessions — single mutation funnel.
  // Every change to the session list goes through one of these actions, so
  // "where can sessions change?" has exactly one answer per intent.
  // ---------------------------------------------------------------------------
  function setSessions(next: AppSession[]): void {
    sessions.value = next;
  }
  /** Replace one session in place (matched by id); no-op if it isn't loaded. */
  function updateSession(id: string, update: (session: AppSession) => AppSession): void {
    sessions.value = sessions.value.map((s) => (s.id === id ? update(s) : s));
  }
  /** Add or replace a session in the pool, keeping updatedAt-desc order
   *  (de-duped by id). Position comes from the timestamp alone — callers never
   *  force the front (a restore/fork lands at its content time, not the top). */
  function upsertSessionSorted(session: AppSession): void {
    sessions.value = insertSessionByRecency(sessions.value, session);
  }
  /** Append a session to the end (e.g. a deep-linked older session). */
  function appendSession(session: AppSession): void {
    sessions.value = [...sessions.value, session];
  }
  /** Drop a session from the list by id. */
  function removeSession(id: string): void {
    sessions.value = sessions.value.filter((s) => s.id !== id);
  }

  /** Set the active session (or clear it with undefined). */
  function setActiveSessionId(id: string | undefined): void {
    activeSessionId.value = id;
  }

  // ---------------------------------------------------------------------------
  // Pins
  // ---------------------------------------------------------------------------
  /** Pin a session. New pins land at the END of the pinned section. */
  function pinSession(id: string): void {
    const next = pinSessionId(pinnedSessionIds.value, id);
    if (next === pinnedSessionIds.value) return;
    pinnedSessionIds.value = next;
    savePinnedSessions(next);
  }

  /** Unpin a session (no-op when it isn't pinned). */
  function unpinSession(id: string): void {
    const next = unpinSessionId(pinnedSessionIds.value, id);
    if (next === pinnedSessionIds.value) return;
    pinnedSessionIds.value = next;
    savePinnedSessions(next);
  }

  /** Unpin a batch of sessions (e.g. the backfill's stale-id cleanup). */
  function unpinSessions(ids: string[]): void {
    const stale = new Set(ids);
    const next = pinnedSessionIds.value.filter((id) => !stale.has(id));
    if (next.length === pinnedSessionIds.value.length) return;
    pinnedSessionIds.value = next;
    savePinnedSessions(next);
  }

  /** Toggle entry point for the session-row menu (pin ↔ unpin). */
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

/** Module-level-safe accessor: resolves the store against the package-held
 *  pinia instance, so import-time singleton code (the client composables) can
 *  call it before any app has installed the pinia plugin. */
export function sessionsStore() {
  return useSessionsStore(clientPinia);
}
