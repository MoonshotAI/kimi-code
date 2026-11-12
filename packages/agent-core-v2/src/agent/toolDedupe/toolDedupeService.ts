import { createHash } from 'node:crypto';

import { Service } from '#/_base/di/service';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { canonicalTelemetryArgs } from '#/_base/utils/canonical-args';
import type {
  ToolCallDedupDetectedEvent,
  ToolCallRepeatEvent,
  ToolCallTurnRepeatEvent,
} from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import { parseBooleanEnv } from '#/_base/utils/env';
import { legacyDidExecuteContext, type LegacyAfterContext } from '#/agent/toolExecutor/legacyHooks';
import { toLegacyToolReturn, type ToolResult } from '#/tool/executor';
import { parseToolCallArguments } from '#/tool/tool-args-parse';
import { IBootstrapService } from '#/app/bootstrap/bootstrap';
import { IAgentLoopService } from '#/agent/loop/loop';
import { historyEntryFromContext } from '#/agent/loop/history';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventBus } from '#/app/event/eventBus';
import { TurnEnded } from '#/agent/loop/turnOps';
import { wrapSystemReminder } from '#/features/reminder/systemReminder';
import { IAgentToolExecutorService, type ToolCallDupType } from '#/agent/toolExecutor/toolExecutor';
import type { ContentPart } from '@moonshot-ai/core/llm/message';
import {
  IAgentToolDedupeService,
  REPEAT_BREAKER_STOP_REASON,
  type ToolDedupeResult,
} from './toolDedupe';

export const REPEAT_BREAKER_ENV = 'KIMI_CODE_REPEAT_BREAKER';

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
  const spill =
    result.spill !== undefined
      ? { ...result.spill, suffix: (result.spill.suffix ?? '') + reminderText }
      : undefined;
  return result.isError === true
    ? { ...result, output: newOutput, isError: true, spill }
    : { ...result, output: newOutput, spill };
}

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
export const toolDedupeTurnCallRecordsKey = defineState<Map<string, TurnCallRecord>>(
  'toolDedupe.turnCallRecords',
  () => new Map(),
);
export const toolDedupeTurnRepeatCountKey = defineState<number>(
  'toolDedupe.turnRepeatCount',
  () => 0,
);
export class AgentToolDedupeService extends Service implements IAgentToolDedupeService {
  declare readonly _serviceBrand: undefined;
  private readonly repeatBreakerEnabled: boolean;
  private repeatBreakerStop = false;

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IBootstrapService bootstrap: IBootstrapService,
    @IEventBus eventBus: IEventBus,
  ) {
    super();
    this.repeatBreakerEnabled = parseBooleanEnv(bootstrap.getEnv(REPEAT_BREAKER_ENV)) !== false;
    this.states.contributeState(toolDedupeStepCallsKey);
    this.states.contributeState(toolDedupeOriginalCallIndexKey);
    this.states.contributeState(toolDedupeSyntheticCallIdsKey);
    this.states.contributeState(toolDedupeCallKeyByCallIdKey);
    this.states.contributeState(toolDedupeConsecutiveKeyKey);
    this.states.contributeState(toolDedupeConsecutiveCountKey);
    this.states.contributeState(toolDedupeActiveTurnIdKey);
    this.states.contributeState(toolDedupeActiveStepKey);
    this.states.contributeState(toolDedupeTurnCallRecordsKey);
    this.states.contributeState(toolDedupeTurnRepeatCountKey);
    this._register(eventBus.subscribe(TurnEnded, () => this.clearTurnRecords()));
    loop.hooks.onWillBeginStep.register('toolDedupe', async (ctx, next) => {
      this.beginStep(ctx.turnId, ctx.step);
      await next();
    });
    loop.hooks.onDidFinishStep.register('toolDedupe', async (ctx, next) => {
      if (this.repeatBreakerStop) {
        ctx.stopTurn = true;
        ctx.stopReason = REPEAT_BREAKER_STOP_REASON;
      }
      this.repeatBreakerStop = false;
      this.endStep();
      await next();
    });
    toolExecutor.registerHook({
      observe: (event) => {
        if (event.type !== 'created') return;
        const parsed = parseToolCallArguments(event.call.arguments);
        this.checkToolCall(
          event.call.id,
          event.call.name,
          parsed.parseFailed ? event.call.arguments : parsed.data,
          event.context.trace,
        );
      },
      afterExecute: async (context) => {
        const legacy = legacyDidExecuteContext(context);
        legacy.result = await this.finalizeResult(
          legacy.toolCall.id,
          legacy.toolCall.name,
          legacy.args,
          legacy.result,
          legacy.trace,
        );
        if (context.prepared?.kind === 'execute' || context.prepared?.kind === 'synthetic') {
          context.prepared.result = legacy.result;
        }
        return legacyResultToToolResult(context, legacy.result);
      },
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

  private get turnCallRecords(): Map<string, TurnCallRecord> {
    return this.states.get(toolDedupeTurnCallRecordsKey);
  }

  private get turnRepeatCount(): number {
    return this.states.get(toolDedupeTurnRepeatCountKey);
  }

  private set turnRepeatCount(value: number) {
    this.states.set(toolDedupeTurnRepeatCountKey, value);
  }

  private clearTurnRecords(): void {
    this.turnCallRecords.clear();
    this.turnRepeatCount = 0;
  }

  private beginStep(turnId?: number, step?: number): void {
    if (turnId !== undefined && turnId !== this.activeTurnId) {
      this.activeTurnId = turnId;
      this.consecutiveKey = null;
      this.consecutiveCount = 0;
      this.clearTurnRecords();
    }
    if (step !== undefined) {
      this.activeStep = step;
    }

    this.repeatBreakerStop = false;
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
      request_id: trace?.requestId,
    };
    this.telemetry.track2('tool_call_turn_repeat', properties);
  }

  private checkToolCall(
    toolCallId: string,
    toolName: string,
    args: unknown,
    trace: LLMRequestTrace | undefined,
  ): void {
    const key = makeKey(toolName, args);
    const index = this.stepCalls.length;
    this.stepCalls.push(key);
    this.callKeyByCallId.set(toolCallId, key);
    this.originalCallIndex.set(toolCallId, index);
    this.recordTurnRepeat(toolCallId, toolName, args, key, trace);
    if (this.consecutiveKey === key && this.consecutiveCount > 0) {
      this.recordDupType(toolCallId, toolName, args, 'cross_step', trace);
    }
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
      request_id: trace?.requestId,
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
    if (this.repeatBreakerEnabled) {
      if (streak > REPEAT_FORCE_STOP_STREAK) {
        finalResult = appendReminder(result, REMINDER_TEXT_3);
        this.repeatBreakerStop = true;
        action = 'stop';
      } else if (streak >= REPEAT_REMINDER_3_START) {
        if (streak === REPEAT_FORCE_STOP_STREAK) {
          this.loop.remind(historyEntryFromContext({
            role: 'user',
            content: [{ type: 'text', text: REMINDER_TEXT_3.trim() }],
            origin: { kind: 'injection', variant: 'tool_dedupe_repeat_breaker' },
          }));
        } else {
          finalResult = appendReminder(result, REMINDER_TEXT_3);
        }
        action = 'r3';
      } else if (streak >= REPEAT_REMINDER_2_START) {
        finalResult = appendReminder(result, makeReminderText2(streak));
        action = 'r2';
      } else if (streak >= REPEAT_REMINDER_1_START) {
        finalResult = appendReminder(result, REMINDER_TEXT_1);
        action = 'r1';
      }
    }

    if (streak >= 2) {
      const properties: ToolCallRepeatEvent = {
        turn_id: this.activeTurnId,
        tool_name: toolName,
        repeat_count: streak,
        action,
        request_id: trace?.requestId,
      };
      this.telemetry.track2('tool_call_repeat', properties);
    }

    return finalResult;
  }
}

function legacyResultToToolResult(context: LegacyAfterContext, result: ToolDedupeResult): ToolResult {
  const converted = toLegacyToolReturn(result, context.call.name);
  if (converted.outcome === 'failed') {
    return {
      ...context.result,
      content: converted.content,
      outcome: context.result.outcome.type === 'failed'
        ? context.result.outcome
        : {
            type: 'failed',
            error: {
              outcome: 'failed',
              type: 'error',
              phase: 'after-execute',
              reason: converted.reason,
              data: converted.data,
            },
          },
    };
  }
  return { ...context.result, content: converted.content, outcome: { type: 'success' } };
}

export const __testing = {
  REMINDER_TEXT_1,
  REMINDER_TEXT_3,
  makeReminderText2,
  REPEAT_REMINDER_1_START,
  REPEAT_REMINDER_2_START,
  REPEAT_REMINDER_3_START,
  REPEAT_FORCE_STOP_STREAK,
  REPEAT_BREAKER_STOP_REASON,
};

registerScopedService(
  LifecycleScope.Agent,
  IAgentToolDedupeService,
  AgentToolDedupeService,
  ScopeActivation.OnScopeCreated,
  'toolDedupe',
);
