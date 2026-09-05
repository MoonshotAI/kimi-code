import {
  buildContextCompactionShape,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/compactionHandoff';
import {
  computeUndoCut,
  isFullyUndoable,
  readContextCompactionShapeInput,
} from '@moonshot-ai/agent-core-v2/agent/contextMemory/contextOps';
import { createLoopEventFold } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import { renderToolResultForModel } from '@moonshot-ai/agent-core-v2/agent/contextMemory/toolResultRender';
import type {
  ContentPart,
  ContextMessage,
  PermissionMode,
  TokenUsage,
  WireEntry,
} from './agent-record-types';

export interface ProjectedMessage {
  lineNo: number;
  time?: number;
  source: 'append_message' | 'compaction_summary' | 'undo' | 'clear';
  message: ContextMessage;
  toolStepUuids: string[];
  /** Set only when source === 'undo'. */
  undo?: { count: number; removedMessageCount: number };
  /** Set only on the summary bubble of source === 'compaction_summary'.
   *  `tokensBefore`/`tokensAfter` are absent on legacy payload variants. */
  compaction?: { compactedCount: number; tokensBefore?: number; tokensAfter?: number };
}

export interface UsageTotals {
  byScope: { session: TokenUsage; turn: TokenUsage };
  byModel: Record<string, TokenUsage>;
}

export interface ConfigSnapshot {
  cwd?: string;
  modelAlias?: string;
  profileName?: string;
  thinkingEffort?: string;
  systemPrompt?: string;
}

export interface GoalSnapshot {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status?: string;
  actor?: string;
  reason?: string;
  tokensUsed?: number;
  turnsUsed?: number;
  wallClockMs?: number;
}

export interface ContextProjection {
  messages: ProjectedMessage[];
  usage: UsageTotals;
  /** Absolute current context-window fill, mirroring the engine's token
   *  counting state. Updated from the latest step.end.usage and the
   *  token_counting.* records, and also reset on the lifecycle events the
   *  engine touches: context.clear → 0, context.apply_compaction →
   *  tokensAfter. Distinct from the cumulative `usage` totals. */
  contextTokens: number;
  config: ConfigSnapshot;
  permission: { mode: PermissionMode | null };
  planMode: { active: boolean; id?: string };
  goal: GoalSnapshot | null;
  swarm: { active: boolean; trigger?: string };
}

const ZERO: TokenUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

/** Build a conversation timeline + derived state from a sequence of
 *  wire entries. The reconstruction mirrors the engine's own loop-event
 *  fold logic, so:
 *
 *  - `context.append_message` records become messages as-is (the
 *    user / tool messages and any explicit assistant injections).
 *  - `step.begin` settles a preceding attempt and opens a fresh assistant;
 *    later `content.part` and `tool.call` events on the same step grow that
 *    message. A normal `step.end` seals it (or drops it when vacuous), while
 *    interrupted/error steps stay partial until the next attempt.
 *  - pending tool calls defer appended messages; matching `tool.result`
 *    events close them, and an attempt that settles first gets synthetic
 *    interrupted results, exactly like engine replay.
 *
 *  Without this loop-event reconstruction the timeline would only
 *  show user prompts — the engine does not emit a synthetic
 *  `context.append_message` for assistant turns.
 *
 *  `mode` selects between two views of the four destructive lifecycle
 *  events (compaction / undo / clear / micro-compaction):
 *
 *  - `'model'` (default): faithfully mirrors what the model currently
 *    sees — compaction drops the compacted prefix, undo splices removed
 *    messages out, clear empties the list, micro-compaction blanks old
 *    tool results. All existing behaviour.
 *  - `'full'`: full reconstructed history for debugging — the same four
 *    events insert an INLINE MARKER but do NOT mutate/drop the message
 *    list, so messages compacted/undone/cleared away stay visible and
 *    micro-compacted tool results keep their original content.
 *
 *  Everything else (append_message, loop events, goal/swarm/permission/
 *  plan/config/usage/contextTokens derived state) is identical in both
 *  modes — `mode` only affects the `messages` array and which markers
 *  appear. */
export function projectContext(
  entries: ReadonlyArray<WireEntry>,
  mode: 'model' | 'full' = 'model',
): ContextProjection {
  let messages: ProjectedMessage[] = [];
  let modelMessages: ProjectedMessage[] = [];
  const usage: UsageTotals = {
    byScope: { session: { ...ZERO }, turn: { ...ZERO } },
    byModel: {},
  };
  const config: ConfigSnapshot = {};
  let permissionMode: PermissionMode | null = null;
  let planActive = false;
  let planId: string | undefined;
  let contextTokens = 0;
  let goal: GoalSnapshot | null = null;
  let swarm: { active: boolean; trigger?: string } = { active: false };
  let microCutoff = 0;
  let currentEntry: WireEntry | undefined;
  let openMessage: ProjectedMessage | undefined;
  let syntheticToolOrdinal = 0;
  const appendMessageEntries = new WeakMap<ContextMessage, ProjectedMessage>();

  const pushModelMessage = (message: ProjectedMessage): void => {
    modelMessages.push(message);
    messages.push(message);
  };

  const removeModelMessage = (message: ProjectedMessage): void => {
    const modelIndex = modelMessages.indexOf(message);
    if (modelIndex !== -1) modelMessages.splice(modelIndex, 1);
    const displayIndex = messages.indexOf(message);
    if (displayIndex !== -1) messages.splice(displayIndex, 1);
  };

  const currentLineNo = (): number => currentEntry?.lineNo ?? 0;

  const fold = createLoopEventFold({
    openAssistant: (time) => {
      const event = currentEntry?.data;
      const stepUuid =
        event?.type === 'context.append_loop_event' && event.event.type === 'step.begin'
          ? event.event.uuid
          : undefined;
      openMessage = {
        lineNo: currentLineNo(),
        time,
        source: 'append_message',
        message: { role: 'assistant', content: [], toolCalls: [], partial: true },
        toolStepUuids: stepUuid === undefined ? [] : [stepUuid],
      };
      pushModelMessage(openMessage);
    },
    appendOpenContent: (part) => {
      if (openMessage === undefined) return;
      openMessage.message = {
        ...openMessage.message,
        content: [...openMessage.message.content, part],
      };
    },
    appendOpenToolCall: (call) => {
      if (openMessage === undefined) return;
      openMessage.message = {
        ...openMessage.message,
        toolCalls: [...openMessage.message.toolCalls, call],
      };
    },
    dropOpenAssistant: () => {
      if (openMessage === undefined) return;
      removeModelMessage(openMessage);
      openMessage = undefined;
    },
    sealOpenAssistant: () => {
      if (openMessage === undefined) return;
      openMessage.message = { ...openMessage.message, partial: undefined };
      openMessage = undefined;
    },
    pushToolMessage: (message, time) => {
      const event = currentEntry?.data;
      const directResult =
        event?.type === 'context.append_loop_event' && event.event.type === 'tool.result';
      const lineNo = directResult
        ? currentLineNo()
        : currentLineNo() - 0.25 - syntheticToolOrdinal++ / 1000;
      pushModelMessage({
        lineNo,
        time,
        source: 'append_message',
        message: modelFacingMessage(message),
        toolStepUuids: [],
      });
    },
    pushMessage: (message, time) => {
      const projected = appendMessageEntries.get(message) ?? {
        lineNo: currentLineNo(),
        time,
        source: 'append_message' as const,
        message,
        toolStepUuids: [],
      };
      projected.message = modelFacingMessage(message);
      pushModelMessage(projected);
    },
  });

  const resetFold = (): void => {
    fold.reset();
    openMessage = undefined;
  };

  for (const entry of entries) {
    currentEntry = entry;
    syntheticToolOrdinal = 0;
    const rec = entry.data;
    switch (rec.type) {
      case 'context.append_message': {
        const message = normalizeLegacyOrigin(rec.message);
        appendMessageEntries.set(message, {
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'append_message',
          message,
          toolStepUuids: [],
        });
        fold.appendMessage(message, rec.time);
        break;
      }
      case 'context.append_loop_event': {
        const ev = rec.event;
        fold.loopEvent(ev, rec.time);
        if (ev.type === 'step.end') {
          // Absolute context-window fill, mirroring the engine's token
          // counting state: the latest step.end usage REPLACES the
          // snapshot (it is not cumulative — see Task P1.7 note on byScope).
          // A zero-usage step.end (e.g. a content-filtered response) is the one
          // exception the engine makes — it keeps the prior count instead of
          // resetting to 0 — so guard against a false drop here too.
          if ('usage' in ev && ev.usage !== undefined) {
            const fill =
              ev.usage.inputCacheRead +
              ev.usage.inputCacheCreation +
              ev.usage.inputOther +
              ev.usage.output;
            if (fill > 0) contextTokens = fill;
          }
        }
        break;
      }
      case 'context.update_token_count':
        contextTokens = rec.tokenCount;
        break;
      case 'context.clear':
        resetFold();
        modelMessages = [];
        if (mode === 'model') {
          messages = [];
          // Mirror the engine's clear() → legacy micro-compaction cutoff
          // reset (→ 0):
          // the message indices are wiped, so any prior cutoff is meaningless.
          microCutoff = 0;
        } else {
          // Full history: keep all preceding messages, just
          // append a synthetic 'clear' marker inline. The original tool results
          // stay un-blanked, so the cutoff is not applied (the end-of-loop
          // blanking pass is gated on model mode).
          messages.push({
            lineNo: entry.lineNo,
            time: rec.time,
            source: 'clear',
            // Synthetic marker: never rendered as a bubble (the web dispatches on
            // `source === 'clear'`). `role: 'assistant'` keeps it out of any
            // role-counting / tool-blanking path.
            message: { role: 'assistant', content: [], toolCalls: [] } as ContextMessage,
            toolStepUuids: [],
          });
        }
        // Mirror the engine's clear() → token count = 0: the context-window
        // fill is wiped. Derived state, so it is mode-INDEPENDENT (applied for
        // both modes).
        contextTokens = 0;
        break;
      case 'context.apply_compaction': {
        let compactionInput: ReturnType<typeof readContextCompactionShapeInput>;
        try {
          compactionInput = readContextCompactionShapeInput(rec);
        } catch {
          break;
        }
        if (mode === 'full' && rec.keptUserMessageCount !== undefined) {
          fold.settle(rec.time);
        }
        const historyEntries = [...modelMessages];
        resetFold();
        // Mirror the engine's applyCompaction
        // (`packages/agent-core-v2/src/agent/contextMemory/`): the live history
        // becomes the kept real user messages (verbatim, within a token budget
        // — the oldest head plus the most recent tail, separated by an elision
        // marker when the pool overflowed) followed by a single user-role
        // summary tagged `origin.kind = 'compaction_summary'`. Assistant
        // messages, tool calls, and tool results are dropped. The selection
        // rules come from the same `buildContextCompactionShape` helper the
        // engine uses during replay, so both views stay in sync.
        //
        // The v2 payload is a union of three variants: current records carry
        // `summary` as a string (with `contextSummary` holding the
        // model-facing variant when media degraded); a legacy variant carries
        // the summary as a ContextMessage plus `count` instead of
        // `compactedCount`. `tokensBefore`/`tokensAfter` are optional in all
        // variants. Normalize before projecting.
        const rawSummary = rec.summary;
        const contextSummary = 'contextSummary' in rec ? rec.contextSummary : undefined;
        const summaryText =
          typeof rawSummary === 'string'
            ? rawSummary
            : rawSummary !== undefined
              ? contextMessageText(rawSummary)
              : (contextSummary ?? '');
        const shape = buildContextCompactionShape(
          historyEntries.map((message) => message.message),
          compactionInput,
        );
        const compactedCount = shape.compactedCount;
        const summaryBubble: ProjectedMessage = {
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'compaction_summary',
          message: {
            role: 'user',
            content: [{ type: 'text', text: summaryText }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          } as ContextMessage,
          toolStepUuids: [],
          compaction: {
            compactedCount,
            tokensBefore: rec.tokensBefore,
            tokensAfter: shape.tokensAfter,
          },
        };
        const legacyTail = rec.legacyTail === true || rec.keptUserMessageCount === undefined;
        const summaryIndex = legacyTail ? 0 : shape.messages.length - 1;
        const modelSummaryBubble: ProjectedMessage = {
          ...summaryBubble,
          message: modelFacingMessage(shape.messages[summaryIndex] ?? summaryBubble.message),
        };
        const available = new Set(historyEntries);
        let syntheticOrdinal = 0;
        modelMessages = shape.messages.map((message, index) => {
          if (index === summaryIndex) return modelSummaryBubble;
          const original = historyEntries.find(
            (candidate) => available.has(candidate) && candidate.message === message,
          );
          if (original !== undefined) {
            available.delete(original);
            return original;
          }
          syntheticOrdinal += 1;
          return {
            lineNo: entry.lineNo - 0.5 - syntheticOrdinal / 1000,
            time: rec.time,
            source: 'append_message',
            message: modelFacingMessage(message),
            toolStepUuids: [],
          };
        });
        if (mode === 'model') {
          messages = [...modelMessages];
        } else {
          // Full history: keep ALL preceding messages, just append the summary
          // marker inline so the compacted prefix stays visible.
          messages.push(summaryBubble);
        }
        // Mirror the engine's applyCompaction() → legacy micro-compaction
        // cutoff reset (→ 0): the message list is rebuilt, so the old
        // index-based cutoff no longer points at the same messages. (In full
        // mode the blanking pass does not run, so this is a no-op there.)
        microCutoff = 0;
        // `buildContextCompactionShape` also derives the post-compaction token
        // count for legacy records that omit `tokensAfter`.
        contextTokens = shape.tokensAfter;
        break;
      }
      case 'usage.record': {
        // byScope keeps per-scope cumulative spend. This is NOT the live context-window
        // fill — that is `contextTokens` (latest step.end.usage). The web TokenBar shows
        // contextTokens; byScope/byModel are for the cumulative breakdown only.
        const scope = (rec.usageScope ?? 'session') as 'session' | 'turn';
        addUsage(usage.byScope[scope], rec.usage);
        usage.byModel[rec.model] ??= { ...ZERO };
        addUsage(usage.byModel[rec.model]!, rec.usage);
        break;
      }
      case 'config.update': {
        // v2 dropped top-level `cwd` (it lives in `environmentDisclosure`)
        // and persists `thinkingLevel` on some records instead of
        // `thinkingEffort`; accept both spellings.
        if (rec.environmentDisclosure !== undefined)
          config.cwd = rec.environmentDisclosure.cwd;
        if (rec.modelAlias !== undefined) config.modelAlias = rec.modelAlias;
        if (rec.profileName !== undefined) config.profileName = rec.profileName;
        const effort = rec.thinkingEffort ?? rec.thinkingLevel;
        if (effort !== undefined) config.thinkingEffort = effort;
        if (rec.systemPrompt !== undefined) config.systemPrompt = rec.systemPrompt;
        break;
      }
      case 'profile.bind': {
        // v2 writes most initial config state on `profile.bind` rather than
        // `config.update` (which now carries only later updates).
        if (rec.environmentDisclosure !== undefined)
          config.cwd = rec.environmentDisclosure.cwd;
        if (rec.modelAlias !== undefined) config.modelAlias = rec.modelAlias;
        if (rec.profileName !== undefined) config.profileName = rec.profileName;
        config.thinkingEffort = rec.thinkingEffort;
        config.systemPrompt = rec.systemPrompt;
        break;
      }
      case 'permission.set_mode':
        permissionMode = rec.mode;
        break;
      case 'plan_mode.enter':
        planActive = true; planId = rec.id; break;
      case 'plan_mode.cancel':
      case 'plan_mode.exit':
        planActive = false; planId = undefined; break;
      case 'context.undo': {
        // Mirror the engine's `undo`: locate the requested user anchor while
        // skipping injections, stop at a compaction summary, include an
        // immediately preceding prompt-owned injection in the cut, then remove
        // the entire suffix from that cut. The UI adds a marker afterwards.
        //
        // `computeUndoCut` is the engine's single source of truth for that
        // skip/stop walk; only the visible removal is gated on `'model'` mode.
        const cut = computeUndoCut(
          modelMessages.map((message) => message.message),
          rec.count,
        );
        const applied = isFullyUndoable(cut, rec.count);
        const removedMessageCount = applied ? modelMessages.length - cut.cutIndex : 0;
        if (applied) {
          const firstRemoved = modelMessages[cut.cutIndex];
          modelMessages = modelMessages.slice(0, cut.cutIndex);
          resetFold();
          if (mode === 'model') {
            const displayCutoff = firstRemoved === undefined ? -1 : messages.indexOf(firstRemoved);
            messages = displayCutoff === -1 ? [...modelMessages] : messages.slice(0, displayCutoff);
          }
        }
        if (mode === 'model') {
          // Mirror the engine's undo() → legacy micro-compaction cutoff reset
          // (to the post-undo history length):
          // clamp the cutoff to the post-undo HISTORY-entry count so a later append
          // does not get blanked by a now-too-large stale cutoff. Count only history
          // entries (`isHistoryEntry`) — `messages.length` would include any surviving
          // synthetic undo/clear marker, which the engine's `_history.length` does
          // NOT, so an array-length clamp could be too high by the marker count.
          // (Clamp before pushing the undo marker, which is a non-tool pseudo-message
          // and unaffected by blanking regardless.) With no markers, historyCount ===
          // messages.length, so this is a no-op then.
          microCutoff = Math.min(microCutoff, modelMessages.length);
        }
        // In 'full' mode: do NOT remove the visible messages; only push the undo
        // marker. `modelMessages` still advances exactly like engine state so a
        // later undo/compaction is computed from the right live history.
        messages.push({
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'undo',
          // Synthetic message: never rendered. The web dispatches on
          // `source === 'undo'`; this only satisfies ProjectedMessage.
          // `role: 'assistant'` is deliberate so this marker can never match the
          // `role: 'tool'` micro-compaction blanking gate — keep it non-tool if
          // you ever change the placeholder.
          message: { role: 'assistant', content: [], toolCalls: [] } as ContextMessage,
          toolStepUuids: [],
          undo: { count: rec.count, removedMessageCount },
        });
        break;
      }
      case 'micro_compaction.apply':
        // Track the latest cutoff; the actual content blanking is applied
        // after the loop (mirrors the engine's legacy MicroCompaction.compact,
        // which runs over the full history at projection time).
        microCutoff = rec.cutoff;
        break;
      case 'goal.create':
        goal = {
          goalId: rec.goalId,
          objective: rec.objective,
          completionCriterion: rec.completionCriterion,
        };
        break;
      case 'goal.update':
        if (goal !== null) {
          const prev: GoalSnapshot = goal;
          goal = {
            ...prev,
            status: rec.status ?? prev.status,
            actor: rec.actor ?? prev.actor,
            reason: rec.reason ?? prev.reason,
            tokensUsed: rec.tokensUsed ?? prev.tokensUsed,
            turnsUsed: rec.turnsUsed ?? prev.turnsUsed,
            wallClockMs: rec.wallClockMs ?? prev.wallClockMs,
          };
        }
        break;
      case 'goal.clear':
        goal = null;
        break;
      case 'swarm_mode.enter':
        swarm = { active: true, trigger: rec.trigger };
        break;
      case 'swarm_mode.exit':
        swarm = { active: false };
        break;
      case 'tower_mode.enter':
      case 'tower_mode.exit':
        break;
      case 'token_counting.measured':
      case 'token_counting.truncated':
      case 'token_counting.rebased':
      case 'token_counting.turn_recorded':
        // v2's replacement for `context.update_token_count`: every
        // token_counting record carries the agent's current context-window
        // fill (`tokens`) — the tokenCounting model sets its running count
        // from each of them, and so do we.
        contextTokens = rec.tokens;
        break;
      // Kinds that don't affect the projected timeline / derived state,
      // including the observability records (request trace — `llm.*`,
      // `mcp.tools_discovered`) and v2's lifecycle/task bookkeeping, which
      // are never part of context state:
      case 'metadata':
      case 'forked':
      case 'turn.prompt':
      case 'turn.steer':
      case 'turn.cancel':
      case 'turn.ended':
      case 'turn.step.interrupted':
      case 'turn.step.retrying':
      case 'prompt.accepted':
      case 'prompt.aborted':
      case 'prompt.completed':
      case 'prompt.steered':
      case 'interaction.request':
      case 'interaction.resolved':
      case 'task.started':
      case 'task.terminated':
      case 'task.waitDelivered':
      case 'cron.add':
      case 'cron.cursor':
      case 'cron.delete':
      case 'plan.revision':
      case 'plugin.session_start':
      case 'runtime.set_binding':
      case 'staleGuard.recorded':
      case 'staleGuard.cleared':
      case 'interruptionReminder.recorded':
      case 'permission.record_approval_result':
      case 'full_compaction.begin':
      case 'full_compaction.cancel':
      case 'full_compaction.complete':
      case 'tools.register_user_tool':
      case 'tools.unregister_user_tool':
      case 'tools.set_active_tools':
      case 'tools.update_store':
      case 'tools.reset_active_tools':
      case 'llm.tools_snapshot':
      case 'llm.request':
      case 'mcp.tools_discovered':
      case 'file_history.checkpoint':
      case 'file_history.tracked':
        break;
      default: {
        const _exhaustive: never = rec;
        void _exhaustive;
        break;
      }
    }
  }

  // Micro-compaction blanking (mirrors the engine's legacy
  // MicroCompaction.compact): blank any message whose HISTORY index < cutoff
  // that is a `role: 'tool'` result with a defined toolCallId and content
  // large enough (≥ the min-content gate), replacing its content with the
  // truncation marker. The cutoff is an engine `_history` index, which never
  // includes our synthetic 'undo'/'clear' markers, so we count only history
  // entries (`isHistoryEntry`)
  // — array indices would be offset by any preceding marker. This rewrite is the
  // model's-eye view, so it runs ONLY in 'model' mode — in 'full' mode the
  // original tool results are shown un-blanked.
  if (mode === 'model' && microCutoff > 0) {
    let historyIndex = 0;
    for (const pm of messages) {
      if (!isHistoryEntry(pm)) continue;
      if (historyIndex >= microCutoff) break;
      historyIndex++;
      const m = pm.message;
      if (
        m.role === 'tool' &&
        m.toolCallId !== undefined &&
        estimateContentTokens(m.content) >= MICRO_MIN_CONTENT_TOKENS
      ) {
        pm.message = { ...m, content: [{ type: 'text', text: MICRO_TRUNCATED_MARKER }] };
      }
    }
  }

  return {
    messages,
    usage,
    contextTokens,
    config,
    permission: { mode: permissionMode },
    planMode: { active: planActive, id: planId },
    goal,
    swarm,
  };
}

function addUsage(into: TokenUsage, src: TokenUsage): void {
  (into as any).inputOther += src.inputOther;
  (into as any).output += src.output;
  (into as any).inputCacheRead += src.inputCacheRead;
  (into as any).inputCacheCreation += src.inputCacheCreation;
}

const MICRO_TRUNCATED_MARKER = '[Old tool result content cleared]';
const MICRO_MIN_CONTENT_TOKENS = 100;

/** Replicates the engine's per-char token weighting exactly, over the same
 *  `text` + `think` parts its gate counts. The engine
 *  (`packages/agent-core-v2/src/kosong/contract/tokens.ts`) sums per-part
 *  estimates, each
 *  `estimateTokens(s) = Math.ceil(asciiCount / 4) + nonAsciiCount` (ASCII ~4
 *  chars/token, every non-ASCII/CJK code point a full token); other part types
 *  contribute 0. Matching it ensures Chinese-heavy tool results blank at the
 *  same gate as the agent. */
function estimateTokens(text: string): number {
  let asciiCount = 0;
  let nonAsciiCount = 0;
  for (const char of text) {
    if (char.codePointAt(0)! <= 127) {
      asciiCount++;
    } else {
      nonAsciiCount++;
    }
  }
  return Math.ceil(asciiCount / 4) + nonAsciiCount;
}

function estimateContentTokens(content: readonly ContentPart[]): number {
  let total = 0;
  for (const p of content) {
    if (p.type === 'text') total += estimateTokens(p.text);
    else if (p.type === 'think') total += estimateTokens(p.think);
  }
  return total;
}

/** True for messages that correspond to a real `_history` entry —
 *  i.e. `append_message` and `compaction_summary` (the summary IS in `_history`).
 *  The synthetic UI-only markers (`undo` / `clear`) are NOT in `_history`, so
 *  index-based operations that mirror the engine (compaction slice, micro-
 *  compaction cutoff) must skip them to stay aligned with engine indices. */
function isHistoryEntry(pm: ProjectedMessage): boolean {
  return pm.source !== 'undo' && pm.source !== 'clear';
}

function modelFacingMessage(message: ContextMessage): ContextMessage {
  if (message.role !== 'tool') return message;
  return {
    ...message,
    content: renderToolResultForModel({
      output: message.content,
      isError: message.isError,
      note: message.note,
    }),
    note: undefined,
  };
}

/** v1 wires tag background-task prompts `origin.kind === 'background_task'`;
 *  v2 renamed the kind to 'task' (same status literals). Normalize on ingest
 *  so the engine's undo helper and the web see one vocabulary. */
function normalizeLegacyOrigin(message: ContextMessage): ContextMessage {
  const origin = message.origin as { readonly kind: string } | undefined;
  if (origin?.kind !== 'background_task') return message;
  return { ...message, origin: { ...origin, kind: 'task' } as ContextMessage['origin'] };
}

/** Text rendering of a ContextMessage's content parts, used to surface the
 *  legacy `context.apply_compaction` variant whose summary is a message. */
function contextMessageText(message: ContextMessage): string {
  return message.content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('\n');
}
