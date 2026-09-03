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
import { createToolMessage } from '#/kosong/contract/message';
import { estimateTokens, estimateTokensForMessages } from '#/kosong/contract/tokens';
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

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

const GOAL_FORK_CLEARED_REMINDER =
  'This fork does not have a current goal. Ignore earlier active-goal reminders from the source session. Handle requests normally unless the user starts a new goal.';

export function foldWireRecords(records: readonly WireRecord[]): WireReplayFold {
  const fold = new WireReplayFoldState();
  for (const record of migrateJournalRecords(records)) {
    fold.apply(record);
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
  private deferredMessages: ContextMessage[] = [];
  private goal: FoldGoalState | undefined;

  apply(record: WireRecord): void {
    const time = record.time ?? Date.now();
    switch (record.type) {
      case 'context.append_message':
        this.appendMessage(record['message'] as ContextMessage, time);
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

  private pushHistory(messages: readonly ContextMessage[], time: number): void {
    for (const message of messages) {
      this.history.push(message);
      this.push({ type: 'message', message }, time);
    }
  }

  private appendMessage(message: ContextMessage, time: number): void {
    if (this.pendingToolResultIds.size > 0) {
      this.deferredMessages.push(message);
      return;
    }
    this.pushHistory([message], time);
  }

  private flushDeferredMessages(time: number): void {
    if (this.pendingToolResultIds.size > 0 || this.deferredMessages.length === 0) {
      return;
    }
    this.pushHistory(this.deferredMessages, time);
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
        if (openStep === undefined) {
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
      toolCalls: [],
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
        toolCalls: [],
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
