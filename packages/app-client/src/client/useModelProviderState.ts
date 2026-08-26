// packages/app-client/src/client/useModelProviderState.ts
// Models, providers, starred/favorite models, the active-session thinking
// level, session-scoped slash skills, and the managed OAuth device flow.
// The state itself (model/provider caches, starred list, skills, draft pick)
// lives in the models Pinia store (stores/models.ts, P10) — this module holds
// the orchestrating actions. Cross-dependencies (failure reporting, status
// refresh, activity, in-flight set, thinking storage) are injected by the facade.

import { computed, watch, type ComputedRef } from 'vue';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import type { AddProviderInput, AppCatalogProvider, AppMessage, AppModel, AppProvider, AppProviderDetail, AppSession, DeleteProviderResult, ImportCatalogProviderInput, ImportCustomRegistryInput, KimiWebApi, ManagedUsageResult, OAuthLoginStartResult, OAuthRegion, ThinkingLevel, UpdateProviderInput } from '@moonshot-ai/app-core/api';
import { logError, logWarn } from '@moonshot-ai/app-core/lib';
import { attachmentsToContent } from './attachmentsToContent';
import {
  ackThinkingPending,
  defaultThinkingLevelFor,
  levelDeclaredBy,
  markThinkingPending,
  thinkingLevelForModelSwitch,
  thinkingLevelFromConfig,
} from '@moonshot-ai/app-core/lib';
import type { ActivityState } from '@moonshot-ai/app-core/client/types';
import type { ExtendedState, PromptAttachment } from './types';
import { modelsStore } from '../stores/models';

/** Sentinel thrown to abort a skill activation when the prerequisite profile
 *  persist failed — persistSessionProfile already surfaced that failure, so
 *  the catch skips activating without reporting a second, synthetic error.
 *  (An actual Error instance: oxlint only-throw-error.) */
const PROFILE_PERSIST_FAILED = new Error('profile persist failed');

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
  api: KimiWebApi;
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  refreshSessionStatus: (sessionId: string) => Promise<boolean>;
  /** Persist profile fields to the daemon. Resolves false (after surfacing the
   *  failure itself) when the daemon rejected the patch — awaited callers that
   *  order strictly after the profile must NOT proceed on false. */
  persistSessionProfile: (patch: PersistSessionProfilePatch, sessionId?: string) => Promise<boolean>;
  /** Persist the per-session armed-plan intent map after consuming one. */
  savePlanModeToStorage: () => void;
  activity: ComputedRef<ActivityState>;
  /** Replace one session in place (matched by id). Owned by the facade so the
   *  model module never assigns rawState.sessions directly. */
  updateSession: (id: string, update: (session: AppSession) => AppSession) => void;
  /** Reload the global config. Provider/model writes (and discovery refreshes)
   *  rewrite config sections; the edit form reads model records from config,
   *  so every mutation must end with a fresh snapshot. */
  loadConfig: () => Promise<void>;
  /** Re-check /auth readiness. The provider count feeds the composer send
   *  gate, so every provider mutation (add/delete/import) must refresh it —
   *  adding the first provider unblocks sending, deleting the last re-arms it. */
  checkAuth: () => Promise<unknown>;
  /** Local-turn lifecycle (owned by the workspace-state module in the app):
   *  begin marks a locally-started turn so a racing terminal snapshot can't
   *  clear it; settle releases the token when the daemon answered. */
  beginLocalTurn: (sid: string) => number;
  settleLocalTurn: (sid: string, token: number) => void;
  /** The main transcript's current tail turn id — stamped onto the skill
   *  activation's optimistic bubble at submit time (same reconciliation anchor
   *  as prompt bubbles). Optional for test harnesses. */
  mainTranscriptTailTurnId?: (sessionId: string) => string | undefined;
  /** The main transcript's newest prompt stamp — the fallback echo floor for
   *  sessions with prompt history but no turn yet. Optional for test harnesses. */
  mainTranscriptTailPromptCreatedAt?: (sessionId: string) => string | undefined;
  /** Settle a just-answered activation when the transcript already carries its
   *  terminal evidence (a pre-submit block's frame beat the response — the
   *  activation never receives a prompt id, and no later edge re-fires).
   *  Optional for test harnesses. */
  settleIfFateProven?: (sessionId: string) => void;
}

export function useModelProviderState(
  rawState: ExtendedState,
  deps: UseModelProviderStateDeps,
) {
  const {
    api,
    pushOperationFailure,
    refreshSessionStatus,
    persistSessionProfile,
    savePlanModeToStorage,
    activity,
    updateSession,
    loadConfig,
    checkAuth,
    beginLocalTurn,
    settleLocalTurn,
    mainTranscriptTailTurnId,
    mainTranscriptTailPromptCreatedAt,
    settleIfFateProven,
  } = deps;

  // The models/providers/skills/draft-model state lives in the models Pinia
  // store (stores/models.ts, P10); this module's actions read and write it
  // through the store.
  const store = modelsStore();

  function modelById(modelId: string | null | undefined): AppModel | undefined {
    if (modelId === undefined || modelId === null || modelId.length === 0) return undefined;
    // Prefer the exact id — model names can collide across providers.
    return (
      store.models.find((m) => m.id === modelId) ??
      store.models.find((m) => m.model === modelId)
    );
  }

  function currentModelId(): string | undefined {
    const activeSession = rawState.activeSessionId
      ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
      : undefined;
    const rawModel =
      activeSession === undefined
        ? store.draftModel ?? rawState.defaultModel
        : activeSession.model || rawState.defaultModel;
    return modelById(rawModel)?.id ?? rawModel ?? undefined;
  }

  /** thinkingLevelForModel by model id, for paths that submit a prompt for a
   *  session other than the active one (queued drain, steer): the level must
   *  come from the prompt's OWN model, not from rawState.thinking, which always
   *  tracks the active session's model. Undefined when the id is not in the
   *  catalog (caller falls back to the active value, same as before). */
  function thinkingLevelForModelId(modelId: string | undefined): ThinkingLevel | undefined {
    if (modelId === undefined) return undefined;
    const model = modelById(modelId);
    return model === undefined ? undefined : defaultThinkingLevelFor(model);
  }

  /**
   * The level a session should run at.
   *
   * An existing entry (thinkingBySession — fed by /status folds and explicit
   * picks) wins when the model still declares it; if the model no longer
   * declares it (a catalog refresh dropped that effort out from under an
   * already-running session), fall back to the MODEL's own catalog default —
   * never the daemon-wide config default, which is the new-session default,
   * not "what an existing session should renormalize to".
   *
   * No entry at all — sessionId is a draft (null) or a session that has never
   * been assigned a level — applies the daemon-wide config.thinking default
   * (same resolution the Settings picker itself displays) before the
   * catalog default.
   *
   * Per-session state wins over both fallbacks so a session keeps the level
   * it actually ran with — picking 'high' in one session must not
   * retroactively change another session that ran 'max'.
   */
  function thinkingLevelForSession(
    sessionId: string | null | undefined,
    model: AppModel,
  ): ThinkingLevel {
    const sessionLevel =
      sessionId === null || sessionId === undefined
        ? undefined
        : rawState.thinkingBySession[sessionId];
    if (sessionLevel !== undefined) {
      return levelDeclaredBy(model, sessionLevel) ? sessionLevel : defaultThinkingLevelFor(model);
    }
    return thinkingLevelFromConfig(rawState.config?.thinking, model) ?? defaultThinkingLevelFor(model);
  }

  /** thinkingLevelForSession by session + model id, for prompt submission
   *  paths (send, steer, side chat). Undefined when the model id is not in the
   *  catalog (caller falls back to the active value, same as before). */
  function thinkingLevelForSessionId(
    sessionId: string | null | undefined,
    modelId: string | undefined,
  ): ThinkingLevel | undefined {
    if (modelId === undefined) return undefined;
    const model = modelById(modelId);
    return model === undefined ? undefined : thinkingLevelForSession(sessionId, model);
  }

  /**
   * Submission-time resolution: when the session's own level has not been
   * folded from /status yet (the cold window right after a reload or a
   * session switch), wait for that fold first. Resolving straight to the
   * catalog default here would not just display wrong — the prompt carries
   * the level to the daemon, which writes it into the session profile and
   * permanently overwrites the level the session actually ran at.
   */
  async function resolveThinkingForPrompt(
    sessionId: string | null | undefined,
    modelId: string | undefined,
  ): Promise<ThinkingLevel | undefined> {
    if (
      sessionId !== null &&
      sessionId !== undefined &&
      rawState.thinkingBySession[sessionId] === undefined
    ) {
      await refreshSessionStatus(sessionId);
    }
    return thinkingLevelForSessionId(sessionId, modelId);
  }

  function applyThinkingLevel(level: ThinkingLevel | undefined): ThinkingLevel | undefined {
    // The explicit-picker path (setThinking). Model switches (setModel) and
    // passive resolution update rawState.thinking in-memory the same way, but
    // only an explicit pick is pushed to the session profile — a derived
    // catalog default must not masquerade as a user choice.
    rawState.thinking = level;
    // Mirror the pick into the session's own entry, marked pending until the
    // daemon acks the profile write (persistSessionProfile).
    const sid = rawState.activeSessionId;
    if (level !== undefined && sid !== null && sid !== undefined) {
      rawState.thinkingBySession = { ...rawState.thinkingBySession, [sid]: level };
      markThinkingPending(rawState, sid);
    } else if (sid === null || sid === undefined) {
      // No-session draft: thinkingBySession has no id to key this pick under
      // (see draftThinkingExplicit's own doc) — record explicitness directly
      // so passive re-resolution (resolveActiveThinking) knows to leave it
      // alone, and createDraftSession() knows to actually seed it.
      rawState.draftThinkingExplicit = level !== undefined;
    }
    return level;
  }

  /** Re-resolve rawState.thinking for the active session/model right now —
   *  shared by the watcher below and loadModels(). A no-op while a no-session
   *  draft holds an EXPLICIT pick (draftThinkingExplicit) still valid for
   *  whatever model is currently active — thinkingBySession has no id to key
   *  that pick under while there is no session, so rawState.thinking is its
   *  only home, and passive re-resolution must not clobber it. But the
   *  protection is conditional on the pick still applying: if the draft's
   *  model changed underneath it with no explicit setModel() switch (Settings'
   *  own default model, a catalog refresh dropping the effort) the old pick
   *  may not even be valid for the new model — drop "explicit" and let it
   *  re-resolve fresh, same as an actual switch already does. Landing on a
   *  REAL session unconditionally clears the flag: it is scoped to the
   *  CURRENT draft only — otherwise browsing into an existing session and
   *  back to a fresh draft would let that session's level (now sitting in
   *  rawState.thinking) masquerade as an explicit pick for the NEW draft. */
  function resolveActiveThinking(): void {
    const sid = rawState.activeSessionId;
    const model = modelById(currentModelId());
    if (sid === null || sid === undefined) {
      if (rawState.draftThinkingExplicit) {
        // Model not loaded yet: nothing to invalidate against — keep
        // protecting rather than treating catalog latency as a model change.
        if (model === undefined) return;
        if (rawState.thinking !== undefined && levelDeclaredBy(model, rawState.thinking)) return;
        rawState.draftThinkingExplicit = false;
      }
    } else if (rawState.draftThinkingExplicit) {
      rawState.draftThinkingExplicit = false;
    }
    if (model === undefined) return;
    rawState.thinking = thinkingLevelForSession(sid, model);
  }

  // The displayed level tracks the ACTIVE session, and the active session or
  // its model can change WITHOUT a picker action: switching sessions, the
  // snapshot adopting another session, a /status fold arriving late, the
  // catalog/default arriving late, or the daemon-wide config default changing
  // (Settings' own picker, or any other config write). Re-resolve on any of
  // these so a pick made for one session/model is never submitted to — or
  // rendered on — another, and an inherited (non-explicit) draft keeps
  // tracking the config default right up to its first prompt. The picker
  // paths (setThinking/setModel) apply the same resolution synchronously, so
  // the watcher's re-resolution after them is an idempotent no-op — and for
  // an explicit draft pick specifically, resolveActiveThinking's own guard
  // above makes it a no-op regardless of what triggered it.
  watch(
    [
      () => rawState.activeSessionId,
      () => currentModelId(),
      () => {
        const sid = rawState.activeSessionId;
        return sid === null || sid === undefined ? undefined : rawState.thinkingBySession[sid];
      },
      () => rawState.config?.thinking,
    ],
    resolveActiveThinking,
  );

  /** Load models (cached — call again to force refresh) */
  async function loadModels(): Promise<void> {
    try {
      store.setModels(await api.listModels());
      // Resolve the active session's level: its own daemon-reported level when
      // still declared, else the config default, else the model's catalog
      // default. Always re-resolved (not just when unset) so a level carried
      // over from another model can't outlive the catalog refresh that makes
      // it invalid.
      resolveActiveThinking();
    } catch (err) {
      pushOperationFailure('loadModels', err);
    }
  }

  /** Load providers */
  async function loadProviders(): Promise<void> {
    try {
      store.setProviders(await api.listProviders());
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
   * callers can gate follow-up persistence on a confirmed switch — errors are
   * surfaced here, not thrown.
   */
  async function setModel(modelId: string): Promise<boolean> {
    const sid = rawState.activeSessionId;
    const targetModel = modelById(modelId);
    const prevThinking = rawState.thinking;
    const prevSessionModel = sid
      ? rawState.sessions.find((s) => s.id === sid)?.model
      : undefined;
    const isSwitch = currentModelId() !== (targetModel?.id ?? modelId);
    // On a real switch, pre-select the target model's catalog default (see
    // thinkingLevelForModelSwitch); re-selecting keeps the live level. The
    // daemon-wide config default only applies to a NEW-SESSION draft (no sid
    // yet, below) — it is the new-session default, not "whatever an existing,
    // already-running session's thinking should reset to on a model swap".
    const nextThinking = thinkingLevelForModelSwitch(
      targetModel,
      prevThinking,
      isSwitch,
      sid ? undefined : rawState.config?.thinking,
    );
    if (!sid) {
      // New-session draft (onboarding composer): no backend session to update.
      // Remember the pick — startSessionAndSendPrompt applies it at create time.
      // In-memory only: a model switch is not a thinking pick, so nothing is
      // persisted beyond the in-memory level (a derived default would otherwise
      // masquerade as an explicit choice later). A real switch's resulting
      // level is a freshly computed default for the target model, not the
      // user's choice — draftThinkingExplicit resets so it keeps tracking
      // config/catalog changes; re-selecting the SAME model leaves the level
      // (and its explicitness) untouched.
      store.setDraftModel(modelId);
      rawState.thinking = nextThinking;
      if (isSwitch) rawState.draftThinkingExplicit = false;
      return true;
    }
    // Optimistic: show the chosen model immediately, but remember the previous
    // one so we can roll back if the switch never reaches the daemon.
    updateSession(sid, (s) => ({ ...s, model: modelId }));
    let thinkingWriteToken: number | undefined;
    if (nextThinking !== prevThinking) {
      rawState.thinking = nextThinking;
      // Keep the session's own entry in sync optimistically — marked pending
      // until the daemon applies the switch below.
      if (nextThinking !== undefined) {
        rawState.thinkingBySession = { ...rawState.thinkingBySession, [sid]: nextThinking };
        thinkingWriteToken = markThinkingPending(rawState, sid);
      }
    }
    try {
      await api.updateSession(sid, {
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
        if (prevThinking !== undefined) {
          rawState.thinkingBySession = { ...rawState.thinkingBySession, [sid]: prevThinking };
        }
        // Never resurrect the pre-attempt mark (its write may have settled —
        // a dead token shields every later fold). Drop only THIS switch's
        // mark; a newer pick keeps its shield. Then re-fold the daemon's
        // actual level.
        if (ackThinkingPending(rawState, sid, thinkingWriteToken)) void refreshSessionStatus(sid);
      }
      pushOperationFailure('setModel', err, { sessionId: sid });
      return false;
    }
    // Ack this write, then echo /status back in (best-effort — a failure here
    // does not mean the switch failed): the fold only lands once the shield is
    // down, and it corrects any interim setModel-step status frame (the model
    // default) the daemon emitted before setThinking.
    ackThinkingPending(rawState, sid, thinkingWriteToken);
    await refreshSessionStatus(sid);
    return true;
  }

  /**
   * Activate a session skill (the web analogue of typing `/<skill> <args>` in the
   * TUI). The daemon starts a turn with a `skill_activation` origin; progress
   * arrives over the WS stream like any other turn. Never crashes the caller.
   *
   * `attachments` are the composer's uploaded files — they ride the same user
   * message as the rendered skill prompt, exactly like a prompt with uploads.
   *
   * `sessionId` overrides the active session — used when activating right after
   * creating a session, so a concurrent session switch can't redirect the
   * activation to the wrong session. No session at all is a no-op.
   * `skipThinkingPersist` skips the pre-activation profile write when the
   * caller already persisted (and awaited) the same level.
   */
  async function activateSkill(
    skillName: string,
    args?: string,
    attachments?: PromptAttachment[],
    sessionId?: string,
    opts?: { skipThinkingPersist?: boolean },
  ): Promise<boolean> {
    const sid = sessionId ?? rawState.activeSessionId;
    if (!sid) return false;
    const guarded = activity.value === 'idle' && !rawState.inFlightBySession[sid];
    const tempId = `msg_skill_opt_${Date.now().toString(36)}`;

    const localTurnToken = guarded ? beginLocalTurn(sid) : undefined;
    // Set only at the activation POST itself: a failure thrown earlier (the
    // profile pre-write) provably started nothing.
    let activationAttempted = false;
    // Set on the clean accept only (NOT the catch's ambiguous-fate true): the
    // response's landing is where a terminal frame that beat it gets settled.
    let activationOk = false;
    if (guarded) {
      // Share the local-turn-start lifecycle with prompt submits: a racing
      // terminal snapshot must not clear this skill's turn either.
      rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: true };
      const optimisticMsg: AppMessage = {
        id: tempId,
        sessionId: sid,
        role: 'user',
        content: [
          { type: 'text', text: `/${skillName}${args ? ` ${args}` : ''}` },
          ...attachmentsToContent(attachments),
        ],
        createdAt: new Date().toISOString(),
        metadata: {
          'kimiWeb.optimisticUserMessage': true,
          'kimiWeb.anchorTurnId': mainTranscriptTailTurnId?.(sid),
          'kimiWeb.anchorPromptCreatedAt': mainTranscriptTailPromptCreatedAt?.(sid),
          origin: {
            kind: 'skill_activation',
            trigger: 'user-slash',
            skillName,
            skillArgs: args,
          },
        },
      };
      rawState.optimisticMessagesBySession = {
        ...rawState.optimisticMessagesBySession,
        [sid]: [...(rawState.optimisticMessagesBySession[sid] ?? []), optimisticMsg],
      };
    }

    try {
      // Skill activation carries only name/args — the daemon runs the turn at
      // the SESSION PROFILE effort. Persist the level resolved for this
      // session's own model first (awaited), so a profile that predates the
      // per-model restore can't run the skill at a stale effort while the UI
      // shows the restored level. When the persist fails (it surfaces the
      // error itself), activating would launch the skill at exactly that
      // stale effort — abort instead.
      if (opts?.skipThinkingPersist !== true) {
        // Session models can be '' transiently (daemon profile echo) — treat
        // that as "unset" and resolve through the configured default, same as
        // the prompt/BTW/steer paths, before selecting the thinking level.
        const rawModel = rawState.sessions.find((s) => s.id === sid)?.model;
        const skillModel = (rawModel && rawModel.length > 0 ? rawModel : rawState.defaultModel) ?? undefined;
        // Carry the session's swarm/permission along with thinking: the
        // activation runs at the session profile, and a retry after a failed
        // new-session patch would otherwise run at daemon defaults while the
        // UI shows the user's picks. An armed plan intent rides the same
        // write (the daemon learns plan mode only via the session profile)
        // and is consumed on success.
        const cashArmedPlan = rawState.planArmedBySession[sid] ?? false;
        const persisted = await persistSessionProfile(
          {
            thinking: (await resolveThinkingForPrompt(sid, skillModel)) ?? rawState.thinking,
            swarmMode: rawState.swarmModeBySession?.[sid] ?? false,
            permissionMode: rawState.permission,
            ...(cashArmedPlan ? { planMode: true } : {}),
          },
          sid,
        );
        if (!persisted) throw PROFILE_PERSIST_FAILED;
        if (cashArmedPlan) {
          rawState.planArmedBySession = { ...rawState.planArmedBySession, [sid]: false };
          savePlanModeToStorage();
          rawState.planModeBySession = { ...rawState.planModeBySession, [sid]: true };
        }
      }
      activationAttempted = true;
      await api.activateSkill(sid, skillName, args, attachmentsToContent(attachments));
      activationOk = true;
      return true;
    } catch (err) {
      if (guarded) {
        rawState.inFlightBySession = { ...rawState.inFlightBySession, [sid]: false };
        // Drop the bubble ONLY when the failure provably started nothing
        // (pre-submit, or a definitive daemon refusal). A lost POST response
        // leaves the activation's fate unknown — the bubble is the only
        // rendering of the command until its skill_activation turn arrives.
        const provablyRejected = !activationAttempted || err instanceof DaemonApiError;
        if (provablyRejected) {
          const remainingOptimistic = (rawState.optimisticMessagesBySession[sid] ?? []).filter(
            (m) => m.id !== tempId,
          );
          const nextOptimistic = { ...rawState.optimisticMessagesBySession };
          if (remainingOptimistic.length > 0) nextOptimistic[sid] = remainingOptimistic;
          else delete nextOptimistic[sid];
          rawState.optimisticMessagesBySession = nextOptimistic;
        } else {
          // Uncertain fate: mark the bubble (same contract as prompt submits)
          // so an unrelated turn end's batch clear keeps it — its own
          // skill_activation turn retires it via origin reconciliation.
          const current = rawState.optimisticMessagesBySession[sid];
          if (current !== undefined) {
            rawState.optimisticMessagesBySession = {
              ...rawState.optimisticMessagesBySession,
              [sid]: current.map((m) =>
                m.id === tempId
                  ? { ...m, metadata: { ...m.metadata, 'kimiWeb.uncertain': true } }
                  : m,
              ),
            };
          }
        }
      }
      // The persist failure was already surfaced by persistSessionProfile.
      if (err !== PROFILE_PERSIST_FAILED) pushOperationFailure('activateSkill', err, { sessionId: sid });
      // Pre-submit failures and definitive daemon refusals provably started
      // nothing — the caller restores the command. Only an ambiguous
      // post-submit failure (lost response) reports success, so a retry
      // can't double-activate.
      return !activationAttempted || err instanceof DaemonApiError ? false : true;
    } finally {
      // The daemon answered the activation (accepted or rejected) — the
      // pending window in which a snapshot can't reflect this turn is over.
      if (localTurnToken !== undefined) settleLocalTurn(sid, localTurnToken);
      // A blocked activation's terminal frame may have beaten this response
      // (and the activation never receives a prompt id) — settle by the
      // bubble's skill marker now that the answer is in. Guarded calls only:
      // an unguarded activation owns no local turn to settle.
      if (activationOk && localTurnToken !== undefined) settleIfFateProven?.(sid);
    }
  }

  /**
   * Fetch a single provider's detail — the only call that reveals the stored
   * API key, used by the edit form to prefill the password field. Throws to
   * the caller (the form degrades to the redacted placeholder on failure).
   */
  async function getProvider(id: string): Promise<AppProviderDetail> {
    return api.getProvider(id);
  }

  /**
   * Add a provider, then reload providers + models. Resolves to null on
   * success, or to the error message on failure — the add form shows that
   * message in its inline banner, so failures are NOT toasted here (only
   * logged, keeping them diagnosable from the console/web log).
   */
  async function addProvider(input: AddProviderInput): Promise<string | null> {
    try {
      await api.addProvider(input);
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return null;
    } catch (err) {
      logError('[kimi-code] operation failed: addProvider', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Update a provider (PUT replace semantics), then reload providers + models.
   * Same error contract as addProvider: resolves to null on success, or to the
   * error message for the panel's inline banner (failures are logged, not
   * toasted).
   */
  async function updateProvider(id: string, input: UpdateProviderInput): Promise<string | null> {
    try {
      await api.updateProvider(id, input);
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      return null;
    } catch (err) {
      logError('[kimi-code] operation failed: updateProvider', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Delete a provider, then reload providers + models + config. Resolves to
   * `{ deleted: id }` on success (the daemon never touches the global default
   * pointers on delete), or null on failure (toasted here).
   */
  async function deleteProvider(id: string): Promise<DeleteProviderResult | null> {
    try {
      const result = await api.deleteProvider(id);
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return result;
    } catch (err) {
      pushOperationFailure('deleteProvider', err);
      return null;
    }
  }

  /** Refresh a single provider's remote model metadata, then reload caches. */
  async function refreshProvider(id: string): Promise<void> {
    try {
      const result = await api.refreshProvider(id);
      for (const failure of result.failed) {
        pushOperationFailure('refreshProvider', new Error(failure.reason), {
          message: failure.provider,
        });
      }
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
    } catch (err) {
      pushOperationFailure('refreshProvider', err);
    }
  }

  /** Refresh every refreshable provider's remote model metadata, then reload caches. */
  async function refreshAllProviders(): Promise<void> {
    try {
      const result = await api.refreshAllProviders();
      for (const failure of result.failed) {
        pushOperationFailure('refreshAllProviders', new Error(failure.reason), {
          message: failure.provider,
        });
      }
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
    } catch (err) {
      pushOperationFailure('refreshAllProviders', err);
    }
  }

  /**
   * Load the server-proxied models.dev directory for the add-provider flow.
   * Three-way outcome: 'ok' carries the entries, 'unsupported' means the
   * connected server predates the catalog routes (an old daemon answers the
   * unknown route with a non-envelope 404, surfacing as a DaemonApiError
   * without a code — the flow then hides the directory source), 'error' is
   * any other failure (directory unavailable, network down — retryable).
   */
  async function loadCatalogProviders(): Promise<
    | { kind: 'ok'; items: AppCatalogProvider[] }
    | { kind: 'unsupported' }
    | { kind: 'error' }
  > {
    try {
      const items = await api.listCatalogProviders();
      return { kind: 'ok', items };
    } catch (err) {
      if (err instanceof DaemonApiError && err.code === undefined) {
        return { kind: 'unsupported' };
      }
      logError('[kimi-code] operation failed: loadCatalogProviders', err);
      return { kind: 'error' };
    }
  }

  /**
   * Import a models.dev directory entry as a provider, then reload providers
   * + models + config. Same error contract as addProvider: null on success,
   * the error message otherwise (inline banner, logged not toasted).
   */
  async function importCatalogProvider(
    input: ImportCatalogProviderInput,
  ): Promise<string | null> {
    try {
      await api.importCatalogProvider(input);
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return null;
    } catch (err) {
      logError('[kimi-code] operation failed: importCatalogProvider', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /**
   * Import a custom registry (api.json URL + optional key), then reload
   * providers + models + config. Success carries the imported providers (the
   * flow expands the first one); failure resolves to the error message for
   * the flow's inline banner (logged, not toasted).
   */
  async function importCustomRegistry(
    input: ImportCustomRegistryInput,
  ): Promise<{ providers: AppProvider[]; modelsImported: number } | string> {
    try {
      const result = await api.importCustomRegistry(input);
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return result;
    } catch (err) {
      logError('[kimi-code] operation failed: importCustomRegistry', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  /** Start managed Kimi OAuth device flow. Returns flow data or null on error.
   *  `region` pins the OAuth host region for the flow (login UI region cards). */
  async function startOAuthLogin(region?: OAuthRegion): Promise<OAuthLoginStartResult | null> {
    try {
      return await api.startOAuthLogin(region);
    } catch {
      return null;
    }
  }

  /** Server-resolved account region (null on older daemons / failures — the
   *  api client already degrades; this stays a thin pass-through). */
  async function getOAuthRegion(): Promise<OAuthRegion | null> {
    return api.getOAuthRegion();
  }

  /** Poll the singleton OAuth flow. Returns null on error or no active flow. */
  async function pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'expired' | 'cancelled';
    resolvedAt?: string;
  } | null> {
    try {
      return await api.pollOAuthLogin();
    } catch (err) {
      // The dialog counts consecutive nulls and gives up after a few; keep the
      // cause in the log so a dead daemon is diagnosable.
      logWarn('[kimi-code] pollOAuthLogin failed', err);
      return null;
    }
  }

  /** Cancel the current OAuth flow (best-effort). */
  async function cancelOAuthLogin(): Promise<void> {
    try {
      await api.cancelOAuthLogin();
    } catch {
      // Best-effort
    }
  }

  /** Fetch managed-account plan usage. Never throws — failures (e.g. an older
   *  daemon without the endpoint) come back as the `error` shape so the
   *  settings UI can render an inline state instead of a toast. */
  async function getUsage(): Promise<ManagedUsageResult> {
    try {
      return await api.getUsage();
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  /** Persist and apply a new extended-thinking level (also pushed to the active
   *  session profile so the daemon's /status reflects it; still sent per-prompt).
   *  Session-scoped only — never written to the daemon-wide [thinking] config,
   *  matching the TUI's session-only path (persist=false): a pick made for one
   *  session/model must not change the default every other session and client
   *  starts at. */
  function setThinking(level: ThinkingLevel): void {
    const next = applyThinkingLevel(level);
    void persistSessionProfile({ thinking: next });
  }

  return {
    // state (models store — computed aliases keep this return shape stable)
    models: computed(() => store.models),
    starredModelIds: computed(() => store.starredModelIds),
    providers: computed(() => store.providers),
    draftModel: computed(() => store.draftModel),
    skillsBySession: computed(() => store.skillsBySession),
    skillsByWorkspace: computed(() => store.skillsByWorkspace),
    skillsFetchedBySession: computed(() => store.skillsFetchedBySession),
    skillsFetchedByWorkspace: computed(() => store.skillsFetchedByWorkspace),
    // actions
    loadSkillsForSession: store.loadSkillsForSession,
    loadSkillsForWorkspace: store.loadSkillsForWorkspace,
    loadModels,
    loadProviders,
    setModel,
    thinkingLevelForModelId,
    thinkingLevelForSessionId,
    resolveThinkingForPrompt,
    toggleStarModel: store.toggleStarModel,
    activateSkill,
    addProvider,
    updateProvider,
    deleteProvider,
    getProvider,
    loadCatalogProviders,
    importCatalogProvider,
    importCustomRegistry,
    refreshProvider,
    refreshAllProviders,
    startOAuthLogin,
    pollOAuthLogin,
    cancelOAuthLogin,
    getOAuthRegion,
    getUsage,
    setThinking,
  };
}

export type UseModelProviderState = ReturnType<typeof useModelProviderState>;
