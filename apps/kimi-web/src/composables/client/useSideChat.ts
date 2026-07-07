// apps/kimi-web/src/composables/client/useSideChat.ts
// Side chat ("BTW") — a TUI-style forked agent rendered as a session tab.
// It is not a child session and never appears in the sidebar. Each session can
// have its own side chat; state is keyed by session id, while messages are
// keyed by agent id so they survive session switches.
//
// Cross-dependencies (failure reporting, optimistic-id generation, the event
// connection) are injected by the facade.

import { computed, ref } from 'vue';
import { getKimiWebApi } from '../../api';
import type { AppMessage } from '../../api/types';
import type { KimiEventConnection } from '../../api/types';
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
    // Reuse the existing side chat for this session if it already exists.
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
      getEventConn()?.markSideChannelAgent(agentId);
    }
    if (initialPrompt && initialPrompt.trim()) {
      await sendSideChatPrompt(initialPrompt.trim());
    }
  }

  function closeSideChat(): void {
    const sid = rawState.activeSessionId;
    if (!sid) return;
    const { [sid]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;
  }

  /** Send a plain prompt to the side-chat child (no plan/swarm/goal modes). */
  async function sendSideChatPrompt(text: string): Promise<void> {
    const target = activeSideChatTarget.value;
    const trimmed = text.trim();
    if (!target || !trimmed) return;
    const sid = target.parentId;
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
      const result = await getKimiWebApi().submitPrompt(sid, {
        content: [{ type: 'text', text: trimmed }],
        agentId,
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

  // When a session is deleted, drop its side-chat target so it cannot leak into a
  // later session that happens to reuse the same id.
  function clearSideChatForSession(sessionId: string): void {
    if (!sideChatTargetBySession.value[sessionId]) return;
    const { [sessionId]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;
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
    closeSideChat,
    sendSideChatPrompt,
    clearSideChatForSession,
  };
}

export type UseSideChat = ReturnType<typeof useSideChat>;
