import type { ComputedRef } from 'vue';
import { isDaemonApiError, isSessionOccupiedError } from '@moonshot-ai/app-core/api';
import type { AppMessage, AppMessageContent, AppSession, AppWorkspace, PromptDelivery } from '@moonshot-ai/app-core/api';
import { markSwarmPending, markThinkingPending, markTowerPending } from '@moonshot-ai/app-core/lib';
import type { SessionUrlMode } from '@moonshot-ai/app-core/lib';
import { buildPromptContent, buildPromptMetadata } from '../lib/browserReferenceSubmission';
import { consumeSessionIntent, getKimiWebApi, type SessionCreatedSource } from './deps';
import { markDraftPromotion } from './draftPromotion';
import { newPromptId } from './promptId';
import { createSendFailureNotifier, PromptFailedError } from './sendFailure';
import { retryWhileOccupied } from './sessionOccupancy';
import { sideChatDrafts } from './sideChatDrafts';
import { submitWithNetworkRetry } from './submitRetry';
import type { ChatGateVerdict } from '../lib/chatGate';
import { track } from '../contracts';
import { modeStore } from '../stores/mode';
import { modelsStore } from '../stores/models';
import { permissionsStore } from '../stores/permissions';
import { movedQueue, promptStore } from '../stores/prompt';
import { sessionListStore } from '../stores/sessionList';
import { sessionRatingStore } from '../stores/sessionRating';
import { sessionsStore } from '../stores/sessions';
import { warningsStore } from '../stores/warnings';
import { workspacesStore } from '../stores/workspaces';
import type { UseModelProviderState, PersistSessionProfilePatch } from './useModelProviderState';
import type { UseSideChat, SideChatTarget } from './useSideChat';
import type { ActivityState } from '@moonshot-ai/app-core/client/types';
import type {
  ExtendedState,
  PromptAttachment,
  PromptEnvelope,
  PromptEnvelopeContent,
  PromptSkillActivation,
} from './types';

const MAIN_AGENT_ID = 'main';
const PROMPT_NOT_FOUND_CODE = 40402;
const WORKSPACE_NOT_FOUND_CODE = 40410;

export interface PromptPipelineDeps {
  sideChat: UseSideChat;
  modelProvider: UseModelProviderState;
  activity: ComputedRef<ActivityState>;
  nextOptimisticMsgId: () => string;
  persistSessionProfile: (
    patch: PersistSessionProfilePatch,
    sessionId?: string,
    preserveDraftThinking?: boolean,
  ) => Promise<boolean>;
  whenSessionProfileSettled: (sid: string) => Promise<boolean>;
  mapSendAuthFailure?: (err: unknown, sid?: string) => Promise<ChatGateVerdict | null>;
  isMainTurnRunning?: (sessionId: string) => boolean;
  hasUnechoedPrompt?: (sessionId: string) => boolean;
  transcriptHasPrompt?: (sessionId: string, promptId: string) => boolean;
  isCompacting?: (sessionId: string) => boolean;
  isMainWaitForWaiting?: (sessionId: string) => boolean;
  promptIdToAbort?: (sessionId: string) => string | undefined;
  lastAgentTurnId?: (sessionId: string) => string | undefined;
  selectSession: (
    sessionId: string,
    opts?: {
      urlMode?: SessionUrlMode;
      skipTrack?: boolean;
      skipStatusRefresh?: boolean;
      source?: SessionCreatedSource;
    },
  ) => Promise<void>;
  upsertSessionSorted: (session: AppSession) => void;
}

export function usePromptPipeline(rawState: ExtendedState, deps: PromptPipelineDeps) {
  const {
    sideChat,
    modelProvider,
    activity,
    nextOptimisticMsgId,
    persistSessionProfile,
    mapSendAuthFailure,
    isMainTurnRunning,
    hasUnechoedPrompt,
    transcriptHasPrompt,
    isCompacting,
    isMainWaitForWaiting,
    promptIdToAbort,
    lastAgentTurnId,
    selectSession,
    upsertSessionSorted,
  } = deps;
  const pushSendFailure = createSendFailureNotifier({
    pushOperationFailure: warningsStore().pushOperationFailure,
    mapSendAuthFailure,
  });
  const pendingSubmitBySession = new Map<string, { promise: Promise<void>; resolve: () => void }>();
  const submitsInFlightBySession = new Map<string, number>();
  const reordersInFlightBySession = new Map<string, number>();
  const reorderChainBySession = new Map<string, Promise<unknown>>();

  function createPromptEnvelope(input: PromptEnvelopeContent): PromptEnvelope {
    return {
      text: input.text,
      snapshot: input.snapshot === undefined ? undefined : structuredClone(input.snapshot),
      attachments: [...(input.attachments ?? [])],
      skills: [...(input.skills ?? [])],
    };
  }

  async function createSessionInWorkspace(
    ws: AppWorkspace,
    model: string | undefined,
  ): Promise<{ session: AppSession; workspaceId: string | undefined }> {
    const api = getKimiWebApi();
    const request = { cwd: ws.root, model };
    const workspaceId = ws.id === ws.root ? undefined : ws.id;
    let session: AppSession;
    try {
      session = await api.createSession({ ...request, workspaceId });
    } catch (err) {
      if (!isDaemonApiError(err) || err.code !== WORKSPACE_NOT_FOUND_CODE) throw err;
      session = await api.createSession({ ...request, workspaceId: undefined });
    }
    return { session, workspaceId: session.workspaceId };
  }

  async function createDraftSession(workspaceId: string): Promise<string | null> {
    const ws = workspacesStore().mergedWorkspaces.find((w) => w.id === workspaceId);
    if (!ws) return null;
    const sessionSource = consumeSessionIntent('sidebar');
    const draftThinking = modeStore().thinking;
    const draftThinkingExplicit = modeStore().draftThinkingExplicit;
    const draftPermission = permissionsStore().forDraftPrompt();
    const draftPick = modelsStore().resolveSendModel(null, { includeDraft: true }) ?? undefined;
    const { session, workspaceId: workspaceIdForCreate } =
      await createSessionInWorkspace(ws, draftPick);
    modelsStore().setDraftModel(null);
    const sid = session.id;
    sessionListStore().notePoolInsert(sid);
    upsertSessionSorted(session.model === '' && draftPick !== undefined ? { ...session, model: draftPick } : session);
    const draftThinkingWrite = draftThinkingExplicit ? draftThinking : undefined;
    if (draftThinkingWrite !== undefined) {
      modeStore().thinkingBySession = { ...modeStore().thinkingBySession, [sid]: draftThinkingWrite };
      markThinkingPending(rawState, sid);
    }
    markDraftPromotion({ workspaceId, sessionId: sid });
    modeStore().draftThinkingExplicit = false;
    workspacesStore().selectWorkspace(session.workspaceId ?? workspaceIdForCreate ?? workspaceId);
    track('session_created', { kind: 'new', source: sessionSource });
    await selectSession(session.id, {
      skipTrack: true,
      skipStatusRefresh: true,
    });
    permissionsStore().materializeDraft(sid, draftPermission);
    const { swarmMode, towerMode, towerBase } = modeStore().draftModes;
    if (modeStore().draftModes.planMode) {
      modeStore().planArmedBySession = { ...modeStore().planArmedBySession, [sid]: true };
      modeStore().savePlanModeToStorage();
    }
    if (swarmMode) {
      modeStore().swarmModeBySession = { ...modeStore().swarmModeBySession, [sid]: true };
      modeStore().saveSwarmModeToStorage();
      markSwarmPending({ pendingSwarmBySession: modeStore().pendingSwarmBySession }, sid);
    }
    if (towerMode) {
      modeStore().towerModeBySession = { ...modeStore().towerModeBySession, [sid]: true };
      modeStore().saveTowerModeToStorage();
      markTowerPending({ pendingTowerBySession: modeStore().pendingTowerBySession }, sid);
    }
    const draftSettings: PersistSessionProfilePatch = {
      thinking: draftThinkingWrite,
      permissionMode: draftPermission,
      swarmMode: swarmMode || undefined,
      towerMode: towerMode || undefined,
      towerBase: towerMode ? towerBase : undefined,
    };
    if (Object.values(draftSettings).some((value) => value !== undefined)) {
      if (draftThinkingWrite === undefined) void persistSessionProfile(draftSettings, sid);
      else void persistSessionProfile(draftSettings, sid, true);
    }
    if (draftThinkingWrite !== undefined && draftPick !== undefined && session.model !== draftPick) {
      void modelProvider.normalizeDraftSessionModel(sid, draftPick);
    }
    if (modeStore().draftModes.goalMode) {
      modeStore().goalModeBySession = { ...modeStore().goalModeBySession, [sid]: true };
      modeStore().saveGoalModeToStorage();
    }
    modeStore().draftModes.planMode = false;
    modeStore().draftModes.swarmMode = false;
    modeStore().draftModes.towerMode = false;
    modeStore().draftModes.towerBase = undefined;
    modeStore().draftModes.goalMode = false;
    return sid;
  }

  async function startSessionAndSendPrompt(
    workspaceId: string,
    prompt: PromptEnvelope,
  ): Promise<{ sessionId: string | null; promptRejected: boolean; concurrent?: boolean }> {
    if (!promptStore().tryBeginStartingFirstPrompt(workspaceId)) {
      return { sessionId: null, promptRejected: false, concurrent: true };
    }
    let createdId: string | null = null;
    try {
      const sid = await createDraftSession(workspaceId);
      if (!sid) return { sessionId: null, promptRejected: false };
      createdId = sid;
      const outcome = await submitPromptInternal(sid, prompt);
      return { sessionId: sid, promptRejected: outcome === 'rejected' };
    } catch (err) {
      warningsStore().pushOperationFailure('startSessionAndSendPrompt', err);
      return { sessionId: createdId, promptRejected: false };
    } finally {
      promptStore().endStartingFirstPrompt(workspaceId);
    }
  }

  async function startSessionAndActivateSkill(
    workspaceId: string,
    skillName: string,
    args?: string,
    attachments?: PromptAttachment[],
    snapshot?: PromptEnvelope['snapshot'],
    skillPath?: string,
  ): Promise<{ sessionId: string | null; activated: boolean }> {
    if (!promptStore().tryBeginStartingFirstPrompt(workspaceId)) return { sessionId: null, activated: false };
    const savedSnapshot = snapshot === undefined ? undefined : structuredClone(snapshot);
    let createdId: string | null = null;
    try {
      const sid = await createDraftSession(workspaceId);
      if (!sid) return { sessionId: null, activated: false };
      createdId = sid;
      const activated = await modelProvider.activateSkill(skillName, args, attachments, sid, { snapshot: savedSnapshot, skillPath });
      return { sessionId: sid, activated };
    } catch (err) {
      warningsStore().pushOperationFailure('startSessionAndActivateSkill', err);
      return { sessionId: createdId, activated: false };
    } finally {
      promptStore().endStartingFirstPrompt(workspaceId);
    }
  }

  async function startSessionAndOpenSideChat(
    workspaceId: string,
    prompt?: string | PromptEnvelopeContent,
  ): Promise<{ sessionId: string; target: SideChatTarget | null; sent: boolean } | null> {
    if (prompt !== undefined && typeof prompt !== 'string') prompt = structuredClone(prompt);
    if (!promptStore().tryBeginStartingFirstPrompt(workspaceId)) return null;
    let createdId: string | null = null;
    try {
      const sid = await createDraftSession(workspaceId);
      if (!sid) return null;
      createdId = sid;
      const result = await sideChat.openSideChatOn(sid, prompt);
      if (result.target && !result.sent && typeof prompt === 'string' && prompt) {
        sideChatDrafts.set(result.target.agentId, prompt);
      }
      return { sessionId: sid, target: result.target, sent: result.sent };
    } catch (err) {
      warningsStore().pushOperationFailure('startSessionAndOpenSideChat', err);
      return createdId ? { sessionId: createdId, target: null, sent: false } : null;
    } finally {
      promptStore().endStartingFirstPrompt(workspaceId);
    }
  }

  function buildOptimisticUserMessage(
    sid: string,
    tempId: string,
    content: AppMessageContent[],
    skills: PromptSkillActivation[],
    extraMetadata?: Record<string, unknown>,
  ): AppMessage {
    return {
      id: tempId,
      sessionId: sid,
      role: 'user',
      content,
      createdAt: new Date().toISOString(),
      metadata: {
        'kimiWeb.optimisticUserMessage': true,
        ...extraMetadata,
        ...(skills.length > 0
          ? {
              origin: {
                kind: 'user',
                skillActivations: skills.map((skill, index) => ({
                  activationId: `optimistic-${index}-${skill.name}`,
                  skillName: skill.name,
                  skillPath: skill.path,
                  skillArgs: skill.args,
                })),
              },
            }
          : {}),
      },
    };
  }

  function rollBackSubmit(sid: string, tempId: string): 'rejected' {
    promptStore().removeOptimisticMessage(sid, tempId);
    return 'rejected';
  }

  function mainBusy(sid: string): boolean {
    return (
      promptStore().inFlightBySession[sid] === true ||
      promptStore().isContinueTurnStarting(sid) ||
      isMainTurnRunning?.(sid) === true ||
      hasUnechoedPrompt?.(sid) === true
    );
  }

  async function settleSessionSettings(sid: string): Promise<boolean> {
    const current = sessionsStore().sessions.find((s) => s.id === sid)?.model;
    const sendable = modelsStore().resolveSendModel(current);
    if (sendable !== null && sendable !== current) {
      void modelProvider.setSessionModel(sid, sendable);
    }
    return deps.whenSessionProfileSettled(sid);
  }

  async function commitArmedPlanMode(sid: string): Promise<boolean> {
    if (!(modeStore().planArmedBySession[sid] ?? false)) return true;
    modeStore().planArmedBySession = { ...modeStore().planArmedBySession, [sid]: false };
    modeStore().savePlanModeToStorage();
    if (modeStore().planModeBySession[sid] ?? false) return true;
    if (!(await persistSessionProfile({ planMode: true, towerMode: false }, sid))) return false;
    modeStore().planModeBySession = { ...modeStore().planModeBySession, [sid]: true };
    modeStore().towerModeBySession = { ...modeStore().towerModeBySession, [sid]: false };
    modeStore().saveTowerModeToStorage();
    return true;
  }

  function beginSubmitFlight(sid: string): {
    sessionGenAtEntry: number;
    endFlight: () => void;
  } {
    let resolveSubmitReady!: () => void;
    const submitReady = {
      promise: new Promise<void>((resolve) => {
        resolveSubmitReady = resolve;
      }),
      resolve: () => resolveSubmitReady(),
    };
    pendingSubmitBySession.set(sid, submitReady);
    const sessionGenAtEntry = permissionsStore().sessionTeardownGenFor(sid);
    permissionsStore().noteSubmitPrepStart(sid);
    submitsInFlightBySession.set(sid, (submitsInFlightBySession.get(sid) ?? 0) + 1);
    promptStore().setInFlight(sid, true);
    return {
      sessionGenAtEntry,
      endFlight: () => {
        submitReady.resolve();
        if (pendingSubmitBySession.get(sid) === submitReady) pendingSubmitBySession.delete(sid);
        const remaining = (submitsInFlightBySession.get(sid) ?? 1) - 1;
        if (remaining > 0) {
          submitsInFlightBySession.set(sid, remaining);
        } else {
          submitsInFlightBySession.delete(sid);
          promptStore().setInFlight(sid, false);
        }
        permissionsStore().noteSubmitPrepEnd(sid);
      },
    };
  }

  function queuedLocally(sid: string, promptId: string): boolean {
    return (promptStore().queueBySession[sid] ?? []).some((entry) => entry.promptId === promptId);
  }

  async function submitPromptInternal(
    sid: string,
    prompt: PromptEnvelope,
    opts?: { recoverConflicts?: boolean; delivery?: PromptDelivery; editText?: string; followTowerMode?: boolean },
  ): Promise<'ok' | 'rejected' | 'queued'> {
    const { sessionGenAtEntry, endFlight } = beginSubmitFlight(sid);
    const { text, skills } = prompt;
    let delivery = opts?.delivery ?? 'queue';
    const tempId = nextOptimisticMsgId();
    const promptId = newPromptId();
    try {
      const api = getKimiWebApi();
      const content = buildPromptContent(prompt);
      if (content.length === 0) return 'rejected';

      const markDelivery = (steered: boolean) =>
        steered
          ? { 'kimiWeb.steered': true, 'kimiWeb.steerPhase': 'sending' }
          : { 'kimiWeb.steered': undefined, 'kimiWeb.steerPhase': undefined };
      promptStore().addOptimisticMessage(sid, buildOptimisticUserMessage(sid, tempId, content, skills, {
        'kimiWeb.promptId': promptId,
        ...markDelivery(delivery === 'steer'),
        ...(prompt.snapshot === undefined ? {} : { 'kimiWeb.composerSnapshot': prompt.snapshot }),
      }));

      if (!(await commitArmedPlanMode(sid))) return rollBackSubmit(sid, tempId);

      if ((modeStore().goalModeBySession[sid] ?? false) && text) {
        if (!(await persistSessionProfile({ goalObjective: text.trim(), planMode: false }, sid))) return rollBackSubmit(sid, tempId);
        modeStore().planModeBySession = { ...modeStore().planModeBySession, [sid]: false };
        modeStore().goalModeBySession = { ...modeStore().goalModeBySession, [sid]: false };
        modeStore().saveGoalModeToStorage();
      }

      if (!(await settleSessionSettings(sid))) return rollBackSubmit(sid, tempId);
      if (opts?.followTowerMode === true) {
        delivery = deliveryForSend(sid);
        promptStore().patchOptimisticMessage(sid, tempId, markDelivery(delivery === 'steer'));
      }

      const metadata = buildPromptMetadata(prompt);
      const request = {
        promptId,
        content,
        metadata: opts?.editText === undefined ? metadata : { ...metadata, edit_text: opts.editText },
        skills: skills.length > 0 ? skills : undefined,
        delivery,
      };
      const attempt = async () => {
        if (permissionsStore().sessionTeardownGenFor(sid) !== sessionGenAtEntry) return null;
        return submitWithNetworkRetry(() => api.submitPrompt(sid, request));
      };
      const result = opts?.recoverConflicts === true
        ? await retryWhileOccupied(sid, attempt)
        : await attempt();
      if (result === null) return rollBackSubmit(sid, tempId);
      if (result.status === 'failed') throw new PromptFailedError(promptId);

      if (result.acceptedAs === 'queue' || result.status === 'queued') {
        promptStore().patchOptimisticMessage(sid, tempId, {
          'kimiWeb.queued': true,
          ...(result.acceptedAs === 'steer' ? {} : markDelivery(false)),
        });
        if (queuedLocally(sid, promptId)) promptStore().removeOptimisticMessage(sid, tempId);
        return 'queued';
      }
      if (result.acceptedAs === 'steer') {
        promptStore().patchOptimisticMessage(sid, tempId, { 'kimiWeb.steered': true, 'kimiWeb.steerPhase': 'accepted' });
      } else {
        promptStore().patchOptimisticMessage(sid, tempId, markDelivery(false));
      }
      return 'ok';
    } catch (err) {
      if (transcriptHasPrompt?.(sid, promptId) === true) return 'ok';
      if (queuedLocally(sid, promptId)) {
        promptStore().removeOptimisticMessage(sid, tempId);
        return 'queued';
      }
      rollBackSubmit(sid, tempId);
      const dismissedOccupied = opts?.recoverConflicts === true && isSessionOccupiedError(err);
      if (!dismissedOccupied) pushSendFailure(delivery === 'steer' ? 'steer' : 'sendPrompt', err, sid);
      return 'rejected';
    } finally {
      endFlight();
    }
  }

  function promptBacklog(sid: string): 'busy' | 'clear' {
    if (
      activity.value !== 'idle' ||
      promptStore().inFlightBySession[sid] === true ||
      promptStore().isContinueTurnStarting(sid) ||
      isCompacting?.(sid) === true ||
      (promptStore().queueBySession[sid]?.length ?? 0) > 0
    ) {
      return 'busy';
    }
    return 'clear';
  }

  function steersIntoRunningTurn(sid: string): boolean {
    return modeStore().towerModeBySession?.[sid] ?? false;
  }

  function deliveryForSend(sid: string): PromptDelivery {
    if (!steersIntoRunningTurn(sid)) return 'queue';
    return isMainWaitForWaiting?.(sid) === true ? 'queue' : 'steer';
  }

  function wouldEnqueuePrompt(sid?: string): boolean {
    const target = sid ?? sessionsStore().activeSessionId;
    return target !== undefined && promptBacklog(target) !== 'clear' && deliveryForSend(target) === 'queue';
  }

  function wouldSteerPrompt(sid?: string): boolean {
    const target = sid ?? sessionsStore().activeSessionId;
    return target !== undefined && promptBacklog(target) !== 'clear' && deliveryForSend(target) === 'steer';
  }

  async function sendPrompt(
    prompt: PromptEnvelope,
    editText?: string,
    opts?: { recoverConflicts?: boolean; forceQueue?: boolean },
  ): Promise<'ok' | 'rejected' | 'queued'> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return 'rejected';
    const delivery = opts?.forceQueue === true ? 'queue' : deliveryForSend(sid);
    return submitPromptInternal(sid, prompt, {
      ...opts,
      delivery,
      editText,
      followTowerMode: opts?.forceQueue !== true,
    });
  }

  async function steerPrompt(prompt: PromptEnvelope, editText?: string, targetSid?: string): Promise<'ok' | 'rejected' | 'queued'> {
    const sid = targetSid ?? sessionsStore().activeSessionId;
    if (!sid) return 'rejected';
    return submitPromptInternal(sid, prompt, { delivery: 'steer', editText });
  }

  async function steerQueued(promptId: string): Promise<'ok' | 'rejected'> {
    const sid = sessionsStore().activeSessionId;
    if (sid === undefined) return 'rejected';
    const input = (promptStore().queueBySession[sid] ?? []).find((entry) => entry.promptId === promptId);
    if (input === undefined) return 'rejected';
    const tempId = nextOptimisticMsgId();
    const snapshot = input.clientMetadata?.['kimi_code_composer'];
    promptStore().addOptimisticMessage(sid, buildOptimisticUserMessage(sid, tempId, [...input.content], [...(input.skills ?? [])], {
      'kimiWeb.promptId': input.promptId,
      'kimiWeb.steered': true,
      'kimiWeb.steerPhase': 'accepted',
      ...(snapshot === undefined ? {} : { 'kimiWeb.composerSnapshot': snapshot }),
    }));
    try {
      const result = await getKimiWebApi().steerPrompts(sid, [input.promptId]);
      if (result.steered && result.promptIds.includes(input.promptId)) {
        promptStore().patchOptimisticMessage(sid, tempId, { 'kimiWeb.queued': true });
        promptStore().dropQueueEntry(sid, input.promptId);
        return 'ok';
      }
      promptStore().removeOptimisticMessage(sid, tempId);
      return 'rejected';
    } catch (err) {
      if (transcriptHasPrompt?.(sid, input.promptId) === true) return 'ok';
      promptStore().removeOptimisticMessage(sid, tempId);
      if (!isDaemonApiError(err) || err.code !== PROMPT_NOT_FOUND_CODE) {
        warningsStore().pushOperationFailure('steerQueued', err, { sessionId: sid });
      }
      return 'rejected';
    }
  }

  async function uploadImage(file: Blob, name?: string, onProgress?: (loaded: number, total: number) => void, signal?: AbortSignal): Promise<{ fileId: string; name: string; mediaType: string } | null> {
    try {
      const api = getKimiWebApi();
      const hostId = workspacesStore().visibleWorkspace?.hostId;
      const result = await api.uploadFile({ file, name, hostId, onProgress, signal });
      return { fileId: result.id, name: result.name, mediaType: result.mediaType };
    } catch (err) {
      if (err instanceof DOMException && err.name === 'AbortError') return null;
      warningsStore().pushOperationFailure('uploadImage', err);
      return null;
    }
  }

  async function abortCurrentPrompt(): Promise<boolean> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return false;
    const promptId = promptIdToAbort?.(sid);
    const api = getKimiWebApi();

    if (promptId !== undefined) {
      try {
        if (!(await api.abortPrompt(sid, promptId)).aborted) return false;
        const pending = promptStore().optimisticMessagesBySession[sid] ?? [];
        promptStore().setOptimisticMessages(sid, pending.filter((msg) => msg.metadata?.['kimiWeb.promptId'] !== promptId));
        return true;
      } catch (err) {
        if (!isDaemonApiError(err) || err.code !== PROMPT_NOT_FOUND_CODE) {
          warningsStore().pushOperationFailure('abortCurrentPrompt', err, { sessionId: sid });
        }
        return false;
      }
    }

    if (!mainBusy(sid)) return false;
    try {
      const result = await api.cancelSession(sid);
      return result.cancelled === true;
    } catch (err) {
      warningsStore().pushOperationFailure('abortCurrentPrompt', err, { sessionId: sid });
      return false;
    }
  }

  async function continueSession(targetSid?: string): Promise<'ok' | 'rejected' | 'noop'> {
    const sid = targetSid ?? sessionsStore().activeSessionId;
    if (!sid || mainBusy(sid) || promptBacklog(sid) !== 'clear') return 'noop';
    const { sessionGenAtEntry, endFlight } = beginSubmitFlight(sid);
    const turnIdBefore = lastAgentTurnId?.(sid);
    sessionRatingStore().endSession(sid);
    try {
      if (!(await commitArmedPlanMode(sid)) || !(await settleSessionSettings(sid))) return 'rejected';
      const api = getKimiWebApi();
      const result = await retryWhileOccupied(sid, async () => {
        if (permissionsStore().sessionTeardownGenFor(sid) !== sessionGenAtEntry) return null;
        return api.continueSession(sid);
      });
      if (result === null) return 'rejected';
      if (isMainTurnRunning?.(sid) !== true && lastAgentTurnId?.(sid) === turnIdBefore) {
        promptStore().beginContinueTurnStart(sid);
      }
      return 'ok';
    } catch (err) {
      if (!isSessionOccupiedError(err)) pushSendFailure('continueSession', err, sid);
      return 'rejected';
    } finally {
      endFlight();
    }
  }

  async function unqueue(promptId: string): Promise<boolean> {
    const sid = sessionsStore().activeSessionId;
    if (sid === undefined) return false;
    try {
      const { aborted } = await getKimiWebApi().abortPrompt(sid, promptId);
      if (aborted) {
        promptStore().dropQueueEntry(sid, promptId);
        promptStore().setOptimisticMessages(
          sid,
          (promptStore().optimisticMessagesBySession[sid] ?? []).filter((message) => message.metadata?.['kimiWeb.promptId'] !== promptId),
        );
      }
      return aborted;
    } catch (err) {
      if (!isDaemonApiError(err) || err.code !== PROMPT_NOT_FOUND_CODE) {
        warningsStore().pushOperationFailure('unqueue', err, { sessionId: sid });
      }
      return false;
    }
  }

  async function reorderQueue(promptId: string, beforePromptId: string | undefined): Promise<void> {
    const sid = sessionsStore().activeSessionId;
    if (sid === undefined || promptId === beforePromptId) return;
    const next = movedQueue(promptStore().queueBySession[sid] ?? [], promptId, beforePromptId);
    if (next === undefined) return;
    promptStore().showQueue(sid, next);
    reordersInFlightBySession.set(sid, (reordersInFlightBySession.get(sid) ?? 0) + 1);
    const move = (reorderChainBySession.get(sid) ?? Promise.resolve()).then(() =>
      getKimiWebApi().moveQueuedPrompt(sid, MAIN_AGENT_ID, promptId, beforePromptId),
    );
    reorderChainBySession.set(sid, move.catch(() => undefined));
    try {
      await move;
      promptStore().confirmQueueMove(sid, promptId, beforePromptId);
    } catch (err) {
      if (!isDaemonApiError(err) || err.code !== PROMPT_NOT_FOUND_CODE) {
        warningsStore().pushOperationFailure('reorderQueue', err, { sessionId: sid });
      }
    } finally {
      const remaining = (reordersInFlightBySession.get(sid) ?? 1) - 1;
      if (remaining > 0) {
        reordersInFlightBySession.set(sid, remaining);
      } else {
        reordersInFlightBySession.delete(sid);
        reorderChainBySession.delete(sid);
        promptStore().restoreConfirmedQueue(sid);
      }
    }
  }

  return {
    createPromptEnvelope,
    createDraftSession,
    startSessionAndSendPrompt,
    startSessionAndActivateSkill,
    startSessionAndOpenSideChat,
    buildOptimisticUserMessage,
    submitPromptInternal,
    promptBacklog,
    wouldEnqueuePrompt,
    wouldSteerPrompt,
    sendPrompt,
    steerPrompt,
    steerQueued,
    uploadImage,
    abortCurrentPrompt,
    continueSession,
    unqueue,
    reorderQueue,
  };
}

export type UsePromptPipeline = ReturnType<typeof usePromptPipeline>;
