// apps/kimi-web/src/composables/client/useModelProviderState.ts
// Models, providers, starred/favorite models, the active-session thinking
// level, session-scoped slash skills, and the managed OAuth device flow.
// Owns the lazy-loaded model/provider caches plus the new-session "draft"
// model pick. Cross-dependencies (failure reporting, status refresh, activity,
// in-flight set, thinking storage) are injected by the facade.

import { ref, type ComputedRef } from 'vue';
import { getKimiWebApi } from '../../api';
import type { AppMessage, AppModel, AppProvider, AppSession, AppSkill, ThinkingLevel } from '../../api/types';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';
import { coerceThinkingForModel } from '../../lib/modelThinking';
import type { ActivityState } from '../../types';
import type { ExtendedState } from '../useKimiWebClient';

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

export interface PersistSessionProfilePatch {
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  swarmMode?: boolean;
  goalObjective?: string;
  goalControl?: 'pause' | 'resume' | 'cancel';
  thinking?: string;
}

export interface UseModelProviderStateDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  refreshSessionStatus: (sessionId: string) => Promise<void>;
  persistSessionProfile: (patch: PersistSessionProfilePatch) => void;
  activity: ComputedRef<ActivityState>;
  inFlightPromptSessions: Set<string>;
  saveThinkingToStorage: (v: ThinkingLevel) => void;
  /** Replace one session in place (matched by id). Owned by the facade so the
   *  model module never assigns rawState.sessions directly. */
  updateSession: (id: string, update: (session: AppSession) => AppSession) => void;
  /** Update one session's message list via a function of the current list. */
  updateSessionMessages: (
    sessionId: string,
    update: (messages: AppMessage[]) => AppMessage[],
  ) => void;
}

export function useModelProviderState(
  rawState: ExtendedState,
  deps: UseModelProviderStateDeps,
) {
  const {
    pushOperationFailure,
    refreshSessionStatus,
    persistSessionProfile,
    activity,
    inFlightPromptSessions,
    saveThinkingToStorage,
    updateSession,
    updateSessionMessages,
  } = deps;

  // Models + Providers reactive state (lazy-loaded, cached)
  const models = ref<AppModel[]>([]);
  const starredModelIds = ref<string[]>(loadStarredModelsFromStorage());

  // Session-scoped skills (slash-invocable). Loaded lazily per session; the active
  // session's list feeds the composer's `/` menu.
  const skillsBySession = ref<Record<string, AppSkill[]>>({});
  const providers = ref<AppProvider[]>([]);

  // Model picked while in the "new session draft" state (onboarding composer —
  // no backend session exists yet, so POST /profile has nothing to target).
  // Applied and cleared when the first prompt creates the session.
  const draftModel = ref<string | null>(null);

  function modelById(modelId: string | null | undefined): AppModel | undefined {
    if (modelId === undefined || modelId === null || modelId.length === 0) return undefined;
    return models.value.find((m) => m.id === modelId || m.model === modelId);
  }

  function activeThinkingModel(): AppModel | undefined {
    const activeSession = rawState.activeSessionId
      ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
      : undefined;
    return modelById(activeSession?.model ?? draftModel.value ?? rawState.defaultModel);
  }

  function applyThinkingLevel(level: ThinkingLevel): ThinkingLevel {
    const next = coerceThinkingForModel(activeThinkingModel(), level);
    rawState.thinking = next;
    saveThinkingToStorage(next);
    return next;
  }

  async function loadSkillsForSession(sessionId: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      const list = await api.listSkills(sessionId);
      skillsBySession.value = { ...skillsBySession.value, [sessionId]: list };
    } catch {
      // Skills are side data; an older daemon without /skills just yields no
      // slash-skills, the built-in commands still work.
    }
  }

  /** Load models (cached — call again to force refresh) */
  async function loadModels(): Promise<void> {
    try {
      const api = getKimiWebApi();
      models.value = await api.listModels();
      applyThinkingLevel(rawState.thinking);
    } catch (err) {
      pushOperationFailure('loadModels', err);
    }
  }

  async function refreshOAuthProviderModels(): Promise<void> {
    try {
      const result = await getKimiWebApi().refreshOAuthProviderModels();
      for (const failure of result.failed) {
        pushOperationFailure('refreshOAuthProviderModels', new Error(failure.reason), {
          message: failure.provider,
        });
      }
    } catch {
      // Older daemons may not expose this endpoint; model listing still works.
    }
  }

  /** Load providers */
  async function loadProviders(): Promise<void> {
    try {
      const api = getKimiWebApi();
      providers.value = await api.listProviders();
    } catch (err) {
      pushOperationFailure('loadProviders', err);
    }
  }

  /**
   * Switch model for the active session via POST /sessions/{id}/profile (the
   * daemon dispatches agent_config.model to core.rpc.setModel). The profile echo
   * can return model '', so the authoritative current model comes from
   * GET /sessions/{id}/status, which we re-read right after. Optimistically show
   * the chosen id meanwhile. Never crashes.
   */
  async function setModel(modelId: string): Promise<void> {
    const sid = rawState.activeSessionId;
    const nextThinking = coerceThinkingForModel(modelById(modelId), rawState.thinking);
    const prevThinking = rawState.thinking;
    if (!sid) {
      // New-session draft (onboarding composer): no backend session to update.
      // Remember the pick — startSessionAndSendPrompt applies it at create time.
      draftModel.value = modelId;
      applyThinkingLevel(nextThinking);
      return;
    }
    // Optimistic: show the chosen model immediately, but remember the previous
    // one so we can roll back if the switch never reaches the daemon.
    const prevModel = rawState.sessions.find((s) => s.id === sid)?.model;
    updateSession(sid, (s) => ({ ...s, model: modelId }));
    if (nextThinking !== prevThinking) {
      rawState.thinking = nextThinking;
      saveThinkingToStorage(nextThinking);
    }
    try {
      await getKimiWebApi().updateSession(sid, {
        model: modelId,
        thinking: nextThinking !== prevThinking ? nextThinking : undefined,
      });
    } catch (err) {
      // The model change rides HTTP, not the WS, so a dropped socket alone does
      // not fail it — but when the daemon is unreachable the request throws here.
      // Roll the picker back to the real model so the UI can't keep showing the
      // new one as if the switch succeeded, then surface the failure.
      updateSession(sid, (s) => ({ ...s, model: prevModel ?? s.model }));
      if (nextThinking !== prevThinking) {
        rawState.thinking = prevThinking;
        saveThinkingToStorage(prevThinking);
      }
      pushOperationFailure('setModel', err, { sessionId: sid });
      return;
    }
    // refreshSessionStatus folds the authoritative current model from /status
    // back into the session (the profile echo can return ''). Best-effort: a
    // failure here does not mean the switch failed, so it must not roll back.
    await refreshSessionStatus(sid);
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

  /**
   * Activate a session skill (the web analogue of typing `/<skill> <args>` in the
   * TUI). The daemon starts a turn with a `skill_activation` origin; progress
   * arrives over the WS stream like any other turn. Never crashes the caller.
   */
  async function activateSkill(skillName: string, args?: string): Promise<void> {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const guarded = activity.value === 'idle' && !inFlightPromptSessions.has(sid);
    const tempId = `msg_skill_opt_${Date.now().toString(36)}`;

    if (guarded) {
      inFlightPromptSessions.add(sid);
      rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: true };
      const optimisticMsg: AppMessage = {
        id: tempId,
        sessionId: sid,
        role: 'user',
        content: [{ type: 'text', text: `/${skillName}${args ? ` ${args}` : ''}` }],
        createdAt: new Date().toISOString(),
        metadata: {
          'kimiWeb.optimisticUserMessage': true,
          origin: {
            kind: 'skill_activation',
            trigger: 'user-slash',
            skillName,
            skillArgs: args,
          },
        },
      };
      updateSessionMessages(sid, (msgs) => [...msgs, optimisticMsg]);
    }

    try {
      await getKimiWebApi().activateSkill(sid, skillName, args);
    } catch (err) {
      if (guarded) {
        inFlightPromptSessions.delete(sid);
        rawState.sendingBySession = { ...rawState.sendingBySession, [sid]: false };
        updateSessionMessages(sid, (msgs) => msgs.filter((m) => m.id !== tempId));
      }
      pushOperationFailure('activateSkill', err, { sessionId: sid });
    }
  }

  /** Add a provider, then reload providers + models */
  async function addProvider(input: {
    type: string;
    apiKey?: string;
    baseUrl?: string;
    defaultModel?: string;
  }): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.addProvider(input);
      await Promise.all([loadProviders(), loadModels()]);
    } catch (err) {
      pushOperationFailure('addProvider', err);
    }
  }

  /** Delete a provider, then reload providers + models */
  async function deleteProvider(id: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.deleteProvider(id);
      await Promise.all([loadProviders(), loadModels()]);
    } catch (err) {
      pushOperationFailure('deleteProvider', err);
    }
  }

  /** Refresh a single provider's remote model metadata, then reload caches. */
  async function refreshProvider(id: string): Promise<void> {
    try {
      const result = await getKimiWebApi().refreshProvider(id);
      for (const failure of result.failed) {
        pushOperationFailure('refreshProvider', new Error(failure.reason), {
          message: failure.provider,
        });
      }
      await Promise.all([loadProviders(), loadModels()]);
    } catch (err) {
      pushOperationFailure('refreshProvider', err);
    }
  }

  /** Refresh every refreshable provider's remote model metadata, then reload caches. */
  async function refreshAllProviders(): Promise<void> {
    try {
      const result = await getKimiWebApi().refreshAllProviders();
      for (const failure of result.failed) {
        pushOperationFailure('refreshAllProviders', new Error(failure.reason), {
          message: failure.provider,
        });
      }
      await Promise.all([loadProviders(), loadModels()]);
    } catch (err) {
      pushOperationFailure('refreshAllProviders', err);
    }
  }

  /** Start managed Kimi OAuth device flow. Returns flow data or null on error. */
  async function startOAuthLogin(): Promise<{
    flowId: string;
    provider: string;
    verificationUri: string;
    verificationUriComplete: string;
    userCode: string;
    expiresIn: number;
    interval: number;
    status: 'pending';
    expiresAt: string;
  } | null> {
    try {
      const api = getKimiWebApi();
      return await api.startOAuthLogin();
    } catch {
      return null;
    }
  }

  /** Poll the singleton OAuth flow. Returns null on error or no active flow. */
  async function pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null> {
    try {
      const api = getKimiWebApi();
      return await api.pollOAuthLogin();
    } catch {
      return null;
    }
  }

  /** Cancel the current OAuth flow (best-effort). */
  async function cancelOAuthLogin(): Promise<void> {
    try {
      const api = getKimiWebApi();
      await api.cancelOAuthLogin();
    } catch {
      // Best-effort
    }
  }

  /** Persist and apply a new extended-thinking level (also pushed to the active
   *  session profile so the daemon's /status reflects it; still sent per-prompt). */
  function setThinking(level: ThinkingLevel): void {
    const next = applyThinkingLevel(level);
    persistSessionProfile({ thinking: next });
  }

  return {
    // state
    models,
    starredModelIds,
    providers,
    draftModel,
    skillsBySession,
    // actions
    loadSkillsForSession,
    loadModels,
    refreshOAuthProviderModels,
    loadProviders,
    setModel,
    toggleStarModel,
    activateSkill,
    addProvider,
    deleteProvider,
    refreshProvider,
    refreshAllProviders,
    startOAuthLogin,
    pollOAuthLogin,
    cancelOAuthLogin,
    setThinking,
  };
}

export type UseModelProviderState = ReturnType<typeof useModelProviderState>;
