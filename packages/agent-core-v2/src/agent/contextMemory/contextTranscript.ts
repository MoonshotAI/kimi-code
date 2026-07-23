/**
 * `contextMemory` domain (L4) — rebuilds display history from the wire journal.
 *
 * Supplies message and transcript consumers with full pre-compaction history,
 * folded-context length, and stable turn identity while preserving live
 * undo/clear semantics. Scope-agnostic.
 */

import { type ContentPart, type ToolCall } from '#/kosong/contract/message';
import type { WireRecord } from '#/wire/record';

import {
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  collectCompactableUserMessages,
  selectRecentUserMessages,
} from './compactionHandoff';
import { isUndoAnchor } from './conversationTime';
import type { LoopRecordedEvent } from './loopEventFold';
import type { ContextMessage, PromptOrigin } from './types';
import { isVacuousContentPart } from './vacuousContent';

const TOOL_INTERRUPTED_ON_RESUME_OUTPUT =
  'Tool execution was interrupted before its result was recorded. Do not assume the tool completed successfully.';

export interface ContextTranscript {
  readonly entries: readonly ContextMessage[];
  readonly times: readonly (number | undefined)[];
  readonly turnIds: readonly (number | undefined)[];
  readonly turns: readonly ContextTranscriptTurn[];
  readonly stableTurnIds: boolean;
  readonly foldedLength: number;
}

export interface ContextTranscriptTurn {
  readonly turnId: number;
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
  readonly time?: number;
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
  turnId?: number;
  opensTurn: boolean;
  order: number;
}

interface MutableTurn extends ContextTranscriptTurn {
  readonly order: number;
}

interface PendingSteerBase {
  readonly input: readonly ContentPart[];
  readonly origin: PromptOrigin;
  readonly time?: number;
  readonly order: number;
  readonly expectsMessage: boolean;
}

type PendingSteer =
  | (PendingSteerBase & { readonly state: 'recorded' })
  | (PendingSteerBase & { readonly state: 'message-bound'; readonly entry: MutableEntry })
  | (PendingSteerBase & {
      readonly state: 'turn-bound';
      readonly turnId: number;
      readonly opensTurn: boolean;
    });

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
  let turns: MutableTurn[] = [];
  let nextTurnId = 0;
  let currentTurnId: number | undefined;
  const cancelledTurnIds = new Set<number>();
  let pendingPromptAnchor: { readonly turnId: number } | undefined;
  let pendingSteers: PendingSteer[] = [];
  let stableTurnIds = true;
  let recordOrder = 0;
  const toolTurnIds = new Map<string, number | undefined>();

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
        turnId: toolTurnIds.get(toolCallId),
        opensTurn: false,
        order: recordOrder,
      });
      pendingToolResultIds.delete(toolCallId);
      toolTurnIds.delete(toolCallId);
    }
    flushDeferredIfToolExchangeClosed();
  };
  const resetOpenState = (clearPendingInput = true): void => {
    openSteps.clear();
    pendingToolResultIds.clear();
    deferred = [];
    lastOpenStepUuid = undefined;
    toolTurnIds.clear();
    if (clearPendingInput) {
      pendingPromptAnchor = undefined;
      pendingSteers = [];
    }
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
    const observedTurnId = readLoopTurnId(event);
    if (observedTurnId !== undefined) {
      resolvePendingSteers(observedTurnId);
      currentTurnId = observedTurnId;
      nextTurnId = Math.max(nextTurnId, observedTurnId + 1);
      if (!turns.some((turn) => turn.turnId === observedTurnId)) {
        turns.push({
          turnId: observedTurnId,
          input: [],
          origin: { kind: 'retry' },
          time,
          order: recordOrder,
        });
      }
    }
    switch (event.type) {
      case 'step.begin': {
        closePendingToolResults(time);
        if (lastOpenStepUuid !== undefined) settleStep(lastOpenStepUuid);
        const entry: MutableEntry = {
          message: { role: 'assistant', content: [], toolCalls: [] },
          time,
          turnId: observedTurnId ?? currentTurnId,
          opensTurn: false,
          order: recordOrder,
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
        toolTurnIds.set(event.toolCallId, openStep.turnId);
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
          turnId: toolTurnIds.get(event.toolCallId),
          opensTurn: false,
          order: recordOrder,
        });
        pendingToolResultIds.delete(event.toolCallId);
        toolTurnIds.delete(event.toolCallId);
        flushDeferredIfToolExchangeClosed();
        return;
      }
    }
  };

  const applyUndo = (count: number): void => {
    if (count <= 0) return;
    let removedUserCount = 0;
    let cutEntry: MutableEntry | undefined;
    for (let i = transcript.length - 1; i >= clearFloor; i--) {
      const entry = transcript[i]!;
      const message = entry.message;
      if (message.origin?.kind === 'injection') continue;
      if (message.origin?.kind === 'compaction_summary') break;
      transcript.splice(i, 1);
      foldedLength = Math.max(0, foldedLength - 1);
      if (isUndoAnchor(message)) {
        removedUserCount++;
        if (removedUserCount >= count) {
          cutEntry = entry;
          break;
        }
      }
    }
    if (cutEntry !== undefined) {
      turns = turns.filter(
        (turn) =>
          turn.order < cutEntry.order &&
          (!cutEntry.opensTurn || turn.turnId !== cutEntry.turnId),
      );
    }
    resetOpenState();
  };

  const add = (record: WireRecord): void => {
    recordOrder += 1;
    switch (record.type) {
      case 'turn.prompt': {
        if (pendingSteers.length > 0) stableTurnIds = false;
        const input = readTurnInput(record);
        const origin = readTurnOrigin(record);
        while (cancelledTurnIds.delete(nextTurnId)) nextTurnId += 1;
        const turnId = nextTurnId;
        nextTurnId += 1;
        currentTurnId = turnId;
        turns.push({ turnId, input, origin, time: record.time, order: recordOrder });
        pendingSteers = [];
        pendingPromptAnchor =
          input.length > 0 &&
          isUndoAnchor({ role: 'user', content: [...input], toolCalls: [], origin })
            ? { turnId }
            : undefined;
        break;
      }
      case 'turn.steer': {
        const input = readTurnInput(record);
        const origin = readTurnOrigin(record);
        pendingSteers.push({
          state: 'recorded',
          input,
          origin,
          time: record.time,
          order: recordOrder,
          expectsMessage: input.length > 0,
        });
        break;
      }
      case 'turn.cancel': {
        const turnId = readTurnCancelId(record);
        const target = readTurnCancelTarget(record);
        if (target === 'queued') {
          if (turnId !== undefined && turnId >= nextTurnId) {
            cancelledTurnIds.add(turnId);
          }
          break;
        }
        if (target === undefined) {
          stableTurnIds = false;
          pendingSteers = [];
          pendingPromptAnchor = undefined;
          break;
        }
        if (pendingSteers.length === 0) {
          if (turnId !== undefined && turnId >= nextTurnId) cancelledTurnIds.add(turnId);
          pendingPromptAnchor = undefined;
          break;
        }
        if (
          turnId === undefined ||
          (turnId !== currentTurnId && turnId !== nextTurnId)
        ) {
          stableTurnIds = false;
          pendingSteers = [];
        } else {
          resolvePendingSteers(turnId, true);
          currentTurnId = turnId;
          nextTurnId = Math.max(nextTurnId, turnId + 1);
          if (!turns.some((turn) => turn.turnId === turnId)) {
            turns.push({
              turnId,
              input: [],
              origin: { kind: 'retry' },
              time: record.time,
              order: recordOrder,
            });
          }
        }
        pendingPromptAnchor = undefined;
        break;
      }
      case 'context.append_message': {
        const message = record['message'] as ContextMessage;
        const entry = toMutableEntry(
          message,
          record.time,
          currentTurnId,
          false,
          recordOrder,
        );
        if (isUndoAnchor(message) && pendingPromptAnchor !== undefined) {
          entry.turnId = pendingPromptAnchor.turnId;
          entry.opensTurn = true;
          pendingPromptAnchor = undefined;
          const redundantSteer = pendingSteers.findIndex(
            (steer) =>
              steer.state !== 'message-bound' &&
              steer.expectsMessage &&
              hasSameOriginKind(steer.origin, message.origin),
          );
          if (redundantSteer >= 0) pendingSteers.splice(redundantSteer, 1);
        } else {
          const steerIndex = pendingSteers.findIndex(
            (candidate) =>
              candidate.state !== 'message-bound' &&
              candidate.expectsMessage &&
              hasSameOriginKind(candidate.origin, message.origin),
          );
          const steer = pendingSteers[steerIndex];
          if (steer !== undefined) {
            if (steer.state === 'turn-bound') {
              entry.turnId = steer.turnId;
              entry.opensTurn = steer.opensTurn;
              pendingSteers.splice(steerIndex, 1);
            } else {
              pendingSteers[steerIndex] = { ...steer, state: 'message-bound', entry };
            }
          }
        }
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
          turnId: currentTurnId,
          opensTurn: false,
          order: recordOrder,
        });
        foldedLength = recoverFoldedLength(record, transcript, clearFloor, foldedLength);
        resetOpenState(false);
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
      turnIds: transcript.map((e) => e.turnId),
      turns: turns
        .toSorted((a, b) => a.turnId - b.turnId)
        .map(({ order: _order, ...turn }) => turn),
      stableTurnIds,
      foldedLength,
    }),
  };

  function resolvePendingSteers(observedTurnId: number, settleUnbound = false): void {
    const unresolved = pendingSteers.filter(
      (steer) => steer.state !== 'turn-bound' && steer.expectsMessage,
    );
    const opensNewTurn =
      unresolved.length > 0 &&
      (currentTurnId === undefined || observedTurnId !== currentTurnId);
    if (opensNewTurn) {
      const opener = unresolved[0]!;
      if (!turns.some((turn) => turn.turnId === observedTurnId)) {
        turns.push({
          turnId: observedTurnId,
          input: opener.input,
          origin: opener.origin,
          time: opener.time,
          order: opener.order,
        });
      }
    }
    let unresolvedIndex = 0;
    pendingSteers = pendingSteers.flatMap((steer) => {
      if (steer.state === 'turn-bound') return settleUnbound ? [] : [steer];
      if (!steer.expectsMessage) return [];
      const opensTurn = opensNewTurn && unresolvedIndex === 0;
      unresolvedIndex += 1;
      if (steer.state === 'message-bound') {
        steer.entry.turnId = observedTurnId;
        steer.entry.opensTurn = opensTurn;
        return [];
      }
      if (settleUnbound) return [];
      return [{ ...steer, state: 'turn-bound', turnId: observedTurnId, opensTurn }];
    });
  }
}

function toMutableEntry(
  message: ContextMessage,
  time: number | undefined,
  turnId: number | undefined,
  opensTurn: boolean,
  order: number,
): MutableEntry {
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
    turnId,
    opensTurn,
    order,
  };
}

function readLoopTurnId(event: LoopRecordedEvent): number | undefined {
  if (!('turnId' in event) || event.turnId === undefined) return undefined;
  const value = Number.parseInt(event.turnId, 10);
  return Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readTurnInput(record: WireRecord): readonly ContentPart[] {
  const input = record['input'];
  return Array.isArray(input) ? (input as readonly ContentPart[]) : [];
}

function readTurnOrigin(record: WireRecord): PromptOrigin {
  const origin = record['origin'];
  if (origin !== null && typeof origin === 'object' && 'kind' in origin) {
    return origin as PromptOrigin;
  }
  return { kind: 'user' };
}

function readTurnCancelId(record: WireRecord): number | undefined {
  const turnId = record['turnId'];
  return typeof turnId === 'number' && Number.isInteger(turnId) && turnId >= 0
    ? turnId
    : undefined;
}

function readTurnCancelTarget(record: WireRecord): 'active' | 'queued' | undefined {
  const target = record['target'];
  return target === 'active' || target === 'queued' ? target : undefined;
}

function hasSameOriginKind(
  left: PromptOrigin,
  right: ContextMessage['origin'],
): boolean {
  return left.kind === (right?.kind ?? 'user');
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
