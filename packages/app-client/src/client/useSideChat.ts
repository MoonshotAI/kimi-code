// packages/app-client/src/client/useSideChat.ts
// Side chat ("BTW") — a TUI-style forked agent rendered as a session tab.
// It is not a child session and never appears in the sidebar. Each session can
// have its own side chat; state is keyed by session id, while messages are
// keyed by agent id so they survive session switches.
//
// Cross-dependencies (failure reporting, optimistic-id generation, the event
// connection) are injected by the facade.

import { computed, ref, shallowReactive } from 'vue';
import { DaemonApiError } from '@moonshot-ai/app-core/api';
import type { AppApprovalRequest, AppMessage, AppMessageContent, KimiEventConnection, KimiWebApi, ThinkingLevel } from '@moonshot-ai/app-core/api';
import { createTurnsProjector, turnToMessages } from '@moonshot-ai/app-core/client';
import { ackThinkingPending } from '@moonshot-ai/app-core/lib';
import type { ChatTurn } from '@moonshot-ai/app-core/client/types';
import { joinDraftSegments } from '../lib/quoteSelection';
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
  refreshSessionStatus: (sessionId: string) => Promise<boolean>;
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
  // Every agent EVER started as a side chat (BTW), kept until it terminates:
  // closing the panel drops the visible target but the agent's task rows must
  // stay out of the dock — otherwise a closed-but-running BTW resurfaces as a
  // regular subagent with a wrong cancel entry. REACTIVE: a BTW task frame can
  // land before startBtw() answers, and the dock filter must re-run on add.
  const knownSideChatAgentIds = shallowReactive(new Set<string>());
  // session → agent attribution, kept past panel close (closeSideChat drops
  // only the target): a session that dies with its panel closed must still
  // resolve its agent for teardown, or every agent-keyed bucket leaks. ALL
  // agents the session ever started are tracked (a Set): reopening the panel
  // starts a NEW agent over the old mapping, and the overwritten one would
  // otherwise leak in knownSideChatAgentIds — its late terminal event would
  // pass wasSideChatAgent and recreate buckets no mapping can clean anymore.
  const sideChatAgentIdsBySession = new Map<string, Set<string>>();
  // Agents whose turn already ended but whose terminal taskCompleted output
  // may still be routed: the hide-mark must outlive turn.ended, or a gap
  // window that delivers ONLY the task summary loses the final answer.
  const terminatedSideChatAgentIds = new Set<string>();

  function isSideChatAgent(agentId: string | undefined): boolean {
    return (
      agentId !== undefined &&
      knownSideChatAgentIds.has(agentId) &&
      !terminatedSideChatAgentIds.has(agentId)
    );
  }

  /** Terminal-event routing predicate: still routes taskCompleted's output
   *  even after turn.ended moved the agent out of the dock filter. */
  function wasSideChatAgent(agentId: string | undefined): boolean {
    return agentId !== undefined && knownSideChatAgentIds.has(agentId);
  }


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
    // A resync baseline is being rebuilt for this agent — hold the chunk and
    // let it replay onto the fresh baseline instead of being replaced away.
    const resyncBuffer = resyncBufferByAgent.get(agentId);
    if (resyncBuffer !== undefined) {
      resyncBuffer.push({ text: chunk });
      return;
    }
    updateSideChatMessages(agentId, (messages) => {
      const last = messages.at(-1);
      if (last?.role === 'assistant') {
        const parts = last.content;
        const lastPart = parts.at(-1);
        if (lastPart?.type === 'text') {
          // Continue ONLY the trailing text part — the parts before it
          // (thinking/tool cards, e.g. freshly rebuilt by a resync) stay.
          return [
            ...messages.slice(0, -1),
            {
              ...last,
              content: [...parts.slice(0, -1), { type: 'text', text: `${lastPart.text}${chunk}` }],
            },
          ];
        }
        // The tail part is not text (a rebuilt thinking/tool card): start a
        // NEW text part instead of replacing the whole content.
        return [
          ...messages.slice(0, -1),
          { ...last, content: [...parts, { type: 'text', text: chunk }] },
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

  // Assistant chunks arriving while a side chat's transcript baseline is being
  // rebuilt (resyncSideChat): the whole-array replace would delete a chunk that
  // landed after the server's snapshot point, so they buffer here and replay
  // onto the rebuilt baseline instead. Terminal outputs (taskCompleted's
  // outputPreview) ride the same buffer — the task is done, no more chunks
  // will come, and the replace would drop the only copy.
  const resyncBufferByAgent = new Map<string, { text: string; terminal?: boolean }[]>();
  // The current round's submit-POST window per agent, COUNTED: concurrent
  // sends share the agent (openSideChatOn lets each caller send its own
  // initial prompt), and one call's settle must not clear the window while
  // another POST is still out — an unanswered POST means a missing promptId
  // is "not stamped yet", NOT "lost" (see arbitrateUnmarkedTaskCompleted).
  const pendingSubmitCountByAgent = new Map<string, number>();
  const parkedTaskCompletedByAgent = new Map<string, { outputPreview?: string }>();

  // Per-agent in-flight resync marks: a second resync_required while the
  // first rebuild is still reading would REPLACE the shared buffer (and each
  // completion would commit over the other's window). But that later resync
  // is itself a journal gap whose events NEVER reached us — they can't be in
  // the in-flight buffer either — so it's remembered and re-run once the
  // current rebuild commits.
  const resyncInFlightByAgent = new Set<string>();
  const resyncPendingByAgent = new Set<string>();

  /** Rebuild an active side chat's messages from its agent transcript after a
   *  session-event resync: the raw-delta gap is unrecoverable (side-channel
   *  agents have no transcript subscription of their own), and without a fresh
   *  baseline new chunks would append to a truncated reply. */
  async function resyncSideChat(parentSessionId: string): Promise<void> {
    const target = sideChatTargetBySession.value[parentSessionId];
    if (target === undefined) return;
    if (resyncInFlightByAgent.has(target.agentId)) {
      resyncPendingByAgent.add(target.agentId);
      return;
    }
    resyncInFlightByAgent.add(target.agentId);
    // Buffer from BEFORE the request leaves: the server's snapshot point sits
    // somewhere inside the request window, and deltas past it must survive.
    // Messages APPENDED meanwhile (a fresh side-chat prompt's optimistic user
    // bubble) must survive the whole-array replace too — remember the tail
    // boundary now and carry them over.
    const messagesBefore = rawState.sideChatMessagesByAgent[target.agentId] ?? [];
    // The CURRENT round's prompt id, captured BEFORE the rebuild replaces
    // (and possibly dedupes away) the local bubble — the post-resync
    // sending-state settle arbitrates by this id, not by anything the
    // rebuilt array may or may not still carry.
    const lastLocalPid = messagesBefore.findLast(
      (msg) => msg.metadata?.['kimiWeb.optimisticUserMessage'] === true,
    )?.promptId;
    resyncBufferByAgent.set(target.agentId, []);
    try {
      const snapshot = await api.getSessionTranscript(parentSessionId, {
        agentId: target.agentId,
      });
      // The parent died (or the panel closed) while the read was in flight:
      // clearSideChatForSession already dropped the buckets, and committing
      // here would resurrect them as orphans no teardown can reach again.
      if (sideChatTargetBySession.value[parentSessionId]?.agentId !== target.agentId) return;
      const taskById = new Map(snapshot.tasks.map((task) => [task.taskId, task]));
      const messages = snapshot.items.flatMap((item) =>
        item.kind === 'turn'
          ? turnToMessages(item, snapshot.attachments, taskById, undefined, undefined, parentSessionId)
          : [],
      );
      const appendedTail = (rawState.sideChatMessagesByAgent[target.agentId] ?? [])
        .slice(messagesBefore.length)
        .filter((msg) => {
          // The server's snapshot may already cover a message appended
          // meanwhile (its POST was processed before the GET ran): keep only
          // what the snapshot hasn't. A queued prompt isn't rendered yet —
          // the bubble must stay until its turn starts. The confirmed id lives
          // at the message's TOP-level promptId (confirmSideChatUserMessage /
          // reconcileSideChatUserMessage stamp it there) — the metadata key
          // belongs to the MAIN optimistic bubbles and is never set here.
          const pid = msg.promptId ?? (msg.metadata?.['kimiWeb.promptId'] as string | undefined);
          if (pid === undefined) return true;
          return !snapshot.prompts.some(
            (prompt) => prompt.promptId === pid && prompt.status !== 'queued',
          );
        });
      // An optimistic bubble that existed BEFORE the resync and got confirmed
      // IN PLACE meanwhile (WS echo stamps promptId/userMessageId by ARRAY
      // REPLACE, so messagesBefore never sees them) is in messagesBefore, not
      // the tail — the snapshot can't cover it either (the echo arrived after
      // the snapshot point). Read the carry-over candidates from the CURRENT
      // array's prefix so the freshly stamped identity reconciles too.
      const currentMessages = rawState.sideChatMessagesByAgent[target.agentId] ?? [];
      const optimisticCarry = currentMessages.slice(0, messagesBefore.length).filter((msg) => {
        if (msg.metadata?.['kimiWeb.optimisticUserMessage'] !== true) return false;
        const pid = msg.promptId ?? (msg.metadata?.['kimiWeb.promptId'] as string | undefined);
        if (pid === undefined) {
          // No identity yet (POST unanswered): the snapshot CANNOT cover this
          // bubble by definition — keep it. A whole-history text match would
          // drop a legit resend of an old message's text.
          return true;
        }
        return !snapshot.prompts.some(
          (prompt) => prompt.promptId === pid && prompt.status !== 'queued',
        );
      });
      rawState.sideChatMessagesByAgent = {
        ...rawState.sideChatMessagesByAgent,
        [target.agentId]: [...messages, ...optimisticCarry, ...appendedTail],
      };
      // Replay chunks that streamed in while the baseline was in flight. Take
      // the buffer OUT first: appendSideChatAssistantText re-enters the buffer
      // while it's set, and replaying into the same array we're iterating
      // would loop forever. Chunks that landed BEFORE the server's snapshot
      // point are already in the rebuilt tail — drop the overlap by matching
      // the WHOLE buffered sequence against the tail (item-wise endsWith only
      // catches a single chunk, not A+B already concatenated there).
      const buffered = resyncBufferByAgent.get(target.agentId) ?? [];
      resyncBufferByAgent.delete(target.agentId);
      const deltaText = buffered.filter((item) => item.terminal !== true).map((item) => item.text).join('');
      if (deltaText.length > 0) {
        const tail = (rawState.sideChatMessagesByAgent[target.agentId] ?? []).at(-1);
        const tailText =
          tail?.role === 'assistant' && tail.content[0]?.type === 'text'
            ? tail.content[0].text
            : '';
        let overlap = 0;
        const maxOverlap = Math.min(tailText.length, deltaText.length);
        for (let k = maxOverlap; k > 0; k--) {
          if (tailText.endsWith(deltaText.slice(0, k))) {
            overlap = k;
            break;
          }
        }
        // A short "overlap" is no proof of inclusion: a fresh chunk can
        // legitimately repeat the tail's text (the snapshot ends `ha`, the
        // real next chunk is also `ha` — expected `haha`). Only a substantial
        // match is treated as already-snapshotted; below the threshold the
        // chunk is kept whole (a rare duplicate beats a lost suffix).
        if (overlap < 16) overlap = 0;
        const remaining = deltaText.slice(overlap);
        if (remaining.length > 0) {
          appendSideChatAssistantText(target.agentId, parentSessionId, remaining);
        }
      }
      for (const item of buffered) {
        if (item.terminal !== true) continue;
        // Back through finishSideChatAgent itself (buffer now detached): it
        // only appends when the rebuilt tail has no text yet — no duplicate
        // when the snapshot already contains the final answer.
        finishSideChatAgent(target.agentId, parentSessionId, item.text);
      }
      // The gap swallowed this round's turn.end (resync_required advanced
      // the cursor past it, so the end event never replays): settle the
      // sending state from the snapshot's own terminal evidence. The current
      // round's prompt id (captured before the rebuild) is the only
      // arbiter — a snapshot that merely PREDATES its entity is not an end,
      // and an unanswered send (no id yet) has no resync-level arbiter.
      if (
        lastLocalPid !== undefined &&
        rawState.sideChatSendingByAgent[target.agentId] === true &&
        snapshot.meta.activity !== 'turn'
      ) {
        const own = snapshot.prompts.find((prompt) => prompt.promptId === lastLocalPid);
        if (own !== undefined && own.status !== 'queued' && own.status !== 'running') {
          finishSideChatAgent(target.agentId, parentSessionId);
        }
      }
    } catch {
      // best-effort: the rebuild failed, but chunks buffered meanwhile must
      // still land on the CURRENT messages — deleting the buffer unread would
      // lose them (a terminal output especially has no later chunk to come).
      const buffered = resyncBufferByAgent.get(target.agentId) ?? [];
      resyncBufferByAgent.delete(target.agentId);
      // Same guard as the success path: the parent died while the read was in
      // flight — the buffer replay must not resurrect torn-down buckets.
      if (sideChatTargetBySession.value[parentSessionId]?.agentId !== target.agentId) return;
      for (const item of buffered) {
        if (item.terminal === true) {
          finishSideChatAgent(target.agentId, parentSessionId, item.text);
        } else {
          appendSideChatAssistantText(target.agentId, parentSessionId, item.text);
        }
      }
    } finally {
      resyncBufferByAgent.delete(target.agentId);
      resyncInFlightByAgent.delete(target.agentId);
      // A resync arrived while this one was in flight: its events never
      // reached us at all, so rebuild once more to cover that gap too.
      if (resyncPendingByAgent.delete(target.agentId)) {
        void resyncSideChat(parentSessionId);
      }
    }
  }

  function finishSideChatAgent(
    agentId: string,
    sessionId: string,
    outputPreview?: string,
    fromTaskCompleted?: boolean,
  ): void {
    if (fromTaskCompleted === true && !terminatedSideChatAgentIds.has(agentId)) {
      // A taskCompleted is round-scoped: its OWN round's agentTurnEnded
      // always lands first (marking the agent terminated). Arriving while
      // the agent is NOT terminated usually means a NEWER round already
      // re-armed it and this straggler belongs to a PREVIOUS round — but a
      // resync gap may instead have swallowed THIS round's turn-end, making
      // the taskCompleted the only terminal evidence left. Arbitrate by the
      // current round's prompt identity, not by whether THIS client
      // observed the turn-end.
      void arbitrateUnmarkedTaskCompleted(agentId, sessionId, outputPreview);
      return;
    }
    rawState.sideChatSendingByAgent = { ...rawState.sideChatSendingByAgent, [agentId]: false };
    // The turn ended: move the agent out of the dock filter, but KEEP the id
    // known so a later taskCompleted still routes its output here (the clear
    // for real happens with the session).
    terminatedSideChatAgentIds.add(agentId);
    if (!outputPreview) return;
    // The terminal output rides the resync buffer like a text delta: the
    // whole-array replace would otherwise drop the only copy (the task is
    // done — no more chunks will ever arrive).
    const resyncBuffer = resyncBufferByAgent.get(agentId);
    if (resyncBuffer !== undefined) {
      resyncBuffer.push({ text: outputPreview, terminal: true });
      return;
    }
    const messages = rawState.sideChatMessagesByAgent[agentId] ?? [];
    const last = messages.at(-1);
    // Text may live at ANY part index now (a resync-window delta can append
    // after thinking/tool parts) — dedupe against the actual trailing text
    // part, not content[0], or the output would duplicate the visible reply.
    const lastText = last?.role === 'assistant'
      ? (last.content.findLast(
          (part): part is Extract<AppMessageContent, { type: 'text' }> => part.type === 'text',
        )?.text ?? '')
      : '';
    if (lastText.trim().length > 0) return;
    appendSideChatAssistantText(agentId, sessionId, outputPreview);
  }

  /** The fromTaskCompleted guard's arbitration (see finishSideChatAgent): a
   *  one-shot transcript read decides by the CURRENT round's prompt identity.
   *  Terminal prompt ⇒ this taskCompleted IS the current round's terminal
   *  (its turn-end was swallowed by a resync gap) — accept it. A live prompt
   *  ⇒ the current round is still running and this is a previous round's
   *  straggler — drop it. */
  async function arbitrateUnmarkedTaskCompleted(
    agentId: string,
    sessionId: string,
    outputPreview?: string,
  ): Promise<void> {
    if ((pendingSubmitCountByAgent.get(agentId) ?? 0) > 0) {
      // ANY unanswered POST on this agent: the judgement can't see the full
      // round picture yet — the newest bubble carrying an id (or not) says
      // nothing about the outstanding one. Park until every identity is
      // known, then arbitrate.
      parkedTaskCompletedByAgent.set(agentId, { outputPreview });
      return;
    }
    const optimisticNow = rawState.sideChatMessagesByAgent[agentId] ?? [];
    const currentPid = optimisticNow.findLast(
      (msg) => msg.metadata?.['kimiWeb.optimisticUserMessage'] === true,
    )?.promptId;
    let currentRoundEnded: boolean;
    try {
      const snapshot = await api.getSessionTranscript(sessionId, { agentId });
      if (currentPid !== undefined) {
        // The taskCompleted belongs to the CURRENT round only when its prompt
        // is terminal — the newest local bubble, not a whole-history set
        // (every local send stays flagged optimistic forever, and old ids
        // that scrolled out of the window would pin the verdict forever).
        const own = snapshot.prompts.find((prompt) => prompt.promptId === currentPid);
        const ownTerminal =
          own !== undefined && own.status !== 'queued' && own.status !== 'running';
        // Accepting is sound only when the transcript is quiet AND no prompt
        // in the window is still queued/running: local bubble order is NOT
        // the daemon's order (a slower prep can submit an earlier bubble
        // behind a later one), so the newest being terminal says nothing
        // about a sibling that may still be queued.
        const anyLive = snapshot.prompts.some(
          (prompt) => prompt.status === 'queued' || prompt.status === 'running',
        );
        currentRoundEnded =
          ownTerminal && !anyLive && snapshot.meta.activity !== 'turn';
      } else {
        // No local prompt identity (the POST's fate was uncertain): the
        // transcript's activity is the only arbiter.
        currentRoundEnded = snapshot.meta.activity !== 'turn';
      }
    } catch {
      // Best-effort: keep the sending state; a later edge may still settle it.
      return;
    }
    if (!currentRoundEnded) return;
    // Identity guard against a NEW round started mid-read: the prompt we
    // arbitrated must still be the latest local one.
    const latestPid = (rawState.sideChatMessagesByAgent[agentId] ?? []).findLast(
      (msg) => msg.metadata?.['kimiWeb.optimisticUserMessage'] === true,
    )?.promptId;
    if (latestPid !== currentPid) return;
    finishSideChatAgent(agentId, sessionId, outputPreview);
  }

  /** Open (creating if needed) the side chat for the active session; optionally send a first prompt. */
  async function openSideChat(initialPrompt?: string): Promise<boolean> {
    const parent = rawState.activeSessionId;
    if (!parent) return false;
    return openSideChatOn(parent, initialPrompt);
  }

  // In-flight AGENT CREATIONS keyed by parent session — the dedup slot behind
  // openSideChatOn's concurrency guard (cleared on settle). Only the creation
  // is deduped: each caller sends its own initial prompt independently, so a
  // failed first send never eats a concurrent caller's prompt.
  const createInFlightBySession = new Map<string, Promise<boolean>>();

  // Quotes dropped off by the GUARDED side-chat open (selection quote
  // actions: the user moved on mid-flight, so the panel must not force
  // itself open) — keyed by parent session, consumed by the next
  // SideChatPanel mount for that session.
  const pendingDraftBySession = ref<Record<string, string>>({});

  // Session-deletion generation: bumped by clearSideChatForSession, captured
  // by createSideChatAgent so an async create result writes back only when
  // the session is still alive (a stale generation = tombstoned mid-flight).
  // Also the tombstone behind setSideChatPendingDraft's refusal.
  const sideChatClearGenerationBySession = new Map<string, number>();

  function clearGeneration(sessionId: string): number {
    return sideChatClearGenerationBySession.get(sessionId) ?? 0;
  }

  /** Stash a draft for the session's side chat (guarded-open fallback).
   *  Repeat stashes JOIN like the panel's own insertDraft — one normalized
   *  draft, never last-write-wins. A cleared-and-never-reopened session is
   *  tombstoned: stashing is refused (its agent target is gone for good). */
  function setSideChatPendingDraft(sessionId: string, text: string): void {
    if (clearGeneration(sessionId) > 0 && sideChatTargetBySession.value[sessionId] === undefined) return;
    const existing = pendingDraftBySession.value[sessionId];
    pendingDraftBySession.value = {
      ...pendingDraftBySession.value,
      [sessionId]: existing === undefined ? text : joinDraftSegments(existing, text),
    };
  }

  /** Read AND clear the session's pending side-chat draft (null when none). */
  function takeSideChatPendingDraft(sessionId: string): string | null {
    const text = pendingDraftBySession.value[sessionId];
    if (text === undefined) return null;
    const { [sessionId]: _removed, ...rest } = pendingDraftBySession.value;
    void _removed;
    pendingDraftBySession.value = rest;
    return text;
  }

  // The WHOLE side-chat draft, keyed by parent session: the panel instance is
  // reused across session switches (not keyed) and unmounts when the target
  // session has no BTW tab, so the draft cannot live in component state —
  // typed text is saved as it changes and re-loaded by the panel on mount /
  // switch. Same layer and record style as pendingDraftBySession.
  const sideChatDraftBySession = ref<Record<string, string>>({});

  /** Persist the session's side-chat draft; an empty draft evicts the key. */
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

  /** The session's persisted side-chat draft ('' when none). */
  function sideChatDraft(sessionId: string): string {
    return sideChatDraftBySession.value[sessionId] ?? '';
  }

  /** Clear the session's persisted draft ONLY when it still equals the given
   *  snapshot — the post-send cleanup. A draft that moved on mid-flight (the
   *  user typed more before the send resolved, possibly after the panel
   *  closed or switched sessions, so its draft watcher can no longer run) is
   *  the user's new content and must survive. */
  function clearSideChatDraftIfUnchanged(sessionId: string, snapshot: string): void {
    if (sideChatDraftBySession.value[sessionId] !== snapshot) return;
    const { [sessionId]: _removed, ...rest } = sideChatDraftBySession.value;
    void _removed;
    sideChatDraftBySession.value = rest;
  }

  /** Low-level: open the side chat on an explicit parent session id.
   *  Used when the parent was just created from the empty composer so the call
   *  can target it directly instead of reading the active session (which could
   *  race with a concurrent session switch). */
  /** Resolves false when the initial prompt provably never left, so the
   *  caller can restore the text (the composer consumed the /btw command). */
  async function openSideChatOn(parent: string, initialPrompt?: string): Promise<boolean> {
    if (!sideChatTargetBySession.value[parent]) {
      // Concurrent first opens for the SAME session share one in-flight
      // CREATION: two opens landing before the first startBtw returns would
      // otherwise both take the create branch and spawn an orphan agent (the
      // second target write clobbers the first). The dedup covers only the
      // creation — a piggybacked caller sends its own prompt afterwards and
      // gets its own result.
      const inFlight = createInFlightBySession.get(parent);
      if (inFlight) {
        const created = await inFlight;
        if (!created) return false;
      } else {
        const create = createSideChatAgent(parent);
        createInFlightBySession.set(parent, create);
        try {
          const created = await create;
          if (!created) return false;
        } finally {
          // Identity-guarded: clearSideChatForSession may have invalidated
          // this slot mid-flight, and a LATER call may already have opened a
          // fresh one — never evict another call's slot.
          if (createInFlightBySession.get(parent) === create) {
            createInFlightBySession.delete(parent);
          }
        }
      }
    }
    if (initialPrompt && initialPrompt.trim()) {
      return sendSideChatPromptOn(parent, initialPrompt.trim());
    }
    return true;
  }

  /** The deduped half of openSideChatOn: startBtw + target registration. The
   *  async result writes back ONLY when no clear landed during the flight —
   *  a stale clear-generation means the parent session was archived/deleted
   *  mid-create, and registering the fresh agent would resurrect hidden
   *  state for a dead session (a LATER explicit open captures the bumped
   *  generation and proceeds normally, e.g. after a restore). */
  async function createSideChatAgent(parent: string): Promise<boolean> {
    const generation = clearGeneration(parent);
    let agentId: string;
    try {
      ({ agentId } = await api.startBtw(parent));
    } catch (err) {
      pushOperationFailure('openSideChat', err, { sessionId: parent });
      return false;
    }
    if (clearGeneration(parent) !== generation) return false;
    knownSideChatAgentIds.add(agentId);
    rawState.sideChatMessagesByAgent = {
      ...rawState.sideChatMessagesByAgent,
      [agentId]: rawState.sideChatMessagesByAgent[agentId] ?? [],
    };
    sideChatTargetBySession.value = {
      ...sideChatTargetBySession.value,
      [parent]: { agentId },
    };
    {
      const ids = sideChatAgentIdsBySession.get(parent) ?? new Set<string>();
      ids.add(agentId);
      sideChatAgentIdsBySession.set(parent, ids);
    }
    connectEventsIfNeeded();
    getEventConn()?.markSideChannelAgent(parent, agentId);
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
    // The same BTW agent runs MULTIPLE turns: finishSideChatAgent cleared the
    // mark at the previous turn's end — re-mark so this new turn's task row
    // stays out of the dock too.
    terminatedSideChatAgentIds.delete(agentId);
    knownSideChatAgentIds.add(agentId);
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
    // The arbitration window opens with the bubble — BEFORE any submit-prep
    // await (resolving the thinking level can cost a /status round-trip in a
    // cold session): a straggler taskCompleted arriving in that prep window
    // would otherwise judge against an idle pre-submit snapshot and end a
    // round whose POST is still being assembled.
    pendingSubmitCountByAgent.set(agentId, (pendingSubmitCountByAgent.get(agentId) ?? 0) + 1);
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
      // No turn provably started (pre-submit failure or definitive refusal):
      // undo the re-mark too — the previous turn already terminated, so
      // nothing will ever clear it, and the finished task rows would stay
      // dock-filtered forever. (An ambiguous lost response keeps the mark:
      // the prompt may still launch.)
      const provablyNoTurn = !submitAttempted || err instanceof DaemonApiError;
      if (provablyNoTurn) {
        // Undo the re-mark's DOCK state only: the agent goes back to
        // terminated-filtered, but its routing identity stays KNOWN — the
        // previous round's taskCompleted may still be in flight, and its
        // final answer routes through wasSideChatAgent.
        terminatedSideChatAgentIds.add(agentId);
      }
      // Only a provably-unsent failure — or a definitive daemon refusal,
      // which provably accepted nothing — lets the panel restore the draft.
      return provablyNoTurn ? false : true;
    } finally {
      // Counted settle: a CONCURRENT send's POST may still be out — only the
      // last outstanding answer runs the parked arbitration.
      const left = (pendingSubmitCountByAgent.get(agentId) ?? 1) - 1;
      if (left > 0) pendingSubmitCountByAgent.set(agentId, left);
      else pendingSubmitCountByAgent.delete(agentId);
      const parked = parkedTaskCompletedByAgent.get(agentId);
      if (left === 0 && parked !== undefined) {
        parkedTaskCompletedByAgent.delete(agentId);
        // The answer stamped (or definitively denied) the identity the
        // arbitration was parked for.
        void arbitrateUnmarkedTaskCompleted(agentId, sid, parked.outputPreview);
      }
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
    // Bump the deletion generation FIRST: any in-flight create holds a stale
    // one from here on and must not write its result back. The in-flight
    // dedup slot dies with it too — a LATER open (e.g. the session was
    // archived and restored) must start a fresh creation at the new
    // generation instead of piggybacking on the stale one.
    sideChatClearGenerationBySession.set(sessionId, clearGeneration(sessionId) + 1);
    createInFlightBySession.delete(sessionId);
    // Session-keyed, so always cleanable — even when the target is already
    // gone (the user closed the BTW tab before the session died). The
    // agent-keyed buckets below can only be resolved while a target exists.
    if (rawState.sideChatUserMessageIdsBySession[sessionId] !== undefined) {
      const { [sessionId]: _ids, ...restIds } = rawState.sideChatUserMessageIdsBySession;
      void _ids;
      rawState.sideChatUserMessageIdsBySession = restIds;
    }
    // A stashed pending draft (guarded-open fallback) dies with the session
    // too — a long quote must not linger forever.
    if (pendingDraftBySession.value[sessionId] !== undefined) {
      const { [sessionId]: _draft, ...restDrafts } = pendingDraftBySession.value;
      void _draft;
      pendingDraftBySession.value = restDrafts;
    }
    // The persisted whole draft dies with the session as well.
    if (sideChatDraftBySession.value[sessionId] !== undefined) {
      const { [sessionId]: _draft, ...restDrafts } = sideChatDraftBySession.value;
      void _draft;
      sideChatDraftBySession.value = restDrafts;
    }

    const target = sideChatTargetBySession.value[sessionId];
    // Panel closed first? The target is gone but the attribution stays — skip
    // nothing, or the agent-keyed buckets leak for the app's lifetime. Clean
    // EVERY agent the session ever started: a reopened panel replaced the
    // target with a new agent, and the superseded one's buckets are just as
    // dead as the current one's.
    const agentIds = new Set<string>(sideChatAgentIdsBySession.get(sessionId) ?? []);
    if (target?.agentId !== undefined) agentIds.add(target.agentId);
    sideChatAgentIdsBySession.delete(sessionId);
    const { [sessionId]: _removed, ...rest } = sideChatTargetBySession.value;
    void _removed;
    sideChatTargetBySession.value = rest;

    for (const agentId of agentIds) {
      knownSideChatAgentIds.delete(agentId);
      terminatedSideChatAgentIds.delete(agentId);
      pendingSubmitCountByAgent.delete(agentId);
      parkedTaskCompletedByAgent.delete(agentId);
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
    resyncSideChat,
    isSideChatAgent,
    wasSideChatAgent,
    openSideChat,
    openSideChatOn,
    closeSideChat,
    sendSideChatPrompt,
    setSideChatPendingDraft,
    takeSideChatPendingDraft,
    saveSideChatDraft,
    sideChatDraft,
    clearSideChatDraftIfUnchanged,
    clearSideChatForSession,
  };
}

export type UseSideChat = ReturnType<typeof useSideChat>;
