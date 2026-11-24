import { nextTick, ref } from 'vue';
import { defineStore } from 'pinia';
import { setContextInspectorBetaOverride } from '@moonshot-ai/app-core';
import type {
  AppConfig,
  ServerExperimentalBeta,
  ServerExperimentalFeature,
} from '@moonshot-ai/app-core/api';
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

function buildActiveExperimentalFlags(
  rawFlags: Record<string, boolean>,
  features: readonly ServerExperimentalFeature[] | undefined,
): Record<string, boolean> {
  if (!features || features.length === 0) return rawFlags;
  const merged: Record<string, boolean> = { ...rawFlags };
  for (const feature of features) {
    merged[feature.id] = feature.effectTiming === 'restart' ? feature.active : feature.enabled;
  }
  return merged;
}

export const useConfigStore = defineStore('kimi.config', () => {
  const config = ref<AppConfig | null>(null);
  const serverVersion = ref('');
  const availableOpenInApps = ref<string[]>([]);
  const dangerousBypassAuth = ref(false);
  const experimentalFlags = ref<Record<string, boolean>>({});
  const experimentalBeta = ref<ServerExperimentalBeta | null>(null);
  const experimentalFeatures = ref<ServerExperimentalFeature[]>([]);
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
    const api = getKimiWebApi();
    if (typeof api.getMeta !== 'function') return;
    const m = await api.getMeta().catch((error) => {
      onError?.(error);
      return null;
    });
    if (!m) return;
    serverVersion.value = m.serverVersion;
    availableOpenInApps.value = m.openInApps;
    dangerousBypassAuth.value = m.dangerousBypassAuth;
    experimentalBeta.value = m.experimentalBeta ?? null;
    experimentalFeatures.value = m.experimentalFeatures ?? [];
    experimentalFlags.value = buildActiveExperimentalFlags(
      m.experimentalFlags ?? {},
      m.experimentalFeatures,
    );
    setContextInspectorBetaOverride(experimentalBeta.value?.enabled === true);
    backend.value = m.backend;
    webTitle.value = m.webTitle;
    homeDir.value = m.homeDir;
  }

  async function setExperimentalFlag(id: string, on: boolean): Promise<boolean> {
    const saved = await updateConfig({ experimental: { [id]: on } });
    if (!saved) return false;
    const existing = experimentalFeatures.value.find((feature) => feature.id === id);
    if (existing?.effectTiming !== 'restart') {
      experimentalFlags.value = { ...experimentalFlags.value, [id]: on };
    }
    if (existing !== undefined) {
      experimentalFeatures.value = experimentalFeatures.value.map((feature) =>
        feature.id === id
          ? {
              ...feature,
              enabled: on,
              active: feature.effectTiming === 'restart' ? feature.active : on,
              source: 'config',
              configValue: on,
            }
          : feature,
      );
    }
    await refreshServerMeta();
    return true;
  }

  async function setBetaFeaturesEnabled(on: boolean): Promise<boolean> {
    const saved = await updateConfig({ experimental: { beta: on } });
    if (!saved) return false;
    experimentalBeta.value = {
      enabled: on,
      source: 'config',
      env: experimentalBeta.value?.env ?? 'KIMI_CODE_EXPERIMENTAL_FLAG',
      configValue: on,
    };
    setContextInspectorBetaOverride(on);
    experimentalFeatures.value = experimentalFeatures.value.map((feature) => {
      if (feature.stage !== 'beta' || feature.source === 'env') return feature;
      const nextEnabled = on ? true : (feature.configValue ?? false);
      return {
        ...feature,
        enabled: nextEnabled,
        active: feature.effectTiming === 'restart' ? feature.active : nextEnabled,
        source: on ? 'beta-config' : feature.configValue !== undefined ? 'config' : 'default',
      };
    });
    experimentalFlags.value = buildActiveExperimentalFlags(
      experimentalFlags.value,
      experimentalFeatures.value,
    );
    await refreshServerMeta();
    return true;
  }

  async function setNotifyUserEnabled(on: boolean): Promise<boolean> {
    return setExperimentalFlag('notify_user', on);
  }

  function resetConfig(): void {
    config.value = null;
    serverVersion.value = '';
    availableOpenInApps.value = [];
    dangerousBypassAuth.value = false;
    experimentalFlags.value = {};
    experimentalBeta.value = null;
    experimentalFeatures.value = [];
    setContextInspectorBetaOverride(false);
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
    experimentalBeta,
    experimentalFeatures,
    backend,
    webTitle,
    homeDir,
    noteConfigWrite,
    loadConfig,
    updateConfig,
    setExperimentalFlag,
    setBetaFeaturesEnabled,
    setNotifyUserEnabled,
    refreshServerMeta,
    resetConfig,
  };
});

export function configStore() {
  return useConfigStore(clientPinia);
}
