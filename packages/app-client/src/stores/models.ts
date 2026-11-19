
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppCatalogProvider, AppModel, AppProvider, AppSkill, ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { PROVIDER_PRESETS, safeGetString, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { getDeviceApi, getKimiWebApi } from '../client/deps';
import { resolveChatModel } from '../lib/chatGate';
import { clientPinia } from './pinia';

const STARRED_MODELS_STORAGE_KEY = STORAGE_KEYS.starredModels;

function loadStarredModelsFromStorage(): string[] {
  try {
    const raw = safeGetString(STARRED_MODELS_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((item) => typeof item === 'string')) {
      return parsed as string[];
    }
  } catch {}
  return [];
}

function saveStarredModelsToStorage(v: string[]): void {
  try {
    safeSetString(STARRED_MODELS_STORAGE_KEY, JSON.stringify(v));
  } catch {}
}

export const useModelsStore = defineStore('kimi.models', () => {
  const models = ref<AppModel[]>([]);
  const starredModelIds = ref<string[]>(loadStarredModelsFromStorage());
  const providers = ref<AppProvider[]>([]);

  const skillsBySession = ref<Record<string, AppSkill[]>>({});
  const skillsByWorkspace = ref<Record<string, AppSkill[]>>({});
  const skillsFetchedBySession = ref<Record<string, true>>({});
  const skillsFetchedByWorkspace = ref<Record<string, true>>({});
  type SkillsRequest = { signal?: AbortSignal; promise: Promise<boolean> };
  const skillsFetchInflightSession = new Map<string, SkillsRequest>();
  const skillsFetchInflightWorkspace = new Map<string, SkillsRequest>();

  const draftModel = ref<string | null>(null);

  const defaultModel = ref<string | null>(null);
  const modelsReady = ref(false);

  const activeDeviceId = ref<string | undefined>(undefined);
  const modelsByDevice = ref<Record<string, AppModel[]>>({});
  const defaultModelByDevice = ref<Record<string, string | null>>({});
  const activeModels = computed(() =>
    activeDeviceId.value === undefined ? models.value : modelsByDevice.value[activeDeviceId.value] ?? [],
  );
  const activeDefaultModel = computed(() =>
    activeDeviceId.value === undefined ? defaultModel.value : defaultModelByDevice.value[activeDeviceId.value] ?? null,
  );

  const catalogProviders = ref<AppCatalogProvider[]>([]);
  const catalogState = ref<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const PRESET_CATALOG_IDS = new Set(
    PROVIDER_PRESETS.flatMap((p) => [p.catalogId, ...(p.catalogIds ?? [])]),
  );

  async function loadCatalogProviders(): Promise<void> {
    if (catalogState.value === 'loading') return;
    catalogState.value = 'loading';
    try {
      const items = await getKimiWebApi().listCatalogProviders();
      catalogProviders.value = items.filter((e) => PRESET_CATALOG_IDS.has(e.id));
      catalogState.value = 'ready';
    } catch {
      catalogState.value = 'error';
    }
  }

  const hasModels = computed(() => models.value.length > 0);

  function resolveSendModel(sessionModel?: string | null, opts?: { includeDraft?: boolean }): string | null {
    return resolveChatModel(
      sessionModel,
      opts?.includeDraft === true ? draftModel.value : null,
      activeDefaultModel.value,
      activeModels.value,
    );
  }

  function setActiveDevice(deviceId: string | undefined): void {
    activeDeviceId.value = deviceId;
  }

  async function loadDeviceCatalog(deviceId: string): Promise<void> {
    const api = getDeviceApi(deviceId);
    const [list, config] = await Promise.all([api.listModels(), api.getConfig()]);
    modelsByDevice.value = { ...modelsByDevice.value, [deviceId]: list };
    defaultModelByDevice.value = { ...defaultModelByDevice.value, [deviceId]: config.defaultModel ?? null };
  }

  function setDeviceDefaultModel(deviceId: string, id: string | null): void {
    defaultModelByDevice.value = { ...defaultModelByDevice.value, [deviceId]: id };
  }

  function removeDevices(deviceIds: readonly string[]): void {
    if (deviceIds.length === 0) return;
    const removed = new Set(deviceIds);
    if (activeDeviceId.value !== undefined && removed.has(activeDeviceId.value)) {
      activeDeviceId.value = undefined;
    }
    let modelsChanged = false;
    const nextModels = { ...modelsByDevice.value };
    let defaultsChanged = false;
    const nextDefaults = { ...defaultModelByDevice.value };
    for (const deviceId of removed) {
      if (Object.prototype.hasOwnProperty.call(nextModels, deviceId)) {
        delete nextModels[deviceId];
        modelsChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(nextDefaults, deviceId)) {
        delete nextDefaults[deviceId];
        defaultsChanged = true;
      }
    }
    if (modelsChanged) modelsByDevice.value = nextModels;
    if (defaultsChanged) defaultModelByDevice.value = nextDefaults;
  }

  function setModels(next: AppModel[]): void {
    models.value = next;
  }

  function setProviders(next: AppProvider[]): void {
    providers.value = next;
  }

  function setDraftModel(id: string | null): void {
    draftModel.value = id;
  }

  function setDefaultModel(id: string | null): void {
    defaultModel.value = id;
  }

  function setModelsReady(ready: boolean): void {
    modelsReady.value = ready;
  }

  function setSkillsForSession(sessionId: string, list: AppSkill[]): void {
    skillsBySession.value = { ...skillsBySession.value, [sessionId]: list };
  }

  function setSkillsForWorkspace(workspaceId: string, list: AppSkill[]): void {
    skillsByWorkspace.value = { ...skillsByWorkspace.value, [workspaceId]: list };
  }

  function invalidateSkillsForSession(sessionId: string): void {
    skillsFetchInflightSession.delete(sessionId);
    const cached = { ...skillsBySession.value };
    delete cached[sessionId];
    skillsBySession.value = cached;
    const fetched = { ...skillsFetchedBySession.value };
    delete fetched[sessionId];
    skillsFetchedBySession.value = fetched;
  }

  function invalidateSkillsForWorkspace(workspaceId: string): void {
    skillsFetchInflightWorkspace.delete(workspaceId);
    const cached = { ...skillsByWorkspace.value };
    delete cached[workspaceId];
    skillsByWorkspace.value = cached;
    const fetched = { ...skillsFetchedByWorkspace.value };
    delete fetched[workspaceId];
    skillsFetchedByWorkspace.value = fetched;
  }

  function toggleStarModel(modelId: string): void {
    const set = new Set(starredModelIds.value);
    if (set.has(modelId)) {
      set.delete(modelId);
    } else {
      set.add(modelId);
    }
    starredModelIds.value = Array.from(set);
    saveStarredModelsToStorage(starredModelIds.value);
  }

  function loadSkillsForSession(sessionId: string, options?: ReadRequestOptions): Promise<boolean> {
    if (options?.signal?.aborted) return Promise.resolve(false);
    const existing = skillsFetchInflightSession.get(sessionId);
    if (existing && !existing.signal?.aborted && (!existing.signal || existing.signal === options?.signal)) {
      return existing.promise;
    }
    const request: SkillsRequest = { signal: options?.signal, promise: Promise.resolve(false) };
    skillsFetchInflightSession.set(sessionId, request);
    const fetching = { ...skillsFetchedBySession.value };
    delete fetching[sessionId];
    skillsFetchedBySession.value = fetching;
    request.promise = (async (): Promise<boolean> => {
      let cancelled = false;
      try {
        const api = getKimiWebApi();
        const list = await (options === undefined
          ? api.listSkills(sessionId)
          : api.listSkills(sessionId, options));
        if (request.signal?.aborted || skillsFetchInflightSession.get(sessionId) !== request) {
          return false;
        }
        setSkillsForSession(sessionId, list);
        return true;
      } catch (error) {
        cancelled = error instanceof Error && error.name === 'AbortError';
        return false;
      } finally {
        if (skillsFetchInflightSession.get(sessionId) === request) {
          skillsFetchInflightSession.delete(sessionId);
          if (!request.signal?.aborted && !cancelled) {
            skillsFetchedBySession.value = { ...skillsFetchedBySession.value, [sessionId]: true };
          }
        }
      }
    })();
    return request.promise;
  }

  function loadSkillsForWorkspace(workspaceId: string, options?: ReadRequestOptions): Promise<boolean> {
    if (options?.signal?.aborted) return Promise.resolve(false);
    const existing = skillsFetchInflightWorkspace.get(workspaceId);
    if (existing && !existing.signal?.aborted && (!existing.signal || existing.signal === options?.signal)) {
      return existing.promise;
    }
    const request: SkillsRequest = { signal: options?.signal, promise: Promise.resolve(false) };
    skillsFetchInflightWorkspace.set(workspaceId, request);
    const fetching = { ...skillsFetchedByWorkspace.value };
    delete fetching[workspaceId];
    skillsFetchedByWorkspace.value = fetching;
    request.promise = (async (): Promise<boolean> => {
      let cancelled = false;
      try {
        const api = getKimiWebApi();
        const list = await (options === undefined
          ? api.listSkillsForWorkspace(workspaceId)
          : api.listSkillsForWorkspace(workspaceId, options));
        if (request.signal?.aborted || skillsFetchInflightWorkspace.get(workspaceId) !== request) {
          return false;
        }
        setSkillsForWorkspace(workspaceId, list);
        return true;
      } catch (error) {
        cancelled = error instanceof Error && error.name === 'AbortError';
        return false;
      } finally {
        if (skillsFetchInflightWorkspace.get(workspaceId) === request) {
          skillsFetchInflightWorkspace.delete(workspaceId);
          if (!request.signal?.aborted && !cancelled) {
            skillsFetchedByWorkspace.value = { ...skillsFetchedByWorkspace.value, [workspaceId]: true };
          }
        }
      }
    })();
    return request.promise;
  }

  return {
    models,
    starredModelIds,
    providers,
    draftModel,
    defaultModel,
    modelsReady,
    hasModels,
    activeDeviceId,
    activeModels,
    activeDefaultModel,
    setActiveDevice,
    loadDeviceCatalog,
    setDeviceDefaultModel,
    removeDevices,
    resolveSendModel,
    catalogProviders,
    catalogState,
    loadCatalogProviders,
    skillsBySession,
    skillsByWorkspace,
    skillsFetchedBySession,
    skillsFetchedByWorkspace,
    setModels,
    setProviders,
    setDraftModel,
    setDefaultModel,
    setModelsReady,
    setSkillsForSession,
    setSkillsForWorkspace,
    invalidateSkillsForSession,
    invalidateSkillsForWorkspace,
    toggleStarModel,
    loadSkillsForSession,
    loadSkillsForWorkspace,
  };
});

export function modelsStore() {
  return useModelsStore(clientPinia);
}
