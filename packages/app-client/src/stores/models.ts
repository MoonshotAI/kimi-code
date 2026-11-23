
import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppCatalogProvider, AppModel, AppProvider, AppSkill, ReadRequestOptions } from '@moonshot-ai/app-core/api';
import { PROVIDER_PRESETS, safeGetJson, safeGetString, safeSetJson, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { getDeviceApi, getKimiWebApi } from '../client/deps';
import { resolveChatModel } from '../lib/chatGate';
import { clientPinia } from './pinia';

const STARRED_MODELS_STORAGE_KEY = STORAGE_KEYS.starredModels;
const RECENT_MODELS_STORAGE_KEY = STORAGE_KEYS.recentModels;
const RECENT_MODELS_HISTORY_LIMIT = 20;

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

function loadRecentModelsFromStorage(): string[] {
  const parsed = safeGetJson<unknown>(RECENT_MODELS_STORAGE_KEY);
  return Array.isArray(parsed) && parsed.every((item) => typeof item === 'string') ? parsed : [];
}

function saveRecentModelsToStorage(value: string[]): void {
  safeSetJson(RECENT_MODELS_STORAGE_KEY, value);
}

export const useModelsStore = defineStore('kimi.models', () => {
  const models = ref<AppModel[]>([]);
  const starredModelIds = ref<string[]>(loadStarredModelsFromStorage());
  const recentModelIds = ref<string[]>(loadRecentModelsFromStorage());
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

  const activeHostId = ref<string | undefined>(undefined);
  const modelsByHost = ref<Record<string, AppModel[]>>({});
  const defaultModelByHost = ref<Record<string, string | null>>({});
  const activeModels = computed(() =>
    activeHostId.value === undefined ? models.value : modelsByHost.value[activeHostId.value] ?? [],
  );
  const activeDefaultModel = computed(() =>
    activeHostId.value === undefined ? defaultModel.value : defaultModelByHost.value[activeHostId.value] ?? null,
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

  function setActiveHost(hostId: string | undefined): void {
    activeHostId.value = hostId;
  }

  async function loadHostCatalog(hostId: string): Promise<void> {
    const api = getDeviceApi(hostId);
    const [list, config] = await Promise.all([api.listModels(), api.getConfig()]);
    modelsByHost.value = { ...modelsByHost.value, [hostId]: list };
    defaultModelByHost.value = { ...defaultModelByHost.value, [hostId]: config.defaultModel ?? null };
  }

  function setHostDefaultModel(hostId: string, id: string | null): void {
    defaultModelByHost.value = { ...defaultModelByHost.value, [hostId]: id };
  }

  function removeHosts(hostIds: readonly string[]): void {
    if (hostIds.length === 0) return;
    const removed = new Set(hostIds);
    if (activeHostId.value !== undefined && removed.has(activeHostId.value)) {
      activeHostId.value = undefined;
    }
    let modelsChanged = false;
    const nextModels = { ...modelsByHost.value };
    let defaultsChanged = false;
    const nextDefaults = { ...defaultModelByHost.value };
    for (const hostId of removed) {
      if (Object.prototype.hasOwnProperty.call(nextModels, hostId)) {
        delete nextModels[hostId];
        modelsChanged = true;
      }
      if (Object.prototype.hasOwnProperty.call(nextDefaults, hostId)) {
        delete nextDefaults[hostId];
        defaultsChanged = true;
      }
    }
    if (modelsChanged) modelsByHost.value = nextModels;
    if (defaultsChanged) defaultModelByHost.value = nextDefaults;
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

  function noteRecentModel(modelId: string, previousModelId?: string): void {
    if (modelId.length === 0) return;
    const prioritized = [
      ...new Set(
        [modelId, previousModelId].filter(
          (id): id is string => id !== undefined && id.length > 0,
        ),
      ),
    ];
    const prioritizedSet = new Set(prioritized);
    recentModelIds.value = [
      ...prioritized,
      ...recentModelIds.value.filter((id) => !prioritizedSet.has(id)),
    ].slice(0, RECENT_MODELS_HISTORY_LIMIT);
    saveRecentModelsToStorage(recentModelIds.value);
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
    recentModelIds,
    providers,
    draftModel,
    defaultModel,
    modelsReady,
    hasModels,
    activeHostId,
    activeModels,
    activeDefaultModel,
    setActiveHost,
    loadHostCatalog,
    setHostDefaultModel,
    removeHosts,
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
    noteRecentModel,
    loadSkillsForSession,
    loadSkillsForWorkspace,
  };
});

export function modelsStore() {
  return useModelsStore(clientPinia);
}
