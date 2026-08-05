// web-core daemon event reducer.
// Pure TypeScript state reducer for KimiClient.
// Operates on plain TS state — no Vue reactivity here.
// The reducer consumes AppEvent (camelCase), produced by toAppEvent() in mappers.ts.
//
// No-op-but-known events (tool.*, assistant streaming, assistant.completed)
// are mapped to { type: 'unknown', raw: { _noop: true, ... } } by mappers.ts.
// The reducer detects `_noop: true` and silently advances lastSeqBySession
// without pushing a warning.

import type {
  AppApprovalRequest,
  AppConfig,
  AppEvent,
  AppGoal,
  AppMessage,
  AppMessageContent,
  AppNotice,
  AppNoticeDetail,
  AppTurnError,
  AppTurnRetry,
  AppWarning,
  AppQuestionRequest,
  AppSession,
  AppTask,
  CompactionMarkerMetadata,
} from '../types';
import { COMPACTION_MARKER_METADATA_KEY } from '../types';

/** Translator injected by the consumer so the reducer stays free of any
 *  concrete i18n instance. Defaults to the identity (returns the key), which
 *  keeps pure/reducer tests independent of a host locale. */
export interface ReduceContext {
  t: (key: string, params?: Record<string, unknown>) => string;
}

const DEFAULT_REDUCE_CONTEXT: ReduceContext = { t: (key) => key };

const OPTIMISTIC_USER_MESSAGE_METADATA_KEY = 'kimiWeb.optimisticUserMessage';

/** Tail cap for accumulated output of non-subagent (bash / background tool)
 *  tasks, whose stdout can be noisy and unbounded. Subagent progress is kept
 *  in full (small synthesized lines). */
const MAX_BACKGROUND_OUTPUT_LINES = 40;

/** Skeleton description used by `patchSubagent` in agentEventProjector.ts when
 *  a lifecycle event re-projects a subagent the projector never saw spawn
 *  (e.g. after a page refresh, where the snapshot roster — not the WS stream —
 *  carried the real description). */
const PLACEHOLDER_SUBAGENT_DESCRIPTION = 'Sub Agent';

// ---------------------------------------------------------------------------
// Thinking-part timing (client-side only)
// ---------------------------------------------------------------------------
// The daemon streams thinking deltas without any timing, so the renderer
// measures it: a part is stamped `startedAt` when it opens and `durationMs`
// when the stream moves past it (a later part opens, or the message settles).
// History-loaded and snapshot-restored parts stay untimed — nothing is
// fabricated for content we never watched stream.

/** Stamp `durationMs` on every open thinking part before `before` (all parts
 *  when omitted). Idempotent. */
function closeThinkingParts(content: AppMessageContent[], nowMs: number, before = content.length): void {
  for (let i = 0; i < before; i++) {
    const part = content[i]!;
    if (part.type === 'thinking' && part.startedAt !== undefined && part.durationMs === undefined) {
      content[i] = { ...part, durationMs: Math.max(0, nowMs - Date.parse(part.startedAt)) };
    }
  }
}

/** Settle the open thinking parts of the session's latest assistant message:
 *  an approval/question parks the turn on the user, and the wait must not
 *  count as thinking time. */
function settleThinkingOnUserInteraction(next: KimiClientState, sessionId: string, nowMs: number): void {
  const msgs = next.messagesBySession[sessionId];
  if (!msgs) return;
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== 'assistant') continue;
    const hasOpenThinking = m.content.some(
      (part) => part.type === 'thinking' && part.startedAt !== undefined && part.durationMs === undefined,
    );
    if (!hasOpenThinking) return;
    const content = [...m.content];
    closeThinkingParts(content, nowMs);
    const patched = [...msgs];
    patched[i] = { ...m, content };
    next.messagesBySession[sessionId] = patched;
    return;
  }
}

/** Wall-clock ms of an approval/question request. Settling at the request
 *  moment — not at event-consumption time — keeps delivery delays (throttled
 *  tabs, busy main thread) out of the thinking span. */
function requestTimeMs(createdAt: string): number {
  const ms = Date.parse(createdAt);
  return Number.isNaN(ms) ? Date.now() : ms;
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** Live compaction progress for a session: present (status 'running') only
    while the daemon is compacting. Completion is recorded as a persistent
    divider marker message in the transcript, not as transient status. */
export interface CompactionStatus {
  status: 'running';
  trigger: 'manual' | 'auto';
}

export interface KimiClientState {
  sessions: AppSession[];
  activeSessionId?: string;
  messagesBySession: Record<string, AppMessage[]>;
  approvalsBySession: Record<string, AppApprovalRequest[]>;
  /** Preserved `plan_review` displays keyed by toolCallId. Plan content survives
   *  approval resolution so the ExitPlanMode tool card can keep rendering the
   *  plan (approved / rejected / revised) instead of losing it. */
  planReviewByToolCallId: Record<string, { plan: string; path?: string }>;
  questionsBySession: Record<string, AppQuestionRequest[]>;
  tasksBySession: Record<string, AppTask[]>;
  goalBySession: Record<string, AppGoal>;
  /** Monotonic per-session counter bumped on EVERY `goalUpdated` event —
   *  including delete/clear ones — so an async recovery read can detect that a
   *  live event won the race even when the goal entry stayed absent. */
  goalVersionBySession: Record<string, number>;
  lastSeqBySession: Record<string, number>;
  /** MAIN-agent turn in flight, per session — set from the main agent's
   *  turn.started/turn.ended boundary events and seeded from the snapshot's
   *  (main-only) inFlightTurn. Half of the working moon; subagent turns never
   *  reach the events that set this. */
  turnActiveBySession: Record<string, boolean>;
  /** promptId served by the most recently ended main turn, per session. When
   *  prompt.aborted arrives for that same prompt it is an active-turn abort —
   *  turn.ended already provided the recency moment, so promptAborted skips
   *  its (no-turn) bump. Cleared when the next main turn starts. */
  turnEndedPromptIdBySession: Record<string, string>;
  /** Latest main-turn terminal error per session, captured from the agent's
   *  `error` event. Drives the persistent failed-turn card in the conversation
   *  (the warning toast alone is transient); cleared when the next main turn
   *  starts. */
  turnErrorBySession: Record<string, AppTurnError>;
  /** Live step-retry state per session (present only while the main turn's
   *  current step is backing off before a retry). Drives the working
   *  indicator's retry label. */
  turnRetryBySession: Record<string, AppTurnRetry>;
  compactionBySession: Record<string, CompactionStatus>;
  config?: AppConfig | null;
  warnings: AppWarning[];
}

export function createInitialState(): KimiClientState {
  return {
    sessions: [],
    activeSessionId: undefined,
    messagesBySession: {},
    approvalsBySession: {},
    planReviewByToolCallId: {},
    questionsBySession: {},
    tasksBySession: {},
    goalBySession: {},
    goalVersionBySession: {},
    lastSeqBySession: {},
    turnActiveBySession: {},
    turnEndedPromptIdBySession: {},
    turnErrorBySession: {},
    turnRetryBySession: {},
    compactionBySession: {},
    warnings: [],
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function cloneState(s: KimiClientState): KimiClientState {
  return {
    ...s,
    // Reuse the `sessions` array reference when an event does not touch it.
    // Every session-mutating case below already builds its own array via
    // `[...]` / `.map` / `.filter`, so sharing the reference is safe — and it
    // keeps `rawState.sessions` stable for events that don't change sessions,
    // so the sidebar computeds (sessionsForView / workspaceGroups /
    // mergedWorkspaces) are not dirtied by unrelated events.
    sessions: s.sessions,
    messagesBySession: { ...s.messagesBySession },
    approvalsBySession: { ...s.approvalsBySession },
    planReviewByToolCallId: { ...s.planReviewByToolCallId },
    questionsBySession: { ...s.questionsBySession },
    tasksBySession: { ...s.tasksBySession },
    goalBySession: { ...s.goalBySession },
    goalVersionBySession: { ...s.goalVersionBySession },
    lastSeqBySession: { ...s.lastSeqBySession },
    turnActiveBySession: { ...s.turnActiveBySession },
    turnEndedPromptIdBySession: { ...s.turnEndedPromptIdBySession },
    turnErrorBySession: { ...s.turnErrorBySession },
    turnRetryBySession: { ...s.turnRetryBySession },
    compactionBySession: { ...s.compactionBySession },
    warnings: [...s.warnings],
  };
}

function advanceSeq(state: KimiClientState, sessionId: string | undefined, seq: number | undefined): void {
  if (sessionId !== undefined && seq !== undefined && seq > 0) {
    const prev = state.lastSeqBySession[sessionId] ?? 0;
    if (seq > prev) {
      state.lastSeqBySession[sessionId] = seq;
    }
  }
}

/** Float a session to the top of the sidebar by bumping its `updatedAt` to now
 *  (never backwards). Recency is deliberately coarse: only moments the user
 *  should look at bump it — main-turn end and new approval/question requests.
 *  Per-step and per-tool-call messages do NOT (they re-sorted the session list
 *  mid-turn). */
function bumpSessionRecency(state: KimiClientState, sessionId: string): void {
  const now = new Date().toISOString();
  state.sessions = state.sessions.map((s) =>
    s.id === sessionId && now > s.updatedAt ? { ...s, updatedAt: now } : s,
  );
}

/** True when the event actually advances the session's durable seq cursor —
 *  i.e. it is fresh, not a stale/replayed frame arriving after a snapshot
 *  resync already moved the cursor past it (the same gate processEvent
 *  applies to its turn-end side effects). Recency bumps must only fire for
 *  fresh events, or a replay floats an idle session to the top. */
function isFreshEvent(state: KimiClientState, meta: EventMeta): boolean {
  return meta.seq > (state.lastSeqBySession[meta.sessionId] ?? 0);
}

function isOptimisticUserMessage(message: AppMessage): boolean {
  return (
    message.role === 'user' &&
    message.metadata?.[OPTIMISTIC_USER_MESSAGE_METADATA_KEY] === true
  );
}

function isCronOriginMessage(message: AppMessage): boolean {
  const origin = message.metadata?.['origin'] as { kind?: string } | undefined;
  return origin?.kind === 'cron_job' || origin?.kind === 'cron_missed';
}

/** System-trigger messages (goal continuations, …) are synthesized by the
    runtime, never typed by the user — they can never be an optimistic echo. */
function isSystemTriggerOriginMessage(message: AppMessage): boolean {
  const origin = message.metadata?.['origin'] as { kind?: string } | undefined;
  return origin?.kind === 'system_trigger';
}

function findOptimisticUserEchoIndex(messages: AppMessage[], message: AppMessage): number {
  const userMessageId = message.userMessageId ?? message.id;
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i]!;
    if (
      isOptimisticUserMessage(candidate) &&
      candidate.userMessageId === userMessageId
    ) {
      return i;
    }
  }

  const promptId = message.promptId;
  if (promptId !== undefined) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i]!;
      if (isOptimisticUserMessage(candidate) && candidate.promptId === promptId) {
        return i;
      }
    }
  }

  return -1;
}

function appendToolOutputToMessages(messages: AppMessage[], toolCallId: string, outputChunk: string): AppMessage[] {
  let changed = false;
  const next = messages.map((message) => {
    let contentChanged = false;
    const content = message.content.map((part) => {
      if (part.type !== 'toolUse' || part.toolCallId !== toolCallId) return part;
      contentChanged = true;
      return {
        ...part,
        outputLines: [...(part.outputLines ?? []), outputChunk],
      };
    });
    if (!contentChanged) return message;
    changed = true;
    return { ...message, content };
  });
  return changed ? next : messages;
}

// ---------------------------------------------------------------------------
// Reducer
// ---------------------------------------------------------------------------

/** Agent error code → semantic title key under `warnings.agentError`. Codes
 *  come from the protocol error domain (agent-core-v2 `ProtocolErrors`);
 *  anything unmapped falls back to the generic `title`. */
const AGENT_ERROR_TITLE_KEYS: Readonly<Record<string, string>> = {
  'provider.connection_error': 'connection',
  'provider.auth_error': 'auth',
  'provider.rate_limit': 'rateLimit',
  'provider.overloaded': 'overloaded',
  'provider.filtered': 'filtered',
  'provider.api_error': 'api',
  'context.overflow': 'contextOverflow',
};

interface AgentErrorRaw {
  code?: string;
  message?: string;
  name?: string;
  details?: Record<string, unknown>;
}

/**
 * Build the structured error notice for a failed agent turn (typically a
 * model-provider failure). The wire payload already carries the coded error —
 * surface it in full so a rate-limit / auth / endpoint failure is diagnosable
 * from the toast: semantic title, the provider's raw message as the body, and
 * a diagnostics list (error code, HTTP status, request id, SDK error name,
 * plus any extra detail fields such as finishReason).
 */
function buildAgentErrorNotice(raw: AgentErrorRaw, t: ReduceContext['t']): AppNotice {
  const details: AppNoticeDetail[] = [];
  const push = (label: string, value: unknown): void => {
    if (typeof value === 'number' || typeof value === 'boolean') {
      details.push({ label, value: String(value) });
    } else if (typeof value === 'string' && value.length > 0) {
      details.push({ label, value });
    }
  };
  push(t('warnings.details.code'), raw.code);
  const rawDetails = raw.details ?? {};
  push(t('warnings.details.status'), rawDetails['statusCode']);
  push(t('warnings.details.requestId'), rawDetails['requestId']);
  push(t('warnings.details.errorName'), raw.name);
  // Keep any remaining detail fields (finishReason, rawFinishReason, …) so no
  // diagnostics the daemon sent are hidden.
  for (const [key, value] of Object.entries(rawDetails)) {
    if (key === 'statusCode' || key === 'requestId') continue;
    push(key, value);
  }
  const titleKey = (raw.code !== undefined ? AGENT_ERROR_TITLE_KEYS[raw.code] : undefined) ?? 'title';
  return {
    severity: 'error',
    title: t(`warnings.agentError.${titleKey}`),
    message: raw.message,
    details: details.length > 0 ? details : undefined,
  };
}

/**
 * Apply a single AppEvent to the state, returning a new state object.
 * The event carries `_wireSeq` and `_wireSessionId` as hidden extras when
 * produced by the client wrapper, but the reducer only depends on the
 * AppEvent.type discriminant.
 *
 * Extra metadata attached by the caller:
 *   meta.sessionId — wire session_id for lastSeqBySession update
 *   meta.seq       — wire seq for lastSeqBySession update
 */
export interface EventMeta {
  sessionId: string;
  seq: number;
}

export function reduceAppEvent(
  state: KimiClientState,
  event: AppEvent,
  meta: EventMeta,
  ctx: ReduceContext = DEFAULT_REDUCE_CONTEXT,
): KimiClientState {
  const next = cloneState(state);

  // Always advance lastSeqBySession for every event that carries seq info.
  advanceSeq(next, meta.sessionId, meta.seq);

  switch (event.type) {
    // -------------------------------------------------------------------------
    case 'sessionCreated': {
      const exists = next.sessions.some((s) => s.id === event.session.id);
      if (!exists) {
        next.sessions = [event.session, ...next.sessions];
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionUpdated': {
      next.sessions = next.sessions.map((s) =>
        s.id === event.session.id ? event.session : s,
      );
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionDeleted': {
      const id = event.sessionId;
      next.sessions = next.sessions.filter((s) => s.id !== id);
      delete next.messagesBySession[id];
      delete next.tasksBySession[id];
      delete next.goalBySession[id];
      delete next.approvalsBySession[id];
      delete next.questionsBySession[id];
      delete next.lastSeqBySession[id];
      delete next.turnActiveBySession[id];
      delete next.turnEndedPromptIdBySession[id];
      delete next.turnErrorBySession[id];
      delete next.turnRetryBySession[id];
      if (next.activeSessionId === id) {
        next.activeSessionId = undefined;
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionWorkChanged': {
      // A replayed work_changed (stale seq after a reconnect) carries a stale
      // busy/liveness/outcome aggregate — applying it could idle a turn that
      // is actually mid-retry or clear the latest turn outcome. The current
      // aggregate is restored from the snapshot, so only fresh frames apply.
      if (!isFreshEvent(state, meta)) break;
      let pendingInteraction: AppSession['pendingInteraction'];
      next.sessions = next.sessions.map((s) => {
        if (s.id !== event.sessionId) return s;
        pendingInteraction =
          event.pendingInteraction ?? (event.busy ? s.pendingInteraction : 'none');
        return {
          ...s,
          busy: event.busy,
          mainTurnActive: event.mainTurnActive ?? (event.busy ? s.mainTurnActive : false),
          pendingInteraction,
          // Authoritative, not nullish-merge: an omitted last_turn_reason is
          // how the server says "no current outcome" (a fresh turn cleared
          // the previous one), so the stale value must not survive.
          lastTurnReason: event.lastTurnReason,
        };
      });
      if (pendingInteraction === 'none') {
        delete next.approvalsBySession[event.sessionId];
        delete next.questionsBySession[event.sessionId];
      } else if (pendingInteraction === 'question') {
        delete next.approvalsBySession[event.sessionId];
      }
      if (event.mainTurnActive === true) {
        next.turnActiveBySession[event.sessionId] = true;
      } else if (event.mainTurnActive === false || !event.busy) {
        // The fallback end-of-turn path: turn.ended was lost (abrupt agent
        // disposal) and this work_changed retires the main turn instead.
        // Give the turn its recency bump — but only when the flag was still
        // set (a normal turn.ended already cleared it and bumped).
        if (state.turnActiveBySession[event.sessionId]) {
          bumpSessionRecency(next, event.sessionId);
        }
        delete next.turnActiveBySession[event.sessionId];
        // A retired turn cannot be mid-retry — drop the backoff state too.
        delete next.turnRetryBySession[event.sessionId];
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionMetaUpdated': {
      // Lightweight meta patch — the daemon's auto-generated title (or a title
      // changed by another client) and the latest user prompt arrive via
      // session.meta.updated. We keep prior values for any field the event does
      // not carry; the full session object otherwise stays as-is. Keeping
      // lastPrompt fresh lets sidebar search match the most recent prompt
      // without a full reload.
      next.sessions = next.sessions.map((s) =>
        s.id === event.sessionId
          ? { ...s, title: event.title ?? s.title, lastPrompt: event.lastPrompt ?? s.lastPrompt }
          : s,
      );
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionUsageUpdated': {
      next.sessions = next.sessions.map((s) => {
        if (s.id !== event.sessionId) return s;
        // The live model name (from agent.status.updated) rides along with usage.
        // Only overwrite model when a non-empty one is supplied.
        const model = event.model && event.model.length > 0 ? event.model : s.model;
        return { ...s, usage: event.usage, model };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'historyCompacted': {
      // Only advance lastSeqBySession; actual reload is triggered by client wrapper
      // when it sees this event type (before_seq is in event.beforeSeq).
      // The advanceSeq at top already handled seq update.
      break;
    }

    // -------------------------------------------------------------------------
    case 'compactionStarted': {
      next.compactionBySession = {
        ...next.compactionBySession,
        [event.sessionId]: { status: 'running', trigger: event.trigger },
      };
      break;
    }

    case 'compactionCompleted': {
      const sid = event.sessionId;
      const prev = next.compactionBySession[sid];
      const { [sid]: _doneEntry, ...rest } = next.compactionBySession;
      next.compactionBySession = rest;

      // Append a persistent "context compacted" divider to the loaded
      // transcript (TUI parity: the scrollback is kept untouched; only a
      // one-line marker records that compaction happened). The marker id is
      // derived from the wire seq so an event replay after reconnect can't
      // duplicate it.
      if (Object.prototype.hasOwnProperty.call(next.messagesBySession, sid)) {
        const msgs = next.messagesBySession[sid] ?? [];
        const markerId = `compaction_${sid}_${meta.seq}`;
        if (!msgs.some((m) => m.id === markerId)) {
          const marker: CompactionMarkerMetadata = {
            trigger: prev?.trigger ?? 'auto',
            tokensBefore: event.tokensBefore,
            tokensAfter: event.tokensAfter,
          };
          next.messagesBySession[sid] = [
            ...msgs,
            {
              id: markerId,
              sessionId: sid,
              role: 'assistant',
              content: event.summary ? [{ type: 'text', text: event.summary }] : [],
              createdAt: new Date().toISOString(),
              metadata: {
                origin: { kind: 'compaction_summary' },
                [COMPACTION_MARKER_METADATA_KEY]: marker,
              },
            },
          ];
        }
      }
      break;
    }

    case 'compactionCancelled': {
      const { [event.sessionId]: _gone, ...rest } = next.compactionBySession;
      next.compactionBySession = rest;
      break;
    }

    // -------------------------------------------------------------------------
    case 'messageCreated': {
      const sid = event.message.sessionId;
      // Deliberately NOT bumping the session's `updatedAt` here: messages are
      // created per step (assistant bubble) and per tool call, and bumping
      // recency on each one re-sorted the sidebar session list mid-turn.
      // Recency is turn-grained — see the `turnActiveChanged` case.
      const msgs = next.messagesBySession[sid] ?? [];
      const exists = msgs.some((m) => m.id === event.message.id);
      if (!exists) {
        // Cron-injected user messages (origin cron_job/cron_missed) carry the
        // reminder's prompt as their text, which can coincide with a still-
        // optimistic user message. They must append as their own turn rather
        // than reconcile into (and replace) that optimistic echo — so skip the
        // echo lookup entirely for them.
        if (
          event.message.role === 'user' &&
          !isCronOriginMessage(event.message) &&
          !isSystemTriggerOriginMessage(event.message)
        ) {
          const optimisticIndex = findOptimisticUserEchoIndex(msgs, event.message);
          if (optimisticIndex !== -1) {
            const updated = [...msgs];
            const optimistic = updated[optimisticIndex]!;
            updated[optimisticIndex] = {
              ...event.message,
              id: optimistic.id,
              promptId: event.message.promptId ?? optimistic.promptId,
              userMessageId: event.message.userMessageId ?? event.message.id,
              metadata: {
                ...event.message.metadata,
                ...optimistic.metadata,
              },
            };
            next.messagesBySession[sid] = updated;
            break;
          }
        }
        next.messagesBySession[sid] = [...msgs, event.message];
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'messageUpdated': {
      const sid = event.sessionId;
      const msgs = next.messagesBySession[sid] ?? [];
      next.messagesBySession[sid] = msgs.map((m) => {
        if (m.id !== event.messageId) return m;
        // Preserve renderer-stamped thinking timing across full-content
        // replaces: the projector's copy carries no stamps, so merge ours back
        // by index (type-matched).
        const content = event.content.map((part, i) => {
          const prev = m.content[i];
          if (part.type === 'thinking' && prev?.type === 'thinking') {
            return { ...part, startedAt: prev.startedAt, durationMs: prev.durationMs };
          }
          return part;
        });
        const nowMs = Date.now();
        // A thinking part with content after it can no longer be streaming;
        // once the message settles, neither can the last one.
        closeThinkingParts(content, nowMs, content.length - 1);
        if (event.status !== 'pending' || event.durationMs !== undefined) {
          closeThinkingParts(content, nowMs);
        }
        return {
          ...m,
          content,
          durationMs: event.durationMs ?? m.durationMs,
        };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'assistantDelta': {
      const sid = event.sessionId;
      const msgs = next.messagesBySession[sid] ?? [];
      next.messagesBySession[sid] = msgs.map((m) => {
        if (m.id !== event.messageId) return m;
        const content = [...m.content];
        const idx = event.contentIndex;
        const isNewSlot = content.length <= idx;
        // Ensure the slot exists
        while (content.length <= idx) {
          content.push({ type: 'text', text: '' });
        }
        const existing = content[idx]!;
        let patched: AppMessageContent;
        if (event.delta.text !== undefined) {
          if (existing.type === 'text' && !isNewSlot) {
            patched = { type: 'text', text: existing.text + event.delta.text };
          } else {
            patched = { type: 'text', text: event.delta.text };
            // A new part opened — any earlier open thinking part is done.
            closeThinkingParts(content, Date.now(), idx);
          }
        } else if (event.delta.thinking !== undefined) {
          if (existing.type === 'thinking') {
            patched = {
              type: 'thinking',
              thinking: existing.thinking + event.delta.thinking,
              signature: existing.signature,
              startedAt: existing.startedAt,
              durationMs: existing.durationMs,
            };
          } else {
            patched = {
              type: 'thinking',
              thinking: event.delta.thinking,
              startedAt: new Date().toISOString(),
            };
            closeThinkingParts(content, Date.now(), idx);
          }
        } else {
          patched = existing;
        }
        content[idx] = patched;
        return { ...m, content };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'toolOutput': {
      const sid = event.sessionId;
      const msgs = next.messagesBySession[sid] ?? [];
      next.messagesBySession[sid] = appendToolOutputToMessages(msgs, event.toolCallId, event.outputChunk);
      break;
    }

    // -------------------------------------------------------------------------
    case 'approvalRequested': {
      const sid = event.sessionId;
      const list = next.approvalsBySession[sid] ?? [];
      const exists = list.some((a) => a.approvalId === event.approval.approvalId);
      if (!exists) {
        next.approvalsBySession[sid] = [...list, event.approval];
        // A fresh approval waits on the user: settle thinking and float the
        // session to the top. A replayed request whose approval has since
        // been resolved (so the id dedupe misses it) must do neither — the
        // session may already be streaming a later turn's thinking.
        if (isFreshEvent(state, meta)) {
          settleThinkingOnUserInteraction(next, sid, requestTimeMs(event.approval.createdAt));
          bumpSessionRecency(next, sid);
        }
      }
      // Preserve a plan_review display so the plan stays visible in the
      // ExitPlanMode tool card after the approval resolves.
      const display = event.approval.display as
        | { kind?: unknown; plan?: unknown; path?: unknown }
        | null
        | undefined;
      if (display?.kind === 'plan_review' && typeof display.plan === 'string' && display.plan.length > 0) {
        next.planReviewByToolCallId = {
          ...next.planReviewByToolCallId,
          [event.approval.toolCallId]: {
            plan: display.plan,
            path: typeof display.path === 'string' ? display.path : undefined,
          },
        };
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'approvalResolved':
    case 'approvalExpired': {
      const sid = event.sessionId;
      const aid = event.approvalId;
      const list = next.approvalsBySession[sid] ?? [];
      next.approvalsBySession[sid] = list.filter((a) => a.approvalId !== aid);
      break;
    }

    // -------------------------------------------------------------------------
    case 'questionRequested': {
      const sid = event.sessionId;
      const list = next.questionsBySession[sid] ?? [];
      const exists = list.some((q) => q.questionId === event.question.questionId);
      if (!exists) {
        next.questionsBySession[sid] = [...list, event.question];
        // Same freshness gate as approvals (see there).
        if (isFreshEvent(state, meta)) {
          settleThinkingOnUserInteraction(next, sid, requestTimeMs(event.question.createdAt));
          bumpSessionRecency(next, sid);
        }
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'questionAnswered':
    case 'questionDismissed': {
      const sid = event.sessionId;
      const qid = event.questionId;
      const list = next.questionsBySession[sid] ?? [];
      next.questionsBySession[sid] = list.filter((q) => q.questionId !== qid);
      break;
    }

    // -------------------------------------------------------------------------
    case 'taskCreated': {
      const sid = event.sessionId;
      const list = next.tasksBySession[sid] ?? [];
      const idx = list.findIndex((t) => t.id === event.task.id);
      if (idx === -1) {
        next.tasksBySession[sid] = [...list, event.task];
      } else {
        const patched = [...list];
        const previous = list[idx]!;
        // The projected task does not carry reducer-owned accumulated progress;
        // preserve it across the replacement so subagent output keeps growing.
        // A resync also rebuilds skeleton tasks without their identity metadata,
        // so keep the previous value when the projected task omits it.
        patched[idx] = {
          ...event.task,
          outputLines: previous.outputLines,
          text: previous.text,
          // A post-refresh lifecycle event re-projects the task with skeleton
          // metadata; don't let its placeholder clobber the roster-seeded
          // description.
          description:
            event.task.description === PLACEHOLDER_SUBAGENT_DESCRIPTION &&
            previous.description !== PLACEHOLDER_SUBAGENT_DESCRIPTION
              ? previous.description
              : event.task.description,
          swarmIndex: event.task.swarmIndex ?? previous.swarmIndex,
          parentToolCallId: event.task.parentToolCallId ?? previous.parentToolCallId,
          subagentType: event.task.subagentType ?? previous.subagentType,
          runInBackground: event.task.runInBackground ?? previous.runInBackground,
          backgroundTaskId: event.task.backgroundTaskId ?? previous.backgroundTaskId,
          // The roster-seeded agent id anchors transcript resumes; a skeleton
          // re-projection (no wire agent_id) must not drop it.
          agentId: event.task.agentId ?? previous.agentId,
        };
        next.tasksBySession[sid] = patched;
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'taskProgress': {
      const sid = event.sessionId;
      const list = next.tasksBySession[sid] ?? [];
      next.tasksBySession[sid] = list.map((t) => {
        if (t.id !== event.taskId) return t;
        // Subagent streamed output (assistant.delta) concatenates into a single
        // growing text block rather than fragmenting each delta into its own
        // line — the detail panel renders it like a thinking block.
        if (t.kind === 'subagent' && event.kind === 'text') {
          return { ...t, text: (t.text ?? '') + event.outputChunk };
        }
        const outputLines = t.outputLines ?? [];
        if (outputLines.at(-1) === event.outputChunk) return t;
        const lines = [...outputLines, event.outputChunk];
        return {
          ...t,
          // Keep subagent progress in full (small synthesized lines) so the
          // panel shows the whole process; cap background bash/tool output,
          // which can grow without bound.
          outputLines: t.kind === 'subagent' ? lines : lines.slice(-MAX_BACKGROUND_OUTPUT_LINES),
        };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'taskCompleted': {
      const sid = event.sessionId;
      const list = next.tasksBySession[sid] ?? [];
      next.tasksBySession[sid] = list.map((t) => {
        if (t.id !== event.taskId) return t;
        return {
          ...t,
          status: event.status,
          outputPreview: event.outputPreview,
          outputBytes: event.outputBytes,
        };
      });
      break;
    }

    // -------------------------------------------------------------------------
    case 'goalUpdated': {
      const sid = event.sessionId;
      // Bump on every goal event — including clears — so refreshSessionGoal's
      // recovery read can detect any live event that landed mid-flight.
      next.goalVersionBySession[sid] = (next.goalVersionBySession[sid] ?? 0) + 1;
      if (event.goal === null || event.goal.status === 'complete') {
        delete next.goalBySession[sid];
      } else {
        next.goalBySession[sid] = event.goal;
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'configChanged': {
      next.config = event.config;
      break;
    }

    // -------------------------------------------------------------------------
    // Provider-model catalog refresh result. The daemon already persisted the
    // new catalog; the web picks it up on the next explicit model/provider load
    // (model picker, session switch). Advance seq silently.
    case 'modelCatalogChanged':
      break;

    // -------------------------------------------------------------------------
    // Agent-scoped side-channel events (e.g. BTW side chat) are consumed by the
    // web layer, not the session reducer. Advance seq silently.
    case 'agentDelta':
    case 'agentTurnEnded':
      break;

    // -------------------------------------------------------------------------
    // Prompt-level lifecycle events drive the web layer's in-flight cleanup
    // (see useKimiWebClient.processEvent), not reducer state — with two
    // recency exceptions: the no-turn prompt paths. A prompt blocked before
    // any turn started (promptCompleted reason 'blocked') and a queued prompt
    // aborted before launch (promptAborted) produce no turn.ended, so without
    // this the prompt's activity never bumps the session's recency.
    case 'promptCompleted': {
      if (event.reason === 'blocked' && isFreshEvent(state, meta)) {
        bumpSessionRecency(next, event.sessionId);
      }
      break;
    }
    case 'promptAborted': {
      // An active-turn abort arrives right after that turn's turn.ended —
      // the turn end already bumped, so a second bump would only re-sort the
      // list a moment later (and could slip the session ahead of one that
      // finished in between). This case is for the queued no-turn abort only.
      if (event.promptId === state.turnEndedPromptIdBySession[event.sessionId]) break;
      if (isFreshEvent(state, meta)) {
        bumpSessionRecency(next, event.sessionId);
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'turnActiveChanged': {
      // Replays after a reconnect/resync re-deliver old turn boundaries; the
      // current liveness comes from the snapshot, so a stale frame must not
      // move any of this state (a stale start would otherwise hide the failed
      // card behind a phantom "working").
      if (!isFreshEvent(state, meta)) break;
      next.sessions = next.sessions.map((session) =>
        session.id === event.sessionId
          ? { ...session, mainTurnActive: event.active }
          : session,
      );
      if (event.active) {
        next.turnActiveBySession[event.sessionId] = true;
        delete next.turnEndedPromptIdBySession[event.sessionId];
        // A new main turn supersedes the previous turn's terminal error and
        // any leftover retry state.
        delete next.turnErrorBySession[event.sessionId];
        delete next.turnRetryBySession[event.sessionId];
      } else {
        delete next.turnActiveBySession[event.sessionId];
        delete next.turnRetryBySession[event.sessionId];
        if (event.promptId !== undefined) {
          next.turnEndedPromptIdBySession[event.sessionId] = event.promptId;
        }
        // The main turn's end is one of the coarse recency moments.
        bumpSessionRecency(next, event.sessionId);
      }
      break;
    }

    case 'turnRetry': {
      // The main turn's current step entered/left the retry backoff. Fresh
      // events only: a replayed old phase frame must not resurrect an earlier
      // turn's retry progress nor clear the current one.
      if (!isFreshEvent(state, meta)) break;
      if (event.retry === undefined) {
        delete next.turnRetryBySession[event.sessionId];
      } else {
        next.turnRetryBySession[event.sessionId] = event.retry;
      }
      break;
    }

    case 'unknown': {
      // Distinguish no-op known events (sentinel _noop) from agent errors/warnings
      // and truly unknown events.
      const raw = event.raw as {
        _noop?: boolean;
        _agentError?: boolean;
        _agentWarning?: boolean;
        code?: string;
        message?: string;
        name?: string;
        details?: Record<string, unknown>;
        retryable?: boolean;
        type?: string;
      } | null;
      if (raw && raw._noop === true) {
        // No-op streaming/tool event — seq already advanced, nothing else to do
      } else if (raw && raw._agentError) {
        // Stale replays (reconnect / snapshot rebuild) re-deliver the same
        // terminal failure; it was surfaced when fresh, so skip both the
        // record and the toast — otherwise an old provider message could
        // overwrite a newer failure's details.
        if (isFreshEvent(state, meta)) {
          // Agent errors only ever mean "a main turn died" (the loop's terminal
          // failure is the single publisher). Record it per session so the
          // conversation can render a persistent failed-turn card.
          if (meta.sessionId !== undefined) {
            const details = raw.details ?? {};
            next.turnErrorBySession[meta.sessionId] = {
              code: raw.code,
              message: raw.message,
              name: raw.name,
              retryable: raw.retryable,
              statusCode: typeof details['statusCode'] === 'number' ? details['statusCode'] : undefined,
              requestId: typeof details['requestId'] === 'string' ? details['requestId'] : undefined,
            };
          }
          // The card covers the session the user is looking at, so the
          // transient toast is only worth showing for background sessions —
          // it is their only failure signal (sidebar marker aside).
          if (meta.sessionId === undefined || meta.sessionId !== state.activeSessionId) {
            // Surface the agent's real error (e.g. a 429 from the model provider)
            // as a structured notice: semantic title + raw provider message +
            // diagnostics (code / HTTP status / request id) for troubleshooting.
            next.warnings = [...next.warnings, buildAgentErrorNotice(raw, ctx.t)];
          }
        }
      } else if (raw && raw._agentWarning) {
        const msg = raw.message ?? raw.code ?? ctx.t('warnings.agentWarningFallback');
        next.warnings = [...next.warnings, `${ctx.t('warnings.noteLabel')}: ${msg}`];
      } else {
        // Truly unknown — push a warning
        const wireType = raw?.type ?? '(unknown)';
        next.warnings = [...next.warnings, ctx.t('warnings.unhandledEvent', { type: wireType })];
      }
      break;
    }

    // Workspace lifecycle events are handled in the composable (rawState), not
    // here — listed explicitly to keep the switch exhaustive.
    case 'workspaceCreated':
    case 'workspaceUpdated':
    case 'workspaceDeleted':
      break;

    default: {
      // TypeScript exhaustiveness guard — should not reach here
      const _exhaustive: never = event;
      void _exhaustive;
      break;
    }
  }

  return next;
}
