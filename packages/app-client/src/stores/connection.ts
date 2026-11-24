import { markRaw, ref, shallowRef } from 'vue';
import { defineStore } from 'pinia';
import type { KimiEventConnection } from '@moonshot-ai/app-core/api';
import type { ConnectionState } from '@moonshot-ai/app-core/client/types';
import { logWarn } from '@moonshot-ai/app-core/lib';
import { clientPinia } from './pinia';

const eventConn = shallowRef<KimiEventConnection | null>(null);

export function getEventConn(): KimiEventConnection | null {
  return eventConn.value;
}

export function setEventConn(next: KimiEventConnection | null): void {
  eventConn.value = next;
}

const SESSION_WORK_BASELINE_RETRY_MAX_MS = 30_000;

export interface SessionWorkBaselineRun {
  workEventSessions: Set<string>;
  titleEventSessions: Set<string>;
  pendingEventSourceBySession: Map<string, 'work' | 'interaction'>;
}

export const useConnectionStore = defineStore('kimi.connection', () => {
  const connected = ref(false);
  const connection = ref<ConnectionState>('disconnected');
  const connectionGeneration = ref(0);
  const wsEverConnected = ref(false);
  const wsDisconnectedAt = ref<number | null>(null);

  const eventCountBySession = markRaw(new Map<string, number>());

  const sessionWorkBaseline = markRaw({
    run: null as SessionWorkBaselineRun | null,
    attempts: 0,
    lastError: null as unknown,
    cooldownUntil: null as number | null,
    retryTimer: null as ReturnType<typeof setTimeout> | null,
  });

  function markConnecting(): void {
    connection.value = 'connecting';
  }

  function markConnected(): number | null {
    connected.value = true;
    connection.value = 'connected';
    connectionGeneration.value += 1;
    wsEverConnected.value = true;
    const disconnectedAt = wsDisconnectedAt.value;
    wsDisconnectedAt.value = null;
    return disconnectedAt;
  }

  function markDisconnected(): boolean {
    connected.value = false;
    connection.value = 'disconnected';
    const wasLive = wsEverConnected.value && wsDisconnectedAt.value === null;
    if (wasLive) wsDisconnectedAt.value = Date.now();
    sessionWorkBaseline.run = null;
    cancelSessionWorkBaselineRetry();
    sessionWorkBaseline.attempts = 0;
    sessionWorkBaseline.lastError = null;
    return wasLive;
  }

  function noteSessionEvent(sessionId: string): void {
    eventCountBySession.set(sessionId, sessionEventCount(sessionId) + 1);
  }

  function sessionEventCount(sessionId: string): number {
    return eventCountBySession.get(sessionId) ?? 0;
  }

  function beginSessionWorkBaseline(run: SessionWorkBaselineRun): void {
    sessionWorkBaseline.run = run;
  }

  function isSessionWorkBaselineCurrent(run: SessionWorkBaselineRun): boolean {
    return sessionWorkBaseline.run === run;
  }

  function clearSessionWorkBaseline(): void {
    sessionWorkBaseline.run = null;
  }

  function cancelSessionWorkBaselineRetry(): void {
    if (sessionWorkBaseline.retryTimer === null) return;
    clearTimeout(sessionWorkBaseline.retryTimer);
    sessionWorkBaseline.retryTimer = null;
    sessionWorkBaseline.cooldownUntil = null;
  }

  function scheduleSessionWorkBaselineRetry(error: unknown, retry: () => void): void {
    if (!connected.value || sessionWorkBaseline.retryTimer !== null) return;
    const delay = Math.min(
      SESSION_WORK_BASELINE_RETRY_MAX_MS,
      1000 * 2 ** sessionWorkBaseline.attempts,
    );
    sessionWorkBaseline.attempts += 1;
    sessionWorkBaseline.lastError = error;
    sessionWorkBaseline.cooldownUntil = Date.now() + delay;
    logWarn('[kimi-code] session work reconciliation incomplete; retrying', error);
    sessionWorkBaseline.retryTimer = setTimeout(() => {
      sessionWorkBaseline.retryTimer = null;
      sessionWorkBaseline.cooldownUntil = null;
      if (connected.value) retry();
    }, delay);
  }

  function resetSessionWorkBaselineBackoff(): void {
    sessionWorkBaseline.attempts = 0;
    sessionWorkBaseline.lastError = null;
  }

  function forgetSession(sessionId: string): void {
    eventCountBySession.delete(sessionId);
  }

  return {
    connected,
    connection,
    connectionGeneration,
    wsEverConnected,
    wsDisconnectedAt,
    eventCountBySession,
    sessionWorkBaseline,
    markConnecting,
    markConnected,
    markDisconnected,
    noteSessionEvent,
    sessionEventCount,
    beginSessionWorkBaseline,
    isSessionWorkBaselineCurrent,
    clearSessionWorkBaseline,
    cancelSessionWorkBaselineRetry,
    scheduleSessionWorkBaselineRetry,
    resetSessionWorkBaselineBackoff,
    forgetSession,
  };
});

export function connectionStore() {
  return useConnectionStore(clientPinia);
}
