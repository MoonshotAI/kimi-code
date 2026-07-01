import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  collectCompactableUserMessages,
  isRealUserInput,
  selectRecentUserMessages,
} from '@moonshot-ai/agent-core';
import type {
  ContentPart,
  ContextMessage,
  PermissionMode,
  AgentConfigUpdateData,
  TokenUsage,
  ToolCall,
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
  /** Set only on the summary bubble of source === 'compaction_summary'. */
  compaction?: { compactedCount: number; tokensBefore: number; tokensAfter: number };
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
  /** Absolute current context-window fill, mirroring agent-core
   *  ContextMemory._tokenCount. Updated from the latest step.end.usage, and
   *  also reset on the lifecycle events agent-core touches: context.clear → 0,
   *  context.apply_compaction → tokensAfter. Distinct from the cumulative
   *  `usage` totals. */
  contextTokens: number;
  config: ConfigSnapshot;
  permission: { mode: PermissionMode | null };
  planMode: { active: boolean; id?: string };
  goal: GoalSnapshot | null;
  swarm: { active: boolean; trigger?: string };
}

const ZERO: TokenUsage = { inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0 };

/** Build a conversation timeline + derived state from a sequence of
 *  wire entries. The reconstruction mirrors agent-core's own
 *  `appendLoopEvent` logic, so:
 *
 *  - `context.append_message` records become messages as-is (the
 *    user / tool messages and any explicit assistant injections).
 *  - `step.begin` pushes a fresh assistant message; later
 *    `content.part` and `tool.call` events on the same step **mutate
 *    that same message** to grow its content / toolCalls. `step.end`
 *    just closes the step.
 *  - `tool.result` events emit an independent `role: 'tool'` message,
 *    matching how agent-core surfaces tool exchanges to the model.
 *
 *  Without this loop-event reconstruction the timeline would only
 *  show user prompts — agent-core does not emit a synthetic
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
  // Maps step.uuid → the assistant ProjectedMessage that step is filling in.
  // Cleared on context.clear / context.apply_compaction.
  let openSteps = new Map<string, ProjectedMessage>();

  for (const entry of entries) {
    const rec = entry.data;
    switch (rec.type) {
      case 'context.append_message':
        messages.push({
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'append_message',
          message: rec.message,
          toolStepUuids: [],
        });
        break;
      case 'context.append_loop_event': {
        const ev = rec.event;
        if (ev.type === 'step.begin') {
          const message: ContextMessage = {
            role: 'assistant',
            content: [],
            toolCalls: [],
          };
          const projected: ProjectedMessage = {
            lineNo: entry.lineNo,
            time: rec.time,
            source: 'append_message',
            message,
            toolStepUuids: [ev.uuid],
          };
          messages.push(projected);
          openSteps.set(ev.uuid, projected);
        } else if (ev.type === 'content.part') {
          const projected = openSteps.get(ev.stepUuid);
          if (projected !== undefined) {
            (projected.message.content as ContentPart[]).push(ev.part);
          }
        } else if (ev.type === 'tool.call') {
          const projected = openSteps.get(ev.stepUuid);
          if (projected !== undefined) {
            const args =
              typeof ev.args === 'string'
                ? ev.args
                : ev.args === undefined
                  ? null
                  : JSON.stringify(ev.args);
            (projected.message.toolCalls as ToolCall[]).push({
              type: 'function',
              id: ev.toolCallId,
              name: ev.name,
              arguments: args,
            });
          }
        } else if (ev.type === 'step.end') {
          // Absolute context-window fill, mirroring agent-core
          // ContextMemory._tokenCount: the latest step.end usage REPLACES the
          // snapshot (it is not cumulative — see Task P1.7 note on byScope).
          // A zero-usage step.end (e.g. a content-filtered response) is the one
          // exception agent-core makes — it keeps the prior count instead of
          // resetting to 0 — so guard against a false drop here too.
          if ('usage' in ev && ev.usage !== undefined) {
            const fill =
              ev.usage.inputCacheRead +
              ev.usage.inputCacheCreation +
              ev.usage.inputOther +
              ev.usage.output;
            if (fill > 0) contextTokens = fill;
          }
          openSteps.delete(ev.uuid);
        } else if (ev.type === 'tool.result') {
          // Mirror what the MODEL saw, not the raw output. agent-core's
          // ContextMemory.appendLoopEvent (`tool.result` case) stores
          // `createToolMessage(toolCallId, toolResultOutputForModel(result))`,
          // which normalizes error / empty outputs with sentinel strings. Using
          // `ev.result.output` directly would surface content the model never
          // received for failed / empty tool calls. See
          // `toolResultContentForModel` below.
          const content = toolResultContentForModel(ev.result);
          const toolMsg: ContextMessage = {
            role: 'tool',
            content,
            toolCalls: [],
            toolCallId: ev.toolCallId,
            ...(ev.result.isError === true ? { isError: true } : {}),
          };
          messages.push({
            lineNo: entry.lineNo,
            time: rec.time,
            source: 'append_message',
            message: toolMsg,
            toolStepUuids: [],
          });
        }
        break;
      }
      case 'context.clear':
        if (mode === 'model') {
          messages = [];
          openSteps = new Map();
          // Mirror agent-core clear() → microCompaction.reset() (cutoff → 0):
          // the message indices are wiped, so any prior cutoff is meaningless.
          microCutoff = 0;
        } else {
          // Full history: keep all preceding messages and openSteps as-is, just
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
        // Mirror agent-core clear() → _tokenCount = 0: the context-window fill is
        // wiped. Derived state, so it is mode-INDEPENDENT (applied for both modes).
        contextTokens = 0;
        break;
      case 'context.apply_compaction': {
        openSteps = new Map();
        // Mirror agent-core's `applyCompaction`
        // (`packages/agent-core/src/agent/context/index.ts`): the live history
        // becomes the most recent real user messages (verbatim, within a token
        // budget) followed by a single user-role summary tagged
        // `origin.kind = 'compaction_summary'`. Assistant messages, tool calls,
        // and tool results are dropped. The selection rule
        // (`selectRecentUserMessages` / `collectCompactableUserMessages`) is the
        // same helper agent-core's `ContextMemory` and the web transcript
        // reducer apply, so all three views stay in sync.
        const summaryBubble: ProjectedMessage = {
          lineNo: entry.lineNo,
          time: rec.time,
          source: 'compaction_summary',
          message: {
            role: 'user',
            content: [{ type: 'text', text: rec.summary }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          } as ContextMessage,
          toolStepUuids: [],
          compaction: {
            compactedCount: rec.compactedCount,
            tokensBefore: rec.tokensBefore,
            tokensAfter: rec.tokensAfter,
          },
        };
        const modelSummaryBubble: ProjectedMessage =
          rec.contextSummary === undefined
            ? summaryBubble
            : {
                ...summaryBubble,
                message: {
                  ...summaryBubble.message,
                  content: [{ type: 'text', text: rec.contextSummary }],
                } as ContextMessage,
              };
        if (mode === 'model') {
          // Rebuild the model's-eye view. New records carry `keptUserMessageCount`
          // and use the kept-user selection below; legacy records fall back to the
          // old verbatim-tail shape (handled first).
          const historyEntries = messages.filter(isHistoryEntry);
          if (rec.keptUserMessageCount === undefined && rec.compactedCount < historyEntries.length) {
            // Legacy (pre-rework) record: it has no `keptUserMessageCount`, so
            // agent-core's ContextMemory restore reproduces the old
            // `[summary, ...history.slice(compactedCount)]` semantics — a verbatim
            // recent tail (assistant/tool included), not the new kept-user
            // selection. Mirror that exact shape so opening an older compacted
            // session in model mode shows the same tail the resumed agent still
            // holds, instead of hiding it behind the new selection.
            messages = [modelSummaryBubble, ...historyEntries.slice(rec.compactedCount)];
          } else {
            // `realUserEntries` is filtered with the exact
            // `collectCompactableUserMessages` predicate so it stays aligned with
            // the selection below (genuine user input only — no injections, system
            // triggers, or prior summaries). `selectRecentUserMessages` keeps a
            // contiguous suffix of that subsequence, with only the oldest kept
            // message possibly truncated, so each kept message maps back onto its
            // original ProjectedMessage wrapper (preserving line/time); we swap in
            // the (possibly truncated) message object.
            const realUserEntries = historyEntries.filter(
              (pm) => collectCompactableUserMessages([pm.message]).length === 1,
            );
            const keptUserMessages = selectRecentUserMessages(
              realUserEntries.map((pm) => pm.message),
              COMPACT_USER_MESSAGE_MAX_TOKENS,
            );
            const suffixStart = realUserEntries.length - keptUserMessages.length;
            const keptEntries: ProjectedMessage[] = keptUserMessages.map((message, i) => {
              const original = realUserEntries[suffixStart + i]!;
              return original.message === message ? original : { ...original, message };
            });
            messages = [...keptEntries, modelSummaryBubble];
          }
        } else {
          // Full history: keep ALL preceding messages, just append the summary
          // marker inline so the compacted prefix stays visible.
          messages.push(summaryBubble);
        }
        // Mirror agent-core applyCompaction() → microCompaction.reset() (cutoff
        // → 0): the message list is rebuilt, so the old index-based cutoff no
        // longer points at the same messages. (In full mode the blanking pass
        // does not run, so this is a no-op there.)
        microCutoff = 0;
        // Mirror agent-core applyCompaction() → _tokenCount = result.tokensAfter:
        // the live context-window fill is now the post-compaction count. Derived
        // state, so it is mode-INDEPENDENT.
        contextTokens = rec.tokensAfter;
        break;
      }
      case 'usage.record': {
        // byScope keeps per-scope cumulative spend. This is NOT the live context-window
        // fill — that is `contextTokens` (latest step.end.usage). The web TokenBar shows
        // contextTokens; byScope/byModel are for the cumulative breakdown only.
        const scope = (rec.usageScope ?? 'session') as 'session' | 'turn';
        addUsage(usage.byScope[scope], rec.usage);
        if (!usage.byModel[rec.model]) usage.byModel[rec.model] = { ...ZERO };
        addUsage(usage.byModel[rec.model]!, rec.usage);
        break;
      }
      case 'config.update': {
        const upd = rec as AgentConfigUpdateData & { type: 'config.update' };
        if (upd.cwd !== undefined) config.cwd = upd.cwd;
        if (upd.modelAlias !== undefined) config.modelAlias = upd.modelAlias;
        if (upd.profileName !== undefined) config.profileName = upd.profileName;
        if (upd.thinkingEffort !== undefined) config.thinkingEffort = upd.thinkingEffort;
        if (upd.systemPrompt !== undefined) config.systemPrompt = upd.systemPrompt;
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
        // Mirror agent-core `undo` (`agent/context/index.ts`): walk from the
        // end, skip `origin.kind === 'injection'`, stop at
        // `origin.kind === 'compaction_summary'`, remove others, counting real
        // user prompts via `isRealUserInput` until `count` is reached. Then
        // leave an undo marker.
        //
        // `computeUndoCutoff` is the single source of truth for that skip/stop
        // walk (shared by both modes); only the actual removal is gated on
        // `'model'` mode.
        const { cutoff, removedMessageCount } = computeUndoCutoff(messages, rec.count);
        if (mode === 'model') {
          // Remove everything from `cutoff` onward EXCEPT injections, which the
          // walk skips (they survive even when inside the undo window). Using
          // the same `origin.kind === 'injection'` predicate keeps removal in
          // lockstep with the counting walk above.
          messages = messages.filter(
            (pm, i) => i < cutoff || pm.message.origin?.kind === 'injection',
          );
          openSteps = new Map();
          // Mirror agent-core undo() → microCompaction.reset(this._history.length):
          // clamp the cutoff to the post-undo HISTORY-entry count so a later append
          // does not get blanked by a now-too-large stale cutoff. Count only history
          // entries (`isHistoryEntry`) — `messages.length` would include any surviving
          // synthetic undo/clear marker, which agent-core's `_history.length` does
          // NOT, so an array-length clamp could be too high by the marker count.
          // (Clamp before pushing the undo marker, which is a non-tool pseudo-message
          // and unaffected by blanking regardless.) With no markers, historyCount ===
          // messages.length, so this is a no-op then.
          const historyCount = messages.reduce((n, pm) => (isHistoryEntry(pm) ? n + 1 : n), 0);
          microCutoff = Math.min(microCutoff, historyCount);
        }
        // In 'full' mode: do NOT remove — keep the undone messages and openSteps
        // as-is, only push the undo marker. `removedMessageCount` still reflects
        // what WOULD have been removed.
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
        // after the loop (mirrors agent-core MicroCompaction.compact, which
        // runs over the full history at projection time).
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
      // Kinds that don't affect the projected timeline / derived state:
      case 'metadata':
      case 'forked':
      case 'turn.prompt':
      case 'turn.steer':
      case 'turn.cancel':
      case 'permission.record_approval_result':
      case 'full_compaction.begin':
      case 'full_compaction.cancel':
      case 'full_compaction.complete':
      case 'tools.register_user_tool':
      case 'tools.unregister_user_tool':
      case 'tools.set_active_tools':
      case 'tools.update_store':
        break;
      default: {
        const _exhaustive: never = rec;
        void _exhaustive;
        break;
      }
    }
  }

  // Micro-compaction blanking (mirrors agent-core MicroCompaction.compact):
  // blank any message whose HISTORY index < cutoff that is a `role: 'tool'`
  // result with a defined toolCallId and content large enough (≥ the
  // min-content gate), replacing its content with the truncation marker. The
  // cutoff is an agent-core `_history` index, which never includes our synthetic
  // 'undo'/'clear' markers, so we count only history entries (`isHistoryEntry`)
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

// ── Tool-result normalization (mirror of agent-core) ─────────────────────────
// These replicate agent-core's `toolResultOutputForModel` so vis's model-view
// shows the EXACT content the model received for a tool result. The constants
// and branch conditions are copied verbatim from
// `packages/agent-core/src/agent/context/index.ts` (lines 18-22, 350-377). Keep
// them byte-identical with that source — if agent-core changes the sentinels or
// branch logic, update here too.
const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';

/** Mirrors agent-core `isEmptyOutputText`
 *  (`packages/agent-core/src/agent/context/index.ts` ~line 375). */
function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

/** Mirrors agent-core `toolResultOutputForModel`
 *  (`packages/agent-core/src/agent/context/index.ts` ~line 350), then wraps the
 *  result into `ContentPart[]` exactly as `createToolMessage` does (a string
 *  output → a single `{ type: 'text', text }` part). The model saw this
 *  normalized content in BOTH model and full views (agent-core normalizes at
 *  append time, before any of the destructive lifecycle events), so the
 *  tool.result branch uses this output mode-independently. */
function toolResultContentForModel(result: {
  output: string | ContentPart[];
  isError?: boolean;
}): ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    let normalized: string;
    if (result.isError === true) {
      if (output.length === 0) {
        normalized = TOOL_EMPTY_ERROR_STATUS;
      } else if (output.trimStart().startsWith('<system>ERROR:')) {
        normalized = output;
      } else {
        normalized = `${TOOL_ERROR_STATUS}\n${output}`;
      }
    } else {
      normalized = isEmptyOutputText(output) ? TOOL_EMPTY_STATUS : output;
    }
    // Match createToolMessage: a string output becomes a single text part.
    return [{ type: 'text', text: normalized }];
  }

  if (output.length === 0) {
    return [
      {
        type: 'text',
        text: result.isError === true ? TOOL_EMPTY_ERROR_STATUS : TOOL_EMPTY_STATUS,
      },
    ];
  }
  if (result.isError === true) {
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output];
  }
  return output;
}

const MICRO_TRUNCATED_MARKER = '[Old tool result content cleared]';
const MICRO_MIN_CONTENT_TOKENS = 100;

/** Replicates agent-core's per-char token weighting exactly, over the same
 *  `text` + `think` parts its gate counts. agent-core
 *  (`packages/agent-core/src/utils/tokens.ts`) sums per-part estimates, each
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

/** True for messages that correspond to a real agent-core `_history` entry —
 *  i.e. `append_message` and `compaction_summary` (the summary IS in `_history`).
 *  The synthetic UI-only markers (`undo` / `clear`) are NOT in `_history`, so
 *  index-based operations that mirror agent-core (compaction slice, micro-
 *  compaction cutoff) must skip them to stay aligned with agent-core indices. */
function isHistoryEntry(pm: ProjectedMessage): boolean {
  return pm.source !== 'undo' && pm.source !== 'clear';
}

/** Single source of truth for the `context.undo` backward walk, shared by both
 *  projection modes. Mirrors agent-core `undo` (`agent/context/index.ts`): walk
 *  from the end, skip `origin.kind === 'injection'` (those are KEPT even when
 *  they sit inside the undo window), stop at `origin.kind === 'compaction_summary'`,
 *  and count real user prompts via `isRealUserInput` until `count` is reached.
 *
 *  Returns the `cutoff` (lowest index to remove from, inclusive) plus the
 *  `removedMessageCount` (number of non-skipped messages in the window). In
 *  `'model'` mode the caller removes everything from `cutoff` onward EXCEPT
 *  injections; in `'full'` mode only `removedMessageCount` is reported on the
 *  undo marker (no removal). Defining the skip/stop predicate exactly once here
 *  keeps the two modes from drifting. */
function computeUndoCutoff(
  messages: readonly ProjectedMessage[],
  count: number,
): { cutoff: number; removedMessageCount: number } {
  let removedUserCount = 0;
  let removedMessageCount = 0;
  let cutoff = messages.length;
  for (let i = messages.length - 1; i >= 0; i--) {
    const origin = messages[i]?.message.origin;
    if (origin?.kind === 'injection') continue; // skip, keep
    if (origin?.kind === 'compaction_summary') break; // stop
    removedMessageCount++;
    cutoff = i;
    if (isRealUserInput(messages[i]!.message) && ++removedUserCount >= count) break;
  }
  return { cutoff, removedMessageCount };
}
