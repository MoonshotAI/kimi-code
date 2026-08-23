// packages/app-core/src/api/daemon/agentEventProjector.ts
//
// Client-side projector: raw agent-core WS events → AppEvent[]
//
// The real daemon pushes raw agent-core events (NOT the projected "event.*"
// protocol events). This projector translates them into the same AppEvent union
// that the existing reducer (eventReducer.ts) consumes.
//
// Ported from the daemon-side reference implementation:
//   apps/kimi-daemon/src/session/event-projector.ts
//   apps/kimi-daemon/src/session/message-log.ts
//   apps/kimi-daemon/src/session/usage-tracker.ts
//
// Usage:
//   const projector = createAgentProjector({ t });
//   const appEvents = projector.project(rawType, payload, sessionId);
//   // call reset() when re-subscribing / resyncing a session

import type {
  AppEvent,
  AppGoal,
  AppInFlightTurn,
  AppMessage,
  AppMessageContent,
  AppSessionUsage,
  AppTask,
} from '../types';
import type { Translator } from '../../contracts';
import { logError } from '../../lib/log';
import { toolLabel, toolSummary } from '../../lib/toolText';
import { toAppMessageContent } from './mappers';
import type { AgentProjector, ProjectMeta } from './projector';
import type { WireMessageContent } from './wire';

// Subagent turns share the parent session id: their turn / step / delta / tool
// frames stream over the SAME session channel, each tagged with the subagent's
// own agentId (the main agent's is 'main'). They must NOT be folded into the
// parent transcript — doing so created empty "skeleton" assistant bubbles (a
// subagent turn.step.started opens a parent assistant message that never gets
// the main agent's text) and fragmented snippets (subagent deltas appended to
// the parent). The subagent's live progress is surfaced separately via the
// subagent.* → task → right-side detail panel path (the spawning `Agent` tool
// itself renders as a normal tool card in the transcript). This mirrors the
// server's InFlightTurnTracker, which likewise tracks only main-agent activity.
const MAIN_AGENT_ID = 'main';
const MAIN_AGENT_TRANSCRIPT_FRAMES = new Set<string>([
  'turn.started',
  'turn.step.started',
  'turn.step.completed',
  'turn.step.retrying',
  'turn.step.interrupted',
  'turn.ended',
  'thinking.delta',
  'assistant.delta',
  'tool.use',
  'tool.call.started',
  'tool.call.delta',
  'tool.progress',
  'tool.result',
  'agent.status.updated',
  'prompt.completed',
  'prompt.aborted',
  'error',
]);

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function ulid(prefix = 'msg_'): string {
  const t = Date.now().toString(36).padStart(10, '0');
  const r = Math.random().toString(36).slice(2, 12).padEnd(10, '0');
  return `${prefix}${t}${r}`;
}

/** Normalise the raw token usage shape emitted by agent-core. */
function normalizeUsage(raw: unknown): {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreate: number;
} {
  if (!raw || typeof raw !== 'object') {
    return { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 };
  }
  const u = raw as Record<string, number | undefined>;
  return {
    input: u['inputOther'] ?? u['input_tokens'] ?? 0,
    output: u['output'] ?? u['output_tokens'] ?? 0,
    cacheRead: u['inputCacheRead'] ?? u['cache_read_input_tokens'] ?? 0,
    cacheCreate: u['inputCacheCreation'] ?? u['cache_creation_input_tokens'] ?? 0,
  };
}

// ---------------------------------------------------------------------------
// Per-session projector state
// ---------------------------------------------------------------------------

interface SessionState {
  // Turn ID → promptId binding
  turnPromptId: Map<number, string>;
  currentPromptId: string | undefined;

  // Assistant message tracking
  currentAssistantMsgId: string | undefined;

  // Per-step accumulated stream lengths — aligned against the (step-relative)
  // wire `offset` on volatile delta frames (v2 sync protocol) to skip
  // duplicates and detect gaps after a snapshot seed.
  turnTextLen: number;
  turnThinkLen: number;

  // Tool timing
  toolStartTimes: Map<string, number>;

  // Usage accumulator
  totalInput: number;
  totalOutput: number;
  totalCacheRead: number;
  totalCacheCreate: number;
  contextTokens: number;
  contextLimit: number;
  turnCount: number;
  model: string;

  // In-memory message log (mirrors daemon message-log.ts)
  messages: AppMessage[];

  /** True while the main turn's current step is in the retry backoff — the
   *  last projected `agent.status.updated` carried phase 'retrying'. Gates the
   *  clear emission so non-retrying phases don't each emit a redundant clear. */
  retryActive: boolean;

  // Subagent lifecycle deltas after spawned only carry subagentId. Keep the
  // spawned metadata here so later updates can replace the full AppTask.
  subagentMeta: Map<string, AppTask>;
  /** Agents whose `subagent.started` re-opened a settled row (the new run's
   *  lifecycle has begun but its registration/spawned has not landed yet). */
  restartedThisRun: Set<string>;
  /** Agents the KERNEL terminated (task.terminated) — the reducer row settled
   *  but the projector meta still says running, so re-opens must key on this,
   *  not the meta's stale status. */
  settledByKernel: Set<string>;
  /** Bindings a new run explicitly retired (cleared at its spawned): a
   *  replayed event for one never re-adopts it. */
  retiredBindings: Set<string>;
  /** Registration order per task id: a spawned's binding may reset the row
   *  only when its own registration is confirmed and not older than the
   *  row's current one (an outdated spawned replay never regresses it). */
  registrationSeq: number;
  registrationOrderByKey: Map<string, number>;

  // Bubble cleared by turn.step.retrying, to be reused by the retried
  // step.started (same turn) instead of stacking a new bubble.
  retryReuseMsgId: string | undefined;
}

function createSessionState(): SessionState {
  return {
    turnPromptId: new Map(),
    currentPromptId: undefined,
    currentAssistantMsgId: undefined,
    turnTextLen: 0,
    turnThinkLen: 0,
    toolStartTimes: new Map(),
    totalInput: 0,
    totalOutput: 0,
    totalCacheRead: 0,
    totalCacheCreate: 0,
    contextTokens: 0,
    contextLimit: 0,
    turnCount: 0,
    model: '',
    messages: [],
    subagentMeta: new Map(),
    restartedThisRun: new Set(),
    settledByKernel: new Set(),
    retiredBindings: new Set(),
    registrationSeq: 0,
    registrationOrderByKey: new Map(),
    retryReuseMsgId: undefined,
    retryActive: false,
  };
}

function stringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  return typeof value === 'string' ? value : undefined;
}

function numberField(source: Record<string, unknown>, key: string): number | undefined {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function nullableNumberField(source: Record<string, unknown>, key: string): number | null {
  const value = source[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function mapGoalSnapshot(snapshot: unknown): AppGoal | null {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const s = snapshot as Record<string, unknown>;
  const budgetRaw = s['budget'];
  const budget = budgetRaw && typeof budgetRaw === 'object' ? budgetRaw as Record<string, unknown> : {};
  const status = stringField(s, 'status');
  if (status !== 'active' && status !== 'paused' && status !== 'blocked' && status !== 'complete') return null;
  const goalId = stringField(s, 'goalId') ?? stringField(s, 'goal_id') ?? 'goal';
  const objective = stringField(s, 'objective') ?? '';
  return {
    goalId,
    objective,
    completionCriterion: stringField(s, 'completionCriterion') ?? stringField(s, 'completion_criterion'),
    status,
    turnsUsed: numberField(s, 'turnsUsed') ?? numberField(s, 'turns_used') ?? 0,
    tokensUsed: numberField(s, 'tokensUsed') ?? numberField(s, 'tokens_used') ?? 0,
    wallClockMs: numberField(s, 'wallClockMs') ?? numberField(s, 'wall_clock_ms') ?? 0,
    terminalReason: stringField(s, 'terminalReason') ?? stringField(s, 'terminal_reason'),
    budget: {
      tokenBudget: nullableNumberField(budget, 'tokenBudget') ?? nullableNumberField(budget, 'token_budget'),
      remainingTokens: nullableNumberField(budget, 'remainingTokens') ?? nullableNumberField(budget, 'remaining_tokens'),
      turnBudget: nullableNumberField(budget, 'turnBudget') ?? nullableNumberField(budget, 'turn_budget'),
      remainingTurns: nullableNumberField(budget, 'remainingTurns') ?? nullableNumberField(budget, 'remaining_turns'),
      wallClockBudgetMs: nullableNumberField(budget, 'wallClockBudgetMs') ?? nullableNumberField(budget, 'wall_clock_budget_ms'),
      remainingWallClockMs: nullableNumberField(budget, 'remainingWallClockMs') ?? nullableNumberField(budget, 'remaining_wall_clock_ms'),
      overBudget: budget['overBudget'] === true || budget['over_budget'] === true,
    },
  };
}

function patchSubagent(
  t: Translator,
  state: SessionState,
  sessionId: string,
  subagentId: unknown,
  patch: Partial<AppTask>,
): AppTask | null {
  if (typeof subagentId !== 'string' || subagentId.length === 0) return null;
  const prev = state.subagentMeta.get(subagentId) ?? {
    id: subagentId,
    agentId: subagentId,
    sessionId,
    kind: 'subagent',
    description: t('tasks.dockSubagent'),
    status: 'running',
    createdAt: new Date().toISOString(),
    subagentPhase: 'queued',
  } satisfies AppTask;
  const next: AppTask = { ...prev, ...patch, id: subagentId, sessionId, kind: 'subagent' };
  state.subagentMeta.set(subagentId, next);
  return next;
}

export function subagentProgressText(t: Translator, rawType: string, payload: Record<string, unknown>): string | null {
  // "Started a step" fires on every step and adds no information — the phase
  // badge already shows the subagent is working, so skip it to cut the noise.
  if (rawType === 'turn.step.started') return null;
  if (rawType === 'tool.use' || rawType === 'tool.call.started') {
    const name = stringField(payload, 'name') ?? stringField(payload, 'toolName') ?? 'tool';
    const label = toolLabel(t, cleanToolName(name));
    const summary = toolArgSummary(t, name, payload['args'] ?? payload['input']);
    return summary ? `Calling ${label}: ${summary}` : `Calling ${label}`;
  }
  if (rawType === 'tool.progress') {
    const update = payload['update'];
    if (update && typeof update === 'object') {
      const text = stringField(update as Record<string, unknown>, 'text');
      if (text) return capProgressText(text);
      const message = stringField(update as Record<string, unknown>, 'message');
      if (message) return capProgressText(message);
    }
    const message = stringField(payload, 'message');
    if (message) return capProgressText(message);
  }
  // tool.result lines ("Finished X") add noise without much information — the
  // next call or the final summary already implies completion — so skip them.
  if (rawType === 'tool.result') return null;
  return null;
}

/** Strip a trailing `_N` index that some subagents append to tool names in
 *  `tool.result` events (e.g. `Read_0` → `Read`) so the label resolves. */
function cleanToolName(name: string): string {
  return name.replace(/_\d+$/, '');
}

/** Cap a progress text chunk so a single huge tool output (e.g. a big command
 *  result) cannot dominate the panel. */
const MAX_PROGRESS_TEXT = 2000;
function capProgressText(text: string): string {
  return text.length > MAX_PROGRESS_TEXT ? `${text.slice(0, MAX_PROGRESS_TEXT)}…` : text;
}

/** A concise, human-readable summary of a tool call's arguments for progress
 *  lines (e.g. a file path or shell command), instead of the full JSON blob. */
function toolArgSummary(t: Translator, name: string, args: unknown): string {
  if (args === undefined || args === null) return '';
  const arg = typeof args === 'string' ? args : JSON.stringify(args);
  return toolSummary(t, name, arg);
}

function projectSubagentProgress(
  t: Translator,
  state: SessionState,
  sessionId: string,
  subagentId: string,
  rawType: string,
  payload: Record<string, unknown>,
  sideChannelAgents: ReadonlySet<string>,
): AppEvent[] {
  // Side-channel agents (e.g. BTW side chat) stream their own transcript via
  // agentDelta events; don't pollute the main task output with generic step
  // placeholders like "Started a step".
  if (sideChannelAgents.has(subagentId) && rawType === 'turn.step.started') return [];

  // The subagent's own streamed text: forward each delta as a `text`-kind
  // progress chunk so the reducer concatenates it into `AppTask.text`, letting
  // the right-side detail panel show the subagent's output growing live (like
  // a thinking block) instead of staying blank until the first tool call.
  if (rawType === 'assistant.delta') {
    const delta = stringField(payload, 'delta');
    if (!delta) return [];
    // Ensure the subagent task exists before forwarding the text delta. A client
    // that subscribed from a snapshot after `subagent.spawned` already fired
    // never received the lifecycle taskCreated, and the reducer only applies
    // taskProgress to existing tasks — without this, the deltas are dropped and
    // the live detail stays blank until a non-text frame recreates the task.
    const previous = state.subagentMeta.get(subagentId);
    const task = patchSubagent(t, state, sessionId, subagentId, {
      status: 'running',
      subagentPhase: 'working',
      startedAt: previous?.startedAt ?? new Date().toISOString(),
    });
    const out: AppEvent[] = [];
    if (task) out.push({ type: 'taskCreated', sessionId, task });
    out.push({
      type: 'taskProgress',
      sessionId,
      taskId: subagentId,
      outputChunk: delta,
      stream: 'stdout',
      kind: 'text',
    });
    return out;
  }

  const text = subagentProgressText(t, rawType, payload);
  if (text === null || text.length === 0) return [];
  // A `replace` tool-progress update (e.g. a subagent's WaitFor tick) rewrites
  // the status line it previously emitted rather than growing the panel by one
  // line per second.
  const update = rawType === 'tool.progress' ? payload['update'] : undefined;
  const replace =
    update !== undefined && update !== null && typeof update === 'object'
      ? (update as Record<string, unknown>)['replace'] === true
      : false;
  const previous = state.subagentMeta.get(subagentId);
  const task = patchSubagent(t, state, sessionId, subagentId, {
    status: 'running',
    subagentPhase: 'working',
    startedAt: previous?.startedAt ?? new Date().toISOString(),
  });
  const out: AppEvent[] = [];
  if (task) out.push({ type: 'taskCreated', sessionId, task });
  out.push({ type: 'taskProgress', sessionId, taskId: subagentId, outputChunk: text, stream: 'stdout', replace });
  return out;
}

// ---------------------------------------------------------------------------
// Message-log helpers (inlined; mirrors message-log.ts)
// ---------------------------------------------------------------------------

/**
 * Decouple an emitted message from the projector's internal log. The reducer
 * stores emitted messages by reference; the projector keeps mutating its own
 * copy in place (`slot.text += delta`), so sharing the content objects makes
 * the reducer's delta-append run on already-appended text — the first streamed
 * chunk of every text/thinking block rendered twice.
 */
function cloneMessage(msg: AppMessage): AppMessage {
  return { ...msg, content: msg.content.map((c) => ({ ...c })) };
}

function startAssistantMessage(state: SessionState, sessionId: string, promptId: string): AppMessage {
  const msg: AppMessage = {
    id: ulid('msg_'),
    sessionId,
    role: 'assistant',
    content: [],
    createdAt: new Date().toISOString(),
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

function startUserMessage(
  state: SessionState,
  sessionId: string,
  promptId: string,
  userMessageId: string,
  content: AppMessageContent[],
  createdAt: string,
): AppMessage {
  const msg: AppMessage = {
    id: userMessageId,
    sessionId,
    role: 'user',
    content,
    createdAt,
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

function toAppPromptContent(raw: unknown): AppMessageContent[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((part) => toAppMessageContent(part as WireMessageContent));
}

/**
 * Append a streamed text/thinking delta in stream order: continue the LAST
 * content part when it has the same type, otherwise open a NEW part at the
 * end. Returns the content index written (-1 if the message is unknown) so
 * the emitted assistantDelta targets the same slot in the reducer.
 *
 * No per-type fixed slots: a step that goes think → text → think again gets
 * three parts in call order instead of all thinking collapsing into one slot.
 */
function appendAssistantDelta(
  state: SessionState,
  messageId: string,
  kind: 'text' | 'thinking',
  delta: string,
): number {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return -1;
  const last = msg.content.at(-1);
  if (last && last.type === kind) {
    if (kind === 'text') (last as { type: 'text'; text: string }).text += delta;
    else (last as { type: 'thinking'; thinking: string }).thinking += delta;
    return msg.content.length - 1;
  }
  msg.content.push(kind === 'text' ? { type: 'text', text: delta } : { type: 'thinking', thinking: delta });
  return msg.content.length - 1;
}

function appendToolUse(
  state: SessionState,
  messageId: string,
  toolCallId: string,
  toolName: string,
  input: unknown,
  outputLines?: string[],
): void {
  const msg = state.messages.find((m) => m.id === messageId);
  if (!msg) return;
  msg.content.push({ type: 'toolUse', toolCallId, toolName, input, outputLines });
}

function toolProgressOutput(payload: Record<string, unknown>): { outputChunk: string; stream: 'stdout' | 'stderr'; replace: boolean } | null {
  const update = payload['update'];
  const updateRecord = update && typeof update === 'object' ? update as Record<string, unknown> : null;
  const streamRaw = updateRecord?.['stream'] ?? updateRecord?.['kind'] ?? payload['stream'];
  const stream = streamRaw === 'stderr' ? 'stderr' : 'stdout';
  const chunk =
    (typeof updateRecord?.['text'] === 'string' && updateRecord['text']) ||
    (typeof updateRecord?.['message'] === 'string' && updateRecord['message']) ||
    (typeof payload['chunk'] === 'string' && payload['chunk']) ||
    (typeof payload['output'] === 'string' && payload['output']) ||
    (typeof payload['message'] === 'string' && payload['message']) ||
    '';
  // A `replace` update rewrites the status line it previously emitted (e.g.
  // WaitFor's per-second wait tick) rather than adding a new one.
  const replace = updateRecord?.['replace'] === true;
  return chunk.length > 0 ? { outputChunk: chunk, stream, replace } : null;
}

function finishAssistantMessage(state: SessionState, messageId: string): void {
  const msg = state.messages.find((m) => m.id === messageId);
  // We record nothing extra here — status is implicit in the downstream reducer
  void msg;
}

function appendToolResultMessage(
  state: SessionState,
  sessionId: string,
  toolCallId: string,
  output: unknown,
  isError: boolean,
  promptId: string,
): AppMessage {
  const msg: AppMessage = {
    id: ulid('msg_'),
    sessionId,
    role: 'tool',
    content: [{ type: 'toolResult', toolCallId, output, isError }],
    createdAt: new Date().toISOString(),
    promptId,
  };
  state.messages.push(msg);
  return msg;
}

function getMsgById(state: SessionState, messageId: string): AppMessage | undefined {
  return state.messages.find((m) => m.id === messageId);
}

/**
 * Drop every log message the projector can no longer touch. Reads of the
 * internal log are always by id of a still-live message — the current
 * assistant bubble (`currentAssistantMsgId`) or the retry-reuse target
 * (`retryReuseMsgId`). Everything else (user prompts, finished assistant
 * bubbles, tool results, synthesized notices) was already emitted to the
 * reducer as a decoupled clone; keeping it here only pins the full transcript
 * a second time for the renderer's lifetime. Called whenever the live-id set
 * shrinks (step/turn boundaries), so the log holds at most the in-flight
 * bubble between turns instead of the whole session history.
 */
function trimSessionLog(state: SessionState): void {
  const keep = new Set<string>();
  if (state.currentAssistantMsgId !== undefined) keep.add(state.currentAssistantMsgId);
  if (state.retryReuseMsgId !== undefined) keep.add(state.retryReuseMsgId);
  if (state.messages.length > keep.size) {
    state.messages = state.messages.filter((m) => keep.has(m.id));
  }
}

// ---------------------------------------------------------------------------
// Usage snapshot builder
// ---------------------------------------------------------------------------

function buildUsageSnapshot(state: SessionState): AppSessionUsage {
  return {
    inputTokens: state.totalInput,
    outputTokens: state.totalOutput,
    cacheReadTokens: state.totalCacheRead,
    cacheCreationTokens: state.totalCacheCreate,
    totalCostUsd: 0,
    contextTokens: state.contextTokens,
    contextLimit: state.contextLimit,
    turnCount: state.turnCount,
  };
}

// ---------------------------------------------------------------------------
// Stateless raw frames
//
// These frame types only re-broadcast their payload — projecting them needs
// no per-session state, and the daemon broadcasts some of them (e.g.
// session.meta.updated) to every connection regardless of subscription.
// Routing them through a stateless path keeps getOrCreate from materializing
// a SessionState for sessions the client never subscribed to (or just
// forgot), which would let the sessions map regrow behind the LRU/forget
// cleanup.
// ---------------------------------------------------------------------------

const STATELESS_RAW_FRAMES = new Set<string>([
  'session.meta.updated',
  'goal.updated',
  'compaction.completed',
  'compaction.started',
  'compaction.cancelled',
  // Explicitly known but not projected.
  'compaction.blocked',
  'hook.result',
  'mcp.server.status',
  'skill.activated',
  'tool.list.updated',
]);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function projectStatelessFrame(rawType: string, p: any, sessionId: string): AppEvent[] {
  switch (rawType) {
    case 'session.meta.updated': {
      // The daemon auto-generates a title from the first prompt (and other
      // clients can rename a session); it also reports the latest user prompt
      // via patch.lastPrompt. Patch only the changed meta fields.
      const title: string | undefined = p?.patch?.title ?? p?.title;
      const lastPrompt: string | undefined = p?.patch?.lastPrompt;
      const patch: { title?: string; lastPrompt?: string } = {};
      if (typeof title === 'string' && title.length > 0) patch.title = title;
      if (typeof lastPrompt === 'string') patch.lastPrompt = lastPrompt;
      return patch.title !== undefined || patch.lastPrompt !== undefined
        ? [{ type: 'sessionMetaUpdated', sessionId, ...patch }]
        : [];
    }
    case 'goal.updated': {
      const goal = mapGoalSnapshot(p?.snapshot ?? null);
      return [
        { type: 'goalUpdated', sessionId, goal: goal?.status === 'complete' ? null : goal },
      ];
    }
    case 'compaction.completed': {
      // Compaction replaced old messages with a summary daemon-side. The
      // visible transcript is NOT reloaded; historyCompacted still fires so
      // seq bookkeeping and non-compaction consumers stay correct.
      const result = (p?.result ?? {}) as Record<string, unknown>;
      return [
        {
          type: 'compactionCompleted',
          sessionId,
          tokensBefore: typeof result.tokensBefore === 'number' ? result.tokensBefore : undefined,
          tokensAfter: typeof result.tokensAfter === 'number' ? result.tokensAfter : undefined,
          summary: typeof result.summary === 'string' ? result.summary : undefined,
        },
        { type: 'historyCompacted', sessionId, beforeSeq: 0, reason: 'auto_compact' },
      ];
    }
    case 'compaction.started':
      return [
        {
          type: 'compactionStarted',
          sessionId,
          trigger: p?.trigger === 'manual' ? 'manual' : 'auto',
          instruction: typeof p?.instruction === 'string' ? p.instruction : undefined,
        },
      ];
    case 'compaction.cancelled':
      return [{ type: 'compactionCancelled', sessionId }];
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------
// AgentProjector
// ---------------------------------------------------------------------------

// The translator is injected (`deps.t`) so projected text — task descriptions,
// progress labels — is localized without importing the consumer's i18n runtime.

/** Concrete projector instance: the AgentProjector contract plus test/debug
 *  introspection (kept off the interface so api consumers see only the
 *  contract). */
export interface AgentProjectorInstance extends AgentProjector {
  /** Number of transcript messages the projector still pins for a session —
   *  undefined when no state exists for it (never seen, or forgotten). */
  retainedMessageCount(sessionId: string): number | undefined;
}

export function createAgentProjector(deps: { t: Translator }): AgentProjectorInstance {
  const { t } = deps;
  const sessions = new Map<string, SessionState>();
  const sideChannelAgents = new Set<string>();

  function getOrCreate(sessionId: string): SessionState {
    let s = sessions.get(sessionId);
    if (!s) {
      s = createSessionState();
      sessions.set(sessionId, s);
    }
    return s;
  }

  function reset(sessionId: string): void {
    sessions.set(sessionId, createSessionState());
  }

  function forgetSession(sessionId: string): void {
    sessions.delete(sessionId);
  }

  function retainedMessageCount(sessionId: string): number | undefined {
    return sessions.get(sessionId)?.messages.length;
  }

  function markSideChannelAgent(agentId: string): void {
    sideChannelAgents.add(agentId);
  }

  function bindNextPromptId(sessionId: string, promptId: string): void {
    const s = getOrCreate(sessionId);
    s.currentPromptId = promptId;
  }

  function seedInFlight(sessionId: string, turn: AppInFlightTurn): AppEvent[] {
    reset(sessionId);
    const s = getOrCreate(sessionId);

    const promptId = turn.promptId ?? ulid('pr_');
    s.currentPromptId = promptId;
    s.turnPromptId.set(turn.turnId, promptId);

    const msg = startAssistantMessage(s, sessionId, promptId);
    if (turn.thinkingText.length > 0) {
      msg.content.push({ type: 'thinking', thinking: turn.thinkingText });
    }
    if (turn.assistantText.length > 0) {
      msg.content.push({ type: 'text', text: turn.assistantText });
    }
    for (const tool of turn.runningTools) {
      const outputLines =
        typeof tool.lastProgress?.text === 'string' && tool.lastProgress.text.length > 0
          ? [tool.lastProgress.text]
          : undefined;
      msg.content.push({
        type: 'toolUse',
        toolCallId: tool.toolCallId,
        toolName: tool.name,
        input: tool.args ?? {},
        outputLines,
      });
      s.toolStartTimes.set(tool.toolCallId, Date.now());
    }
    s.currentAssistantMsgId = msg.id;
    // Seeded step-relative lengths; the next turn.step.started resets both.
    s.turnTextLen = turn.assistantText.length;
    s.turnThinkLen = turn.thinkingText.length;

    return [{ type: 'messageCreated', message: cloneMessage(msg) }];
  }

  function project(
    rawType: string,
    payload: unknown,
    sessionId: string,
    meta?: ProjectMeta,
  ): AppEvent[] {
    try {
      return _project(rawType, payload, sessionId, meta);
    } catch (error) {
      // Defensive: log but never crash the caller
      logError('[agentProjector] Error projecting event:', rawType, error instanceof Error ? error.message : error);
      return [];
    }
  }

  /**
   * Align a live text-delta against the per-turn accumulated length using the
   * wire `offset`. Returns 'skip' for duplicates (offset behind local state),
   * 'gap' when deltas were missed (offset ahead — trigger a re-snapshot), and
   * 'append' otherwise.
   */
  function alignDelta(localLen: number, offset: number | undefined): 'append' | 'skip' | 'gap' {
    if (offset === undefined) return 'append';
    if (offset < localLen) return 'skip';
    if (offset > localLen) return 'gap';
    return 'append';
  }

  function _project(
    rawType: string,
    payload: unknown,
    sessionId: string,
    meta?: ProjectMeta,
  ): AppEvent[] {
    // Frames that only re-broadcast their payload must not materialize a
    // SessionState for sessions we have never seen (or just forgot): the
    // daemon broadcasts them to every connection regardless of subscription,
    // so an entry dropped by unsubscribe / LRU eviction / forgetSession would
    // immediately regrow otherwise.
    if (STATELESS_RAW_FRAMES.has(rawType)) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return projectStatelessFrame(rawType, payload as any, sessionId);
    }
    const s = getOrCreate(sessionId);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = payload as any;
    const out: AppEvent[] = [];

    // Drop subagent-scoped transcript frames (see MAIN_AGENT_TRANSCRIPT_FRAMES).
    // A subagent carries its own agentId; only the main agent's stream builds the
    // visible transcript. Lifecycle frames (subagent.*, goal.*, background.*) are
    // intentionally NOT in the set — they describe the subagent for the task view
    // and must always be projected.
    const frameAgentId: unknown = p?.agentId;
    if (typeof frameAgentId === 'string' && frameAgentId !== MAIN_AGENT_ID) {
      const isSideChannel = sideChannelAgents.has(frameAgentId);
      if (rawType === 'prompt.submitted') {
        if (!isSideChannel) return [];
        const promptId: string | undefined = p?.promptId;
        const userMessageId: string | undefined = p?.userMessageId;
        if (!promptId || !userMessageId) return [];
        const content = toAppPromptContent(p?.content);
        if (content.length === 0) return [];
        return [{
          type: 'messageCreated',
          agentId: frameAgentId,
          message: {
            id: userMessageId,
            sessionId,
            role: 'user',
            content,
            createdAt: typeof p?.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
            promptId,
          },
        }];
      }
      // Side-channel agents (e.g. BTW side chat) stream text/thinking deltas and
      // a turn boundary over the parent session channel. Route them to the web
      // layer as agent-scoped events instead of dropping them or folding them
      // into the parent transcript.
      if (isSideChannel && (rawType === 'thinking.delta' || rawType === 'assistant.delta')) {
        const deltaText: string = p?.delta ?? '';
        if (!deltaText) return [];
        return [
          {
            type: 'agentDelta' as const,
            sessionId,
            agentId: frameAgentId,
            delta: { [rawType === 'thinking.delta' ? ('thinking' as const) : ('text' as const)]: deltaText },
          },
        ];
      }
      if (isSideChannel && rawType === 'turn.ended') {
        return [
          { type: 'agentTurnEnded' as const, sessionId, agentId: frameAgentId, reason: p?.reason },
        ];
      }
      if (MAIN_AGENT_TRANSCRIPT_FRAMES.has(rawType)) {
        return projectSubagentProgress(t, s, sessionId, frameAgentId, rawType, p ?? {}, sideChannelAgents);
      }
    }

    switch (rawType) {
      // -----------------------------------------------------------------------
      case 'prompt.submitted': {
        const promptId: string | undefined = p?.promptId;
        const userMessageId: string | undefined = p?.userMessageId;
        if (!promptId || !userMessageId) break;
        const content = toAppPromptContent(p?.content);
        if (content.length === 0) break;
        s.currentPromptId = promptId;
        const msg = startUserMessage(
          s,
          sessionId,
          promptId,
          userMessageId,
          content,
          typeof p?.createdAt === 'string' ? p.createdAt : new Date().toISOString(),
        );
        out.push({
          type: 'messageCreated',
          message: cloneMessage(msg),
          ...(typeof frameAgentId === 'string' ? { agentId: frameAgentId } : {}),
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.started': {
        // Bind turnId → promptId. Generate a synthetic one if none was pre-bound.
        // Session busy is intentionally NOT projected here — the daemon's
        // `event.session.work_changed` is the single source of the busy fact
        // (it re-reads the authoritative drain registry and dedupes per real
        // transition); projecting a second busy flip per turn from the raw
        // stream made every turn-end consumer fire twice.
        const turnId: number = p?.turnId;
        const existingPromptId = s.currentPromptId ?? ulid('pr_');
        s.currentPromptId = existingPromptId;
        if (turnId !== undefined) {
          s.turnPromptId.set(turnId, existingPromptId);
        }
        // Fresh turn → fresh step stream offsets.
        s.turnTextLen = 0;
        s.turnThinkLen = 0;
        // The goal-continuation trigger message is persisted but never
        // broadcast — synthesize it (like cron.fired below) so the provenance
        // marker shows live; the turn-derived id dedupes replays downstream.
        const turnOrigin = p?.origin;
        if (
          turnOrigin &&
          typeof turnOrigin === 'object' &&
          (turnOrigin as Record<string, unknown>)['kind'] === 'system_trigger' &&
          (turnOrigin as Record<string, unknown>)['name'] === 'goal_continuation'
        ) {
          const msg: AppMessage = {
            id: turnId !== undefined ? `goal_cont_${turnId}` : ulid('goal_'),
            sessionId,
            role: 'user',
            content: [{ type: 'text', text: stringField(p ?? {}, 'prompt') ?? '' }],
            createdAt: new Date().toISOString(),
            metadata: { origin: turnOrigin as Record<string, unknown> },
          };
          s.messages.push(msg);
          // Liveness first: it shares this frame's seq with the synthetic
          // messageCreated, and the reducer's freshness gate only passes the
          // first same-seq event (the turn.ended arm already orders it first
          // for the same reason).
          out.push({ type: 'turnActiveChanged', sessionId, active: true });
          out.push({ type: 'messageCreated', message: cloneMessage(msg) });
          break;
        }
        // Main-conversation liveness (the working indicator) keys off the main agent's turn
        // boundary directly — only main-agent frames reach this switch arm.
        out.push({ type: 'turnActiveChanged', sessionId, active: true });
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.step.started': {
        const turnId: number = p?.turnId;
        // A step starting (including a retry's next attempt) means any retry
        // backoff is over — clear it here too, not only on the next
        // agent.status.updated phase, so the indicator never narrates a retry
        // while the model is already producing.
        if (s.retryActive) {
          s.retryActive = false;
          out.push({ type: 'turnRetry', sessionId, retry: undefined });
        }
        let promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
        if (!promptId) {
          // Joined mid-turn (reconnect/resync wiped the binding): synthesize a
          // promptId like turn.started does, so the REST of the turn still
          // renders instead of every following event being dropped.
          promptId = ulid('pr_');
          s.currentPromptId = promptId;
          if (turnId !== undefined) s.turnPromptId.set(turnId, promptId);
        }

        // Fresh step → fresh stream offsets: the server's delta `offset` is
        // step-relative, so without this reset every delta from step 2 on is
        // silently skipped or misread as a gap.
        s.turnTextLen = 0;
        s.turnThinkLen = 0;

        // A retry continuation: refill the bubble turn.step.retrying cleared,
        // instead of creating a second bubble with the same step's content.
        if (s.retryReuseMsgId !== undefined) {
          const reuseId = s.retryReuseMsgId;
          s.retryReuseMsgId = undefined;
          if (getMsgById(s, reuseId) !== undefined) {
            s.currentAssistantMsgId = reuseId;
            trimSessionLog(s);
            break;
          }
        }

        // Create a new pending assistant message
        const msg = startAssistantMessage(s, sessionId, promptId);
        s.currentAssistantMsgId = msg.id;
        trimSessionLog(s);

        out.push({ type: 'messageCreated', message: cloneMessage(msg) });
        break;
      }

      // -----------------------------------------------------------------------
      case 'thinking.delta': {
        const msgId = s.currentAssistantMsgId;
        if (!msgId) break;
        const delta: string = p?.delta ?? '';
        if (!delta) break;

        // Same missed-turn-boundary self-heal as assistant.delta (see there).
        if (meta?.offset === 0 && s.turnThinkLen > 0) {
          s.turnThinkLen = 0;
        }

        const align = alignDelta(s.turnThinkLen, meta?.offset);
        if (align === 'skip') break;
        if (align === 'gap') {
          out.push({ type: 'historyCompacted', sessionId, beforeSeq: 0, reason: 'delta_gap' });
          break;
        }

        const thinkIdx = appendAssistantDelta(s, msgId, 'thinking', delta);
        if (thinkIdx < 0) break;
        s.turnThinkLen += delta.length;
        out.push({
          type: 'assistantDelta',
          sessionId,
          messageId: msgId,
          contentIndex: thinkIdx,
          delta: { thinking: delta },
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'assistant.delta': {
        const msgId = s.currentAssistantMsgId;
        if (!msgId) break;
        const delta: string = p?.delta ?? '';
        if (!delta) break;

        // Self-heal a missed turn boundary: a pre-append offset of 0 while we
        // still believe we are mid-stream means the daemon began a fresh
        // assistant stream (new turn / retry) whose turn.started we never saw —
        // e.g. the durable replay and the live volatile deltas raced on the
        // cursor after a reconnect. Without this reset every delta has
        // offset < turnTextLen and is SILENTLY skipped forever (skip, unlike
        // gap, never recovers), so streaming dies until a full page reload.
        if (meta?.offset === 0 && s.turnTextLen > 0) {
          s.turnTextLen = 0;
        }

        const align = alignDelta(s.turnTextLen, meta?.offset);
        if (align === 'skip') break;
        if (align === 'gap') {
          // Deltas were missed in the snapshot↔subscribe window — the only
          // exact recovery is a fresh snapshot. historyCompacted is routed to
          // onResync by the client wrapper, which reloads via snapshot.
          out.push({ type: 'historyCompacted', sessionId, beforeSeq: 0, reason: 'delta_gap' });
          break;
        }

        const textIdx = appendAssistantDelta(s, msgId, 'text', delta);
        if (textIdx < 0) break;
        s.turnTextLen += delta.length;
        out.push({
          type: 'assistantDelta',
          sessionId,
          messageId: msgId,
          contentIndex: textIdx,
          delta: { text: delta },
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'tool.use':
      case 'tool.call.started': {
        const msgId = s.currentAssistantMsgId;
        const turnId: number = p?.turnId;
        const promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
        if (!msgId || !promptId) break;

        const toolCallId: string = p?.toolCallId;
        // Real daemon field name is 'name' per event-projector.ts
        const toolName: string = p?.name ?? p?.toolName ?? '';
        const args = p?.args ?? p?.input ?? {};

        appendToolUse(s, msgId, toolCallId, toolName, args);

        const msg = getMsgById(s, msgId);
        const contentIndex = msg ? msg.content.length - 1 : 0;

        // Record start time
        s.toolStartTimes.set(toolCallId, Date.now());

        // Emit messageUpdated so the reducer knows about the new tool-use slot
        if (msg) {
          out.push({
            type: 'messageUpdated',
            sessionId,
            messageId: msgId,
            content: msg.content.map((c) => ({ ...c })),
            status: 'pending',
          });
        }
        void contentIndex;
        break;
      }

      // -----------------------------------------------------------------------
      case 'tool.call.delta': {
        // Input streaming — no-op for the web client (content already in tool.call.started.args)
        break;
      }

      // -----------------------------------------------------------------------
      case 'tool.progress': {
        const toolCallId: string = p?.toolCallId;
        const progress = toolProgressOutput(p ?? {});
        if (toolCallId && progress) {
          out.push({
            type: 'toolOutput',
            sessionId,
            toolCallId,
            outputChunk: progress.outputChunk,
            stream: progress.stream,
            replace: progress.replace,
          });
        }
        break;
      }

      // -----------------------------------------------------------------------
      case 'tool.result': {
        const turnId: number = p?.turnId;
        let promptId = s.turnPromptId.get(turnId) ?? s.currentPromptId;
        if (!promptId) {
          // Same mid-turn-join fallback as turn.step.started.
          promptId = ulid('pr_');
          s.currentPromptId = promptId;
          if (turnId !== undefined) s.turnPromptId.set(turnId, promptId);
        }

        const toolCallId: string = p?.toolCallId;
        const output = p?.output;
        const isError: boolean = p?.isError ?? false;

        const startTime = s.toolStartTimes.get(toolCallId) ?? Date.now();
        s.toolStartTimes.delete(toolCallId);
        void (Date.now() - startTime); // duration — unused at client level

        const resultMsg = appendToolResultMessage(s, sessionId, toolCallId, output, isError, promptId);
        out.push({ type: 'messageCreated', message: cloneMessage(resultMsg) });

        // Reset assistant message tracking — next step.started will create a fresh one
        s.currentAssistantMsgId = undefined;
        trimSessionLog(s);
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.step.completed': {
        const msgId = s.currentAssistantMsgId;

        // Feed usage
        const u = normalizeUsage(p?.usage);
        s.totalInput += u.input;
        s.totalOutput += u.output;
        s.totalCacheRead += u.cacheRead;
        s.totalCacheCreate += u.cacheCreate;

        if (msgId) {
          finishAssistantMessage(s, msgId);
          const msg = getMsgById(s, msgId);
          if (msg) {
            out.push({
              type: 'messageUpdated',
              sessionId,
              messageId: msgId,
              content: msg.content.map((c) => ({ ...c })),
              status: 'completed',
            });
          }
        }
        break;
      }

      // -----------------------------------------------------------------------
      case 'agent.status.updated': {
        if (p?.model) s.model = p.model;
        if (p?.contextTokens !== undefined) s.contextTokens = p.contextTokens;
        if (p?.maxContextTokens !== undefined) s.contextLimit = p.maxContextTokens;

        // The activity edge maps the main turn's live phase onto this event.
        // Surface the retry backoff (provider 429/5xx etc.) so the working
        // indicator can say "retrying (n/max)" instead of looking stuck.
        const phase = p?.phase as Record<string, unknown> | null | undefined;
        if (phase !== undefined && phase !== null && phase['kind'] === 'retrying') {
          s.retryActive = true;
          out.push({
            type: 'turnRetry',
            sessionId,
            retry: {
              failedAttempt: numberField(phase, 'failedAttempt') ?? 0,
              nextAttempt: numberField(phase, 'nextAttempt') ?? 0,
              maxAttempts: numberField(phase, 'maxAttempts') ?? 0,
              delayMs: numberField(phase, 'delayMs') ?? 0,
              errorName: stringField(phase, 'errorName'),
              statusCode: numberField(phase, 'statusCode'),
              turnId: numberField(phase, 'turnId'),
            },
          });
        } else if (
          s.retryActive &&
          phase !== undefined &&
          phase !== null &&
          typeof phase['kind'] === 'string'
        ) {
          // Only an explicit non-retrying phase clears the backoff; routine
          // status frames (model/context/usage) carry no phase and must not
          // extinguish a live retry.
          s.retryActive = false;
          out.push({ type: 'turnRetry', sessionId, retry: undefined });
        }

        out.push({
          type: 'sessionUsageUpdated',
          sessionId,
          usage: buildUsageSnapshot(s),
          // Carry the live model so the status bar shows the real running model
          // instead of falling back to the daemon's (empty) REST model.
          model: s.model || undefined,
          swarmMode: p?.swarmMode === true ? true : p?.swarmMode === false ? false : undefined,
          // The agent reports plan mode here too (e.g. it auto-entered plan mode
          // for a "make a plan" prompt). Carry it so the composer's plan toggle
          // reflects the agent's real state, not just the user's manual choice.
          planMode: p?.planMode === true ? true : p?.planMode === false ? false : undefined,
          // The session's own thinking level, so per-session state stays in sync
          // across clients (same treatment as plan/swarm above).
          thinking:
            typeof p?.thinkingEffort === 'string' && p.thinkingEffort.length > 0
              ? p.thinkingEffort
              : undefined,
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.ended': {
        const msgId = s.currentAssistantMsgId;
        const reason: string = p?.reason ?? 'completed';
        const durationMs = numberField(p ?? {}, 'durationMs');
        // Which prompt this turn served — recorded so the web layer can tell
        // an active-turn abort (prompt already ended with this turn) from a
        // queued abort (no turn ever started) when prompt.aborted arrives.
        const turnId: number | undefined = p?.turnId;
        const turnPromptId: string | undefined =
          (turnId !== undefined ? s.turnPromptId.get(turnId) : undefined) ?? s.currentPromptId;

        // Main-conversation liveness: the prompt this turn served is done.
        // This — not the session-busy status — is what ends the working indicator.
        // It MUST be emitted first in this arm: the onMainTurnEnd side effect
        // gates on `seq > lastSeqBySession`, and sibling events in this arm
        // advance that cursor — emitted after them, this event would compare
        // equal and the prompt-finish cleanup (indicator, queue drain) would never
        // fire (observed: indicator stuck when a turn ends with background tasks
        // still running, where no work_changed(busy:false) fallback exists).
        out.push({
          type: 'turnActiveChanged',
          sessionId,
          active: false,
          reason: p?.reason,
          promptId: turnPromptId,
        });

        if (msgId) {
          finishAssistantMessage(s, msgId);
          const msg = getMsgById(s, msgId);
          if (msg) {
            out.push({
              type: 'messageUpdated',
              sessionId,
              messageId: msgId,
              content: msg.content.map((c) => ({ ...c })),
              status: reason === 'failed' || reason === 'blocked' ? 'error' : 'completed',
              durationMs,
            });
          }
        }

        s.turnCount++;

        // No busy projection here — see turn.started. The daemon's
        // `event.session.work_changed` flips the session busy fact.

        // Clear per-turn state. Reset the stream offsets too so a stale length
        // from this turn can't wedge the next turn's delta alignment into a
        // silent skip if its turn.started is missed across a reconnect. The
        // retry reuse target is per-turn as well: if the turn died between
        // turn.step.retrying and the retried step.started, the next prompt
        // must open a fresh bubble, not refill this turn's emptied one.
        s.currentAssistantMsgId = undefined;
        s.currentPromptId = undefined;
        s.turnTextLen = 0;
        s.turnThinkLen = 0;
        s.retryReuseMsgId = undefined;
        // The turn's transcript now lives only in the reducer — release the
        // projector's copies (empties the log: no live ids remain).
        trimSessionLog(s);
        break;
      }

      // -----------------------------------------------------------------------
      case 'prompt.completed': {
        // No state change at AppEvent level — turn.ended / the session
        // status_changed ahead of this event already finished the prompt. The
        // event rides along so the web layer can spot the one case that has no
        // turn-level signal: a prompt blocked before any turn started (reason
        // 'blocked'), which would otherwise pin the in-flight state forever.
        const promptId: string | undefined = p?.promptId;
        if (typeof promptId === 'string' && promptId.length > 0) {
          out.push({ type: 'promptCompleted', sessionId, promptId, reason: p?.reason ?? 'completed' });
        }
        break;
      }

      // -----------------------------------------------------------------------
      case 'prompt.aborted': {
        // Fires both for an active-turn abort (a turn.ended + status_changed
        // precede it — the prompt is already finished) and for a QUEUED prompt
        // that never started a turn (no turn events, no status flip). The web
        // layer keys on promptId to clear the in-flight state in the latter case.
        const promptId: string | undefined = p?.promptId;
        if (typeof promptId === 'string' && promptId.length > 0) {
          out.push({ type: 'promptAborted', sessionId, promptId });
        }
        break;
      }

      // -----------------------------------------------------------------------
      case 'turn.step.retrying': {
        // Drive the retry label from the raw step frame too — the
        // agent.status.updated phase is edge-synthesized and can be lost
        // across a reconnect window. Emitted first in the arm: same-frame
        // siblings share the seq and the reducer's freshness gate only
        // passes the first.
        s.retryActive = true;
        out.push({
          type: 'turnRetry',
          sessionId,
          retry: {
            failedAttempt: numberField(p ?? {}, 'failedAttempt') ?? 0,
            nextAttempt: numberField(p ?? {}, 'nextAttempt') ?? 0,
            maxAttempts: numberField(p ?? {}, 'maxAttempts') ?? 0,
            delayMs: numberField(p ?? {}, 'delayMs') ?? 0,
            errorName: stringField(p ?? {}, 'errorName'),
            statusCode: numberField(p ?? {}, 'statusCode'),
            turnId: typeof p?.turnId === 'number' ? p.turnId : undefined,
          },
        });
        // The step's stream restarts from offset 0. Reuse the abandoned
        // bubble instead of stacking a new one: strip its streamed parts and
        // keep the id in retryReuseMsgId so the retried step.started refills
        // it in place. Otherwise the failed attempt's partial bubble stays
        // rendered next to the retry's full stream — the "text/tool shown
        // twice" duplication (far more visible since the retry budget grew).
        const msgId = s.currentAssistantMsgId;
        if (msgId !== undefined) {
          const msg = getMsgById(s, msgId);
          if (msg !== undefined) {
            msg.content = msg.content.filter(
              (c) => c.type !== 'text' && c.type !== 'thinking' && c.type !== 'toolUse',
            );
            out.push({
              type: 'messageUpdated',
              sessionId,
              messageId: msgId,
              content: msg.content.map((c) => ({ ...c })),
              status: 'pending',
            });
            s.retryReuseMsgId = msgId;
          }
        }
        s.turnTextLen = 0;
        s.turnThinkLen = 0;
        s.toolStartTimes.clear();
        break;
      }

      case 'turn.step.interrupted': {
        // Discard current assistant message; next step.started will create a
        // new one. Drop any pending retry reuse target for the same reason.
        s.currentAssistantMsgId = undefined;
        s.retryReuseMsgId = undefined;
        trimSessionLog(s);
        break;
      }

      // -----------------------------------------------------------------------
      case 'subagent.spawned': {
        const taskId = typeof p?.subagentId === 'string' && p.subagentId.length > 0 ? p.subagentId : ulid('task_');
        // Patch-style: `subagent.started` and `task.started` can legitimately
        // land first (the daemon emits spawned only after task registration),
        // and a replayed spawned must never clobber a phase the stream already
        // advanced or a terminal state the reducer already settled. A
        // task.started that arrived with no agent id seeded a skeleton row
        // keyed by the bare task id — fold it in too (the reducer rekeys the
        // row via backgroundTaskId) instead of surfacing a second row.
        const wireTaskId = typeof p?.taskId === 'string' && p.taskId.length > 0 ? p.taskId : undefined;
        const skeleton = wireTaskId !== undefined && wireTaskId !== taskId
          ? s.subagentMeta.get(wireTaskId)
          : undefined;
        const agentRow = s.subagentMeta.get(taskId);
        if (skeleton !== undefined) s.subagentMeta.delete(wireTaskId!);
        // A spawned-carried task id is itself a registration confirmation (on
        // the new daemon spawned follows registration): remember its first
        // sighting so outdated replays can be told from new bindings.
        if (wireTaskId !== undefined && !s.registrationOrderByKey.has(wireTaskId)) {
          s.registrationOrderByKey.set(wireTaskId, ++s.registrationSeq);
        }
        // Both a skeleton and the agent row can legally exist (task.started,
        // then subagent.started, then the spawned): merge, keeping the
        // skeleton's daemon-stamped timing, its always-true background flag,
        // and its key as the row's task binding.
        const prev = agentRow === undefined || skeleton === undefined
          ? (agentRow ?? skeleton)
          : {
              ...agentRow,
              createdAt: skeleton.createdAt,
              startedAt: skeleton.startedAt ?? agentRow.startedAt,
              runInBackground: true,
              // Adopt the skeleton key as the binding only when the agent row
              // has none: a DIFFERENT existing binding means the skeleton is
              // a new registration, which the newRun check must see. The
              // kernel's task.terminated remains the authoritative terminal
              // for that new run, so a settled row here simply resets — an
              // agent-side settle can never be attributed safely (a replayed
              // old-run completion is indistinguishable from a new-run one).
              backgroundTaskId: agentRow.backgroundTaskId ?? wireTaskId,
            };
        // The lone skeleton's key is its binding too — a spawned carrying
        // that same id re-announces this run, not a new one.
        const prevBinding = prev?.backgroundTaskId
          ?? (prev !== undefined && wireTaskId !== undefined && prev.id === wireTaskId ? wireTaskId : undefined);
        // A spawned over a SETTLED row is a new run unless it re-announces
        // the SAME registered task (Agent resume registers a fresh task id;
        // swarm resume ships none at all): reset the run-scoped fields like a
        // fresh spawn, or the row would show the previous run's terminal
        // state forever. The meta can lag the reducer (a local cancel never
        // reaches it), so a changed binding counts even while the meta still
        // says running; only a running UNBOUND row gaining its first
        // registration is the same run and keeps its in-flight facts. A
        // taskless spawned over a settled row, or over a bound row the
        // re-opened started claimed, is that swarm/foreground resume — but an
        // old daemon's bare replay over its own running row is NOT (it has no
        // marker), so it patches instead of resetting.
        const incomingOrder = wireTaskId !== undefined
          ? s.registrationOrderByKey.get(wireTaskId)
          : undefined;
        const currentOrder = prevBinding !== undefined
          ? s.registrationOrderByKey.get(prevBinding)
          : undefined;
        // Only a binding CONFIRMED-older than the row's (both registered,
        // incoming older) is a stale replay: it neither resets nor re-binds.
        // An unseen binding (its registration not observed yet) stays a
        // candidate new run and binds at once. A binding this session already
        // retired is stale by definition.
        const confirmedStale = s.retiredBindings.has(wireTaskId ?? '')
          || (incomingOrder !== undefined
            && currentOrder !== undefined
            && incomingOrder < currentOrder);
        const newRun = prev !== undefined && (
          (wireTaskId === undefined && (prev.status !== 'running'
              ? true
              : prevBinding !== undefined && s.restartedThisRun.has(taskId)))
          || (wireTaskId !== undefined
              && wireTaskId !== prevBinding
              && !confirmedStale
              && !(prev.status === 'running' && prevBinding === undefined))
        );
        // A started that re-opened this run (phase working + the marker it
        // left — or simply no binding change at this spawned) owns the
        // timing/phase facts now. Only a RE-OPENING started marks: a bare
        // started continuing the current run needs no blessing, and a changed
        // binding without a marker means the working phase was the old run's.
        const startedThisRun = prev?.subagentPhase === 'working'
          && (wireTaskId === undefined || wireTaskId === prevBinding || s.restartedThisRun.has(taskId));
        if (newRun) {
          s.restartedThisRun.delete(taskId);
          // The replaced binding is retired: no replay may re-adopt it (the
          // old run's late task.terminated would otherwise hit this row).
          if (prevBinding !== undefined && prevBinding !== wireTaskId) {
            s.retiredBindings.add(prevBinding);
          }
        }
        const task: AppTask = {
          id: taskId,
          agentId: prev?.agentId ?? taskId,
          sessionId,
          kind: 'subagent',
          description: typeof p?.description === 'string' ? p.description : p?.subagentName ?? prev?.description ?? t('tasks.dockSubagent'),
          status: newRun ? 'running' : (prev?.status ?? 'running'),
          createdAt: newRun && !startedThisRun
            ? new Date().toISOString()
            : (prev?.createdAt ?? new Date().toISOString()),
          startedAt: newRun && !startedThisRun ? undefined : prev?.startedAt,
          completedAt: newRun ? undefined : prev?.completedAt,
          completedAtEstimated: newRun ? undefined : prev?.completedAtEstimated,
          subagentPhase: newRun
            ? (startedThisRun ? 'working' : 'queued')
            : (prev?.subagentPhase ?? 'queued'),
          subagentType: typeof p?.subagentName === 'string' ? p.subagentName : prev?.subagentType,
          // Newer cores report the display-normalized bound alias here.
          model: typeof p?.model === 'string' && p.model.length > 0 ? p.model : prev?.model,
          thinkingEffort:
            typeof p?.thinkingEffort === 'string' && p.thinkingEffort.length > 0
              ? p.thinkingEffort
              : prev?.thinkingEffort,
          parentToolCallId: typeof p?.parentToolCallId === 'string' ? p.parentToolCallId : prev?.parentToolCallId,
          swarmIndex: typeof p?.swarmIndex === 'number' ? p.swarmIndex : prev?.swarmIndex,
          // A new run takes its background mode from the event when stated —
          // a settled background agent resumed in the foreground must not
          // stay pinned to the dock by the previous run's flag; an OMITTED
          // flag falls back to the freshest registration fact (the fold
          // already merged the new skeleton's mode into prev).
          runInBackground: newRun
            ? p?.runInBackground === true || (p?.runInBackground === undefined && prev?.runInBackground === true)
            : p?.runInBackground === true || prev?.runInBackground === true,
          outputPreview: newRun ? undefined : prev?.outputPreview,
          outputBytes: newRun ? undefined : prev?.outputBytes,
          outputLines: newRun ? undefined : prev?.outputLines,
          suspendedReason: newRun ? undefined : prev?.suspendedReason,
          text: newRun ? undefined : prev?.text,
          // Newer daemons attach the background-task id the run registered
          // under, so cancel works before `task.started` lands; keep the
          // earlier binding when the field is absent — and never regress it
          // to an outdated replayed one.
          backgroundTaskId: confirmedStale
            ? prev?.backgroundTaskId
            : newRun
              ? wireTaskId
              : (wireTaskId ?? prev?.backgroundTaskId),
        };
        s.subagentMeta.set(task.id, task);
        out.push({
          type: 'taskCreated',
          sessionId,
          task,
        });
        break;
      }

      case 'subagent.started': {
        // A started over a SETTLED row opens a new lifecycle (a taskless
        // resume fires started before its spawned) — reset the run-scoped
        // fields or the previous run's result would show through this one.
        // A replay keeps them: the terminal event that always follows
        // re-settles the row.
        const subagentId = typeof p?.subagentId === 'string' ? p.subagentId : undefined;
        const restarting = subagentId !== undefined
          && ((s.subagentMeta.get(subagentId)?.status !== undefined
            && s.subagentMeta.get(subagentId)!.status !== 'running')
            || s.settledByKernel.has(subagentId));
        if (restarting) s.settledByKernel.delete(subagentId);
        const task = patchSubagent(t, s, sessionId, p?.subagentId, {
          subagentPhase: 'working',
          status: 'running',
          startedAt: new Date().toISOString(),
          // Back to work: the suspension's reason is spent (a spawned REPLAY
          // while still suspended keeps it, via the spawned patch path).
          suspendedReason: undefined,
          ...(restarting
            ? {
                createdAt: new Date().toISOString(),
                completedAt: undefined,
                completedAtEstimated: undefined,
                outputPreview: undefined,
                outputBytes: undefined,
                outputLines: undefined,
                text: undefined,
              }
            : {}),
        });
        // A started over a settled row marks the re-opened lifecycle (a
        // started without an observed settle is just the current run
        // continuing — its working phase needs no blessing later).
        if (restarting && subagentId !== undefined) s.restartedThisRun.add(subagentId);
        if (task) out.push({ type: 'taskCreated', sessionId, task });
        break;
      }

      case 'subagent.suspended': {
        const task = patchSubagent(t, s, sessionId, p?.subagentId, {
          subagentPhase: 'suspended',
          status: 'running',
          suspendedReason: typeof p?.reason === 'string' ? p.reason : undefined,
        });
        if (task) out.push({ type: 'taskCreated', sessionId, task });
        break;
      }

      case 'subagent.completed': {
        const outputPreview = typeof p?.resultSummary === 'string' ? p.resultSummary : undefined;
        const task = patchSubagent(t, s, sessionId, p?.subagentId, {
          subagentPhase: 'completed',
          status: 'completed',
          // Client-observed stamp (replays included) — sort-only until REST
          // delivers the daemon's real completed_at.
          completedAt: new Date().toISOString(),
          completedAtEstimated: true,
          outputPreview,
        });
        if (task) out.push({ type: 'taskCreated', sessionId, task });
        if (task !== null) s.restartedThisRun.delete(task.id);
        out.push({
          type: 'taskCompleted',
          sessionId,
          taskId: p?.subagentId ?? '',
          status: 'completed',
          outputPreview,
        });
        break;
      }

      case 'subagent.failed': {
        const outputPreview = typeof p?.error === 'string' ? p.error : undefined;
        const task = patchSubagent(t, s, sessionId, p?.subagentId, {
          subagentPhase: 'failed',
          status: 'failed',
          // Same observed-stamp rule as the completed path above.
          completedAt: new Date().toISOString(),
          completedAtEstimated: true,
          outputPreview,
        });
        if (task) out.push({ type: 'taskCreated', sessionId, task });
        if (task !== null) s.restartedThisRun.delete(task.id);
        out.push({
          type: 'taskCompleted',
          sessionId,
          taskId: p?.subagentId ?? '',
          status: 'failed',
          outputPreview,
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'error': {
        // Fold into an unknown event so the reducer surfaces it as a structured
        // error notice (semantic title + code/status/requestId details). The
        // wire payload already carries name/details/retryable — pass them
        // through untouched; the reducer decides what to display.
        out.push({
          type: 'unknown',
          raw: {
            _agentError: true,
            code: p?.code,
            message: p?.message,
            name: p?.name,
            details: p?.details,
            retryable: p?.retryable,
          },
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'task.notified': {
        // A background task's settlement notification IS broadcast (unlike the
        // persisted <notification> message, which only lands on reload).
        // Rebuild the XML block and synthesize the hidden user message so the
        // notification card shows live — mid-turn included, on the same parse
        // path as the snapshot copy. The id derives from sourceId + status so
        // a replay dedupes by id in the reducer.
        const notificationType = stringField(p ?? {}, 'notificationType');
        const sourceKind = stringField(p ?? {}, 'sourceKind');
        const sourceId = stringField(p ?? {}, 'sourceId');
        if (!notificationType || !sourceKind || !sourceId) break;
        const status = notificationType.startsWith('task.')
          ? notificationType.slice('task.'.length)
          : notificationType;
        const notificationId = `task:${sourceId}:${status}`;
        const escapeXml = (v: string) =>
          v.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
        const title = stringField(p ?? {}, 'title') ?? '';
        const severity = stringField(p ?? {}, 'severity') ?? '';
        const body = stringField(p ?? {}, 'body') ?? '';
        const text =
          `<notification id="${notificationId}" category="task" type="${escapeXml(notificationType)}" source_kind="${escapeXml(sourceKind)}" source_id="${escapeXml(sourceId)}">\n` +
          (title !== '' ? `Title: ${escapeXml(title)}\n` : '') +
          (severity !== '' ? `Severity: ${escapeXml(severity)}\n` : '') +
          (body !== '' ? `${escapeXml(body)}\n` : '') +
          `</notification>`;
        const msg: AppMessage = {
          id: `task_ntf_${notificationId}`,
          sessionId,
          role: 'user',
          content: [{ type: 'text', text }],
          createdAt: new Date().toISOString(),
          metadata: {
            origin: { kind: 'task', taskId: sourceId, status, notificationId },
          },
        };
        s.messages.push(msg);
        out.push({ type: 'messageCreated', message: cloneMessage(msg) });
        break;
      }

      // -----------------------------------------------------------------------
      case 'warning': {
        out.push({
          type: 'unknown',
          raw: { _agentWarning: true, message: p?.message },
        });
        break;
      }

      // -----------------------------------------------------------------------
      // Tasks (e.g. a detached Bash command). Real daemon shape:
      // payload.info = { taskId, description, status, startedAt(ms), endedAt,
      // kind:'process', command, pid, exitCode }.
      // `task.*` is the current wire name; `background.task.*` is the legacy
      // alias older daemons still emit — handle both.
      case 'task.started':
      case 'background.task.started': {
        const info = (p?.info ?? {}) as Record<string, unknown>;
        const startedAt =
          typeof info.startedAt === 'number' ? new Date(info.startedAt).toISOString() : undefined;
        const taskId =
          typeof info.taskId === 'string'
            ? info.taskId
            : typeof info.taskId === 'number'
              ? String(info.taskId)
              : ulid('task_');
        const description =
          typeof info.description === 'string'
            ? info.description
            : typeof info.command === 'string'
              ? info.command
              : t('tasks.defaultDescription');
        // A background subagent registers into the background-task store under
        // a fresh task id that differs from its agent id. Record the task id on
        // the existing WS-owned row (keyed by agent id) instead of adding a
        // second row — REST `/tasks` returns the same agent keyed by task id,
        // and keepLiveSubagents folds that copy into this row.
        if (info.kind === 'agent') {
          const agentId =
            typeof info.agentId === 'string' && info.agentId.length > 0
              ? info.agentId
              : undefined;
          if (agentId !== undefined) {
            const prevMeta = s.subagentMeta.get(agentId);
            // Reject a confirmed-outdated registration replay BEFORE touching
            // anything: it must neither re-bind the row back to the old task
            // nor refresh the old id's order to latest. An unseen id is new
            // (the journal never replays a pre-cursor registration).
            const incomingOrder = s.registrationOrderByKey.get(taskId);
            const currentOrder = prevMeta?.backgroundTaskId !== undefined
              ? s.registrationOrderByKey.get(prevMeta.backgroundTaskId!)
              : undefined;
            if (
              s.retiredBindings.has(taskId) ||
              (incomingOrder !== undefined &&
                currentOrder !== undefined &&
                incomingOrder < currentOrder)
            ) {
              if (prevMeta !== undefined) out.push({ type: 'taskCreated', sessionId, task: prevMeta });
              break;
            }
            if (!s.registrationOrderByKey.has(taskId)) {
              s.registrationOrderByKey.set(taskId, ++s.registrationSeq);
            }
            // Key by agent id even when the spawn event never reached this
            // client (subscribed late): later agent-scoped progress frames are
            // routed by agent id, and seeding subagentMeta here keeps them on
            // this one row instead of synthesizing a second one. A changed
            // task binding on a settled row is a new run (the resume fires
            // task.started before its spawned) — so is the FIRST binding of a
            // settled row (a foreground agent resumed into the background);
            // reset the lifecycle and outputs here or the later spawned can
            // no longer tell it from a replay. The meta can lag the reducer
            // (a local cancel never reaches it), so the check keys on the
            // binding, not the possibly-stale status. A RUNNING row gaining
            // its initial binding (spawned without a task id, registration
            // arriving mid-run) is the same run — keep its in-flight facts.
            const freshRegistration = prevMeta !== undefined
              && prevMeta.backgroundTaskId !== taskId
              && !(prevMeta.status === 'running' && prevMeta.backgroundTaskId === undefined);
            const task = patchSubagent(t, s, sessionId, agentId, {
              description,
              backgroundTaskId: taskId,
              runInBackground: true,
              // Any registration of a LIVE row IS a started run — stamp
              // working + the registration's start time even when the spawn
              // events were missed (freshRegistration resets further below).
              ...(prevMeta === undefined || prevMeta.status === 'running'
                ? {
                    status: 'running' as const,
                    subagentPhase: 'working' as const,
                    startedAt: prevMeta?.startedAt ?? startedAt,
                  }
                : {}),
              ...(freshRegistration
                ? {
                    status: 'running' as const,
                    // A fresh registration IS a started run (the new daemon
                    // emits subagent.started before it) — never queue it.
                    subagentPhase: 'working' as const,
                    createdAt: startedAt ?? new Date().toISOString(),
                    startedAt,
                    completedAt: undefined,
                    completedAtEstimated: undefined,
                    outputPreview: undefined,
                    outputBytes: undefined,
                    outputLines: undefined,
                    suspendedReason: undefined,
                    text: undefined,
                  }
                : {}),
            });
            if (task) out.push({ type: 'taskCreated', sessionId, task });
            s.restartedThisRun.delete(agentId);
          } else {
            // No agent id — nothing to link. The spawned of the new daemon
            // order (spawned → task.started) already keyed this run by its
            // agent id and bound THIS task id: re-emit that row instead of
            // adding a skeleton duplicate the reducer can never fold.
            const owner = [...s.subagentMeta.values()].find(
              (meta) => meta.backgroundTaskId === taskId,
            );
            if (owner === undefined &&
              (s.retiredBindings.has(taskId) ||
                (s.registrationOrderByKey.has(taskId) &&
                  s.registrationOrderByKey.get(taskId)! < s.registrationSeq))
            ) {
              // An already-seen, outdated id with no live owner (an old
              // replay after the binding moved on, or a retired one) must
              // not recreate a duplicate skeleton row.
              break;
            }
            if (owner !== undefined) {
              // Same registration facts as the agent-id branch: a registration
              // IS a started run — stamp working, not just the binding. An
              // omitted description stays the spawned's own instead of the
              // generic placeholder.
              const task = patchSubagent(t, s, sessionId, owner.agentId ?? owner.id, {
                description:
                  typeof info.description === 'string' || typeof info.command === 'string'
                    ? description
                    : owner.description,
                status: 'running',
                subagentPhase: 'working',
                runInBackground: true,
                startedAt: owner.startedAt ?? startedAt,
              });
              if (task) out.push({ type: 'taskCreated', sessionId, task });
              break;
            }
            // Otherwise key the row by the background task id so the REST
            // poll dedupes it. Seed subagentMeta too: a later spawned
            // carrying this task id folds the skeleton (and its
            // daemon-stamped timestamps) into the agent-keyed row.
            const skeleton: AppTask = {
              id: taskId,
              sessionId,
              kind: 'subagent',
              description,
              status: 'running',
              createdAt: startedAt ?? new Date().toISOString(),
              startedAt,
              // A registration IS a started run (see the agent-id branch) —
              // even when its started frame was missed entirely.
              subagentPhase: 'working',
              runInBackground: true,
            };
            s.subagentMeta.set(taskId, skeleton);
            if (!s.registrationOrderByKey.has(taskId)) {
              s.registrationOrderByKey.set(taskId, ++s.registrationSeq);
            }
            out.push({
              type: 'taskCreated',
              sessionId,
              task: skeleton,
            });
          }
          break;
        }
        const command = typeof info.command === 'string' ? info.command : undefined;
        out.push({
          type: 'taskCreated',
          sessionId,
          task: {
            id: taskId,
            sessionId,
            kind: 'bash',
            description,
            command,
            status: 'running',
            createdAt: startedAt ?? new Date().toISOString(),
            startedAt,
            outputPreview: command !== undefined ? `$ ${command}` : undefined,
          },
        });
        break;
      }
      case 'task.terminated':
      case 'background.task.terminated': {
        const info = (p?.info ?? {}) as Record<string, unknown>;
        // info.status is the kernel vocabulary (completed/failed/timed_out/
        // killed/lost): killed means the user cancelled — mapping it to
        // 'completed' would paint a stopped task as a success.
        const failed =
          info.status === 'failed' ||
          info.status === 'timed_out' ||
          info.status === 'lost' ||
          (typeof info.exitCode === 'number' && info.exitCode !== 0);
        // The kernel settles the reducer row without touching the meta — a
        // resume must be able to tell this row is done (see restarting).
        if (info.kind === 'agent' && typeof info.agentId === 'string' && info.agentId.length > 0) {
          s.settledByKernel.add(info.agentId);
        }
        out.push({
          type: 'taskCompleted',
          sessionId,
          taskId:
            typeof info.taskId === 'string'
              ? info.taskId
              : typeof info.taskId === 'number'
                ? String(info.taskId)
                : '',
          status: info.status === 'killed' ? 'cancelled' : failed ? 'failed' : 'completed',
          // Do NOT set outputPreview here. The command is already kept on the
          // task as `command`; setting outputPreview to `$ <command>` would
          // clobber any real output captured by polling and prevents the UI
          // from fetching the final terminal output after the task finishes.
        });
        break;
      }

      // -----------------------------------------------------------------------
      case 'cron.fired': {
        // A scheduled reminder fired into the session. agent-core persists the
        // injected user message (so a refresh renders it via messagesToTurns),
        // but turn.steer() does NOT broadcast a prompt.submitted / message.created
        // for it — synthesize one here so the notice shows up live too. A later
        // snapshot reload replaces the message log wholesale, so this synthesized
        // copy never duplicates the persisted one. The promptId is intentionally
        // omitted: the web client caches every user message's promptId into
        // promptIdBySession for Stop/abort, and a synthetic id the daemon would
        // reject would clobber the real active promptId. The reducer already skips
        // optimistic-echo reconciliation for cron-origin messages, so no promptId
        // is needed for de-dup either.
        const origin = p?.origin;
        const promptText = stringField(p ?? {}, 'prompt');
        if (
          origin &&
          typeof origin === 'object' &&
          (origin as Record<string, unknown>)['kind'] === 'cron_job' &&
          promptText
        ) {
          const msg: AppMessage = {
            id: ulid('cron_'),
            sessionId,
            role: 'user',
            content: [{ type: 'text', text: promptText }],
            createdAt: new Date().toISOString(),
            metadata: { origin: origin as Record<string, unknown> },
          };
          s.messages.push(msg);
          out.push({ type: 'messageCreated', message: cloneMessage(msg) });
        }
        break;
      }

      // -----------------------------------------------------------------------
      default:
        // Unknown future events — safe no-op
        break;
    }

    return out;
  }

  return { project, bindNextPromptId, seedInFlight, reset, forgetSession, retainedMessageCount, markSideChannelAgent };
}
