import { createHash } from 'node:crypto';

import {
  PROVIDER_FILTERED_ERROR_CODE,
  type ContextMessage,
} from '@moonshot-ai/agent-core-v2';
import { isUserPromptSubmitHookPart } from '@moonshot-ai/agent-core-v2/agent/contextMemory/hookParts';
import type { LoopRecordedEvent } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import { LoopErrors } from '@moonshot-ai/agent-core-v2/agent/loop/errors';
import { isUndoAnchorOrigin } from '@moonshot-ai/agent-core-v2/agent/undo/turnUndo';
import { stripBundledSkillBlocks } from '@moonshot-ai/core/history/origin';
import type { ContentPart } from '@moonshot-ai/core/llm/message';
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';

import type {
  CompactionItem,
  ConversationItem,
  ConversationOutcome,
  ConversationTurn,
  ErrorInfo,
  NotificationItem,
  ToolCallItem,
  TurnEndReason,
  UserMessageItem,
} from '../../protocol/conversation';
import {
  agentRefOf,
  contentItem,
  endToolCall,
  errorInfoOf,
  isPlanTool,
  isoTime,
  notificationItem,
  promptIdsOf,
  refreshToolCall,
  requestDebug,
  retryStateOf,
  stepOutcome,
  stepSummary,
  toolCallItem,
  totalUsage,
  userMessageItem,
  type ToolInteraction,
} from './conversationItems';
import { parseTaskNotifications, plainTaskNotification } from './taskNotifications';

export interface TurnEnd {
  readonly outcome: ConversationOutcome;
  readonly reason?: TurnEndReason;
  readonly error?: ErrorInfo;
}

export interface ConversationFork {
  readonly source: 'btw' | 'fork';
  readonly forkedFrom: string;
}

export interface StepTrack {
  readonly id: string;
  readonly index: number;
  readonly startedAt: number;
  ended: boolean;
  failed?: boolean;
  interruptReason?: string;
}

export interface ToolTrack {
  turnId?: string;
  interaction?: ToolInteraction;
  planDisplay?: unknown;
}

type CompactionDetails = Pick<
  CompactionItem,
  'trigger' | 'instruction' | 'summary' | 'tokens_before' | 'tokens_after' | 'compacted_count'
>;

interface PendingPrompt {
  readonly turnNumber?: number;
  readonly promptId?: string;
  readonly originKind?: string;
}

interface UndoAnchor {
  readonly turnId: string;
  readonly itemCount: number;
  readonly stepCount: number;
}

export interface ConversationState {
  readonly agentId: string;
  readonly debug: boolean;
  fork?: ConversationFork;
  inheriting: boolean;
  clock: number;
  turns: ConversationTurn[];
  steps: Record<string, StepTrack[]>;
  tools: Record<string, ToolTrack>;
  interactions: Record<string, string>;
  nextOrdinal: number;
  openTurnId?: string;
  pendingPrompt?: PendingPrompt;
  pendingSteers: number;
  anchors: UndoAnchor[];
  implicitlyEnded: Record<string, true>;
  provisionalEnds: Record<string, TurnEnd>;
  recordsTurnEnds: boolean;
  stepParts: Record<string, number>;
  compaction?: CompactionDetails;
}

export function createConversationState(agentId: string, fork?: ConversationFork, debug = false): ConversationState {
  return {
    agentId,
    debug,
    fork,
    inheriting: fork !== undefined,
    clock: 0,
    turns: [],
    steps: {},
    tools: {},
    interactions: {},
    nextOrdinal: 0,
    pendingSteers: 0,
    anchors: [],
    implicitlyEnded: {},
    provisionalEnds: {},
    recordsTurnEnds: false,
    stepParts: {},
  };
}

const COMPLETED: TurnEnd = { outcome: 'completed' };
const HIDDEN_ORIGIN_KINDS: ReadonlySet<string> = new Set(['injection']);
const TASK_ORIGIN_KINDS: ReadonlySet<string> = new Set(['task', 'background_task', 'task_notification']);
const TURN_OPENING_SYSTEM_TRIGGERS: ReadonlySet<string> = new Set(['goal_continuation', 'subagent']);

export function applyConversationRecord(state: ConversationState, record: WireRecord): void {
  const time = numberField(record.time) ?? state.clock;
  state.clock = time;
  if (state.fork !== undefined) {
    addForkBoundary(state, state.fork, time);
    state.fork = undefined;
  }
  if (state.inheriting) {
    if (record.type !== 'turn.prompt') return;
    state.inheriting = false;
  }
  switch (record.type) {
    case 'turn.prompt':
      state.pendingPrompt = {
        turnNumber: numberField(record['turnId']),
        promptId: stringField(record['promptId']),
        originKind: stringField((record['origin'] as { kind?: unknown } | undefined)?.kind),
      };
      return;
    case 'context.append_message':
      applyMessage(state, record['message'] as ContextMessage | undefined, time);
      return;
    case 'context.append_loop_event':
      applyLoopEvent(state, record['event'] as LoopRecordedEvent | undefined, time);
      return;
    case 'turn.steer':
      applySteer(state, record);
      return;
    case 'turn.cancel':
      markProvisionalEnd(state, record['turnId'], {
        outcome: 'interrupted',
        reason: record['reason'] === 'aborted' ? 'aborted' : 'user_cancelled',
      });
      return;
    case 'turn.step.interrupted':
      applyStepInterrupted(state, record);
      return;
    case 'turn.step.started': {
      const turn = findTurnByNumber(state, numberField(record['turnId'])) ?? unnumberedOpenTurn(state);
      if (turn !== undefined) turn.retry = undefined;
      return;
    }
    case 'turn.step.retrying':
      applyStepRetrying(state, record);
      return;
    case 'turn.ended':
      applyTurnEnded(state, record, time);
      return;
    case 'prompt.completed':
      if (record['reason'] === 'blocked') applyPromptBlocked(state, stringField(record['promptId']), time);
      return;
    case 'interaction.request':
      applyInteractionRequest(state, record, time);
      return;
    case 'interaction.resolved':
      applyInteractionResolved(state, record);
      return;
    case 'subagent.spawned':
      applySubagentSpawned(state, record);
      return;
    case 'task.started':
      applyTaskStarted(state, record);
      return;
    case 'full_compaction.begin':
      state.compaction = {
        trigger: record['source'] === 'manual' ? 'manual' : 'auto',
        instruction: stringField(record['instruction']),
      };
      return;
    case 'context.apply_compaction':
      applyCompactionSummary(state, record, time);
      return;
    case 'full_compaction.complete':
      completeCompaction(state, time);
      return;
    case 'full_compaction.cancel':
      state.compaction = undefined;
      return;
    case 'context.clear':
      clearConversation(state);
      return;
  }
}

export interface RunningWork {
  readonly turnNumber?: number;
}

export function settleOrphanTurns(state: ConversationState, running: RunningWork = {}): ConversationState {
  const orphaned = (turn: ConversationTurn): boolean =>
    turn.status === 'running' && (turn.turn_number === undefined || turn.turn_number !== running.turnNumber);
  if (!state.turns.some(orphaned)) return state;
  const next: ConversationState = {
    ...state,
    turns: [...state.turns],
    tools: { ...state.tools },
    provisionalEnds: { ...state.provisionalEnds },
  };
  next.turns.forEach((turn, index) => {
    if (!orphaned(turn)) return;
    const settled = structuredClone(turn);
    for (const item of settled.items) {
      const track = item.type === 'tool_call' ? next.tools[item.item_id] : undefined;
      if (track !== undefined) next.tools[item.item_id] = structuredClone(track);
    }
    next.turns[index] = settled;
    endTurn(next, settled, state.recordsTurnEnds ? { outcome: 'interrupted', reason: 'aborted' } : COMPLETED, state.clock);
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
    const steps = state.steps[turn.turn_id] ?? [];
    turn.items.splice(anchor.itemCount);
    steps.splice(anchor.stepCount);
    turn.steps = turn.steps.filter((summary) => steps.some((step) => step.ended && step.index === summary.index));
    turn.usage = totalUsage(turn.steps);
  }
  const cutIndex = anchor.itemCount > 0 ? anchorIndex + 1 : anchorIndex;
  const removed = new Set(state.turns.splice(cutIndex).map((turn) => turn.turn_id));
  state.nextOrdinal = (state.turns.at(-1)?.ordinal ?? -1) + 1;
  for (const turnId of removed) delete state.steps[turnId];
  for (const toolCallId of Object.keys(state.tools)) {
    if (findToolCall(state, toolCallId) === undefined) delete state.tools[toolCallId];
  }
  for (const [interactionId, toolCallId] of Object.entries(state.interactions)) {
    if (state.tools[toolCallId] === undefined) delete state.interactions[interactionId];
  }
  if (state.openTurnId !== undefined && removed.has(state.openTurnId)) state.openTurnId = undefined;
  state.pendingPrompt = undefined;
  state.pendingSteers = 0;
  return state;
}

function applyMessage(state: ConversationState, message: ContextMessage | undefined, time: number): void {
  if (message === undefined) return;
  if (message.role === 'assistant') {
    applyLegacyAssistant(state, message, time);
    return;
  }
  if (message.role === 'tool') {
    applyLegacyToolResult(state, message, time);
    return;
  }
  if (message.role !== 'user') return;
  const origin = message.origin;
  const kind: string | undefined = origin?.kind;
  if (kind !== undefined && HIDDEN_ORIGIN_KINDS.has(kind)) return;
  const pending = state.pendingPrompt;
  if (
    pending !== undefined &&
    ((pending.promptId !== undefined && message.id !== undefined && pending.promptId !== message.id) ||
      (pending.originKind !== undefined && pending.originKind !== (kind ?? 'user')))
  ) {
    state.pendingPrompt = undefined;
  }
  if (kind === 'compaction_summary') {
    appendCompaction(state, { trigger: 'auto', summary: textOf(message.content) }, time);
    return;
  }
  const steered = state.pendingSteers > 0;
  if (steered) state.pendingSteers -= 1;
  if ((origin?.kind === 'skill_activation' || origin?.kind === 'plugin_command') && origin.trigger !== 'user-slash') return;
  const notification = kind !== undefined && TASK_ORIGIN_KINDS.has(kind);
  const open = openTurn(state);
  if (notification && (state.pendingPrompt === undefined || steered)) {
    const turn = open ?? addTurn(state, time);
    turn.items.push(...notificationItems(turn, message, time));
    if (open === undefined) endTurn(state, turn, COMPLETED, time);
    return;
  }
  const inTurn = origin !== undefined && 'inTurn' in origin && origin.inTurn === true;
  if (inTurn || (steered && state.pendingPrompt === undefined && open !== undefined)) {
    const turn = open ?? addTurn(state, time);
    if (isUndoAnchorOrigin(message.origin)) {
      state.anchors.push({ turnId: turn.turn_id, itemCount: turn.items.length, stepCount: state.steps[turn.turn_id]?.length ?? 0 });
    }
    turn.items.push(userMessage(message.id ?? nextItemId(turn), 'steer', message.id, message, time));
    if (open === undefined) endTurn(state, turn, COMPLETED, time);
    return;
  }
  if ((kind === 'system_trigger' || kind === 'retry') && state.pendingPrompt === undefined) {
    const name = (origin as { name?: unknown } | undefined)?.name;
    if (typeof name !== 'string' || !TURN_OPENING_SYSTEM_TRIGGERS.has(name)) return;
  }
  const owned = state.pendingPrompt !== undefined;
  const promptId = message.id ?? state.pendingPrompt?.promptId;
  const turn = owned ? startTurn(state, time) : addTurn(state, time);
  if (isUndoAnchorOrigin(message.origin)) state.anchors.push({ turnId: turn.turn_id, itemCount: 0, stepCount: 0 });
  if (notification) turn.items.push(...notificationItems(turn, message, time));
  else turn.items.push(userMessage(promptId ?? nextItemId(turn), 'opener', promptId, message, time));
  if (!owned) endTurn(state, turn, COMPLETED, time);
}

function userMessage(
  id: string,
  placement: UserMessageItem['placement'],
  promptId: string | undefined,
  message: ContextMessage,
  time: number,
): UserMessageItem {
  const origin = message.origin;
  const hidden = origin?.kind === 'retry' || (origin?.kind === 'system_trigger' && origin.name !== 'subagent');
  const content = hidden ? [] : stripBundledSkillBlocks(message).filter((part) => !isUserPromptSubmitHookPart(part));
  return userMessageItem(id, placement, promptId, origin, content, time);
}

function notificationItems(turn: ConversationTurn, message: ContextMessage, time: number): NotificationItem[] {
  const baseId = message.id ?? nextItemId(turn);
  const text = textOf(message.content, '\n');
  const parsed = parseTaskNotifications(text);
  const origin = message.origin as { readonly kind?: string; readonly taskId?: unknown } | undefined;
  const notifications = parsed.length > 0 || text.trim() === ''
    ? parsed
    : [plainTaskNotification(origin?.kind ?? 'task', stringField(origin?.taskId) ?? '', text.trim())];
  return notifications.map((notification, index) =>
    notificationItem(index === 0 ? baseId : `${baseId}:${index}`, notification, time),
  );
}

function applyLegacyAssistant(
  state: ConversationState,
  message: Extract<ContextMessage, { role: 'assistant' }>,
  time: number,
): void {
  const open = openTurn(state);
  const ownerless = open === undefined && state.pendingPrompt === undefined;
  const turn = open ?? (ownerless ? addTurn(state, time) : startTurn(state, time));
  for (const part of message.content) {
    const item = contentItem(part, nextItemId(turn), undefined, time);
    if (item !== undefined) turn.items.push(item);
  }
  for (const call of message.toolCalls ?? []) {
    upsertToolCall(
      state,
      turn,
      toolCallItem(call.id, call.name, undefined, time, parseArguments(call.arguments), message.toolCallDisplays?.[call.id]),
    );
  }
  if (ownerless) endTurn(state, turn, COMPLETED, time);
}

function applyLegacyToolResult(
  state: ConversationState,
  message: Extract<ContextMessage, { role: 'tool' }>,
  time: number,
): void {
  const found = findToolCall(state, message.toolCallId);
  if (found !== undefined) finishToolCall(state, found, message.content, message.isError === true, message.note, time);
}

function applyLoopEvent(state: ConversationState, event: LoopRecordedEvent | undefined, time: number): void {
  if (event === undefined) return;
  switch (event.type) {
    case 'step.begin': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      turn.retry = undefined;
      const steps = (state.steps[turn.turn_id] ??= []);
      const index = event.step ?? steps.length + 1;
      const previous = steps.at(-1);
      if (previous?.failed === true && previous.index === index) {
        turn.items = turn.items.filter((item) => !item.item_id.startsWith(`${previous.id}:`));
      }
      steps.push({ id: event.uuid, index, startedAt: time, ended: false });
      return;
    }
    case 'step.end': {
      delete state.stepParts[event.uuid];
      const found = findStep(state, event.uuid);
      if (found === undefined) return;
      const { turn, step } = found;
      turn.retry = undefined;
      step.ended = true;
      step.failed = event.finishReason === 'error';
      const summary = stepSummary(step.index, step.startedAt, time, step.interruptReason, event);
      turn.steps = [...turn.steps.filter((existing) => existing.index !== step.index), summary].toSorted(
        (a, b) => a.index - b.index,
      );
      turn.usage = totalUsage(turn.steps);
      if (state.debug) {
        const last = turn.items.findLast((item) => item.step_index === step.index);
        if (last !== undefined) last.debug = requestDebug(event);
      }
      return;
    }
    case 'content.part': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      const position = state.stepParts[event.stepUuid] ?? 0;
      state.stepParts[event.stepUuid] = position + 1;
      const startedAt = event.startedAt ?? findStep(state, event.stepUuid)?.step.startedAt ?? time;
      const item = contentItem(
        event.part,
        `${event.stepUuid}:${event.block ?? position}`,
        event.step,
        startedAt,
        event.durationMs,
      );
      if (item !== undefined) upsertItem(turn, item);
      return;
    }
    case 'tool.call': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      upsertToolCall(state, turn, toolCallItem(event.toolCallId, event.name, event.step, time, event.args, event.display));
      return;
    }
    case 'tool.result': {
      const found = findToolCall(state, event.toolCallId);
      if (found !== undefined) {
        finishToolCall(state, found, event.result.output, event.result.isError === true, event.result.note, time);
      }
      return;
    }
  }
}

function applySteer(state: ConversationState, record: WireRecord): void {
  const messageId = stringField(record['messageId']);
  const promptIds = record['promptIds'];
  if (messageId !== undefined && Array.isArray(promptIds)) {
    for (let index = state.turns.length - 1; index >= 0; index--) {
      const item = state.turns[index]!.items.find((candidate) => candidate.item_id === messageId);
      if (item?.type !== 'user_message') continue;
      item.prompt_ids = promptIdsOf(item.origin, promptIds.filter((id): id is string => typeof id === 'string'));
      return;
    }
  }
  state.pendingSteers += 1;
}

function markProvisionalEnd(state: ConversationState, turnNumber: unknown, end: TurnEnd): void {
  const turn = findTurnByNumber(state, numberField(turnNumber)) ?? unnumberedOpenTurn(state);
  if (turn?.status === 'running') state.provisionalEnds[turn.turn_id] = end;
}

function applyStepInterrupted(state: ConversationState, record: WireRecord): void {
  const reason = stringField(record['reason']);
  const turn = findTurnByNumber(state, numberField(record['turnId'])) ?? unnumberedOpenTurn(state);
  if (reason === undefined || turn === undefined) return;
  const stepId = stringField(record['stepId']);
  const index = numberField(record['step']);
  const step = state.steps[turn.turn_id]?.findLast((candidate) =>
    stepId === undefined ? candidate.index === index : candidate.id === stepId,
  );
  if (step !== undefined) {
    step.interruptReason = reason;
    const summary = step.ended ? turn.steps.find((candidate) => candidate.index === step.index) : undefined;
    if (summary !== undefined) summary.outcome = stepOutcome(reason, summary.finish_reason);
  }
  if (turn.status !== 'running') return;
  state.provisionalEnds[turn.turn_id] ??= reason === 'error'
    ? { outcome: 'failed', reason: 'error' }
    : { outcome: 'interrupted', reason: 'user_cancelled' };
}

function applyStepRetrying(state: ConversationState, record: WireRecord): void {
  const turn = findTurnByNumber(state, numberField(record['turnId'])) ?? unnumberedOpenTurn(state);
  const attempt = numberField(record['failedAttempt']);
  const nextAttempt = numberField(record['nextAttempt']);
  const maxAttempts = numberField(record['maxAttempts']);
  const delayMs = numberField(record['delayMs']);
  if (turn?.status !== 'running' || attempt === undefined || nextAttempt === undefined) return;
  if (maxAttempts === undefined || delayMs === undefined) return;
  turn.retry = retryStateOf({
    attempt,
    nextAttempt,
    maxAttempts,
    delayMs,
    errorName: typeof record['errorName'] === 'string' ? record['errorName'] : '',
    errorMessage: typeof record['errorMessage'] === 'string' ? record['errorMessage'] : '',
    statusCode: numberField(record['statusCode']),
  });
}

function applyTurnEnded(state: ConversationState, record: WireRecord, time: number): void {
  state.recordsTurnEnds = true;
  const turnNumber = numberField(record['turnId']);
  if (turnNumber !== undefined && state.pendingPrompt?.turnNumber === turnNumber) state.pendingPrompt = undefined;
  const turn = findTurnByNumber(state, turnNumber) ?? unnumberedOpenTurn(state);
  if (turn === undefined) return;
  if (turn.turn_number === undefined && turnNumber !== undefined) turn.turn_number = turnNumber;
  const error = errorInfoOf(record['error'], stringField(record['requestId']));
  endTurn(state, turn, turnEndOf(record['reason'], error, state.provisionalEnds[turn.turn_id]), time);
  delete state.implicitlyEnded[turn.turn_id];
  const durationMs = numberField(record['durationMs']);
  if (durationMs !== undefined) turn.duration_ms = durationMs;
}

function turnEndOf(reason: unknown, error: ErrorInfo | undefined, provisional: TurnEnd | undefined): TurnEnd {
  switch (reason) {
    case 'cancelled':
      return provisional?.outcome === 'interrupted' ? provisional : { outcome: 'interrupted', reason: 'user_cancelled' };
    case 'failed':
      return { outcome: 'failed', reason: failureReasonOf(error), error };
    case 'blocked':
      return { outcome: 'failed', reason: 'blocked', error };
    default:
      return COMPLETED;
  }
}

function failureReasonOf(error: ErrorInfo | undefined): TurnEndReason {
  if (error?.code === LoopErrors.codes.LOOP_MAX_STEPS_EXCEEDED) return 'max_steps';
  if (error?.code === PROVIDER_FILTERED_ERROR_CODE) return 'filtered';
  return 'error';
}

function applyPromptBlocked(state: ConversationState, promptId: string | undefined, time: number): void {
  if (promptId === undefined) return;
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index]!;
    const opener = turn.items[0];
    if (opener?.type !== 'user_message' || opener.item_id !== promptId) continue;
    endTurn(state, turn, { outcome: 'failed', reason: 'blocked' }, time);
    return;
  }
}

function applyInteractionRequest(state: ConversationState, record: WireRecord, time: number): void {
  const toolCallId = stringField(record['toolCallId']);
  const id = stringField(record['id']);
  const kind = record['kind'];
  if (toolCallId === undefined || id === undefined) return;
  if (kind !== 'approval' && kind !== 'question' && kind !== 'user_tool') return;
  state.interactions[id] = toolCallId;
  const request = record['request'];
  const track = callTrack(state, toolCallId);
  if (kind === 'approval' && findToolCall(state, toolCallId) === undefined) {
    openToolCallAwaitingApproval(state, toolCallId, request, time);
  }
  track.interaction = { id, kind, request, pending: true };
  refreshRecordedTool(state, toolCallId);
}

function openToolCallAwaitingApproval(state: ConversationState, toolCallId: string, request: unknown, time: number): void {
  const { toolName, turnId, display } = (request ?? {}) as { toolName?: unknown; turnId?: unknown; display?: unknown };
  const turn = findTurnByNumber(state, numberField(turnId)) ?? openTurn(state);
  if (turn?.status !== 'running' || typeof toolName !== 'string') return;
  const stepIndex = state.steps[turn.turn_id]?.at(-1)?.index;
  upsertToolCall(state, turn, toolCallItem(toolCallId, toolName, stepIndex, time, undefined, display));
}

function applyInteractionResolved(state: ConversationState, record: WireRecord): void {
  const id = stringField(record['id']);
  if (id === undefined) return;
  const toolCallId = state.interactions[id];
  if (toolCallId === undefined) return;
  delete state.interactions[id];
  const track = state.tools[toolCallId];
  if (track?.interaction === undefined) return;
  track.interaction = { ...track.interaction, pending: false, response: record['response'] };
  refreshRecordedTool(state, toolCallId);
}

function applySubagentSpawned(state: ConversationState, record: WireRecord): void {
  const toolCallId = stringField(record['parentToolCallId']);
  const agentId = stringField(record['subagentId']);
  if (toolCallId === undefined || agentId === undefined) return;
  const ref = agentRefOf(agentId, numberField(record['swarmIndex']), stringField(record['taskId']));
  const found = findToolCall(state, toolCallId);
  if (found === undefined) return;
  found.item.agent_refs = [...(found.item.agent_refs ?? []).filter((existing) => existing.agent_id !== agentId), ref];
}

function applyTaskStarted(state: ConversationState, record: WireRecord): void {
  const info = record['info'] as
    | { readonly taskId?: unknown; readonly parentToolCallId?: unknown; readonly toolCallId?: unknown }
    | undefined;
  const taskId = stringField(info?.taskId);
  const toolCallId = stringField(info?.parentToolCallId) ?? stringField(info?.toolCallId);
  if (taskId === undefined || toolCallId === undefined) return;
  const found = findToolCall(state, toolCallId);
  if (found !== undefined) found.item.task_id = taskId;
}

function applyCompactionSummary(state: ConversationState, record: WireRecord, time: number): void {
  const details = {
    summary: compactionSummaryText(record['summary']) ?? stringField(record['contextSummary']),
    tokens_before: numberField(record['tokensBefore']),
    tokens_after: numberField(record['tokensAfter']),
    compacted_count: numberField(record['compactedCount']) ?? numberField(record['count']),
  };
  if (state.compaction !== undefined) {
    state.compaction = { ...state.compaction, ...details };
    return;
  }
  const last = state.turns.at(-1);
  const completed = last?.items.at(-1);
  if (last !== undefined && completed?.type === 'system' && completed.kind === 'compaction' && completed.summary === undefined) {
    upsertItem(last, { ...completed, ...details });
    return;
  }
  appendCompaction(state, { trigger: 'auto', ...details }, time);
}

function completeCompaction(state: ConversationState, time: number): void {
  const compaction = state.compaction;
  if (compaction === undefined) return;
  state.compaction = undefined;
  appendCompaction(state, compaction, time);
}

function appendCompaction(state: ConversationState, compaction: CompactionDetails, time: number): void {
  const open = openTurn(state);
  const turn = open ?? addTurn(state, time, 'system');
  turn.items.push({
    type: 'system',
    kind: 'compaction',
    item_id: nextItemId(turn),
    status: 'ended',
    outcome: 'completed',
    created_at: isoTime(time),
    ...compaction,
  });
  if (open === undefined) endTurn(state, turn, COMPLETED, time);
}

function addForkBoundary(state: ConversationState, fork: ConversationFork, time: number): void {
  const turn = addTurn(state, time, 'system');
  turn.items.push({
    type: 'system',
    kind: 'fork_boundary',
    item_id: nextItemId(turn),
    status: 'ended',
    outcome: 'completed',
    created_at: isoTime(time),
    source: fork.source,
    forked_from: { agent_id: fork.forkedFrom },
  });
  endTurn(state, turn, COMPLETED, time);
}

function clearConversation(state: ConversationState): void {
  state.turns = [];
  state.nextOrdinal = 0;
  state.steps = {};
  state.tools = {};
  state.interactions = {};
  state.openTurnId = undefined;
  state.pendingPrompt = undefined;
  state.pendingSteers = 0;
  state.anchors = [];
  state.implicitlyEnded = {};
  state.provisionalEnds = {};
  state.stepParts = {};
  state.compaction = undefined;
}

function startTurn(state: ConversationState, time: number): ConversationTurn {
  const previous = openTurn(state);
  if (previous !== undefined) {
    endTurn(state, previous, state.provisionalEnds[previous.turn_id] ?? COMPLETED, time);
    state.implicitlyEnded[previous.turn_id] = true;
  }
  const turn = addTurn(state, time, 'agent', state.pendingPrompt?.turnNumber);
  state.pendingPrompt = undefined;
  state.openTurnId = turn.turn_id;
  return turn;
}

function addTurn(
  state: ConversationState,
  time: number,
  kind: ConversationTurn['kind'] = 'agent',
  turnNumber?: number,
): ConversationTurn {
  const ordinal = state.nextOrdinal++;
  const turn: ConversationTurn = {
    turn_id: turnIdOf(state.agentId, ordinal, time),
    ordinal,
    kind,
    status: 'running',
    turn_number: turnNumber,
    started_at: isoTime(time),
    steps: [],
    items: [],
  };
  state.turns.push(turn);
  return turn;
}

function turnIdOf(agentId: string, ordinal: number, startedAt: number): string {
  const digest = createHash('sha1').update(`${agentId}\n${ordinal}\n${startedAt}`).digest('hex');
  return `t_${digest.slice(0, 12)}`;
}

function endTurn(state: ConversationState, turn: ConversationTurn, end: TurnEnd, time: number): void {
  turn.status = 'ended';
  turn.outcome = end.outcome;
  turn.end_reason = end.reason;
  turn.error = end.error;
  turn.retry = undefined;
  turn.ended_at = isoTime(time);
  turn.duration_ms = Math.max(0, time - Date.parse(turn.started_at));
  for (const item of turn.items) endItem(state, item, time);
  delete state.provisionalEnds[turn.turn_id];
  if (state.openTurnId === turn.turn_id) {
    state.openTurnId = state.turns.findLast((candidate) => candidate.status === 'running')?.turn_id;
  }
}

function endItem(state: ConversationState, item: ConversationItem, time: number): void {
  if (item.type === 'tool_call') {
    const interaction = state.tools[item.item_id]?.interaction;
    if (interaction?.pending === true) interaction.pending = false;
    if (item.status !== 'ended') {
      item.status = 'ended';
      item.outcome = 'interrupted';
      item.ended_at = isoTime(time);
    }
    refreshTool(state, item);
    return;
  }
  if ((item.type === 'assistant_message' || item.type === 'reasoning') && item.status === 'running') {
    item.status = 'ended';
    item.outcome = 'completed';
  }
}

function turnForNumber(state: ConversationState, turnNumber: number | undefined, time: number): ConversationTurn {
  const open = openTurn(state);
  if (open !== undefined && (turnNumber === undefined || open.turn_number === turnNumber)) return open;
  const known = findTurnByNumber(state, turnNumber);
  if (known !== undefined && (known.status === 'running' || state.implicitlyEnded[known.turn_id] === true)) {
    if (known.status === 'ended') {
      delete state.implicitlyEnded[known.turn_id];
      known.status = 'running';
      known.outcome = undefined;
      known.end_reason = undefined;
      known.error = undefined;
      known.ended_at = undefined;
      known.duration_ms = undefined;
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

function findStep(state: ConversationState, stepId: string): { turn: ConversationTurn; step: StepTrack } | undefined {
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index]!;
    const step = state.steps[turn.turn_id]?.findLast((candidate) => candidate.id === stepId);
    if (step !== undefined) return { turn, step };
  }
  return undefined;
}

function findToolCall(state: ConversationState, toolCallId: string): { turn: ConversationTurn; item: ToolCallItem } | undefined {
  const turnId = state.tools[toolCallId]?.turnId;
  const turn = turnId === undefined ? undefined : findTurn(state, turnId);
  const item = turn?.items.find((candidate) => candidate.item_id === toolCallId);
  if (turn === undefined || item?.type !== 'tool_call') return undefined;
  return { turn, item };
}

function callTrack(state: ConversationState, toolCallId: string): ToolTrack {
  if (findToolCall(state, toolCallId)?.item.status === 'ended') state.tools[toolCallId] = {};
  return (state.tools[toolCallId] ??= {});
}

function upsertToolCall(state: ConversationState, turn: ConversationTurn, fresh: ToolCallItem): void {
  const track = callTrack(state, fresh.item_id);
  const existing = turn.items.find((candidate) => candidate.item_id === fresh.item_id);
  const previous = existing?.type === 'tool_call' ? existing : undefined;
  if (isPlanTool(fresh.name)) track.planDisplay = fresh.display ?? track.planDisplay;
  const item: ToolCallItem = {
    ...fresh,
    created_at: previous?.created_at ?? fresh.created_at,
    started_at: previous?.started_at ?? fresh.started_at,
    display: fresh.display ?? previous?.display,
    agent_refs: previous?.agent_refs,
  };
  track.turnId = turn.turn_id;
  refreshToolCall(item, track.interaction, track.planDisplay);
  upsertItem(turn, item);
}

function finishToolCall(
  state: ConversationState,
  found: { turn: ConversationTurn; item: ToolCallItem },
  output: string | readonly ContentPart[],
  isError: boolean,
  note: string | undefined,
  time: number,
): void {
  const cancelled = state.provisionalEnds[found.turn.turn_id]?.outcome === 'interrupted';
  endToolCall(found.item, output, !isError ? 'completed' : cancelled ? 'interrupted' : 'failed', note, time);
  refreshTool(state, found.item);
}

function refreshRecordedTool(state: ConversationState, toolCallId: string): void {
  const found = findToolCall(state, toolCallId);
  if (found !== undefined) refreshTool(state, found.item);
}

function refreshTool(state: ConversationState, item: ToolCallItem): void {
  const track = state.tools[item.item_id];
  refreshToolCall(item, track?.interaction, track?.planDisplay);
}

function upsertItem(turn: ConversationTurn, item: ConversationItem): void {
  const index = turn.items.findIndex((candidate) => candidate.item_id === item.item_id);
  if (index === -1) turn.items.push(item);
  else turn.items[index] = item;
}

function nextItemId(turn: ConversationTurn): string {
  return `${turn.turn_id}#${turn.items.length}`;
}

function textOf(content: readonly ContentPart[], separator = ''): string {
  return content.flatMap((part) => (part.type === 'text' ? [part.text] : [])).join(separator);
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