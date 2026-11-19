import { computed, ref } from 'vue';
import type { AppMessage, AppMessageContent, KimiWebApi, ThinkingLevel } from '@moonshot-ai/app-core/api';
import {
  conversationTurnError,
  createConversationProjector,
  pendingPromptTurn,
  type ConversationProjector,
} from '@moonshot-ai/app-core/client';
import { findPromptMessage, type ConversationTurn } from '@moonshot-ai/app-core/conversation';
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
import { submitWithNetworkRetry } from './submitRetry';
import { modelsStore } from '../stores/models';
import type { PromptAttachment } from './types';
import { persistComposerDraftSnapshot } from '../lib/composerDraftLifecycle';
import { forgetInputHistory } from '../composables/useInputHistory';
import type { ConversationPool } from '../composables/useConversations';

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
  const closedSideChatAgentIds = new Map<string, string>();
  const pendingMessagesByAgent = ref<Record<string, AppMessage[]>>({});
  const submittingByAgent = ref<Record<string, number>>({});

  function sideAgentKey(sessionId: string, agentId: string): string {
    return `${sessionId}\0${agentId}`;
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
    return closedSideChatAgentIds.get(agentId) === sessionId;
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

  async function openSideChatOn(
    parent: string,
    initialPrompt?: string | PromptEnvelopeContent,
    opts?: { permissionMode?: PermissionMode },
  ): Promise<SideChatOpenResult> {
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

  function closeSideChat(agentId?: string): void {
    if (agentId !== undefined) {
      const parentId = sideChatParentOf(agentId);
      if (!parentId) return;
      evictSideChatAgent(parentId, agentId);
      closedSideChatAgentIds.set(agentId, parentId);
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
      closedSideChatAgentIds.set(target.agentId, sid);
    }
    const { [sid]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;
  }

  async function sendSideChatPrompt(text: string): Promise<boolean> {
    const target = activeSideChatTarget.value;
    if (!target) return false;
    return sendSideChatPromptOn(target.parentId, target.agentId, text);
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
    for (const [agentId, parentId] of closedSideChatAgentIds) {
      if (parentId !== sessionId) continue;
      closedSideChatAgentIds.delete(agentId);
    }
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
    sendSideChatPrompt,
    sendSideChatPromptOn,
    saveSideChatDraft,
    sideChatDraft,
    clearSideChatDraftIfUnchanged,
    clearSideChatForSession,
  };
}

export type UseSideChat = ReturnType<typeof useSideChat>;
