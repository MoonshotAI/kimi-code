import { createHash } from 'node:crypto';

import type { AgentRuntimeContext } from '#/agent/runtime/agentRuntime';
import { canonicalTelemetryArgs } from '#/_base/utils/canonical-args';
import type {
  ToolCallDedupDetectedEvent,
  ToolCallRepeatEvent,
  ToolCallTurnRepeatEvent,
} from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentHostService } from '#/agent/host/agentHost';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import type { ToolCallDupType, ToolDidExecuteHook } from '#/features/toolExecutor/toolExecutor';
import type { ToolExecutionVetoListener } from '#/features/toolExecutor/toolExecutor';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import type { ContentPart } from '#/kosong/contract/message';

import type { ToolExecutorPipeline } from '#/features/toolExecutor/internal/executor';

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

interface CheckedToolCall {
  readonly syntheticResult: ToolDedupeResult | null;
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

export class ToolDedupePolicy {
  private readonly stepDeferreds = new Map<string, Deferred<ToolDedupeResult>>();
  private stepCalls: string[] = [];
  private readonly originalCallIndex = new Map<string, number>();
  private readonly syntheticCallIds = new Set<string>();
  private readonly callKeyByCallId = new Map<string, string>();
  private consecutiveKey: string | null = null;
  private consecutiveCount = 0;
  private activeTurnId: number | undefined;
  private activeStep = 0;
  private readonly turnCallRecords = new Map<string, TurnCallRecord>();
  private turnRepeatCount = 0;

  constructor(
    private readonly runtime: AgentRuntimeContext<unknown>,
    private readonly pipeline: ToolExecutorPipeline,
  ) {}

  private get telemetry(): ITelemetryService {
    return this.runtime.get(IAgentHostService).of(this.runtime.agent).telemetry;
  }

  readonly checkExecution: ToolExecutionVetoListener = (event) => {
    const checked = this.checkToolCall(
      event.toolCall.id,
      event.toolCall.name,
      event.args,
      event.trace,
    );
    if (checked.syntheticResult !== null) {
      event.veto(checked.syntheticResult);
    }
  };

  readonly finalizeExecution: ToolDidExecuteHook = async (ctx, next) => {
    this.registerSkipped(ctx.toolCall.id, ctx.toolCall.name, ctx.args, ctx.toolCall.arguments, ctx.trace);
    ctx.result = await this.finalizeResult(
      ctx.toolCall.id,
      ctx.toolCall.name,
      ctx.args,
      ctx.result,
      ctx.trace,
    );
    if (ctx.result.stopTurn === true) {
      ctx.stopTurn = true;
    }
    await next();
  };

  clearTurnRecords(): void {
    this.turnCallRecords.clear();
    this.turnRepeatCount = 0;
  }

  beginStep(turnId?: number, step?: number): void {
    if (turnId !== undefined && turnId !== this.activeTurnId) {
      this.activeTurnId = turnId;
      this.consecutiveKey = null;
      this.consecutiveCount = 0;
      this.clearTurnRecords();
    }
    if (step !== undefined) {
      this.activeStep = step;
    }

    for (const deferred of this.stepDeferreds.values()) {
      deferred.resolve({
        output: 'Tool call deduplicated but original result was lost',
        isError: true,
      });
    }
    this.stepDeferreds.clear();
    this.stepCalls = [];
    this.originalCallIndex.clear();
    this.syntheticCallIds.clear();
    this.callKeyByCallId.clear();
  }

  endStep(): void {
    for (const key of this.stepCalls) {
      if (key === this.consecutiveKey) {
        this.consecutiveCount += 1;
      } else {
        this.consecutiveKey = key;
        this.consecutiveCount = 1;
      }
    }
  }

  private recordTurnRepeat(
    toolCallId: string,
    toolName: string,
    args: unknown,
    key: string,
    trace: LLMRequestTrace | undefined,
  ): void {
    const signature = callSignature(key);
    const record = this.turnCallRecords.get(signature);
    if (record === undefined) {
      this.turnCallRecords.set(signature, { count: 0, lastStep: this.activeStep });
      return;
    }
    if (record.lastStep === this.activeStep) return;

    record.count += 1;
    record.lastStep = this.activeStep;
    this.turnRepeatCount += 1;
    const properties: ToolCallTurnRepeatEvent = {
      turn_id: this.activeTurnId,
      step_no: this.activeStep,
      tool_call_id: toolCallId,
      tool_name: toolName,
      turn_repeat_count: this.turnRepeatCount,
      args_hash: argsHash(args),
      trace_id: trace?.traceId,
    };
    this.telemetry.track2('tool_call_turn_repeat', properties);
  }

  private checkToolCall(
    toolCallId: string,
    toolName: string,
    args: unknown,
    trace: LLMRequestTrace | undefined,
  ): CheckedToolCall {
    const key = makeKey(toolName, args);
    const index = this.stepCalls.length;
    this.stepCalls.push(key);
    this.callKeyByCallId.set(toolCallId, key);

    const existing = this.stepDeferreds.get(key);
    if (existing !== undefined) {
      this.syntheticCallIds.add(toolCallId);
      this.recordDupType(toolCallId, toolName, args, 'same_step', trace);
      return { syntheticResult: DEDUPE_PLACEHOLDER_RESULT };
    }
    this.recordTurnRepeat(toolCallId, toolName, args, key, trace);
    this.stepDeferreds.set(key, makeDeferred<ToolDedupeResult>());
    this.originalCallIndex.set(toolCallId, index);
    if (this.consecutiveKey === key && this.consecutiveCount > 0) {
      this.recordDupType(toolCallId, toolName, args, 'cross_step', trace);
      return { syntheticResult: null };
    }
    return { syntheticResult: null };
  }

  private registerSkipped(
    toolCallId: string,
    toolName: string,
    args: unknown,
    rawArguments: unknown,
    trace: LLMRequestTrace | undefined,
  ): void {
    if (this.callKeyByCallId.has(toolCallId)) return;
    const keyArgs =
      rawArguments !== undefined &&
      rawArguments !== null &&
      parseToolCallArguments(rawArguments).parseFailed
        ? rawArguments
        : args;
    this.checkToolCall(toolCallId, toolName, keyArgs, trace);
  }

  private recordDupType(
    toolCallId: string,
    toolName: string,
    args: unknown,
    dupType: ToolCallDupType,
    trace: LLMRequestTrace | undefined,
  ): void {
    this.pipeline.recordDupType(toolCallId, dupType);
    const properties: ToolCallDedupDetectedEvent = {
      turn_id: this.activeTurnId,
      step_no: this.activeStep,
      tool_call_id: toolCallId,
      tool_name: toolName,
      dup_type: dupType,
      args_hash: argsHash(args),
      trace_id: trace?.traceId,
    };
    this.telemetry.track2('tool_call_dedup_detected', properties);
  }

  private async finalizeResult(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ToolDedupeResult,
    trace: LLMRequestTrace | undefined,
  ): Promise<ToolDedupeResult> {
    const key = this.callKeyByCallId.get(toolCallId);
    if (key === undefined) return result;
    this.callKeyByCallId.delete(toolCallId);

    if (this.syntheticCallIds.delete(toolCallId)) {
      const deferred = this.stepDeferreds.get(key);
      if (deferred === undefined) return result;
      return deferred.promise;
    }
    const index = this.originalCallIndex.get(toolCallId);
    if (index === undefined) return result;
    this.originalCallIndex.delete(toolCallId);

    let lastKey = this.consecutiveKey;
    let streak = this.consecutiveCount;
    for (let i = 0; i <= index; i += 1) {
      const k = this.stepCalls[i]!;
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
        turn_id: this.activeTurnId,
        tool_name: toolName,
        repeat_count: streak,
        action,
        trace_id: trace?.traceId,
      };
      this.telemetry.track2('tool_call_repeat', properties);
    }

    this.stepDeferreds.get(key)?.resolve(finalResult);
    return finalResult;
  }
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
