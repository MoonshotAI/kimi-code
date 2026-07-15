// apps/kimi-web/src/composables/client/useSideChat.ts
// Side chat ("BTW") — a TUI-style forked agent rendered as a session tab.
// It is not a child session and never appears in the sidebar. Each session can
// have its own side chat; state is keyed by session id, while messages are
// keyed by agent id so they survive session switches.
//
// Cross-dependencies (failure reporting, optimistic-id generation, the event
// connection) are injected by the facade.

import { computed, ref, watch } from 'vue';
import { getKimiWebApi } from '../../api';
import type { AppMessage, KimiEventConnection } from '../../api/types';
import { messagesToTurns } from '../messagesToTurns';
import type { ChatTurn } from '../../types';
import type { ExtendedState } from '../useKimiWebClient';

export interface UseSideChatDeps {
  pushOperationFailure: (
    operation: string,
    err: unknown,
    opts?: { title?: string; message?: string; sessionId?: string },
  ) => void;
  nextOptimisticMsgId: () => string;
  connectEventsIfNeeded: () => void;
  getEventConn: () => KimiEventConnection | null;
}

export function useSideChat(rawState: ExtendedState, deps: UseSideChatDeps) {
  const { pushOperationFailure, nextOptimisticMsgId, connectEventsIfNeeded, getEventConn } = deps;

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

  // LRU eviction unsubscribes inactive sessions and releases their projector
  // state. Re-register an existing side chat when its parent becomes active so
  // the next snapshot/subscribe routes that agent back to the side panel.
  watch(
    () => rawState.activeSessionId,
    (sessionId) => {
      if (!sessionId) return;
      const target = sideChatTargetBySession.value[sessionId];
      if (target) getEventConn()?.markSideChannelAgent(target.agentId, sessionId);
    },
    { flush: 'sync' },
  );

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

  const sideChatTurns = computed<ChatTurn[]>(() => {
    const target = activeSideChatTarget.value;
    if (!target) return [];
    const messages = rawState.sideChatMessagesByAgent[target.agentId] ?? [];
    return messagesToTurns(
      messages,
      [],
      (fileId) => getKimiWebApi().getFileUrl(fileId),
      sideChatRunning.value,
    );
  });

  function updateSideChatMessages(agentId: string, update: (messages: AppMessage[]) => AppMessage[]): void {
    rawState.sideChatMessagesByAgent = {
      ...rawState.sideChatMessagesByAgent,
      [agentId]: update(rawState.sideChatMessagesByAgent[agentId] ?? []),
    };
  }

  function appendSideChatMessage(agentId: string, message: AppMessage): void {
    updateSideChatMessages(agentId, (messages) => [...messages, message]);
  }

  function removeLastSideChatUserMessage(agentId: string): void {
    updateSideChatMessages(agentId, (messages) => {
      const idx = [...messages].reverse().findIndex((message) => message.role === 'user');
      if (idx === -1) return messages;
      const removeIndex = messages.length - 1 - idx;
      return messages.filter((_, index) => index !== removeIndex);
    });
  }

  function stampLastSideChatUserPrompt(agentId: string, promptId: string): void {
    updateSideChatMessages(agentId, (messages) => {
      const next = [...messages];
      for (let i = next.length - 1; i >= 0; i -= 1) {
        const message = next[i]!;
        if (message.role !== 'user') continue;
        next[i] = { ...message, promptId: message.promptId ?? promptId };
        return next;
      }
      return messages;
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
  async function openSideChat(initialPrompt?: string): Promise<void> {
    const parent = rawState.activeSessionId;
    if (!parent) return;
    await openSideChatOn(parent, initialPrompt);
  }

  /** Low-level: open the side chat on an explicit parent session id.
   *  Used when the parent was just created from the empty composer so the call
   *  can target it directly instead of reading the active session (which could
   *  race with a concurrent session switch). */
  async function openSideChatOn(parent: string, initialPrompt?: string): Promise<void> {
    if (!sideChatTargetBySession.value[parent]) {
      let agentId: string;
      try {
        ({ agentId } = await getKimiWebApi().startBtw(parent));
      } catch (err) {
        pushOperationFailure('openSideChat', err, { sessionId: parent });
        return;
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
      getEventConn()?.markSideChannelAgent(agentId, parent);
    }
    if (initialPrompt && initialPrompt.trim()) {
      await sendSideChatPromptOn(parent, initialPrompt.trim());
    }
  }

  /** Low-level: send a prompt to the side-chat child of an explicit parent session.
   *  Always uses `parent` as the session id, carrying model / thinking /
   *  permissionMode / plan / swarm so the turn matches the UI regardless of
   *  parent /profile inheritance or race. */
  async function sendSideChatPromptOn(parent: string, text: string): Promise<void> {
    const target = sideChatTargetBySession.value[parent];
    const trimmed = text.trim();
    if (!target || !trimmed) return;
    const sid = parent;
    const agentId = target.agentId;
    rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: true };
    const userMsg: AppMessage = {
      id: nextOptimisticMsgId(),
      sessionId: sid,
      role: 'user',
      content: [{ type: 'text', text: trimmed }],
      createdAt: new Date().toISOString(),
      metadata: { 'kimiWeb.optimisticUserMessage': true },
    };
    appendSideChatMessage(agentId, userMsg);
    try {
      // Carry the parent's current thinking level, model, and permission so a
      // BTW first-turn reflects the same draft/runtime controls the UI shows —
      // the parent session profile mirrors them, but the prompt itself is the
      // only thing the daemon reads for this turn. Thinking goes verbatim
      // (same as normal prompts and the TUI).
      const promptSession = rawState.sessions.find((s) => s.id === sid);
      const model =
        (promptSession?.model && promptSession.model.length > 0
          ? promptSession.model
          : rawState.defaultModel) ?? undefined;
      const result = await getKimiWebApi().submitPrompt(sid, {
        content: [{ type: 'text', text: trimmed }],
        agentId,
        model,
        thinking: rawState.thinking,
        permissionMode: rawState.permission,
        planMode: rawState.planModeBySession[sid] ?? false,
        swarmMode: rawState.swarmModeBySession[sid] ?? false,
      });
      stampLastSideChatUserPrompt(agentId, result.promptId);
      rawState.sideChatUserMessageIdsBySession = {
        ...rawState.sideChatUserMessageIdsBySession,
        [sid]: [...(rawState.sideChatUserMessageIdsBySession[sid] ?? []), result.userMessageId],
      };
    } catch (err) {
      pushOperationFailure('sendSideChatPrompt', err, { sessionId: sid });
      removeLastSideChatUserMessage(agentId);
      rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: false };
    }
  }

  function closeSideChat(): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const target = sideChatTargetBySession.value[sid];
    if (target) getEventConn()?.clearSideChannelAgent(target.agentId, sid);
    const { [sid]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;
  }

  /** Send a plain prompt to the active session's side chat, carrying the
   *  controls (model, thinking, permissionMode, plan/swarm) the UI shows so a
   *  BTW first turn matches them even if the parent's /profile is still in
   *  flight. */
  async function sendSideChatPrompt(text: string): Promise<void> {
    const target = activeSideChatTarget.value;
    if (!target) return;
    await sendSideChatPromptOn(target.parentId, text);
  }

  // When a session is deleted, drop its side-chat target so it cannot leak into a
  // later session that happens to reuse the same id.
  function clearSideChatForSession(sessionId: string): void {
    const target = sideChatTargetBySession.value[sessionId];
    if (!target) return;
    getEventConn()?.clearSideChannelAgent(target.agentId, sessionId);
    const { [sessionId]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;
    const { [target.agentId]: _messages, ...messagesRest } = rawState.sideChatMessagesByAgent;
    void _messages;
    rawState.sideChatMessagesByAgent = messagesRest;
    const { [target.agentId]: _sending, ...sendingRest } = rawState.sideChatSendingByAgent;
    void _sending;
    rawState.sideChatSendingByAgent = sendingRest;
    const { [sessionId]: _userIds, ...userIdsRest } = rawState.sideChatUserMessageIdsBySession;
    void _userIds;
    rawState.sideChatUserMessageIdsBySession = userIdsRest;
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
    openSideChat,
    openSideChatOn,
    closeSideChat,
    sendSideChatPrompt,
    clearSideChatForSession,
  };
}

export type UseSideChat = ReturnType<typeof useSideChat>;
