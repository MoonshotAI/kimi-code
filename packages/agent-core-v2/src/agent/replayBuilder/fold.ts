import type { LoopRecordedEvent } from '#/agent/contextMemory/loopEventFold';
import type { ContextMessage } from '#/agent/contextMemory/types';
import type { CompactionResult } from '#/agent/fullCompaction/types';
import type { PermissionApprovalResultRecord } from '#/agent/permissionRules/permissionRules';
import type { PermissionMode } from '#/agent/permissionPolicy/types';
import type { AgentConfigUpdateData } from '#/agent/profile/profile';
import type {
  GoalActor,
  GoalBudgetLimits,
  GoalBudgetReport,
  GoalSnapshot,
  GoalStatus,
} from '#/features/goal/types';
import { createToolMessage } from '#human/llm/message';
import { estimateTokens, estimateTokensForMessages } from '#/llm-adapter/contract/tokens';
import {
  isNewerWireVersion,
  migrateV1_4ToV1_5,
  migrateWireRecord,
  resolveWireMigrations,
  type WireMigration,
} from '#/wire/migration/migration';
import { isWireMetadataRecord, type WireRecord } from '#/wire/record';

import type { AgentReplayRecord, AgentReplayRecordPayload } from './types';

export interface WireReplayFold {
  readonly replay: readonly AgentReplayRecord[];
  readonly toolStore: Readonly<Record<string, unknown>>;
}

export const FOLD_RELEVANT_WIRE_TYPES: ReadonlySet<string> = new Set([
  'context.append_message',
  'context.append_loop_event',
  'context.undo',
  'context.clear',
  'context.apply_compaction',
  'full_compaction.begin',
  'full_compaction.cancel',
  'goal.create',
  'goal.update',
  'goal.clear',
  'goal.account_usage',
  'goal.continuation',
  'forked',
  'plan_mode.enter',
  'plan_mode.cancel',
  'plan_mode.exit',
  'config.update',
  'permission.set_mode',
  'permission.record_approval_result',
  'tools.update_store',
  'turn.prompt',
  'turn.steer',
  'turn.cancel',
]);

export const FOLD_CARRYOVER_WIRE_TYPES: ReadonlySet<string> = new Set([
  'tools.update_store',
  'goal.create',
  'goal.update',
  'goal.clear',
  'goal.account_usage',
  'goal.continuation',
  'forked',
  'context.undo',
  'context.clear',
  'context.apply_compaction',
  'turn.prompt',
  'turn.steer',
  'turn.cancel',
]);

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

const GOAL_FORK_CLEARED_REMINDER =
  'This fork does not have a current goal. Ignore earlier active-goal reminders from the source session. Handle requests normally unless the user starts a new goal.';

const REPLAY_TURN_ID = '__replayTurnId';

export function foldWireRecords(
  records: readonly WireRecord[],
  decodePersistent?: (record: WireRecord) => WireRecord,
  matchingRecords?: readonly WireRecord[],
): WireReplayFold {
  const turnIdByAppend = new Map<WireRecord, number>();
  for (const match of matchWireTurnInputRecords(matchingRecords ?? records, true)) {
    if (match.turnId !== undefined) {
      turnIdByAppend.set((matchingRecords ?? records)[match.appendIndex]!, match.turnId);
    }
  }
  const fold = new WireReplayFoldState();
  const annotated = records.map((record) =>
    record.type === 'context.append_message'
      ? { ...record, [REPLAY_TURN_ID]: turnIdByAppend.get(record) }
      : record,
  );
  for (const record of migrateJournalRecords(annotated)) {
    fold.apply(decodePersistent === undefined ? record : decodePersistent(record));
  }
  fold.finish();
  return { replay: fold.replay, toolStore: fold.toolStore };
}

function migrateJournalRecords(records: readonly WireRecord[]): WireRecord[] {
  if (records.length === 0) return [];
  const first = records[0]!;
  let migrations: readonly WireMigration[];
  if (first.type === 'metadata') {
    if (!isWireMetadataRecord(first)) {
      throw new Error('Agent wire metadata is malformed');
    }
    migrations = isNewerWireVersion(first.protocol_version)
      ? []
      : resolveWireMigrations(first.protocol_version);
  } else {
    migrations = [migrateV1_4ToV1_5];
  }
  return records.map((record) => migrateWireRecord(record, migrations));
}

interface FoldGoalState {
  goalId: string;
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  tokensUsed: number;
  wallClockMs: number;
  budgetLimits: GoalBudgetLimits;
  terminalReason?: string;
}

class WireReplayFoldState {
  readonly replay: AgentReplayRecord[] = [];
  readonly toolStore: Record<string, unknown> = {};
  private history: ContextMessage[] = [];
  private readonly openSteps = new Map<string, ContextMessage>();
  private readonly pendingToolResultIds = new Set<string>();
  private deferredMessages: { readonly message: ContextMessage; readonly turnId?: number }[] = [];
  private goal: FoldGoalState | undefined;
  private nextTurnId = 0;
  private readonly cancelledTurnIds = new Set<number>();

  apply(record: WireRecord): void {
    const time = record.time ?? Date.now();
    switch (record.type) {
      case 'context.append_message':
        this.appendMessage(
          record['message'] as ContextMessage,
          time,
          readNumber(record, REPLAY_TURN_ID),
        );
        return;
      case 'context.append_loop_event':
        this.appendLoopEvent(record['event'] as LoopRecordedEvent, time);
        return;
      case 'context.undo':
        this.undo(record['count'] as number);
        return;
      case 'context.clear':
        this.clearContext();
        return;
      case 'context.apply_compaction':
        this.applyCompaction(record);
        return;
      case 'turn.prompt':
        this.updateTurnId(record);
        return;
      case 'turn.steer':
        return;
      case 'turn.cancel': {
        const turnId = record['turnId'];
        if (
          record['target'] !== undefined &&
          typeof turnId === 'number' &&
          turnId >= this.nextTurnId
        ) {
          this.cancelledTurnIds.add(turnId);
          while (this.cancelledTurnIds.delete(this.nextTurnId)) this.nextTurnId += 1;
        }
        return;
      }
      case 'full_compaction.begin':
        this.push(
          { type: 'compaction', instruction: readString(record, 'instruction') },
          time,
        );
        return;
      case 'full_compaction.cancel':
        this.patchLastCompaction({ result: 'cancelled' });
        return;
      case 'goal.create':
        this.createGoal(record, time);
        return;
      case 'goal.update':
        this.updateGoal(record, time);
        return;
      case 'goal.clear':
        this.goal = undefined;
        return;
      case 'forked':
        this.applyForked(time);
        return;
      case 'plan_mode.enter':
        this.push({ type: 'plan_updated', enabled: true }, time);
        return;
      case 'plan_mode.cancel':
      case 'plan_mode.exit':
        this.push({ type: 'plan_updated', enabled: false }, time);
        return;
      case 'config.update':
        this.updateConfig(record, time);
        return;
      case 'permission.set_mode':
        this.push({ type: 'permission_updated', mode: record['mode'] as PermissionMode }, time);
        return;
      case 'permission.record_approval_result':
        this.recordApprovalResult(record, time);
        return;
      case 'tools.update_store':
        this.toolStore[record['key'] as string] = record['value'];
        return;
      default:
        return;
    }
  }

  finish(): void {
    this.closePendingToolResults(Date.now());
  }

  private push(payload: AgentReplayRecordPayload, time: number): void {
    this.replay.push({ ...payload, time });
  }

  private updateTurnId(record: WireRecord): void {
    const explicitTurnId = record['turnId'];
    const turnId = typeof explicitTurnId === 'number' ? explicitTurnId : this.nextTurnId;
    this.nextTurnId = Math.max(this.nextTurnId, turnId + 1);
    while (this.cancelledTurnIds.delete(this.nextTurnId)) this.nextTurnId += 1;
  }

  private pushHistory(messages: readonly ContextMessage[], time: number): void {
    for (const message of messages) this.pushHistoryEntry(message, time);
  }

  private pushHistoryEntry(message: ContextMessage, time: number, turnId?: number): void {
    this.history.push(message);
    if (message.role === 'user' && turnId !== undefined) {
      this.push({ type: 'message', message, turnId }, time);
    } else {
      this.push({ type: 'message', message }, time);
    }
  }

  private appendMessage(message: ContextMessage, time: number, turnId?: number): void {
    if (this.pendingToolResultIds.size > 0) {
      this.deferredMessages.push({ message, turnId });
      return;
    }
    this.pushHistoryEntry(message, time, turnId);
  }

  private flushDeferredMessages(time: number): void {
    if (this.pendingToolResultIds.size > 0 || this.deferredMessages.length === 0) {
      return;
    }
    for (const entry of this.deferredMessages) {
      this.pushHistoryEntry(entry.message, time, entry.turnId);
    }
    this.deferredMessages = [];
  }

  private closePendingToolResults(time: number): void {
    if (this.pendingToolResultIds.size === 0) return;
    const messages: ContextMessage[] = [];
    for (const toolCallId of this.pendingToolResultIds) {
      messages.push({
        ...createToolMessage(toolCallId, TOOL_INTERRUPTED_ON_RESUME_OUTPUT),
        isError: true,
      });
    }
    this.pendingToolResultIds.clear();
    this.pushHistory(messages, time);
    this.flushDeferredMessages(time);
  }

  private appendLoopEvent(event: LoopRecordedEvent, time: number): void {
    switch (event.type) {
      case 'step.begin': {
        this.closePendingToolResults(time);
        const message: ContextMessage = { role: 'assistant', content: [], toolCalls: [] };
        this.pushHistory([message], time);
        this.openSteps.set(event.uuid, message);
        return;
      }
      case 'step.end': {
        this.openSteps.delete(event.uuid);
        this.flushDeferredMessages(time);
        return;
      }
      case 'content.part': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined) {
          throw new Error(
            `Received content_part for unknown step_uuid '${event.stepUuid}' (no open step_begin)`,
          );
        }
        openStep.content.push(event.part);
        return;
      }
      case 'tool.call': {
        const openStep = this.openSteps.get(event.stepUuid);
        if (openStep === undefined || openStep.role !== 'assistant') {
          throw new Error(
            `Received tool_call for unknown step_uuid '${event.stepUuid}' (no open step_begin)`,
          );
        }
        openStep.toolCalls.push({
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
          extras: event.extras,
        });
        if (event.display !== undefined) {
          openStep.toolCallDisplays ??= {};
          openStep.toolCallDisplays[event.toolCallId] = event.display;
        }
        this.pendingToolResultIds.add(event.toolCallId);
        return;
      }
      case 'tool.result': {
        if (!this.pendingToolResultIds.has(event.toolCallId)) return;
        const output = event.result.output;
        this.pushHistory(
          [
            {
              ...createToolMessage(
                event.toolCallId,
                typeof output === 'string' ? output : [...output],
              ),
              isError: event.result.isError,
              note: event.result.note,
            },
          ],
          time,
        );
        this.pendingToolResultIds.delete(event.toolCallId);
        this.flushDeferredMessages(time);
        return;
      }
    }
  }

  private undo(count: number): void {
    if (count <= 0 || this.history.length === 0) return;
    const removed = new Set<ContextMessage>();
    let removedUserCount = 0;
    for (let i = this.history.length - 1; i >= 0; i--) {
      const message = this.history[i]!;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      removed.add(message);
      this.history.splice(i, 1);
      if (isRealUserInput(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }
    for (let i = this.replay.length - 1; i >= 0; i--) {
      const record = this.replay[i]!;
      if (record.type === 'message' && removed.has(record.message)) {
        this.replay.splice(i, 1);
      }
    }
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
  }

  private clearContext(): void {
    this.history = [];
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
  }

  private applyCompaction(record: WireRecord): void {
    const summary = readCompactionSummary(record);
    const contextSummary = readString(record, 'contextSummary') ?? summary;
    const compactedCount = readNumber(record, 'compactedCount') ?? readNumber(record, 'count') ?? 0;
    const keptTail = this.selectLegacyKeptTail(record);
    const result: CompactionResult = {
      summary,
      contextSummary,
      compactedCount,
      tokensBefore: readNumber(record, 'tokensBefore') ?? 0,
      tokensAfter:
        readNumber(record, 'tokensAfter') ??
        estimateTokens(contextSummary) + estimateTokensForMessages(keptTail),
      keptUserMessageCount: readNumber(record, 'keptUserMessageCount') ?? keptTail.length,
      keptHeadUserMessageCount: readNumber(record, 'keptHeadUserMessageCount'),
      droppedCount: readNumber(record, 'droppedCount'),
    };
    this.patchLastCompaction({ result });
    const summaryMessage: ContextMessage = {
      role: 'user',
      content: [{ type: 'text', text: contextSummary }],
      origin: { kind: 'compaction_summary' },
    };
    this.history =
      readNumber(record, 'keptUserMessageCount') === undefined &&
      compactedCount < this.history.length
        ? [summaryMessage, ...this.history.slice(compactedCount)]
        : [summaryMessage];
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
  }

  private patchLastCompaction(patch: { readonly result: CompactionResult | 'cancelled' }): void {
    const last = this.replay.at(-1);
    if (last?.type === 'compaction') {
      Object.assign(last, patch);
    }
  }

  private selectLegacyKeptTail(record: WireRecord): ContextMessage[] {
    if (
      readNumber(record, 'tokensAfter') !== undefined &&
      readNumber(record, 'keptUserMessageCount') !== undefined
    ) {
      return [];
    }
    const compactable = this.history.filter((message) => isRealUserInput(message));
    const selected: ContextMessage[] = [];
    let remaining = COMPACT_USER_MESSAGE_MAX_TOKENS;
    for (let i = compactable.length - 1; i >= 0 && remaining > 0; i--) {
      const message = compactable[i]!;
      const tokens = estimateTokensForMessages([message]);
      selected.unshift(message);
      if (tokens > remaining) break;
      remaining -= tokens;
    }
    return selected;
  }

  private createGoal(record: WireRecord, time: number): void {
    const state: FoldGoalState = {
      goalId: record['goalId'] as string,
      objective: record['objective'] as string,
      completionCriterion: readString(record, 'completionCriterion'),
      status: 'active',
      turnsUsed: 0,
      tokensUsed: 0,
      wallClockMs: 0,
      budgetLimits: {},
    };
    this.goal = state;
    this.push(
      { type: 'goal_updated', snapshot: goalSnapshot(state), change: { kind: 'created' } },
      time,
    );
  }

  private updateGoal(record: WireRecord, time: number): void {
    const state = this.goal;
    if (state === undefined) return;
    const status = record['status'] as GoalStatus | undefined;
    const reason = readString(record, 'reason');
    if (status !== undefined) {
      state.status = status;
      state.terminalReason = status === 'active' ? undefined : reason;
    }
    const turnsUsed = readNumber(record, 'turnsUsed');
    if (turnsUsed !== undefined) state.turnsUsed = turnsUsed;
    const tokensUsed = readNumber(record, 'tokensUsed');
    if (tokensUsed !== undefined) state.tokensUsed = tokensUsed;
    const wallClockMs = readNumber(record, 'wallClockMs');
    if (wallClockMs !== undefined) state.wallClockMs = wallClockMs;
    const budgetLimits = record['budgetLimits'] as GoalBudgetLimits | undefined;
    if (budgetLimits !== undefined) state.budgetLimits = budgetLimits;
    if (status === undefined) return;
    const actor = record['actor'] as GoalActor | undefined;
    this.push(
      {
        type: 'goal_updated',
        snapshot: goalSnapshot(state),
        change:
          status === 'complete'
            ? {
                kind: 'completion',
                status,
                reason,
                stats: {
                  turnsUsed: state.turnsUsed,
                  tokensUsed: state.tokensUsed,
                  wallClockMs: state.wallClockMs,
                },
                actor,
              }
            : { kind: 'lifecycle', status, reason, actor },
      },
      time,
    );
  }

  private applyForked(time: number): void {
    if (this.goal === undefined) return;
    this.goal = undefined;
    this.appendMessage(
      {
        role: 'user',
        content: [
          { type: 'text', text: `<system-reminder>\n${GOAL_FORK_CLEARED_REMINDER}\n</system-reminder>` },
        ],
          origin: { kind: 'system_trigger', name: 'goal_fork_cleared' },
      },
      time,
    );
  }

  private updateConfig(record: WireRecord, time: number): void {
    const config: AgentConfigUpdateData = {
      modelAlias: readString(record, 'modelAlias'),
      profileName: readString(record, 'profileName'),
      thinkingLevel: readString(record, 'thinkingEffort') ?? readString(record, 'thinkingLevel'),
      systemPrompt: readString(record, 'systemPrompt'),
    };
    this.push({ type: 'config_updated', config }, time);
  }

  private recordApprovalResult(record: WireRecord, time: number): void {
    const approval: PermissionApprovalResultRecord = {
      turnId: record['turnId'] as number,
      toolCallId: record['toolCallId'] as string,
      toolName: record['toolName'] as string,
      action: record['action'] as string,
      sessionApprovalRule: readString(record, 'sessionApprovalRule'),
      result: record['result'] as PermissionApprovalResultRecord['result'],
    };
    this.push({ type: 'approval_result', record: approval }, time);
  }
}

function goalSnapshot(state: FoldGoalState): GoalSnapshot {
  return {
    goalId: state.goalId,
    objective: state.objective,
    completionCriterion: state.completionCriterion,
    status: state.status,
    turnsUsed: state.turnsUsed,
    tokensUsed: state.tokensUsed,
    wallClockMs: state.wallClockMs,
    budget: goalBudgetReport(state),
    terminalReason: state.terminalReason,
  };
}

function goalBudgetReport(state: FoldGoalState): GoalBudgetReport {
  const tokenBudget = state.budgetLimits.tokenBudget ?? null;
  const turnBudget = state.budgetLimits.turnBudget ?? null;
  const wallClockBudgetMs = state.budgetLimits.wallClockBudgetMs ?? null;
  const tokenBudgetReached = tokenBudget !== null && state.tokensUsed >= tokenBudget;
  const turnBudgetReached = turnBudget !== null && state.turnsUsed >= turnBudget;
  const wallClockBudgetReached =
    wallClockBudgetMs !== null && state.wallClockMs >= wallClockBudgetMs;
  return {
    tokenBudget,
    turnBudget,
    wallClockBudgetMs,
    remainingTokens: tokenBudget === null ? null : Math.max(0, tokenBudget - state.tokensUsed),
    remainingTurns: turnBudget === null ? null : Math.max(0, turnBudget - state.turnsUsed),
    remainingWallClockMs:
      wallClockBudgetMs === null ? null : Math.max(0, wallClockBudgetMs - state.wallClockMs),
    tokenBudgetReached,
    turnBudgetReached,
    wallClockBudgetReached,
    overBudget: tokenBudgetReached || turnBudgetReached || wallClockBudgetReached,
  };
}

export interface WireTurnInputMatch {
  readonly appendIndex: number;
  readonly inputIndex?: number;
  readonly visibleTurnIndex: number;
  readonly turnId?: number;
}

export function matchWireTurnInputRecords(
  records: readonly WireRecord[],
  allUserMessages = false,
): WireTurnInputMatch[] {
  const inputIndices: number[] = [];
  const appends: {
    readonly record: WireRecord;
    readonly index: number;
    readonly visibleTurnIndex: number;
  }[] = [];
  const turnIds = new Map<number, number>();
  const cancelledTurnIds = new Set<number>();
  let currentTurnId: number | undefined;
  let nextTurnId = 0;
  let visibleTurnIndex = 0;
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]!;
    if (
      record.type === 'context.undo' ||
      record.type === 'context.clear' ||
      record.type === 'context.apply_compaction'
    ) {
      currentTurnId = undefined;
    }
    if (record.type === 'turn.cancel') {
      const turnId = record['turnId'];
      if (record['target'] !== undefined && typeof turnId === 'number' && turnId >= nextTurnId) {
        cancelledTurnIds.add(turnId);
        while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
      }
      continue;
    }
    if (record.type === 'turn.prompt') {
      const explicitTurnId = record['turnId'];
      const turnId = typeof explicitTurnId === 'number' ? explicitTurnId : nextTurnId;
      currentTurnId = turnId;
      turnIds.set(index, turnId);
      nextTurnId = Math.max(nextTurnId, turnId + 1);
      while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
    } else if (record.type === 'turn.steer') {
      const explicitTurnId = record['turnId'];
      const turnId = typeof explicitTurnId === 'number' ? explicitTurnId : currentTurnId;
      if (turnId !== undefined) turnIds.set(index, turnId);
    }
    const isInput = allUserMessages
      ? record.type === 'turn.prompt' || record.type === 'turn.steer'
      : isVisibleWireTurnInput(record);
    if (isInput) inputIndices.push(index);
    const isAppend = allUserMessages
      ? record.type === 'context.append_message' &&
        wireRecordObject(record['message'])?.['role'] === 'user'
      : isVisibleWireTurnAppend(record);
    if (!isAppend) continue;
    appends.push({ record, index, visibleTurnIndex });
    visibleTurnIndex += 1;
  }
  const unused = [...inputIndices];
  const matches: WireTurnInputMatch[] = [];
  for (const append of appends) {
    const exact = unused.findIndex(
      (index) =>
        (records[index]!.type !== 'turn.prompt' || index < append.index) &&
        wireTurnInputMatches(records[index]!, append.record, true, allUserMessages),
    );
    const matchAt = exact !== -1
      ? exact
      : unused.findIndex(
          (index) =>
            (records[index]!.type !== 'turn.prompt' || index < append.index) &&
            wireTurnInputMatches(records[index]!, append.record, false, allUserMessages),
        );
    const inputIndex = matchAt === -1 ? undefined : unused.splice(matchAt, 1)[0];
    matches.push({
      appendIndex: append.index,
      inputIndex,
      visibleTurnIndex: append.visibleTurnIndex,
      turnId: inputIndex === undefined ? undefined : turnIds.get(inputIndex),
    });
  }
  return matches;
}

function isVisibleWireTurnInput(record: WireRecord): boolean {
  if (record.type !== 'turn.prompt' && record.type !== 'turn.steer') return false;
  const origin = wireRecordObject(record['origin']);
  switch (origin?.['kind']) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin?.['trigger'] === 'user-slash';
    case 'shell_command':
      return origin?.['phase'] === 'input';
    default:
      return false;
  }
}

function isVisibleWireTurnAppend(record: WireRecord): boolean {
  if (record.type !== 'context.append_message') return false;
  const message = wireRecordObject(record['message']);
  if (message === undefined || message['role'] !== 'user') return false;
  const origin = wireRecordObject(message['origin']);
  switch (origin?.['kind']) {
    case undefined:
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin?.['trigger'] === 'user-slash';
    case 'shell_command':
      return origin?.['phase'] === 'input';
    default:
      return false;
  }
}

function wireTurnInputMatches(
  inputRecord: WireRecord,
  turnRecord: WireRecord,
  compareContent: boolean,
  anyOrigin: boolean,
): boolean {
  if (inputRecord.type !== 'turn.prompt' && inputRecord.type !== 'turn.steer') return false;
  if (turnRecord.type !== 'context.append_message') return false;
  const message = wireRecordObject(turnRecord['message']);
  if (message === undefined || message['role'] !== 'user') return false;
  if (!anyOrigin) {
    const inputKind = wireRecordObject(inputRecord['origin'])?.['kind'];
    if (typeof inputKind !== 'string') return false;
    const messageKind = wireRecordObject(message['origin'])?.['kind'];
    if (messageKind !== undefined && typeof messageKind !== 'string') return false;
    if (
      inputKind === 'user'
        ? messageKind !== undefined && messageKind !== 'user'
        : inputKind !== messageKind
    ) {
      return false;
    }
  }
  const messageId = typeof message['id'] === 'string' ? message['id'] : undefined;
  const steerMessageId =
    inputRecord.type === 'turn.steer' && typeof inputRecord['messageId'] === 'string'
      ? inputRecord['messageId']
      : undefined;
  if (steerMessageId !== undefined && messageId !== undefined) {
    return steerMessageId === messageId;
  }
  const promptId =
    inputRecord.type === 'turn.prompt' && typeof inputRecord['promptId'] === 'string'
      ? inputRecord['promptId']
      : undefined;
  if (promptId !== undefined && messageId !== undefined) return promptId === messageId;
  return (
    !compareContent ||
    JSON.stringify(inputRecord['input']) === JSON.stringify(message['content'])
  );
}

function wireRecordObject(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function isRealUserInput(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined) return true;
  switch (origin.kind) {
    case 'user':
      return true;
    case 'skill_activation':
    case 'plugin_command':
      return origin.trigger === 'user-slash';
    default:
      return false;
  }
}

function readString(record: WireRecord, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

function readNumber(record: WireRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function readCompactionSummary(record: WireRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (summary !== null && typeof summary === 'object' && !Array.isArray(summary)) {
    const content = (summary as { readonly content?: unknown }).content;
    if (Array.isArray(content)) {
      let text = '';
      for (const part of content) {
        if (part !== null && typeof part === 'object') {
          const typed = part as { readonly type?: unknown; readonly text?: unknown };
          if (typed.type === 'text' && typeof typed.text === 'string') text += typed.text;
        }
      }
      return text;
    }
  }
  return '';
}
