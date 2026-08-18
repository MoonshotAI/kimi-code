// Models domain store (P10).
//
// Truth source for the lazy-loaded model/provider caches, the starred-model
// list (persisted), session/workspace-scoped slash skills, and the new-session
// "draft" model pick. The heavy actions that orchestrate daemon calls and
// facade callbacks (setModel / activateSkill / provider CRUD / OAuth / …) stay
// in client/useModelProviderState.ts — they read and write this store, exactly
// like the workspace-state module does with the sessions store.

import { ref } from 'vue';
import { defineStore } from 'pinia';
import type { AppModel, AppProvider, AppSkill } from '@moonshot-ai/app-core/api';
import { safeGetString, safeSetString, STORAGE_KEYS } from '@moonshot-ai/app-core/lib';
import { getKimiWebApi } from '../client/deps';
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
  } catch {
    // ignore (localStorage not available or malformed)
  }
  return [];
}

function saveStarredModelsToStorage(v: string[]): void {
  try {
    safeSetString(STARRED_MODELS_STORAGE_KEY, JSON.stringify(v));
  } catch {
    // ignore
  }
}

export const useModelsStore = defineStore('kimi.models', () => {
  // Models + Providers reactive state (lazy-loaded, cached)
  const models = ref<AppModel[]>([]);
  const starredModelIds = ref<string[]>(loadStarredModelsFromStorage());
  const providers = ref<AppProvider[]>([]);

  // Session-scoped skills (slash-invocable). Loaded lazily per session; the active
  // session's list feeds the composer's `/` menu.
  const skillsBySession = ref<Record<string, AppSkill[]>>({});
  // Workspace-scoped skills, used to populate the `/` menu before a session exists
  // (onboarding composer). Keyed by workspace id; loaded once per workspace.
  const skillsByWorkspace = ref<Record<string, AppSkill[]>>({});

  // Model picked while in the "new session draft" state (onboarding composer —
  // no backend session exists yet, so POST /profile has nothing to target).
  // Applied and cleared when the first prompt creates the session.
  const draftModel = ref<string | null>(null);

  function setModels(next: AppModel[]): void {
    models.value = next;
  }

  function setProviders(next: AppProvider[]): void {
    providers.value = next;
  }

  function setDraftModel(id: string | null): void {
    draftModel.value = id;
  }

  function setSkillsForSession(sessionId: string, list: AppSkill[]): void {
    skillsBySession.value = { ...skillsBySession.value, [sessionId]: list };
  }

  function setSkillsForWorkspace(workspaceId: string, list: AppSkill[]): void {
    skillsByWorkspace.value = { ...skillsByWorkspace.value, [workspaceId]: list };
  }

  /** Toggle whether a model is starred (favorited) in the model picker. */
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

  async function loadSkillsForSession(sessionId: string): Promise<void> {
    try {
      const list = await getKimiWebApi().listSkills(sessionId);
      setSkillsForSession(sessionId, list);
    } catch {
      // Skills are side data; an older daemon without /skills just yields no
      // slash-skills, the built-in commands still work.
    }
  }

  async function loadSkillsForWorkspace(workspaceId: string): Promise<void> {
    try {
      const list = await getKimiWebApi().listSkillsForWorkspace(workspaceId);
      setSkillsForWorkspace(workspaceId, list);
    } catch {
      // Side data; an older daemon without /workspaces/{id}/skills just yields
      // no slash-skills for the onboarding composer.
    }
  }

  return {
    models,
    starredModelIds,
    providers,
    draftModel,
    skillsBySession,
    skillsByWorkspace,
    setModels,
    setProviders,
    setDraftModel,
    setSkillsForSession,
    setSkillsForWorkspace,
    toggleStarModel,
    loadSkillsForSession,
    loadSkillsForWorkspace,
  };
});

/** Module-level-safe accessor: resolves the store against the package-held
 *  pinia instance, so import-time singleton code (the client composables) can
 *  call it before any app has installed the pinia plugin. */
export function modelsStore() {
  return useModelsStore(clientPinia);
}
