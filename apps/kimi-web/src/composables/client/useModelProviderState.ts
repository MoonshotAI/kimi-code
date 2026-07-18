// apps/kimi-web/src/composables/client/useModelProviderState.ts
// Models, providers, starred/favorite models, the active-session thinking
// level, session-scoped slash skills, and the managed OAuth device flow.
// Owns the lazy-loaded model/provider caches plus the new-session "draft"
// model pick. Cross-dependencies (failure reporting, status refresh, activity,
// in-flight set, thinking storage) are injected by the facade.

import { ref, watch, type ComputedRef } from 'vue';
import { getKimiWebApi } from '../../api';
import type {
  AppMessage,
  AppModel,
  AppProvider,
  AppSession,
  AppSkill,
  OAuthLoginStartResult,
  ThinkingLevel,
} from '../../api/types';
import { safeGetString, safeSetString, STORAGE_KEYS } from '../../lib/storage';
import {
  defaultThinkingLevelFor,
  levelDeclaredBy,
  thinkingLevelForModelSwitch,
  thinkingLevelToConfig,
} from '../../lib/modelThinking';
import { beginLocalTurn, settleLocalTurn } from './useWorkspaceState';
import type { ActivityState } from '../../types';
import type { ExtendedState } from '../useKimiWebClient';

const STARRED_MODELS_STORAGE_KEY = STORAGE_KEYS.starredModels;

/** Sentinel thrown to abort a skill activation when the prerequisite profile
 *  persist failed — persistSessionProfile already surfaced that failure, so
 *  the catch skips activating without reporting a second, synthetic error.
 *  (An actual Error instance: oxlint only-throw-error.) */
const PROFILE_PERSIST_FAILED = new Error('profile persist failed');

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
  /** Persist profile fields to the daemon. Resolves false (after surfacing the
   *  failure itself) when the daemon rejected the patch — awaited callers that
   *  order strictly after the profile must NOT proceed on false. */
  persistSessionProfile: (patch: PersistSessionProfilePatch, sessionId?: string) => Promise<boolean>;
  activity: ComputedRef<ActivityState>;
  /** Read the persisted thinking pick for a model (undefined = never picked
   *  for that model). Storage is keyed by model id. */
  loadThinkingForModel: (modelId: string) => ThinkingLevel | undefined;
  /** Persist an explicit thinking pick under the given model id. */
  saveThinkingToStorage: (modelId: string, level: ThinkingLevel) => void;
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
    loadThinkingForModel,
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
  // Workspace-scoped skills, used to populate the `/` menu before a session exists
  // (onboarding composer). Keyed by workspace id; loaded once per workspace.
  const skillsByWorkspace = ref<Record<string, AppSkill[]>>({});
  const providers = ref<AppProvider[]>([]);

  // Model picked while in the "new session draft" state (onboarding composer —
  // no backend session exists yet, so POST /profile has nothing to target).
  // Applied and cleared when the first prompt creates the session.
  const draftModel = ref<string | null>(null);

  function modelById(modelId: string | null | undefined): AppModel | undefined {
    if (modelId === undefined || modelId === null || modelId.length === 0) return undefined;
    // Prefer the exact id — model names can collide across providers.
    return (
      models.value.find((m) => m.id === modelId) ??
      models.value.find((m) => m.model === modelId)
    );
  }

  function currentModelId(): string | undefined {
    const activeSession = rawState.activeSessionId
      ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
      : undefined;
    const rawModel =
      activeSession === undefined
        ? draftModel.value ?? rawState.defaultModel
        : activeSession.model || rawState.defaultModel;
    return modelById(rawModel)?.id ?? rawModel ?? undefined;
  }

  /**
   * The level a model should run at: the user's stored pick for THIS model when
   * the model still declares it, else the model's catalog default. Validation
   * against the catalog entry is what keeps a stale or foreign level (picked
   * for another model, or dropped by a catalog update) from reaching the UI and
   * the daemon.
   */
  function thinkingLevelForModel(model: AppModel): ThinkingLevel {
    const stored = loadThinkingForModel(model.id);
    if (stored !== undefined && levelDeclaredBy(model, stored)) return stored;
    return defaultThinkingLevelFor(model);
  }

  /** thinkingLevelForModel by model id, for paths that submit a prompt for a
   *  session other than the active one (queued drain, steer): the level must
   *  come from the prompt's OWN model, not from rawState.thinking, which always
   *  tracks the active session's model. Undefined when the id is not in the
   *  catalog (caller falls back to the active value, same as before). */
  function thinkingLevelForModelId(modelId: string | undefined): ThinkingLevel | undefined {
    if (modelId === undefined) return undefined;
    const model = modelById(modelId);
    return model === undefined ? undefined : thinkingLevelForModel(model);
  }

  function applyThinkingLevel(level: ThinkingLevel | undefined): ThinkingLevel | undefined {
    // The explicit-picker path (setThinking) — the ONLY writer of thinking
    // storage. Model switches (setModel) and passive resolution update
    // rawState.thinking in-memory instead, so a level the user never actually
    // picked (e.g. a derived catalog default) is never mistaken for a stored
    // choice. Persisted under the CURRENT model id — per-model storage keeps a
    // pick from leaking onto models that never declared it. Only concrete
    // levels are persisted; "no preference" stays in-memory.
    rawState.thinking = level;
    const modelId = currentModelId();
    if (level !== undefined && modelId !== undefined) saveThinkingToStorage(modelId, level);
    return level;
  }

  // The active model can change WITHOUT a picker action: switching sessions,
  // the snapshot adopting another session, or the catalog/default arriving
  // late. Re-resolve the level for the new model so a pick made for one model
  // is never submitted to — or rendered on — another (a foreign level used to
  // leave the composer showing nothing selected with no way to switch). The
  // picker path (setModel) applies the same resolution synchronously, so the
  // watcher's re-resolution after it is an idempotent no-op.
  watch(
    () => currentModelId(),
    (id, prevId) => {
      if (id === undefined || id === prevId) return;
      const model = modelById(id);
      if (model === undefined) return;
      rawState.thinking = thinkingLevelForModel(model);
    },
  );

  /** Persist an explicit thinking pick as the daemon-wide default ([thinking]
   *  in config.toml), mirroring the TUI's persistModelSelection, so sessions
   *  created by other clients inherit it. Fire-and-forget: the session-level
   *  and local values have already been applied. Never called for derived
   *  values (e.g. the loadModels default pin) — only for user actions. */
  function persistGlobalThinking(level: ThinkingLevel): void {
    void getKimiWebApi()
      .setConfig({ thinking: thinkingLevelToConfig(level) })
      .catch((error: unknown) => pushOperationFailure('setConfig', error));
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

  async function loadSkillsForWorkspace(workspaceId: string): Promise<void> {
    try {
      const api = getKimiWebApi();
      const list = await api.listSkillsForWorkspace(workspaceId);
      skillsByWorkspace.value = { ...skillsByWorkspace.value, [workspaceId]: list };
    } catch {
      // Side data; an older daemon without /workspaces/{id}/skills just yields
      // no slash-skills for the onboarding composer.
    }
  }

  /** Load models (cached — call again to force refresh) */
  async function loadModels(): Promise<void> {
    try {
      const api = getKimiWebApi();
      models.value = await api.listModels();
      // Resolve the active model's level: the stored pick for THIS model when
      // still declared, else the catalog default. In-memory only — localStorage
      // stays reserved for levels the user actually picked. Always re-resolved
      // (not just when unset) so a level carried over from another model can't
      // outlive the catalog refresh that makes it invalid.
      const active = modelById(currentModelId());
      if (active !== undefined) rawState.thinking = thinkingLevelForModel(active);
    } catch (err) {
      pushOperationFailure('loadModels', err);
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
   *
   * Returns whether the switch was accepted (true for the draft path too), so
   * callers can gate follow-up persistence (e.g. bumping the global default) on
   * a confirmed switch — errors are surfaced here, not thrown.
   */
  async function setModel(modelId: string): Promise<boolean> {
    const sid = rawState.activeSessionId;
    const targetModel = modelById(modelId);
    const prevThinking = rawState.thinking;
    const prevSessionModel = sid
      ? rawState.sessions.find((s) => s.id === sid)?.model
      : undefined;
    const isSwitch = currentModelId() !== (targetModel?.id ?? modelId);
    // On a real switch, restore the target model's own stored pick when still
    // declared; otherwise its catalog default (see thinkingLevelForModelSwitch).
    const nextThinking = thinkingLevelForModelSwitch(
      targetModel,
      prevThinking,
      isSwitch,
      targetModel === undefined ? undefined : loadThinkingForModel(targetModel.id),
    );
    if (!sid) {
      // New-session draft (onboarding composer): no backend session to update.
      // Remember the pick — startSessionAndSendPrompt applies it at create time.
      // In-memory only: a model switch is not a thinking pick, so nothing is
      // persisted (a derived default would otherwise masquerade as an explicit
      // choice later). Storage writes stay with setThinking.
      draftModel.value = modelId;
      rawState.thinking = nextThinking;
      if (nextThinking !== prevThinking && nextThinking !== undefined) {
        persistGlobalThinking(nextThinking);
      }
      return true;
    }
    // Optimistic: show the chosen model immediately, but remember the previous
    // one so we can roll back if the switch never reaches the daemon.
    updateSession(sid, (s) => ({ ...s, model: modelId }));
    if (nextThinking !== prevThinking) {
      rawState.thinking = nextThinking;
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
      updateSession(sid, (s) => ({ ...s, model: prevSessionModel ?? s.model }));
      if (nextThinking !== prevThinking) {
        rawState.thinking = prevThinking;
      }
      pushOperationFailure('setModel', err, { sessionId: sid });
      return false;
    }
    // The switch reached the daemon: also persist the thinking pick as the
    // daemon-wide default (mirrors the TUI). Skipped on rollback above.
    if (nextThinking !== prevThinking && nextThinking !== undefined) {
      persistGlobalThinking(nextThinking);
    }
    // refreshSessionStatus folds the authoritative current model from /status
    // back into the session (the profile echo can return ''). Best-effort: a
    // failure here does not mean the switch failed, so it must not roll back.
    await refreshSessionStatus(sid);
    return true;
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
   *
   * `sessionId` overrides the active session — used when activating right after
   * creating a session, so a concurrent session switch can't redirect the
   * activation to the wrong session. No session at all is a no-op.
   */
  async function activateSkill(skillName: string, args?: string, sessionId?: string): Promise<void> {
    const sid = sessionId ?? rawState.activeSessionId;
    if (!sid) return;
    const guarded = activity.value === 'idle' && !rawState.inFlightBySession[sid];
    const tempId = `msg_skill_opt_${Date.now().toString(36)}`;

    const localTurnToken = guarded ? beginLocalTurn(sid) : undefined;
    if (guarded) {
      // Share the local-turn-start lifecycle with prompt submits: a racing
      // terminal snapshot must not clear this skill's turn either.
      rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: true };
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
      // Skill activation carries only name/args — the daemon runs the turn at
      // the SESSION PROFILE effort. Persist the level resolved for this
      // session's own model first (awaited, mirroring the new-session skill
      // path), so a profile that predates the per-model restore can't run the
      // skill at a stale effort while the UI shows the restored level. When
      // the persist fails (it surfaces the error itself), activating would
      // launch the skill at exactly that stale effort — abort instead.
      // Session models can be '' transiently (daemon profile echo) — treat
      // that as "unset" and resolve through the configured default, same as
      // the prompt/BTW/steer paths, before selecting the thinking level.
      const rawModel = rawState.sessions.find((s) => s.id === sid)?.model;
      const skillModel = (rawModel && rawModel.length > 0 ? rawModel : rawState.defaultModel) ?? undefined;
      const persisted = await persistSessionProfile(
        { thinking: thinkingLevelForModelId(skillModel) ?? rawState.thinking },
        sid,
      );
      if (!persisted) throw PROFILE_PERSIST_FAILED;
      await getKimiWebApi().activateSkill(sid, skillName, args);
    } catch (err) {
      if (guarded) {
        rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: false };
        updateSessionMessages(sid, (msgs) => msgs.filter((m) => m.id !== tempId));
      }
      // The persist failure was already surfaced by persistSessionProfile.
      if (err !== PROFILE_PERSIST_FAILED) pushOperationFailure('activateSkill', err, { sessionId: sid });
    } finally {
      // The daemon answered the activation (accepted or rejected) — the
      // pending window in which a snapshot can't reflect this turn is over.
      if (localTurnToken !== undefined) settleLocalTurn(sid, localTurnToken);
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
  async function startOAuthLogin(): Promise<OAuthLoginStartResult | null> {
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
    } catch (err) {
      // The dialog counts consecutive nulls and gives up after a few; keep the
      // cause in the log so a dead daemon is diagnosable.
      console.warn('[kimi-web] pollOAuthLogin failed', err);
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
    void persistSessionProfile({ thinking: next });
    if (next !== undefined) persistGlobalThinking(next);
  }

  return {
    // state
    models,
    starredModelIds,
    providers,
    draftModel,
    skillsBySession,
    skillsByWorkspace,
    // actions
    loadSkillsForSession,
    loadSkillsForWorkspace,
    loadModels,
    loadProviders,
    setModel,
    thinkingLevelForModelId,
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
