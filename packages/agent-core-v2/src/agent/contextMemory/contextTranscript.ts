/**
 * `contextMemory` transcript reducer — rebuilds the FULL message history of an
 * agent from its `context.*` wire records for UI display (snapshot / messages).
 *
 * The live `ContextModel` (`ContextMemoryService`) rewrites the model-facing
 * context on `context.apply_compaction` into `[...keptUserMessages,
 * compaction_summary]`, so reading the live context after a compaction loses
 * everything before the fold. The wire log keeps every record, though, so this
 * reducer re-reduces the `context.*` records with the same semantics as the
 * live `ContextMemory` restore, EXCEPT that `context.apply_compaction` KEEPS
 * the full history and appends a user-role summary marker — the same view the
 * v1 transcript / TUI shows after resume. `foldedLength` tracks what the live
 * (folded) `context.history.length` would be, so a caller can detect and
 * append an unflushed live tail.
 *
 * Mirrors v1 `reduceWireRecords`
 * (`packages/agent-core/src/services/message/transcript.ts`):
 *   - `context.append_message`    → append (deferred while a tool exchange is open)
 *   - `context.append_loop_event` → step.begin/content.part/tool.call mutate the
 *                                   open assistant; tool.result appends a tool
 *                                   message with the raw output; settling a step
 *                                   (at its end or at the next begin) drops an
 *                                   output-free assistant, mirroring the live fold
 *   - `context.apply_compaction`  → keep the full history, append the user-role
 *                                   summary marker, recover `foldedLength` from
 *                                   the recorded kept-count fields
 *   - `context.undo`              → remove tail messages (skip injections, stop
 *                                   at compaction summaries / clear floor)
 *   - `context.clear`             → keep prior transcript entries but reset the
 *                                   folded view
 */

import { type ContentPart, type ToolCall } from '#/kosong/contract/message';
import type { WireRecord } from '#/wire/record';

import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  collectCompactableUserMessages,
  isRealUserInput,
  selectRecentUserMessages,
} from './compactionHandoff';
import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage } from './types';
import { isVacuousContentPart } from './vacuousContent';

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

export interface ContextTranscript {
  readonly entries: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
  readonly foldedLength: number;
}

export interface ContextTranscriptReducer {
  add(record: WireRecord): void;
  result(): ContextTranscript;
}

interface MutableMessage {
  id?: string;
  role: ContextMessage['role'];
  content: ContentPart[];
  toolCalls: ToolCall[];
  toolCallId?: string;
  isError?: boolean;
  origin?: ContextMessage['origin'];
}

interface MutableEntry {
  message: MutableMessage;
  time?: number;
}

export function reduceContextTranscript(records: Iterable<WireRecord>): ContextTranscript {
  const reducer = createContextTranscriptReducer();
  for (const record of records) reducer.add(record);
  return reducer.result();
}

export function createContextTranscriptReducer(): ContextTranscriptReducer {
  const transcript: MutableEntry[] = [];
  let foldedLength = 0;
  let clearFloor = 0;
  const openSteps = new Map<string, MutableEntry>();
  const pendingToolResultIds = new Set<string>();
  let deferred: MutableEntry[] = [];
  let lastOpenStepUuid: string | undefined;

  const push = (...entries: MutableEntry[]): void => {
    transcript.push(...entries);
    foldedLength += entries.length;
  };
  const flushDeferredIfToolExchangeClosed = (): void => {
    if (pendingToolResultIds.size > 0 || deferred.length === 0) return;
    push(...deferred);
    deferred = [];
  };
  const closePendingToolResults = (time: number | undefined): void => {
    if (pendingToolResultIds.size === 0) return;
    const interruptedToolCallIds = [...pendingToolResultIds];
    for (const toolCallId of interruptedToolCallIds) {
      push({
        message: {
          role: 'tool',
          content: [{ type: 'text', text: TOOL_INTERRUPTED_ON_RESUME_OUTPUT }],
          toolCalls: [],
          toolCallId,
          isError: true,
        },
        time,
      });
      pendingToolResultIds.delete(toolCallId);
    }
    flushDeferredIfToolExchangeClosed();
  };
  const resetOpenState = (): void => {
    openSteps.clear();
    pendingToolResultIds.clear();
    deferred = [];
    lastOpenStepUuid = undefined;
  };
  const settleStep = (uuid: string): void => {
    const entry = openSteps.get(uuid);
    if (entry === undefined) return;
    openSteps.delete(uuid);
    if (entry.message.toolCalls.length > 0) return;
    if (!entry.message.content.every(isVacuousContentPart)) return;
    const index = transcript.indexOf(entry);
    if (index === -1) return;
    transcript.splice(index, 1);
    foldedLength = Math.max(0, foldedLength - 1);
  };

  const applyLoopEvent = (event: LoopRecordedEvent, time: number | undefined): void => {
    switch (event.type) {
      case 'step.begin': {
        closePendingToolResults(time);
        if (lastOpenStepUuid !== undefined) settleStep(lastOpenStepUuid);
        const entry: MutableEntry = {
          message: { role: 'assistant', content: [], toolCalls: [] },
          time,
        };
        push(entry);
        openSteps.set(event.uuid, entry);
        lastOpenStepUuid = event.uuid;
        return;
      }
      case 'step.end': {
        settleStep(event.uuid);
        if (lastOpenStepUuid === event.uuid) lastOpenStepUuid = undefined;
        flushDeferredIfToolExchangeClosed();
        return;
      }
      case 'content.part': {
        openSteps.get(event.stepUuid)?.message.content.push(event.part);
        return;
      }
      case 'tool.call': {
        const openStep = openSteps.get(event.stepUuid);
        if (openStep === undefined) return;
        const call: ToolCall = {
          type: 'function',
          id: event.toolCallId,
          name: event.name,
          arguments: event.args === undefined ? null : JSON.stringify(event.args),
          ...(event.extras !== undefined ? { extras: event.extras } : {}),
        };
        openStep.message.toolCalls.push(call);
        pendingToolResultIds.add(event.toolCallId);
        return;
      }
      case 'tool.result': {
        if (!pendingToolResultIds.has(event.toolCallId)) return;
        push({
          message: {
            role: 'tool',
            content: rawToolResultContent(event.result.output),
            toolCalls: [],
            toolCallId: event.toolCallId,
            isError: event.result.isError,
          },
          time,
        });
        pendingToolResultIds.delete(event.toolCallId);
        flushDeferredIfToolExchangeClosed();
        return;
      }
    }
  };

  const applyUndo = (count: number): void => {
    if (count <= 0) return;
    let removedUserCount = 0;
    for (let i = transcript.length - 1; i >= clearFloor; i--) {
      const message = transcript[i]!.message;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      transcript.splice(i, 1);
      foldedLength = Math.max(0, foldedLength - 1);
      if (isRealUserInput(message)) {
        removedUserCount++;
        if (removedUserCount >= count) break;
      }
    }
    resetOpenState();
  };

  const add = (record: WireRecord): void => {
    switch (record.type) {
      case 'context.append_message': {
        const entry = toMutableEntry(record['message'] as ContextMessage, record.time);
        if (pendingToolResultIds.size > 0) deferred.push(entry);
        else push(entry);
        break;
      }
      case 'context.append_loop_event':
        applyLoopEvent(record['event'] as LoopRecordedEvent, record.time);
        break;
      case 'context.apply_compaction': {
        transcript.push({
          message: {
            role: 'user',
            content: [{ type: 'text', text: readCompactionSummaryText(record) }],
            toolCalls: [],
            origin: { kind: 'compaction_summary' },
          },
          time: record.time,
        });
        foldedLength = recoverFoldedLength(record, transcript, clearFloor, foldedLength);
        resetOpenState();
        break;
      }
      case 'context.undo':
        applyUndo(record['count'] as number);
        break;
      case 'context.clear':
        clearFloor = transcript.length;
        foldedLength = 0;
        resetOpenState();
        break;
      default:
        break;
    }
  };

  return {
    add,
    result: () => ({
      entries: transcript.map((e) => e.message),
      times: transcript.map((e) => e.time),
      foldedLength,
    }),
  };
}

function toMutableEntry(message: ContextMessage, time: number | undefined): MutableEntry {
  return {
    message: {
      ...(message.id !== undefined ? { id: message.id } : {}),
      role: message.role,
      content: [...message.content],
      toolCalls: [...message.toolCalls],
      ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
      ...(message.isError !== undefined ? { isError: message.isError } : {}),
      ...(message.origin !== undefined ? { origin: message.origin } : {}),
    },
    time,
  };
}

function recoverFoldedLength(
  record: WireRecord,
  transcript: readonly MutableEntry[],
  clearFloor: number,
  foldedLength: number,
): number {
  const keptUserMessageCount = readNumber(record, 'keptUserMessageCount');
  const keptHeadUserMessageCount = readNumber(record, 'keptHeadUserMessageCount');
  const compactedCount = readNumber(record, 'compactedCount');
  if (keptUserMessageCount !== undefined) {
    return keptUserMessageCount + (keptHeadUserMessageCount === undefined ? 1 : 2);
  }
  if (compactedCount !== undefined && compactedCount < foldedLength) {
    return 1 + (foldedLength - compactedCount);
  }
  const keptUserMessages = selectRecentUserMessages(
    collectCompactableUserMessages(transcript.slice(clearFloor).map((e) => e.message)),
    COMPACT_USER_MESSAGE_MAX_TOKENS,
  );
  return keptUserMessages.length + 1;
}

function readCompactionSummaryText(record: WireRecord): string {
  const summary = record['summary'];
  if (typeof summary === 'string') return summary;
  const contextSummary = record['contextSummary'];
  if (typeof contextSummary === 'string') return contextSummary;
  if (isContextMessageLike(summary)) return textOfParts(summary.content);
  return '';
}

function isContextMessageLike(value: unknown): value is ContextMessage {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const message = value as { role?: unknown; content?: unknown };
  return typeof message.role === 'string' && Array.isArray(message.content);
}

function textOfParts(content: readonly ContentPart[]): string {
  let text = '';
  for (const part of content) {
    if (part.type === 'text') text += part.text;
  }
  return text;
}

function readNumber(record: WireRecord, key: string): number | undefined {
  const value = record[key];
  return typeof value === 'number' ? value : undefined;
}

function rawToolResultContent(output: string | readonly ContentPart[]): ContentPart[] {
  return typeof output === 'string' ? [{ type: 'text', text: output }] : [...output];
}
