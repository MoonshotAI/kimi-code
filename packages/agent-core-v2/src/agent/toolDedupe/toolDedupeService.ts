/**
 * `toolDedupe` domain — `IAgentToolDedupeService` implementation.
 *
 * Self-wiring plugin: its constructor registers `loop` onWillBeginStep/onDidFinishStep
 * hooks, an `onBeforeExecuteTool` veto listener (same-step duplicates are
 * vetoed with a placeholder synthetic result), and an `onDidExecuteTool`
 * hook to drive same-step suppression and cross-step repeat reminders, and
 * reports repeat telemetry through `telemetry`. The mutable dedupe state
 * (`stepCalls`, `originalCallIndex`, `syntheticCallIds`, `callKeyByCallId`,
 * `consecutiveKey`, `consecutiveCount`, `activeTurnId`, `activeStep`) is
 * registered into `agentState` (`IAgentStateService`) and read/written
 * through it; the `stepDeferreds` promise locks stay plain fields.
 * Constructed eagerly at
 * Agent scope so the hooks are installed without any other service
 * injecting it.
 */

import { createHash } from 'node:crypto';

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { canonicalTelemetryArgs } from '#/_base/utils/canonical-args';
import type { ToolCallDedupDetectedEvent, ToolCallRepeatEvent } from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IAgentStateService } from '#/agent/state/agentState';
import { wrapSystemReminder } from '#/agent/systemReminder/systemReminder';
import { IAgentToolExecutorService, type ToolCallDupType } from '#/agent/toolExecutor/toolExecutor';
import type { ContentPart } from '#/kosong/contract/message';
import { IAgentToolDedupeService, type ToolDedupeResult } from './toolDedupe';

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

interface CheckedToolCall {
  readonly syntheticResult: ToolDedupeResult | null;
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

export const toolDedupeStepCallsKey = defineState<string[]>('toolDedupe.stepCalls', () => []);
export const toolDedupeOriginalCallIndexKey = defineState<Map<string, number>>(
  'toolDedupe.originalCallIndex',
  () => new Map(),
);
export const toolDedupeSyntheticCallIdsKey = defineState<Set<string>>(
  'toolDedupe.syntheticCallIds',
  () => new Set(),
);
export const toolDedupeCallKeyByCallIdKey = defineState<Map<string, string>>(
  'toolDedupe.callKeyByCallId',
  () => new Map(),
);
export const toolDedupeConsecutiveKeyKey = defineState<string | null>(
  'toolDedupe.consecutiveKey',
  () => null,
);
export const toolDedupeConsecutiveCountKey = defineState<number>(
  'toolDedupe.consecutiveCount',
  () => 0,
);
export const toolDedupeActiveTurnIdKey = defineState<number | undefined>(
  'toolDedupe.activeTurnId',
  () => undefined as number | undefined,
);
export const toolDedupeActiveStepKey = defineState<number>('toolDedupe.activeStep', () => 0);

export class AgentToolDedupeService extends Service implements IAgentToolDedupeService {
  declare readonly _serviceBrand: undefined;
  private readonly stepDeferreds = new Map<string, Deferred<ToolDedupeResult>>();

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentLoopService loop: IAgentLoopService,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentStateService private readonly states: IAgentStateService,
  ) {
    super();
    this.states.contributeState(toolDedupeStepCallsKey);
    this.states.contributeState(toolDedupeOriginalCallIndexKey);
    this.states.contributeState(toolDedupeSyntheticCallIdsKey);
    this.states.contributeState(toolDedupeCallKeyByCallIdKey);
    this.states.contributeState(toolDedupeConsecutiveKeyKey);
    this.states.contributeState(toolDedupeConsecutiveCountKey);
    this.states.contributeState(toolDedupeActiveTurnIdKey);
    this.states.contributeState(toolDedupeActiveStepKey);
    loop.hooks.onWillBeginStep.register('toolDedupe', async (ctx, next) => {
      this.beginStep(ctx.turnId, ctx.step);
      await next();
    });
    loop.hooks.onDidFinishStep.register('toolDedupe', async (_ctx, next) => {
      this.endStep();
      await next();
    });
    toolExecutor.onBeforeExecuteTool((event) => {
      const checked = this.checkToolCall(
        event.toolCall.id,
        event.toolCall.name,
        event.args,
        event.trace,
      );
      if (checked.syntheticResult !== null) {
        event.veto(checked.syntheticResult);
      }
    });
    toolExecutor.hooks.onDidExecuteTool.register('toolDedupe', async (ctx, next) => {
      this.registerSkipped(
        ctx.toolCall.id,
        ctx.toolCall.name,
        ctx.args,
        ctx.toolCall.arguments,
        ctx.trace,
      );
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
    });
  }

  private get stepCalls(): string[] {
    return this.states.get(toolDedupeStepCallsKey);
  }

  private set stepCalls(value: string[]) {
    this.states.set(toolDedupeStepCallsKey, value);
  }

  private get originalCallIndex(): Map<string, number> {
    return this.states.get(toolDedupeOriginalCallIndexKey);
  }

  private get syntheticCallIds(): Set<string> {
    return this.states.get(toolDedupeSyntheticCallIdsKey);
  }

  private get callKeyByCallId(): Map<string, string> {
    return this.states.get(toolDedupeCallKeyByCallIdKey);
  }

  private get consecutiveKey(): string | null {
    return this.states.get(toolDedupeConsecutiveKeyKey);
  }

  private set consecutiveKey(value: string | null) {
    this.states.set(toolDedupeConsecutiveKeyKey, value);
  }

  private get consecutiveCount(): number {
    return this.states.get(toolDedupeConsecutiveCountKey);
  }

  private set consecutiveCount(value: number) {
    this.states.set(toolDedupeConsecutiveCountKey, value);
  }

  private get activeTurnId(): number | undefined {
    return this.states.get(toolDedupeActiveTurnIdKey);
  }

  private set activeTurnId(value: number | undefined) {
    this.states.set(toolDedupeActiveTurnIdKey, value);
  }

  private get activeStep(): number {
    return this.states.get(toolDedupeActiveStepKey);
  }

  private set activeStep(value: number) {
    this.states.set(toolDedupeActiveStepKey, value);
  }

  private beginStep(turnId?: number, step?: number): void {
    if (turnId !== undefined && turnId !== this.activeTurnId) {
      this.activeTurnId = turnId;
      this.consecutiveKey = null;
      this.consecutiveCount = 0;
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

  private endStep(): void {
    for (const key of this.stepCalls) {
      if (key === this.consecutiveKey) {
        this.consecutiveCount += 1;
      } else {
        this.consecutiveKey = key;
        this.consecutiveCount = 1;
      }
    }
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
    this.toolExecutor.recordDupType(toolCallId, dupType);
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolDedupeService,
  AgentToolDedupeService,
  ScopeActivation.OnScopeCreated,
  'toolDedupe',
);
