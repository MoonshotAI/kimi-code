import { nextTick, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppConfig } from '@moonshot-ai/app-core/api';
import { isDaemonApiError } from '@moonshot-ai/app-core/api';
import { permissionModeFromConfig } from '@moonshot-ai/app-core/lib';
import type { PermissionMode } from '@moonshot-ai/app-core/client/types';
import { getKimiWebApi } from '../client/deps';
import { clientPinia } from './pinia';
import { modelsStore } from './models';
import { permissionsStore } from './permissions';

export interface ConfigHooks {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
}

let configHooks: ConfigHooks | null = null;

export function setConfigHooks(next: ConfigHooks | null): void {
  configHooks = next;
}

export const useConfigStore = defineStore('kimi.config', () => {
  const config = ref<AppConfig | null>(null);
  const serverVersion = ref('');
  const availableOpenInApps = ref<string[]>([]);
  const dangerousBypassAuth = ref(false);
  const experimentalFlags = ref<Record<string, boolean>>({});
  const backend = ref<'v1' | 'v2'>('v1');
  const webTitle = ref('');
  const homeDir = ref('');

  let configWriteGeneration = 0;
  let configCommittedGeneration = 0;
  let configWriteCommittedGeneration = 0;
  let configWriteQueue: Promise<unknown> = Promise.resolve();

  function noteConfigWrite(): void {
    const generation = ++configWriteGeneration;
    configCommittedGeneration = generation;
    configWriteCommittedGeneration = generation;
  }

  async function loadConfig(onError?: (error: unknown) => void): Promise<'committed' | 'superseded' | 'failed'> {
    const generation = ++configWriteGeneration;
    try {
      const api = getKimiWebApi();
      const next = await api.getConfig();
      if (generation <= configCommittedGeneration) return 'superseded';
      configCommittedGeneration = generation;
      config.value = next;
      modelsStore().setDefaultModel(next.defaultModel ?? null);
      return 'committed';
    } catch (error) {
      onError?.(error);
      return 'failed';
    }
  }

  async function updateConfig(patch: Partial<AppConfig>): Promise<boolean> {
    const defaultWriteStamp =
      patch.defaultPermissionMode !== undefined
        ? permissionsStore().noteDaemonDefaultWriteInitiated(
            patch.defaultPermissionMode as PermissionMode,
          )
        : 0;
    const run = configWriteQueue.then(() => updateConfigNow(patch, defaultWriteStamp));
    configWriteQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async function updateConfigNow(
    patch: Partial<AppConfig>,
    defaultWriteStamp: number,
  ): Promise<boolean> {
    const generation = ++configWriteGeneration;
    try {
      const api = getKimiWebApi();
      const next = await api.setConfig(patch);
      if (generation > configWriteCommittedGeneration) {
        configWriteCommittedGeneration = generation;
        configCommittedGeneration = Math.max(configCommittedGeneration, generation);
        config.value = next;
        modelsStore().setDefaultModel(next.defaultModel ?? null);
      }
      await nextTick();
      if (defaultWriteStamp !== 0) {
        permissionsStore().consumeDaemonDefaultWriteStamp(defaultWriteStamp);
      }
      return true;
    } catch (err) {
      if (defaultWriteStamp !== 0) {
        if (isDaemonApiError(err)) {
          permissionsStore().clearDaemonDefaultWriteInitiated(defaultWriteStamp);
        } else {
          void configWriteQueue.then(async () => {
            let delivered = (await loadConfig()) !== 'failed';
            if (!delivered) {
              await new Promise((resolve) => setTimeout(resolve, 2_000));
              delivered = (await loadConfig()) !== 'failed';
            }
            if (!delivered) return;
            permissionsStore().reconcileDaemonDefaultWriteStamps(
              permissionModeFromConfig(config.value?.defaultPermissionMode),
            );
          });
        }
      }
      configHooks?.pushOperationFailure('setConfig', err);
      return false;
    }
  }

  async function refreshServerMeta(onError?: (error: unknown) => void): Promise<void> {
    const m = await getKimiWebApi()
      .getMeta()
      .catch((error) => {
        onError?.(error);
        return null;
      });
    if (m === null) return;
    serverVersion.value = m.serverVersion;
    availableOpenInApps.value = m.openInApps;
    dangerousBypassAuth.value = m.dangerousBypassAuth;
    experimentalFlags.value = m.experimentalFlags;
    backend.value = m.backend;
    webTitle.value = m.webTitle;
    homeDir.value = m.homeDir;
  }

  async function setNotifyUserEnabled(on: boolean): Promise<boolean> {
    const saved = await updateConfig({ experimental: { notify_user: on } });
    if (saved) {
      experimentalFlags.value = { ...experimentalFlags.value, notify_user: on };
    }
    return saved;
  }

  async function setPromptPredictionEnabled(on: boolean): Promise<boolean> {
    const saved = await updateConfig({ experimental: { prompt_prediction: on } });
    if (saved) {
      experimentalFlags.value = { ...experimentalFlags.value, prompt_prediction: on };
    }
    return saved;
  }

  function resetConfig(): void {
    config.value = null;
    serverVersion.value = '';
    availableOpenInApps.value = [];
    dangerousBypassAuth.value = false;
    experimentalFlags.value = {};
    backend.value = 'v1';
    webTitle.value = '';
    homeDir.value = '';
    configWriteGeneration = 0;
    configCommittedGeneration = 0;
    configWriteCommittedGeneration = 0;
    configWriteQueue = Promise.resolve();
  }

  return {
    config,
    serverVersion,
    availableOpenInApps,
    dangerousBypassAuth,
    experimentalFlags,
    backend,
    webTitle,
    homeDir,
    noteConfigWrite,
    loadConfig,
    updateConfig,
    setNotifyUserEnabled,
    setPromptPredictionEnabled,
  refreshServerMeta,
    resetConfig,
  };
});

export function configStore() {
  return useConfigStore(clientPinia);
}
