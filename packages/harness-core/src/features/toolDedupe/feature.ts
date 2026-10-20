import {
  createFeature,
  useAgent,
  useStepContinuing,
  useStepStarting,
  useToolEnding,
  useToolStarting,
  type Feature,
} from '@moonshot-ai/agent-core/app/index';
import {
  createUserEntry,
  systemReminderText,
  type ToolMeta,
} from '@moonshot-ai/agent-core/history/index';
import { useInject } from '@moonshot-ai/agent-core/kernel/index';
import type { Agent } from '@moonshot-ai/agent-core/session/index';
import type { ToolResult } from '@moonshot-ai/agent-core/tool/index';

import {
  TelemetryRef,
  useTelemetryEvents,
  type TelemetryEventDefinition,
  type TelemetryProperties,
} from '#/features/telemetry/index';
import { useLoopEvent } from '#/runtime/index';
import { sha256Hex } from '#/sha256';

export const REMINDER_TEXT_1 =
  '\n\n' +
  systemReminderText(
    'The same tool call has been repeated several times in a row. ' +
      'Before making your next call, write one sentence stating what new information you expect it to produce. ' +
      'Then act on that sentence: if it names something this result does not already give you, choose the action that best provides it; otherwise, continue with the evidence you already have.',
  );

export function makeReminderText2(repeatCount: number): string {
  return (
    '\n\n' +
    systemReminderText(
      `The same tool call has now been issued ${String(repeatCount)} times in a row. ` +
        'Choose exactly one of the following and state your choice before acting:\n' +
        '(1) Falsification check: run the cheapest test that could conclusively disprove your current approach, if such a test exists.\n' +
        '(2) Missing input: tell the user precisely what information or decision you need to proceed, and ask for it.\n' +
        '(3) Conclude: deliver your best result based on the evidence already gathered, listing anything that remains uncertain.',
    )
  );
}

export const REMINDER_TEXT_3 =
  '\n\n' +
  systemReminderText(
    'Write your final response now, without any further tool calls. ' +
      'Cover: the current blocker, each approach you have tried and what it established, and the specific information or decision you need from the user to unblock progress. ' +
      'Text only.',
  );

export const REPEAT_REMINDER_1_START = 3;
export const REPEAT_REMINDER_2_START = 5;
export const REPEAT_REMINDER_3_START = 8;
export const REPEAT_FORCE_STOP_STREAK = 12;

export const HANDOFF_VETO_TEXT =
  'This turn was ended by the repeat breaker after the same tool call was issued ' +
  `${String(REPEAT_FORCE_STOP_STREAK)} times in a row. This step accepts a text response only, ` +
  'so the tool call was not executed. Reply in text: the current blocker, what you tried, ' +
  'and what you need next.';

const HANDOFF_VETO_RESULT: ToolResult = {
  content: [{ type: 'text', text: HANDOFF_VETO_TEXT }],
  isError: true,
  stopTurn: true,
};

const LOST_ORIGINAL_RESULT: ToolResult = {
  content: [{ type: 'text', text: 'Tool call deduplicated but original result was lost' }],
  isError: true,
};

type HandoffPhase = 'idle' | 'pending' | 'active' | 'done';

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function sortJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortJsonValue);
  }
  if (!isPlainRecord(value)) {
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(value).toSorted()) {
    out[key] = sortJsonValue(value[key]);
  }
  return out;
}

function canonicalArgs(args: unknown): string {
  const json = JSON.stringify(sortJsonValue(args));
  return json ?? String(args);
}

function keyArgsOf(rawArguments: string | null): unknown {
  if (rawArguments === null || rawArguments.length === 0) return {};
  try {
    return JSON.parse(rawArguments) as unknown;
  } catch {
    return rawArguments;
  }
}

function makeKey(toolName: string, args: unknown): string {
  return `${toolName} ${canonicalArgs(args)}`;
}

function argsHash(args: unknown): string {
  return sha256Hex(canonicalArgs(args)).slice(0, 8);
}

function callSignature(key: string): string {
  return sha256Hex(key);
}

interface TurnCallRecord {
  count: number;
  lastStep: number;
}

function appendReminder(result: ToolResult, reminderText: string): ToolResult {
  const arr = [...result.content];
  const last = arr.at(-1);
  if (last !== undefined && last.type === 'text') {
    arr[arr.length - 1] = { ...last, text: last.text + reminderText };
  } else {
    arr.push({ type: 'text', text: reminderText });
  }
  return { ...result, content: arr };
}

interface DedupeState {
  stepCalls: string[];
  originalCallIndex: Map<string, number>;
  callKeyByCallId: Map<string, string>;
  stepDeferreds: Map<string, Deferred<ToolResult>>;
  consecutiveKey: string | null;
  consecutiveCount: number;
  turnCallRecords: Map<string, TurnCallRecord>;
  turnRepeatCount: number;
  handoffPhase: HandoffPhase;
  handoffVetoedCallIds: Set<string>;
  forceStoppedInStep: boolean;
}

function createDedupeState(): DedupeState {
  return {
    stepCalls: [],
    originalCallIndex: new Map(),
    callKeyByCallId: new Map(),
    stepDeferreds: new Map(),
    consecutiveKey: null,
    consecutiveCount: 0,
    turnCallRecords: new Map(),
    turnRepeatCount: 0,
    handoffPhase: 'idle',
    handoffVetoedCallIds: new Set(),
    forceStoppedInStep: false,
  };
}

const toolDedupeTelemetryEvents = [
  {
    name: 'tool_call_turn_repeat',
    properties: ['turn_id', 'step_no', 'tool_call_id', 'tool_name', 'turn_repeat_count', 'args_hash'],
  },
  {
    name: 'tool_call_dedup_detected',
    properties: ['turn_id', 'step_no', 'tool_call_id', 'tool_name', 'dup_type', 'args_hash'],
  },
  { name: 'tool_call_repeat', properties: ['turn_id', 'tool_name', 'repeat_count', 'action'] },
  { name: 'tool_call_repeat_handoff', properties: ['turn_id', 'outcome'] },
] as const satisfies readonly TelemetryEventDefinition[];

export function createToolDedupe(): Feature<void> {
  const states = new WeakMap<Agent, DedupeState>();
  return createFeature('toolDedupe', {
    agent() {
      const agent = useAgent();
      useTelemetryEvents(toolDedupeTelemetryEvents);
      const telemetry = useInject(TelemetryRef);
      const track = (event: string, properties: TelemetryProperties): void => {
        telemetry.value?.track(event, properties);
      };
      const memoized = states.get(agent);
      const state = memoized ?? createDedupeState();
      if (memoized === undefined) states.set(agent, state);

      const recordDupType = (
        toolCallId: string,
        toolName: string,
        args: unknown,
        dupType: 'same_step' | 'cross_step',
        turnId: number,
        step: number,
      ): void => {
        track('tool_call_dedup_detected', {
          turn_id: turnId,
          step_no: step,
          tool_call_id: toolCallId,
          tool_name: toolName,
          dup_type: dupType,
          args_hash: argsHash(args),
        });
      };

      const recordTurnRepeat = (
        toolCallId: string,
        toolName: string,
        args: unknown,
        key: string,
        turnId: number,
        step: number,
      ): void => {
        const signature = callSignature(key);
        const record = state.turnCallRecords.get(signature);
        if (record === undefined) {
          state.turnCallRecords.set(signature, { count: 0, lastStep: step });
          return;
        }
        if (record.lastStep === step) return;
        record.count += 1;
        record.lastStep = step;
        state.turnRepeatCount += 1;
        track('tool_call_turn_repeat', {
          turn_id: turnId,
          step_no: step,
          tool_call_id: toolCallId,
          tool_name: toolName,
          turn_repeat_count: state.turnRepeatCount,
          args_hash: argsHash(args),
        });
      };

      useLoopEvent('turn.started', (event) => {
        state.consecutiveKey = null;
        state.consecutiveCount = 0;
        if (state.handoffPhase === 'pending') {
          if (event.trigger !== 'notify') state.handoffPhase = 'done';
        } else {
          state.handoffPhase = 'idle';
        }
        state.turnCallRecords.clear();
        state.turnRepeatCount = 0;
      });

      useLoopEvent('step.ended', (event) => {
        for (const key of state.stepCalls) {
          if (key === state.consecutiveKey) {
            state.consecutiveCount += 1;
          } else {
            state.consecutiveKey = key;
            state.consecutiveCount = 1;
          }
        }
        if (state.handoffPhase === 'active') {
          state.handoffPhase = 'done';
          track('tool_call_repeat_handoff', {
            turn_id: event.turnId,
            outcome: state.handoffVetoedCallIds.size > 0 ? 'vetoed' : 'text',
          });
          return;
        }
        if (state.handoffPhase !== 'idle' || !state.forceStoppedInStep) return;
        state.handoffPhase = 'pending';
        queueMicrotask(() => {
          agent.loop.notify(createUserEntry({ role: 'user', content: [] }, { source: 'notify' }));
        });
      });

      useLoopEvent('tool.ended', (event) => {
        if (event.outcome.type === 'succeeded') return;
        const key = state.callKeyByCallId.get(event.toolCallId);
        if (key === undefined) return;
        state.callKeyByCallId.delete(event.toolCallId);
        state.originalCallIndex.delete(event.toolCallId);
        state.stepDeferreds.get(key)?.resolve(LOST_ORIGINAL_RESULT);
      });

      useStepStarting(() => {
        if (state.handoffPhase === 'pending') state.handoffPhase = 'active';
        state.forceStoppedInStep = false;
        state.handoffVetoedCallIds.clear();
        for (const deferred of state.stepDeferreds.values()) {
          deferred.resolve(LOST_ORIGINAL_RESULT);
        }
        state.stepDeferreds.clear();
        state.stepCalls = [];
        state.originalCallIndex.clear();
        state.callKeyByCallId.clear();
        return undefined;
      });

      useStepContinuing(({ messages }) => {
        for (let i = messages.length - 1; i >= 0; i--) {
          const entry = messages[i];
          if (entry === undefined || entry.message.role !== 'tool') break;
          if ((entry.meta as ToolMeta | undefined)?.stopTurn === true) {
            return { type: 'done', cause: { reason: 'stop_turn' } };
          }
        }
        return undefined;
      });

      useToolStarting(async ({ toolCall, turnId, step }) => {
        if (state.handoffPhase === 'active') {
          state.handoffVetoedCallIds.add(toolCall.id);
          return { blocked: { reason: 'repeat_breaker_handoff' }, result: HANDOFF_VETO_RESULT };
        }
        const args = keyArgsOf(toolCall.arguments);
        const key = makeKey(toolCall.name, args);
        const index = state.stepCalls.length;
        state.stepCalls.push(key);
        state.callKeyByCallId.set(toolCall.id, key);
        const existing = state.stepDeferreds.get(key);
        if (existing !== undefined) {
          state.callKeyByCallId.delete(toolCall.id);
          recordDupType(toolCall.id, toolCall.name, args, 'same_step', turnId, step);
          const finalResult = await existing.promise;
          return { blocked: { reason: 'tool_call_deduplicated' }, result: finalResult };
        }
        recordTurnRepeat(toolCall.id, toolCall.name, args, key, turnId, step);
        state.stepDeferreds.set(key, makeDeferred<ToolResult>());
        state.originalCallIndex.set(toolCall.id, index);
        if (state.consecutiveKey === key && state.consecutiveCount > 0) {
          recordDupType(toolCall.id, toolCall.name, args, 'cross_step', turnId, step);
        }
        return undefined;
      });

      useToolEnding(({ toolCall, result, failed, turnId }) => {
        if (failed) return undefined;
        const key = state.callKeyByCallId.get(toolCall.id);
        if (key === undefined) return undefined;
        state.callKeyByCallId.delete(toolCall.id);
        const index = state.originalCallIndex.get(toolCall.id);
        if (index === undefined) return undefined;
        state.originalCallIndex.delete(toolCall.id);

        let lastKey = state.consecutiveKey;
        let streak = state.consecutiveCount;
        for (let i = 0; i <= index; i += 1) {
          const k = state.stepCalls[i] as string;
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
          finalResult = { ...appendReminder(result, REMINDER_TEXT_3), stopTurn: true };
          action = 'stop';
          state.forceStoppedInStep = true;
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
          track('tool_call_repeat', {
            turn_id: turnId,
            tool_name: toolCall.name,
            repeat_count: streak,
            action,
          });
        }

        state.stepDeferreds.get(key)?.resolve(finalResult);
        return { result: finalResult, stopTurn: action === 'stop' ? true : undefined };
      });
    },
  });
}
