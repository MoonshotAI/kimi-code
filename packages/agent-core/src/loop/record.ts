import type { HistoryMessage, ToolMeta, UserEntry, UserMeta } from '#/history/message';
import type { Projection } from '#/store/index';
import type { LoopProfile, UnfinishedTurn } from './contract/command';
import type { LoopEmitted } from './contract/emitted';
import { INTERRUPTED, type TurnOutcome } from './contract/outcome';
import { completionEntry } from './tool/outcome';

const recordTypes = [
  'turn.started',
  'turn.resumed',
  'turn.ended',
  'step.started',
  'step.ended',
  'message.appended',
  'context.settled',
  'system_prompt.settled',
  'tools.settled',
  'tool.started',
  'tool.async_ended',
  'hook.failed',
  'llm.retrying',
  'llm.notice',
] as const;

export type LoopRecordType = (typeof recordTypes)[number];

export type LoopRecord = Extract<LoopEmitted, { type: LoopRecordType }>;

const recorded: ReadonlySet<string> = new Set(recordTypes);

function toJson(value: unknown, ancestors: Set<object>): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value !== 'object' || ancestors.has(value)) return undefined;
  if (value instanceof Error) return { name: value.name, message: value.message };
  const { toJSON } = value as { toJSON?: unknown };
  if (typeof toJSON === 'function') return toJson(toJSON.call(value), ancestors);
  ancestors.add(value);
  const json = Array.isArray(value)
    ? value.map((item) => toJson(item, ancestors) ?? null)
    : Object.fromEntries(
        Object.entries(value).flatMap(([key, item]) => {
          const converted = toJson(item, ancestors);
          return converted === undefined ? [] : [[key, converted]];
        }),
      );
  ancestors.delete(value);
  return json;
}

export function toLoopRecord(event: LoopEmitted): LoopRecord | undefined {
  return recorded.has(event.type) ? (toJson(event, new Set()) as LoopRecord) : undefined;
}

export interface TurnPosition {
  readonly turnId: number;
  readonly start: number;
  readonly end?: number;
  readonly outcome?: TurnOutcome;
}

export interface LoopRecordState {
  readonly profile: LoopProfile;
  readonly messages: readonly HistoryMessage[];
  readonly nextTurnId: number;
  readonly turns: readonly TurnPosition[];
  readonly unfinished?: UnfinishedTurn;
  readonly notify: readonly UserEntry[];
}

function withUnfinished(state: LoopRecordState, unfinished: UnfinishedTurn | undefined): LoopRecordState {
  const { unfinished: _, ...rest } = state;
  return unfinished === undefined ? rest : { ...rest, unfinished };
}

function taskOf(entry: UserEntry): string | undefined {
  return (entry.meta as UserMeta | undefined)?.toolCallId;
}

function withTask(notify: readonly UserEntry[], toolCallId: string, entry: UserEntry): UserEntry[] {
  return [...notify.filter((item) => taskOf(item) !== toolCallId), entry];
}

function detachedTask(state: LoopRecordState, entry: HistoryMessage): UserEntry | undefined {
  if (entry.message.role !== 'tool' || (entry.meta as ToolMeta | undefined)?.detached !== true) return undefined;
  const toolCallId = entry.message.toolCallId;
  if (state.notify.some((item) => taskOf(item) === toolCallId)) return undefined;
  const toolCall = state.messages
    .flatMap((item) => (item.message.role === 'assistant' ? item.message.toolCalls : []))
    .findLast((call) => call.id === toolCallId);
  return toolCall === undefined ? undefined : completionEntry(toolCall, { type: 'aborted', reason: INTERRUPTED });
}

function appended(state: LoopRecordState, event: Extract<LoopRecord, { type: 'message.appended' }>): LoopRecordState {
  const orphan = detachedTask(state, event.entry);
  const consumed = event.source !== 'tool' && event.entry.message.role === 'user' ? taskOf(event.entry as UserEntry) : undefined;
  const notify =
    orphan !== undefined
      ? [...state.notify, orphan]
      : consumed !== undefined
        ? state.notify.filter((item) => taskOf(item) !== consumed)
        : state.notify;
  const unfinished =
    state.unfinished?.turnId === event.turnId ? { ...state.unfinished, appended: true } : state.unfinished;
  return withUnfinished({ ...state, messages: [...state.messages, event.entry], notify }, unfinished);
}

export function loopProjection(): Projection<LoopRecordState, LoopRecord> {
  return {
    initial: () => ({ messages: [], nextTurnId: 0, turns: [], notify: [], profile: {} }),
    reduce: (state, { seq, event }) => {
      switch (event.type) {
        case 'message.appended':
          return appended(state, event);
        case 'context.settled':
          return { ...state, messages: event.messages };
        case 'system_prompt.settled':
          return { ...state, profile: { ...state.profile, systemPrompt: event.systemPrompt } };
        case 'tools.settled':
          return { ...state, profile: { ...state.profile, tools: event.tools } };
        case 'tool.async_ended':
          return { ...state, notify: withTask(state.notify, event.toolCallId, event.entry) };
        case 'hook.failed':
          return { ...state, nextTurnId: Math.max(state.nextTurnId, event.turnId + 1) };
        case 'turn.started':
          return {
            ...state,
            nextTurnId: Math.max(state.nextTurnId, event.turnId + 1),
            turns: [...state.turns, { turnId: event.turnId, start: seq }],
            unfinished: { turnId: event.turnId, trigger: event.trigger, step: 0, stepUnfinished: false, appended: false },
          };
        case 'step.started':
          return state.unfinished?.turnId === event.turnId
            ? { ...state, unfinished: { ...state.unfinished, step: event.step, stepUnfinished: true } }
            : state;
        case 'step.ended':
          return state.unfinished?.turnId === event.turnId ? { ...state, unfinished: { ...state.unfinished, stepUnfinished: false } } : state;
        case 'turn.ended': {
          const index = state.turns.findLastIndex((turn) => turn.turnId === event.turnId);
          return withUnfinished(
            {
              ...state,
              nextTurnId: Math.max(state.nextTurnId, event.turnId + 1),
              turns: state.turns.map((turn, i) => (i === index ? { ...turn, end: seq, outcome: event.outcome } : turn)),
            },
            state.unfinished?.turnId === event.turnId ? undefined : state.unfinished,
          );
        }
        default:
          return state;
      }
    },
  };
}
