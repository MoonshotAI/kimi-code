import type { ToolCall } from '#/llm/message';
import type { LlmModelSpec } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import {
  createAssistantEntry,
  createUserEntry,
  mergeSteerMessages,
  type AssistantEntry,
  type HistoryMessage,
  type ToolEntry,
  type UserEntry,
} from '#/history/message';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';
import type { LoopInput, LoopProfile, UnfinishedTurn, TurnReply } from '../contract/command';
import type { Inbox, MessageSource, QueuedItem, RemindEntry, TurnTrigger } from '../contract/inbox';
import type { Cause, StepOutcome, ToolCallOutcome, TurnOutcome } from '../contract/outcome';
import type { HookFailure } from '../hook/failure';
import type { ToolActorRef } from '../tool/machine';

export interface ToolSlot {
  ref: ToolActorRef;
  toolCall: ToolCall;
  turnId: number;
  detached: boolean;
}

export interface TurnState {
  id: number;
  trigger: TurnTrigger;
  pending: QueuedItem[];
  step: number;
  scope: AbortScope;
  outcome?: TurnOutcome;
  reply?: TurnReply;
  resumed?: true;
}

export interface StepCall {
  key: string;
  toolCall: ToolCall;
}

export interface StepState {
  model?: LlmModelSpec;
  llm?: LlmOutcome;
  calls: StepCall[];
  settled: Record<string, ToolEntry>;
  stoppedBy?: string;
  outcome?: StepOutcome;
}

export interface LoopMachineContext {
  profile: LoopProfile;
  messages: HistoryMessage[];
  inbox: Inbox;
  tools: Record<string, ToolSlot>;
  held: boolean;
  nextTurnId: number;
  scope: AbortScope;
  unfinished?: UnfinishedTurn;
  turn?: TurnState;
  step?: StepState;
}

export type AppendedItem =
  | { source: MessageSource; entry: HistoryMessage; blocked?: Cause }
  | { source: 'notify'; entry: UserEntry; failure: HookFailure };

type Patch = Partial<LoopMachineContext>;

export function initialContext(input: LoopInput): LoopMachineContext {
  return {
    profile: {
      ...(input.profile?.systemPrompt === undefined ? {} : { systemPrompt: input.profile.systemPrompt }),
      ...(input.profile?.tools === undefined ? {} : { tools: [...input.profile.tools] }),
    },
    messages: [...(input.messages ?? [])],
    inbox: {
      normal: [...(input.inbox?.normal ?? [])],
      notify: [...(input.inbox?.notify ?? [])],
      remind: [...(input.inbox?.remind ?? [])],
    },
    tools: {},
    held: true,
    nextTurnId: Math.max(input.nextTurnId ?? 0, input.unfinished === undefined ? 0 : input.unfinished.turnId + 1),
    scope: createAbortScope(),
    ...(input.unfinished === undefined ? {} : { unfinished: { ...input.unfinished } }),
  };
}

export function turnOf(context: LoopMachineContext): TurnState {
  if (context.turn === undefined) throw new Error('no active turn');
  return context.turn;
}

export function stepOf(context: LoopMachineContext): StepState {
  if (context.step === undefined) throw new Error('no active step');
  return context.step;
}

export function isAborted(context: LoopMachineContext): boolean {
  return context.turn?.outcome?.type === 'aborted';
}

export function abortReason(context: LoopMachineContext): unknown {
  return context.turn?.outcome?.type === 'aborted' ? context.turn.outcome.reason : undefined;
}

export function hasTrigger(context: LoopMachineContext): boolean {
  return context.inbox.normal.length > 0 || context.inbox.notify.length > 0;
}

export function canContinue(messages: readonly HistoryMessage[]): boolean {
  const role = messages.at(-1)?.message.role;
  return role === 'user' || role === 'tool';
}

export interface TrailingCalls {
  unresolved: ToolCall[];
  stopped: boolean;
}

export function trailingCalls(messages: readonly HistoryMessage[]): TrailingCalls {
  const index = messages.findLastIndex((entry) => entry.message.role === 'assistant');
  const assistant = messages[index]?.message;
  if (assistant?.role !== 'assistant') return { unresolved: [], stopped: false };
  const after = messages.slice(index + 1);
  const results = after.filter((entry): entry is ToolEntry => entry.message.role === 'tool');
  const answered = new Set(results.map((entry) => entry.message.toolCallId));
  return {
    unresolved: assistant.toolCalls.filter((toolCall) => !answered.has(toolCall.id)),
    stopped: results.length === after.length && results.some((entry) => entry.meta?.stopTurn === true),
  };
}

export function isResumable(context: LoopMachineContext): boolean {
  if (context.unfinished?.appended !== true) return false;
  const { unresolved, stopped } = trailingCalls(context.messages);
  return !stopped && (unresolved.length > 0 || canContinue(context.messages));
}

export function resumedTurn(context: LoopMachineContext, unfinished: UnfinishedTurn): TurnState {
  return {
    id: unfinished.turnId,
    trigger: unfinished.trigger,
    pending: [],
    step: unfinished.step,
    scope: withAbort(context.scope.signal),
    resumed: true,
  };
}

export function submitPatch(context: LoopMachineContext, entry: UserEntry): Patch {
  return { inbox: { ...context.inbox, normal: [...context.inbox.normal, entry] }, held: false };
}

export function notifyPatch(context: LoopMachineContext, entries: readonly UserEntry[]): Patch {
  if (entries.length === 0) return {};
  return { inbox: { ...context.inbox, notify: [...context.inbox.notify, ...entries] }, held: false };
}

export function remindPatch(context: LoopMachineContext, entry: RemindEntry): Patch {
  return { inbox: { ...context.inbox, remind: [...context.inbox.remind, entry] } };
}

export function steer(
  context: LoopMachineContext,
  promptIds: readonly string[],
): { promptIds: string[]; entry?: UserEntry; patch: Patch } {
  const steered = context.inbox.normal.filter(
    (entry) => entry.meta?.promptId !== undefined && promptIds.includes(entry.meta.promptId),
  );
  const ids = steered.map((entry) => entry.meta?.promptId as string);
  if (steered.length === 0) return { promptIds: ids, patch: {} };
  const merged = mergeSteerMessages(
    steered.map((entry) => ({ content: entry.message.content, origin: entry.meta?.origin })),
  );
  const entry = createUserEntry({ role: 'user', content: merged.content }, { source: 'input', origin: merged.origin });
  return {
    promptIds: ids,
    entry,
    patch: {
      inbox: {
        ...context.inbox,
        normal: context.inbox.normal.filter((item) => !steered.includes(item)),
        notify: [...context.inbox.notify, entry],
      },
      held: false,
    },
  };
}

export function cancel(context: LoopMachineContext, promptId: string): { canceled: boolean; patch: Patch } {
  const normal = context.inbox.normal.filter((entry) => entry.meta?.promptId !== promptId);
  return { canceled: normal.length !== context.inbox.normal.length, patch: { inbox: { ...context.inbox, normal } } };
}

export function newTurn(context: LoopMachineContext, trigger: TurnTrigger, pending: QueuedItem[]): TurnState {
  return { id: context.nextTurnId, trigger, pending, step: 0, scope: withAbort(context.scope.signal) };
}

function sideItems(inbox: Inbox): QueuedItem[] {
  return [
    ...inbox.notify.map((entry) => ({ kind: 'notify' as const, entry })),
    ...inbox.remind.map((entry) => ({ kind: 'remind' as const, entry })),
  ];
}

export function dequeueTurn(context: LoopMachineContext): Patch {
  const [head, ...normal] = context.inbox.normal;
  const pending: QueuedItem[] = [
    ...(head === undefined ? [] : [{ kind: 'normal' as const, entry: head }]),
    ...sideItems(context.inbox),
  ];
  return {
    inbox: { normal, notify: [], remind: [] },
    held: false,
    turn: newTurn(context, head === undefined ? 'notify' : 'normal', pending),
  };
}

export function runTurnPatch(context: LoopMachineContext, entry: UserEntry, reply: TurnReply): Patch {
  const pending: QueuedItem[] = [{ kind: 'normal', entry }, ...sideItems(context.inbox)];
  return {
    inbox: { ...context.inbox, notify: [], remind: [] },
    held: false,
    turn: { ...newTurn(context, 'normal', pending), reply },
  };
}

export function drainPatch(context: LoopMachineContext): Patch {
  return {
    turn: { ...turnOf(context), pending: sideItems(context.inbox) },
    inbox: { ...context.inbox, notify: [], remind: [] },
  };
}

function restorePending(inbox: Inbox, pending: readonly QueuedItem[]): Inbox {
  const restored: Inbox = { normal: [], notify: [], remind: [] };
  for (const item of pending) {
    if (item.kind === 'remind') restored.remind.push(item.entry);
    else restored[item.kind].push(item.entry);
  }
  return {
    normal: [...restored.normal, ...inbox.normal],
    notify: [...restored.notify, ...inbox.notify],
    remind: [...restored.remind, ...inbox.remind],
  };
}

export function releasePending(context: LoopMachineContext, outcome: TurnOutcome): Patch {
  const turn = turnOf(context);
  return {
    inbox: restorePending(context.inbox, turn.pending),
    held: true,
    turn: { ...turn, pending: [], outcome },
  };
}

export function draftOutcome(step: StepState): StepOutcome {
  const llm = step.llm;
  if (llm === undefined) return { type: 'failed' };
  if (llm.type === 'aborted') return { type: 'aborted', reason: llm.reason };
  if (llm.type === 'failed') {
    return { type: 'failed', error: llm.error.kind === 'syntax' ? llm.error : (llm.rawError ?? llm.error) };
  }
  if (step.stoppedBy !== undefined) return { type: 'done', cause: { by: step.stoppedBy, reason: 'stop_turn' } };
  if (llm.message.toolCalls.length === 0) return { type: 'done' };
  return { type: 'continue' };
}

export function decide(context: LoopMachineContext, outcome: StepOutcome): Patch {
  const turn = turnOf(context);
  return {
    step: { ...stepOf(context), outcome },
    turn: outcome.type === 'continue' ? turn : { ...turn, outcome },
  };
}

export function assistantEntryOf(outcome: LlmOutcome, model?: LlmModelSpec): AssistantEntry | undefined {
  if (outcome.type === 'failed' || outcome.message === null) return undefined;
  return createAssistantEntry(outcome.message, {
    source: outcome.type === 'done' ? 'llm' : 'salvaged',
    ...(model === undefined ? {} : { model: { provider: model.provider, model: model.name } }),
    usage: outcome.usage,
    headers: outcome.headers,
    finish: outcome.finish,
    messageId: outcome.messageId,
  });
}

export function allSettled(step: StepState | undefined): boolean {
  return step !== undefined && step.calls.every((call) => step.settled[call.key] !== undefined);
}

export function settle(step: StepState | undefined, key: string, outcome: ToolCallOutcome): StepState | undefined {
  const call = step?.calls.find((item) => item.key === key);
  if (step === undefined || call === undefined) return step;
  const stops = outcome.type === 'succeeded' && outcome.stopTurn === true;
  return {
    ...step,
    settled: { ...step.settled, [key]: outcome.entry },
    stoppedBy: step.stoppedBy ?? (stops ? call.toolCall.id : undefined),
  };
}
