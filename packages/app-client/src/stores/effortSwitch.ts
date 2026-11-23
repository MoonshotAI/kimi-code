import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  EFFORT_SWITCH_CONFIG_NAME,
  parseEffortSwitchConfig,
  type EffortSwitchAction,
  type EffortSwitchConfig,
} from '@moonshot-ai/app-core/lib';
import type { ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { getKimiWebApi } from '../client/deps';
import { clientPinia } from './pinia';

export interface EffortSwitchConfirmRequest {
  fromEffort: string;
  toEffort: string;
  sessionType: 'old' | 'new';
  hint?: string;
  warning?: string;
  resolve: (action: EffortSwitchAction) => void;
}

export const useEffortSwitchStore = defineStore('kimi.effortSwitch', () => {
  const config = ref<EffortSwitchConfig | undefined>(undefined);
  const pending = ref<EffortSwitchConfirmRequest | null>(null);

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
        const raw = await getKimiWebApi().getClientConfig(EFFORT_SWITCH_CONFIG_NAME, options);
        if (latestRequest === requestId) {
          config.value = raw === null ? undefined : parseEffortSwitchConfig(raw);
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

  function peek(): EffortSwitchConfig | undefined {
    return config.value;
  }

  function requestConfirm(request: Omit<EffortSwitchConfirmRequest, 'resolve'>): Promise<EffortSwitchAction> {
    return new Promise((resolve) => {
      pending.value?.resolve('cancel');
      pending.value = { ...request, resolve };
    });
  }

  function settle(action: EffortSwitchAction): void {
    const current = pending.value;
    if (current === null) return;
    pending.value = null;
    current.resolve(action);
  }

  function resetForTest(): void {
    config.value = undefined;
    pending.value = null;
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
    resetForTest,
  };
});

export function effortSwitchStore() {
  return useEffortSwitchStore(clientPinia);
}
