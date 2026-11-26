import { stripAttachmentLinks, type ComposerDocumentSnapshot } from '@moonshot-ai/app-composer/model';
import { browserReferenceText, buildPromptContent, buildPromptMetadata } from '../lib/browserReferenceSubmission';
import { withSessionReferences } from '../lib/sessionReferences';

import { computed, watch, type ComputedRef } from 'vue';
import { DaemonApiError, isSessionOccupiedError } from '@moonshot-ai/app-core/api';
import type { AddProviderInput, AppCatalogProvider, AppMessage, AppModel, AppProvider, AppProviderDetail, AppSession, DeleteProviderResult, ImportCatalogProviderInput, ImportCustomRegistryInput, KimiWebApi, ManagedQuotaResult, OAuthLoginStartResult, OAuthRegion, ProviderRefreshResult, ThinkingLevel, UpdateProviderInput } from '@moonshot-ai/app-core/api';
import { logError, logWarn, providerDisplayName } from '@moonshot-ai/app-core/lib';
import { attachmentsToContent } from './attachmentsToContent';
import { newPromptId } from './promptId';
import {
  defaultThinkingLevelFor,
  levelDeclaredBy,
  markThinkingPending,
  thinkingLevelForModelSwitch,
  thinkingLevelFromConfig,
  thinkingLevelKeptAcrossModelSwitch,
} from '@moonshot-ai/app-core/lib';
import type { ActivityState } from '@moonshot-ai/app-core/client/types';
import type { ExtendedState, PromptAttachment } from './types';
import type { ChatGateVerdict } from '../lib/chatGate';
import { modelsStore } from '../stores/models';
import type { AuthCheckResult } from '../stores/auth';
import { promptStore } from '../stores/prompt';
import { sessionRuntimeStore } from '../stores/sessionRuntime';
import { createSendFailureNotifier } from './sendFailure';
import { retryWhileOccupied } from './sessionOccupancy';
import { submitWithNetworkRetry } from './submitRetry';
import { t } from './deps';

const PROFILE_PERSIST_FAILED = new Error('profile persist failed');

export interface PersistSessionProfilePatch {
  model?: string;
  permissionMode?: string;
  planMode?: boolean;
  swarmMode?: boolean;
  towerMode?: boolean;
  towerBase?: string;
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
  persistSessionProfile: (
    patch: PersistSessionProfilePatch,
    sessionId?: string,
    preserveDraftThinking?: boolean,
  ) => Promise<boolean>;
  whenSessionProfileSettled: (sid: string) => Promise<boolean>;
  savePlanModeToStorage: () => void;
  saveTowerModeToStorage: () => void;
  activity: ComputedRef<ActivityState>;
  updateSession: (id: string, update: (session: AppSession) => AppSession) => void;
  loadConfig: () => Promise<'committed' | 'superseded' | 'failed'>;
  checkAuth: () => Promise<AuthCheckResult>;
  mapSendAuthFailure?: (err: unknown, sid?: string) => Promise<ChatGateVerdict | null>;
}

export function useModelProviderState(
  rawState: ExtendedState,
  deps: UseModelProviderStateDeps,
) {
  const {
    api,
    pushOperationFailure,
    persistSessionProfile,
    whenSessionProfileSettled,
    savePlanModeToStorage,
    saveTowerModeToStorage,
    activity,
    updateSession,
    loadConfig,
    checkAuth,
    mapSendAuthFailure,
  } = deps;

  const pushSendFailure = createSendFailureNotifier({ pushOperationFailure, mapSendAuthFailure });

  const store = modelsStore();

  function modelById(modelId: string | null | undefined): AppModel | undefined {
    if (modelId === undefined || modelId === null || modelId.length === 0) return undefined;
    return (
      store.activeModels.find((m) => m.id === modelId) ??
      store.activeModels.find((m) => m.model === modelId)
    );
  }

  function canonicalModelId(modelId: string | null | undefined): string | undefined {
    return modelById(modelId)?.id ?? modelId ?? undefined;
  }

  function currentModelId(): string | undefined {
    const activeSession = rawState.activeSessionId
      ? rawState.sessions.find((s) => s.id === rawState.activeSessionId)
      : undefined;
    const rawModel =
      activeSession === undefined
        ? store.draftModel ?? store.activeDefaultModel
        : rawState.unavailableModelBySession?.[activeSession.id] !== undefined
          ? null
          : activeSession.model || store.activeDefaultModel;
    return canonicalModelId(rawModel);
  }

  function thinkingLevelForModelId(modelId: string | undefined): ThinkingLevel | undefined {
    if (modelId === undefined) return undefined;
    const model = modelById(modelId);
    return model === undefined ? undefined : defaultThinkingLevelFor(model);
  }

  function thinkingLevelForSession(
    sessionId: string | null | undefined,
    model: AppModel,
  ): ThinkingLevel {
    const sessionLevel =
      sessionId === null || sessionId === undefined
        ? undefined
        : rawState.thinkingBySession[sessionId];
    if (sessionLevel !== undefined) return thinkingLevelKeptAcrossModelSwitch(model, sessionLevel);
    return thinkingLevelFromConfig(rawState.config?.thinking, model) ?? defaultThinkingLevelFor(model);
  }

  function applyThinkingLevel(level: ThinkingLevel | undefined): ThinkingLevel | undefined {
    rawState.thinking = level;
    const sid = rawState.activeSessionId;
    if (level !== undefined && sid !== null && sid !== undefined) {
      rawState.thinkingBySession = { ...rawState.thinkingBySession, [sid]: level };
      markThinkingPending(rawState, sid);
    } else if (sid === null || sid === undefined) {
      rawState.draftThinkingExplicit = level !== undefined;
    }
    return level;
  }

  function resolveActiveThinking(): void {
    const sid = rawState.activeSessionId;
    const model = modelById(currentModelId());
    if (sid === null || sid === undefined) {
      if (rawState.draftThinkingExplicit) {
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

  async function loadModels(onError?: (error: unknown) => void): Promise<boolean> {
    try {
      store.setModels(await api.listModels());
      resolveActiveThinking();
      return true;
    } catch (err) {
      onError?.(err);
      pushOperationFailure('loadModels', err);
      return false;
    }
  }

  async function loadProviders(): Promise<void> {
    try {
      store.setProviders(await api.listProviders());
    } catch (err) {
      pushOperationFailure('loadProviders', err);
    }
  }

  function writeSessionModel(
    sid: string,
    modelId: string,
    nextThinking: ThinkingLevel | undefined,
  ): Promise<boolean> {
    updateSession(sid, (s) => ({ ...s, model: modelId }));
    sessionRuntimeStore().markModelPending(sid);
    if (nextThinking !== undefined) {
      rawState.thinkingBySession = { ...rawState.thinkingBySession, [sid]: nextThinking };
      markThinkingPending(rawState, sid);
    }
    const persisted = persistSessionProfile({ model: modelId, thinking: nextThinking }, sid);
    void persisted.then((ok) => {
      if (!ok) return;
      const nextUnavailable = { ...rawState.unavailableModelBySession };
      delete nextUnavailable[sid];
      rawState.unavailableModelBySession = nextUnavailable;
    });
    return persisted;
  }

  async function setModel(modelId: string): Promise<boolean> {
    const sid = rawState.activeSessionId;
    const targetModel = modelById(modelId);
    const targetModelId = canonicalModelId(modelId) ?? modelId;
    const previousModelId = currentModelId();
    if (!sid) {
      const isSwitch = previousModelId !== targetModelId;
      store.setDraftModel(modelId);
      rawState.thinking = thinkingLevelForModelSwitch(targetModel, rawState.thinking, isSwitch, rawState.config?.thinking);
      if (isSwitch) rawState.draftThinkingExplicit = false;
      store.noteRecentModel(targetModelId, previousModelId);
      return true;
    }
    const switched = await writeSessionModel(sid, modelId, undefined);
    if (switched) store.noteRecentModel(targetModelId, previousModelId);
    return switched;
  }

  async function setSessionModel(sessionId: string, modelId: string, thinking?: ThinkingLevel): Promise<boolean> {
    const sessionEntry = rawState.sessions.find((s) => s.id === sessionId);
    if (sessionEntry === undefined) return false;
    const targetModelId = canonicalModelId(modelId) ?? modelId;
    const previousModelId = canonicalModelId(sessionEntry.model || store.activeDefaultModel);
    const switched = await writeSessionModel(
      sessionId,
      modelId,
      thinking === rawState.thinkingBySession[sessionId] ? undefined : thinking,
    );
    if (switched) store.noteRecentModel(targetModelId, previousModelId);
    return switched;
  }

  async function activateSkill(
    skillName: string,
    args?: string,
    attachments?: PromptAttachment[],
    sessionId?: string,
    opts?: { snapshot?: ComposerDocumentSnapshot; skillPath?: string },
  ): Promise<boolean> {
    const sid = sessionId ?? rawState.activeSessionId;
    if (!sid) return false;
    const snapshot = opts?.snapshot === undefined ? undefined : structuredClone(opts.snapshot);
    const activationArgs = snapshot === undefined
      ? (args === undefined ? undefined : withSessionReferences(stripAttachmentLinks(args)))
      : withSessionReferences(stripAttachmentLinks(browserReferenceText(args ?? '', snapshot))) || undefined;
    const guarded = activity.value === 'idle' && !promptStore().inFlightBySession[sid];
    const tempId = `msg_skill_opt_${Date.now().toString(36)}`;
    const promptId = newPromptId();

    if (guarded) {
      promptStore().setInFlight(sid, true);
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
          ...(snapshot === undefined ? {} : { 'kimiWeb.composerSnapshot': snapshot }),
          'kimiWeb.optimisticUserMessage': true,
          'kimiWeb.promptId': promptId,
          origin: {
            kind: 'skill_activation',
            trigger: 'user-slash',
            skillName,
            skillPath: opts?.skillPath,
            skillArgs: activationArgs,
          },
        },
      };
      promptStore().addOptimisticMessage(sid, optimisticMsg);
    }

    try {
      if (rawState.planArmedBySession[sid] ?? false) {
        const persisted = await persistSessionProfile({ planMode: true, towerMode: false }, sid);
        if (!persisted) throw PROFILE_PERSIST_FAILED;
        rawState.planArmedBySession = { ...rawState.planArmedBySession, [sid]: false };
        savePlanModeToStorage();
        rawState.planModeBySession = { ...rawState.planModeBySession, [sid]: true };
        rawState.towerModeBySession = { ...rawState.towerModeBySession, [sid]: false };
        saveTowerModeToStorage();
      }
      if (!(await whenSessionProfileSettled(sid))) throw PROFILE_PERSIST_FAILED;
      await retryWhileOccupied(sid, async () => {
        if (snapshot === undefined) {
          const parts = attachmentsToContent(attachments);
          await submitWithNetworkRetry(() => api.activateSkill(sid, skillName, activationArgs, parts, { skillPath: opts?.skillPath, promptId }));
        } else {
          const prompt = { text: '', attachments: attachments ?? [], snapshot };
          const parts = buildPromptContent(prompt);
          const metadata = buildPromptMetadata(prompt);
          await submitWithNetworkRetry(() => api.activateSkill(sid, skillName, activationArgs, parts, { metadata, skillPath: opts?.skillPath, promptId }));
        }
      });
      return true;
    } catch (err) {
      if (guarded) promptStore().removeOptimisticMessage(sid, tempId);
      if (err !== PROFILE_PERSIST_FAILED && !isSessionOccupiedError(err)) {
        pushSendFailure('activateSkill', err, sid);
      }
      return false;
    } finally {
      if (guarded) promptStore().setInFlight(sid, false);
    }
  }

  async function getProvider(id: string): Promise<AppProviderDetail> {
    return api.getProvider(id);
  }

  async function addProvider(input: AddProviderInput): Promise<string | null> {
    try {
      await api.addProvider(input);
      forgetRefreshFailures();
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return null;
    } catch (err) {
      logError('[kimi-code] operation failed: addProvider', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function updateProvider(id: string, input: UpdateProviderInput): Promise<string | null> {
    try {
      await api.updateProvider(id, input);
      forgetRefreshFailures();
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return null;
    } catch (err) {
      logError('[kimi-code] operation failed: updateProvider', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function deleteProvider(id: string): Promise<DeleteProviderResult | null> {
    try {
      const result = await api.deleteProvider(id);
      forgetRefreshFailures();
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return result;
    } catch (err) {
      pushOperationFailure('deleteProvider', err);
      return null;
    }
  }

  const refreshFailureSignatures = new Map<string, string>();

  function forgetRefreshFailures(): void {
    refreshFailureSignatures.clear();
  }

  function notifyProviderRefreshFailures(
    operation: 'refreshProvider' | 'refreshAllProviders',
    result: ProviderRefreshResult,
    coveredProviderIds: readonly string[],
  ): void {
    const failedByProvider = new Map(
      result.failed.map((failure) => [failure.provider, failure.reason]),
    );
    for (const id of coveredProviderIds) {
      if (!failedByProvider.has(id)) refreshFailureSignatures.delete(id);
    }
    for (const [provider, reason] of failedByProvider) {
      if (refreshFailureSignatures.get(provider) === reason) continue;
      refreshFailureSignatures.set(provider, reason);
      pushOperationFailure(operation, reason, {
        title: t('warnings.providerRefreshFailedTitle'),
        message: t('warnings.providerRefreshFailedMessage', {
          provider: providerDisplayName(provider, t),
          reason,
        }),
      });
    }
  }

  async function refreshProvider(id: string): Promise<void> {
    try {
      const result = await api.refreshProvider(id);
      notifyProviderRefreshFailures('refreshProvider', result, [id]);
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
    } catch (err) {
      pushOperationFailure('refreshProvider', err);
    }
  }

  async function refreshAllProviders(): Promise<void> {
    try {
      const result = await api.refreshAllProviders();
      notifyProviderRefreshFailures('refreshAllProviders', result, [
        ...result.changed.map((change) => change.providerId),
        ...result.unchanged,
        ...result.failed.map((failure) => failure.provider),
      ]);
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
    } catch (err) {
      pushOperationFailure('refreshAllProviders', err);
    }
  }

  async function refreshOAuthProviderModels(): Promise<{
    ok: boolean;
    failed: ProviderRefreshResult['failed'];
    changed: ProviderRefreshResult['changed'];
  }> {
    try {
      const result = await api.refreshOAuthProviderModels();
      if (result.failed.length > 0) {
        return { ok: false, failed: result.failed, changed: result.changed };
      }
      const catalogOk = await loadModels();
      const configOk = (await loadConfig()) !== 'failed';
      const authResult = await checkAuth();
      return {
        ok: catalogOk && configOk && authResult === 'proceed',
        failed: result.failed,
        changed: result.changed,
      };
    } catch {
      return { ok: false, failed: [], changed: [] };
    }
  }

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

  async function importCatalogProvider(
    input: ImportCatalogProviderInput,
  ): Promise<string | null> {
    try {
      await api.importCatalogProvider(input);
      forgetRefreshFailures();
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return null;
    } catch (err) {
      logError('[kimi-code] operation failed: importCatalogProvider', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function importCustomRegistry(
    input: ImportCustomRegistryInput,
  ): Promise<{ providers: AppProvider[]; modelsImported: number } | string> {
    try {
      const result = await api.importCustomRegistry(input);
      forgetRefreshFailures();
      await Promise.all([loadProviders(), loadModels(), loadConfig()]);
      await checkAuth();
      return result;
    } catch (err) {
      logError('[kimi-code] operation failed: importCustomRegistry', err);
      return err instanceof Error ? err.message : String(err);
    }
  }

  async function startOAuthLogin(region?: OAuthRegion): Promise<OAuthLoginStartResult | { error: string }> {
    try {
      return await api.startOAuthLogin(region);
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  }

  async function getOAuthRegion(): Promise<OAuthRegion | null> {
    return api.getOAuthRegion();
  }

  async function pollOAuthLogin(): Promise<{
    flowId: string;
    status: 'pending' | 'authenticated' | 'denied' | 'expired' | 'cancelled';
    resolvedAt?: string;
    errorMessage?: string;
  } | null> {
    try {
      return await api.pollOAuthLogin();
    } catch (err) {
      logWarn('[kimi-code] pollOAuthLogin failed', err);
      return null;
    }
  }

  async function cancelOAuthLogin(): Promise<void> {
    try {
      await api.cancelOAuthLogin();
    } catch {}
  }

  async function getUsage(): Promise<ManagedQuotaResult> {
    try {
      return await api.getUsage();
    } catch (err) {
      return { kind: 'error', message: err instanceof Error ? err.message : String(err) };
    }
  }

  function setThinking(level: ThinkingLevel): void {
    const next = applyThinkingLevel(level);
    void persistSessionProfile({ thinking: next });
  }

  return {
    models: computed(() => store.activeModels),
    recentModelIds: computed(() => store.recentModelIds),
    providers: computed(() => store.providers),
    draftModel: computed(() => store.draftModel),
    skillsBySession: computed(() => store.skillsBySession),
    skillsByWorkspace: computed(() => store.skillsByWorkspace),
    skillsFetchedBySession: computed(() => store.skillsFetchedBySession),
    skillsFetchedByWorkspace: computed(() => store.skillsFetchedByWorkspace),
    loadSkillsForSession: store.loadSkillsForSession,
    loadSkillsForWorkspace: store.loadSkillsForWorkspace,
    invalidateSkillsForSession: store.invalidateSkillsForSession,
    invalidateSkillsForWorkspace: store.invalidateSkillsForWorkspace,
    loadModels,
    loadProviders,
    setModel,
    setSessionModel,
    thinkingLevelForModelId,
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
    refreshOAuthProviderModels,
    startOAuthLogin,
    pollOAuthLogin,
    cancelOAuthLogin,
    getOAuthRegion,
    getUsage,
    setThinking,
  };
}

export type UseModelProviderState = ReturnType<typeof useModelProviderState>;
