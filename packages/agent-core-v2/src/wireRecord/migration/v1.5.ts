import {
  createToolMessage,
  type ContentPart,
  type ToolCall,
} from '@moonshot-ai/kosong';

import type { CompactionResult } from '../../../../agent/compaction';
import type { ContextMessage, PromptOrigin } from '../../../../agent/context';
import type {
  ExecutableToolResult,
  LoopContentPartEvent,
  LoopRecordedEvent,
  LoopStepEndEvent,
  LoopToolCallEvent,
  LoopToolResultEvent,
} from '../../../../loop';
import type { WireMigration, WireMigrationRecord } from './index';

const TOOL_ERROR_STATUS = '<system>ERROR: Tool execution failed.</system>';
const TOOL_EMPTY_STATUS = '<system>Tool output is empty.</system>';
const TOOL_EMPTY_ERROR_STATUS =
  '<system>ERROR: Tool execution failed. Tool output is empty.</system>';
const TOOL_OUTPUT_EMPTY_TEXT = 'Tool output is empty.';
const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

export const migrateV1_4ToV1_5: WireMigration = {
  sourceVersion: '1.4',
  targetVersion: '1.5',
  migrateRecords(records: readonly WireMigrationRecord[]): readonly WireMigrationRecord[] {
    const state = new V1_5MigrationState();
    return records.flatMap((record) => state.migrate(record));
  },
};

class V1_5MigrationState {
  private readonly history: ContextMessage[] = [];
  private readonly openSteps = new Map<string, OpenStep>();
  private readonly pendingToolResultIds = new Set<string>();
  private readonly launchedTurnIds = new Set<number>();
  private readonly promptAppendDedupKeys: string[] = [];
  private deferredMessages: ContextMessage[] = [];
  private nextTurnId = 0;
  private hasGoal = false;

  migrate(record: WireMigrationRecord): WireMigrationRecord[] {
    switch (record.type) {
      case 'metadata':
        return [record];
      case 'turn.prompt':
        return this.migrateTurnPrompt(record as V1_4TurnPromptRecord);
      case 'turn.steer':
      case 'turn.cancel':
        return [];
      case 'turn.launch':
        return this.preserveTurnLaunch(record as V1_5TurnLaunchRecord);
      case 'context.append_message':
        return this.migrateAppendMessage(record as V1_4AppendMessageRecord);
      case 'context.append_loop_event':
        return this.migrateLoopEvent(record as V1_4AppendLoopEventRecord);
      case 'context.clear':
        return this.migrateClear(record);
      case 'context.apply_compaction':
        return this.migrateApplyCompaction(record as V1_4ApplyCompactionRecord);
      case 'full_compaction.complete':
        return [];
      case 'context.undo':
        return this.migrateUndo(record as V1_4UndoRecord);
      case 'context.splice':
        return this.preserveContextSplice(record as V1_5ContextSpliceRecord);
      case 'forked':
        return this.migrateForked(record);
      default:
        this.trackGoal(record);
        return [record];
    }
  }

  private migrateTurnPrompt(record: V1_4TurnPromptRecord): WireMigrationRecord[] {
    const turnId = this.allocateTurnId();
    const message: ContextMessage = {
      role: 'user',
      content: cloneContentParts(record.input),
      toolCalls: [],
      origin: record.origin,
    };
    this.promptAppendDedupKeys.push(messageKey(message));
    return [
      ...this.appendNow(message, record),
      this.createTurnLaunchRecord(turnId, record.origin, record),
    ];
  }

  private preserveTurnLaunch(record: V1_5TurnLaunchRecord): WireMigrationRecord[] {
    this.markTurnLaunched(record.turnId);
    return [record];
  }

  private migrateAppendMessage(record: V1_4AppendMessageRecord): WireMigrationRecord[] {
    const message = cloneContextMessage(record.message);
    if (this.consumePromptAppendDedup(message)) {
      return [];
    }
    if (this.pendingToolResultIds.size > 0) {
      this.deferredMessages.push(message);
      return [];
    }
    return this.appendNow(message, record);
  }

  private migrateLoopEvent(record: V1_4AppendLoopEventRecord): WireMigrationRecord[] {
    const event = record.event;
    const output = this.ensureTurnLaunchForEvent(event, record);
    switch (event.type) {
      case 'step.begin':
        output.push(...this.closePendingToolResults(record));
        this.openSteps.set(event.uuid, {
          message: createAssistantMessage(),
          inserted: false,
        });
        return output;
      case 'content.part':
        output.push(...this.applyContentPart(event, record));
        return output;
      case 'tool.call':
        output.push(...this.applyToolCall(event, record));
        return output;
      case 'tool.result':
        output.push(...this.applyToolResult(event, record));
        return output;
      case 'step.end':
        output.push(...this.applyStepEnd(event, record));
        return output;
      default:
        return output;
    }
  }

  private migrateClear(record: WireMigrationRecord): WireMigrationRecord[] {
    const deleteCount = this.history.length;
    this.history.splice(0, deleteCount);
    this.resetLoopState();
    if (deleteCount === 0) return [];
    return [this.createContextSpliceRecord(0, deleteCount, [], record)];
  }

  private migrateApplyCompaction(record: V1_4ApplyCompactionRecord): WireMigrationRecord[] {
    const message = createCompactionSummaryMessage(record.summary);
    const deleteCount = clampDeleteCount(record.compactedCount, this.history.length);
    this.history.splice(0, deleteCount, message);
    this.resetLoopState();
    return [
      this.createContextSpliceRecord(0, deleteCount, [message], record),
      this.createFullCompactionCompleteRecord(record),
    ];
  }

  private migrateUndo(record: V1_4UndoRecord): WireMigrationRecord[] {
    if (record.count <= 0) return [];

    const output: WireMigrationRecord[] = [];
    let removedUserCount = 0;
    for (let index = this.history.length - 1; index >= 0; index--) {
      const message = this.history[index];
      if (message === undefined) continue;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;

      this.history.splice(index, 1);
      output.push(this.createContextSpliceRecord(index, 1, [], record));
      if (isRealUserPrompt(message)) {
        removedUserCount++;
        if (removedUserCount >= record.count) break;
      }
    }
    this.resetLoopState();
    return output;
  }

  private preserveContextSplice(record: V1_5ContextSpliceRecord): WireMigrationRecord[] {
    const start = normalizedSpliceStart(record.start, this.history.length);
    const deleteCount = clampDeleteCount(record.deleteCount, this.history.length - start);
    const messages = record.messages.map(cloneContextMessage);
    this.history.splice(start, deleteCount, ...messages);
    return [record];
  }

  private migrateForked(record: WireMigrationRecord): WireMigrationRecord[] {
    if (!this.hasGoal) return [];
    this.hasGoal = false;
    return [withTime(record, { type: 'goal.clear' })];
  }

  private applyContentPart(
    event: LoopContentPartEvent,
    record: WireMigrationRecord,
  ): WireMigrationRecord[] {
    return this.replaceOpenStep(event.stepUuid, record, (message) => ({
      ...message,
      content: [...message.content, cloneContentPart(event.part)],
    }));
  }

  private applyToolCall(
    event: LoopToolCallEvent,
    record: WireMigrationRecord,
  ): WireMigrationRecord[] {
    const output = this.replaceOpenStep(event.stepUuid, record, (message) => ({
      ...message,
      toolCalls: [
        ...message.toolCalls,
        {
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
        },
      ],
    }));
    this.pendingToolResultIds.add(event.toolCallId);
    return output;
  }

  private applyToolResult(
    event: LoopToolResultEvent,
    record: WireMigrationRecord,
  ): WireMigrationRecord[] {
    if (!this.pendingToolResultIds.has(event.toolCallId)) return [];
    const output = this.appendToolResult(event.toolCallId, event.result, record);
    this.pendingToolResultIds.delete(event.toolCallId);
    output.push(...this.flushDeferredMessages(record));
    return output;
  }

  private applyStepEnd(
    event: LoopStepEndEvent,
    record: WireMigrationRecord,
  ): WireMigrationRecord[] {
    this.openSteps.delete(event.uuid);
    return this.flushDeferredMessages(record);
  }

  private replaceOpenStep(
    stepUuid: string,
    record: WireMigrationRecord,
    update: (message: ContextMessage) => ContextMessage,
  ): WireMigrationRecord[] {
    const openStep = this.openSteps.get(stepUuid) ?? {
      message: createAssistantMessage(),
      inserted: false,
    };
    const next = update(openStep.message);
    if (!openStep.inserted) {
      const inserted = cloneContextMessage(next);
      const start = this.history.length;
      this.history.push(inserted);
      this.openSteps.set(stepUuid, { message: inserted, inserted: true });
      return [this.createContextSpliceRecord(start, 0, [inserted], record)];
    }

    const index = this.history.indexOf(openStep.message);
    if (index < 0) {
      this.openSteps.set(stepUuid, { message: next, inserted: false });
      return this.appendNow(next, record);
    }

    this.history.splice(index, 1, next);
    this.openSteps.set(stepUuid, { message: next, inserted: true });
    return [this.createContextSpliceRecord(index, 1, [next], record)];
  }

  private appendToolResult(
    toolCallId: string,
    result: ExecutableToolResult,
    record: WireMigrationRecord,
  ): WireMigrationRecord[] {
    const message = createToolMessage(toolCallId, toolResultOutputForModel(result));
    return this.appendNow(
      {
        ...message,
        role: 'tool',
        isError: result.isError,
      },
      record,
    );
  }

  private closePendingToolResults(record: WireMigrationRecord): WireMigrationRecord[] {
    if (this.pendingToolResultIds.size === 0) return [];
    const output: WireMigrationRecord[] = [];
    const toolCallIds = [...this.pendingToolResultIds];
    for (const toolCallId of toolCallIds) {
      output.push(
        ...this.appendToolResult(
          toolCallId,
          {
            output: TOOL_INTERRUPTED_ON_RESUME_OUTPUT,
            isError: true,
          },
          record,
        ),
      );
      this.pendingToolResultIds.delete(toolCallId);
    }
    output.push(...this.flushDeferredMessages(record));
    return output;
  }

  private flushDeferredMessages(record: WireMigrationRecord): WireMigrationRecord[] {
    if (this.pendingToolResultIds.size > 0 || this.deferredMessages.length === 0) {
      return [];
    }
    const messages = this.deferredMessages;
    this.deferredMessages = [];
    const output: WireMigrationRecord[] = [];
    for (const message of messages) {
      output.push(...this.appendNow(message, record));
    }
    return output;
  }

  private appendNow(
    message: ContextMessage,
    record: WireMigrationRecord,
  ): WireMigrationRecord[] {
    const next = cloneContextMessage(message);
    const start = this.history.length;
    this.history.push(next);
    return [this.createContextSpliceRecord(start, 0, [next], record)];
  }

  private createContextSpliceRecord(
    start: number,
    deleteCount: number,
    messages: readonly ContextMessage[],
    source: WireMigrationRecord,
  ): WireMigrationRecord {
    return withTime(source, {
      type: 'context.splice',
      start,
      deleteCount,
      messages: messages.map(cloneContextMessage),
    });
  }

  private createTurnLaunchRecord(
    turnId: number,
    origin: PromptOrigin,
    source: WireMigrationRecord,
  ): WireMigrationRecord {
    this.markTurnLaunched(turnId);
    return withTime(source, { type: 'turn.launch', turnId, origin });
  }

  private createFullCompactionCompleteRecord(
    source: V1_4ApplyCompactionRecord,
  ): WireMigrationRecord {
    return withTime(source, {
      type: 'full_compaction.complete',
      compactedCount: source.compactedCount,
      tokensBefore: source.tokensBefore,
      tokensAfter: source.tokensAfter,
    });
  }

  private ensureTurnLaunchForEvent(
    event: LoopRecordedEvent,
    source: WireMigrationRecord,
  ): WireMigrationRecord[] {
    const turnId = turnIdOf(event);
    if (turnId === undefined || this.launchedTurnIds.has(turnId)) return [];
    return [
      this.createTurnLaunchRecord(
        turnId,
        { kind: 'system_trigger', name: 'migrated_turn' },
        source,
      ),
    ];
  }

  private allocateTurnId(): number {
    const turnId = this.nextTurnId;
    this.markTurnLaunched(turnId);
    return turnId;
  }

  private markTurnLaunched(turnId: number): void {
    this.launchedTurnIds.add(turnId);
    this.nextTurnId = Math.max(this.nextTurnId, turnId + 1);
  }

  private consumePromptAppendDedup(message: ContextMessage): boolean {
    const key = messageKey(message);
    const index = this.promptAppendDedupKeys.indexOf(key);
    if (index < 0) return false;
    this.promptAppendDedupKeys.splice(index, 1);
    return true;
  }

  private trackGoal(record: WireMigrationRecord): void {
    if (record.type === 'goal.create') {
      this.hasGoal = true;
    } else if (record.type === 'goal.clear') {
      this.hasGoal = false;
    }
  }

  private resetLoopState(): void {
    this.openSteps.clear();
    this.pendingToolResultIds.clear();
    this.deferredMessages = [];
  }
}

interface OpenStep {
  readonly message: ContextMessage;
  readonly inserted: boolean;
}

interface V1_4TurnPromptRecord extends WireMigrationRecord {
  readonly type: 'turn.prompt';
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
}

interface V1_5TurnLaunchRecord extends WireMigrationRecord {
  readonly type: 'turn.launch';
  readonly turnId: number;
  readonly origin: PromptOrigin;
}

interface V1_4AppendMessageRecord extends WireMigrationRecord {
  readonly type: 'context.append_message';
  readonly message: ContextMessage;
}

interface V1_4AppendLoopEventRecord extends WireMigrationRecord {
  readonly type: 'context.append_loop_event';
  readonly event: LoopRecordedEvent;
}

interface V1_4ApplyCompactionRecord extends WireMigrationRecord, CompactionResult {
  readonly type: 'context.apply_compaction';
}

interface V1_4UndoRecord extends WireMigrationRecord {
  readonly type: 'context.undo';
  readonly count: number;
}

interface V1_5ContextSpliceRecord extends WireMigrationRecord {
  readonly type: 'context.splice';
  readonly start: number;
  readonly deleteCount: number;
  readonly messages: readonly ContextMessage[];
}

function createAssistantMessage(): ContextMessage {
  return {
    role: 'assistant',
    content: [],
    toolCalls: [],
  };
}

function createCompactionSummaryMessage(summary: string): ContextMessage {
  return {
    role: 'assistant',
    content: [{ type: 'text', text: summary }],
    toolCalls: [],
    origin: { kind: 'compaction_summary' },
  };
}

function withTime<T extends WireMigrationRecord>(
  source: WireMigrationRecord,
  record: T,
): T {
  const time = source['time'];
  if (time === undefined) return record;
  return { ...record, time } as T;
}

function turnIdOf(event: LoopRecordedEvent): number | undefined {
  if (event.type === 'tool.result') return undefined;
  const turnId = Number(event.turnId);
  return Number.isInteger(turnId) && turnId >= 0 ? turnId : undefined;
}

function normalizedSpliceStart(start: number, length: number): number {
  if (!Number.isFinite(start)) return length;
  if (start < 0) return Math.max(0, length + start);
  return Math.min(start, length);
}

function clampDeleteCount(deleteCount: number, max: number): number {
  if (!Number.isFinite(deleteCount) || deleteCount <= 0) return 0;
  return Math.min(deleteCount, Math.max(0, max));
}

function isRealUserPrompt(message: ContextMessage): boolean {
  if (message.role !== 'user') return false;
  const origin = message.origin;
  if (origin === undefined || origin.kind === 'user') return true;
  if (origin.kind === 'skill_activation') {
    return origin.trigger === 'user-slash';
  }
  return false;
}

function toolResultOutputForModel(result: ExecutableToolResult): string | ContentPart[] {
  const output = result.output;
  if (typeof output === 'string') {
    if (result.isError === true) {
      if (output.length === 0) return TOOL_EMPTY_ERROR_STATUS;
      if (output.trimStart().startsWith('<system>ERROR:')) return output;
      return `${TOOL_ERROR_STATUS}\n${output}`;
    }
    return isEmptyOutputText(output) ? TOOL_EMPTY_STATUS : output;
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
    return [{ type: 'text', text: TOOL_ERROR_STATUS }, ...output.map(cloneContentPart)];
  }
  return output.map(cloneContentPart);
}

function isEmptyOutputText(output: string): boolean {
  return output.length === 0 || output.trim() === TOOL_OUTPUT_EMPTY_TEXT;
}

function cloneContextMessage(message: ContextMessage): ContextMessage {
  return {
    ...message,
    content: cloneContentParts(message.content),
    toolCalls: cloneToolCalls(message.toolCalls),
  };
}

function cloneContentParts(parts: readonly ContentPart[]): ContentPart[] {
  return parts.map(cloneContentPart);
}

function cloneContentPart<T extends ContentPart>(part: T): T {
  return { ...part };
}

function cloneToolCalls(toolCalls: readonly ToolCall[]): ToolCall[] {
  return toolCalls.map((toolCall) => ({ ...toolCall }));
}

function messageKey(message: ContextMessage): string {
  return JSON.stringify(message);
}
