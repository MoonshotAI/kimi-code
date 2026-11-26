import { computed, ref } from 'vue';
import {
  isDaemonApiError,
  SERVER_AUTH_UNAUTHORIZED_CODE,
  SESSION_NOT_FOUND_CODE,
  type AppMessage,
  type AppMessageContent,
  type KimiWebApi,
  type ThinkingLevel,
} from '@moonshot-ai/app-core/api';
import {
  conversationTurnError,
  createConversationProjector,
  pendingPromptTurn,
  type ConversationProjector,
} from '@moonshot-ai/app-core/client';
import { findPromptMessage, type ConversationTurn } from '@moonshot-ai/app-core/conversation';
import { sessionWorktreeBlocksSend, sessionWorktreeHoldsPrompts } from '@moonshot-ai/app-core/lib';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import type { PermissionMode } from '@moonshot-ai/app-core/client/types';
import { permissionsStore } from '../stores/permissions';
import { agentStatesStore } from '../stores/agentStates';
import { buildPromptContent, buildPromptMetadata } from '../lib/browserReferenceSubmission';
import type { ExtendedState, PromptEnvelopeContent, SideChatTurnError } from './types';
import type { ChatGateVerdict } from '../lib/chatGate';
import { sideChatDrafts } from './sideChatDrafts';
import { createSendFailureNotifier, PromptFailedError } from './sendFailure';
import { newPromptId } from './promptId';
import { t } from './deps';
import { submitWithNetworkRetry } from './submitRetry';
import { modelsStore } from '../stores/models';
import type { PromptAttachment } from './types';
import { persistComposerDraftSnapshot } from '../lib/composerDraftLifecycle';
import { forgetInputHistory } from '../composables/useInputHistory';
import { defaultPanelStorage, destroyPanelBtwTab } from '../panel/panelPersistence';
import type { ConversationPool } from '../composables/useConversations';

const PENDING_SIDE_CHAT_CLOSES_STORAGE_KEY = 'kimi-web.side-chat.pending-closes.v1';

function loadPersistedPendingCloses(): Array<{ sessionId: string; agentId: string }> {
  try {
    const raw = defaultPanelStorage()?.getItem(PENDING_SIDE_CHAT_CLOSES_STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is { sessionId: string; agentId: string } =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as { sessionId?: unknown }).sessionId === 'string' &&
        typeof (item as { agentId?: unknown }).agentId === 'string',
    );
  } catch {
    return [];
  }
}

function persistPendingCloseDelta(
  upserts: readonly { sessionId: string; agentId: string }[],
  removedKeys: readonly string[],
): void {
  const storage = defaultPanelStorage();
  if (!storage) return;
  try {
    const merged = new Map<string, { sessionId: string; agentId: string }>();
    for (const item of loadPersistedPendingCloses()) {
      merged.set(`${item.sessionId}\0${item.agentId}`, item);
    }
    for (const key of removedKeys) merged.delete(key);
    for (const item of upserts) merged.set(`${item.sessionId}\0${item.agentId}`, item);
    const list = [...merged.values()];
    if (list.length === 0) storage.removeItem(PENDING_SIDE_CHAT_CLOSES_STORAGE_KEY);
    else storage.setItem(PENDING_SIDE_CHAT_CLOSES_STORAGE_KEY, JSON.stringify(list));
  } catch {
  }
}

export interface SideChatTarget {
  agentId: string;
  seq: number;
}

export interface SideChatOpenResult {
  target: SideChatTarget | null;
  sent: boolean;
}

export interface UseSideChatDeps {
  api: KimiWebApi;
  conversations: ConversationPool;
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  nextOptimisticMsgId: () => string;
  resolveThinkingForPrompt: (
    sessionId: string | null,
    modelId: string | undefined,
  ) => ThinkingLevel | undefined;
  mapSendAuthFailure?: (err: unknown, sid?: string) => Promise<ChatGateVerdict | null>;
  ensureSideChatReady?: (sid: string) => Promise<ChatGateVerdict | 'server-auth-required'>;
  onSideChatClosed?: (sessionId: string, agentId: string) => void;
}

export function useSideChat(rawState: ExtendedState, deps: UseSideChatDeps) {
  const {
    api,
    conversations,
    pushOperationFailure,
    nextOptimisticMsgId,
    resolveThinkingForPrompt,
    mapSendAuthFailure,
    ensureSideChatReady,
    onSideChatClosed,
  } = deps;

  const pushSendFailure = createSendFailureNotifier({ pushOperationFailure, mapSendAuthFailure });

  const sideChatTargetBySession = ref<Record<string, SideChatTarget[]>>({});
  const sideChatSeqBySession: Record<string, number> = {};
  const closedSideChatAgentIds = new Set<string>();
  const pendingCloseRequests = new Map<string, { sessionId: string; agentId: string }>();
  const inFlightCloseRequests = new Set<string>();
  const pendingMessagesByAgent = ref<Record<string, AppMessage[]>>({});
  const submittingByAgent = ref<Record<string, number>>({});

  function sideAgentKey(sessionId: string, agentId: string): string {
    return `${sessionId}\0${agentId}`;
  }

  for (const item of loadPersistedPendingCloses()) {
    const key = sideAgentKey(item.sessionId, item.agentId);
    pendingCloseRequests.set(key, item);
    closedSideChatAgentIds.add(key);
  }

  function addPendingClose(sessionId: string, agentId: string): void {
    const entry = { sessionId, agentId };
    pendingCloseRequests.set(sideAgentKey(sessionId, agentId), entry);
    persistPendingCloseDelta([entry], []);
  }

  function removePendingCloses(keys: readonly string[]): void {
    const removed: string[] = [];
    for (const key of keys) {
      if (pendingCloseRequests.delete(key)) removed.push(key);
    }
    if (removed.length > 0) persistPendingCloseDelta([], removed);
  }

  function sideChatTargetsOfSession(sessionId: string): SideChatTarget[] {
    return sideChatTargetBySession.value[sessionId] ?? [];
  }

  function hasSideChatTarget(sessionId: string, agentId: string): boolean {
    return sideChatTargetsOfSession(sessionId).some((target) => target.agentId === agentId);
  }

  function addSideChatTarget(sessionId: string, target: SideChatTarget): void {
    sideChatSeqBySession[sessionId] = Math.max(sideChatSeqBySession[sessionId] ?? 0, target.seq);
    sideChatTargetBySession.value = {
      ...sideChatTargetBySession.value,
      [sessionId]: [...sideChatTargetsOfSession(sessionId), target],
    };
    conversations.activate(sessionId, target.agentId);
  }

  function restoreSideChatTarget(sessionId: string, target: SideChatTarget): void {
    if (isClosedSideChatAgent(sessionId, target.agentId)) return;
    if (hasSideChatTarget(sessionId, target.agentId)) return;
    addSideChatTarget(sessionId, target);
  }

  function sideChatParentOf(agentId: string): string | undefined {
    const active = rawState.activeSessionId;
    if (active && hasSideChatTarget(active, agentId)) return active;
    for (const [sid, targets] of Object.entries(sideChatTargetBySession.value).reverse()) {
      if (targets.some((target) => target.agentId === agentId)) return sid;
    }
    return undefined;
  }

  function isClosedSideChatAgent(sessionId: string, agentId: string): boolean {
    return closedSideChatAgentIds.has(sideAgentKey(sessionId, agentId));
  }

  function turnsOf(agentId: string, parentId = sideChatParentOf(agentId)): readonly ConversationTurn[] | undefined {
    if (parentId === undefined) return undefined;
    const entry = conversations.getEntry(parentId, agentId);
    if (entry === undefined) return undefined;
    void entry.version.value;
    return entry.view.turns;
  }

  function unacknowledgedMessagesOf(agentId: string, parent = sideChatParentOf(agentId)): AppMessage[] {
    return parent === undefined ? [] : pendingMessagesByAgent.value[sideAgentKey(parent, agentId)] ?? [];
  }

  function pruneEchoedMessages(sessionId: string, agentId: string): void {
    const pending = pendingMessagesByAgent.value[sideAgentKey(sessionId, agentId)];
    const turns = conversations.getEntry(sessionId, agentId)?.view.turns;
    if (pending === undefined || pending.length === 0 || turns === undefined) return;
    const kept = pending.filter((message) => message.promptId === undefined || findPromptMessage(turns, message.promptId) === undefined);
    if (kept.length !== pending.length) setPendingMessages(sessionId, agentId, kept);
  }

  function setPendingMessages(sessionId: string, agentId: string, messages: AppMessage[]): void {
    if (!hasSideChatTarget(sessionId, agentId)) return;
    pendingMessagesByAgent.value = { ...pendingMessagesByAgent.value, [sideAgentKey(sessionId, agentId)]: messages };
  }

  function adjustSubmitting(sessionId: string, agentId: string, delta: number): void {
    const key = sideAgentKey(sessionId, agentId);
    const { [key]: current = 0, ...rest } = submittingByAgent.value;
    const next = current + delta;
    submittingByAgent.value = next > 0 ? { ...rest, [key]: next } : rest;
  }

  const activeSideChatTarget = computed<{ parentId: string; agentId: string } | null>(() => {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    const target = sideChatTargetsOfSession(sid).at(-1);
    return target ? { parentId: sid, agentId: target.agentId } : null;
  });

  const sideChatSessionId = computed<string | null>(
    () => activeSideChatTarget.value?.parentId ?? null,
  );
  const sideChatVisible = computed<boolean>(() => activeSideChatTarget.value !== null);

  function sideChatSendingOf(agentId: string): boolean {
    const parent = sideChatParentOf(agentId);
    return parent !== undefined && (submittingByAgent.value[sideAgentKey(parent, agentId)] ?? 0) > 0;
  }

  function sideChatRunningOf(agentId: string): boolean {
    const turns = turnsOf(agentId);
    if (sideChatSendingOf(agentId)) return true;
    if (unacknowledgedMessagesOf(agentId).length > 0) return true;
    const parent = sideChatParentOf(agentId);
    if (turns === undefined || parent === undefined) return false;
    return agentStatesStore().running(parent, agentId) || turns.at(-1)?.status === 'running';
  }

  function sideChatTurnErrorOf(agentId: string): SideChatTurnError | null {
    const turns = turnsOf(agentId);
    if (turns === undefined || sideChatRunningOf(agentId)) return null;
    return conversationTurnError(turns.at(-1)) ?? null;
  }

  const sideChatSending = computed<boolean>(() => {
    const target = activeSideChatTarget.value;
    return target ? sideChatSendingOf(target.agentId) : false;
  });

  const sideChatRunning = computed<boolean>(() => {
    const target = activeSideChatTarget.value;
    return target ? sideChatRunningOf(target.agentId) : false;
  });

  const getSideChatSessionMediaUrl = (sessionId: string, fileId: string): string => api.getSessionMediaUrl(sessionId, fileId);
  const getSideChatFileUrl = (fileId: string): string => api.getFileUrl(fileId);

  const projectors = new Map<string, ConversationProjector>();

  function sideChatTurnsOf(agentId: string): ChatTurn[] {
    const parentId = sideChatParentOf(agentId);
    const turns = turnsOf(agentId);
    if (parentId === undefined || turns === undefined) return [];
    let projector = projectors.get(agentId);
    if (projector === undefined) {
      projector = createConversationProjector();
      projectors.set(agentId, projector);
    }
    const options = { sessionId: parentId, getFileUrl: getSideChatFileUrl, getSessionMediaUrl: getSideChatSessionMediaUrl };
    const projected = projector(turns, options);
    const pending = unacknowledgedMessagesOf(agentId);
    if (pending.length === 0) return projected;
    const startNo = projected.filter((turn) => turn.role !== 'compaction').length + 1;
    return [...projected, ...pending.map((message, index) => pendingPromptTurn(message, startNo + index, options))];
  }

  const sideChatTurns = computed<ChatTurn[]>(() => {
    const target = activeSideChatTarget.value;
    return target ? sideChatTurnsOf(target.agentId) : [];
  });

  async function openSideChat(initialPrompt?: string): Promise<boolean> {
    const parent = rawState.activeSessionId;
    if (!parent) return false;
    const permissionMode = permissionsStore().forSession(parent);
    const existing = sideChatTargetsOfSession(parent).at(-1);
    if (existing) {
      if (initialPrompt && initialPrompt.trim()) {
        return sendSideChatPromptOn(parent, existing.agentId, initialPrompt, {
          permissionMode,
        });
      }
      return true;
    }
    const result = await openSideChatOn(parent, initialPrompt, { permissionMode });
    return result.target !== null && result.sent;
  }

  const sideChatClearGenerationBySession = new Map<string, number>();

  function clearGeneration(sessionId: string): number {
    return sideChatClearGenerationBySession.get(sessionId) ?? 0;
  }

  const sideChatDraftBySession = ref<Record<string, string>>({});

  function saveSideChatDraft(sessionId: string, text: string): void {
    if (text) {
      sideChatDraftBySession.value = { ...sideChatDraftBySession.value, [sessionId]: text };
      return;
    }
    if (sideChatDraftBySession.value[sessionId] === undefined) return;
    const { [sessionId]: _removed, ...rest } = sideChatDraftBySession.value;
    void _removed;
    sideChatDraftBySession.value = rest;
  }

  function sideChatDraft(sessionId: string): string {
    return sideChatDraftBySession.value[sessionId] ?? '';
  }

  function clearSideChatDraftIfUnchanged(sessionId: string, snapshot: string): void {
    if (sideChatDraftBySession.value[sessionId] !== snapshot) return;
    const { [sessionId]: _removed, ...rest } = sideChatDraftBySession.value;
    void _removed;
    sideChatDraftBySession.value = rest;
  }

  function refusedWhileWorktreeHeld(parent: string, operation: string): boolean {
    const session = rawState.sessions.find((candidate) => candidate.id === parent);
    if (!sessionWorktreeHoldsPrompts(session) && !sessionWorktreeBlocksSend(session)) return false;
    const message = t('sideChat.waitsForWorktree');
    pushOperationFailure(operation, new Error(message), { sessionId: parent, message });
    return true;
  }

  async function openSideChatOn(
    parent: string,
    initialPrompt?: string | PromptEnvelopeContent,
    opts?: { permissionMode?: PermissionMode },
  ): Promise<SideChatOpenResult> {
    if (refusedWhileWorktreeHeld(parent, 'openSideChat')) return { target: null, sent: false };
    if (initialPrompt !== undefined && typeof initialPrompt !== 'string') initialPrompt = structuredClone(initialPrompt);
    const firstSendOpts =
      opts !== undefined ? opts : { permissionMode: permissionsStore().forSession(parent) };
    const generation = clearGeneration(parent);
    let agentId: string;
    try {
      ({ agentId } = await api.startBtw(parent));
    } catch (err) {
      pushOperationFailure('openSideChat', err, { sessionId: parent });
      return { target: null, sent: false };
    }
    if (clearGeneration(parent) !== generation) return { target: null, sent: false };
    const target: SideChatTarget = { agentId, seq: (sideChatSeqBySession[parent] ?? 0) + 1 };
    addSideChatTarget(parent, target);
    if (initialPrompt && (typeof initialPrompt === 'string' ? initialPrompt.trim() : initialPrompt.text.trim() || initialPrompt.attachments?.length)) {
      const sent = await sendSideChatPromptOn(parent, agentId, initialPrompt, firstSendOpts);
      if (clearGeneration(parent) !== generation || !hasSideChatTarget(parent, agentId)) {
        return { target: null, sent };
      }
      return { target, sent };
    }
    return { target, sent: true };
  }

  async function sendSideChatPromptOn(
    parent: string,
    agentId: string,
    input: string | PromptEnvelopeContent,
    opts?: { permissionMode?: PermissionMode; attachments?: PromptAttachment[] },
  ): Promise<boolean> {
    const source = typeof input === 'string' ? { text: input } : structuredClone(input);
    const prompt = { ...source, text: source.text.trim(), attachments: source.attachments ?? opts?.attachments ?? [] };
    if (!prompt.text && prompt.attachments.length === 0) return false;
    if (refusedWhileWorktreeHeld(parent, 'sendSideChatPrompt')) return false;
    let content: AppMessageContent[];
    let metadata: Record<string, unknown> | undefined;
    try {
      content = buildPromptContent(prompt);
      metadata = buildPromptMetadata(prompt);
    } catch (error) {
      pushSendFailure('sendSideChatPrompt', error, parent);
      return false;
    }
    const sid = parent;
    if (ensureSideChatReady !== undefined) {
      const verdict = await ensureSideChatReady(sid);
      if (verdict !== 'ok') return false;
    }
    const permissionMode = opts?.permissionMode ?? permissionsStore().forSession(parent);
    const tempId = nextOptimisticMsgId();
    const promptId = newPromptId();
    setPendingMessages(sid, agentId, [
      ...unacknowledgedMessagesOf(agentId, sid),
      {
        id: tempId,
        sessionId: sid,
        role: 'user',
        content,
        createdAt: new Date().toISOString(),
        promptId,
        metadata: { 'kimiWeb.optimisticUserMessage': true, ...(prompt.snapshot === undefined ? {} : { 'kimiWeb.composerSnapshot': prompt.snapshot }) },
      },
    ]);
    adjustSubmitting(sid, agentId, 1);
    try {
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model = modelsStore().resolveSendModel(promptSession?.model) ?? undefined;
      const thinking = resolveThinkingForPrompt(sid, model);
      const result = await submitWithNetworkRetry(() => api.submitPrompt(sid, {
        promptId,
        content,
        ...(metadata === undefined ? {} : { metadata }),
        agentId,
        model,
        thinking,
        permissionMode,
        planMode: rawState.planModeBySession[sid] ?? false,
        swarmMode: rawState.swarmModeBySession[sid] ?? false,
      }));
      if (result.status === 'failed') throw new PromptFailedError(promptId);
      return true;
    } catch (err) {
      pushSendFailure('sendSideChatPrompt', err, sid);
      setPendingMessages(
        sid,
        agentId,
        (pendingMessagesByAgent.value[sideAgentKey(sid, agentId)] ?? []).filter((message) => message.id !== tempId),
      );
      return false;
    } finally {
      adjustSubmitting(sid, agentId, -1);
    }
  }

  function evictSideChatAgent(sessionId: string, agentId: string): void {
    conversations.release(sessionId, agentId);
    projectors.delete(agentId);
    onSideChatClosed?.(sessionId, agentId);
    sideChatDrafts.delete(agentId);
    persistComposerDraftSnapshot(`sidechat:${agentId}`, '', []);
    forgetInputHistory(`sidechat:${agentId}`);
    const { [sideAgentKey(sessionId, agentId)]: _pending, ...restPending } = pendingMessagesByAgent.value;
    void _pending;
    pendingMessagesByAgent.value = restPending;
  }

  const closeRetryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const closeRetryCounts = new Map<string, number>();

  function clearCloseRetry(key: string): void {
    const timer = closeRetryTimers.get(key);
    if (timer !== undefined) {
      clearTimeout(timer);
      closeRetryTimers.delete(key);
    }
    closeRetryCounts.delete(key);
  }

  function requestDaemonClose(
    sessionId: string,
    agentId: string,
    operation: 'closeSideChat' | 'closeSideChats',
    silent = false,
  ): void {
    const key = sideAgentKey(sessionId, agentId);
    addPendingClose(sessionId, agentId);
    if (inFlightCloseRequests.has(key)) return;
    const existingTimer = closeRetryTimers.get(key);
    if (existingTimer !== undefined) {
      clearTimeout(existingTimer);
      closeRetryTimers.delete(key);
    }
    inFlightCloseRequests.add(key);
    void submitWithNetworkRetry(() => api.closeAgent(sessionId, agentId))
      .then(() => {
        clearCloseRetry(key);
        removePendingCloses([key]);
      })
      .catch((err: unknown) => {
        if (!pendingCloseRequests.has(key)) {
          clearCloseRetry(key);
          return;
        }
        if (
          isDaemonApiError(err) &&
          (err.code === SESSION_NOT_FOUND_CODE || err.code === 40939)
        ) {
          clearCloseRetry(key);
          removePendingCloses([key]);
          return;
        }
        const isServerErrorCode =
          isDaemonApiError(err) &&
          err.code !== undefined &&
          (err.code >= 50000 || (err.code >= 500 && err.code < 600));
        if (
          isDaemonApiError(err) &&
          err.code !== undefined &&
          !isServerErrorCode &&
          err.code !== 401 &&
          err.code !== 429 &&
          err.code !== SERVER_AUTH_UNAUTHORIZED_CODE
        ) {
          clearCloseRetry(key);
          removePendingCloses([key]);
          if (!silent) {
            pushOperationFailure(operation, err, { sessionId });
          }
          return;
        }
        if (!silent) {
          pushOperationFailure(operation, err, { sessionId });
        }
        if (pendingCloseRequests.has(key)) {
          const attempt = (closeRetryCounts.get(key) ?? 0) + 1;
          closeRetryCounts.set(key, attempt);
          const delayMs = Math.min(30_000, 1_000 * 2 ** Math.min(attempt - 1, 5));
          const timer = setTimeout(() => {
            closeRetryTimers.delete(key);
            if (pendingCloseRequests.has(key)) {
              requestDaemonClose(sessionId, agentId, operation, true);
            }
          }, delayMs);
          closeRetryTimers.set(key, timer);
        }
      })
      .finally(() => {
        inFlightCloseRequests.delete(key);
      });
  }

  function flushPendingCloses(): void {
    for (const item of loadPersistedPendingCloses()) {
      const key = sideAgentKey(item.sessionId, item.agentId);
      pendingCloseRequests.set(key, item);
      closedSideChatAgentIds.add(key);
    }
    for (const { sessionId, agentId } of pendingCloseRequests.values()) {
      requestDaemonClose(sessionId, agentId, 'closeSideChat', true);
    }
  }

  function closeSideChat(agentId?: string, sessionId?: string): void {
    if (agentId !== undefined) {
      const parentId =
        sessionId !== undefined
          ? hasSideChatTarget(sessionId, agentId)
            ? sessionId
            : undefined
          : sideChatParentOf(agentId);
      if (!parentId) return;
      evictSideChatAgent(parentId, agentId);
      closedSideChatAgentIds.add(sideAgentKey(parentId, agentId));
      requestDaemonClose(parentId, agentId, 'closeSideChat');
      sideChatTargetBySession.value = {
        ...sideChatTargetBySession.value,
        [parentId]: sideChatTargetsOfSession(parentId).filter(
          (target) => target.agentId !== agentId,
        ),
      };
      return;
    }
    const sid = rawState.activeSessionId;
    if (!sid) return;
    for (const target of sideChatTargetsOfSession(sid)) {
      evictSideChatAgent(sid, target.agentId);
      closedSideChatAgentIds.add(sideAgentKey(sid, target.agentId));
      requestDaemonClose(sid, target.agentId, 'closeSideChats');
    }
    const { [sid]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;
  }

  function handleAgentEnded(sessionId: string, agentId: string): void {
    const key = sideAgentKey(sessionId, agentId);
    clearCloseRetry(key);
    removePendingCloses([key]);
    const activeTarget = hasSideChatTarget(sessionId, agentId);
    if (activeTarget) {
      closedSideChatAgentIds.add(key);
      evictSideChatAgent(sessionId, agentId);
      sideChatTargetBySession.value = {
        ...sideChatTargetBySession.value,
        [sessionId]: sideChatTargetsOfSession(sessionId).filter(
          (target) => target.agentId !== agentId,
        ),
      };
      destroyPanelBtwTab(sessionId, agentId);
      return;
    }
    if (!destroyPanelBtwTab(sessionId, agentId)) return;
    closedSideChatAgentIds.add(key);
    onSideChatClosed?.(sessionId, agentId);
  }

  async function sendSideChatPrompt(text: string): Promise<boolean> {
    const target = activeSideChatTarget.value;
    if (!target) return false;
    return sendSideChatPromptOn(target.parentId, target.agentId, text);
  }

  async function cancelSideChatOn(parent: string, agentId: string): Promise<boolean> {
    if (!parent || !agentId) return false;
    if (!sideChatRunningOf(agentId) && !sideChatSendingOf(agentId)) return false;
    try {
      const result = await api.cancelSession(parent, { agentId });
      return result.cancelled;
    } catch (err) {
      pushOperationFailure('cancelSideChat', err, { sessionId: parent });
      return false;
    }
  }

  async function cancelSideChat(): Promise<boolean> {
    const target = activeSideChatTarget.value;
    if (!target) return false;
    return cancelSideChatOn(target.parentId, target.agentId);
  }

  function clearSideChatForSession(sessionId: string): void {
    sideChatClearGenerationBySession.set(sessionId, clearGeneration(sessionId) + 1);
    delete sideChatSeqBySession[sessionId];
    if (sideChatDraftBySession.value[sessionId] !== undefined) {
      const { [sessionId]: _draft, ...restDrafts } = sideChatDraftBySession.value;
      void _draft;
      sideChatDraftBySession.value = restDrafts;
    }

    for (const target of sideChatTargetsOfSession(sessionId)) {
      evictSideChatAgent(sessionId, target.agentId);
    }
    const prefix = `${sessionId}\0`;
    for (const key of closedSideChatAgentIds) {
      if (key.startsWith(prefix)) closedSideChatAgentIds.delete(key);
    }
    const removedKeys: string[] = [];
    for (const [key, entry] of pendingCloseRequests) {
      if (entry.sessionId === sessionId) {
        clearCloseRetry(key);
        removedKeys.push(key);
      }
    }
    removePendingCloses(removedKeys);
    const { [sessionId]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;
  }

  return {
    sideChatTargetBySession,
    sideChatTargetsOfSession,
    restoreSideChatTarget,
    pruneEchoedMessages,
    isClosedSideChatAgent,
    sideChatSessionId,
    sideChatVisible,
    sideChatSending,
    sideChatRunning,
    sideChatTurns,
    sideChatSendingOf,
    sideChatRunningOf,
    sideChatTurnsOf,
    sideChatTurnErrorOf,
    openSideChat,
    openSideChatOn,
    closeSideChat,
    flushPendingCloses,
    handleAgentEnded,
    sendSideChatPrompt,
    sendSideChatPromptOn,
    cancelSideChat,
    cancelSideChatOn,
    saveSideChatDraft,
    sideChatDraft,
    clearSideChatDraftIfUnchanged,
    clearSideChatForSession,
  };
}

export type UseSideChat = ReturnType<typeof useSideChat>;
