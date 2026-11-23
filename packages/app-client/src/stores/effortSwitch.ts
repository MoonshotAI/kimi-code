import { ref } from 'vue';
import { defineStore } from 'pinia';
import {
  EFFORT_SWITCH_CONFIG_NAME,
  parseEffortSwitchConfig,
  type EffortSwitchAction,
  type EffortSwitchConfig,
} from '@moonshot-ai/app-core/lib';
import { clientPinia } from './pinia';
import { createClientConfigLoader } from './clientConfigLoader';

export interface EffortSwitchConfirmRequest {
  fromEffort: string;
  toEffort: string;
  sessionType: 'old' | 'new';
  hint?: string;
  warning?: string;
  resolve: (action: EffortSwitchAction) => void;
}

export const useEffortSwitchStore = defineStore('kimi.effortSwitch', () => {
  const {
    value: config,
    refresh,
    needsLoad,
    reset: resetConfig,
  } = createClientConfigLoader<EffortSwitchConfig>(
    EFFORT_SWITCH_CONFIG_NAME,
    parseEffortSwitchConfig,
  );
  const pending = ref<EffortSwitchConfirmRequest | null>(null);

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
    resetConfig();
    pending.value = null;
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
