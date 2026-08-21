// packages/app-client/src/client/useSideChat.ts
// Side chat ("BTW") — a TUI-style forked agent rendered as a session tab.
// It is not a child session and never appears in the sidebar. Each session can
// have its own side chat; state is keyed by session id, while messages are
// keyed by agent id so they survive session switches.
//
// Cross-dependencies (failure reporting, optimistic-id generation, the event
// connection) are injected by the facade.

import { computed, ref } from 'vue';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import type { AppApprovalRequest, AppMessage, KimiEventConnection, KimiWebApi, ThinkingLevel } from '@moonshot-ai/app-core/api';
import { createTurnsProjector } from '@moonshot-ai/app-core/client';
import { ackThinkingPending } from '@moonshot-ai/app-core/lib';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import type { ExtendedState } from './types';

export interface UseSideChatDeps {
  api: KimiWebApi;
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  nextOptimisticMsgId: () => string;
  connectEventsIfNeeded: () => void;
  getEventConn: () => KimiEventConnection | null;
  /** Resolve the thinking level for a prompt submission: waits for the
   *  session's own /status fold when it has not landed yet, then resolves the
   *  session + model level; undefined when the model is not in the catalog. */
  resolveThinkingForPrompt: (
    sessionId: string | null,
    modelId: string | undefined,
  ) => Promise<ThinkingLevel | undefined>;
  /** Re-read /status so a released thinking pick re-folds the daemon's level. */
  refreshSessionStatus: (sessionId: string) => Promise<void>;
}

export function useSideChat(rawState: ExtendedState, deps: UseSideChatDeps) {
  const {
    api,
    pushOperationFailure,
    nextOptimisticMsgId,
    connectEventsIfNeeded,
    getEventConn,
    resolveThinkingForPrompt,
    refreshSessionStatus,
  } = deps;

  const sideChatTargetBySession = ref<Record<string, { agentId: string }>>({});

  const activeSideChatTarget = computed<{ parentId: string; agentId: string } | null>(() => {
    const sid = rawState.activeSessionId;
    if (!sid) return null;
    const target = sideChatTargetBySession.value[sid];
    return target ? { parentId: sid, agentId: target.agentId } : null;
  });

  const sideChatSessionId = computed<string | null>(
    () => activeSideChatTarget.value?.parentId ?? null,
  );
  const sideChatVisible = computed<boolean>(() => activeSideChatTarget.value !== null);

  const sideChatSending = computed<boolean>(() => {
    const target = activeSideChatTarget.value;
    return target ? Boolean(rawState.sideChatSendingByAgent[target.agentId]) : false;
  });

  const sideChatRunning = computed<boolean>(() => {
    const target = activeSideChatTarget.value;
    if (!target) return false;
    if (rawState.sideChatSendingByAgent[target.agentId]) return true;
    return (rawState.tasksBySession[target.parentId] ?? []).some(
      (task) => task.id === target.agentId && task.status === 'running',
    );
  });

  // Same incremental projection as the main transcript (see turnsProjector.ts):
  // a streaming side chat rebuilds only its live tail. The projector is
  // stateful, so a plain computed keeps the old synchronous pull semantics.
  // The approvals list and getFileUrl are hoisted to stable refs so the
  // projector's reuse gate holds.
  const getSideChatFileUrl = (fileId: string): string => api.getFileUrl(fileId);
  const SIDE_CHAT_NO_APPROVALS: AppApprovalRequest[] = [];
  const sideChatTurnsProjector = createTurnsProjector();
  const sideChatTurns = computed<ChatTurn[]>(() => {
    const target = activeSideChatTarget.value;
    if (!target) return [];
    return sideChatTurnsProjector({
      messages: rawState.sideChatMessagesByAgent[target.agentId] ?? [],
      approvals: SIDE_CHAT_NO_APPROVALS,
      getFileUrl: getSideChatFileUrl,
      sessionActive: sideChatRunning.value,
    });
  });

  function updateSideChatMessages(agentId: string, update: (messages: AppMessage[]) => AppMessage[]): void {
    rawState.sideChatMessagesByAgent[agentId] = update(rawState.sideChatMessagesByAgent[agentId] ?? []);
  }

  function appendSideChatMessage(agentId: string, message: AppMessage): void {
    updateSideChatMessages(agentId, (messages) => [...messages, message]);
  }

  function removeSideChatUserMessage(agentId: string, messageId: string): void {
    updateSideChatMessages(agentId, (messages) => {
      const message = messages.find((candidate) => candidate.id === messageId);
      if (
        message?.promptId !== undefined ||
        message?.userMessageId !== undefined
      ) return messages;
      return messages.filter((candidate) => candidate.id !== messageId);
    });
  }

  function rememberSideChatUserMessageId(sessionId: string, userMessageId: string): void {
    const current = rawState.sideChatUserMessageIdsBySession[sessionId] ?? [];
    if (current.includes(userMessageId)) return;
    rawState.sideChatUserMessageIdsBySession = {
      ...rawState.sideChatUserMessageIdsBySession,
      [sessionId]: [...current, userMessageId],
    };
  }

  function confirmSideChatUserMessage(
    agentId: string,
    messageId: string,
    promptId: string,
    userMessageId: string,
  ): void {
    updateSideChatMessages(agentId, (messages) => {
      const optimisticIndex = messages.findIndex((message) => message.id === messageId);
      if (optimisticIndex === -1) return messages;
      const echoIndex = messages.findIndex(
        (message, index) =>
          index !== optimisticIndex &&
          message.role === 'user' &&
          (message.id === userMessageId ||
            message.userMessageId === userMessageId ||
            message.promptId === promptId),
      );
      const optimistic = messages[optimisticIndex]!;
      const confirmed = echoIndex === -1 ? optimistic : messages[echoIndex]!;
      return messages.flatMap((message, index) => {
        if (index === echoIndex) return [];
        if (index !== optimisticIndex) return [message];
        return [{
          ...confirmed,
          id: optimistic.id,
          promptId,
          userMessageId,
          metadata: { ...confirmed.metadata, ...optimistic.metadata },
        }];
      });
    });
  }

  function reconcileSideChatUserMessage(agentId: string, message: AppMessage): void {
    rememberSideChatUserMessageId(message.sessionId, message.userMessageId ?? message.id);
    updateSideChatMessages(agentId, (messages) => {
      const index = messages.findIndex(
        (candidate) =>
          candidate.role === 'user' &&
          (candidate.userMessageId === (message.userMessageId ?? message.id) ||
            (candidate.promptId !== undefined && candidate.promptId === message.promptId)),
      );
      if (index === -1) return [...messages, message];
      const optimistic = messages[index]!;
      const next = [...messages];
      next[index] = {
        ...message,
        id: optimistic.id,
        promptId: message.promptId ?? optimistic.promptId,
        userMessageId: message.userMessageId ?? message.id,
        metadata: { ...message.metadata, ...optimistic.metadata },
      };
      return next;
    });
  }

  function appendSideChatAssistantText(agentId: string, sessionId: string, chunk: string): void {
    if (!chunk) return;
    updateSideChatMessages(agentId, (messages) => {
      const last = messages.at(-1);
      if (last?.role === 'assistant') {
        const first = last.content[0];
        const text = first?.type === 'text' ? first.text : '';
        return [
          ...messages.slice(0, -1),
          {
            ...last,
            content: [{ type: 'text', text: `${text}${chunk}` }],
          },
        ];
      }
      return [
        ...messages,
        {
          id: nextOptimisticMsgId(),
          sessionId,
          role: 'assistant',
          content: [{ type: 'text', text: chunk }],
          createdAt: new Date().toISOString(),
        },
      ];
    });
  }

  function finishSideChatAgent(agentId: string, sessionId: string, outputPreview?: string): void {
    rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: false };
    if (!outputPreview) return;
    const messages = rawState.sideChatMessagesByAgent[agentId] ?? [];
    const last = messages.at(-1);
    const lastText = last?.role === 'assistant' && last.content[0]?.type === 'text'
      ? last.content[0].text
      : '';
    if (lastText.trim().length > 0) return;
    appendSideChatAssistantText(agentId, sessionId, outputPreview);
  }

  /** Open (creating if needed) the side chat for the active session; optionally send a first prompt. */
  async function openSideChat(initialPrompt?: string): Promise<boolean> {
    const parent = rawState.activeSessionId;
    if (!parent) return false;
    return openSideChatOn(parent, initialPrompt);
  }

  /** Low-level: open the side chat on an explicit parent session id.
   *  Used when the parent was just created from the empty composer so the call
   *  can target it directly instead of reading the active session (which could
   *  race with a concurrent session switch). */
  /** Resolves false when the initial prompt provably never left, so the
   *  caller can restore the text (the composer consumed the /btw command). */
  async function openSideChatOn(parent: string, initialPrompt?: string): Promise<boolean> {
    if (!sideChatTargetBySession.value[parent]) {
      let agentId: string;
      try {
        ({ agentId } = await api.startBtw(parent));
      } catch (err) {
        pushOperationFailure('openSideChat', err, { sessionId: parent });
        return false;
      }
      rawState.sideChatMessagesByAgent = {
        ...rawState.sideChatMessagesByAgent,
        [agentId]: rawState.sideChatMessagesByAgent[agentId] ?? [],
      };
      sideChatTargetBySession.value = {
        ...sideChatTargetBySession.value,
        [parent]: { agentId },
      };
      connectEventsIfNeeded();
      getEventConn()?.markSideChannelAgent(parent, agentId);
    }
    if (initialPrompt && initialPrompt.trim()) {
      return sendSideChatPromptOn(parent, initialPrompt.trim());
    }
    return true;
  }

  /** Low-level: send a prompt to the side-chat child of an explicit parent session.
   *  Always uses `parent` as the session id, carrying model / thinking /
   *  permissionMode so the turn matches the UI regardless of parent /profile
   *  inheritance or race. BTW never touches the work-mode chain: it sends
   *  plain, and the daemon applies whatever the session profile holds. */
  /** Resolves true once the prompt was accepted by the daemon; false when
   *  it provably never left (a failure before the submit POST) — the panel
   *  restores the user's draft on false. */
  async function sendSideChatPromptOn(parent: string, text: string): Promise<boolean> {
    const target = sideChatTargetBySession.value[parent];
    const trimmed = text.trim();
    if (!target || !trimmed) return false;
    const sid = parent;
    const agentId = target.agentId;
    rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: true };
    const tempId = nextOptimisticMsgId();
    const userMsg: AppMessage = {
      id: tempId,
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      createdAt: new Date().toISOString(),
      metadata: { 'kimiWeb.optimisticUserMessage': true },
    };
    appendSideChatMessage(agentId, userMsg);
    // Set right before the submit POST; shared by the success ack and the catch.
    let thinkingToken: number | undefined;
    // Set only at the submit POST itself: a failure thrown earlier provably
    // never reached the daemon, so the catch can hand the draft back; a
    // submit-stage failure is ambiguous (the response may have been lost) and
    // must NOT — a retried draft would duplicate the question.
    let submitAttempted = false;
    try {
      // Carry the parent's current model, thinking, and permission so a BTW
      // first-turn reflects the same draft/runtime controls the UI shows — the
      // parent session profile mirrors them, but the prompt itself is the only
      // thing the daemon reads for this turn. Thinking is resolved against the
      // PARENT session + its model (the session's own level when declared,
      // else its stored pick, else its default) — never the active-session
      // rawState.thinking: startBtw above may have spanned a session switch
      // that changed what the active view resolved to (see
      // submitPromptInternal in useWorkspaceState).
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model =
        (promptSession?.model && promptSession.model.length > 0
          ? promptSession.model
          : rawState.defaultModel) ?? undefined;
      const thinking = (await resolveThinkingForPrompt(sid, model)) ?? rawState.thinking;
      thinkingToken = rawState.pendingThinkingBySession[sid];
      submitAttempted = true;
      const result = await api.submitPrompt(sid, {
        content: [{ type: 'text', text: trimmed }],
        agentId,
        model,
        thinking,
        permissionMode: rawState.permission,
        planMode: rawState.planModeBySession[sid] ?? false,
        swarmMode: rawState.swarmModeBySession[sid] ?? false,
      });
      // Same ack as a main-thread send: the daemon consumed the thinking.
      if (thinking !== undefined) ackThinkingPending(rawState, sid, thinkingToken);
      // The session may have died (archive/delete) while the submit was in
      // flight: clearSideChatForSession already dropped its buckets, and
      // writing back here would resurrect them for a dead session. Gate on
      // the target still binding this session to this agent.
      if (sideChatTargetBySession.value[sid]?.agentId === agentId) {
        confirmSideChatUserMessage(
          agentId,
          tempId,
          result.promptId,
          result.userMessageId,
        );
        rememberSideChatUserMessageId(sid, result.userMessageId);
      }
      return true;
    } catch (err) {
      // A failed submit may never have reached the daemon: stop shielding the
      // pick this prompt carried and re-fold the daemon's actual level.
      if (ackThinkingPending(rawState, sid, thinkingToken)) void refreshSessionStatus(sid);
      pushOperationFailure('sendSideChatPrompt', err, { sessionId: sid });
      // Same dead-session guard as the success path: do not resurrect buckets
      // clearSideChatForSession dropped while the submit was in flight.
      if (sideChatTargetBySession.value[sid]?.agentId === agentId) {
        removeSideChatUserMessage(agentId, tempId);
        rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: false };
      }
      // Only a provably-unsent failure — or a definitive daemon refusal,
      // which provably accepted nothing — lets the panel restore the draft.
      return !submitAttempted || err instanceof DaemonApiError ? false : true;
    }
  }

  function closeSideChat(): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const { [sid]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;
  }

  /** Send a plain prompt to the active session's side chat, carrying the
   *  controls (model, thinking, permissionMode) the UI shows so a BTW first
   *  turn matches them even if the parent's /profile is still in flight. */
  async function sendSideChatPrompt(text: string): Promise<boolean> {
    const target = activeSideChatTarget.value;
    if (!target) return false;
    return sendSideChatPromptOn(target.parentId, text);
  }

  // When a session is deleted, drop its side-chat target so it cannot leak into a
  // later session that happens to reuse the same id. The target is the ONLY
  // reference to the side-chat agent, so its per-agent buckets go too —
  // otherwise sideChatMessagesByAgent / sideChatSendingByAgent grow
  // monotonically for the app's lifetime (one dead entry per archived/deleted
  // session that ever opened a BTW).
  function clearSideChatForSession(sessionId: string): void {
    // Session-keyed, so always cleanable — even when the target is already
    // gone (the user closed the BTW tab before the session died). The
    // agent-keyed buckets below can only be resolved while a target exists.
    if (rawState.sideChatUserMessageIdsBySession[sessionId] !== undefined) {
      const { [sessionId]: _ids, ...restIds } = rawState.sideChatUserMessageIdsBySession;
      void _ids;
      rawState.sideChatUserMessageIdsBySession = restIds;
    }

    const target = sideChatTargetBySession.value[sessionId];
    if (!target) return;
    const { [sessionId]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;

    const agentId = target.agentId;
    if (Object.prototype.hasOwnProperty.call(rawState.sideChatMessagesByAgent, agentId)) {
      const { [agentId]: _messages, ...restMessages } = rawState.sideChatMessagesByAgent;
      void _messages;
      rawState.sideChatMessagesByAgent = restMessages;
    }
    if (Object.prototype.hasOwnProperty.call(rawState.sideChatSendingByAgent, agentId)) {
      const { [agentId]: _sending, ...restSending } = rawState.sideChatSendingByAgent;
      void _sending;
      rawState.sideChatSendingByAgent = restSending;
    }
  }

  return {
    sideChatTargetBySession,
    sideChatSessionId,
    sideChatVisible,
    sideChatSending,
    sideChatRunning,
    sideChatTurns,
    appendSideChatAssistantText,
    finishSideChatAgent,
    reconcileSideChatUserMessage,
    openSideChat,
    openSideChatOn,
    closeSideChat,
    sendSideChatPrompt,
    clearSideChatForSession,
  };
}

export type UseSideChat = ReturnType<typeof useSideChat>;
