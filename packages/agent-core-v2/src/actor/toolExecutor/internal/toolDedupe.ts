import { createHash } from 'node:crypto';

import { canonicalTelemetryArgs } from '#/_base/utils/canonical-args';
import type {
  ToolCallDedupDetectedEvent,
  ToolCallRepeatEvent,
  ToolCallTurnRepeatEvent,
} from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import type { ToolCallDupType } from '#/actor/toolExecutor/toolExecutor';
import { wrapSystemReminder } from '#/actor/reminder/systemReminder';
import type { ContentPart } from '#/kosong/contract/message';

export type ToolDedupeOutput = string | ContentPart[];

export interface ToolDedupeSuccessResult {
  readonly output: ToolDedupeOutput;
  readonly isError?: false | undefined;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export interface ToolDedupeErrorResult {
  readonly output: ToolDedupeOutput;
  readonly isError: true;
  readonly stopTurn?: boolean | undefined;
  readonly message?: string | undefined;
  readonly truncated?: boolean | undefined;
}

export type ToolDedupeResult = ToolDedupeSuccessResult | ToolDedupeErrorResult;

const REMINDER_TEXT_1 =
  '\n\n' +
  wrapSystemReminder(
    'The same tool call has been repeated several times in a row. ' +
      'Before making your next call, write one sentence stating what new information you expect it to produce. ' +
      'Then act on that sentence: if it names something this result does not already give you, choose the action that best provides it; otherwise, continue with the evidence you already have.',
  );

function makeReminderText2(repeatCount: number): string {
  return (
    '\n\n' +
    wrapSystemReminder(
      `The same tool call has now been issued ${String(repeatCount)} times in a row. ` +
        'Choose exactly one of the following and state your choice before acting:\n' +
        '(1) Falsification check: run the cheapest test that could conclusively disprove your current approach, if such a test exists.\n' +
        '(2) Missing input: tell the user precisely what information or decision you need to proceed, and ask for it.\n' +
        '(3) Conclude: deliver your best result based on the evidence already gathered, listing anything that remains uncertain.',
    )
  );
}

const REMINDER_TEXT_3 =
  '\n\n' +
  wrapSystemReminder(
    'Write your final response now, without any further tool calls. ' +
      'Cover: the current blocker, each approach you have tried and what it established, and the specific information or decision you need from the user to unblock progress. ' +
      'Text only.',
  );

const REPEAT_REMINDER_1_START = 3;
const REPEAT_REMINDER_2_START = 5;
const REPEAT_REMINDER_3_START = 8;
const REPEAT_FORCE_STOP_STREAK = 12;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
}

function makeDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeKey(toolName: string, args: unknown): string {
  return `${toolName} ${canonicalTelemetryArgs(args)}`;
}

function argsHash(args: unknown): string {
  return createHash('sha256').update(canonicalTelemetryArgs(args)).digest('hex').slice(0, 8);
}

function callSignature(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

interface TurnCallRecord {
  count: number;
  lastStep: number;
}

function appendReminder(result: ToolDedupeResult, reminderText: string): ToolDedupeResult {
  const output = result.output;
  let newOutput: string | ContentPart[];
  if (typeof output === 'string') {
    newOutput = output + reminderText;
  } else {
    const arr: ContentPart[] = [...output];
    const last = arr.at(-1);
    if (last !== undefined && last.type === 'text') {
      arr[arr.length - 1] = { type: 'text', text: last.text + reminderText };
    } else {
      arr.push({ type: 'text', text: reminderText });
    }
    newOutput = arr;
  }
  return result.isError === true
    ? { ...result, output: newOutput, isError: true }
    : { ...result, output: newOutput };
}

function forceStopResult(result: ToolDedupeResult, reminderText: string): ToolDedupeResult {
  const withReminder = appendReminder(result, reminderText);
  return { ...withReminder, stopTurn: true };
}

const DEDUPE_PLACEHOLDER_RESULT: ToolDedupeResult = { output: '' };

export interface ToolDedupeState {
  readonly stepDeferreds: Map<string, Deferred<ToolDedupeResult>>;
  stepCalls: string[];
  readonly originalCallIndex: Map<string, number>;
  readonly syntheticCallIds: Set<string>;
  readonly callKeyByCallId: Map<string, string>;
  consecutiveKey: string | null;
  consecutiveCount: number;
  activeTurnId: number | undefined;
  activeStep: number;
  readonly turnCallRecords: Map<string, TurnCallRecord>;
  turnRepeatCount: number;
  readonly dupTypes: Map<string, ToolCallDupType>;
  dupTypeTurnId: number | undefined;
}

export function createToolDedupeState(): ToolDedupeState {
  return {
    stepDeferreds: new Map(),
    stepCalls: [],
    originalCallIndex: new Map(),
    syntheticCallIds: new Set(),
    callKeyByCallId: new Map(),
    consecutiveKey: null,
    consecutiveCount: 0,
    activeTurnId: undefined,
    activeStep: 0,
    turnCallRecords: new Map(),
    turnRepeatCount: 0,
    dupTypes: new Map(),
    dupTypeTurnId: undefined,
  };
}

export interface ToolDedupeCallInput {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly trace: LLMRequestTrace | undefined;
}

export function dedupeClearTurnRecords(state: ToolDedupeState): void {
  state.turnCallRecords.clear();
  state.turnRepeatCount = 0;
}

export function dedupeBeginStep(state: ToolDedupeState, turnId?: number, step?: number): void {
  if (turnId !== undefined && turnId !== state.activeTurnId) {
    state.activeTurnId = turnId;
    state.consecutiveKey = null;
    state.consecutiveCount = 0;
    dedupeClearTurnRecords(state);
  }
  if (step !== undefined) {
    state.activeStep = step;
  }

  for (const deferred of state.stepDeferreds.values()) {
    deferred.resolve({
      output: 'Tool call deduplicated but original result was lost',
      isError: true,
    });
  }
  state.stepDeferreds.clear();
  state.stepCalls = [];
  state.originalCallIndex.clear();
  state.syntheticCallIds.clear();
  state.callKeyByCallId.clear();
}

export function dedupeEndStep(state: ToolDedupeState): void {
  for (const key of state.stepCalls) {
    if (key === state.consecutiveKey) {
      state.consecutiveCount += 1;
    } else {
      state.consecutiveKey = key;
      state.consecutiveCount = 1;
    }
  }
}

export function dedupeResetDupTypes(state: ToolDedupeState, turnId: number): void {
  if (turnId === state.dupTypeTurnId) return;
  state.dupTypeTurnId = turnId;
  state.dupTypes.clear();
}

export function dedupeTakeDupType(state: ToolDedupeState, toolCallId: string): ToolCallDupType | undefined {
  const dupType = state.dupTypes.get(toolCallId);
  state.dupTypes.delete(toolCallId);
  return dupType;
}

function recordTurnRepeat(
  state: ToolDedupeState,
  telemetry: ITelemetryService,
  input: ToolDedupeCallInput,
  key: string,
): void {
  const signature = callSignature(key);
  const record = state.turnCallRecords.get(signature);
  if (record === undefined) {
    state.turnCallRecords.set(signature, { count: 0, lastStep: state.activeStep });
    return;
  }
  if (record.lastStep === state.activeStep) return;

  record.count += 1;
  record.lastStep = state.activeStep;
  state.turnRepeatCount += 1;
  const properties: ToolCallTurnRepeatEvent = {
    turn_id: state.activeTurnId,
    step_no: state.activeStep,
    tool_call_id: input.toolCallId,
    tool_name: input.toolName,
    turn_repeat_count: state.turnRepeatCount,
    args_hash: argsHash(input.args),
    trace_id: input.trace?.traceId,
  };
  telemetry.track2('tool_call_turn_repeat', properties);
}

function recordDupType(
  state: ToolDedupeState,
  telemetry: ITelemetryService,
  input: ToolDedupeCallInput,
  dupType: ToolCallDupType,
): void {
  state.dupTypes.set(input.toolCallId, dupType);
  const properties: ToolCallDedupDetectedEvent = {
    turn_id: state.activeTurnId,
    step_no: state.activeStep,
    tool_call_id: input.toolCallId,
    tool_name: input.toolName,
    dup_type: dupType,
    args_hash: argsHash(input.args),
    trace_id: input.trace?.traceId,
  };
  telemetry.track2('tool_call_dedup_detected', properties);
}

export function dedupeCheck(
  state: ToolDedupeState,
  telemetry: ITelemetryService,
  input: ToolDedupeCallInput,
): ToolDedupeResult | null {
  const key = makeKey(input.toolName, input.args);
  const index = state.stepCalls.length;
  state.stepCalls.push(key);
  state.callKeyByCallId.set(input.toolCallId, key);

  const existing = state.stepDeferreds.get(key);
  if (existing !== undefined) {
    state.syntheticCallIds.add(input.toolCallId);
    recordDupType(state, telemetry, input, 'same_step');
    return DEDUPE_PLACEHOLDER_RESULT;
  }
  recordTurnRepeat(state, telemetry, input, key);
  state.stepDeferreds.set(key, makeDeferred<ToolDedupeResult>());
  state.originalCallIndex.set(input.toolCallId, index);
  if (state.consecutiveKey === key && state.consecutiveCount > 0) {
    recordDupType(state, telemetry, input, 'cross_step');
    return null;
  }
  return null;
}

export function dedupeRegisterSkipped(
  state: ToolDedupeState,
  telemetry: ITelemetryService,
  input: ToolDedupeCallInput,
  rawArguments: unknown,
): void {
  if (state.callKeyByCallId.has(input.toolCallId)) return;
  const keyArgs =
    rawArguments !== undefined &&
    rawArguments !== null &&
    parseToolCallArguments(rawArguments).parseFailed
      ? rawArguments
      : input.args;
  dedupeCheck(state, telemetry, { ...input, args: keyArgs });
}

export type ToolDedupeFinalization =
  | { readonly result: ToolDedupeResult }
  | { readonly pending: Promise<ToolDedupeResult> };

export function dedupeFinalize(
  state: ToolDedupeState,
  telemetry: ITelemetryService,
  input: ToolDedupeCallInput,
  result: ToolDedupeResult,
): ToolDedupeFinalization {
  const key = state.callKeyByCallId.get(input.toolCallId);
  if (key === undefined) return { result };
  state.callKeyByCallId.delete(input.toolCallId);

  if (state.syntheticCallIds.delete(input.toolCallId)) {
    const deferred = state.stepDeferreds.get(key);
    if (deferred === undefined) return { result };
    return { pending: deferred.promise };
  }
  const index = state.originalCallIndex.get(input.toolCallId);
  if (index === undefined) return { result };
  state.originalCallIndex.delete(input.toolCallId);

  let lastKey = state.consecutiveKey;
  let streak = state.consecutiveCount;
  for (let i = 0; i <= index; i += 1) {
    const k = state.stepCalls[i]!;
    if (k === lastKey) {
      streak += 1;
    } else {
      lastKey = k;
      streak = 1;
    }
  }

  let finalResult = result;
  let action: 'none' | 'r1' | 'r2' | 'r3' | 'stop' = 'none';
  if (streak >= REPEAT_FORCE_STOP_STREAK) {
    finalResult = forceStopResult(result, REMINDER_TEXT_3);
    action = 'stop';
  } else if (streak >= REPEAT_REMINDER_3_START) {
    finalResult = appendReminder(result, REMINDER_TEXT_3);
    action = 'r3';
  } else if (streak >= REPEAT_REMINDER_2_START) {
    finalResult = appendReminder(result, makeReminderText2(streak));
    action = 'r2';
  } else if (streak >= REPEAT_REMINDER_1_START) {
    finalResult = appendReminder(result, REMINDER_TEXT_1);
    action = 'r1';
  }

  if (streak >= 2) {
    const properties: ToolCallRepeatEvent = {
      turn_id: state.activeTurnId,
      tool_name: input.toolName,
      repeat_count: streak,
      action,
      trace_id: input.trace?.traceId,
    };
    telemetry.track2('tool_call_repeat', properties);
  }

  state.stepDeferreds.get(key)?.resolve(finalResult);
  return { result: finalResult };
}

export const __testing = {
  REMINDER_TEXT_1,
  REMINDER_TEXT_3,
  makeReminderText2,
  REPEAT_REMINDER_1_START,
  REPEAT_REMINDER_2_START,
  REPEAT_REMINDER_3_START,
  REPEAT_FORCE_STOP_STREAK,
};
