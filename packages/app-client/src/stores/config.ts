import { nextTick, ref } from 'vue';
import { defineStore } from 'pinia';
import { setContextInspectorEnabled, setSessionMentions } from '@moonshot-ai/app-core';
import type {
  AppConfig,
  ServerExperimentalBeta,
  ServerExperimentalFeature,
} from '@moonshot-ai/app-core/api';
import { isDaemonApiError } from '@moonshot-ai/app-core/api';
import {
  STORAGE_KEYS,
  permissionModeFromConfig,
  safeGetJson,
  safeGetString,
  safeRemove,
  safeSetString,
} from '@moonshot-ai/app-core/lib';
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

const LEGACY_LOCAL_EXPERIMENTAL_ENTRIES = [
  {
    id: 'context_inspector',
    storageKey: STORAGE_KEYS.contextInspector,
    trueLiteral: 'true',
  },
  {
    id: 'session_mentions',
    storageKey: STORAGE_KEYS.sessionMentions,
    trueLiteral: '1',
  },
] as const;

function syncLegacyLocalExperimentalKey(
  id: string,
  on: boolean,
  serverOwnsFeature: boolean,
): void {
  for (const entry of LEGACY_LOCAL_EXPERIMENTAL_ENTRIES) {
    if (entry.id !== id) continue;
    if (serverOwnsFeature || !on) {
      safeRemove(entry.storageKey);
    } else {
      safeSetString(entry.storageKey, entry.trueLiteral);
    }
  }
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

interface LegacyLocalExperimentalMigrationPlan {
  readonly patch: Record<string, boolean>;
  readonly clearImmediately: string[];
}

function planLegacyLocalExperimentalMigration(
  features: readonly ServerExperimentalFeature[] | undefined,
): LegacyLocalExperimentalMigrationPlan {
  const patch: Record<string, boolean> = {};
  const clearImmediately: string[] = [];
  if (!features || features.length === 0) {
    return { patch, clearImmediately };
  }
  for (const entry of LEGACY_LOCAL_EXPERIMENTAL_ENTRIES) {
    const raw = safeGetString(entry.storageKey);
    if (raw === null) continue;
    const feature = features.find((item) => item.id === entry.id);
    if (feature === undefined) continue;
    if (feature.configValue !== undefined || raw !== entry.trueLiteral) {
      clearImmediately.push(entry.storageKey);
      continue;
    }
    patch[entry.id] = true;
  }
  return { patch, clearImmediately };
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
  let metaRequestGeneration = 0;
  let metaCommittedGeneration = 0;
  let storeEpoch = 0;
  let pendingLegacyMigrationPatch: Record<string, boolean> = {};
  let legacyLocalMigrationInFlight: Promise<void> | null = null;

  function syncClientExperimentalSignals(): void {
    const contextFeature = experimentalFeatures.value.find(
      (feature) => feature.id === 'context_inspector',
    );
    const contextEnabled =
      contextFeature !== undefined
        ? contextFeature.enabled
        : experimentalBeta.value?.enabled === true ||
          experimentalFlags.value['context_inspector'] === true ||
          safeGetJson<boolean>(STORAGE_KEYS.contextInspector) === true;
    setContextInspectorEnabled(contextEnabled);

    const mentionsFeature = experimentalFeatures.value.find(
      (feature) => feature.id === 'session_mentions',
    );
    const mentionsEnabled =
      mentionsFeature !== undefined
        ? mentionsFeature.enabled
        : experimentalFlags.value['session_mentions'] === true ||
          safeGetString(STORAGE_KEYS.sessionMentions) === '1';
    setSessionMentions(mentionsEnabled);
  }

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

  function enqueueLegacyLocalExperimentalMigration(patch: Record<string, boolean>): void {
    for (const [id, enabled] of Object.entries(patch)) {
      if (enabled) pendingLegacyMigrationPatch[id] = true;
    }
  }

  function drainLegacyLocalExperimentalMigration(): Promise<void> {
    if (legacyLocalMigrationInFlight !== null) {
      return legacyLocalMigrationInFlight;
    }
    const epochAtStart = storeEpoch;
    let task: Promise<void> | null = null;
    task = (async () => {
      try {
        while (epochAtStart === storeEpoch) {
          const batch = pendingLegacyMigrationPatch;
          pendingLegacyMigrationPatch = {};
          const activePatch: Record<string, boolean> = {};
          const keysToRemove: string[] = [];
          for (const entry of LEGACY_LOCAL_EXPERIMENTAL_ENTRIES) {
            if (
              batch[entry.id] === true &&
              safeGetString(entry.storageKey) === entry.trueLiteral
            ) {
              activePatch[entry.id] = true;
              keysToRemove.push(entry.storageKey);
            }
          }
          if (Object.keys(activePatch).length === 0) break;
          const saved = await updateConfig({ experimental: activePatch });
          if (!saved || epochAtStart !== storeEpoch) break;
          for (const key of keysToRemove) {
            safeRemove(key);
          }
          await refreshServerMeta(undefined, { fromMigration: true });
        }
      } finally {
        if (legacyLocalMigrationInFlight === task) {
          legacyLocalMigrationInFlight = null;
        }
      }
    })();
    legacyLocalMigrationInFlight = task;
    return task;
  }

  async function refreshServerMeta(
    onError?: (error: unknown) => void,
    options?: { fromMigration?: boolean },
  ): Promise<void> {
    const api = getKimiWebApi();
    if (typeof api.getMeta !== 'function') return;
    const generation = ++metaRequestGeneration;
    const m = await Promise.resolve()
      .then(() => api.getMeta())
      .catch((error) => {
        onError?.(error);
        return null;
      });
    if (!m || generation <= metaCommittedGeneration) return;
    metaCommittedGeneration = generation;
    serverVersion.value = m.serverVersion;
    availableOpenInApps.value = m.openInApps;
    dangerousBypassAuth.value = m.dangerousBypassAuth;
    experimentalBeta.value = m.experimentalBeta ?? null;

    const migrationPlan = planLegacyLocalExperimentalMigration(m.experimentalFeatures);
    for (const key of migrationPlan.clearImmediately) {
      safeRemove(key);
    }

    const rawFeatures = m.experimentalFeatures ?? [];
    experimentalFeatures.value =
      Object.keys(migrationPlan.patch).length > 0
        ? rawFeatures.map((feature) => {
            if (migrationPlan.patch[feature.id] !== true) return feature;
            if (feature.source === 'env') {
              return { ...feature, configValue: true };
            }
            return {
              ...feature,
              enabled: true,
              active: feature.effectTiming === 'restart' ? feature.active : true,
              source:
                feature.stage === 'beta' && experimentalBeta.value?.enabled === true
                  ? feature.source
                  : 'config',
              configValue: true,
            };
          })
        : rawFeatures;
    experimentalFlags.value = buildActiveExperimentalFlags(
      m.experimentalFlags ?? {},
      experimentalFeatures.value,
    );
    syncClientExperimentalSignals();
    backend.value = m.backend;
    webTitle.value = m.webTitle;
    homeDir.value = m.homeDir;

    if (Object.keys(migrationPlan.patch).length > 0) {
      enqueueLegacyLocalExperimentalMigration(migrationPlan.patch);
      if (!options?.fromMigration) {
        await drainLegacyLocalExperimentalMigration();
      }
    }
  }

  async function setExperimentalFlag(id: string, on: boolean): Promise<boolean> {
    const saved = await updateConfig({ experimental: { [id]: on } });
    if (!saved) return false;
    const existing = experimentalFeatures.value.find((feature) => feature.id === id);
    syncLegacyLocalExperimentalKey(id, on, existing !== undefined);
    metaCommittedGeneration = ++metaRequestGeneration;
    if (existing?.effectTiming !== 'restart' || !on) {
      experimentalFlags.value = { ...experimentalFlags.value, [id]: on };
    }
    if (existing !== undefined) {
      experimentalFeatures.value = experimentalFeatures.value.map((feature) =>
        feature.id === id
          ? {
              ...feature,
              enabled: on,
              active: feature.effectTiming === 'restart' ? feature.active && on : on,
              source: 'config',
              configValue: on,
            }
          : feature,
      );
    }
    syncClientExperimentalSignals();
    await refreshServerMeta();
    return true;
  }

  async function setBetaFeaturesEnabled(on: boolean): Promise<boolean> {
    if (experimentalBeta.value === null) return false;
    const saved = await updateConfig({ experimental: { beta: on } });
    if (!saved) return false;
    metaCommittedGeneration = ++metaRequestGeneration;
    experimentalBeta.value = {
      enabled: on,
      source: 'config',
      env: experimentalBeta.value?.env ?? 'KIMI_CODE_EXPERIMENTAL_FLAG',
      configValue: on,
    };
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
    syncClientExperimentalSignals();
    await refreshServerMeta();
    return true;
  }

  async function setNotifyUserEnabled(on: boolean): Promise<boolean> {
    return setExperimentalFlag('notify_user', on);
  }

  async function setPromptPredictionEnabled(on: boolean): Promise<boolean> {
    return setExperimentalFlag('prompt_prediction', on);
  }

  function resetConfig(): void {
    storeEpoch += 1;
    pendingLegacyMigrationPatch = {};
    legacyLocalMigrationInFlight = null;
    config.value = null;
    serverVersion.value = '';
    availableOpenInApps.value = [];
    dangerousBypassAuth.value = false;
    experimentalFlags.value = {};
    experimentalBeta.value = null;
    experimentalFeatures.value = [];
    syncClientExperimentalSignals();
    backend.value = 'v1';
    webTitle.value = '';
    homeDir.value = '';
    configWriteGeneration = 0;
    configCommittedGeneration = 0;
    configWriteCommittedGeneration = 0;
    configWriteQueue = Promise.resolve();
    metaCommittedGeneration = ++metaRequestGeneration;
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
    setPromptPredictionEnabled,
    refreshServerMeta,
    resetConfig,
  };
});

export function configStore() {
  return useConfigStore(clientPinia);
}
