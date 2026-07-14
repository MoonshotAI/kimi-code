/**
 * TUI transcript model (`#/core/transcript`) — folds an agent's wire records
 * into RENDERING transcript entries.
 *
 * Why this exists, and why it is not `ContextMessage`:
 * the context history is the model-facing view — `context.apply_compaction`
 * rewrites it into `[...keptUserMessages, summary]`, tool results are shaped
 * for the LLM, and injections/reminders come and go. The UI needs the opposite
 * projection: the full history, compaction cards with token counts, and display
 * content. The wire log keeps every record, so this module re-reduces the
 * records into a dedicated `TranscriptEntry` stream. `TranscriptMessage`
 * deliberately mirrors but does NOT alias `ContextMessage`: the two must not
 * be assignable to each other, so a transcript can never be fed to the model
 * by accident (and vice versa).
 *
 * Form: the reducer set is declared through v2's public `defineDerivedModel`
 * (the same shape a wire-attached derived model would use), but the TUI folds
 * it manually over `IAgentWireRecordService.getRecords()` — resume's
 * `wire.replay` runs inside v2 before the facade sees the session, so a
 * facade-side `wire.attach` would always miss the restore fold. Replay is
 * read exactly once per resume, so a one-shot reduce loses nothing.
 *
 * Record → entry mapping (op types not exported by the v2 barrel are keyed by
 * their literal wire names; payloads are declared locally):
 *   context.append_message      → message entry (deferred while a tool exchange is open)
 *   context.append_loop_event   → folds into assistant / tool entries
 *   context.apply_compaction    → compaction card entry (full history kept;
 *                                 carries summary + token counts from the record)
 *   context.undo / context.clear → truncate tail / floor (mirrors contextTranscript)
 *   goal.create / goal.update   → goal_updated (clear/forked: no entry, no card UI)
 *   plan_mode.enter / exit / cancel → plan_updated
 *   permission.set_mode         → permission_updated
 *   permission.record_approval_result → approval_result
 *   config.update               → config_updated
 *   turn.prompt, full_compaction.* → no entries (turn counter op; compaction
 *                                 cards come only from context.apply_compaction
 *                                 to avoid double-rendering)
 *
 * Mirrors v2's `reduceContextTranscript`
 * (`agent-core-v2/src/agent/contextMemory/contextTranscript.ts`) semantics for
 * the context ops; diverges only where the transcript is not the context:
 * compaction keeps the full history, and the undo boundary is the compaction
 * CARD entry (the summary message never becomes an entry here).
 */

import {
  COMPACTION_SUMMARY_PREFIX,
  contextAppendLoopEvent,
  contextAppendMessage,
  contextApplyCompaction,
  contextClear,
  contextUndo,
  defineDerivedModel,
  isRealUserInput,
  planModeCancel,
  planModeEnter,
  planModeExit,
  readContextCompactionSummary,
  type ContentPart,
  type ContextMessage,
  type GoalBudgetLimits,
  type GoalChange,
  type GoalSnapshot,
  type GoalStatus,
  type LoopRecordedEvent,
  type PermissionApprovalResultRecord,
  type PermissionMode,
  type PromptOrigin,
  type ToolCall,
} from '@moonshot-ai/agent-core-v2';

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

/**
 * Display-side message. Field set intentionally mirrors `ContextMessage`
 * minus the model-facing machinery; the distinct type name is the isolation
 * boundary that keeps transcripts out of LLM input. `role: 'system'` is kept
 * (not folded into 'user') so the renderer can skip it like the live path.
 */
export interface TranscriptMessage {
  readonly role: 'user' | 'assistant' | 'tool' | 'system';
  readonly content: readonly ContentPart[];
  readonly toolCalls: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly origin?: PromptOrigin;
}

export interface TranscriptCompactionEntry {
  readonly type: 'compaction';
  readonly summary: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly compactedCount?: number;
}

export interface TranscriptGoalEntry {
  readonly type: 'goal_updated';
  readonly snapshot: GoalSnapshot;
  readonly change: GoalChange | { readonly kind: 'created' };
}

/** `config.update` wire payload (v2 `ConfigUpdatePayload`; not barrel-exported). */
export interface ConfigUpdateWirePayload {
  readonly cwd?: string;
  readonly modelAlias?: string;
  readonly profileName?: string;
  readonly thinkingEffort?: string;
  readonly systemPrompt?: string;
}

/**
 * Persistent goal fields the fold tracks (v2 `GoalState`; not barrel-exported).
 * Budget remaining/reached fields are derived live by the goal service, so the
 * replay snapshot approximates them — see {@link snapshotFromGoalStateLike}.
 */
interface GoalStateLike {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
  readonly status: GoalStatus;
  readonly turnsUsed: number;
  readonly tokensUsed: number;
  readonly wallClockMs: number;
  readonly budgetLimits: GoalBudgetLimits;
  readonly terminalReason?: string;
}

export type TranscriptEntry =
  | { readonly type: 'message'; readonly message: TranscriptMessage }
  | TranscriptCompactionEntry
  | TranscriptGoalEntry
  | { readonly type: 'plan_updated'; readonly enabled: boolean }
  | { readonly type: 'config_updated'; readonly config: ConfigUpdateWirePayload }
  | { readonly type: 'permission_updated'; readonly mode: PermissionMode }
  | { readonly type: 'approval_result'; readonly record: PermissionApprovalResultRecord };

interface MutableMessage {
  role: TranscriptMessage['role'];
  content: ContentPart[];
  toolCalls: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  origin?: PromptOrigin;
}

/**
 * Fold working set. Must live inside the state (not a closure): the same
 * reducers serve a live fold and a silent replay fold, and closure state
 * would be corrupted by replay. Internal — not part of the public contract.
 */
interface TranscriptWorking {
  readonly openSteps: ReadonlyMap<string, MutableMessage>;
  readonly pendingToolResultIds: ReadonlySet<string>;
  readonly deferred: readonly MutableMessage[];
  readonly clearFloor: number;
  readonly goal: GoalStateLike | null;
}

export interface TranscriptModelState {
  readonly entries: readonly TranscriptEntry[];
  /** @internal fold working set; consumers must not read this. */
  readonly working: TranscriptWorking;
}

const INITIAL_WORKING: TranscriptWorking = {
  openSteps: new Map(),
  pendingToolResultIds: new Set(),
  deferred: [],
  clearFloor: 0,
  goal: null,
};

/** Blob loader subset of `IAgentBlobService` used by {@link rehydrateTranscript}. */
export interface TranscriptBlobLoader {
  loadParts(parts: readonly ContentPart[]): Promise<readonly ContentPart[]>;
}

// -- payload shapes for ops the v2 barrel does not export ------------------

interface GoalCreateWirePayload {
  readonly goalId: string;
  readonly objective: string;
  readonly completionCriterion?: string;
}

interface GoalUpdateWirePayload {
  readonly status?: GoalStatus;
  readonly reason?: string;
  readonly turnsUsed?: number;
  readonly tokensUsed?: number;
  readonly wallClockMs?: number;
  readonly budgetLimits?: GoalStateLike['budgetLimits'];
  readonly actor?: GoalChange['actor'];
}

/** Minimal ContextMessage shape the fold consumes (wire payload side). */
interface ContextMessageLike {
  readonly role: TranscriptMessage['role'];
  readonly content: readonly ContentPart[];
  readonly toolCalls: readonly ToolCall[];
  readonly toolCallId?: string;
  readonly isError?: boolean;
  readonly origin?: PromptOrigin;
}

// -- fold implementation ----------------------------------------------------

function toMutableMessage(message: ContextMessageLike): MutableMessage {
  return {
    role: message.role,
    content: [...message.content],
    toolCalls: [...message.toolCalls],
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.isError !== undefined ? { isError: message.isError } : {}),
    ...(message.origin !== undefined ? { origin: message.origin } : {}),
  };
}

function pushMessageEntry(
  entries: readonly TranscriptEntry[],
  message: MutableMessage,
): readonly TranscriptEntry[] {
  return [...entries, { type: 'message', message: { ...message } }];
}

function flushDeferred(working: TranscriptWorking): {
  entries: readonly TranscriptEntry[];
  working: TranscriptWorking;
} {
  if (working.pendingToolResultIds.size > 0 || working.deferred.length === 0) {
    return { entries: [], working };
  }
  return {
    entries: working.deferred.map((message) => ({ type: 'message' as const, message: { ...message } })),
    working: { ...working, deferred: [] },
  };
}

function closeInterruptedTools(
  entries: readonly TranscriptEntry[],
  working: TranscriptWorking,
): { entries: readonly TranscriptEntry[]; working: TranscriptWorking } {
  if (working.pendingToolResultIds.size === 0) {
    return { entries, working };
  }
  let out = entries;
  for (const toolCallId of working.pendingToolResultIds) {
    out = pushMessageEntry(out, {
      role: 'tool',
      content: [{ type: 'text', text: TOOL_INTERRUPTED_ON_RESUME_OUTPUT }],
      toolCalls: [],
      toolCallId,
      isError: true,
    });
  }
  const flushed = flushDeferred({ ...working, pendingToolResultIds: new Set() });
  return { entries: [...out, ...flushed.entries], working: flushed.working };
}

function applyLoopEvent(
  state: TranscriptModelState,
  event: LoopRecordedEvent,
): TranscriptModelState {
  const { entries, working } = state;
  switch (event.type) {
    case 'step.begin': {
      const closed = closeInterruptedTools(entries, working);
      const step: MutableMessage = { role: 'assistant', content: [], toolCalls: [] };
      return {
        entries: pushMessageEntry(closed.entries, step),
        working: {
          ...closed.working,
          openSteps: new Map([...closed.working.openSteps, [event.uuid, step]]),
        },
      };
    }
    case 'step.end': {
      const openSteps = new Map(working.openSteps);
      openSteps.delete(event.uuid);
      const flushed = flushDeferred({ ...working, openSteps });
      return { entries: [...entries, ...flushed.entries], working: flushed.working };
    }
    case 'content.part': {
      const step = working.openSteps.get(event.stepUuid);
      if (step === undefined) return state;
      // Lenient where the live reducer throws: a dangling part in a damaged
      // file should not take the whole transcript down.
      step.content.push(event.part as ContentPart);
      return state;
    }
    case 'tool.call': {
      const step = working.openSteps.get(event.stepUuid);
      if (step === undefined) return state;
      const call: ToolCall = {
        type: 'function',
        id: event.toolCallId,
        name: event.name,
        arguments: event.args === undefined ? null : JSON.stringify(event.args),
        ...(event.extras !== undefined ? { extras: event.extras } : {}),
      };
      step.toolCalls.push(call);
      return {
        entries,
        working: {
          ...working,
          pendingToolResultIds: new Set([...working.pendingToolResultIds, event.toolCallId]),
        },
      };
    }
    case 'tool.result': {
      if (!working.pendingToolResultIds.has(event.toolCallId)) return state;
      const pendingToolResultIds = new Set(working.pendingToolResultIds);
      pendingToolResultIds.delete(event.toolCallId);
      const appended = pushMessageEntry(entries, {
        role: 'tool',
        content: rawToolResultContent(event.result.output),
        toolCalls: [],
        toolCallId: event.toolCallId,
        isError: event.result.isError,
      });
      const flushed = flushDeferred({ ...working, pendingToolResultIds });
      return { entries: [...appended, ...flushed.entries], working: flushed.working };
    }
  }
}

function applyAppendMessage(
  state: TranscriptModelState,
  message: MutableMessage,
): TranscriptModelState {
  const { entries, working } = state;
  if (working.pendingToolResultIds.size > 0) {
    return { entries, working: { ...working, deferred: [...working.deferred, message] } };
  }
  return { entries: pushMessageEntry(entries, message), working };
}

function applyTranscriptUndo(state: TranscriptModelState, count: number): TranscriptModelState {
  if (count <= 0) return state;
  let removedUserCount = 0;
  const entries = [...state.entries];
  for (let i = entries.length - 1; i >= state.working.clearFloor; i--) {
    const entry = entries[i]!;
    // The undo boundary is the compaction card: the summary never becomes a
    // message entry here, so the card itself marks where the folded past begins.
    if (entry.type === 'compaction') break;
    // Non-message entries (goal/plan/permission/...) survive an undo, exactly
    // like v1's replayBuilder.removeLastMessages only drops message records.
    if (entry.type !== 'message') continue;
    const { message } = entry;
    if (message.origin?.kind === 'injection') continue;
    entries.splice(i, 1);
    if (isRealUserInput(toContextMessageView(message))) {
      removedUserCount++;
      if (removedUserCount >= count) break;
    }
  }
  return {
    entries,
    working: { ...state.working, openSteps: new Map(), pendingToolResultIds: new Set(), deferred: [] },
  };
}

function applyTranscriptClear(state: TranscriptModelState): TranscriptModelState {
  // Keep prior transcript entries but reset the fold floor, exactly like the
  // contextTranscript clear semantics.
  return {
    entries: state.entries,
    working: { ...state.working, clearFloor: state.entries.length, openSteps: new Map(), pendingToolResultIds: new Set(), deferred: [] },
  };
}

function applyCompactionEntry(
  state: TranscriptModelState,
  payload: unknown,
): TranscriptModelState {
  const record = payload as Record<string, unknown>;
  // Every record shape funnels through the prefixed injection text (either
  // `contextSummary` directly, or `summary` / a legacy summary message which
  // also carries the prefix), so strip the marker back off for display.
  const summary = stripSummaryPrefix(textOfParts(readContextCompactionSummary(record).content));
  const entry: TranscriptCompactionEntry = {
    type: 'compaction',
    summary,
    tokensBefore: readNumber(record, 'tokensBefore'),
    tokensAfter: readNumber(record, 'tokensAfter'),
    compactedCount: readNumber(record, 'compactedCount'),
  };
  return {
    entries: [...state.entries, entry],
    working: { ...state.working, openSteps: new Map(), pendingToolResultIds: new Set(), deferred: [] },
  };
}

function applyGoalCreate(
  state: TranscriptModelState,
  payload: GoalCreateWirePayload,
): TranscriptModelState {
  const goal: GoalStateLike = {
    goalId: payload.goalId,
    objective: payload.objective,
    completionCriterion: payload.completionCriterion,
    status: 'active',
    turnsUsed: 0,
    tokensUsed: 0,
    wallClockMs: 0,
    budgetLimits: {},
  };
  const entry: TranscriptGoalEntry = {
    type: 'goal_updated',
    snapshot: snapshotFromGoalStateLike(goal),
    change: { kind: 'created' },
  };
  return { entries: [...state.entries, entry], working: { ...state.working, goal } };
}

function applyGoalUpdate(
  state: TranscriptModelState,
  payload: GoalUpdateWirePayload,
): TranscriptModelState {
  const current = state.working.goal;
  if (current === null) return state;
  let next: GoalStateLike = current;
  if (payload.status !== undefined && payload.status !== current.status) {
    next = {
      ...next,
      status: payload.status,
      terminalReason: payload.status === 'active' ? undefined : payload.reason,
    };
  }
  if (payload.turnsUsed !== undefined) next = { ...next, turnsUsed: payload.turnsUsed };
  if (payload.tokensUsed !== undefined) next = { ...next, tokensUsed: payload.tokensUsed };
  if (payload.wallClockMs !== undefined) next = { ...next, wallClockMs: payload.wallClockMs };
  if (payload.budgetLimits !== undefined) next = { ...next, budgetLimits: payload.budgetLimits };

  const stats =
    payload.turnsUsed !== undefined && payload.tokensUsed !== undefined && payload.wallClockMs !== undefined
      ? { turnsUsed: payload.turnsUsed, tokensUsed: payload.tokensUsed, wallClockMs: payload.wallClockMs }
      : undefined;
  const change: GoalChange =
    next.status === 'complete'
      ? { kind: 'completion', status: next.status, reason: payload.reason, stats, actor: payload.actor }
      : { kind: 'lifecycle', status: payload.status, reason: payload.reason, stats, actor: payload.actor };
  const entry: TranscriptGoalEntry = {
    type: 'goal_updated',
    snapshot: snapshotFromGoalStateLike(next),
    change,
  };
  return { entries: [...state.entries, entry], working: { ...state.working, goal: next } };
}

function applyGoalClear(state: TranscriptModelState): TranscriptModelState {
  // No entry: there is no goal-cleared card in the TUI, so a cleared goal only
  // updates the fold working set (same rule as compaction cancel).
  return { entries: state.entries, working: { ...state.working, goal: null } };
}

/** Replay-approximate snapshot: remaining/reached budget fields are a live-service computation, so the transcript reports limits only. */
function snapshotFromGoalStateLike(goal: GoalStateLike): GoalSnapshot {
  return {
    goalId: goal.goalId,
    objective: goal.objective,
    completionCriterion: goal.completionCriterion,
    status: goal.status,
    turnsUsed: goal.turnsUsed,
    tokensUsed: goal.tokensUsed,
    wallClockMs: goal.wallClockMs,
    budget: {
      tokenBudget: goal.budgetLimits.tokenBudget ?? null,
      turnBudget: goal.budgetLimits.turnBudget ?? null,
      wallClockBudgetMs: goal.budgetLimits.wallClockBudgetMs ?? null,
      remainingTokens: null,
      remainingTurns: null,
      remainingWallClockMs: null,
      tokenBudgetReached: false,
      turnBudgetReached: false,
      wallClockBudgetReached: false,
      overBudget: false,
    },
    terminalReason: goal.terminalReason,
  };
}

// -- public model + one-shot reduce -----------------------------------------

export const TranscriptModel = defineDerivedModel<TranscriptModelState>(
  'kimi.tui.transcript',
  () => ({ entries: [], working: INITIAL_WORKING }),
  {
    [contextAppendMessage.type]: (state, payload: unknown) =>
      applyAppendMessage(state, toMutableMessage((payload as { message: ContextMessageLike }).message)),
    [contextAppendLoopEvent.type]: (state, payload: unknown) =>
      applyLoopEvent(state, (payload as { event: LoopRecordedEvent }).event),
    [contextApplyCompaction.type]: (state, payload: unknown) => applyCompactionEntry(state, payload),
    [contextUndo.type]: (state, payload: unknown) =>
      applyTranscriptUndo(state, (payload as { count: number }).count),
    [contextClear.type]: (state) => applyTranscriptClear(state),
    'goal.create': (state, payload: unknown) => applyGoalCreate(state, payload as GoalCreateWirePayload),
    'goal.update': (state, payload: unknown) => applyGoalUpdate(state, payload as GoalUpdateWirePayload),
    'goal.clear': (state) => applyGoalClear(state),
    forked: (state) => applyGoalClear(state),
    [planModeEnter.type]: (state) => ({
      entries: [...state.entries, { type: 'plan_updated', enabled: true }],
      working: state.working,
    }),
    [planModeExit.type]: (state) => ({
      entries: [...state.entries, { type: 'plan_updated', enabled: false }],
      working: state.working,
    }),
    [planModeCancel.type]: (state) => ({
      entries: [...state.entries, { type: 'plan_updated', enabled: false }],
      working: state.working,
    }),
    'permission.set_mode': (state, payload: unknown) => ({
      entries: [...state.entries, { type: 'permission_updated', mode: (payload as { mode: PermissionMode }).mode }],
      working: state.working,
    }),
    'permission.record_approval_result': (state, payload: unknown) => ({
      entries: [...state.entries, { type: 'approval_result', record: payload as PermissionApprovalResultRecord }],
      working: state.working,
    }),
    'config.update': (state, payload: unknown) => ({
      entries: [...state.entries, { type: 'config_updated', config: payload as ConfigUpdateWirePayload }],
      working: state.working,
    }),
  },
);

function stripSummaryPrefix(text: string): string {
  return text.startsWith(COMPACTION_SUMMARY_PREFIX)
    ? text.slice(COMPACTION_SUMMARY_PREFIX.length).trimStart()
    : text;
}

function rawToolResultContent(output: string | readonly ContentPart[]): ContentPart[] {
  return typeof output === 'string' ? [{ type: 'text', text: output }] : [...output];
}

/** Widen a display message to the mutable `ContextMessage` shape v2 helpers expect. */
function toContextMessageView(message: TranscriptMessage): ContextMessage {
  return { ...message, content: [...message.content], toolCalls: [...message.toolCalls] };
}

function textOfParts(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

/**
 * Fold an agent's persisted wire records into transcript entries. Pure:
 * no I/O, no DI — the same function a wire-attached fold would produce.
 * Records are typed loosely (the persisted `WireRecord` union has no index
 * signature); the reduce reads only `type`/`time` envelope fields plus
 * per-op payload fields.
 */
export function reduceTranscript(records: Iterable<object>): TranscriptModelState {
  let state = TranscriptModel.initial();
  // `ModelReducers` is mapped over the persisted op-type union (no string
  // index signature); the fold feeds it raw persisted records whose `type`
  // is only known to be a string, so index through a string-keyed view.
  const reducers = TranscriptModel.reducers as Readonly<
    Record<string, ((state: TranscriptModelState, payload: unknown) => TranscriptModelState) | undefined>
  >;
  for (const record of records) {
    const fields = record as Record<string, unknown>;
    const type = fields['type'];
    if (typeof type !== 'string') continue;
    const reducer = reducers[type];
    if (reducer === undefined) continue;
    state = reducer(state, recordToPayload(fields));
  }
  return state;
}

/** Facade-side mirror of wire `recordToPayload`: envelope fields out. */
function recordToPayload(record: Record<string, unknown>): unknown {
  const payload: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key === 'type' || key === 'time') continue;
    payload[key] = record[key];
  }
  return payload;
}

/**
 * Rehydrate blob references in transcript message content back to inline
 * parts (the counterpart of the wire's derived-model `rehydrate`, which the
 * facade cannot reach since it folds manually). Entries are returned
 * unchanged when nothing references blob storage.
 */
export async function rehydrateTranscript(
  entries: readonly TranscriptEntry[],
  blobs: TranscriptBlobLoader,
): Promise<readonly TranscriptEntry[]> {
  const out: TranscriptEntry[] = [];
  for (const entry of entries) {
    if (entry.type !== 'message') {
      out.push(entry);
      continue;
    }
    const content = await blobs.loadParts(entry.message.content);
    out.push(content === entry.message.content ? entry : { ...entry, message: { ...entry.message, content } });
  }
  return out;
}
