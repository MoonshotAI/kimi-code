import { toRaw, type ComputedRef } from 'vue';
import { isDaemonApiError, isSessionOccupiedError } from '@moonshot-ai/app-core/api';
import type { AppMessage, AppMessageContent, AppSession, AppWorkspace } from '@moonshot-ai/app-core/api';
import { markSwarmPending, markThinkingPending, markTowerPending, skillIdentity, defaultSkillPath } from '@moonshot-ai/app-core/lib';
import type { SessionUrlMode } from '@moonshot-ai/app-core/lib';
import { offsetAttachmentLinkIndices } from '@moonshot-ai/app-composer/model';
import { buildPromptContent, buildPromptMetadata } from '../lib/browserReferenceSubmission';
import { prepareMergedPromptSnapshots } from '../lib/composerMessageSnapshot';
import { consumeSessionIntent, getKimiWebApi, t, type SessionCreatedSource } from './deps';
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
import { modelSwitchConfirmStore } from '../stores/modelSwitchConfirm';
import { permissionsStore } from '../stores/permissions';
import { chainSteer, isCurrentSteerChain, promptStore } from '../stores/prompt';
import { sessionListStore } from '../stores/sessionList';
import { sessionRuntimeStore } from '../stores/sessionRuntime';
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
  QueuedPrompt,
} from './types';

const MAX_QUEUE_FLUSH_FAILURES = 3;
const COMPACT_RETRY_DELAY_MS = 1000;
const PROMPT_NOT_FOUND_CODE = 40402;
const WORKSPACE_NOT_FOUND_CODE = 40410;

export interface PromptPipelineDeps {
  sideChat: UseSideChat;
  modelProvider: UseModelProviderState;
  activity: ComputedRef<ActivityState>;
  nextOptimisticMsgId: () => string;
  persistSessionProfile: (patch: PersistSessionProfilePatch, sessionId?: string) => Promise<boolean>;
  whenSessionProfileSettled: (sid: string) => Promise<boolean>;
  mapSendAuthFailure?: (err: unknown, sid?: string) => Promise<ChatGateVerdict | null>;
  isMainTurnRunning?: (sessionId: string) => boolean;
  hasUnechoedPrompt?: (sessionId: string) => boolean;
  isCompacting?: (sessionId: string) => boolean;
  isMainWaitForWaiting?: (sessionId: string) => boolean;
  promptIdToAbort?: (sessionId: string) => string | undefined;
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
    isCompacting,
    isMainWaitForWaiting,
    promptIdToAbort,
    selectSession,
    upsertSessionSorted,
  } = deps;
  const pushSendFailure = createSendFailureNotifier({
    pushOperationFailure: warningsStore().pushOperationFailure,
    mapSendAuthFailure,
  });
  const pendingSubmitBySession = new Map<string, { promise: Promise<void>; resolve: () => void }>();

  function createPromptEnvelope(input: PromptEnvelopeContent): PromptEnvelope {
    return {
      text: input.text,
      snapshot: input.snapshot === undefined ? undefined : structuredClone(input.snapshot),
      attachments: [...(input.attachments ?? [])],
      skills: [...(input.skills ?? [])],
    };
  }

  function queuedPromptEnvelope(entry: {
    text: string;
    snapshot?: PromptEnvelope['snapshot'];
    attachments?: PromptAttachment[];
    skills?: PromptSkillActivation[];
  }): PromptEnvelope {
    return {
      text: entry.text,
      snapshot: entry.snapshot === undefined ? undefined : toRaw(entry.snapshot),
      attachments: entry.attachments ?? [],
      skills: entry.skills ?? [],
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
    upsertSessionSorted(session);
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
      void persistSessionProfile(draftSettings, sid);
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

  async function submitPromptInternal(
    sid: string,
    prompt: PromptEnvelope,
    opts?: { recoverConflicts?: boolean },
  ): Promise<'ok' | 'rejected'> {
    let resolveSubmitReady!: () => void;
    const submitReady = {
      promise: new Promise<void>((resolve) => {
        resolveSubmitReady = resolve;
      }),
      resolve: () => resolveSubmitReady(),
    };
    pendingSubmitBySession.set(sid, submitReady);
    const { text, skills } = prompt;
    const sessionGenAtEntry = permissionsStore().sessionTeardownGenFor(sid);
    permissionsStore().noteSubmitPrepStart(sid);
    promptStore().setInFlight(sid, true);
    const tempId = nextOptimisticMsgId();
    const promptId = newPromptId();
    let outcome: 'ok' | 'rejected' | null = null;
    try {
      const api = getKimiWebApi();
      const content = buildPromptContent(prompt);
      if (content.length === 0) return 'rejected';

      promptStore().addOptimisticMessage(sid, buildOptimisticUserMessage(sid, tempId, content, skills, {
        'kimiWeb.promptId': promptId,
        ...(prompt.snapshot === undefined ? {} : { 'kimiWeb.composerSnapshot': prompt.snapshot }),
      }));

      if (modeStore().planArmedBySession[sid] ?? false) {
        modeStore().planArmedBySession = { ...modeStore().planArmedBySession, [sid]: false };
        modeStore().savePlanModeToStorage();
        if (!(modeStore().planModeBySession[sid] ?? false)) {
          if (!(await persistSessionProfile({ planMode: true, towerMode: false }, sid))) return rollBackSubmit(sid, tempId);
          modeStore().planModeBySession = { ...modeStore().planModeBySession, [sid]: true };
          modeStore().towerModeBySession = { ...modeStore().towerModeBySession, [sid]: false };
          modeStore().saveTowerModeToStorage();
        }
      }

      if ((modeStore().goalModeBySession[sid] ?? false) && text) {
        if (!(await persistSessionProfile({ goalObjective: text.trim(), planMode: false }, sid))) return rollBackSubmit(sid, tempId);
        modeStore().planModeBySession = { ...modeStore().planModeBySession, [sid]: false };
        modeStore().goalModeBySession = { ...modeStore().goalModeBySession, [sid]: false };
        modeStore().saveGoalModeToStorage();
      }

      if (!(await settleSessionSettings(sid))) return rollBackSubmit(sid, tempId);

      const request = {
        promptId,
        content,
        metadata: buildPromptMetadata(prompt),
        skills: skills.length > 0 ? skills : undefined,
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

      outcome = 'ok';
      return outcome;
    } catch (err) {
      outcome = rollBackSubmit(sid, tempId);
      const dismissedOccupied = opts?.recoverConflicts === true && isSessionOccupiedError(err);
      if (!dismissedOccupied) pushSendFailure('sendPrompt', err, sid);
      return outcome;
    } finally {
      submitReady.resolve();
      if (pendingSubmitBySession.get(sid) === submitReady) pendingSubmitBySession.delete(sid);
      promptStore().setInFlight(sid, false);
      permissionsStore().noteSubmitPrepEnd(sid);
      if (outcome === 'ok') resumeQueueIfIdle(sid);
    }
  }

  function promptBacklog(sid: string): 'busy' | 'lined-up' | 'clear' {
    if (activity.value !== 'idle' || promptStore().inFlightBySession[sid]) return 'busy';
    if (
      promptStore().isCompactFlushHeld(sid) ||
      isCompacting?.(sid) === true ||
      (promptStore().queuedBySession[sid]?.length ?? 0) > 0 ||
      promptStore().isSteerInFlight(sid)
    ) {
      return 'lined-up';
    }
    return 'clear';
  }

  function wouldEnqueuePrompt(sid?: string): boolean {
    const target = sid ?? sessionsStore().activeSessionId;
    return target !== undefined && promptBacklog(target) !== 'clear';
  }

  function steersIntoRunningTurn(sid: string): boolean {
    return modeStore().towerModeBySession?.[sid] ?? false;
  }

  function profileWritePending(sid: string): boolean {
    return sessionRuntimeStore().profileWriteChainBySid.has(sid);
  }

  function wouldSteerPrompt(sid?: string): boolean {
    const target = sid ?? sessionsStore().activeSessionId;
    if (target === undefined) return false;
    return promptBacklog(target) !== 'clear' && steersIntoRunningTurn(target);
  }

  async function sendPrompt(
    prompt: PromptEnvelope,
    editText?: string,
    opts?: { recoverConflicts?: boolean; forceQueue?: boolean },
  ): Promise<'ok' | 'rejected' | 'queued'> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return 'rejected';

    const backlog = promptBacklog(sid);
    if (backlog !== 'clear') {
      if (!opts?.forceQueue && steersIntoRunningTurn(sid)) {
        const joinedWrite = profileWritePending(sid) ? deps.whenSessionProfileSettled(sid) : undefined;
        const outcome = await chainSteer(sid, async () => {
          if (joinedWrite !== undefined || profileWritePending(sid)) {
            const settled =
              (joinedWrite === undefined || (await joinedWrite)) &&
              (!profileWritePending(sid) || (await deps.whenSessionProfileSettled(sid)));
            if (!settled || sessionsStore().activeSessionId !== sid) return 'rejected' as const;
          }
          return steersIntoRunningTurn(sid) ? steerPromptNow(sid, prompt, editText) : ('requeue' as const);
        });
        if (outcome === 'requeue') {
          promptStore().enqueueForSession(sid, prompt, editText);
          resumeQueueIfIdle(sid);
          return 'queued';
        }
        return outcome === 'noop' ? 'rejected' : outcome;
      }
      enqueue(prompt, editText);
      if (backlog === 'lined-up') flushQueueHead(sid);
      return 'queued';
    }

    return submitPromptInternal(sid, prompt, opts);
  }

  async function runSteerIntoTurn(
    sid: string,
    prompt: PromptEnvelope,
    direct = false,
  ): Promise<'ok' | 'rejected'> {
    const { skills } = prompt;
    promptStore().noteSteerStart(sid);
    try {
      if (!mainBusy(sid) && isMainWaitForWaiting?.(sid) !== true) {
        return await submitPromptInternal(sid, prompt);
      }

      const content = buildPromptContent(prompt);
      const tempId = nextOptimisticMsgId();
      const promptId = newPromptId();
      const optimisticMsg = buildOptimisticUserMessage(sid, tempId, content, skills, {
        'kimiWeb.steered': true,
        'kimiWeb.steerPhase': 'sending',
        'kimiWeb.promptId': promptId,
        ...(prompt.snapshot === undefined ? {} : { 'kimiWeb.composerSnapshot': prompt.snapshot }),
      });
      promptStore().addOptimisticMessage(sid, optimisticMsg);

      const sessionGenAtEntry = permissionsStore().sessionTeardownGenFor(sid);
      permissionsStore().noteSubmitPrepStart(sid);
      let steerOutcome: 'ok' | 'rejected' | null = null;
      try {
        const api = getKimiWebApi();
        if (
          !(await settleSessionSettings(sid)) ||
          permissionsStore().sessionTeardownGenFor(sid) !== sessionGenAtEntry
        ) {
          promptStore().removeOptimisticMessage(sid, tempId);
          steerOutcome = 'rejected';
          return steerOutcome;
        }
        const request = {
          promptId,
          content,
          metadata: buildPromptMetadata(prompt),
          skills: skills.length > 0 ? skills : undefined,
        };
        const result = await submitWithNetworkRetry(() => direct ? api.steerPrompt(sid, request) : api.submitPrompt(sid, request));
        if (result.status === 'failed') throw new PromptFailedError(promptId);

        if (result.status !== 'queued' || direct) {
          promptStore().patchOptimisticMessage(sid, tempId, {
            'kimiWeb.steered': direct ? true : undefined,
            'kimiWeb.steerPhase': direct ? 'accepted' : undefined,
          });
          steerOutcome = 'ok';
          return steerOutcome;
        }

        try {
          const steerResult = await api.steerPrompts(sid, [promptId]);
          if (steerResult.steered !== true || !steerResult.promptIds.includes(promptId)) {
            promptStore().patchOptimisticMessage(sid, tempId, { 'kimiWeb.steered': undefined, 'kimiWeb.steerPhase': undefined });
          } else {
            promptStore().patchOptimisticMessage(sid, tempId, { 'kimiWeb.steerPhase': 'accepted' });
          }
        } catch (err) {
          if (isDaemonApiError(err) && err.code === 40402) {
            promptStore().patchOptimisticMessage(sid, tempId, { 'kimiWeb.steered': undefined });
          }
        }
        steerOutcome = 'ok';
        return steerOutcome;
      } catch (err) {
        promptStore().removeOptimisticMessage(sid, tempId);
        pushSendFailure('steer', err, sid);
        steerOutcome = 'rejected';
        return steerOutcome;
      } finally {
        permissionsStore().noteSubmitPrepEnd(sid);
      }
    } finally {
      promptStore().noteSteerSettled(sid);
    }
  }

  function resumeQueueIfIdle(sid: string): void {
    if (promptStore().isSteerInFlight(sid) || mainBusy(sid)) return;
    flushQueueHead(sid);
  }

  async function steerPrompt(prompt: PromptEnvelope, editText?: string): Promise<'ok' | 'rejected' | 'noop' | 'queued'> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return 'noop';
    return chainSteer(sid, () => steerPromptNow(sid, prompt, editText));
  }

  async function steerPromptDirect(prompt: PromptEnvelope, targetSid?: string): Promise<'ok' | 'rejected' | 'noop'> {
    const sid = targetSid ?? sessionsStore().activeSessionId;
    if (!sid) return 'noop';
    const chained = chainSteer(sid, async () => {
      await pendingSubmitBySession.get(sid)?.promise;
      const outcome = await runSteerIntoTurn(sid, prompt, true);
      return outcome;
    });
    const outcome = await chained;
    if (outcome !== 'ok' && isCurrentSteerChain(sid, chained)) resumeQueueIfIdle(sid);
    return outcome;
  }

  async function steerPromptNow(
    sid: string,
    livePrompt: PromptEnvelope,
    liveEditText?: string,
  ): Promise<'ok' | 'rejected' | 'noop' | 'queued'> {
    const entries = promptStore().queuedBySession[sid] ?? [];
    const barrierIndex = entries.findIndex((entry) => entry.kind === 'compact');
    const queue = barrierIndex >= 0 ? entries.slice(0, barrierIndex) : entries;
    let liveQueued = false;
    if (barrierIndex >= 0) {
      promptStore().enqueueForSession(sid, livePrompt, liveEditText);
      liveQueued = true;
    }
    const live = barrierIndex >= 0 ? undefined : livePrompt;
    const prepared = prepareMergedPromptSnapshots([
      ...queue.map(queuedPromptEnvelope),
      ...(live === undefined ? [] : [live]),
    ]);
    const preparedLive = live === undefined ? undefined : prepared.prompts.at(-1);
    const parts: string[] = [];
    const mergedAttachments: PromptAttachment[] = [];
    let mergedFileCount = 0;
    let mergedMediaCount = 0;
    for (const q of prepared.prompts.slice(0, queue.length)) {
      const trimmed = q.text.trim();
      if (trimmed) parts.push(offsetAttachmentLinkIndices(trimmed, mergedFileCount, mergedMediaCount));
      if (q.attachments?.length) {
        mergedAttachments.push(...q.attachments);
        mergedFileCount += q.attachments.filter((a) => a.kind === 'file').length;
        mergedMediaCount += q.attachments.filter((a) => a.kind === 'image' || a.kind === 'video').length;
      }
    }
    const liveText = preparedLive?.text.trim() ?? '';
    if (liveText) parts.push(offsetAttachmentLinkIndices(liveText, mergedFileCount, mergedMediaCount));
    if (preparedLive !== undefined && preparedLive.attachments.length > 0) {
      mergedAttachments.push(...preparedLive.attachments);
    }
    if (parts.length === 0 && mergedAttachments.length === 0) return liveQueued ? 'queued' : 'noop';
    if (queue.length > 0) {
      const current = promptStore().queuedBySession[sid] ?? [];
      promptStore().setQueuedEntries(sid, barrierIndex >= 0 ? current.slice(barrierIndex) : []);
    }
    const merged = parts.join('\n\n');
    const mergedSkills: PromptSkillActivation[] = [];
    const seenSkills = new Set<string>();
    const availableSkills = modelsStore().skillsBySession[sid] ?? [];
    const mergeSkills = (entries: readonly PromptSkillActivation[]): void => {
      for (const skill of entries) {
        const normalized = { ...skill, path: skill.path ?? defaultSkillPath(availableSkills, skill.name) };
        const key = skillIdentity(normalized);
        if (seenSkills.has(key)) continue;
        seenSkills.add(key);
        mergedSkills.push(normalized);
      }
    };
    for (const q of queue) mergeSkills(q.skills ?? []);
    mergeSkills(live?.skills ?? []);

    const restoreQueue = (): void => {
      if (queue.length === 0) return;
      const current = promptStore().queuedBySession[sid] ?? [];
      promptStore().setQueuedEntries(sid, [...queue, ...current]);
    };

    const outcome = await runSteerIntoTurn(sid, {
      text: merged,
      snapshot: prepared.snapshot,
      attachments: mergedAttachments,
      skills: mergedSkills,
    });
    if (outcome === 'rejected') restoreQueue();
    if (outcome !== 'ok') resumeQueueIfIdle(sid);
    return liveQueued ? 'queued' : outcome;
  }

  async function steerQueued(index: number): Promise<'ok' | 'rejected'> {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return 'rejected';
    const clicked = (promptStore().queuedBySession[sid] ?? [])[index];
    if (clicked === undefined) return 'rejected';
    const key = clicked.id ?? clicked.text;
    return chainSteer(sid, () => steerQueuedNow(sid, key));
  }

  async function steerQueuedNow(sid: string, key: string): Promise<'ok' | 'rejected'> {
    const current = promptStore().queuedBySession[sid] ?? [];
    const index = current.findIndex((e) => (e.id ?? e.text) === key);
    const entry = index >= 0 ? current[index] : undefined;
    if (entry === undefined) return 'rejected';
    if (entry.kind === 'compact') return 'rejected';
    const attachments = entry.attachments ?? [];
    if (entry.text.trim().length === 0 && attachments.length === 0) return 'rejected';
    promptStore().removeQueuedAt(sid, index);
    const outcome = await runSteerIntoTurn(sid, queuedPromptEnvelope(entry));
    if (outcome === 'rejected') {
      if (sessionsStore().sessions.some((s) => s.id === sid)) {
        promptStore().restoreQueueEntry(sid, entry, index);
      }
    }
    if (outcome !== 'ok') resumeQueueIfIdle(sid);
    return outcome;
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

  function enqueue(
    prompt: PromptEnvelope,
    editText?: string,
  ): void {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    promptStore().enqueueForSession(sid, prompt, editText);
  }

  function flushQueueHead(sid: string): void {
    if (promptStore().isSteerInFlight(sid)) return;
    if (promptStore().isCompactFlushHeld(sid)) return;
    const next = (promptStore().queuedBySession[sid] ?? [])[0];
    if (next === undefined) return;
    if (next.kind === 'compact') {
      flushCompactHead(sid, next);
      return;
    }
    const key = next.id ?? next.text;
    const exhausted = promptStore().queueFlushFailureFor(sid);
    if (exhausted?.key === key && exhausted.count >= MAX_QUEUE_FLUSH_FAILURES) return;
    promptStore().dropQueueHead(sid);
    void submitPromptInternal(sid, queuedPromptEnvelope(next)).then((outcome) => {
      if (outcome === 'ok') {
        promptStore().clearQueueFlushFailure(sid);
        return;
      }
      if (!sessionsStore().sessions.some((s) => s.id === sid)) {
        promptStore().clearQueueFlushFailure(sid);
        return;
      }
      const previous = promptStore().queueFlushFailureFor(sid);
      const count = previous !== undefined && previous.key === key ? previous.count + 1 : 1;
      promptStore().noteQueueFlushFailure(sid, key, count);
      promptStore().restoreQueueEntry(sid, next);
    });
  }

  function flushCompactHead(sid: string, item: QueuedPrompt): void {
    if (promptStore().isCompactFlushHeld(sid) || isCompacting?.(sid) === true) return;
    const autoCompactedAt = promptStore().autoCompactedAt(sid);
    if (item.enqueuedAt !== undefined && autoCompactedAt !== undefined && autoCompactedAt >= item.enqueuedAt) {
      promptStore().dropQueueHead(sid);
      warningsStore().pushWarning({
        severity: 'info',
        title: t('commands.compactQueue.skippedAuto'),
      });
      flushQueueHead(sid);
      return;
    }
    promptStore().dropQueueHead(sid);
    promptStore().holdCompactFlush(sid);
    void getKimiWebApi()
      .compactSession(sid, item.instruction)
      .then(
        () => undefined,
        (err) => {
          if (!promptStore().releaseCompactFlush(sid)) return;
          const retries = (item.compactRetries ?? 0) + 1;
          if (retries >= MAX_QUEUE_FLUSH_FAILURES) {
            modelSwitchConfirmStore().noteCompactionSettled(sid, 'request-failed');
            warningsStore().pushOperationFailure('compact', err, { sessionId: sid });
            flushQueueHead(sid);
            return;
          }
          promptStore().restoreQueueEntry(sid, { ...item, compactRetries: retries });
          setTimeout(() => resumeQueueIfIdle(sid), COMPACT_RETRY_DELAY_MS);
        },
      );
  }

  function resumeAfterCompaction(sid: string): void {
    promptStore().releaseCompactFlush(sid);
    resumeQueueIfIdle(sid);
  }

  function resumeAfterExhaustedHeadChanged(
    sid: string,
    previousHead: { id?: string; text: string } | undefined,
    nextHead: { id?: string; text: string } | undefined,
  ): void {
    if (previousHead === undefined) return;
    const previousKey = previousHead.id ?? previousHead.text;
    const nextKey = nextHead === undefined ? undefined : (nextHead.id ?? nextHead.text);
    if (previousKey === nextKey) return;
    const failures = promptStore().queueFlushFailureFor(sid);
    if (failures?.key !== previousKey || failures.count < MAX_QUEUE_FLUSH_FAILURES) return;
    promptStore().clearQueueFlushFailure(sid);
    resumeQueueIfIdle(sid);
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
        resumeQueueIfIdle(sid);
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

  function unqueue(index: number): void {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    const removed = promptStore().removeQueuedAt(sid, index);
    if (removed === null) return;
    resumeAfterExhaustedHeadChanged(sid, removed.previousHead, removed.nextHead);
  }

  function reorderQueue(from: number, to: number): void {
    const sid = sessionsStore().activeSessionId;
    if (!sid) return;
    const moved = promptStore().moveQueued(sid, from, to);
    if (moved === null) return;
    resumeAfterExhaustedHeadChanged(sid, moved.previousHead, moved.nextHead);
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
    runSteerIntoTurn,
    resumeQueueIfIdle,
    steerPrompt,
    steerPromptDirect,
    steerPromptNow,
    steerQueued,
    steerQueuedNow,
    uploadImage,
    enqueue,
    flushQueueHead,
    resumeAfterCompaction,
    resumeAfterExhaustedHeadChanged,
    abortCurrentPrompt,
    unqueue,
    reorderQueue,
  };
}

export type UsePromptPipeline = ReturnType<typeof usePromptPipeline>;
