import { ref, shallowReactive } from 'vue';
import { defineStore } from 'pinia';
import { clientPinia } from './pinia';

export interface SessionRuntime {
  pendingModel: number | undefined;
  subagentCardSerials: Map<string, number> | undefined;
}

function createSessionRuntime(): SessionRuntime {
  return {
    pendingModel: undefined,
    subagentCardSerials: undefined,
  };
}

export const useSessionRuntimeStore = defineStore('kimi.sessionRuntime', () => {
  const runtimes = shallowReactive(new Map<string, SessionRuntime>());

  const profileWriteChainBySid = new Map<string, Promise<boolean>>();

  const lastTurnReasonChangeBySession = ref<Record<string, number>>({});
  const forkInFlightBySession = ref<Record<string, boolean>>({});

  function runtimeFor(sessionId: string): SessionRuntime {
    let entry = runtimes.get(sessionId);
    if (entry === undefined) {
      entry = createSessionRuntime();
      runtimes.set(sessionId, entry);
    }
    return entry;
  }

  function peekRuntime(sessionId: string): SessionRuntime | undefined {
    return runtimes.get(sessionId);
  }

  let modelWriteSeq = 0;

  function markModelPending(sessionId: string): number {
    const token = ++modelWriteSeq;
    runtimeFor(sessionId).pendingModel = token;
    return token;
  }

  function ackModelPending(sessionId: string, token: number | undefined): void {
    const entry = runtimes.get(sessionId);
    if (token !== undefined && entry?.pendingModel === token) entry.pendingModel = undefined;
  }

  function dispose(sessionId: string): void {
    runtimes.delete(sessionId);
    delete lastTurnReasonChangeBySession.value[sessionId];
    delete forkInFlightBySession.value[sessionId];
  }

  function noteLastTurnReasonChange(sessionId: string): void {
    lastTurnReasonChangeBySession.value[sessionId] =
      (lastTurnReasonChangeBySession.value[sessionId] ?? 0) + 1;
  }

  return {
    runtimes,
    profileWriteChainBySid,
    lastTurnReasonChangeBySession,
    forkInFlightBySession,
    runtimeFor,
    peekRuntime,
    markModelPending,
    ackModelPending,
    dispose,
    noteLastTurnReasonChange,
  };
});

export function sessionRuntimeStore() {
  return useSessionRuntimeStore(clientPinia);
}
