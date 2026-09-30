import {
  createFeature,
  systemReminderText,
  TelemetryRef,
  useAgent,
  useAfterStep,
  useAfterTool,
  useBeforeStep,
  useBeforeTool,
  useInject,
  useTelemetryEvents,
  type FeatureSpec,
  type TelemetryEventDefinition,
  type TelemetryProperties,
  type ToolResult,
} from '@moonshot-ai/agent-core';

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

const DEDUPE_PLACEHOLDER_RESULT: ToolResult = { content: [] };

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

export function createToolDedupe(): FeatureSpec {
  return createFeature('toolDedupe', {
    agent() {
      const agent = useAgent();
      useTelemetryEvents(toolDedupeTelemetryEvents);
      const telemetry = useInject(TelemetryRef);
      const track = (event: string, properties: TelemetryProperties): void => {
        telemetry.value?.track(event, properties);
      };

      let stepCalls: string[] = [];
      const originalCallIndex = new Map<string, number>();
      const syntheticCallIds = new Set<string>();
      const callKeyByCallId = new Map<string, string>();
      const stepDeferreds = new Map<string, Deferred<ToolResult>>();
      let consecutiveKey: string | null = null;
      let consecutiveCount = 0;
      let activeTurnId: number | undefined;
      let activeStep = 0;
      const turnCallRecords = new Map<string, TurnCallRecord>();
      let turnRepeatCount = 0;
      let handoffPhase: HandoffPhase = 'idle';
      const handoffVetoedCallIds = new Set<string>();
      let forceStoppedInStep = false;

      const recordDupType = (
        toolCallId: string,
        toolName: string,
        args: unknown,
        dupType: 'same_step' | 'cross_step',
      ): void => {
        track('tool_call_dedup_detected', {
          turn_id: activeTurnId,
          step_no: activeStep,
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
      ): void => {
        const signature = callSignature(key);
        const record = turnCallRecords.get(signature);
        if (record === undefined) {
          turnCallRecords.set(signature, { count: 0, lastStep: activeStep });
          return;
        }
        if (record.lastStep === activeStep) return;
        record.count += 1;
        record.lastStep = activeStep;
        turnRepeatCount += 1;
        track('tool_call_turn_repeat', {
          turn_id: activeTurnId,
          step_no: activeStep,
          tool_call_id: toolCallId,
          tool_name: toolName,
          turn_repeat_count: turnRepeatCount,
          args_hash: argsHash(args),
        });
      };

      agent.on('turn.started', (event) => {
        activeTurnId = event.turnId;
        activeStep = 0;
        consecutiveKey = null;
        consecutiveCount = 0;
        if (handoffPhase === 'pending') {
          if (event.entry !== undefined) handoffPhase = 'done';
        } else {
          handoffPhase = 'idle';
        }
        turnCallRecords.clear();
        turnRepeatCount = 0;
      });

      agent.on('step.started', (event) => {
        activeStep = event.step;
      });

      agent.on('tool.done', (event) => {
        if (event.outcome.type === 'succeeded') return;
        const key = callKeyByCallId.get(event.toolCallId);
        if (key === undefined) return;
        callKeyByCallId.delete(event.toolCallId);
        originalCallIndex.delete(event.toolCallId);
        stepDeferreds.get(key)?.resolve(LOST_ORIGINAL_RESULT);
      });

      useBeforeStep(() => {
        if (handoffPhase === 'pending') handoffPhase = 'active';
        forceStoppedInStep = false;
        handoffVetoedCallIds.clear();
        for (const deferred of stepDeferreds.values()) {
          deferred.resolve(LOST_ORIGINAL_RESULT);
        }
        stepDeferreds.clear();
        stepCalls = [];
        originalCallIndex.clear();
        syntheticCallIds.clear();
        callKeyByCallId.clear();
        return undefined;
      });

      useBeforeTool(({ toolCall }) => {
        if (handoffPhase === 'active') {
          handoffVetoedCallIds.add(toolCall.id);
          return { type: 'denied', result: HANDOFF_VETO_RESULT };
        }
        const args = keyArgsOf(toolCall.arguments);
        const key = makeKey(toolCall.name, args);
        const index = stepCalls.length;
        stepCalls.push(key);
        callKeyByCallId.set(toolCall.id, key);
        const existing = stepDeferreds.get(key);
        if (existing !== undefined) {
          syntheticCallIds.add(toolCall.id);
          recordDupType(toolCall.id, toolCall.name, args, 'same_step');
          return { type: 'denied', result: DEDUPE_PLACEHOLDER_RESULT };
        }
        recordTurnRepeat(toolCall.id, toolCall.name, args, key);
        stepDeferreds.set(key, makeDeferred<ToolResult>());
        originalCallIndex.set(toolCall.id, index);
        if (consecutiveKey === key && consecutiveCount > 0) {
          recordDupType(toolCall.id, toolCall.name, args, 'cross_step');
        }
        return undefined;
      });

      useAfterTool(async ({ toolCall, result }) => {
        if (handoffPhase === 'active') {
          handoffVetoedCallIds.add(toolCall.id);
          return HANDOFF_VETO_RESULT;
        }
        const key = callKeyByCallId.get(toolCall.id);
        if (key === undefined) return undefined;
        callKeyByCallId.delete(toolCall.id);
        if (syntheticCallIds.delete(toolCall.id)) {
          const deferred = stepDeferreds.get(key);
          if (deferred === undefined) return undefined;
          return await deferred.promise;
        }
        const index = originalCallIndex.get(toolCall.id);
        if (index === undefined) return undefined;
        originalCallIndex.delete(toolCall.id);

        let lastKey = consecutiveKey;
        let streak = consecutiveCount;
        for (let i = 0; i <= index; i += 1) {
          const k = stepCalls[i] as string;
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
          forceStoppedInStep = true;
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
            turn_id: activeTurnId,
            tool_name: toolCall.name,
            repeat_count: streak,
            action,
          });
        }

        stepDeferreds.get(key)?.resolve(finalResult);
        return finalResult;
      });

      useAfterStep(() => {
        for (const key of stepCalls) {
          if (key === consecutiveKey) {
            consecutiveCount += 1;
          } else {
            consecutiveKey = key;
            consecutiveCount = 1;
          }
        }
        if (handoffPhase === 'active') {
          handoffPhase = 'done';
          track('tool_call_repeat_handoff', {
            turn_id: activeTurnId,
            outcome: handoffVetoedCallIds.size > 0 ? 'vetoed' : 'text',
          });
          return undefined;
        }
        if (handoffPhase !== 'idle' || !forceStoppedInStep) return undefined;
        handoffPhase = 'pending';
        agent.notify({ role: 'user', content: [] });
        return undefined;
      });
    },
  });
}
