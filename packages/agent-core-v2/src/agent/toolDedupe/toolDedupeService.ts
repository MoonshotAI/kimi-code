/**
 * `toolDedup` domain (L4) — `IAgentToolDedupeService` implementation.
 *
 * Self-wiring plugin: its constructor registers `turn` beforeStep/afterStep
 * hooks and `toolExecutor` onWillExecuteTool/onDidExecuteTool hooks to drive
 * same-step suppression and cross-step repeat reminders, and reports repeat
 * telemetry through `telemetry`. Constructed eagerly at Agent scope so the
 * hooks are installed without any other service injecting it.
 */

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { canonicalTelemetryArgs } from '#/_base/utils/canonical-args';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentToolExecutorService } from '#/agent/toolExecutor';
import { IAgentTurnService } from '#/agent/turn';
import type { ContentPart } from '@moonshot-ai/kosong';
import { IAgentToolDedupeService, type ToolDedupResult } from './toolDedupe';

const REMINDER_TEXT_1 =
  '\n\n<system-reminder>\n' +
  'You are repeating the exact same tool call with identical parameters.' +
  ' Please carefully analyze the previous result. If the task is not yet complete,' +
  ' try a different method or parameters instead of repeating the same call.' +
  '\n</system-reminder>';

function makeReminderText2(toolName: string, repeatCount: number, args: unknown): string {
  const argsStr = canonicalTelemetryArgs(args);
  return (
    '\n\n<system-reminder>\n' +
    'You have repeatedly called the same tool with identical parameters many times.\n' +
    'Repeated tool call detected:\n' +
    `- tool: ${toolName}\n` +
    `- repeated_times: ${String(repeatCount)}\n` +
    `- arguments: ${argsStr}\n` +
    'The previous repeated calls did not make progress. Do not call this exact same tool with the exact same arguments again.\n' +
    'Carefully inspect the latest tool result and choose a different next action, different parameters, or finish the task if enough evidence has been gathered.' +
    '\n</system-reminder>'
  );
}

const REMINDER_TEXT_3 =
  '\n\n<system-reminder>\n' +
  'You are stuck in a dead end and have repeatedly made the same function call without progress.\n' +
  'Stop all function calls immediately. Do not call any tool in your next response.\n' +
  'In analysis, review the current execution state and identify why progress is blocked.\n' +
  'Then return a text-only summary to the user that reports the current problem, what has already been tried, and what information or decision is needed next.' +
  '\n</system-reminder>';

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

function appendReminder(result: ToolDedupResult, reminderText: string): ToolDedupResult {
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

function forceStopResult(result: ToolDedupResult, reminderText: string): ToolDedupResult {
  const withReminder = appendReminder(result, reminderText);
  return { ...withReminder, stopTurn: true };
}

const DEDUP_PLACEHOLDER_RESULT: ToolDedupResult = { output: '' };

export class AgentToolDedupeService extends Disposable implements IAgentToolDedupeService {
  declare readonly _serviceBrand: undefined;
  private readonly stepDeferreds = new Map<string, Deferred<ToolDedupResult>>();
  private stepCalls: string[] = [];
  private readonly originalCallIndex = new Map<string, number>();
  private readonly syntheticCallIds = new Set<string>();
  private readonly callKeyByCallId = new Map<string, string>();
  private consecutiveKey: string | null = null;
  private consecutiveCount = 0;

  constructor(
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTurnService turn: IAgentTurnService,
    @IAgentToolExecutorService toolExecutor: IAgentToolExecutorService,
  ) {
    super();
    turn.hooks.beforeStep.register('toolDedup', async (_ctx, next) => {
      this.beginStep();
      await next();
    });
    turn.hooks.afterStep.register('toolDedup', async (_ctx, next) => {
      this.endStep();
      await next();
    });
    toolExecutor.hooks.onWillExecuteTool.register('toolDedup', async (ctx, next) => {
      const cached = this.checkSameStep(ctx.toolCall.id, ctx.toolCall.name, ctx.args);
      if (cached !== null) {
        ctx.decision = { syntheticResult: cached };
        return;
      }
      await next();
    });
    toolExecutor.hooks.onDidExecuteTool.register('toolDedup', async (ctx, next) => {
      ctx.result = await this.finalizeResult(
        ctx.toolCall.id,
        ctx.toolCall.name,
        ctx.args,
        ctx.result,
      );
      if (ctx.result.stopTurn === true) {
        ctx.stopTurn = true;
      }
      await next();
    });
  }

  private beginStep(): void {
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

  private checkSameStep(toolCallId: string, toolName: string, args: unknown): ToolDedupResult | null {
    const key = makeKey(toolName, args);
    const index = this.stepCalls.length;
    this.stepCalls.push(key);
    this.callKeyByCallId.set(toolCallId, key);

    const existing = this.stepDeferreds.get(key);
    if (existing !== undefined) {
      this.syntheticCallIds.add(toolCallId);
      return DEDUP_PLACEHOLDER_RESULT;
    }
    this.stepDeferreds.set(key, makeDeferred<ToolDedupResult>());
    this.originalCallIndex.set(toolCallId, index);
    return null;
  }

  private async finalizeResult(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ToolDedupResult,
  ): Promise<ToolDedupResult> {
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
      finalResult = appendReminder(result, makeReminderText2(toolName, streak, args));
      action = 'r2';
    } else if (streak >= REPEAT_REMINDER_1_START) {
      finalResult = appendReminder(result, REMINDER_TEXT_1);
      action = 'r1';
    }

    if (streak >= 2) {
      this.telemetry.track('tool_call_repeat', {
        tool_name: toolName,
        repeat_count: streak,
        action,
      });
    }

    this.stepDeferreds.get(key)?.resolve(finalResult);
    return finalResult;
  }

  get currentStreak(): number {
    return this.consecutiveCount;
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
  InstantiationType.Eager,
  'toolDedup',
);
