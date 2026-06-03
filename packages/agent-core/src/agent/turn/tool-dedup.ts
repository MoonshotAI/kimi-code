import type { ContentPart } from '@moonshot-ai/kosong';

import type { TelemetryClient } from '../../telemetry';
import type { ExecutableToolResult } from '../../loop/types';

import { canonicalTelemetryArgs } from './canonical-args';

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

function appendReminder(result: ExecutableToolResult, reminderText: string): ExecutableToolResult {
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

function forceStopResult(
  result: ExecutableToolResult,
  reminderText: string,
): ExecutableToolResult {
  const withReminder = appendReminder(result, reminderText);
  return { ...withReminder, stopTurn: true };
}

/**
 * Placeholder result returned from `checkSameStep` for a duplicate call. Never
 * reaches the model — it is replaced in `finalizeResult` by awaiting the
 * original's deferred result. The loop dispatches `tool.result` events using
 * the finalized value, so this content is purely internal bookkeeping.
 *
 * It must be a non-error result so `toolResultStopsTurn` in tool-call.ts does
 * not short-circuit the batch on the dup's behalf.
 */
const DEDUP_PLACEHOLDER_RESULT: ExecutableToolResult = { output: '' };

/**
 * Detects and suppresses repetitive tool calls within a single turn.
 *
 * Two behaviours are layered:
 * - Same-step dedup: a duplicate `(toolName, args)` issued in the same LLM step
 *   reuses the original call's result instead of executing the tool twice.
 * - Cross-step dedup: when the exact same call is repeated consecutively
 *   across steps, the result returned to the model is suffixed with a system
 *   reminder once the streak hits 3. The reminder escalates as the streak
 *   grows: r1 (gentle nudge) from streak 3, r2 (concrete repeat report) from
 *   streak 5, r3 (dead-end stop instruction) from streak 8. From streak 12
 *   onward the turn is force-stopped via `{ stopTurn: true }` so the loop
 *   cannot keep spinning on the same call. Force-stop does not flip a
 *   successful tool result into an error — the underlying tool's `isError`
 *   is preserved.
 *
 * Telemetry: every finalized original call with streak >= 2 emits a
 * `tool_call_repeat` event carrying the current streak count as `repeat_count`
 * along with the tool name and which action was taken (none/r1/r2/r3/stop).
 */
export class ToolCallDeduplicator {
  private stepDeferreds = new Map<string, Deferred<ExecutableToolResult>>();
  private stepCalls: string[] = [];
  private originalCallIndex = new Map<string, number>();
  private syntheticCallIds = new Set<string>();
  /**
   * Records the dedup key used at `checkSameStep` time, keyed by `toolCallId`.
   * The loop is allowed to rewrite args between `prepareToolExecution` and
   * `finalizeToolResult` via `PrepareToolExecutionResult.updatedArgs`, so the
   * `(toolName, args)` pair available at finalize may differ from what was
   * registered. We pin the key at registration time and look it up by call id
   * during finalize.
   */
  private callKeyByCallId = new Map<string, string>();
  private consecutiveKey: string | null = null;
  private consecutiveCount = 0;
  private readonly telemetry: TelemetryClient | undefined;

  constructor(options?: { readonly telemetry?: TelemetryClient | undefined }) {
    this.telemetry = options?.telemetry;
  }

  beginStep(): void {
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

  /**
   * Called from `prepareToolExecution`. If this `(toolName, args)` was already
   * seen in the current step, returns a placeholder result so the loop can
   * skip executing the tool again; the real result is patched in during
   * `finalizeResult`. Returns `null` for the first occurrence so the normal
   * execution path proceeds.
   *
   * This method is intentionally synchronous to avoid deadlocking the prepare
   * loop on a deferred that only resolves in the finalize phase.
   */
  checkSameStep(toolCallId: string, toolName: string, args: unknown): ExecutableToolResult | null {
    const key = makeKey(toolName, args);
    const index = this.stepCalls.length;
    this.stepCalls.push(key);
    this.callKeyByCallId.set(toolCallId, key);

    const existing = this.stepDeferreds.get(key);
    if (existing !== undefined) {
      this.syntheticCallIds.add(toolCallId);
      return DEDUP_PLACEHOLDER_RESULT;
    }
    this.stepDeferreds.set(key, makeDeferred<ExecutableToolResult>());
    this.originalCallIndex.set(toolCallId, index);
    return null;
  }

  /**
   * Called from `finalizeToolResult`, in provider order. For first-occurrence
   * calls, projects the consecutive streak ending at this call and, if the
   * threshold is reached, appends the system reminder, then resolves the
   * deferred so subsequent same-step dups can fetch the real result. For
   * synthetic duplicates, awaits the original's deferred and returns its
   * value, discarding the placeholder.
   */
  async finalizeResult(
    toolCallId: string,
    toolName: string,
    args: unknown,
    result: ExecutableToolResult,
  ): Promise<ExecutableToolResult> {
    // Use the key recorded at registration time, NOT a fresh key from the args
    // passed here — the loop may have rewritten args via updatedArgs.
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
      this.telemetry?.track('tool_call_repeat', {
        tool_name: toolName,
        repeat_count: streak,
        action,
      });
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
