import { createStore } from '@xstate/store';

import {
  createUserEntry,
  mergeSteerMessages,
  type HistoryMessage,
  type ToolEntry,
  type UserEntry,
} from '#/history/message';
import type { ToolCall, ToolDescription } from '#/llm/message';
import type { LoopInput } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { Inbox, QueuedItem, RemindEntry, TurnTrigger } from './contract/inbox';
import { CRASHED, type StepOutcome, type TurnOutcome } from './contract/outcome';
import type { LoopFact, LoopSignal } from './contract/process';
import type { LoopProfile } from './contract/profile';
import { loopProjection, type LoopRecord, type LoopRecordState } from './record';
import { abortedToolOutcome } from './tool/outcome';

export type LoopPhase = 'idle' | 'running' | 'closed';

export type TurnReply = (outcome?: TurnOutcome) => void;

export interface LoopTurn {
  readonly id: number;
  readonly trigger: TurnTrigger;
  readonly step: number;
}

export interface LoopToolCall {
  readonly toolCall: ToolCall;
  readonly turnId: number;
  readonly detached: boolean;
}

export interface LoopState {
  readonly status: 'idle' | 'running' | 'interrupted';
  readonly held: boolean;
  readonly inbox: Readonly<Inbox>;
  readonly profile: LoopProfile;
  readonly messages: readonly HistoryMessage[];
  readonly nextTurnId: number;
  readonly turn?: LoopTurn;
  readonly calls: readonly LoopToolCall[];
}

interface LiveTurn extends LoopTurn {
  readonly reply?: TurnReply;
}

export interface LoopStateContext {
  readonly phase: LoopPhase;
  readonly held: boolean;
  readonly inbox: Inbox;
  readonly durable: LoopRecordState;
  readonly seq: number;
  readonly ending: boolean;
  readonly turn?: LiveTurn;
  readonly calls: readonly LoopToolCall[];
}

type Reply<T extends LoopEmitted['type']> = (ack: LoopAck<T>) => void;

export type LoopStateEvent =
  | { type: 'submit'; entry: UserEntry; reply: Reply<'prompt.submitted'> }
  | { type: 'notify'; entry: UserEntry; reply: Reply<'prompt.notified'> }
  | { type: 'remind'; entry: RemindEntry; reply: Reply<'prompt.reminded'> }
  | { type: 'steer'; promptIds: readonly string[]; reply: Reply<'prompt.steered'> }
  | { type: 'cancel'; promptId: string; reply: Reply<'prompt.canceled'> }
  | {
      type: 'setContext';
      messages: HistoryMessage[];
      reason?: string;
      reply: Reply<'context.settled' | 'context.rejected'>;
    }
  | { type: 'setSystemPrompt'; systemPrompt: string; reply: Reply<'system_prompt.settled'> }
  | { type: 'setTools'; tools: readonly ToolDescription[]; reply: Reply<'tools.settled'> }
  | { type: 'runTurn'; entry: UserEntry; reply: TurnReply }
  | { type: 'continue' }
  | { type: 'abort'; reason?: unknown }
  | { type: 'abortTool'; toolCallId: string; reason?: unknown }
  | { type: 'detachTool'; toolCallId: string }
  | { type: 'close' }
  | { type: 'fact'; fact: LoopFact };

export type LoopStateOutput = { type: 'event'; event: LoopEmitted } | { type: 'signal'; signal: LoopSignal };

interface Tx {
  ctx: LoopStateContext;
  readonly out: LoopStateOutput[];
  readonly effects: (() => void)[];
}

interface OutputEnqueue {
  emit: {
    event(payload: { event: LoopEmitted }): void;
    signal(payload: { signal: LoopSignal }): void;
  };
  effect(fn: () => void): void;
}

const projection = loopProjection();

function apply(context: LoopStateContext, enq: OutputEnqueue, body: (tx: Tx) => void): LoopStateContext {
  const tx: Tx = { ctx: context, out: [], effects: [] };
  body(tx);
  for (const effect of tx.effects) enq.effect(effect);
  for (const output of tx.out) {
    if (output.type === 'event') enq.emit.event({ event: output.event });
    else enq.emit.signal({ signal: output.signal });
  }
  return tx.ctx;
}

function patch(tx: Tx, next: Partial<LoopStateContext>): void {
  tx.ctx = { ...tx.ctx, ...next };
}

function record<E extends LoopEmitted>(tx: Tx, event: E): E {
  const { durable, seq } = tx.ctx;
  patch(tx, { seq: seq + 1, durable: projection.reduce(durable, { seq, time: 0, event: event as LoopRecord }) });
  tx.out.push({ type: 'event', event });
  return event;
}

function signal(tx: Tx, next: LoopSignal): void {
  tx.out.push({ type: 'signal', signal: next });
}

function hasTrigger(inbox: Inbox): boolean {
  return inbox.normal.length > 0 || inbox.notify.length > 0;
}

function canContinue(messages: readonly HistoryMessage[]): boolean {
  const role = messages.at(-1)?.message.role;
  return role === 'user' || role === 'tool';
}

function trailingCalls(messages: readonly HistoryMessage[]): { unresolved: ToolCall[]; stopped: boolean } {
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

function isResumable(durable: LoopRecordState): boolean {
  if (durable.unfinished?.appended !== true) return false;
  const { unresolved, stopped } = trailingCalls(durable.messages);
  return !stopped && (unresolved.length > 0 || canContinue(durable.messages));
}

function sideItems(inbox: Inbox): QueuedItem[] {
  return [
    ...inbox.notify.map((entry) => ({ kind: 'notify' as const, entry })),
    ...inbox.remind.map((entry) => ({ kind: 'remind' as const, entry })),
  ];
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

function editable(context: LoopStateContext): boolean {
  if (context.phase === 'running') return context.ending;
  return context.phase === 'idle' && context.durable.unfinished === undefined;
}

function start(tx: Tx, turn: LiveTurn, pending: readonly QueuedItem[], resumed?: true): void {
  patch(tx, { phase: 'running', held: false, ending: false, turn });
  const { messages } = tx.ctx.durable;
  signal(tx, {
    type: 'turn.start',
    id: turn.id,
    trigger: turn.trigger,
    step: turn.step,
    pending,
    messages,
    profile: tx.ctx.durable.profile,
    ...(resumed === true ? { resumed } : {}),
  });
}

function settleUnfinished(tx: Tx, outcome: StepOutcome): void {
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

function closeUnfinished(tx: Tx): void {
  const unfinished = tx.ctx.durable.unfinished;
  if (unfinished === undefined) return;
  const outcome = { type: 'aborted' as const, reason: CRASHED };
  settleUnfinished(tx, outcome);
  record(tx, { type: 'turn.ended', turnId: unfinished.turnId, outcome });
}

function schedule(tx: Tx): void {
  if (tx.ctx.held || tx.ctx.phase !== 'idle') return;
  closeUnfinished(tx);
  const { inbox } = tx.ctx;
  if (!hasTrigger(inbox)) return;
  const [head, ...normal] = inbox.normal;
  patch(tx, { inbox: { normal, notify: [], remind: [] } });
  start(tx, { id: tx.ctx.durable.nextTurnId, trigger: head === undefined ? 'notify' : 'normal', step: 0 }, [
    ...(head === undefined ? [] : [{ kind: 'normal' as const, entry: head }]),
    ...sideItems(inbox),
  ]);
}

function release(tx: Tx): void {
  patch(tx, { held: false });
  schedule(tx);
}

function steer(tx: Tx, promptIds: readonly string[]): LoopAck<'prompt.steered'> {
  const { inbox } = tx.ctx;
  const steered = inbox.normal.filter(
    (entry) => entry.meta?.promptId !== undefined && promptIds.includes(entry.meta.promptId),
  );
  const ids = steered.map((entry) => entry.meta?.promptId as string);
  if (steered.length === 0) return record(tx, { type: 'prompt.steered', promptIds: ids });
  const merged = mergeSteerMessages(
    steered.map((entry) => ({ content: entry.message.content, origin: entry.meta?.origin })),
  );
  const entry = createUserEntry({ role: 'user', content: merged.content }, { source: 'input', origin: merged.origin });
  patch(tx, {
    inbox: {
      ...inbox,
      normal: inbox.normal.filter((item) => !steered.includes(item)),
      notify: [...inbox.notify, entry],
    },
  });
  const ack = record(tx, { type: 'prompt.steered', promptIds: ids, entry });
  release(tx);
  return ack;
}

function cont(tx: Tx): void {
  if (tx.ctx.phase !== 'idle') return;
  const unfinished = tx.ctx.durable.unfinished;
  if (unfinished !== undefined && isResumable(tx.ctx.durable)) {
    settleUnfinished(tx, { type: 'continue', cause: CRASHED });
    start(tx, { id: unfinished.turnId, trigger: unfinished.trigger, step: unfinished.step }, [], true);
    return;
  }
  closeUnfinished(tx);
  if (!hasTrigger(tx.ctx.inbox) && canContinue(tx.ctx.durable.messages)) {
    start(tx, { id: tx.ctx.durable.nextTurnId, trigger: 'continue', step: 0 }, []);
    return;
  }
  release(tx);
}

function runTurn(tx: Tx, entry: UserEntry, reply: TurnReply): void {
  if (tx.ctx.phase !== 'idle') {
    tx.effects.push(() => reply());
    return;
  }
  closeUnfinished(tx);
  const { inbox } = tx.ctx;
  patch(tx, { inbox: { ...inbox, notify: [], remind: [] } });
  record(tx, { type: 'prompt.submitted', entry });
  start(tx, { id: tx.ctx.durable.nextTurnId, trigger: 'normal', step: 0, reply }, [
    { kind: 'normal', entry },
    ...sideItems(inbox),
  ]);
}

function follow(tx: Tx, fact: LoopEmitted): void {
  const { turn, calls } = tx.ctx;
  switch (fact.type) {
    case 'step.started':
      if (turn?.id === fact.turnId) patch(tx, { turn: { ...turn, step: fact.step } });
      return;
    case 'tool.started':
      patch(tx, { calls: [...calls, { toolCall: fact.toolCall, turnId: fact.turnId, detached: false }] });
      return;
    case 'tool.ended':
      patch(tx, {
        calls: fact.detached
          ? calls.map((call) => (call.toolCall.id === fact.toolCallId ? { ...call, detached: true } : call))
          : calls.filter((call) => call.toolCall.id !== fact.toolCallId),
      });
      return;
    case 'tool.async_ended':
      patch(tx, { calls: calls.filter((call) => call.toolCall.id !== fact.toolCallId) });
      return;
    default:
      return;
  }
}

function absorb(tx: Tx, fact: LoopFact): void {
  const { inbox, phase } = tx.ctx;
  switch (fact.type) {
    case 'inbox.notify':
      patch(tx, { inbox: { ...inbox, notify: [...inbox.notify, ...fact.entries] } });
      release(tx);
      return;
    case 'turn.draining':
      if (phase !== 'running') return;
      patch(tx, { inbox: { ...inbox, notify: [], remind: [] } });
      signal(tx, { type: 'turn.drained', pending: sideItems(inbox) });
      return;
    case 'turn.released':
      patch(tx, { inbox: restorePending(inbox, fact.pending), held: true });
      return;
    case 'turn.finished': {
      const reply = tx.ctx.turn?.reply;
      patch(tx, { turn: undefined, ending: false, phase: phase === 'running' ? 'idle' : phase });
      if (reply !== undefined) tx.effects.push(() => reply(fact.outcome));
      schedule(tx);
      return;
    }
    case 'ending.entered':
      patch(tx, { ending: true });
      return;
    case 'ending.exited':
      patch(tx, { ending: false });
      return;
    default:
      record(tx, fact);
      follow(tx, fact);
  }
}

function initialState(input: LoopInput): LoopStateContext {
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
    ending: false,
    calls: [],
  };
}

export function viewOf({ phase, held, inbox, durable, turn, calls }: LoopStateContext): LoopState {
  const { profile, messages, nextTurnId, unfinished } = durable;
  const current =
    turn ?? (unfinished === undefined ? undefined : { id: unfinished.turnId, trigger: unfinished.trigger, step: unfinished.step });
  return {
    status: phase === 'running' ? 'running' : unfinished !== undefined ? 'interrupted' : 'idle',
    held,
    inbox,
    profile,
    messages,
    nextTurnId,
    ...(current === undefined ? {} : { turn: { id: current.id, trigger: current.trigger, step: current.step } }),
    calls,
  };
}

export function createLoopState(input: LoopInput) {
  return createStore<LoopStateContext, LoopStateEvent, LoopStateOutput>({
    context: initialState(input),
    on: {
      submit: (context, { entry, reply }, enq) =>
        apply(context, enq, (tx) => {
          const { inbox } = tx.ctx;
          patch(tx, { inbox: { ...inbox, normal: [...inbox.normal, entry] } });
          const ack = record(tx, { type: 'prompt.submitted', entry });
          tx.effects.push(() => reply(ack));
          release(tx);
        }),
      notify: (context, { entry, reply }, enq) =>
        apply(context, enq, (tx) => {
          const { inbox } = tx.ctx;
          patch(tx, { inbox: { ...inbox, notify: [...inbox.notify, entry] } });
          const ack = record(tx, { type: 'prompt.notified', entry });
          tx.effects.push(() => reply(ack));
          release(tx);
        }),
      remind: (context, { entry, reply }, enq) =>
        apply(context, enq, (tx) => {
          const { inbox } = tx.ctx;
          patch(tx, { inbox: { ...inbox, remind: [...inbox.remind, entry] } });
          const ack = record(tx, { type: 'prompt.reminded', entry });
          tx.effects.push(() => reply(ack));
        }),
      steer: (context, { promptIds, reply }, enq) =>
        apply(context, enq, (tx) => {
          const ack = steer(tx, promptIds);
          tx.effects.push(() => reply(ack));
        }),
      cancel: (context, { promptId, reply }, enq) =>
        apply(context, enq, (tx) => {
          const { inbox } = tx.ctx;
          const normal = inbox.normal.filter((entry) => entry.meta?.promptId !== promptId);
          patch(tx, { inbox: { ...inbox, normal } });
          const canceled = normal.length !== inbox.normal.length;
          const ack = record(tx, { type: 'prompt.canceled', promptId, canceled });
          tx.effects.push(() => reply(ack));
        }),
      setContext: (context, { messages, reason, reply }, enq) =>
        apply(context, enq, (tx) => {
          if (!editable(tx.ctx)) {
            const ack = record(tx, { type: 'context.rejected', messages, reason });
            tx.effects.push(() => reply(ack));
            return;
          }
          const ack = record(tx, { type: 'context.settled', messages, reason });
          if (tx.ctx.phase === 'running') signal(tx, { type: 'context.set', messages: tx.ctx.durable.messages });
          tx.effects.push(() => reply(ack));
        }),
      setSystemPrompt: (context, { systemPrompt, reply }, enq) =>
        apply(context, enq, (tx) => {
          const ack = record(tx, { type: 'system_prompt.settled', systemPrompt });
          if (tx.ctx.phase === 'running') signal(tx, { type: 'profile.set', profile: tx.ctx.durable.profile });
          tx.effects.push(() => reply(ack));
        }),
      setTools: (context, { tools, reply }, enq) =>
        apply(context, enq, (tx) => {
          const ack = record(tx, { type: 'tools.settled', tools: [...tools] });
          if (tx.ctx.phase === 'running') signal(tx, { type: 'profile.set', profile: tx.ctx.durable.profile });
          tx.effects.push(() => reply(ack));
        }),
      runTurn: (context, { entry, reply }, enq) => apply(context, enq, (tx) => runTurn(tx, entry, reply)),
      continue: (context, _event, enq) => apply(context, enq, cont),
      abort: (context, { reason }, enq) =>
        apply(context, enq, (tx) => {
          if (tx.ctx.phase === 'idle') closeUnfinished(tx);
          else if (tx.ctx.phase === 'running') signal(tx, { type: 'input.abort_turn', reason });
        }),
      abortTool: (context, { toolCallId, reason }, enq) =>
        apply(context, enq, (tx) => {
          if (tx.ctx.phase !== 'closed') signal(tx, { type: 'input.abort_tool', toolCallId, reason });
        }),
      detachTool: (context, { toolCallId }, enq) =>
        apply(context, enq, (tx) => {
          if (tx.ctx.phase !== 'closed') signal(tx, { type: 'input.detach_tool', toolCallId });
        }),
      close: (context, _event, enq) =>
        apply(context, enq, (tx) => {
          if (tx.ctx.phase === 'closed') return;
          patch(tx, { phase: 'closed', ending: false });
          signal(tx, { type: 'input.close' });
        }),
      fact: (context, { fact }, enq) => apply(context, enq, (tx) => absorb(tx, fact)),
    },
  });
}

export type LoopStateStore = ReturnType<typeof createLoopState>;
