import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  MODEL_SWITCH_CONFIRM_CONFIG_NAME,
  parseModelSwitchConfirmConfig,
  type ModelSwitchAction,
  type ModelSwitchConfirmConfig,
} from '@moonshot-ai/app-core/lib';
import type { ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { getKimiWebApi } from '../client/deps';
import { clientPinia } from './pinia';

export interface ModelSwitchConfirmRequest {
  fromModel: string;
  toModel: string;
  sessionType: 'old' | 'new';
  hint?: string;
  warning?: string;
  resolve: (action: ModelSwitchAction) => void;
}

export type ModelSwitchCompactionOutcome = 'completed' | 'cancelled' | 'timeout' | 'request-failed';

export const useModelSwitchConfirmStore = defineStore('kimi.modelSwitchConfirm', () => {
  const config = ref<ModelSwitchConfirmConfig | undefined>(undefined);
  const pending = ref<ModelSwitchConfirmRequest | null>(null);

  let compactionWait: {
    sessionId: string;
    promise: Promise<ModelSwitchCompactionOutcome>;
    resolve: (outcome: ModelSwitchCompactionOutcome) => void;
  } | null = null;
  let loadState: 'idle' | 'loading' | 'settled' = 'idle';
  let refreshFlight: {
    signal?: AbortSignal;
    background: boolean;
    promise: Promise<void>;
  } | null = null;
  let latestRequest: object | null = null;

  async function refresh(options?: ReadRequestOptions): Promise<void> {
    const signal = options?.signal;
    const background = options?.background ?? true;
    if (
      refreshFlight !== null &&
      refreshFlight.signal === signal &&
      refreshFlight.background === background &&
      signal?.aborted !== true
    ) {
      return refreshFlight.promise;
    }
    config.value = undefined;
    loadState = 'loading';
    const requestId = {};
    latestRequest = requestId;
    const request = (async () => {
      try {
        const raw = await getKimiWebApi().getClientConfig(MODEL_SWITCH_CONFIRM_CONFIG_NAME, options);
        if (latestRequest === requestId) {
          config.value = raw === null ? undefined : parseModelSwitchConfirmConfig(raw);
        }
      } catch {
        if (latestRequest === requestId) config.value = undefined;
      }
    })();
    refreshFlight = { signal, background, promise: request };
    try {
      await request;
    } finally {
      if (latestRequest === requestId) loadState = 'settled';
      if (refreshFlight?.promise === request) refreshFlight = null;
    }
  }

  function needsLoad(): boolean {
    return config.value === undefined && loadState !== 'settled';
  }

  function peek(): ModelSwitchConfirmConfig | undefined {
    return config.value;
  }

  function requestConfirm(request: Omit<ModelSwitchConfirmRequest, 'resolve'>): Promise<ModelSwitchAction> {
    return new Promise((resolve) => {
      pending.value?.resolve('cancel');
      pending.value = { ...request, resolve };
    });
  }

  function settle(action: ModelSwitchAction): void {
    const current = pending.value;
    if (current === null) return;
    pending.value = null;
    current.resolve(action);
  }

  function waitCompactionSettled(sessionId: string, timeoutMs: number): Promise<ModelSwitchCompactionOutcome> {
    if (compactionWait?.sessionId === sessionId) return compactionWait.promise;
    compactionWait?.resolve('cancelled');
    let resolveWait!: (outcome: ModelSwitchCompactionOutcome) => void;
    const promise = new Promise<ModelSwitchCompactionOutcome>((resolve) => {
      resolveWait = resolve;
    });
    const timer = setTimeout(() => {
      if (compactionWait?.sessionId === sessionId) compactionWait = null;
      resolveWait('timeout');
    }, timeoutMs);
    compactionWait = {
      sessionId,
      promise,
      resolve: (outcome) => {
        clearTimeout(timer);
        compactionWait = null;
        resolveWait(outcome);
      },
    };
    return promise;
  }

  function noteCompactionSettled(
    sessionId: string,
    outcome: 'completed' | 'cancelled' | 'request-failed',
  ): void {
    if (compactionWait?.sessionId !== sessionId) return;
    compactionWait.resolve(outcome);
  }

  function hasCompactionWait(sessionId: string): boolean {
    return compactionWait?.sessionId === sessionId;
  }

  function resetForTest(): void {
    config.value = undefined;
    pending.value = null;
    compactionWait = null;
    loadState = 'idle';
    refreshFlight = null;
    latestRequest = null;
  }

  return {
    config,
    pending,
    refresh,
    needsLoad,
    peek,
    requestConfirm,
    settle,
    waitCompactionSettled,
    noteCompactionSettled,
    hasCompactionWait,
    resetForTest,
  };
});

export function modelSwitchConfirmStore() {
  return useModelSwitchConfirmStore(clientPinia);
}
