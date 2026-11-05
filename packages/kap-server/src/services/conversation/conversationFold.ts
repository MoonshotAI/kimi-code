import { createHash } from 'node:crypto';

import {
  PROVIDER_FILTERED_ERROR_CODE,
  isUndoAnchor,
  type ContextMessage,
  type PromptOrigin,
} from '@moonshot-ai/agent-core-v2';
import { isUserPromptSubmitHookPart } from '@moonshot-ai/agent-core-v2/agent/contextMemory/hookParts';
import type { LoopRecordedEvent } from '@moonshot-ai/agent-core-v2/agent/contextMemory/loopEventFold';
import { LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE } from '@moonshot-ai/agent-core-v2/human/agent/errors';
import { stripBundledSkillBlocks } from '@moonshot-ai/agent-core-v2/human/agent/origin';
import type { ContentPart } from '@moonshot-ai/agent-core-v2/human/llm/message';
import type { WireRecord } from '@moonshot-ai/agent-core-v2/wire/record';

import type {
  ConversationOutcome,
  ConversationStatus,
  TurnEndReason,
} from '../../protocol/conversation';
import { parseTaskNotifications, plainTaskNotification, type TaskNotification } from './taskNotifications';

export interface TurnError {
  readonly code: string;
  readonly message: string;
  readonly name?: string;
  readonly statusCode?: number;
  readonly requestId?: string;
  readonly retryable?: boolean;
}

export interface TurnEnd {
  readonly outcome: ConversationOutcome;
  readonly reason?: TurnEndReason;
  readonly error?: TurnError;
}

export interface TurnRetry {
  readonly attempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export interface StepUsage {
  readonly inputOther: number;
  readonly output: number;
  readonly inputCacheRead: number;
  readonly inputCacheCreation: number;
}

export const STEP_TIMING_FIELDS = [
  'llmFirstTokenLatencyMs',
  'llmStreamDurationMs',
  'llmRequestBuildMs',
  'llmServerFirstTokenMs',
  'llmServerDecodeMs',
  'llmClientConsumeMs',
  'llmClientBlockedMs',
] as const;
export type StepTimingField = (typeof STEP_TIMING_FIELDS)[number];

export interface FoldStep {
  readonly id: string;
  readonly index: number;
  readonly startedAt: number;
  endedAt?: number;
  finishReason?: string;
  usage?: StepUsage;
  timing?: Partial<Record<StepTimingField, number>>;
  interruptReason?: string;
}

export interface FoldTurn {
  readonly id: string;
  readonly ordinal: number;
  readonly kind: 'agent' | 'system';
  readonly startedAt: number;
  turnNumber?: number;
  status: ConversationStatus;
  outcome?: ConversationOutcome;
  endReason?: TurnEndReason;
  error?: TurnError;
  retry?: TurnRetry;
  endedAt?: number;
  durationMs?: number;
  steps: FoldStep[];
  items: FoldItem[];
}

interface FoldItemBase {
  readonly id: string;
  readonly createdAt: number;
  readonly stepIndex?: number;
}

export interface FoldUserMessage extends FoldItemBase {
  readonly type: 'user_message';
  readonly placement: 'opener' | 'steer';
  readonly origin?: PromptOrigin;
  readonly content: readonly ContentPart[];
  promptIds: string[];
}

export interface FoldText extends FoldItemBase {
  readonly type: 'assistant_message';
  status: ConversationStatus;
  text: string;
}

export interface FoldReasoning extends FoldItemBase {
  readonly type: 'reasoning';
  status: ConversationStatus;
  text: string;
  readonly startedAt: number;
  durationMs?: number;
}

export interface FoldInteraction {
  readonly id: string;
  readonly kind: 'approval' | 'question' | 'user_tool';
  readonly request?: unknown;
  pending: boolean;
  response?: unknown;
}

export interface FoldAgentRef {
  readonly agentId: string;
  readonly swarmIndex?: number;
  readonly taskId?: string;
}

export interface LiveToolProgress {
  readonly percent?: number;
  readonly status?: string;
  readonly customKind?: string;
  readonly customData?: unknown;
}

export interface LiveToolFields {
  readonly inputText?: string;
  readonly output?: string;
  readonly progress?: LiveToolProgress;
}

export interface FoldToolCall extends FoldItemBase {
  readonly type: 'tool_call';
  readonly name: string;
  readonly startedAt: number;
  status: ConversationStatus;
  outcome?: ConversationOutcome;
  endedAt?: number;
  input?: unknown;
  display?: unknown;
  result?: { readonly output: string | readonly ContentPart[]; readonly isError: boolean };
  interaction?: FoldInteraction;
  agentRefs?: FoldAgentRef[];
  readonly streaming?: boolean;
  readonly live?: LiveToolFields;
}

export interface FoldNotification extends FoldItemBase {
  readonly type: 'notification';
  readonly notification: TaskNotification;
}

export interface CompactionDetails {
  readonly trigger: 'manual' | 'auto';
  readonly instruction?: string;
  readonly summary?: string;
  readonly tokensBefore?: number;
  readonly tokensAfter?: number;
  readonly compactedCount?: number;
}

export interface FoldCompaction extends FoldItemBase, CompactionDetails {
  readonly type: 'system';
  readonly kind: 'compaction';
}

export interface ConversationFork {
  readonly source: 'btw' | 'fork';
  readonly forkedFrom: string;
}

export interface FoldForkBoundary extends FoldItemBase, ConversationFork {
  readonly type: 'system';
  readonly kind: 'fork_boundary';
}

export type FoldItem =
  | FoldUserMessage
  | FoldText
  | FoldReasoning
  | FoldToolCall
  | FoldNotification
  | FoldCompaction
  | FoldForkBoundary;

interface PendingPrompt {
  readonly turnNumber?: number;
  readonly promptId?: string;
  readonly originKind?: string;
}

interface PendingToolPatch {
  interaction?: FoldInteraction;
  agentRefs?: FoldAgentRef[];
}

interface UndoAnchor {
  readonly turnId: string;
  readonly itemCount: number;
  readonly stepCount: number;
}

export interface ConversationState {
  readonly agentId: string;
  fork?: ConversationFork;
  inheriting: boolean;
  clock: number;
  turns: FoldTurn[];
  nextOrdinal: number;
  openTurnId?: string;
  pendingPrompt?: PendingPrompt;
  pendingSteers: number;
  anchors: UndoAnchor[];
  implicitlyEnded: Record<string, true>;
  provisionalEnds: Record<string, TurnEnd>;
  toolTurns: Record<string, string>;
  pendingTools: Record<string, PendingToolPatch>;
  interactionTools: Record<string, string>;
  stepParts: Record<string, number>;
  compaction?: CompactionDetails;
}

export function createConversationState(agentId: string, fork?: ConversationFork): ConversationState {
  return {
    agentId,
    fork,
    inheriting: fork !== undefined,
    clock: 0,
    turns: [],
    nextOrdinal: 0,
    pendingSteers: 0,
    anchors: [],
    implicitlyEnded: {},
    provisionalEnds: {},
    toolTurns: {},
    pendingTools: {},
    interactionTools: {},
    stepParts: {},
  };
}

const COMPLETED: TurnEnd = { outcome: 'completed' };
const HIDDEN_ORIGIN_KINDS: ReadonlySet<string> = new Set(['injection', 'shell_command']);
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
    case 'context.undo': {
      const count = numberField(record['count']);
      if (count !== undefined && count > 0) undoConversationTurns(state, count);
      return;
    }
  }
}

export interface RunningWork {
  readonly turnNumber?: number;
}

export function settleOrphanTurns(state: ConversationState, running: RunningWork = {}): ConversationState {
  const orphaned = (turn: FoldTurn): boolean =>
    turn.status === 'running' && (turn.turnNumber === undefined || turn.turnNumber !== running.turnNumber);
  if (!state.turns.some(orphaned)) return state;
  const next: ConversationState = { ...state, turns: [...state.turns], provisionalEnds: { ...state.provisionalEnds } };
  next.turns.forEach((turn, index) => {
    if (!orphaned(turn)) return;
    const settled = structuredClone(turn);
    next.turns[index] = settled;
    endTurn(next, settled, { outcome: 'interrupted', reason: 'aborted' }, state.clock);
  });
  return next;
}

export function undoConversationTurns(state: ConversationState, count: number): ConversationState {
  const anchor = state.anchors.at(-count);
  if (anchor === undefined) return state;
  state.anchors.splice(state.anchors.length - count);
  const anchorIndex = state.turns.findIndex((turn) => turn.id === anchor.turnId);
  if (anchorIndex === -1) return state;
  if (anchor.itemCount > 0) {
    const turn = state.turns[anchorIndex]!;
    turn.items.splice(anchor.itemCount);
    turn.steps.splice(anchor.stepCount);
  }
  const cutIndex = anchor.itemCount > 0 ? anchorIndex + 1 : anchorIndex;
  const removed = new Set(state.turns.splice(cutIndex).map((turn) => turn.id));
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
    if (isUndoAnchor(message)) state.anchors.push({ turnId: turn.id, itemCount: turn.items.length, stepCount: turn.steps.length });
    turn.items.push(userMessageItem(message.id ?? nextItemId(turn), 'steer', message.id, message, time));
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
  if (isUndoAnchor(message)) state.anchors.push({ turnId: turn.id, itemCount: 0, stepCount: 0 });
  if (notification) turn.items.push(...notificationItems(turn, message, time));
  else turn.items.push(userMessageItem(promptId ?? nextItemId(turn), 'opener', promptId, message, time));
  if (!owned) endTurn(state, turn, COMPLETED, time);
}

function userMessageItem(
  id: string,
  placement: FoldUserMessage['placement'],
  promptId: string | undefined,
  message: ContextMessage,
  time: number,
): FoldUserMessage {
  return {
    type: 'user_message',
    id,
    createdAt: time,
    placement,
    origin: message.origin,
    content: visibleContent(message),
    promptIds: promptId === undefined ? [] : [promptId],
  };
}

function visibleContent(message: ContextMessage): ContentPart[] {
  const origin = message.origin;
  if (origin?.kind === 'retry' || (origin?.kind === 'system_trigger' && origin.name !== 'subagent')) return [];
  return stripBundledSkillBlocks(message).filter((part) => !isUserPromptSubmitHookPart(part));
}

function notificationItems(turn: FoldTurn, message: ContextMessage, time: number): FoldNotification[] {
  const baseId = message.id ?? nextItemId(turn);
  const text = textOf(message.content, '\n');
  const parsed = parseTaskNotifications(text);
  const origin = message.origin as { readonly kind?: string; readonly taskId?: unknown } | undefined;
  const notifications = parsed.length > 0 || text.trim() === ''
    ? parsed
    : [plainTaskNotification(origin?.kind ?? 'task', stringField(origin?.taskId) ?? '', text.trim())];
  return notifications.map((notification, index) => ({
    type: 'notification',
    id: index === 0 ? baseId : `${baseId}:${index}`,
    createdAt: time,
    notification,
  }));
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
  if (found !== undefined) endToolCall(found.item, message.content, message.isError === true, time);
}

function applyLoopEvent(state: ConversationState, event: LoopRecordedEvent | undefined, time: number): void {
  if (event === undefined) return;
  switch (event.type) {
    case 'step.begin': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      turn.retry = undefined;
      turn.steps.push({ id: event.uuid, index: event.step ?? turn.steps.length + 1, startedAt: time });
      return;
    }
    case 'step.end': {
      delete state.stepParts[event.uuid];
      const found = findStep(state, event.uuid);
      if (found === undefined) return;
      found.turn.retry = undefined;
      const { step } = found;
      step.endedAt = time;
      if (event.finishReason !== undefined) step.finishReason = event.finishReason;
      if (event.usage !== undefined) step.usage = usageOf(event.usage);
      const timing: Partial<Record<StepTimingField, number>> = {};
      for (const field of STEP_TIMING_FIELDS) {
        const value = event[field];
        if (typeof value === 'number') timing[field] = value;
      }
      if (Object.keys(timing).length > 0) step.timing = timing;
      return;
    }
    case 'content.part': {
      const turn = turnForNumber(state, numberField(event.turnId), time);
      const position = state.stepParts[event.stepUuid] ?? 0;
      state.stepParts[event.stepUuid] = position + 1;
      const stepStart = findStep(state, event.stepUuid)?.step.startedAt;
      const startedAt = event.startedAt ?? stepStart ?? time;
      const item = contentItem(
        event.part,
        `${event.stepUuid}:${event.block ?? position}`,
        event.step,
        startedAt,
        event.durationMs ?? elapsedMs(stepStart, time),
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
      if (found !== undefined) endToolCall(found.item, event.result.output, event.result.isError === true, time);
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
    const item = state.turns[index]!.items.find((candidate) => candidate.id === messageId);
    if (item?.type !== 'user_message') continue;
    item.promptIds = promptIds.filter((id): id is string => typeof id === 'string');
    return;
  }
}

function markProvisionalEnd(state: ConversationState, turnNumber: unknown, end: TurnEnd): void {
  const turn = findTurnByNumber(state, numberField(turnNumber)) ?? unnumberedOpenTurn(state);
  if (turn?.status === 'running') state.provisionalEnds[turn.id] = end;
}

function applyStepInterrupted(state: ConversationState, record: WireRecord): void {
  const reason = stringField(record['reason']);
  const turn = findTurnByNumber(state, numberField(record['turnId'])) ?? unnumberedOpenTurn(state);
  if (reason === undefined || turn === undefined) return;
  const stepId = stringField(record['stepId']);
  const index = numberField(record['step']);
  const step = turn.steps.findLast((candidate) => (stepId === undefined ? candidate.index === index : candidate.id === stepId));
  if (step !== undefined) step.interruptReason = reason;
  if (turn.status !== 'running') return;
  state.provisionalEnds[turn.id] ??= reason === 'error'
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
  turn.retry = {
    attempt,
    nextAttempt,
    maxAttempts,
    delayMs,
    errorName: typeof record['errorName'] === 'string' ? record['errorName'] : '',
    errorMessage: typeof record['errorMessage'] === 'string' ? record['errorMessage'] : '',
    statusCode: numberField(record['statusCode']),
  };
}

function applyTurnEnded(state: ConversationState, record: WireRecord, time: number): void {
  const turnNumber = numberField(record['turnId']);
  if (turnNumber !== undefined && state.pendingPrompt?.turnNumber === turnNumber) state.pendingPrompt = undefined;
  const turn = findTurnByNumber(state, turnNumber) ?? unnumberedOpenTurn(state);
  if (turn === undefined) return;
  if (turn.turnNumber === undefined && turnNumber !== undefined) turn.turnNumber = turnNumber;
  const error = errorOf(record['error'], stringField(record['requestId']));
  endTurn(state, turn, turnEndOf(record['reason'], error, state.provisionalEnds[turn.id]), time);
  delete state.implicitlyEnded[turn.id];
  const durationMs = numberField(record['durationMs']);
  if (durationMs !== undefined) turn.durationMs = durationMs;
}

function turnEndOf(reason: unknown, error: TurnError | undefined, provisional: TurnEnd | undefined): TurnEnd {
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

function failureReasonOf(error: TurnError | undefined): TurnEndReason {
  if (error?.code === LOOP_MAX_STEPS_EXCEEDED_ERROR_CODE) return 'max_steps';
  if (error?.code === PROVIDER_FILTERED_ERROR_CODE) return 'filtered';
  return 'error';
}

function applyPromptBlocked(state: ConversationState, promptId: string | undefined, time: number): void {
  if (promptId === undefined) return;
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index]!;
    const opener = turn.items[0];
    if (opener?.type !== 'user_message' || !opener.promptIds.includes(promptId)) continue;
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
  state.interactionTools[id] = toolCallId;
  const request = record['request'];
  if (kind === 'approval' && findToolCall(state, toolCallId) === undefined) {
    openToolCallAwaitingApproval(state, toolCallId, request, time);
  }
  patchTool(state, toolCallId, (patch) => {
    patch.interaction = { id, kind, request, pending: true };
  });
}

function openToolCallAwaitingApproval(state: ConversationState, toolCallId: string, request: unknown, time: number): void {
  const { toolName, turnId, display } = (request ?? {}) as { toolName?: unknown; turnId?: unknown; display?: unknown };
  const turn = findTurnByNumber(state, numberField(turnId)) ?? openTurn(state);
  if (turn?.status !== 'running' || typeof toolName !== 'string') return;
  upsertToolCall(state, turn, toolCallItem(toolCallId, toolName, turn.steps.at(-1)?.index, time, undefined, display));
}

function applyInteractionResolved(state: ConversationState, record: WireRecord): void {
  const id = stringField(record['id']);
  if (id === undefined) return;
  const toolCallId = state.interactionTools[id];
  if (toolCallId === undefined) return;
  delete state.interactionTools[id];
  patchTool(state, toolCallId, (patch) => {
    if (patch.interaction === undefined) return;
    patch.interaction = { ...patch.interaction, pending: false, response: record['response'] };
  });
}

function applySubagentSpawned(state: ConversationState, record: WireRecord): void {
  const toolCallId = stringField(record['parentToolCallId']);
  const agentId = stringField(record['subagentId']);
  if (toolCallId === undefined || agentId === undefined) return;
  const ref: FoldAgentRef = {
    agentId,
    swarmIndex: numberField(record['swarmIndex']),
    taskId: stringField(record['taskId']),
  };
  patchTool(state, toolCallId, (patch) => {
    patch.agentRefs = [...(patch.agentRefs ?? []).filter((existing) => existing.agentId !== agentId), ref];
  });
}

function applyCompactionSummary(state: ConversationState, record: WireRecord, time: number): void {
  const details = {
    summary: compactionSummaryText(record['summary']) ?? stringField(record['contextSummary']),
    tokensBefore: numberField(record['tokensBefore']),
    tokensAfter: numberField(record['tokensAfter']),
    compactedCount: numberField(record['compactedCount']) ?? numberField(record['count']),
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
  turn.items.push({ type: 'system', kind: 'compaction', id: nextItemId(turn), createdAt: time, ...compaction });
  if (open === undefined) endTurn(state, turn, COMPLETED, time);
}

function addForkBoundary(state: ConversationState, fork: ConversationFork, time: number): void {
  const turn = addTurn(state, time, 'system');
  turn.items.push({ type: 'system', kind: 'fork_boundary', id: nextItemId(turn), createdAt: time, ...fork });
  endTurn(state, turn, COMPLETED, time);
}

function clearConversation(state: ConversationState): void {
  state.turns = [];
  state.openTurnId = undefined;
  state.pendingPrompt = undefined;
  state.pendingSteers = 0;
  state.anchors = [];
  state.implicitlyEnded = {};
  state.provisionalEnds = {};
  state.toolTurns = {};
  state.pendingTools = {};
  state.interactionTools = {};
  state.stepParts = {};
  state.compaction = undefined;
}

function startTurn(state: ConversationState, time: number): FoldTurn {
  const previous = openTurn(state);
  if (previous !== undefined) {
    endTurn(state, previous, state.provisionalEnds[previous.id] ?? COMPLETED, time);
    state.implicitlyEnded[previous.id] = true;
  }
  const turn = addTurn(state, time, 'agent', state.pendingPrompt?.turnNumber);
  state.pendingPrompt = undefined;
  state.openTurnId = turn.id;
  return turn;
}

function addTurn(state: ConversationState, time: number, kind: FoldTurn['kind'] = 'agent', turnNumber?: number): FoldTurn {
  const ordinal = state.nextOrdinal++;
  const turn: FoldTurn = {
    id: turnIdOf(state.agentId, ordinal, time),
    ordinal,
    kind,
    startedAt: time,
    turnNumber,
    status: 'running',
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

function endTurn(state: ConversationState, turn: FoldTurn, end: TurnEnd, time: number): void {
  turn.status = 'ended';
  turn.outcome = end.outcome;
  turn.endReason = end.reason;
  turn.error = end.error;
  turn.retry = undefined;
  turn.endedAt = time;
  for (const item of turn.items) endItem(item, end.outcome, time);
  delete state.provisionalEnds[turn.id];
  if (state.openTurnId === turn.id) state.openTurnId = undefined;
}

function endItem(item: FoldItem, outcome: ConversationOutcome, time: number): void {
  if (item.type === 'tool_call') {
    if (item.interaction?.pending === true) item.interaction.pending = false;
    if (item.status === 'ended') return;
    item.status = 'ended';
    item.outcome = outcome === 'completed' ? 'completed' : 'interrupted';
    item.endedAt = time;
    return;
  }
  if ((item.type === 'assistant_message' || item.type === 'reasoning') && item.status === 'running') {
    item.status = 'ended';
  }
}

function turnForNumber(state: ConversationState, turnNumber: number | undefined, time: number): FoldTurn {
  const open = openTurn(state);
  if (open !== undefined && (turnNumber === undefined || open.turnNumber === turnNumber)) return open;
  const known = findTurnByNumber(state, turnNumber);
  if (known !== undefined && (known.status === 'running' || state.implicitlyEnded[known.id] === true)) {
    if (known.status === 'ended') {
      delete state.implicitlyEnded[known.id];
      known.status = 'running';
      known.outcome = undefined;
      known.endReason = undefined;
      known.error = undefined;
      known.endedAt = undefined;
      state.openTurnId = known.id;
    }
    return known;
  }
  if (open !== undefined && open.turnNumber === undefined) {
    open.turnNumber = turnNumber;
    return open;
  }
  const turn = startTurn(state, time);
  turn.turnNumber = turnNumber;
  return turn;
}

function openTurn(state: ConversationState): FoldTurn | undefined {
  return state.openTurnId === undefined ? undefined : findTurn(state, state.openTurnId);
}

function unnumberedOpenTurn(state: ConversationState): FoldTurn | undefined {
  const open = openTurn(state);
  return open?.turnNumber === undefined ? open : undefined;
}

function findTurn(state: ConversationState, turnId: string): FoldTurn | undefined {
  return state.turns.findLast((turn) => turn.id === turnId);
}

function findTurnByNumber(state: ConversationState, turnNumber: number | undefined): FoldTurn | undefined {
  if (turnNumber === undefined) return undefined;
  return state.turns.findLast((turn) => turn.turnNumber === turnNumber);
}

function findStep(state: ConversationState, stepId: string): { turn: FoldTurn; step: FoldStep } | undefined {
  for (let index = state.turns.length - 1; index >= 0; index--) {
    const turn = state.turns[index]!;
    const step = turn.steps.findLast((candidate) => candidate.id === stepId);
    if (step !== undefined) return { turn, step };
  }
  return undefined;
}

function findToolCall(state: ConversationState, toolCallId: string): { turn: FoldTurn; item: FoldToolCall } | undefined {
  const turnId = state.toolTurns[toolCallId];
  const turn = turnId === undefined ? undefined : findTurn(state, turnId);
  const item = turn?.items.find((candidate) => candidate.id === toolCallId);
  if (turn === undefined || item?.type !== 'tool_call') return undefined;
  return { turn, item };
}

function toolCallItem(
  id: string,
  name: string,
  stepIndex: number | undefined,
  time: number,
  input: unknown,
  display: unknown,
): FoldToolCall {
  return { type: 'tool_call', id, stepIndex, createdAt: time, startedAt: time, name, status: 'running', input, display };
}

function upsertToolCall(state: ConversationState, turn: FoldTurn, item: FoldToolCall): void {
  const pending = state.pendingTools[item.id];
  delete state.pendingTools[item.id];
  const existing = turn.items.find((candidate) => candidate.id === item.id);
  const previous = existing?.type === 'tool_call' ? existing : undefined;
  upsertItem(turn, {
    ...item,
    createdAt: previous?.createdAt ?? item.createdAt,
    startedAt: previous?.startedAt ?? item.startedAt,
    display: item.display ?? previous?.display,
    interaction: pending?.interaction ?? previous?.interaction,
    agentRefs: pending?.agentRefs ?? previous?.agentRefs,
  });
  state.toolTurns[item.id] = turn.id;
}

function endToolCall(item: FoldToolCall, output: string | readonly ContentPart[], isError: boolean, time: number): void {
  item.status = 'ended';
  item.outcome = isError ? 'failed' : 'completed';
  item.result = { output, isError };
  item.endedAt = time;
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

function upsertItem(turn: FoldTurn, item: FoldItem): void {
  const index = turn.items.findIndex((candidate) => candidate.id === item.id);
  if (index === -1) turn.items.push(item);
  else turn.items[index] = item;
}

function nextItemId(turn: FoldTurn): string {
  return `${turn.id}#${turn.items.length}`;
}

function contentItem(
  part: ContentPart,
  id: string,
  stepIndex: number | undefined,
  createdAt: number,
  durationMs?: number,
): FoldText | FoldReasoning | undefined {
  if (part.type === 'text') {
    return { type: 'assistant_message', id, stepIndex, createdAt, status: 'ended', text: part.text };
  }
  if (part.type === 'think' && part.hidden !== true) {
    return { type: 'reasoning', id, stepIndex, createdAt, status: 'ended', text: part.think, startedAt: createdAt, durationMs };
  }
  return undefined;
}

function usageOf(usage: { readonly inputOther?: number; readonly output?: number; readonly inputCacheRead?: number; readonly inputCacheCreation?: number }): StepUsage {
  return {
    inputOther: usage.inputOther ?? 0,
    output: usage.output ?? 0,
    inputCacheRead: usage.inputCacheRead ?? 0,
    inputCacheCreation: usage.inputCacheCreation ?? 0,
  };
}

function errorOf(error: unknown, requestId: string | undefined): TurnError | undefined {
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
    statusCode: typeof payload.details?.statusCode === 'number' ? payload.details.statusCode : undefined,
    requestId: typeof payload.details?.requestId === 'string' ? payload.details.requestId : requestId,
    retryable: typeof payload.retryable === 'boolean' ? payload.retryable : undefined,
  };
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

function elapsedMs(from: number | undefined, to: number): number | undefined {
  if (from === undefined) return undefined;
  const ms = to - from;
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}
