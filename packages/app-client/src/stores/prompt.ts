import { computed, reactive, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppMessage } from '@moonshot-ai/app-core/api';
import { warningsStore } from './warnings';
import type { PromptEnvelope, QueuedPrompt } from '../client/types';
import { clientPinia } from './pinia';

const steerChainBySession = new Map<string, Promise<unknown>>();

export function chainSteer<T>(sid: string, fn: () => Promise<T>): Promise<T> {
  const prev = steerChainBySession.get(sid) ?? Promise.resolve();
  const run = prev.catch(() => undefined).then(fn);
  steerChainBySession.set(sid, run);
  return run;
}

export function isCurrentSteerChain(sid: string, promise: Promise<unknown>): boolean {
  return steerChainBySession.get(sid) === promise;
}

export const usePromptStore = defineStore('kimi.prompt', () => {
  const queuedBySession = ref<Record<string, QueuedPrompt[]>>({});
  const inFlightBySession = ref<Record<string, boolean>>({});
  const optimisticMessagesBySession = ref<Record<string, AppMessage[]>>({});
  const heldFirstPromptBySession = ref<Record<string, AppMessage>>({});
  const draftEntry = ref<'newChat' | 'workspace'>('newChat');
  const draftEntryNonce = ref(0);

  const queueFlushFailures = new Map<string, { key: string; count: number }>();
  const compactFlushHeldSessions = new Set<string>();
  const unsettledCompactionSessions = new Set<string>();
  const autoCompactedAtBySession = new Map<string, number>();
  const steerInFlightCounts = new Map<string, number>();
  const startingFirstPromptWorkspaces = reactive(new Set<string>());
  let queueEntryCounter = 0;

  const isStartingFirstPrompt = computed(() => startingFirstPromptWorkspaces.size > 0);

  function nextQueueEntryId(): string {
    queueEntryCounter += 1;
    return `${Date.now().toString(36)}-${queueEntryCounter}`;
  }

  function enqueueForSession(sid: string, prompt: PromptEnvelope, editText?: string): void {
    const current = queuedBySession.value[sid] ?? [];
    const entry = {
      ...prompt,
      editText,
      enqueuedAt: Date.now(),
      id: nextQueueEntryId(),
    };
    queuedBySession.value = {
      ...queuedBySession.value,
      [sid]: [...current, entry],
    };
  }

  function enqueueCompactForSession(sid: string, instruction?: string): void {
    const current = queuedBySession.value[sid] ?? [];
    const entry: QueuedPrompt = {
      text: instruction === undefined || instruction === '' ? '/compact' : `/compact ${instruction}`,
      attachments: [],
      skills: [],
      kind: 'compact',
      instruction,
      enqueuedAt: Date.now(),
      id: nextQueueEntryId(),
    };
    queuedBySession.value = {
      ...queuedBySession.value,
      [sid]: [...current, entry],
    };
  }

  function hasQueuedCompact(sid: string): boolean {
    return (queuedBySession.value[sid] ?? []).some((entry) => entry.kind === 'compact');
  }

  function removeQueuedAt(
    sid: string,
    index: number,
  ): { previousHead: QueuedPrompt | undefined; nextHead: QueuedPrompt | undefined } | null {
    const current = queuedBySession.value[sid] ?? [];
    if (index < 0 || index >= current.length) return null;
    const next = [...current];
    next.splice(index, 1);
    queuedBySession.value = { ...queuedBySession.value, [sid]: next };
    return { previousHead: current[0], nextHead: next[0] };
  }

  function moveQueued(
    sid: string,
    from: number,
    to: number,
  ): { previousHead: QueuedPrompt | undefined; nextHead: QueuedPrompt | undefined } | null {
    const current = queuedBySession.value[sid] ?? [];
    if (from === to) return null;
    if (from < 0 || from >= current.length || to < 0 || to >= current.length) return null;
    const next = [...current];
    const [moved] = next.splice(from, 1);
    if (moved === undefined) return null;
    next.splice(to, 0, moved);
    queuedBySession.value = { ...queuedBySession.value, [sid]: next };
    return { previousHead: current[0], nextHead: next[0] };
  }

  function setQueuedEntries(sid: string, entries: QueuedPrompt[]): void {
    queuedBySession.value = { ...queuedBySession.value, [sid]: entries };
  }

  function dropQueueHead(sid: string): QueuedPrompt | undefined {
    const [next, ...rest] = queuedBySession.value[sid] ?? [];
    if (next === undefined) return undefined;
    queuedBySession.value = { ...queuedBySession.value, [sid]: rest };
    return next;
  }

  function restoreQueueEntry(sid: string, entry: QueuedPrompt, index = 0): void {
    const current = queuedBySession.value[sid] ?? [];
    const restored = [...current];
    restored.splice(Math.min(index, restored.length), 0, entry);
    queuedBySession.value = { ...queuedBySession.value, [sid]: restored };
  }

  function queueFlushFailureFor(sid: string): { key: string; count: number } | undefined {
    return queueFlushFailures.get(sid);
  }

  function noteQueueFlushFailure(sid: string, key: string, count: number): void {
    queueFlushFailures.set(sid, { key, count });
  }

  function clearQueueFlushFailure(sid: string): void {
    queueFlushFailures.delete(sid);
  }

  function holdCompactFlush(sid: string): void {
    compactFlushHeldSessions.add(sid);
  }

  function releaseCompactFlush(sid: string): boolean {
    return compactFlushHeldSessions.delete(sid);
  }

  function isCompactFlushHeld(sid: string): boolean {
    return compactFlushHeldSessions.has(sid);
  }

  function noteCompactionStarted(sid: string): void {
    unsettledCompactionSessions.add(sid);
  }

  function noteCompactionSettled(sid: string): void {
    unsettledCompactionSessions.delete(sid);
  }

  function hasUnsettledCompaction(sid: string): boolean {
    return unsettledCompactionSessions.has(sid);
  }

  function noteAutoCompacted(sid: string): void {
    autoCompactedAtBySession.set(sid, Date.now());
  }

  function autoCompactedAt(sid: string): number | undefined {
    return autoCompactedAtBySession.get(sid);
  }

  function noteSteerStart(sid: string): void {
    steerInFlightCounts.set(sid, (steerInFlightCounts.get(sid) ?? 0) + 1);
  }

  function noteSteerSettled(sid: string): void {
    const count = steerInFlightCounts.get(sid) ?? 0;
    if (count <= 1) steerInFlightCounts.delete(sid);
    else steerInFlightCounts.set(sid, count - 1);
  }

  function isSteerInFlight(sid: string): boolean {
    return (steerInFlightCounts.get(sid) ?? 0) > 0;
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

  function holdFirstPrompt(sid: string, message: AppMessage): void {
    heldFirstPromptBySession.value = { ...heldFirstPromptBySession.value, [sid]: message };
  }

  function releaseHeldFirstPrompt(sid: string): AppMessage | undefined {
    const held = heldFirstPromptBySession.value[sid];
    if (held === undefined) return undefined;
    const next = { ...heldFirstPromptBySession.value };
    delete next[sid];
    heldFirstPromptBySession.value = next;
    return held;
  }

  function hasHeldFirstPrompt(sid: string): boolean {
    return heldFirstPromptBySession.value[sid] !== undefined;
  }

  function tryBeginStartingFirstPrompt(workspaceId: string): boolean {
    if (startingFirstPromptWorkspaces.has(workspaceId)) return false;
    startingFirstPromptWorkspaces.add(workspaceId);
    return true;
  }

  function endStartingFirstPrompt(workspaceId: string): void {
    startingFirstPromptWorkspaces.delete(workspaceId);
  }

  function setDraftEntry(entry: 'newChat' | 'workspace'): void {
    draftEntry.value = entry;
    draftEntryNonce.value += 1;
  }

  function forgetPromptState(sid: string): void {
    queueFlushFailures.delete(sid);
    compactFlushHeldSessions.delete(sid);
    unsettledCompactionSessions.delete(sid);
    autoCompactedAtBySession.delete(sid);
    steerInFlightCounts.delete(sid);
    steerChainBySession.delete(sid);
    releaseHeldFirstPrompt(sid);
  }

  function forgetLocalTurnState(sid: string): void {
    forgetPromptState(sid);
    warningsStore().forgetSessionWarnings(sid);
  }

  function clearQueued(sid: string): void {
    if (queuedBySession.value[sid] === undefined) return;
    const next = { ...queuedBySession.value };
    delete next[sid];
    queuedBySession.value = next;
  }

  function clearInFlight(sid: string): void {
    if (inFlightBySession.value[sid] === undefined) return;
    const next = { ...inFlightBySession.value };
    delete next[sid];
    inFlightBySession.value = next;
  }

  return {
    queuedBySession,
    inFlightBySession,
    optimisticMessagesBySession,
    heldFirstPromptBySession,
    draftEntry,
    draftEntryNonce,
    isStartingFirstPrompt,
    enqueueForSession,
    enqueueCompactForSession,
    hasQueuedCompact,
    removeQueuedAt,
    moveQueued,
    setQueuedEntries,
    dropQueueHead,
    restoreQueueEntry,
    queueFlushFailureFor,
    noteQueueFlushFailure,
    clearQueueFlushFailure,
    holdCompactFlush,
    releaseCompactFlush,
    isCompactFlushHeld,
    noteCompactionStarted,
    noteCompactionSettled,
    hasUnsettledCompaction,
    noteAutoCompacted,
    autoCompactedAt,
    noteSteerStart,
    noteSteerSettled,
    isSteerInFlight,
    setInFlight,
    addOptimisticMessage,
    setOptimisticMessages,
    removeOptimisticMessage,
    patchOptimisticMessage,
    clearOptimisticMessages,
    holdFirstPrompt,
    releaseHeldFirstPrompt,
    hasHeldFirstPrompt,
    tryBeginStartingFirstPrompt,
    endStartingFirstPrompt,
    setDraftEntry,
    forgetPromptState,
    forgetLocalTurnState,
    clearQueued,
    clearInFlight,
  };
});

export function promptStore() {
  return usePromptStore(clientPinia);
}
