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
  hint?: string;
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

  async function refresh(options?: ReadRequestOptions): Promise<void> {
    try {
      const raw = await getKimiWebApi().getClientConfig(MODEL_SWITCH_CONFIRM_CONFIG_NAME, options);
      config.value = raw === null ? undefined : parseModelSwitchConfirmConfig(raw);
    } catch {
      config.value = undefined;
    }
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
  }

  return {
    config,
    pending,
    refresh,
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
