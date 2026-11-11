/**
 * Loop state model: the read-only `LoopState` view, the live turn, step, and tool records the actor
 * mutates, and pure helpers over them (turn creation, step outcome drafting, tool settlement,
 * resumability checks).
 */
import {
  createAssistantEntry,
  type AssistantEntry,
  type HistoryMessage,
  type ToolEntry,
  type UserEntry,
} from '#/history/history';
import { annotateBundledSkillParts, type UserPromptOrigin } from '#/history/origin';
import { type ToolCall } from '#/llm/message';
import { usableOutputOf } from '#/llm/policy/settle';
import { emptyUsage } from '#/llm/usage';
import type { LlmModelSpec } from '#/llm/request';
import type { LlmOutcome } from '#/llm/response';
import type { ToolExecutionHandler, ToolResult } from '#/tool/runtime';
import { withAbort, type AbortScope } from '#/utils/abort';
import type { LoopInput } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { Inbox, MessageSource, QueuedItem, TurnTrigger } from './contract/inbox';
import { CRASHED, type AsyncToolOutcome, type Cause, type StepOutcome, type ToolCallOutcome, type TurnOutcome } from './contract/outcome';
import type { LoopProfile } from './contract/profile';
import type { HookFailure } from './hook/failure';
import { loopProjection, type LoopRecord, type LoopRecordState } from './record';
import { abortedToolOutcome, type ToolCompletionFactory } from './tool/outcome';

export type LoopPhase = 'idle' | 'running' | 'closed';

export interface LoopTurn {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
  readonly bypassMaxSteps?: boolean;
}

export interface LoopToolCall {
  readonly toolCall: ToolCall;
  readonly turnId: number;
  readonly detached: boolean;
}

export interface LoopState {
  readonly status: 'idle' | 'running' | 'interrupted';
  readonly held: boolean;
  readonly resetting: boolean;
  readonly inbox: Readonly<Inbox>;
  readonly profile: LoopProfile;
  readonly messages: readonly HistoryMessage[];
  readonly nextTurnId: number;
  readonly turn?: LoopTurn;
  readonly calls: readonly LoopToolCall[];
  readonly completionPending: boolean;
}

export interface TurnCompletion {
  readonly promise: Promise<TurnOutcome>;
  resolve(outcome: TurnOutcome): void;
}

export type TurnPhase =
  | 'starting'
  | 'appending'
  | 'stepStarting'
  | 'requesting'
  | 'batching'
  | 'acting'
  | 'ending'
  | 'finished';

export interface LiveTurn extends LoopTurn {
  step: number;
  phase: TurnPhase;
  pending: QueuedItem[];
  readonly scope: AbortScope;
  outcome?: TurnOutcome;
  readonly promptOnly?: true;
  readonly resumed?: true;
  announced: boolean;
  readonly completion?: TurnCompletion;
  readonly signal?: AbortSignal;
  onAbort?: () => void;
  abortGrace?: ReturnType<typeof setTimeout>;
  continueAfterAbort?: boolean;
}

export interface StepCall {
  readonly key: string;
  readonly toolCall: ToolCall;
}

export interface StepState {
  readonly scope: AbortScope;
  steerRequested: boolean;
  toolCallStreaming: boolean;
  model?: LlmModelSpec;
  llm?: LlmOutcome;
  partialMessage?: LlmOutcome['message'];
  readonly calls: StepCall[];
  readonly settled: Record<string, ToolEntry | null>;
  outcome?: StepOutcome;
}

export interface LiveTool {
  readonly key: string;
  toolCall: ToolCall;
  readonly turnId: number;
  readonly step: number;
  readonly handler: ToolExecutionHandler;
  detached: boolean;
  announced: boolean;
  responded: boolean;
  done: boolean;
  result?: ToolResult;
  completion?: ToolCompletionFactory;
  completionEntry?: Promise<UserEntry>;
  completionEntryValue?: UserEntry;
  completionOutcome?: AsyncToolOutcome;
  completionPending?: boolean;
  readonly waiters: Set<() => void>;
}

export interface AgentState {
  phase: LoopPhase;
  held: boolean;
  inbox: Inbox;
  durable: LoopRecordState;
  seq: number;
  turn?: LiveTurn;
  step?: StepState;
  readonly tools: Map<string, LiveTool>;
}

export type AppendedItem =
  | { source: MessageSource; entry: HistoryMessage; blocked?: Cause }
  | { source: 'notify'; entry: UserEntry; failure: HookFailure };

export type StateOutput =
  | { readonly type: 'event'; readonly event: LoopEmitted }
  | { readonly type: 'start'; readonly turn: LiveTurn }
  | { readonly type: 'effect'; readonly effect: () => void };

export interface StateTx {
  ctx: AgentState;
  readonly root: AbortScope;
  readonly out: StateOutput[];
}

const projection = loopProjection();

export function createTransaction(ctx: AgentState, root: AbortScope): StateTx {
  return { ctx, root, out: [] };
}

export function patch(tx: StateTx, next: Partial<AgentState>): void {
  tx.ctx = { ...tx.ctx, ...next };
}

export function record<E extends LoopEmitted>(tx: StateTx, event: E): E {
  const { durable, seq } = tx.ctx;
  patch(tx, { seq: seq + 1, durable: projection.reduce(durable, { seq, time: 0, event: event as LoopRecord }) });
  tx.out.push({ type: 'event', event });
  return event;
}

export function effect(tx: StateTx, fn: () => void): void {
  tx.out.push({ type: 'effect', effect: fn });
}

export function hasTrigger(inbox: Inbox): boolean {
  return inbox.normal.length > 0 || inbox.notify.length > 0;
}

export function canContinue(messages: readonly HistoryMessage[]): boolean {
  const role = messages.at(-1)?.message.role;
  return role === 'user' || role === 'tool';
}

export function trailingCalls(messages: readonly HistoryMessage[]): { unresolved: ToolCall[]; stopped: boolean } {
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

export function isResumable(durable: LoopRecordState): boolean {
  if (durable.unfinished?.appended !== true) return false;
  const { unresolved, stopped } = trailingCalls(durable.messages);
  return !stopped && (unresolved.length > 0 || canContinue(durable.messages));
}

export function restorePending(inbox: Inbox, pending: readonly QueuedItem[]): Inbox {
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

export function editable(context: AgentState): boolean {
  if (context.phase === 'running') return context.turn?.phase === 'ending' || context.turn?.phase === 'stepStarting';
  return context.phase === 'idle' && context.durable.unfinished === undefined;
}

interface CreateTurnInput {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
  readonly pending: readonly QueuedItem[];
  readonly promptOnly?: true;
  readonly resumed?: true;
  readonly completion?: TurnCompletion;
  readonly signal?: AbortSignal;
  readonly bypassMaxSteps?: boolean;
}

export function createTurn(root: AbortScope, input: CreateTurnInput): LiveTurn {
  return {
    id: input.id,
    trigger: input.trigger,
    step: input.step,
    pending: [...input.pending],
    scope: withAbort(root.signal),
    phase: 'starting',
    announced: false,
    bypassMaxSteps: input.bypassMaxSteps === true,
    ...(input.promptOnly === true ? { promptOnly: true as const } : {}),
    ...(input.resumed === true ? { resumed: true as const } : {}),
    ...(input.completion === undefined ? {} : { completion: input.completion }),
    ...(input.signal === undefined ? {} : { signal: input.signal }),
  };
}

export function start(tx: StateTx, turn: LiveTurn): void {
  patch(tx, { phase: 'running', held: false, turn, step: undefined });
  tx.out.push({ type: 'start', turn });
}

export function settleUnfinished(tx: StateTx, outcome: StepOutcome): void {
  const unfinished = tx.ctx.durable.unfinished;
  if (unfinished === undefined) return;
  const { turnId, step } = unfinished;
  for (const toolCall of trailingCalls(tx.ctx.durable.messages).unresolved) {
    const result = abortedToolOutcome(toolCall, CRASHED);
    record(tx, { type: 'tool.ended', toolCallId: toolCall.id, outcome: result, detached: false });
    record(tx, { type: 'message.appended', turnId, step, source: 'tool', entry: result.entry });
  }
  if (unfinished.stepUnfinished) record(tx, { type: 'step.ended', turnId, step, outcome });
}

export function closeUnfinished(tx: StateTx): void {
  const unfinished = tx.ctx.durable.unfinished;
  if (unfinished === undefined) return;
  const outcome = { type: 'aborted' as const, reason: CRASHED };
  settleUnfinished(tx, outcome);
  record(tx, { type: 'turn.ended', turnId: unfinished.turnId, outcome });
}

export function schedule(tx: StateTx): void {
  if (tx.ctx.held || tx.ctx.phase !== 'idle') return;
  closeUnfinished(tx);
  const { inbox } = tx.ctx;
  if (!hasTrigger(inbox)) return;
  const normalHead = inbox.normal[0];
  const head = normalHead ?? inbox.notify[0]!;
  const kind = normalHead === undefined ? 'notify' as const : 'normal' as const;
  const notify = normalHead === undefined ? inbox.notify.slice(1) : inbox.notify;
  const promptOnly = notify.length > 0;
  patch(tx, {
    inbox: {
      normal: normalHead === undefined ? inbox.normal : inbox.normal.slice(1),
      notify,
      remind: promptOnly ? inbox.remind : [],
    },
  });
  start(
    tx,
    createTurn(tx.root, {
      id: tx.ctx.durable.nextTurnId,
      trigger: kind,
      step: 0,
      pending: [
        { kind, entry: head },
        ...(promptOnly ? [] : inbox.remind.map((entry) => ({ kind: 'remind' as const, entry }))),
      ],
      promptOnly: promptOnly ? true : undefined,
    }),
  );
}

export function release(tx: StateTx): void {
  patch(tx, { held: false });
  schedule(tx);
}

export function queueNotify(tx: StateTx, entries: readonly UserEntry[]): void {
  if (entries.length === 0) return;
  patch(tx, { inbox: { ...tx.ctx.inbox, notify: [...tx.ctx.inbox.notify, ...entries] } });
  release(tx);
}

export function normalizeUserEntry(entry: UserEntry): UserEntry {
  const origin = entry.meta?.origin;
  return {
    ...entry,
    message: {
      ...entry.message,
      content: origin?.kind === 'user'
        ? annotateBundledSkillParts(entry.message.content, (origin as UserPromptOrigin).skillActivations ?? [])
        : [...entry.message.content],
    },
  };
}

export function steer(tx: StateTx, promptIds: readonly string[]): LoopAck<'prompt.steered'> {
  const { inbox } = tx.ctx;
  const steered = inbox.normal.filter(
    (entry) => entry.meta?.promptId !== undefined && promptIds.includes(entry.meta.promptId),
  );
  const ids = steered.map((entry) => entry.meta?.promptId as string);
  if (steered.length === 0) return record(tx, { type: 'prompt.steered', promptIds: ids });
  const entries = steered;
  patch(tx, {
    inbox: {
      ...inbox,
      normal: inbox.normal.filter((item) => !steered.includes(item)),
      notify: [...inbox.notify, ...entries],
    },
  });
  const ack = record(tx, { type: 'prompt.steered', promptIds: ids, entries });
  release(tx);
  return ack;
}

export function cont(tx: StateTx): void {
  if (tx.ctx.phase !== 'idle') return;
  const unfinished = tx.ctx.durable.unfinished;
  if (unfinished !== undefined && isResumable(tx.ctx.durable)) {
    settleUnfinished(tx, { type: 'continue', cause: CRASHED });
    start(
      tx,
      createTurn(tx.root, {
        id: unfinished.turnId,
        trigger: unfinished.trigger,
        step: unfinished.step,
        pending: [],
        resumed: true,
      }),
    );
    return;
  }
  closeUnfinished(tx);
  if (!hasTrigger(tx.ctx.inbox) && canContinue(tx.ctx.durable.messages)) {
    start(
      tx,
      createTurn(tx.root, {
        id: tx.ctx.durable.nextTurnId,
        trigger: 'continue',
        step: 0,
        pending: [],
      }),
    );
    return;
  }
  release(tx);
}

export function initialState(input: LoopInput): AgentState {
  const { unfinished, profile = {} } = input;
  return {
    phase: 'idle',
    held: true,
    inbox: {
      normal: [...(input.inbox?.normal ?? [])],
      notify: [...(input.inbox?.notify ?? [])],
      remind: [...(input.inbox?.remind ?? [])],
    },
    durable: {
      profile: {
        ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
        ...(profile.tools === undefined ? {} : { tools: [...profile.tools] }),
      },
      messages: [...(input.messages ?? [])],
      nextTurnId: Math.max(input.nextTurnId ?? 0, unfinished === undefined ? 0 : unfinished.turnId + 1),
      turns: [],
      notify: [],
      ...(unfinished === undefined ? {} : { unfinished: { ...unfinished } }),
    },
    seq: 0,
    tools: new Map(),
  };
}

export function viewOf({ phase, held, inbox, durable, turn, tools }: AgentState): LoopState {
  const { profile, messages, nextTurnId, unfinished } = durable;
  const current =
    turn ?? (unfinished === undefined ? undefined : { id: unfinished.turnId, trigger: unfinished.trigger, step: unfinished.step, bypassMaxSteps: false });
  return {
    status: phase === 'running' ? 'running' : unfinished !== undefined ? 'interrupted' : 'idle',
    held,
    resetting: false,
    inbox,
    profile,
    messages,
    nextTurnId,
    ...(current === undefined ? {} : { turn: { id: current.id, trigger: current.trigger, step: current.step, bypassMaxSteps: current.bypassMaxSteps } }),
    calls: Array.from(tools.values(), (slot) => ({ toolCall: slot.toolCall, turnId: slot.turnId, detached: slot.detached })),
    completionPending: Array.from(tools.values()).some((slot) => slot.completionPending === true),
  };
}

export function draftOutcome(step: StepState): StepOutcome {
  if (step.outcome !== undefined) return step.outcome;
  const llm = step.llm;
  if (llm === undefined) return { type: 'failed' };
  if (llm.type === 'aborted') return { type: 'aborted', reason: llm.reason };
  if (llm.type === 'failed') {
    return { type: 'failed', error: llm.error };
  }
  if (llm.message.toolCalls.length === 0) return { type: 'done' };
  return { type: 'continue' };
}

export function assistantEntryOf(outcome: LlmOutcome, model?: LlmModelSpec): AssistantEntry | undefined {
  if (outcome.message === null || outcome.message === undefined) return undefined;
  const message = outcome.type === 'done' ? outcome.message : usableOutputOf(outcome.message);
  if (message === null) return undefined;
  return createAssistantEntry(message, {
    source: outcome.type === 'done' ? 'llm' : 'salvaged',
    ...(model === undefined ? {} : { model: { provider: model.provider, model: model.name } }),
    usage: outcome.type === 'done' ? outcome.usage : outcome.usage ?? emptyUsage(),
    headers: outcome.headers,
    finish: outcome.finish,
    messageId: outcome.messageId,
  });
}

export function allSettled(step: StepState | undefined): boolean {
  return step !== undefined && step.calls.every((call) => step.settled[call.key] !== undefined);
}

export function settle(step: StepState, key: string, outcome: ToolCallOutcome): void {
  const call = step.calls.find((item) => item.key === key);
  if (call === undefined || step.settled[key] !== undefined) return;
  step.settled[key] = outcome.entry;
}
