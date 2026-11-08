import { randomUUID } from 'node:crypto';

import { toKimiErrorPayload } from '#/errors';
import type { IWireService } from '#/wire/wire';
import { normalizeLegacyTurnSteerRecords } from '#/wire/human';
import type { PartsTransformer, WireRecord } from '#/wire/record';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import type { ProfileBindingSnapshot } from '#/agent/profile/profile';
import {
  EMPTY_LOOP_PROFILE,
  reduceLoopConfigUpdate,
  reduceLoopProfileBind,
  reduceLoopActiveTools,
} from '#/agent/profile/profileOps';
import { applyContextCompactionRecord } from '#/agent/contextMemory/contextOps';
import { cutTurnUndo, wireLinesOf } from '#/agent/undo/turnUndo';
import {
  foldAppendMessage,
  foldLoopEvent,
  foldSettle,
  type LoopRecordedEvent,
} from '#/agent/contextMemory/loopEventFold';
import {
  type AssistantEntry,
  type HistoryMessage,
  type UserEntry,
} from '#human/agent/turn';

import { contextFromHistoryEntry, historyFromContext } from './history';
import type {
  LoopEmitted,
  LoopInput,
  RemindEntry,
  StepOutcome,
  TurnOutcome,
} from './core/index';

export interface LoopJournalSnapshot {
  readonly input: LoopInput;
  readonly profile?: ProfileBindingSnapshot;
  readonly profileBound: boolean;
}

interface TurnClock {
  nextTurnId: number;
  readonly cancelledTurnIds: Set<number>;
}

interface PendingTurn {
  readonly entry?: UserEntry;
  readonly trigger: 'normal' | 'notify' | 'continue';
  prompted: boolean;
}

interface StepJournal {
  readonly uuid: string;
  readonly streamedBlocks: Map<number, { startedAt: number; endedAt: number }>;
  started: boolean;
  assistant?: AssistantEntry;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entryKey(entry: RemindEntry): string {
  return JSON.stringify([
    entry.message.role,
    entry.message.content,
    'toolCallId' in entry.message ? entry.message.toolCallId : undefined,
  ]);
}

function advanceTurnClock(clock: TurnClock, target: number): void {
  for (const turnId of clock.cancelledTurnIds) {
    if (turnId < target) clock.cancelledTurnIds.delete(turnId);
  }
  while (clock.cancelledTurnIds.delete(target)) target += 1;
  clock.nextTurnId = target;
}

function observeTurnId(clock: TurnClock, turnId: number): void {
  if (turnId >= clock.nextTurnId) advanceTurnClock(clock, turnId + 1);
}

function observeTurnRecord(clock: TurnClock, record: WireRecord): void {
  switch (record.type) {
    case 'turn.prompt': {
      const explicit = record['turnId'];
      const assigned = typeof explicit === 'number' ? explicit : clock.nextTurnId;
      advanceTurnClock(clock, assigned + 1);
      return;
    }
    case 'turn.ended': {
      const turnId = record['turnId'];
      if (typeof turnId === 'number' && Number.isInteger(turnId)) observeTurnId(clock, turnId);
      return;
    }
    case 'turn.cancel': {
      const turnId = record['turnId'];
      if (record['target'] === undefined || typeof turnId !== 'number' || turnId < clock.nextTurnId) return;
      clock.cancelledTurnIds.add(turnId);
      advanceTurnClock(clock, clock.nextTurnId);
      return;
    }
    case 'context.append_loop_event': {
      const event = record['event'];
      if (!isObject(event) || event['type'] === 'tool.result' || typeof event['turnId'] !== 'string') return;
      const turnId = Number.parseInt(event['turnId'], 10);
      if (Number.isInteger(turnId)) observeTurnId(clock, turnId);
      return;
    }
  }
}

export function restoreLoopJournal(records: readonly WireRecord[]): LoopJournalSnapshot {
  records = normalizeLegacyTurnSteerRecords(records);
  const clock: TurnClock = { nextTurnId: 0, cancelledTurnIds: new Set() };
  for (const record of records) observeTurnRecord(clock, record);

  const contextRecords: WireRecord[] = [];
  for (const record of records) {
    if (record.type !== 'context.undo') {
      contextRecords.push(record);
      continue;
    }
    const count = record['count'];
    if (typeof count !== 'number') continue;
    const result = cutTurnUndo(wireLinesOf(contextRecords), new Set(), count);
    if (result.cut !== undefined) contextRecords.splice(result.cut.index);
  }

  let context: readonly ContextMessage[] = [];
  let profile: ProfileBindingSnapshot | undefined;
  let profileBound = false;
  for (const record of contextRecords) {
    switch (record.type) {
      case 'profile.bind':
        profile = reduceLoopProfileBind(profile, record as never);
        profileBound = true;
        break;
      case 'config.update':
        profile = reduceLoopConfigUpdate(profile ?? EMPTY_LOOP_PROFILE, record as never);
        break;
      case 'tools.set_active_tools':
        profile = reduceLoopActiveTools(profile ?? EMPTY_LOOP_PROFILE, record['names'] as readonly string[]);
        break;
      case 'tools.reset_active_tools':
        profile = reduceLoopActiveTools(profile ?? EMPTY_LOOP_PROFILE, undefined);
        break;
      case 'context.append_message':
        context = foldAppendMessage(context, record['message'] as ContextMessage);
        break;
      case 'context.append_loop_event':
        context = foldLoopEvent(context, record['event'] as LoopRecordedEvent);
        break;
      case 'context.apply_compaction':
        context = applyContextCompactionRecord(
          context,
          record as unknown as Parameters<typeof applyContextCompactionRecord>[1],
        );
        break;
      case 'context.clear':
        context = [];
        break;
    }
  }
  context = foldSettle(context);
  return {
    profile,
    profileBound,
    input: {
      profile: profile === undefined ? undefined : { systemPrompt: profile.systemPrompt, tools: [] },
      messages: historyFromContext(
        context.map((message) => message.llmTiming === undefined ? message : { ...message, llmTiming: undefined }),
      ),
      inbox: { normal: [], notify: [], remind: [] },
      nextTurnId: clock.nextTurnId,
    },
  };
}

async function transformParts(
  value: unknown,
  transform: PartsTransformer,
): Promise<unknown> {
  if (!Array.isArray(value)) return value;
  const parts = await transform(value);
  return parts === value ? value : [...parts];
}

async function transformMessage(value: unknown, transform: PartsTransformer): Promise<unknown> {
  if (!isObject(value) || !Array.isArray(value['content'])) return value;
  const content = value['content'];
  const parts = await transform(content);
  return parts === content ? value : { ...value, content: [...parts] };
}

export async function dehydrateLoopJournalRecord(
  record: WireRecord,
  transform: PartsTransformer,
): Promise<WireRecord> {
  switch (record.type) {
    case 'context.append_message': {
      const message = await transformMessage(record['message'], transform);
      return message === record['message'] ? record : { ...record, message };
    }
    case 'context.append_loop_event': {
      const event = record['event'];
      if (!isObject(event)) return record;
      if (event['type'] === 'content.part') {
        const part = event['part'];
        const parts = await transformParts([part], transform) as readonly unknown[];
        return parts[0] === part ? record : { ...record, event: { ...event, part: parts[0] } };
      }
      if (event['type'] === 'tool.result' && isObject(event['result'])) {
        const result = event['result'];
        const output = await transformParts(result['output'], transform);
        return output === result['output']
          ? record
          : { ...record, event: { ...event, result: { ...result, output } } };
      }
      return record;
    }
    case 'turn.prompt':
    case 'turn.steer': {
      const input = await transformParts(record['input'], transform);
      return input === record['input'] ? record : { ...record, input };
    }
    default:
      return record;
  }
}

function stepKey(turnId: number, step: number): string {
  return `${turnId}:${step}`;
}

function origin(entry: UserEntry): PromptOrigin {
  return (entry.meta?.origin as PromptOrigin | undefined) ?? { kind: 'user' };
}

function normalizeFinishReason(reason: string): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

function stepFinishReason(outcome: StepOutcome, assistant: AssistantEntry | undefined): string {
  switch (outcome.type) {
    case 'failed':
    case 'blocked':
      return 'error';
    case 'aborted':
      return 'interrupted';
    default: {
      const finish = assistant?.meta?.finish?.finishReason;
      if (finish === 'tool_calls' && assistant?.message.toolCalls.length === 0) return 'other';
      if (finish !== undefined && finish !== null) return normalizeFinishReason(finish);
      return outcome.type === 'continue' ? 'tool_use' : 'end_turn';
    }
  }
}

function turnReason(outcome: TurnOutcome): 'completed' | 'cancelled' | 'failed' | 'blocked' {
  switch (outcome.type) {
    case 'done':
      return 'completed';
    case 'aborted':
      return 'cancelled';
    case 'failed':
      return 'failed';
    case 'blocked':
      return 'blocked';
  }
}

function toolArguments(entry: AssistantEntry, toolCallId: string): unknown {
  const args = entry.message.toolCalls.find((call) => call.id === toolCallId)?.arguments;
  if (args === undefined || args === null) return undefined;
  try {
    return JSON.parse(args) as unknown;
  } catch {
    return args;
  }
}

export class LoopJournal {
  private readonly normal: UserEntry[] = [];
  private readonly notify: UserEntry[] = [];
  private readonly steps = new Map<string, StepJournal>();
  private readonly toolCallUuids = new Map<string, string>();
  private turn: PendingTurn | undefined;

  constructor(
    private readonly wire: IWireService,
    private readonly agentId: string,
  ) {}

  recordStreamPart(turnId: number, step: number, block: number): void {
    const journal = this.steps.get(stepKey(turnId, step));
    if (journal === undefined) return;
    const now = Date.now();
    const streamed = journal.streamedBlocks.get(block);
    if (streamed === undefined) {
      journal.streamedBlocks.set(block, { startedAt: now, endedAt: now });
    } else {
      streamed.endedAt = now;
    }
  }

  append(event: LoopEmitted): void {
    switch (event.type) {
      case 'prompt.submitted':
        this.normal.push(event.entry);
        return;
      case 'prompt.notified':
        this.notify.push(event.entry);
        return;
      case 'prompt.canceled':
        if (event.canceled) {
          const index = this.normal.findIndex((entry) => entry.meta?.promptId === event.promptId);
          if (index >= 0) this.normal.splice(index, 1);
        }
        return;
      case 'prompt.steered': {
        const entries = event.entries ?? [];
        if (entries.length === 0) return;
        const ids = new Set(event.promptIds);
        for (let index = this.normal.length - 1; index >= 0; index -= 1) {
          if (ids.has(this.normal[index]!.meta?.promptId ?? '')) this.normal.splice(index, 1);
        }
        this.notify.push(...entries);
        return;
      }
      case 'turn.started':
        this.turnId = event.turnId;
        this.turn = {
          entry: event.trigger === 'normal'
            ? this.normal.shift()
            : event.trigger === 'notify'
              ? this.notify[0]
              : undefined,
          trigger: event.trigger,
          prompted: false,
        };
        this.writeTurnPrompt();
        return;
      case 'step.started':
        this.writeTurnPrompt();
        this.steps.set(stepKey(event.turnId, event.step), {
          uuid: randomUUID(),
          streamedBlocks: new Map(),
          started: false,
        });
        return;
      case 'message.appended':
        this.appendMessage(event);
        return;
      case 'tool.started': {
        const step = this.steps.get(stepKey(event.turnId, event.step));
        const assistant = step?.assistant;
        if (step === undefined || assistant === undefined) return;
        this.ensureStepStarted(event.turnId, event.step, step);
        const uuid = randomUUID();
        this.toolCallUuids.set(event.toolCall.id, uuid);
        this.writeLoopEvent({
          type: 'tool.call',
          uuid,
          turnId: String(event.turnId),
          step: event.step,
          stepUuid: step.uuid,
          toolCallId: event.toolCall.id,
          name: event.toolCall.name,
          args: toolArguments(assistant, event.toolCall.id),
          extras: event.toolCall.extras,
          display: event.display,
        });
        return;
      }
      case 'tool.ended': {
        if (!this.toolCallUuids.has(event.toolCallId)) return;
        const entry = event.outcome.entry;
        this.writeLoopEvent({
          type: 'tool.result',
          parentUuid: this.toolCallUuids.get(event.toolCallId) ?? randomUUID(),
          toolCallId: event.toolCallId,
          result: Object.fromEntries(Object.entries(event.result ?? {
            output: entry.message.content,
            isError: entry.meta?.isError,
            note: entry.meta?.note,
            durationMs: entry.meta?.durationMs,
          }).filter(([, value]) => value !== undefined)) as Extract<LoopRecordedEvent, { type: 'tool.result' }>['result'],
        });
        return;
      }
      case 'step.ended': {
        this.writeTurnPrompt();
        const key = stepKey(event.turnId, event.step);
        const step = this.steps.get(key);
        if (step === undefined) return;
        const assistant = step.assistant;
        if (step.started || assistant !== undefined) {
          this.ensureStepStarted(event.turnId, event.step, step);
        }
        this.steps.delete(key);
        this.writeLoopEvent({
          type: 'step.end',
          uuid: step.uuid,
          turnId: String(event.turnId),
          step: event.step,
          finishReason: stepFinishReason(event.outcome, assistant),
          usage: assistant?.meta?.usage,
          llmFirstTokenLatencyMs: event.timing?.firstTokenLatencyMs ?? event.llmTiming?.llmFirstTokenLatencyMs,
          llmStreamDurationMs: event.timing?.streamDurationMs ?? event.llmTiming?.llmStreamDurationMs,
          llmRequestBuildMs: event.timing?.requestBuildMs,
          llmServerFirstTokenMs: event.timing?.serverFirstTokenMs,
          llmServerDecodeMs: event.timing?.serverDecodeMs,
          llmClientConsumeMs: event.timing?.clientConsumeMs,
          llmClientBlockedMs: event.timing?.clientBlockedMs,
          messageId: assistant?.meta?.messageId,
          providerFinishReason: assistant?.meta?.finish?.finishReason ?? undefined,
          rawFinishReason: assistant?.meta?.finish?.rawFinishReason ?? undefined,
        });
        return;
      }
      case 'turn.ended': {
        this.writeTurnPrompt();
        this.turn = undefined;
        const record: WireRecord = {
          type: 'turn.ended',
          agentId: this.agentId,
          turnId: event.turnId,
          reason: turnReason(event.outcome),
          error: event.outcome.type === 'failed' && event.outcome.error !== undefined
            ? toKimiErrorPayload(event.outcome.error)
            : undefined,
          durationMs: event.durationMs,
          stopReason: event.stopReason,
          requestId: event.requestId,
        };
        this.write(record['requestId'] === undefined
          ? Object.fromEntries(Object.entries(record).filter(([key]) => key !== 'requestId')) as WireRecord
          : record);
        return;
      }
      case 'context.settled':
        this.settleContext(event.messages, event.reason);
        return;
      default:
        return;
    }
  }

  snapshot(): LoopJournalSnapshot {
    return restoreLoopJournal(this.wire.readLoopChain().map(({ record }) => record));
  }

  settled(): Promise<void> {
    return this.wire.settled();
  }

  private appendMessage(event: Extract<LoopEmitted, { type: 'message.appended' }>): void {
    if (event.source === 'normal' || event.source === 'notify') {
      this.writeTurnPrompt(event.entry as UserEntry);
    } else {
      this.writeTurnPrompt();
    }
    if (event.source === 'llm' || event.source === 'partial') {
      const assistant = event.entry as AssistantEntry;
      const step = this.steps.get(stepKey(event.turnId, event.step));
      if (step === undefined) return;
      this.ensureStepStarted(event.turnId, event.step, step);
      if (event.source === 'llm') step.assistant = assistant;
      for (const [block, part] of assistant.message.content.entries()) {
        const streamed = step.streamedBlocks.get(block);
        this.writeLoopEvent({
          type: 'content.part',
          uuid: randomUUID(),
          turnId: String(event.turnId),
          step: event.step,
          stepUuid: step.uuid,
          block,
          part,
          startedAt: streamed?.startedAt,
          durationMs: streamed === undefined ? undefined : streamed.endedAt - streamed.startedAt,
        });
      }
      return;
    }
    if (event.source === 'tool') {
      const entry = event.entry;
      if (entry.message.role !== 'tool') return;
      const toolCallId = entry.message.toolCallId;
      if (this.toolCallUuids.has(toolCallId)) return;
      const step = this.steps.get(stepKey(event.turnId, event.step));
      const assistant = step?.assistant;
      if (step !== undefined && assistant !== undefined) {
        this.ensureStepStarted(event.turnId, event.step, step);
        const uuid = randomUUID();
        this.toolCallUuids.set(toolCallId, uuid);
        const toolCall = assistant.message.toolCalls.find((call) => call.id === toolCallId);
        this.writeLoopEvent({
          type: 'tool.call',
          uuid,
          turnId: String(event.turnId),
          step: event.step,
          stepUuid: step.uuid,
          toolCallId,
          name: toolCall?.name ?? toolCallId,
          args: toolArguments(assistant, toolCallId),
          extras: toolCall?.extras,
        });
      }
      this.write({
        type: 'context.append_message',
        agentId: this.agentId,
        message: contextFromHistoryEntry(entry),
      });
      return;
    }
    this.write({
      type: 'context.append_message',
      agentId: this.agentId,
      message: contextFromHistoryEntry(event.entry),
    });
    if (event.source !== 'notify') return;
    const notifyIndex = this.notify.findIndex((entry) => entryKey(entry) === entryKey(event.entry));
    if (notifyIndex >= 0) this.notify.splice(notifyIndex, 1);
  }

  private ensureStepStarted(turnId: number, stepNumber: number, step: StepJournal): void {
    if (step.started) return;
    step.started = true;
    this.writeLoopEvent({
      type: 'step.begin',
      uuid: step.uuid,
      turnId: String(turnId),
      step: stepNumber,
    });
  }

  private writeTurnPrompt(entry?: UserEntry): void {
    const turn = this.turn;
    if (turn === undefined || turn.prompted) return;
    const prompt = entry ?? turn.entry;
    this.write({
      type: 'turn.prompt',
      agentId: this.agentId,
      input: prompt?.message.content ?? [],
      origin: prompt === undefined ? { kind: 'user' } : origin(prompt),
      promptId: prompt?.meta?.promptId,
      turnId: this.turnId,
      trigger: turn.trigger,
    });
    turn.prompted = true;
  }

  private turnId = 0;

  private settleContext(messages: readonly HistoryMessage[], reason: string | undefined): void {
    if (reason === 'compaction' || reason === 'clear' || reason === 'context.clear') return;
    if (reason !== 'fork') throw new Error(`Unsupported Loop context replacement reason: ${reason ?? 'unknown'}`);
    for (const entry of messages) {
      this.write({
        type: 'context.append_message',
        agentId: this.agentId,
        message: contextFromHistoryEntry(entry),
      });
    }
  }

  private writeLoopEvent(event: LoopRecordedEvent): void {
    this.write({ type: 'context.append_loop_event', agentId: this.agentId, event });
  }

  private write(record: WireRecord): void {
    this.wire.append({ ...record, time: record['time'] ?? Date.now() }, dehydrateLoopJournalRecord);
  }
}
