import { isUndoAnchor, type ContextMessage } from '@moonshot-ai/agent-core-v2';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';

import type {
  AgentRef,
  CompactionItem,
  ConversationError,
  ConversationItem,
  ConversationStep,
  ConversationTurn,
  ConversationTurnOutcome,
  ReasoningItem,
  ToolCallItem,
  ToolInteraction,
} from '../../protocol/conversation';
import { projectOrigin, projectToolResultOutput, projectUserContent } from '../messages/messageProjection';

interface PendingPrompt {
  readonly turnNumber?: number;
  readonly promptId?: string;
  readonly originKind?: string;
}

interface PendingToolPatch {
  interaction?: ToolInteraction;
  agent_refs?: AgentRef[];
}

interface UndoAnchor {
  readonly turnId: string;
  readonly itemCount: number;
  readonly stepCount: number;
}

export interface ConversationState {
  turns: ConversationTurn[];
  nextOrdinal: number;
  openTurnId?: string;
  pendingPrompt?: PendingPrompt;
  pendingSteers: number;
  anchors: UndoAnchor[];
  implicitlyEnded: Record<string, true>;
  provisionalOutcomes: Record<string, ConversationTurnOutcome>;
  toolTurns: Record<string, string>;
  pendingTools: Record<string, PendingToolPatch>;
  interactionTools: Record<string, string>;
  stepParts: Record<string, number>;
  compaction?: { readonly turnId: string; readonly itemId: string };
}

export function createConversationState(): ConversationState {
  return {
    turns: [],
    nextOrdinal: 0,
    pendingSteers: 0,
    anchors: [],
    implicitlyEnded: {},
    provisionalOutcomes: {},
    toolTurns: {},
    pendingTools: {},
    interactionTools: {},
    stepParts: {},
  };
}

const TASK_ORIGIN_KINDS: ReadonlySet<string> = new Set(['task', 'background_task', 'task_notification']);
const TURN_OPENING_SYSTEM_TRIGGERS: ReadonlySet<string> = new Set(['goal_continuation', 'subagent']);

export function applyConversationRecord(state: ConversationState, record: WireRecord): void {
  const time = typeof record['time'] === 'number' ? isoTime(record['time']) : undefined;
  switch (record.type) {
    case 'turn.prompt':
      state.pendingPrompt = {
        turnNumber: numberField(record['turnId']),
        promptId: stringField(record['promptId']),
        originKind: stringField((record['origin'] as { kind?: unknown } | undefined)?.kind),
      };
      return;
    case 'context.append_message':
      applyMessage(state, record['message'] as ContextMessage, time);
      return;
    case 'context.append_loop_event':
      applyLoopEvent(state, record['event'] as LoopRecord, time);
      return;
    case 'turn.steer':
      applySteer(state, record);
      return;
    case 'turn.cancel':
      markProvisionalOutcome(state, record['turnId'], 'cancelled');
      return;
    case 'turn.step.interrupted':
      markProvisionalOutcome(state, record['turnId'], record['reason'] === 'error' ? 'failed' : 'cancelled');
      return;
    case 'turn.ended':
      applyTurnEnded(state, record, time);
      return;
    case 'prompt.completed':
      if (record['reason'] === 'blocked') applyPromptBlocked(state, stringField(record['promptId']), time);
      return;
    case 'interaction.request':
      applyInteractionRequest(state, record);
      return;
    case 'interaction.resolved':
      applyInteractionResolved(state, record);
      return;
    case 'subagent.spawned':
      applySubagentSpawned(state, record);
      return;
    case 'full_compaction.begin':
      beginCompaction(state, record['source'] === 'manual' ? 'manual' : 'auto', time);
      return;
    case 'context.apply_compaction':
      applyCompactionSummary(state, record, time);
      return;
    case 'full_compaction.complete':
      endCompaction(state, 'completed', time);
      return;
    case 'full_compaction.cancel':
      endCompaction(state, 'cancelled', time);
      return;
    case 'context.clear':
      clearConversation(state);
      return;
    case 'context.undo': {
      const count = numberField(record['count']);
      if (count !== undefined && count > 0) undoConversationTurns(state, count);
      return;
    }
  }
}

export interface RunningWork {
  readonly turnNumber?: number;
  readonly compacting?: boolean;
}

export function settleOrphanTurns(state: ConversationState, running: RunningWork = {}): ConversationState {
  const live = (turn: ConversationTurn): boolean =>
    turn.kind === 'system'
      ? running.compacting === true
      : turn.turn_number !== undefined && turn.turn_number === running.turnNumber;
  const orphaned = (turn: ConversationTurn): boolean => turn.status === 'running' && !live(turn);
  if (!state.turns.some(orphaned)) return state;
  const next: ConversationState = { ...state, turns: [...state.turns], provisionalOutcomes: { ...state.provisionalOutcomes } };
  next.turns.forEach((turn, index) => {
    if (!orphaned(turn)) return;
    const settled: ConversationTurn = { ...turn, items: turn.items.map((item) => ({ ...item })) };
    next.turns[index] = settled;
    endTurn(next, settled, 'interrupted', undefined);
    if (next.compaction?.turnId === settled.turn_id) next.compaction = undefined;
  });
  return next;
}

export function undoConversationTurns(state: ConversationState, count: number): ConversationState {
  const anchor = state.anchors.at(-count);
  if (anchor === undefined) return state;
  state.anchors.splice(state.anchors.length - count);
  const anchorIndex = state.turns.findIndex((turn) => turn.turn_id === anchor.turnId);
  if (anchorIndex === -1) return state;
  if (anchor.itemCount > 0) {
    const turn = state.turns[anchorIndex]!;
    turn.items.splice(anchor.itemCount);
    turn.steps.splice(anchor.stepCount);
  }
  const cutIndex = anchor.itemCount > 0 ? anchorIndex + 1 : anchorIndex;
  const removed = new Set(state.turns.splice(cutIndex).map((turn) => turn.turn_id));
  if (state.openTurnId !== undefined && removed.has(state.openTurnId)) state.openTurnId = undefined;
  if (state.compaction !== undefined && removed.has(state.compaction.turnId)) state.compaction = undefined;
  state.pendingPrompt = undefined;
  state.pendingSteers = 0;
  return state;
}

type LoopRecord =
  | { readonly type: 'step.begin'; readonly uuid: string; readonly turnId?: string; readonly step?: number }
  | {
      readonly type: 'step.end';
      readonly uuid: string;
      readonly turnId?: string;
      readonly finishReason?: string;
      readonly usage?: Record<string, number>;
    } & Record<string, unknown>
  | {
      readonly type: 'content.part';
      readonly stepUuid: string;
      readonly part: ContentPart;
      readonly block?: number;
      readonly startedAt?: number;
      readonly durationMs?: number;
      readonly turnId?: string;
      readonly step?: number;
    }
  | {
      readonly type: 'tool.call';
      readonly stepUuid: string;
      readonly toolCallId: string;
      readonly name: string;
      readonly args?: unknown;
      readonly display?: unknown;
      readonly turnId?: string;
      readonly step?: number;
    }
  | {
      readonly type: 'tool.result';
      readonly toolCallId: string;
      readonly result: {
        readonly output: string | readonly ContentPart[];
        readonly isError?: boolean;
        readonly durationMs?: number;
      };
    };

const LLM_TIMING_FIELDS = [
  'llmFirstTokenLatencyMs',
  'llmStreamDurationMs',
  'llmRequestBuildMs',
  'llmServerFirstTokenMs',
  'llmServerDecodeMs',
  'llmClientConsumeMs',
  'llmClientBlockedMs',
] as const;

function applyMessage(state: ConversationState, message: ContextMessage | undefined, time: string | undefined): void {
  if (message === undefined) return;
  if (message.role === 'assistant') {
    applyLegacyAssistant(state, message, time);
    return;
  }
  if (message.role === 'tool') {
    applyLegacyToolResult(state, message);
    return;
  }
  if (message.role !== 'user') return;
  const origin = message.origin;
  const kind: string | undefined = origin?.kind;
  if (kind === 'injection') return;
  const pending = state.pendingPrompt;
  if (
    pending !== undefined &&
    ((pending.promptId !== undefined && message.id !== undefined && pending.promptId !== message.id) ||
      (pending.originKind !== undefined && pending.originKind !== (kind ?? 'user')))
  ) {
    state.pendingPrompt = undefined;
  }
  if (kind === 'compaction_summary') {
    appendLegacyCompaction(state, textOf(message.content), time);
    return;
  }
  const steered = state.pendingSteers > 0;
  if (steered) state.pendingSteers -= 1;
  const trigger = (origin as { trigger?: unknown } | undefined)?.trigger;
  if ((kind === 'skill_activation' || kind === 'plugin_command') && trigger !== 'user-slash') return;
  const notification = kind !== undefined && TASK_ORIGIN_KINDS.has(kind);
  const open = openTurn(state);
  if (notification && (state.pendingPrompt === undefined || steered)) {
    const turn = open ?? startTurn(state, time);
    turn.items.push(notificationItem(turn, message));
    if (open === undefined) endTurn(state, turn, 'completed', time);
    return;
  }
  const inTurn = origin !== undefined && 'inTurn' in origin && origin.inTurn === true;
  if (inTurn || (steered && state.pendingPrompt === undefined && open !== undefined)) {
    const turn = open ?? startTurn(state, time);
    if (isUndoAnchor(message)) state.anchors.push({ turnId: turn.turn_id, itemCount: turn.items.length, stepCount: turn.steps.length });
    turn.items.push({
      type: 'user_message',
      item_id: message.id ?? nextItemId(turn),
      status: 'ended',
      placement: 'steer',
      prompt_ids: message.id === undefined ? [] : [message.id],
      origin: projectOrigin(origin),
      content: projectUserContent(message),
      created_at: time,
    });
    return;
  }
  if ((kind === 'system_trigger' || kind === 'retry') && state.pendingPrompt === undefined) {
    const name = (origin as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || !TURN_OPENING_SYSTEM_TRIGGERS.has(name)) return;
  }
  const promptId = message.id ?? state.pendingPrompt?.promptId;
  const turn = startTurn(state, time);
  if (isUndoAnchor(message)) state.anchors.push({ turnId: turn.turn_id, itemCount: 0, stepCount: 0 });
  if (notification) {
    turn.items.push(notificationItem(turn, message));
    return;
  }
  turn.items.push({
    type: 'user_message',
    item_id: promptId ?? nextItemId(turn),
    status: 'ended',
    placement: 'opener',
    prompt_ids: promptId === undefined ? [] : [promptId],
    origin: projectOrigin(origin),
    content: projectUserContent(message),
    created_at: time,
  });
}

function notificationItem(turn: ConversationTurn, message: ContextMessage): ConversationItem {
  return {
    type: 'notification',
    item_id: message.id ?? nextItemId(turn),
    status: 'ended',
    origin: projectOrigin(message.origin),
    text: textOf(message.content),
  };
}

function applyLegacyAssistant(
  state: ConversationState,
  message: Extract<ContextMessage, { role: 'assistant' }>,
  time: string | undefined,
): void {
  const turn = openTurn(state) ?? startTurn(state, time);
  for (const part of message.content) {
    const item = contentItem(part, nextItemId(turn), undefined);
    if (item !== undefined) turn.items.push(item);
  }
  for (const call of message.toolCalls ?? []) {
    upsertToolCall(state, turn, {
      type: 'tool_call',
      item_id: call.id,
      status: 'running',
      name: call.name,
      input: parseArguments(call.arguments),
      display: message.toolCallDisplays?.[call.id],
    });
  }
}

function applyLegacyToolResult(
  state: ConversationState,
  message: Extract<ContextMessage, { role: 'tool' }>,
): void {
  const found = findToolCall(state, message.toolCallId);
  if (found === undefined) return;
  found.item.status = 'ended';
  found.item.output = toolOutput(message.content);
  if (message.isError === true) found.item.is_error = true;
}

function applyLoopEvent(state: ConversationState, event: LoopRecord | undefined, time: string | undefined): void {
  if (event === undefined) return;
  switch (event.type) {
    case 'step.begin': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      turn.steps.push({ step_id: event.uuid, index: event.step ?? turn.steps.length + 1, started_at: time });
      return;
    }
    case 'step.end': {
      delete state.stepParts[event.uuid];
      const step = findStep(state, event.uuid);
      if (step === undefined) return;
      step.ended_at = time;
      if (event.finishReason !== undefined) step.finish_reason = event.finishReason;
      if (event.usage !== undefined) step.usage = { ...event.usage };
      const timing: Record<string, number> = {};
      for (const field of LLM_TIMING_FIELDS) {
        const value = event[field];
        if (typeof value === 'number') timing[field] = value;
      }
      if (Object.keys(timing).length > 0) step.llm_timing = timing;
      return;
    }
    case 'content.part': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      const position = state.stepParts[event.stepUuid] ?? 0;
      state.stepParts[event.stepUuid] = position + 1;
      const stepStart = findStep(state, event.stepUuid)?.started_at;
      const item = contentItem(event.part, `${event.stepUuid}:${event.block ?? position}`, event.step, {
        started_at: event.startedAt === undefined ? stepStart : isoTime(event.startedAt),
        duration_ms: event.durationMs ?? elapsedMs(stepStart, time),
      });
      if (item !== undefined) upsertItem(turn, item);
      return;
    }
    case 'tool.call': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      upsertToolCall(state, turn, {
        type: 'tool_call',
        item_id: event.toolCallId,
        status: 'running',
        step_index: event.step,
        name: event.name,
        input: event.args,
        display: event.display,
      });
      return;
    }
    case 'tool.result': {
      const found = findToolCall(state, event.toolCallId);
      if (found === undefined) return;
      found.item.status = 'ended';
      found.item.output = toolOutput(event.result.output);
      if (event.result.isError === true) found.item.is_error = true;
      if (event.result.durationMs !== undefined) found.item.duration_ms = event.result.durationMs;
      return;
    }
  }
}

function applySteer(state: ConversationState, record: WireRecord): void {
  const messageId = stringField(record['messageId']);
  if (messageId === undefined) {
    state.pendingSteers += 1;
    return;
  }
  const promptIds = record['promptIds'];
  if (!Array.isArray(promptIds)) return;
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const item = state.turns[index]!.items.find((candidate) => candidate.item_id === messageId);
    if (item?.type !== 'user_message') continue;
    item.prompt_ids = promptIds.filter((id): id is string => typeof id === 'string');
    return;
  }
}

function markProvisionalOutcome(state: ConversationState, turnId: unknown, outcome: ConversationTurnOutcome): void {
  const turn = findTurnByNumber(state, numberField(turnId)) ?? unnumberedOpenTurn(state);
  if (turn !== undefined && turn.status === 'running') state.provisionalOutcomes[turn.turn_id] = outcome;
}

function applyTurnEnded(state: ConversationState, record: WireRecord, time: string | undefined): void {
  const turnNumber = numberField(record['turnId']);
  const turn = findTurnByNumber(state, turnNumber) ?? unnumberedOpenTurn(state);
  if (turn === undefined) return;
  if (turn.turn_number === undefined && turnNumber !== undefined) turn.turn_number = turnNumber;
  const reason = record['reason'];
  endTurn(state, turn, isOutcome(reason) ? reason : 'completed', time);
  delete state.implicitlyEnded[turn.turn_id];
  const durationMs = numberField(record['durationMs']);
  if (durationMs !== undefined) turn.duration_ms = durationMs;
  const error = projectError(record['error'], stringField(record['requestId']));
  if (error !== undefined) turn.error = error;
}

function applyPromptBlocked(state: ConversationState, promptId: string | undefined, time: string | undefined): void {
  if (promptId === undefined) return;
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index]!;
    const opener = turn.items[0];
    if (opener?.type !== 'user_message' || !opener.prompt_ids.includes(promptId)) continue;
    if (turn.status === 'running') endTurn(state, turn, 'blocked', time);
    return;
  }
}

function applyInteractionRequest(state: ConversationState, record: WireRecord): void {
  const toolCallId = stringField(record['toolCallId']);
  const id = stringField(record['id']);
  const kind = record['kind'];
  if (toolCallId === undefined || id === undefined) return;
  if (kind !== 'approval' && kind !== 'question' && kind !== 'user_tool') return;
  state.interactionTools[id] = toolCallId;
  patchTool(state, toolCallId, (patch) => {
    patch.interaction = { interaction_id: id, kind, status: 'pending', request: record['request'] };
  });
}

function applyInteractionResolved(state: ConversationState, record: WireRecord): void {
  const id = stringField(record['id']);
  if (id === undefined) return;
  const toolCallId = state.interactionTools[id];
  if (toolCallId === undefined) return;
  delete state.interactionTools[id];
  patchTool(state, toolCallId, (patch) => {
    if (patch.interaction === undefined) return;
    patch.interaction = { ...patch.interaction, status: 'ended', response: record['response'] };
  });
}

function applySubagentSpawned(state: ConversationState, record: WireRecord): void {
  const toolCallId = stringField(record['parentToolCallId']);
  const agentId = stringField(record['subagentId']);
  if (toolCallId === undefined || agentId === undefined) return;
  const ref: AgentRef = {
    agent_id: agentId,
    name: stringField(record['subagentName']),
    description: stringField(record['description']),
    swarm_index: numberField(record['swarmIndex']),
    run_in_background: typeof record['runInBackground'] === 'boolean' ? record['runInBackground'] : undefined,
  };
  patchTool(state, toolCallId, (patch) => {
    const refs = (patch.agent_refs ?? []).filter((existing) => existing.agent_id !== agentId);
    patch.agent_refs = [...refs, ref];
  });
}

function beginCompaction(state: ConversationState, trigger: 'manual' | 'auto', time: string | undefined): void {
  const turn = openTurn(state) ?? startTurn(state, time, 'system');
  const item: CompactionItem = { type: 'compaction', item_id: nextItemId(turn), status: 'running', trigger };
  turn.items.push(item);
  state.compaction = { turnId: turn.turn_id, itemId: item.item_id };
}

function applyCompactionSummary(state: ConversationState, record: WireRecord, time: string | undefined): void {
  const summary = compactionSummaryText(record['summary']) ?? stringField(record['contextSummary']);
  const running = runningCompaction(state);
  if (running === undefined) {
    appendLegacyCompaction(state, summary, time);
    return;
  }
  if (summary !== undefined) running.item.summary = summary;
  const before = numberField(record['tokensBefore']);
  const after = numberField(record['tokensAfter']);
  if (before !== undefined) running.item.tokens_before = before;
  if (after !== undefined) running.item.tokens_after = after;
}

function endCompaction(state: ConversationState, outcome: 'completed' | 'cancelled', time: string | undefined): void {
  const running = runningCompaction(state);
  state.compaction = undefined;
  if (running === undefined) return;
  running.item.status = 'ended';
  running.item.outcome = outcome;
  if (running.turn.kind === 'system') endTurn(state, running.turn, outcome, time);
}

function appendLegacyCompaction(state: ConversationState, summary: string | undefined, time: string | undefined): void {
  const open = openTurn(state);
  const turn = open ?? startTurn(state, time, 'system');
  turn.items.push({
    type: 'compaction',
    item_id: nextItemId(turn),
    status: 'ended',
    outcome: 'completed',
    summary,
  });
  if (open === undefined) endTurn(state, turn, 'completed', time);
}

function runningCompaction(state: ConversationState): { turn: ConversationTurn; item: CompactionItem } | undefined {
  const current = state.compaction;
  if (current === undefined) return undefined;
  const turn = findTurn(state, current.turnId);
  const item = turn?.items.find((candidate) => candidate.item_id === current.itemId);
  if (turn === undefined || item?.type !== 'compaction') return undefined;
  return { turn, item };
}

function clearConversation(state: ConversationState): void {
  state.turns = [];
  state.openTurnId = undefined;
  state.pendingPrompt = undefined;
  state.pendingSteers = 0;
  state.anchors = [];
  state.implicitlyEnded = {};
  state.provisionalOutcomes = {};
  state.toolTurns = {};
  state.pendingTools = {};
  state.interactionTools = {};
  state.stepParts = {};
  state.compaction = undefined;
}

function startTurn(state: ConversationState, time: string | undefined, kind: 'agent' | 'system' = 'agent'): ConversationTurn {
  const previous = openTurn(state);
  if (previous !== undefined) {
    endTurn(state, previous, state.provisionalOutcomes[previous.turn_id] ?? 'completed', time);
    state.implicitlyEnded[previous.turn_id] = true;
  }
  const ordinal = state.nextOrdinal++;
  const turnNumber = kind === 'agent' ? state.pendingPrompt?.turnNumber : undefined;
  const turn: ConversationTurn = {
    turn_id: `t${ordinal}`,
    ordinal,
    turn_number: turnNumber,
    kind,
    status: 'running',
    started_at: time,
    steps: [],
    items: [],
  };
  if (kind === 'agent') state.pendingPrompt = undefined;
  state.turns.push(turn);
  state.openTurnId = turn.turn_id;
  return turn;
}

function endTurn(
  state: ConversationState,
  turn: ConversationTurn,
  outcome: ConversationTurnOutcome,
  time: string | undefined,
): void {
  turn.status = 'ended';
  turn.outcome = outcome;
  if (time !== undefined) turn.ended_at = time;
  for (const item of turn.items) {
    if (item.status === 'running') item.status = 'ended';
  }
  turn.items = turn.items.map(settleInteraction);
  delete state.provisionalOutcomes[turn.turn_id];
  if (state.openTurnId === turn.turn_id) state.openTurnId = undefined;
}

function turnForNumber(state: ConversationState, turnNumber: number | undefined, time: string | undefined): ConversationTurn {
  const open = openTurn(state);
  if (open !== undefined && (turnNumber === undefined || open.turn_number === turnNumber)) return open;
  const known = findTurnByNumber(state, turnNumber);
  if (known !== undefined && (known.status === 'running' || state.implicitlyEnded[known.turn_id] === true)) {
    if (known.status === 'ended') {
      delete state.implicitlyEnded[known.turn_id];
      known.status = 'running';
      known.outcome = undefined;
      known.ended_at = undefined;
      state.openTurnId = known.turn_id;
    }
    return known;
  }
  if (open !== undefined && open.turn_number === undefined) {
    open.turn_number = turnNumber;
    return open;
  }
  const turn = startTurn(state, time);
  turn.turn_number = turnNumber;
  return turn;
}

function openTurn(state: ConversationState): ConversationTurn | undefined {
  return state.openTurnId === undefined ? undefined : findTurn(state, state.openTurnId);
}

function unnumberedOpenTurn(state: ConversationState): ConversationTurn | undefined {
  const open = openTurn(state);
  return open?.turn_number === undefined ? open : undefined;
}

function findTurn(state: ConversationState, turnId: string): ConversationTurn | undefined {
  return state.turns.findLast((turn) => turn.turn_id === turnId);
}

function findTurnByNumber(state: ConversationState, turnNumber: number | undefined): ConversationTurn | undefined {
  if (turnNumber === undefined) return undefined;
  return state.turns.findLast((turn) => turn.turn_number === turnNumber);
}

function findStep(state: ConversationState, stepId: string): ConversationStep | undefined {
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const step = state.turns[index]!.steps.findLast((candidate) => candidate.step_id === stepId);
    if (step !== undefined) return step;
  }
  return undefined;
}

function findToolCall(state: ConversationState, toolCallId: string): { turn: ConversationTurn; item: ToolCallItem } | undefined {
  const turnId = state.toolTurns[toolCallId];
  const turn = turnId === undefined ? undefined : findTurn(state, turnId);
  const item = turn?.items.find((candidate) => candidate.item_id === toolCallId);
  if (turn === undefined || item?.type !== 'tool_call') return undefined;
  return { turn, item };
}

function upsertToolCall(state: ConversationState, turn: ConversationTurn, item: ToolCallItem): void {
  const pending = state.pendingTools[item.item_id];
  if (pending !== undefined) {
    delete state.pendingTools[item.item_id];
    if (pending.interaction !== undefined) item.interaction = pending.interaction;
    if (pending.agent_refs !== undefined) item.agent_refs = pending.agent_refs;
  }
  const existing = turn.items.find((candidate) => candidate.item_id === item.item_id);
  if (existing?.type === 'tool_call') {
    item.interaction ??= existing.interaction;
    item.agent_refs ??= existing.agent_refs;
  }
  upsertItem(turn, item);
  state.toolTurns[item.item_id] = turn.turn_id;
}

function patchTool(state: ConversationState, toolCallId: string, patch: (target: PendingToolPatch) => void): void {
  const found = findToolCall(state, toolCallId);
  if (found !== undefined) {
    patch(found.item);
    return;
  }
  const pending = state.pendingTools[toolCallId] ?? {};
  patch(pending);
  state.pendingTools[toolCallId] = pending;
}

function upsertItem(turn: ConversationTurn, item: ConversationItem): void {
  const index = turn.items.findIndex((candidate) => candidate.item_id === item.item_id);
  if (index === -1) turn.items.push(item);
  else turn.items[index] = item;
}

function nextItemId(turn: ConversationTurn): string {
  return `${turn.turn_id}#${turn.items.length}`;
}

function contentItem(
  part: ContentPart,
  itemId: string,
  stepIndex: number | undefined,
  timing?: Pick<ReasoningItem, 'started_at' | 'duration_ms'>,
): ConversationItem | undefined {
  if (part.type === 'text') {
    return { type: 'assistant_message', item_id: itemId, status: 'ended', step_index: stepIndex, text: part.text };
  }
  if (part.type === 'think' && part.hidden !== true) {
    return {
      type: 'reasoning',
      item_id: itemId,
      status: 'ended',
      step_index: stepIndex,
      text: part.think,
      started_at: timing?.started_at,
      duration_ms: timing?.duration_ms,
    };
  }
  return undefined;
}

function toolOutput(output: string | readonly ContentPart[]): unknown {
  if (typeof output === 'string') return output;
  if (output.some((part) => part.type === 'image_url' || part.type === 'video_url' || part.type === 'audio_url')) {
    return projectToolResultOutput(output);
  }
  return output.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function textOf(content: readonly ContentPart[]): string {
  return content.map((part) => (part.type === 'text' ? part.text : '')).join('');
}

function compactionSummaryText(summary: unknown): string | undefined {
  if (typeof summary === 'string') return summary;
  if (typeof summary !== 'object' || summary === null) return undefined;
  const content = (summary as { content?: unknown }).content;
  return Array.isArray(content) ? textOf(content as ContentPart[]) : undefined;
}

function parseArguments(raw: string | null): unknown {
  if (raw === null) return undefined;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return raw;
  }
}

function settleInteraction(item: ConversationItem): ConversationItem {
  if (item.type !== 'tool_call' || item.interaction?.status !== 'pending') return item;
  return { ...item, interaction: { ...item.interaction, status: 'ended' } };
}

function projectError(error: unknown, requestId: string | undefined): ConversationError | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const payload = error as {
    code?: unknown;
    message?: unknown;
    name?: unknown;
    retryable?: unknown;
    details?: { statusCode?: unknown; requestId?: unknown };
  };
  if (typeof payload.message !== 'string') return undefined;
  return {
    code: typeof payload.code === 'string' ? payload.code : 'internal',
    message: payload.message,
    name: typeof payload.name === 'string' ? payload.name : undefined,
    retryable: typeof payload.retryable === 'boolean' ? payload.retryable : undefined,
    status_code: typeof payload.details?.statusCode === 'number' ? payload.details.statusCode : undefined,
    request_id: typeof payload.details?.requestId === 'string' ? payload.details.requestId : requestId,
  };
}

function isOutcome(value: unknown): value is ConversationTurnOutcome {
  return value === 'completed' || value === 'cancelled' || value === 'failed' || value === 'blocked';
}

function numberField(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function isoTime(ms: number): string {
  return new Date(ms).toISOString();
}

function elapsedMs(from: string | undefined, to: string | undefined): number | undefined {
  if (from === undefined || to === undefined) return undefined;
  const ms = Date.parse(to) - Date.parse(from);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
