// apps/kimi-web/src/api/daemon/eventReducer.ts
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
  AppWarning,
  AppQuestionRequest,
  AppSession,
  AppTask,
  CompactionMarkerMetadata,
} from '../types';
import { COMPACTION_MARKER_METADATA_KEY } from '../types';
import { i18n } from '../../i18n';

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

function sameMessageContent(a: AppMessage, b: AppMessage): boolean {
  return JSON.stringify(a.content) === JSON.stringify(b.content);
}

/** Concatenated text + count of image/file parts — a serialization-independent
    shape of a user message. The daemon's echo carries images as a resolved
    URL/base64 while our optimistic copy carries `{kind:'file',fileId}`, so the
    raw content never matches; comparing (text, image-count) does. */
// Matches the self-contained media path tag the server substitutes for an
// uploaded image/video/audio in a prompt (e.g. `<video path="/cache/f.mp4"></video>`).
// A tag is its own text part, so anchoring keeps ordinary prose from matching.
const MEDIA_PATH_TAG_SHAPE_RE = /^<(image|video|audio)\s+path="[^"]+"><\/\1>$/;

function userMessageShape(m: AppMessage): { text: string; media: number } {
  let text = '';
  let media = 0;
  for (const c of m.content) {
    if (c.type === 'text') {
      // A video/image upload reaches us (after the server resolves it) as a
      // `<video path=…></video>` text tag, not a media part — count it as media
      // and drop it from the text so the echo reconciles with our optimistic copy.
      if (MEDIA_PATH_TAG_SHAPE_RE.test(c.text.trim())) media += 1;
      else text += c.text;
    } else if (c.type === 'image' || c.type === 'video' || c.type === 'file') media += 1;
  }
  return { text, media };
}

function sameUserMessageLoosely(a: AppMessage, b: AppMessage): boolean {
  const sa = userMessageShape(a);
  const sb = userMessageShape(b);
  return sa.text === sb.text && sa.media === sb.media;
}

function findOptimisticUserEchoIndex(messages: AppMessage[], message: AppMessage): number {
  // Prefer matching by prompt_id: image content serializes differently between
  // our optimistic copy ({source:{kind:'file',fileId}}) and the daemon's echo
  // (a resolved URL/base64), so content-equality alone lets an image steer's
  // echo slip through as a duplicate. The submit response's prompt_id is stamped
  // onto the optimistic message, so a shared prompt_id is the reliable match.
  const promptId = message.promptId;
  if (promptId !== undefined) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const candidate = messages[i]!;
      if (isOptimisticUserMessage(candidate) && candidate.promptId === promptId) {
        return i;
      }
    }
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i]!;
    if (isOptimisticUserMessage(candidate) && sameMessageContent(candidate, message)) {
      return i;
    }
  }
  // Loose fallback for image steers: the daemon's messageCreated echo can arrive
  // over the WS *before* submitPrompt resolves and stamps the prompt_id onto the
  // optimistic copy, so neither the prompt_id nor the exact-content match fires —
  // and because the image serializes differently, the echo used to slip through
  // as a SECOND user bubble. Match on (text, image-count) instead so the echo
  // still reconciles into the optimistic message.
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i]!;
    if (isOptimisticUserMessage(candidate) && sameUserMessageLoosely(candidate, message)) {
      return i;
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
      if (next.activeSessionId === id) {
        next.activeSessionId = undefined;
      }
      break;
    }

    // -------------------------------------------------------------------------
    case 'sessionStatusChanged': {
      next.sessions = next.sessions.map((s) => {
        if (s.id !== event.sessionId) return s;
        return {
          ...s,
          status: event.status,
          currentPromptId: event.currentPromptId,
        };
      });
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
      // A new message is activity on the session: bump its recency so it floats
      // to the top of its workspace group in the sidebar immediately. The daemon
      // does not always broadcast a fresh `session.updated` for message activity,
      // so we rely on the message's own timestamp (and never move it backwards).
      const createdAt = event.message.createdAt;
      next.sessions = next.sessions.map((s) =>
        s.id === sid && createdAt > s.updatedAt ? { ...s, updatedAt: createdAt } : s,
      );
      const msgs = next.messagesBySession[sid] ?? [];
      const exists = msgs.some((m) => m.id === event.message.id);
      if (!exists) {
        // Cron-injected user messages (origin cron_job/cron_missed) carry the
        // reminder's prompt as their text, which can coincide with a still-
        // optimistic user message. They must append as their own turn rather
        // than reconcile into (and replace) that optimistic echo — so skip the
        // echo lookup entirely for them.
        if (event.message.role === 'user' && !isCronOriginMessage(event.message)) {
          const optimisticIndex = findOptimisticUserEchoIndex(msgs, event.message);
          if (optimisticIndex !== -1) {
            const updated = [...msgs];
            const optimistic = updated[optimisticIndex]!;
            updated[optimisticIndex] = {
              ...event.message,
              id: optimistic.id,
              promptId: event.message.promptId ?? optimistic.promptId,
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
        return {
          ...m,
          content: event.content,
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
        // Ensure the slot exists
        while (content.length <= idx) {
          content.push({ type: 'text', text: '' });
        }
        const existing = content[idx]!;
        let patched: AppMessageContent;
        if (event.delta.text !== undefined) {
          if (existing.type === 'text') {
            patched = { type: 'text', text: existing.text + event.delta.text };
          } else {
            patched = { type: 'text', text: event.delta.text };
          }
        } else if (event.delta.thinking !== undefined) {
          if (existing.type === 'thinking') {
            patched = {
              type: 'thinking',
              thinking: existing.thinking + event.delta.thinking,
              signature: existing.signature,
            };
          } else {
            patched = { type: 'thinking', thinking: event.delta.thinking };
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

    case 'unknown': {
      // Distinguish no-op known events (sentinel _noop) from agent errors/warnings
      // and truly unknown events.
      const raw = event.raw as {
        _noop?: boolean;
        _agentError?: boolean;
        _agentWarning?: boolean;
        code?: string;
        message?: string;
        type?: string;
      } | null;
      if (raw && raw._noop === true) {
        // No-op streaming/tool event — seq already advanced, nothing else to do
      } else if (raw && (raw._agentError || raw._agentWarning)) {
        // Surface the agent's real error/warning message (e.g. a 403 from the
        // model provider) instead of a useless "Unhandled event".
        const label = raw._agentError
          ? i18n.global.t('warnings.errorLabel')
          : i18n.global.t('warnings.noteLabel');
        const msg = raw.message ?? raw.code ?? 'agent error';
        next.warnings = [...next.warnings, `${label}: ${msg}`];
      } else {
        // Truly unknown — push a warning
        const wireType = raw?.type ?? '(unknown)';
        next.warnings = [...next.warnings, `Unhandled event: ${wireType}`];
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
