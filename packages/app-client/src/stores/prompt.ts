import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppMessage, AppQueuedInput } from '@moonshot-ai/app-core/api';
import { warningsStore } from './warnings';
import { clientPinia } from './pinia';

export const usePromptStore = defineStore('kimi.prompt', () => {
  const queueBySession = ref<Record<string, readonly AppQueuedInput[]>>({});
  const confirmedQueueBySession = new Map<string, readonly AppQueuedInput[]>();
  const queueSnapshotWaiters = new Map<string, Set<string>>();

  const inFlightBySession = ref<Record<string, boolean>>({});
  const optimisticMessagesBySession = ref<Record<string, AppMessage[]>>({});
  const draftEntry = ref<'newChat' | 'workspace'>('newChat');
  const draftEntryNonce = ref(0);

  const unsettledCompactionSessions = new Set<string>();
  const startingFirstPromptWorkspaces = reactive(new Set<string>());
  const continueStartingSessions = reactive(new Set<string>());
  const continueStartingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const compactStartingSessions = reactive(new Set<string>());
  const compactStartingTimers = new Map<string, ReturnType<typeof setTimeout>>();

  const isStartingFirstPrompt = computed(() => startingFirstPromptWorkspaces.size > 0);

  function showQueue(sid: string, inputs: readonly AppQueuedInput[]): void {
    queueBySession.value = { ...queueBySession.value, [sid]: inputs };
  }

  function restoreConfirmedQueue(sid: string): void {
    const confirmed = confirmedQueueBySession.get(sid);
    if (confirmed !== undefined) showQueue(sid, confirmed);
  }

  function confirmQueueMove(sid: string, promptId: string, beforePromptId: string | undefined): void {
    const moved = movedQueue(confirmedQueueBySession.get(sid) ?? [], promptId, beforePromptId);
    if (moved !== undefined) confirmedQueueBySession.set(sid, moved);
  }

  function awaitQueueSnapshots(): void {
    queueSnapshotWaiters.clear();
    for (const [sid, messages] of Object.entries(optimisticMessagesBySession.value)) {
      const accepted = messages.flatMap((message) =>
        message.metadata?.['kimiWeb.queued'] === true ? [message.metadata['kimiWeb.promptId'] as string] : [],
      );
      if (accepted.length > 0) queueSnapshotWaiters.set(sid, new Set(accepted));
    }
  }

  function setQueue(sid: string, inputs: readonly AppQueuedInput[]): void {
    const withdrawn = queueSnapshotWaiters.get(sid);
    queueSnapshotWaiters.delete(sid);
    if (inputs.length === 0) clearQueue(sid);
    else {
      confirmedQueueBySession.set(sid, inputs);
      showQueue(sid, inputs);
    }
    const current = optimisticMessagesBySession.value[sid];
    if (current === undefined) return;
    const listed = new Set(inputs.map((input) => input.promptId));
    const remaining = current.filter((message) => {
      const promptId = message.metadata?.['kimiWeb.promptId'] as string;
      if (listed.has(promptId)) return message.metadata?.['kimiWeb.steered'] === true;
      return withdrawn?.has(promptId) !== true;
    });
    if (remaining.length !== current.length) setOptimisticMessages(sid, remaining);
  }

  function dropQueueEntry(sid: string, promptId: string): void {
    const confirmed = confirmedQueueBySession.get(sid);
    if (confirmed !== undefined) confirmedQueueBySession.set(sid, confirmed.filter((entry) => entry.promptId !== promptId));
    const shown = queueBySession.value[sid];
    if (shown !== undefined) showQueue(sid, shown.filter((entry) => entry.promptId !== promptId));
  }

  function noteCompactionStarted(sid: string): void {
    settleCompactStart(sid);
    unsettledCompactionSessions.add(sid);
  }

  function noteCompactionSettled(sid: string): void {
    settleCompactStart(sid);
    unsettledCompactionSessions.delete(sid);
  }

  function hasUnsettledCompaction(sid: string): boolean {
    return unsettledCompactionSessions.has(sid);
  }

  function setInFlight(sid: string, value: boolean): void {
    inFlightBySession.value = { ...inFlightBySession.value, [sid]: value };
  }

  function addOptimisticMessage(sid: string, message: AppMessage): void {
    optimisticMessagesBySession.value = {
      ...optimisticMessagesBySession.value,
      [sid]: [...(optimisticMessagesBySession.value[sid] ?? []), message],
    };
  }

  function setOptimisticMessages(sid: string, messages: AppMessage[]): void {
    const next = { ...optimisticMessagesBySession.value };
    if (messages.length > 0) next[sid] = messages;
    else delete next[sid];
    optimisticMessagesBySession.value = next;
  }

  function removeOptimisticMessage(sid: string, id: string): void {
    const remaining = (optimisticMessagesBySession.value[sid] ?? []).filter((m) => m.id !== id);
    const next = { ...optimisticMessagesBySession.value };
    if (remaining.length > 0) next[sid] = remaining;
    else delete next[sid];
    optimisticMessagesBySession.value = next;
  }

  function patchOptimisticMessage(sid: string, id: string, patch: Record<string, unknown>): void {
    const current = optimisticMessagesBySession.value[sid];
    if (current === undefined) return;
    optimisticMessagesBySession.value = {
      ...optimisticMessagesBySession.value,
      [sid]: current.map((m) => (m.id === id ? { ...m, metadata: { ...m.metadata, ...patch } } : m)),
    };
  }

  function clearOptimisticMessages(sid: string): void {
    if (optimisticMessagesBySession.value[sid] === undefined) return;
    const next = { ...optimisticMessagesBySession.value };
    delete next[sid];
    optimisticMessagesBySession.value = next;
  }

  function tryBeginStartingFirstPrompt(workspaceId: string): boolean {
    if (startingFirstPromptWorkspaces.has(workspaceId)) return false;
    startingFirstPromptWorkspaces.add(workspaceId);
    return true;
  }

  function endStartingFirstPrompt(workspaceId: string): void {
    startingFirstPromptWorkspaces.delete(workspaceId);
  }

  function clearTimedSession(
    sessions: Set<string>,
    timers: Map<string, ReturnType<typeof setTimeout>>,
    sid: string,
  ): void {
    const existing = timers.get(sid);
    if (existing !== undefined) {
      clearTimeout(existing);
      timers.delete(sid);
    }
    sessions.delete(sid);
  }

  function armTimedSession(
    sessions: Set<string>,
    timers: Map<string, ReturnType<typeof setTimeout>>,
    sid: string,
    ms: number,
  ): void {
    const existing = timers.get(sid);
    if (existing !== undefined) clearTimeout(existing);
    sessions.add(sid);
    timers.set(
      sid,
      setTimeout(() => {
        timers.delete(sid);
        sessions.delete(sid);
      }, ms),
    );
  }

  function beginContinueTurnStart(sid: string): void {
    armTimedSession(continueStartingSessions, continueStartingTimers, sid, 2000);
  }

  function settleContinueTurnStart(sid: string): void {
    clearTimedSession(continueStartingSessions, continueStartingTimers, sid);
  }

  function isContinueTurnStarting(sid: string): boolean {
    return continueStartingSessions.has(sid);
  }

  function beginCompactStart(sid: string): void {
    clearTimedSession(compactStartingSessions, compactStartingTimers, sid);
    compactStartingSessions.add(sid);
  }

  function holdCompactStartGrace(sid: string): void {
    if (!compactStartingSessions.has(sid)) return;
    armTimedSession(compactStartingSessions, compactStartingTimers, sid, 500);
  }

  function settleCompactStart(sid: string): void {
    clearTimedSession(compactStartingSessions, compactStartingTimers, sid);
  }

  function isCompactStarting(sid: string): boolean {
    return compactStartingSessions.has(sid);
  }

  function setDraftEntry(entry: 'newChat' | 'workspace'): void {
    draftEntry.value = entry;
    draftEntryNonce.value += 1;
  }

  function forgetPromptState(sid: string): void {
    unsettledCompactionSessions.delete(sid);
    settleContinueTurnStart(sid);
    settleCompactStart(sid);
  }

  function forgetLocalTurnState(sid: string): void {
    forgetPromptState(sid);
    warningsStore().forgetSessionWarnings(sid);
  }

  function clearQueue(sid: string): void {
    confirmedQueueBySession.delete(sid);
    if (queueBySession.value[sid] === undefined) return;
    const next = { ...queueBySession.value };
    delete next[sid];
    queueBySession.value = next;
  }

  function clearInFlight(sid: string): void {
    if (inFlightBySession.value[sid] === undefined) return;
    const next = { ...inFlightBySession.value };
    delete next[sid];
    inFlightBySession.value = next;
  }

  return {
    queueBySession,
    inFlightBySession,
    optimisticMessagesBySession,
    draftEntry,
    draftEntryNonce,
    isStartingFirstPrompt,
    setQueue,
    showQueue,
    dropQueueEntry,
    confirmQueueMove,
    awaitQueueSnapshots,
    restoreConfirmedQueue,
    noteCompactionStarted,
    noteCompactionSettled,
    hasUnsettledCompaction,
    setInFlight,
    addOptimisticMessage,
    setOptimisticMessages,
    removeOptimisticMessage,
    patchOptimisticMessage,
    clearOptimisticMessages,
    tryBeginStartingFirstPrompt,
    endStartingFirstPrompt,
    beginContinueTurnStart,
    settleContinueTurnStart,
    isContinueTurnStarting,
    beginCompactStart,
    holdCompactStartGrace,
    settleCompactStart,
    isCompactStarting,
    setDraftEntry,
    forgetPromptState,
    forgetLocalTurnState,
    clearQueue,
    clearInFlight,
  };
});

export function movedQueue(
  queue: readonly AppQueuedInput[],
  promptId: string,
  beforePromptId: string | undefined,
): AppQueuedInput[] | undefined {
  const moved = queue.find((entry) => entry.promptId === promptId);
  if (moved === undefined) return undefined;
  const rest = queue.filter((entry) => entry !== moved);
  const index = beforePromptId === undefined ? rest.length : rest.findIndex((entry) => entry.promptId === beforePromptId);
  if (index < 0) return undefined;
  return [...rest.slice(0, index), moved, ...rest.slice(index)];
}

export function promptStore() {
  return usePromptStore(clientPinia);
}
