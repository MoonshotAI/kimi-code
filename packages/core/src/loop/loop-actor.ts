import type { Message, ToolDescription, UserMessage } from '#/llm/message';
import { createPolicyRegistry, type PolicyRegistry } from '#/llm/policy/registry';
import { isToolDetachAck } from '#/tool/tool-executor';
import type { ToolExecutionResponse, ToolResult } from '#/tool/types';
import { createAbortScope, type AbortScope } from '#/utils/abort';
import { waitEvent, type WaitOpts } from '#/utils/wait';
import type { CreateLoopOptions, Loop, LoopToolExecutor } from './create-loop';
import type { LoopCommand, LoopInput, UnfinishedTurn } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { HookPoint, LoopHooks } from './contract/hook';
import type { Inbox, QueuedItem, RemindMessage } from './contract/inbox';
import {
  CLOSED,
  CRASHED,
  STEERED,
  type AsyncToolOutcome,
  type StepOutcome,
  type ToolCallOutcome,
  type TurnOutcome,
} from './contract/outcome';
import { isMessage, isObject } from './guards';
import { isPromiseLike } from '#/hook/result';
import {
  hookFailedEvent,
  hookFailureMessage,
  hookFailureReports,
  runtimeFailure,
  type HookFailureReport,
} from '#/hook/loop/failure';
import {
  runMessageAppending,
  runTurnStarting,
  type TurnStartingRun,
} from '#/hook/loop/run';
import type { LoopLlmRequester, LoopRequestRuntime } from './request';
import { loopProjection, type LoopRecord, type LoopRecordState } from './record';
import {
  canContinue,
  isResumable,
  normalizeUserMessage,
  trailingCalls,
  type AppendedItem,
  type LiveTool,
  type LiveTurn,
  type LoopState,
  type TurnCompletion,
} from './state';
import {
  abortedToolOutcome,
  blockedToolOutcome,
  completionMessage,
  resolveCompletionMessage,
  toolOutcomeMessage,
  type ToolCompletionFactory,
} from './tool/outcome';
import { createWaitForTasks, type WaitForTasks } from './tool/tasks';
import {
  createTurn,
  createTurnHookRegistry,
  type TurnEnding,
  type TurnHookContext,
  type TurnInput,
  type TurnMessage,
  type TurnOwnerStartingEvent,
  type TurnPoint,
  type TurnRuntime,
  type TurnStartDecision,
  type TurnToolBatch,
  type TurnToolBatchResult,
  type TurnYield,
} from './turn';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve: (value: T) => void = () => undefined;
  let reject: (error: unknown) => void = () => undefined;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function turnCompletion(): TurnCompletion {
  const completion = deferred<TurnOutcome>();
  return {
    promise: completion.promise,
    resolve: (outcome) => {
      completion.resolve(outcome);
    },
  };
}

function toolOutcomeOf(slot: LiveTool): ToolCallOutcome {
  const result = slot.result!;
  const outcome = result.outcome;
  const message = toolOutcomeMessage(slot.toolCall, result);
  switch (outcome.type) {
    case 'success':
      return { type: 'succeeded', message };
    case 'aborted':
      return { type: 'aborted', message, reason: outcome.error.data ?? outcome.error.reason };
    default:
      return { type: 'failed', message, error: outcome.error };
  }
}

function asyncOutcomeOf(slot: LiveTool): AsyncToolOutcome {
  const outcome = slot.result!.outcome;
  if (outcome.type === 'success') return { type: 'succeeded' };
  if (outcome.type === 'aborted') {
    return { type: 'aborted', reason: outcome.error.data ?? outcome.error.reason };
  }
  return { type: 'failed', error: outcome.error.data ?? outcome.error.reason };
}

interface MailboxTurn {
  readonly kind: 'normal' | 'notify';
  readonly pending: QueuedItem[];
  readonly promptOnly: boolean;
}

class LoopMailbox {
  private normal: UserMessage[];
  private notifyEntries: UserMessage[];
  private reminders: RemindMessage[];

  constructor(input: LoopInput['inbox'], private readonly emit: (event: LoopEmitted) => void) {
    this.normal = [...(input?.normal ?? [])];
    this.notifyEntries = [...(input?.notify ?? [])];
    this.reminders = [...(input?.remind ?? [])];
  }

  get snapshot(): Inbox {
    return {
      normal: [...this.normal],
      notify: [...this.notifyEntries],
      remind: [...this.reminders],
    };
  }

  get hasTrigger(): boolean {
    return this.normal.length > 0 || this.notifyEntries.length > 0;
  }

  get hasNotify(): boolean {
    return this.notifyEntries.length > 0;
  }

  get hasReminders(): boolean {
    return this.reminders.length > 0;
  }

  submit(message: UserMessage): LoopAck<'prompt.submitted'> {
    this.normal.push(message);
    const ack: LoopAck<'prompt.submitted'> = { type: 'prompt.submitted', message };
    this.emit(ack);
    return ack;
  }

  notify(message: UserMessage): LoopAck<'prompt.notified'> {
    this.notifyEntries.push(message);
    const ack: LoopAck<'prompt.notified'> = { type: 'prompt.notified', message };
    this.emit(ack);
    return ack;
  }

  remind(messages: readonly RemindMessage[]): LoopAck<'prompt.reminded'> | undefined {
    this.reminders.push(...messages);
    let ack: LoopAck<'prompt.reminded'> | undefined;
    for (const message of messages) {
      ack = { type: 'prompt.reminded', message };
      this.emit(ack);
    }
    return ack;
  }

  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> {
    const messages = this.normal.filter(
      (message) => message.attributes?.promptId !== undefined && promptIds.includes(message.attributes.promptId),
    );
    const ids = messages.map((message) => message.attributes?.promptId as string);
    if (messages.length === 0) {
      const ack: LoopAck<'prompt.steered'> = { type: 'prompt.steered', promptIds: ids };
      this.emit(ack);
      return ack;
    }
    this.normal = this.normal.filter((item) => !messages.includes(item));
    this.notifyEntries.push(...messages);
    const ack: LoopAck<'prompt.steered'> = { type: 'prompt.steered', promptIds: ids, messages };
    this.emit(ack);
    return ack;
  }

  cancel(promptId: string): LoopAck<'prompt.canceled'> {
    const normal = this.normal.filter((message) => message.attributes?.promptId !== promptId);
    const notify = this.notifyEntries.filter((message) => message.attributes?.promptId !== promptId);
    const canceled = normal.length !== this.normal.length || notify.length !== this.notifyEntries.length;
    this.normal = normal;
    this.notifyEntries = notify;
    const ack: LoopAck<'prompt.canceled'> = { type: 'prompt.canceled', promptId, canceled };
    this.emit(ack);
    return ack;
  }

  queue(messages: readonly UserMessage[]): void {
    this.notifyEntries.push(...messages);
  }

  restore(pending: readonly QueuedItem[]): void {
    const restored: Inbox = { normal: [], notify: [], remind: [] };
    for (const item of pending) {
      if (item.kind === 'remind') restored.remind.push(item.message);
      else restored[item.kind].push(item.message);
    }
    this.normal = [...restored.normal, ...this.normal];
    this.notifyEntries = [...restored.notify, ...this.notifyEntries];
    this.reminders = [...restored.remind, ...this.reminders];
  }

  take(): MailboxTurn | undefined {
    const normalHead = this.normal[0];
    const head = normalHead ?? this.notifyEntries[0];
    if (head === undefined) return undefined;
    const kind = normalHead === undefined ? 'notify' as const : 'normal' as const;
    const remainingNotify = normalHead === undefined ? this.notifyEntries.slice(1) : this.notifyEntries;
    const promptOnly =
      head.attributes?.promptOnly === true ||
      remainingNotify.some((entry) => entry.attributes?.promptOnly !== true);
    this.normal = normalHead === undefined ? this.normal : this.normal.slice(1);
    this.notifyEntries = remainingNotify;
    const reminders = promptOnly ? [] : this.drainReminders();
    return {
      kind,
      pending: [
        { kind, message: head },
        ...reminders.map((message) => ({ kind: 'remind' as const, message })),
      ],
      promptOnly,
    };
  }

  drainReminders(): RemindMessage[] {
    const messages = this.reminders;
    this.reminders = [];
    return messages;
  }

  clearReminders(): void {
    this.reminders = [];
  }
}

type ActorMessage =
  | { readonly type: 'turn.start'; readonly turn: LiveTurn }
  | { readonly type: 'tool.prepared'; readonly slot: LiveTool }
  | { readonly type: 'tool.responded'; readonly slot: LiveTool; readonly response: ToolExecutionResponse }
  | { readonly type: 'tool.failed'; readonly slot: LiveTool; readonly error: unknown }
  | { readonly type: 'tool.completed'; readonly slot: LiveTool; readonly result: ToolResult }
  | { readonly type: 'tool.detached_completed'; readonly slot: LiveTool; readonly outcome: AsyncToolOutcome; readonly completion: UserMessage }
  | { readonly type: 'tool.detached_rejected'; readonly slot: LiveTool; readonly outcome: AsyncToolOutcome; readonly completion: UserMessage }
  | { readonly type: 'tool.abort'; readonly toolCallId: string; readonly reason?: unknown }
  | { readonly type: 'abort.requested'; readonly turn?: LiveTurn; readonly reason?: unknown; readonly continueAfterAbort: boolean }
  | { readonly type: 'continue'; readonly force: boolean }
  | { readonly type: 'close' }
  | {
      readonly type: 'close.detached';
      readonly completions: readonly { readonly slot: LiveTool; readonly outcome: AsyncToolOutcome; readonly message: UserMessage }[];
    }
  | { readonly type: 'close.failed'; readonly error: unknown };

interface ActiveToolBatch extends TurnToolBatch {
  readonly outcomes: (ToolCallOutcome | null | undefined)[];
  failure?: unknown;
  resolve(result: TurnToolBatchResult): void;
}

class LoopActor implements Loop {
  readonly executor: LoopToolExecutor;
  readonly policy: PolicyRegistry;
  readonly waitForTasks: WaitForTasks;

  private readonly hook: Partial<LoopHooks>;
  private readonly turnHooks = createTurnHookRegistry();
  private readonly turnRuntime: TurnRuntime;
  private readonly root: AbortScope = createAbortScope();
  private readonly projection = loopProjection();
  private mailbox: LoopMailbox;
  private readonly listeners = new Set<(event: LoopEmitted) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly messages: ActorMessage[] = [];
  private readonly events: LoopEmitted[] = [];
  private readonly completedTurns: LiveTurn[] = [];
  private readonly toolContext?: CreateLoopOptions['toolContext'];
  private readonly completionFactory?: CreateLoopOptions['completionMessage'];
  private readonly shouldQueueTaskNotification?: CreateLoopOptions['shouldQueueTaskNotification'];
  private readonly abortGraceMs: number;
  private readonly onListenerError?: CreateLoopOptions['onListenerError'];
  private phase: 'idle' | 'running' | 'closed' = 'idle';
  private held = true;
  private durable: LoopRecordState;
  private turn: LiveTurn | undefined;
  private readonly tools = new Map<string, LiveTool>();
  private toolBatch: ActiveToolBatch | undefined;
  private completedToolBatch: { readonly turnId: number; readonly step: number; readonly result: TurnToolBatchResult } | undefined;
  private requesterTemplate: LoopLlmRequester | undefined;
  private revision = 0;
  private seq = 0;
  private kicking = false;
  private dispatching = false;
  private turnTransitions = 0;
  private resetting = false;
  private closePending = false;
  private closeCompletion?: Deferred<void>;
  private completionContinuation?: () => void;
  private completionHandoff = false;
  private lifecycleGeneration = 0;
  private lifecycleDrained = false;
  private lifecycleIdle = false;

  constructor(options: CreateLoopOptions) {
    const input = options.input ?? {};
    const invalid = inputError(input);
    if (invalid !== undefined) throw new TypeError(invalid);
    this.revision = input.historyRevision ?? 0;
    const unfinished = input.unfinished;
    const profile = input.profile ?? {};
    this.durable = {
      ...this.projection.initial(),
      profile: {
        ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
        ...(profile.tools === undefined ? {} : { tools: [...profile.tools] }),
      },
      messages: [...(input.messages ?? [])],
      nextTurnId: Math.max(input.nextTurnId ?? 0, unfinished === undefined ? 0 : unfinished.turnId + 1),
      ...(unfinished === undefined ? {} : { unfinished: { ...unfinished } }),
    };
    this.mailbox = new LoopMailbox(input.inbox, (event) => {
      this.record(event);
    });
    this.requesterTemplate = options.requester;
    this.executor = options.executor;
    this.toolContext = options.toolContext;
    this.completionFactory = options.completionMessage;
    this.shouldQueueTaskNotification = options.shouldQueueTaskNotification;
    this.abortGraceMs = options.abortGraceMs ?? 2_500;
    this.onListenerError = options.onListenerError;
    this.hook = options.hook ?? {};
    this.policy = createPolicyRegistry();
    this.waitForTasks = createWaitForTasks(() =>
      Array.from(this.tools.values()).filter((slot) => slot.detached && !slot.done),
    );
    this.turnHooks.addTurnHook({ point: 'starting', id: 'loop', hook: (event, ctx) => this.ownerStarting(event, ctx) });
    this.turnHooks.addTurnHook({ point: 'requesting', id: 'loop', hook: (event, ctx) => this.ownerRequesting(event, ctx) });
    this.turnHooks.addTurnHook({ point: 'continuing', id: 'loop', hook: (event, ctx) => this.ownerContinuing(event, ctx) });
    this.turnHooks.addTurnHook({ point: 'ending', id: 'loop', hook: (event, ctx) => this.ownerEnding(event, ctx) });
    this.turnRuntime = {
      request: {
        current: () => this.requesterTemplate,
        policy: this.policy,
      },
      tools: {
        executeBatch: (batch) => this.executeToolBatch(batch),
        abortBatch: (batch, reason, options) => this.abortToolBatch(batch, reason, options),
      },
      hooks: this.turnHooks.hook,
      extensions: this.hook,
      host: {
        read: () => ({ messages: this.durable.messages, profile: this.durable.profile }),
        emit: (event) => {
          this.record(event);
          if (event.type === 'turn.ended' && this.turn?.id === event.turnId) {
            this.finishTurn(this.turn, event.outcome);
          }
        },
        transition: (run) => this.transition(run),
        report: (point, event, reports, notify) => {
          if (this.turn?.id === event.turnId) this.report(point, this.turn, event.step, reports, notify);
        },
        committed: (turnId) => {
          if (this.turn?.id === turnId) this.turn.pending = [];
        },
      },
      signal: this.root.signal,
      abortGraceMs: this.abortGraceMs,
    };
  }

  get state(): LoopState {
    const { profile, messages, nextTurnId, unfinished } = this.durable;
    const live = this.turn;
    const current = live !== undefined
      ? {
          id: live.id,
          trigger: live.trigger,
          step: live.machine.state.step,
          bypassMaxSteps: live.machine.state.bypassMaxSteps,
        }
      : unfinished === undefined ? undefined : {
          id: unfinished.turnId,
          trigger: unfinished.trigger,
          step: unfinished.step,
          bypassMaxSteps: false,
        };
    return {
      status: this.phase === 'running' ? 'running' : unfinished !== undefined ? 'interrupted' : 'idle',
      held: this.held,
      resetting: this.resetting,
      inbox: this.mailbox.snapshot,
      profile,
      messages,
      nextTurnId,
      completionPending: this.hasPendingCompletions,
      calls: Array.from(this.tools.values(), (slot) => ({
        toolCall: slot.toolCall,
        turnId: slot.turnId,
        detached: slot.detached,
      })),
      ...(current === undefined ? {} : { turn: current }),
    };
  }

  get historyRevision(): number {
    return this.revision;
  }

  operation<T>(create: (runtime: LoopRequestRuntime) => T): T {
    return create({
      historyRevision: () => this.revision,
    });
  }

  private open(): boolean {
    return this.phase !== 'closed';
  }

  private check(command: LoopCommand): void {
    const reason = commandError(command);
    if (reason !== undefined) throw new TypeError(reason);
  }

  private record<E extends LoopEmitted>(event: E): E {
    if (
      event.type === 'prompt.submitted' ||
      event.type === 'prompt.notified' ||
      event.type === 'prompt.reminded' ||
      event.type === 'turn.started' ||
      event.type === 'turn.resumed' ||
      (event.type === 'tool.ended' && event.detached)
    ) {
      if (this.lifecycleDrained) this.lifecycleGeneration += 1;
      this.lifecycleDrained = false;
      this.lifecycleIdle = false;
    }
    this.durable = this.projection.reduce(this.durable, {
      seq: this.seq,
      time: 0,
      event: event as LoopRecord,
    });
    this.seq += 1;
    if (event.type === 'context.settled') this.revision += 1;
    this.events.push(event);
    return event;
  }

  private post(message: ActorMessage): void {
    this.messages.push(message);
  }

  private transition<T>(run: () => T): T {
    this.turnTransitions += 1;
    try {
      return run();
    } finally {
      this.turnTransitions -= 1;
      if (this.turnTransitions === 0) this.kick();
    }
  }

  private kick(): void {
    if (this.kicking || this.dispatching || this.turnTransitions > 0) return;
    this.kicking = true;
    let failed = false;
    let failure: unknown;
    const deliver = (): void => {
      try {
        this.drainEvents();
      } catch (error) {
        if (!failed) {
          failed = true;
          failure = error;
        }
      }
    };
    try {
      while (true) {
        if (!this.resetting && !this.hasPendingCompletions && this.completionContinuation !== undefined) {
          const continuation = this.completionContinuation;
          this.completionContinuation = undefined;
          continuation();
          continue;
        }
        deliver();
        this.settleTurnCompletions();
        const message = this.messages.shift();
        if (message !== undefined) this.handle(message);
        else if (!this.schedule()) {
          deliver();
          this.settleTurnCompletions();
          break;
        }
      }
    } finally {
      this.kicking = false;
      this.settleIdle();
      this.settleClose();
    }
    if (failed) throw failure;
  }

  private drainEvents(): void {
    if (this.dispatching) return;
    this.dispatching = true;
    let failed = false;
    let failure: unknown;
    const capture = (error: unknown): void => {
      if (failed) return;
      failed = true;
      failure = error;
    };
    try {
      for (let event = this.events.shift(); event !== undefined; event = this.events.shift()) {
        for (const listener of Array.from(this.listeners)) {
          try {
            listener(event);
          } catch (error) {
            if (this.onListenerError === undefined) capture(error);
            else {
              try {
                this.onListenerError(error, event);
              } catch (listenerError) {
                capture(listenerError);
              }
            }
          }
        }
      }
    } finally {
      this.dispatching = false;
    }
    if (failed) throw failure;
  }

  private settleTurnCompletions(): void {
    if (this.completedTurns.length === 0) return;
    const turns = this.completedTurns.splice(0);
    for (const turn of turns) {
      if (turn.completion === undefined) continue;
      if (turn.signal !== undefined && turn.onAbort !== undefined) {
        turn.signal.removeEventListener('abort', turn.onAbort);
      }
      turn.completion.resolve(turn.outcome ?? { type: 'aborted' });
    }
  }

  private settleIdle(): void {
    const drained =
      !this.resetting &&
      this.phase !== 'running' &&
      this.messages.length === 0 &&
      this.events.length === 0 &&
      !this.hasPendingCompletions &&
      !this.canSchedule();
    if (!drained) this.lifecycleDrained = false;
    const idle = drained && !this.hasActiveBackgroundTasks;
    if (!idle) this.lifecycleIdle = false;
    const publishDrained = this.open() && drained && !this.lifecycleDrained;
    const publishIdle = this.open() && idle && this.lifecycleDrained && !this.lifecycleIdle;
    if (publishDrained) {
      this.lifecycleDrained = true;
      this.record({ type: 'loop.drained', generation: this.lifecycleGeneration });
    }
    if (publishIdle) {
      this.lifecycleIdle = true;
      this.record({ type: 'loop.idle', generation: this.lifecycleGeneration });
    }
    if (!drained) return;
    const waiters = Array.from(this.idleWaiters);
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
    if (publishDrained || publishIdle) this.kick();
  }

  private settleClose(): void {
    if (
      this.phase !== 'closed' ||
      this.turn !== undefined ||
      this.closePending ||
      this.messages.length > 0 ||
      this.events.length > 0
    ) return;
    this.closeCompletion?.resolve();
  }

  private get hasPendingCompletions(): boolean {
    for (const slot of this.tools.values()) {
      if (slot.completionPending === true) return true;
    }
    return false;
  }

  private get hasActiveBackgroundTasks(): boolean {
    for (const slot of this.tools.values()) {
      if (slot.detached && !slot.done) return true;
    }
    return false;
  }

  private canSchedule(): boolean {
    return (
      !this.resetting &&
      this.phase === 'idle' &&
      !this.held &&
      !this.hasPendingCompletions &&
      (this.mailbox.hasTrigger || this.mailbox.hasReminders)
    );
  }

  private schedule(): boolean {
    if (!this.canSchedule()) return false;
    this.closeUnfinished();
    if (!this.mailbox.hasTrigger) {
      this.flushReminders();
      return true;
    }
    const next = this.mailbox.take();
    if (next === undefined) return false;
    this.activate({
      id: this.durable.nextTurnId,
      start: {
        type: 'prompt',
        trigger: next.kind,
        pending: next.pending,
        promptOnly: next.promptOnly ? true : undefined,
      },
      bypassMaxSteps: next.pending.some((item) => item.kind !== 'remind' && item.message.attributes?.bypassMaxSteps === true),
    });
    return true;
  }

  private activate(input: TurnInput, completion?: TurnCompletion): LiveTurn | undefined {
    if (this.phase !== 'idle' || this.turn !== undefined) return undefined;
    const machine = createTurn(input, this.turnRuntime);
    const turn: LiveTurn = {
      id: input.id,
      trigger: machine.state.trigger,
      machine,
      pending: input.start.type === 'prompt' ? [...input.start.pending] : [],
      promptOnly: input.start.type === 'prompt' && input.start.promptOnly === true ? true : undefined,
      resumed: input.start.type === 'resume' ? true : undefined,
      announced: false,
      completion,
      signal: input.signal,
    };
    this.phase = 'running';
    this.held = false;
    this.turn = turn;
    this.post({ type: 'turn.start', turn });
    return turn;
  }

  private startTurn(turn: LiveTurn): void {
    if (this.isCurrent(turn)) turn.machine.start();
  }

  private releaseIntake(): void {
    if (!this.resetting) this.held = false;
    if (!this.kicking && !this.dispatching) this.schedule();
  }

  private abortRequest(): void {
    this.turn?.machine.interrupt(STEERED);
  }

  private handle(message: ActorMessage): void {
    switch (message.type) {
      case 'turn.start':
        this.startTurn(message.turn);
        return;
      case 'tool.prepared':
        this.announceTool(message.slot);
        return;
      case 'tool.responded':
        this.respondToTool(message.slot, message.response);
        return;
      case 'tool.failed':
        this.failTool(message.slot, message.error);
        return;
      case 'tool.completed':
        this.completeTool(message.slot, message.result);
        return;
      case 'tool.detached_completed':
        this.completeDetached(message.slot, message.outcome, message.completion);
        return;
      case 'tool.detached_rejected':
        if (this.phase !== 'closed') this.completeDetached(message.slot, message.outcome, message.completion);
        return;
      case 'tool.abort':
        this.abortToolCall(message.toolCallId, message.reason);
        return;
      case 'abort.requested':
        this.requestAbort(message.turn ?? this.turn, message.reason, message.continueAfterAbort);
        return;
      case 'continue':
        this.continueTurn(message.force);
        return;
      case 'close':
        this.closeRuntime();
        return;
      case 'close.detached':
        this.completeDetachedClose(message.completions);
        return;
      case 'close.failed':
        this.failClose(message.error);
    }
  }

  submit(message: UserMessage): LoopAck<'prompt.submitted'> | undefined {
    const normalized = normalizeUserMessage(message);
    this.check({ type: 'input.submit', message: normalized });
    if (!this.open()) return undefined;
    const ack = this.mailbox.submit(normalized);
    this.releaseIntake();
    this.kick();
    return ack;
  }

  notify(message: UserMessage): LoopAck<'prompt.notified'> | undefined {
    const normalized = normalizeUserMessage(message);
    this.check({ type: 'input.notify', message: normalized });
    if (!this.open()) return undefined;
    const ack = this.mailbox.notify(normalized);
    this.releaseIntake();
    this.kick();
    return ack;
  }

  recordNotification(message: UserMessage): LoopAck<'prompt.notified'> | undefined {
    const normalized = normalizeUserMessage({
      ...message,
      attributes: { ...message.attributes, promptOnly: true },
    });
    this.check({ type: 'input.notify', message: normalized });
    if (!this.open()) return undefined;
    return this.mailbox.notify(normalized);
  }

  remind(...messages: readonly RemindMessage[]): LoopAck<'prompt.reminded'> | undefined {
    for (const message of messages) this.check({ type: 'input.remind', message });
    if (!this.open() || messages.length === 0) return undefined;
    const ack = this.mailbox.remind(messages);
    this.kick();
    return ack;
  }

  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined {
    this.check({ type: 'input.steer', promptIds });
    if (!this.open()) return undefined;
    const ack = this.mailbox.steer(promptIds);
    if ((ack.messages?.length ?? 0) > 0) {
      this.releaseIntake();
      if (this.turn?.machine.state.phase === 'requesting') this.abortRequest();
    }
    this.kick();
    return ack;
  }

  sendNow(message: UserMessage): LoopAck<'prompt.notified'> | undefined;
  sendNow(promptIds: readonly string[]): void;
  sendNow(input: UserMessage | readonly string[]): LoopAck<'prompt.notified'> | undefined | void {
    const message = Array.isArray(input) ? undefined : input as UserMessage;
    if (message !== undefined) {
      const normalized = normalizeUserMessage(message);
      this.check({ type: 'input.notify', message: normalized });
      if (!this.open()) return undefined;
      const ack = this.mailbox.notify(normalized);
      this.releaseIntake();
      this.abortRequest();
      this.kick();
      return ack;
    }
    const promptIds = input as readonly string[];
    this.check({ type: 'input.steer', promptIds });
    if (!this.open()) return;
    const ids = new Set(promptIds);
    if (ids.size !== promptIds.length) return;
    const inbox = this.mailbox.snapshot;
    const normal = new Set(inbox.normal.map((item) => item.attributes?.promptId));
    const notify = new Set(inbox.notify.map((item) => item.attributes?.promptId));
    if (![...ids].every((id) => normal.has(id) || notify.has(id))) return;
    const pending = promptIds.filter((id) => normal.has(id));
    if (pending.length > 0) this.mailbox.steer(pending);
    this.releaseIntake();
    this.abortRequest();
    this.kick();
  }

  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined {
    this.check({ type: 'input.cancel', promptId });
    if (!this.open()) return undefined;
    const ack = this.mailbox.cancel(promptId);
    this.kick();
    return ack;
  }

  start(): void {
    if (!this.open()) return;
    this.held = false;
    this.schedule();
    this.kick();
  }

  resume(): void {
    if (this.durable.unfinished === undefined || !isResumable(this.durable)) return;
    this.continue();
  }

  continue(options?: { readonly force?: boolean }): void {
    if (!this.open()) return;
    this.post({ type: 'continue', force: options?.force === true });
    this.kick();
  }

  abort(reason?: unknown, options?: { readonly continue?: boolean }): void {
    if (!this.open()) return;
    this.post({ type: 'abort.requested', reason, continueAfterAbort: options?.continue === true });
    this.kick();
  }

  abortTool(toolCallId: string, reason?: unknown): void {
    this.check({ type: 'input.abort_tool', toolCallId });
    if (!this.open()) return;
    this.post({ type: 'tool.abort', toolCallId, reason });
    this.kick();
  }

  detachTool(toolCallId: string, text?: string, completion?: ToolCompletionFactory): void {
    this.check({ type: 'input.detach_tool', toolCallId });
    if (!this.open()) return;
    for (const slot of Array.from(this.tools.values())) {
      if (slot.toolCall.id === toolCallId && !slot.detached) {
        slot.completion = completion;
        const acknowledgement = text ?? `moved to background by the user: ${slot.toolCall.name} (tool_call_id=${toolCallId})`;
        const response = slot.handler.detach(acknowledgement, {
          content: [{ type: 'text', text: acknowledgement }],
        });
        if (response !== undefined) this.post({ type: 'tool.responded', slot, response });
      }
    }
    this.kick();
  }

  async reset(prepare: () => Promise<LoopInput>): Promise<void> {
    if (!this.open() || this.resetting || this.phase !== 'idle') {
      throw new Error('Loop reset requires an idle open loop');
    }
    const held = this.held;
    const liveToolCallIds = new Set(
      Array.from(this.tools.values()).filter((slot) => slot.detached).map((slot) => slot.toolCall.id),
    );
    this.resetting = true;
    this.held = true;
    try {
      this.kick();
      if (!this.open()) return;
      const input = await prepare();
      if (!this.open()) return;
      const invalid = inputError(input);
      if (invalid !== undefined) throw new TypeError(invalid);
      const live = this.mailbox.snapshot;
      const restored = input.inbox ?? {};
      const normal = mergeResetEntries(live.normal, restored.normal ?? [], liveToolCallIds);
      const notify = mergeResetEntries(live.notify, restored.notify ?? [], liveToolCallIds);
      const remind = mergeResetEntries(live.remind, restored.remind ?? [], liveToolCallIds);
      const unfinished = input.unfinished;
      const profile = input.profile ?? this.durable.profile;
      const nextTurnId = Math.max(
        this.durable.nextTurnId,
        input.nextTurnId ?? 0,
        unfinished === undefined ? 0 : unfinished.turnId + 1,
      );
      const revision = Math.max(this.revision, input.historyRevision ?? 0);
      this.durable = {
        ...this.projection.initial(),
        profile: {
          ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
          ...(profile.tools === undefined ? {} : { tools: [...profile.tools] }),
        },
        messages: [...(input.messages ?? [])],
        nextTurnId,
        ...(unfinished === undefined ? {} : { unfinished: { ...unfinished } }),
      };
      this.revision = revision;
      this.mailbox = new LoopMailbox({ normal, notify, remind }, (event) => {
        this.record(event);
      });
      this.turn = undefined;
      this.toolBatch = undefined;
      this.completedToolBatch = undefined;
      this.completionHandoff = false;
      this.held = true;
    } catch (error) {
      this.held = held;
      throw error;
    } finally {
      this.resetting = false;
      this.kick();
    }
  }

  setRequester(requester: LoopLlmRequester | undefined): void {
    if (!this.open()) return;
    this.requesterTemplate = requester;
  }

  setContext(messages: Message[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined {
    this.check({ type: 'input.set_context', messages });
    if (!this.open()) return undefined;
    if (!this.editable() && reason !== 'compaction' && reason !== 'clear' && reason !== 'context.clear') {
      const ack = this.record({ type: 'context.rejected', messages, reason });
      this.kick();
      return ack;
    }
    if (reason === 'compaction') this.mailbox.clearReminders();
    const ack = this.record({ type: 'context.settled', messages, reason });
    this.kick();
    return ack;
  }

  private editable(): boolean {
    if (this.phase === 'running') {
      const phase = this.turn?.machine.state.phase;
      return phase === 'ending' || phase === 'stepStarting';
    }
    return this.phase === 'idle' && this.durable.unfinished === undefined;
  }

  setSystemPrompt(systemPrompt: string): LoopAck<'system_prompt.settled'> | undefined {
    this.check({ type: 'input.set_system_prompt', systemPrompt });
    if (!this.open()) return undefined;
    const ack = this.record({ type: 'system_prompt.settled', systemPrompt });
    this.kick();
    return ack;
  }

  subscribe(listener: (event: LoopEmitted) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  wait<T extends LoopEmitted['type']>(type: T, opts?: WaitOpts<LoopAck<T>>): Promise<LoopAck<T>> {
    return waitEvent<LoopAck<T>>(
      (handler) =>
        this.subscribe((event) => {
          if (event.type === type) handler(event as LoopAck<T>);
        }),
      opts,
    );
  }

  runTurn(message: UserMessage, opts?: { readonly signal?: AbortSignal }): Promise<TurnOutcome> {
    const signal = opts?.signal;
    if (signal?.aborted) return Promise.resolve({ type: 'aborted', reason: signal.reason });
    try {
      this.check({ type: 'input.run_turn', message });
      if (!this.open() || this.phase !== 'idle') {
        return Promise.reject(new Error('runTurn is only accepted while idle'));
      }
      const completion = turnCompletion();
      this.closeUnfinished();
      const turn = this.activate({
        id: this.durable.nextTurnId,
        start: {
          type: 'prompt',
          trigger: 'normal',
          pending: [
            { kind: 'normal', message },
            ...this.mailbox.drainReminders().map((reminder) => ({ kind: 'remind' as const, message: reminder })),
          ],
        },
        bypassMaxSteps: message.attributes?.bypassMaxSteps === true,
        signal,
      }, completion)!;
      if (signal !== undefined) {
        turn.onAbort = () => {
          if (this.turn !== turn || !this.open()) return;
          this.post({ type: 'abort.requested', turn, reason: signal.reason, continueAfterAbort: false });
          this.kick();
        };
        signal.addEventListener('abort', turn.onAbort, { once: true });
      }
      this.record({ type: 'prompt.submitted', message });
      this.kick();
      return completion.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  waitForIdle(): Promise<void> {
    if (
      !this.resetting &&
      this.phase !== 'running' &&
      !this.kicking &&
      !this.dispatching &&
      this.messages.length === 0 &&
      this.events.length === 0 &&
      !this.hasPendingCompletions &&
      !this.canSchedule()
    ) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  close(): Promise<void> {
    if (this.closeCompletion !== undefined) return this.closeCompletion.promise;
    const completion = deferred<void>();
    this.closeCompletion = completion;
    try {
      this.post({ type: 'close' });
      this.kick();
    } catch (error) {
      completion.reject(error);
    }
    return completion.promise;
  }

  private isCurrent(turn: LiveTurn): boolean {
    return this.turn === turn && this.phase === 'running';
  }

  private announceTurn(turn: LiveTurn): void {
    if (turn.announced) return;
    turn.announced = true;
    if (turn.resumed === true) this.record({ type: 'turn.resumed', turnId: turn.id, step: turn.machine.state.step });
    else this.record({
      type: 'turn.started',
      turnId: turn.id,
      trigger: turn.trigger,
      promptOnly: turn.promptOnly,
      message: turn.pending.find((item): item is Extract<QueuedItem, { kind: 'normal' | 'notify' }> => item.kind !== 'remind')?.message,
    });
  }

  private report(
    point: HookPoint,
    turn: LiveTurn,
    step: number,
    reports: readonly HookFailureReport[],
    notify: boolean,
  ): void {
    const messages: UserMessage[] = [];
    for (const { failure, message } of reports) {
      this.record(hookFailedEvent(point, turn.id, step, failure));
      this.record({ type: 'prompt.notified', message });
      messages.push(message);
      failure.suspend?.();
    }
    if (notify) {
      this.mailbox.queue(messages);
      this.held = false;
      this.schedule();
    }
  }

  private releaseTurn(turn: LiveTurn, outcome: TurnOutcome): void {
    const pending = turn.pending;
    turn.pending = [];
    turn.outcome = outcome;
    this.mailbox.restore(pending);
    this.held = true;
  }

  private settleBlockedTurn(
    turn: LiveTurn,
    outcome: Extract<TurnOutcome, { type: 'blocked' }>,
    ctx: Pick<TurnHookContext, 'append'>,
  ): void {
    const pending = turn.pending;
    turn.pending = [];
    turn.outcome = outcome;
    this.mailbox.restore(pending.filter((item) => item.kind === 'notify'));
    const reminders = [
      ...pending.flatMap((item) => item.kind === 'remind' ? [item.message] : []),
      ...this.mailbox.drainReminders(),
    ];
    this.held = true;
    this.announceTurn(turn);
    for (const item of pending) {
      if (item.kind === 'normal') ctx.append({ source: 'normal', message: item.message });
    }
    for (const message of reminders) ctx.append({ source: 'remind', message });
  }

  private requestAbort(turn: LiveTurn | undefined, reason: unknown, continueAfterAbort: boolean): void {
    if (turn === undefined) {
      if (this.phase === 'idle') this.closeUnfinished();
      return;
    }
    if (!this.isCurrent(turn)) return;
    if (turn.machine.state.outcome?.type === 'aborted') {
      turn.machine.abort(reason, { force: true });
      return;
    }
    turn.continueAfterAbort = continueAfterAbort || turn.continueAfterAbort === true;
    this.releaseTurn(turn, { type: 'aborted', reason });
    turn.machine.abort(reason);
  }

  private async ownerStarting(
    event: TurnOwnerStartingEvent,
    ctx: TurnHookContext,
  ): Promise<TurnStartDecision> {
    const turn = this.turn;
    if (turn === undefined || turn.id !== event.turnId) throw new Error('turn is no longer active');
    if (turn.resumed === true) {
      this.announceTurn(turn);
      if (this.mailbox.hasNotify) return { done: { by: 'loop', reason: 'notify' } };
      return {};
    }
    const run = await (async (): Promise<TurnStartingRun> => {
      try {
        return await runTurnStarting(
          this.hook,
          { turnId: turn.id, trigger: turn.trigger, pending: turn.pending },
          ctx.signal,
        );
      } catch (error) {
        return { failures: [runtimeFailure(error)] };
      }
    })();
    if (this.turn !== turn || ctx.signal.aborted) return {};
    this.transition(() => {
      const reports = hookFailureReports('turn.starting', run.failures);
      turn.pending.push(...reports.map(({ message }) => ({ kind: 'notify' as const, message })));
      this.report('turn.starting', turn, turn.machine.state.step, reports, false);
      if (run.blocked === undefined) this.announceTurn(turn);
    });
    if (run.blocked !== undefined) return { blocked: run.blocked };
    const items = await this.appendPendingItems(turn, ctx.signal);
    if (this.turn !== turn || ctx.signal.aborted) return {};
    for (const item of items) {
      ctx.append({
        source: item.source as TurnMessage['source'],
        message: item.message,
        blocked: 'blocked' in item ? item.blocked : undefined,
        failure: 'failure' in item ? item.failure : undefined,
      });
    }
    return {};
  }

  private async appendPendingItems(turn: LiveTurn, signal: AbortSignal): Promise<AppendedItem[]> {
    const items = turn.pending;
    const appended: AppendedItem[] = [];
    try {
      for (const item of items) {
        const run = await runMessageAppending(
          this.hook,
          { turnId: turn.id, step: turn.machine.state.step, item },
          signal,
        );
        appended.push({ source: item.kind, message: run.message, blocked: run.blocked });
        for (const failure of run.failures) {
          appended.push({ source: 'notify', message: hookFailureMessage('message.appending', failure.error), failure });
        }
      }
    } catch (error) {
      appended.length = 0;
      appended.push(...items.map((item) => ({ source: item.kind, message: item.message })));
      appended.push({
        source: 'notify',
        message: hookFailureMessage('message.appending', error),
        failure: runtimeFailure(error),
      });
    }
    return appended;
  }

  private ownerRequesting(event: TurnPoint, ctx: TurnHookContext): TurnYield | void | Promise<TurnYield | void> {
    if (this.turn?.id !== event.turnId) return;
    const settled = this.settleCompletions();
    const complete = (): TurnYield | void => {
      if (this.turn?.id !== event.turnId || ctx.signal.aborted) return;
      if (this.completionHandoff) {
        this.completionHandoff = false;
        return { type: 'done', cause: { by: 'loop', reason: 'notify' } };
      }
      ctx.append(...this.mailbox.drainReminders().map((message) => ({ source: 'remind' as const, message })));
    };
    return isPromiseLike(settled) ? settled.then(complete) : complete();
  }

  private ownerContinuing(event: TurnPoint, _ctx: TurnHookContext): TurnYield | void | Promise<TurnYield | void> {
    if (this.turn?.id !== event.turnId) return;
    const settled = this.settleCompletions();
    const complete = (): TurnYield | void => {
      if (this.turn?.id !== event.turnId) return;
      if (this.mailbox.hasNotify) return { type: 'done', cause: { by: 'loop', reason: 'notify' } };
    };
    return isPromiseLike(settled) ? settled.then(complete) : complete();
  }

  private settleCompletions(): void | Promise<void> {
    let resume!: () => void;
    const waiting = new Promise<void>((resolve) => {
      resume = resolve;
    });
    if (!this.deferForCompletion(resume)) return;
    return waiting.then(() => this.settleCompletions() as void);
  }

  private ownerEnding(event: TurnEnding, ctx: Pick<TurnHookContext, 'append'>): void {
    const turn = this.turn;
    if (turn === undefined || turn.id !== event.turnId) return;
    if (event.outcome.type === 'blocked' && event.outcome.at === 'turn.starting') {
      this.settleBlockedTurn(turn, event.outcome, ctx);
      return;
    }
    this.announceTurn(turn);
    if (event.at === 'requesting') {
      this.mailbox.restore(event.uncommitted.flatMap((item) =>
        item.source === 'remind' ? [{ kind: 'remind' as const, message: item.message }] : [],
      ));
    }
    if (event.outcome.type !== 'aborted') return;
    for (const message of this.mailbox.drainReminders()) ctx.append({ source: 'remind', message });
  }

  flushReminders(): void {
    if (!this.open()) return;
    const messages = this.mailbox.drainReminders();
    for (const message of messages) {
      this.record({
        type: 'message.appended',
        turnId: this.turn?.id ?? this.durable.nextTurnId,
        step: this.turn?.machine.state.step ?? 0,
        source: 'remind',
        message,
      });
    }
    this.kick();
  }

  private settleUnfinished(outcome: StepOutcome): void {
    const unfinished = this.durable.unfinished;
    if (unfinished === undefined) return;
    const { turnId, step } = unfinished;
    for (const toolCall of trailingCalls(this.durable.messages).unresolved) {
      const result = abortedToolOutcome(toolCall, CRASHED);
      this.record({ type: 'tool.ended', toolCallId: toolCall.id, outcome: result, detached: false });
      this.record({ type: 'message.appended', turnId, step, source: 'tool', message: result.message });
    }
    if (unfinished.stepUnfinished) this.record({ type: 'step.ended', turnId, step, outcome });
  }

  private closeUnfinished(): void {
    const unfinished = this.durable.unfinished;
    if (unfinished === undefined) return;
    const outcome = { type: 'aborted' as const, reason: CRASHED };
    this.settleUnfinished(outcome);
    this.record({ type: 'turn.ended', turnId: unfinished.turnId, outcome });
  }

  private continueTurn(force: boolean): void {
    if (this.resetting || this.phase !== 'idle') return;
    if (this.deferForCompletion(() => this.continueTurn(force))) return;
    const unfinished = this.durable.unfinished;
    if (unfinished !== undefined && isResumable(this.durable)) {
      this.settleUnfinished({ type: 'continue', cause: CRASHED });
      this.activate({
        id: unfinished.turnId,
        start: { type: 'resume', trigger: unfinished.trigger, step: unfinished.step },
      });
      return;
    }
    this.closeUnfinished();
    if (!this.mailbox.hasTrigger && (force || canContinue(this.durable.messages))) {
      this.activate({
        id: this.durable.nextTurnId,
        start: { type: 'continue' },
      });
      return;
    }
    this.held = false;
    this.schedule();
  }

  private finishTurn(turn: LiveTurn, outcome: TurnOutcome): void {
    if (this.turn !== turn) return;
    this.announceTurn(turn);
    for (const [key, slot] of this.tools) {
      if (slot.turnId !== turn.id || slot.detached) continue;
      slot.done = true;
      this.tools.delete(key);
      this.notifyTool(slot);
    }
    const batch = this.toolBatch;
    if (batch?.turnId === turn.id) {
      this.toolBatch = undefined;
      batch.resolve({
        outcomes: batch.calls.map((_, index) => batch.outcomes[index] ?? null),
        failure: batch.failure,
      });
    }
    turn.outcome = outcome;
    if (this.completedToolBatch?.turnId === turn.id) this.completedToolBatch = undefined;
    this.completionHandoff = false;
    this.completionContinuation = undefined;
    this.turn = undefined;
    this.phase = this.phase === 'closed' ? 'closed' : 'idle';
    this.completedTurns.push(turn);
    if (outcome.type === 'aborted' && turn.continueAfterAbort === true) this.held = false;
    this.schedule();
  }

  private closeRuntime(): void {
    if (this.phase !== 'closed') {
      this.closeDetached();
      this.phase = 'closed';
      const turn = this.turn;
      if (turn !== undefined) this.closeTurn(turn);
      this.root.abort();
    }
  }

  private closeTurn(turn: LiveTurn): void {
    const outcome = turn.machine.state.outcome;
    const reason = outcome?.type === 'aborted' ? outcome.reason : CLOSED;
    if (outcome?.type !== 'aborted') this.releaseTurn(turn, { type: 'aborted', reason: CLOSED });
    turn.machine.abort(reason, { force: true });
  }

  private executeToolBatch(batch: TurnToolBatch): TurnToolBatchResult | Promise<TurnToolBatchResult> {
    if (batch.blocked !== undefined) {
      return this.transition(() => {
        const blocked = batch.blocked!;
        const outcomes = batch.calls.map(({ toolCall }) => {
          const outcome = blockedToolOutcome(toolCall, blocked.cause, blocked.result);
          this.record({ type: 'tool.started', turnId: batch.turnId, step: batch.step, toolCall });
          this.record({ type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
          return outcome;
        });
        const result = { outcomes };
        this.completedToolBatch = { turnId: batch.turnId, step: batch.step, result };
        return result;
      });
    }
    if (batch.aborted !== undefined) return this.abortedBatchResult(batch, batch.aborted.reason);
    const completion = deferred<TurnToolBatchResult>();
    const active: ActiveToolBatch = {
      ...batch,
      outcomes: Array.from({ length: batch.calls.length }),
      resolve: (result) => {
        completion.resolve(result);
      },
    };
    this.toolBatch = active;
    const slots: LiveTool[] = [];
    for (const call of batch.calls) {
      const context = {
        origin: 'loop' as const,
        turnId: batch.turnId,
        step: batch.step,
        ...this.toolContext?.(batch.turnId),
      };
      const handler = this.executor.execute(call.toolCall, context);
      const slot: LiveTool = {
        key: call.key,
        toolCall: call.toolCall,
        turnId: batch.turnId,
        step: batch.step,
        handler,
        detached: false,
        announced: false,
        responded: false,
        done: false,
        waiters: new Set(),
      };
      this.tools.set(call.key, slot);
      slots.push(slot);
    }
    for (const slot of slots) this.executeTool(slot);
    this.checkToolBatch(active);
    this.kick();
    return completion.promise;
  }

  private abortToolBatch(
    batch: TurnToolBatch,
    reason: unknown,
    _options?: { readonly force?: boolean },
  ): TurnToolBatchResult | undefined {
    const active = this.toolBatch;
    if (active === undefined || active.turnId !== batch.turnId || active.step !== batch.step) {
      const completed = this.completedToolBatch;
      if (completed?.turnId === batch.turnId && completed.step === batch.step) return completed.result;
      return this.abortedBatchResult(batch, reason);
    }
    this.transition(() => {
      this.settleUnstartedBatchCalls(active, reason);
      for (const slot of this.tools.values()) {
        if (slot.turnId === batch.turnId && slot.step === batch.step && !slot.detached && !slot.done) {
          void slot.handler.stop(reason);
        }
      }
      this.checkToolBatch(active);
    });
    return undefined;
  }

  private abortedBatchResult(batch: TurnToolBatch, reason: unknown): TurnToolBatchResult {
    return this.transition(() => {
      const outcomes = batch.calls.map(({ toolCall }) => {
        this.record({ type: 'tool.started', turnId: batch.turnId, step: batch.step, toolCall });
        const outcome = abortedToolOutcome(toolCall, reason);
        this.record({ type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
        return outcome;
      });
      const result = { outcomes };
      this.completedToolBatch = { turnId: batch.turnId, step: batch.step, result };
      return result;
    });
  }

  private settleUnstartedBatchCalls(batch: ActiveToolBatch, reason: unknown): void {
    for (const [index, call] of batch.calls.entries()) {
      if (batch.outcomes[index] !== undefined || this.tools.has(call.key)) continue;
      this.record({ type: 'tool.started', turnId: batch.turnId, step: batch.step, toolCall: call.toolCall });
      const outcome = abortedToolOutcome(call.toolCall, reason);
      this.record({ type: 'tool.ended', toolCallId: call.toolCall.id, outcome, detached: false });
      batch.outcomes[index] = outcome;
    }
  }

  private settleToolBatch(slot: LiveTool, outcome: ToolCallOutcome | null, failure?: unknown): void {
    const batch = this.toolBatch;
    if (batch === undefined || batch.turnId !== slot.turnId || batch.step !== slot.step) return;
    const index = batch.calls.findIndex((call) => call.key === slot.key);
    if (index < 0 || batch.outcomes[index] !== undefined) return;
    batch.outcomes[index] = outcome;
    if (failure !== undefined) batch.failure = failure;
    this.checkToolBatch(batch);
  }

  private checkToolBatch(batch: ActiveToolBatch): void {
    if (batch.outcomes.some((outcome) => outcome === undefined)) return;
    if (this.toolBatch === batch) this.toolBatch = undefined;
    const result = { outcomes: [...batch.outcomes] as (ToolCallOutcome | null)[], failure: batch.failure };
    this.completedToolBatch = { turnId: batch.turnId, step: batch.step, result };
    batch.resolve(result);
  }

  private executeTool(slot: LiveTool): void {
    const prepared = (): void => {
      this.post({ type: 'tool.prepared', slot });
      this.kick();
    };
    const unsubscribe = slot.handler.observe((event) => {
      if (event.type !== 'change') return;
      const snapshot = event.snapshot;
      if (
        snapshot.phase === 'execute' ||
        snapshot.status === 'success' ||
        snapshot.status === 'failed' ||
        snapshot.status === 'aborted'
      ) prepared();
    });
    void Promise.resolve(slot.handler).then((response) => {
      this.post({ type: 'tool.responded', slot, response });
      this.kick();
    }, (error: unknown) => {
      unsubscribe();
      this.post({ type: 'tool.failed', slot, error });
      this.kick();
    });
    void slot.handler.wait().then((result) => {
      unsubscribe();
      this.post({ type: 'tool.completed', slot, result });
      this.kick();
    }, () => undefined);
  }

  private announceTool(slot: LiveTool): void {
    if (slot.announced || slot.done) return;
    slot.announced = true;
    const prepared = slot.handler.snapshot().prepared as { display?: { kind: string } } | undefined;
    this.record({
      type: 'tool.started',
      taskId: slot.handler.taskId,
      turnId: slot.turnId,
      step: slot.step,
      toolCall: slot.toolCall,
      args: slot.handler.snapshot().args,
      display: prepared?.display,
    });
  }

  private failTool(slot: LiveTool, error: unknown): void {
    if (slot.done) return;
    slot.responded = true;
    slot.done = true;
    this.tools.delete(slot.key);
    this.notifyTool(slot);
    this.settleToolBatch(slot, null, error);
  }

  private respondToTool(slot: LiveTool, response: ToolExecutionResponse): void {
    if (slot.responded) return;
    slot.responded = true;
    if (isToolDetachAck(response)) {
      slot.detached = true;
    } else {
      slot.result = response;
    }
    const outcome = isToolDetachAck(response)
      ? { type: 'succeeded' as const, message: toolOutcomeMessage(slot.toolCall, response, true) }
      : toolOutcomeOf(slot);
    this.record({
      type: 'tool.ended',
      taskId: slot.handler.taskId,
      toolCallId: slot.toolCall.id,
      outcome,
      detached: slot.detached,
    });
    this.settleToolBatch(slot, outcome);
  }

  private completeTool(slot: LiveTool, result: ToolResult): void {
    if (slot.done) return;
    slot.result = result;
    slot.done = true;
    if (slot.detached) {
      slot.completionPending = true;
      const outcome = asyncOutcomeOf(slot);
      const completion = slot.completion ?? this.completionFactory;
      if (completion === undefined) {
        const message = completionMessage(slot.toolCall, outcome, result);
        slot.completionMessage = Promise.resolve(message);
        this.post({ type: 'tool.detached_completed', slot, outcome, completion: message });
      } else {
        slot.completionMessage = resolveCompletionMessage({
          toolCall: slot.toolCall,
          outcome,
          result,
        }, completion);
        void slot.completionMessage.then((message) => {
          this.post({ type: 'tool.detached_completed', slot, outcome, completion: message });
          this.kick();
        }, (error: unknown) => {
          if (this.phase === 'closed') {
            this.closeDetached();
            this.kick();
            return;
          }
          const failed: AsyncToolOutcome = { type: 'failed', error };
          const input = { toolCall: slot.toolCall, outcome: failed, result };
          const fallback = async (): Promise<UserMessage> => {
            try {
              if (completion.onRejected !== undefined) {
                return await completion.onRejected(error, input);
              }
            } catch {
            }
            return completionMessage(slot.toolCall, failed, result);
          };
          void fallback().then((message) => {
            if (this.phase === 'closed') return;
            this.post({ type: 'tool.detached_rejected', slot, outcome: failed, completion: message });
            this.kick();
          });
        });
      }
      this.kick();
      return;
    }
    this.tools.delete(slot.key);
    this.notifyTool(slot);
  }

  private completeDetached(slot: LiveTool, outcome: AsyncToolOutcome, message: UserMessage): void {
    if (this.tools.get(slot.key) !== slot) return;
    if (this.phase === 'closed') {
      this.completeDetachedClose([{ slot, outcome, message }]);
      return;
    }
    slot.completionOutcome = outcome;
    slot.completionMessageValue = message;
    this.drainDetachedCompletions();
  }

  private drainDetachedCompletions(): void {
    let drained = false;
    for (const slot of Array.from(this.tools.values())) {
      const message = slot.completionMessageValue;
      const outcome = slot.completionOutcome;
      if (message === undefined || outcome === undefined) continue;
      this.tools.delete(slot.key);
      slot.completionPending = false;
      this.notifyTool(slot);
      const shouldQueue = this.shouldQueueTaskNotification?.(slot.handler.taskId) ?? true;
      this.record({ type: 'tool.async_ended', taskId: slot.handler.taskId, toolCallId: slot.toolCall.id, outcome, message });
      if (shouldQueue) {
        this.record({ type: 'prompt.notified', message });
        if (this.turn !== undefined) this.completionHandoff = true;
        this.mailbox.queue([message]);
      }
      drained = true;
    }
    if (!drained) return;
    if (!this.resetting) this.held = false;
    this.schedule();
  }

  private deferForCompletion(continuation: () => void): boolean {
    this.drainDetachedCompletions();
    if (!this.hasPendingCompletions) return false;
    this.completionContinuation = continuation;
    return true;
  }

  private notifyTool(slot: LiveTool): void {
    for (const notify of Array.from(slot.waiters)) notify();
  }

  private abortToolCall(toolCallId: string, reason: unknown): void {
    for (const slot of this.tools.values()) {
      if (slot.toolCall.id === toolCallId && !slot.detached && !slot.done) {
        void slot.handler.stop(reason);
      }
    }
  }

  private closeDetached(): void {
    const closing: { slot: LiveTool; outcome: AsyncToolOutcome; message: Promise<UserMessage> }[] = [];
    let pending = false;
    for (const slot of this.tools.values()) {
      if (!slot.detached) continue;
      pending = true;
      void slot.handler.stop(CLOSED);
      if (!slot.done) continue;
      const outcome = asyncOutcomeOf(slot);
      slot.completionMessage ??= resolveCompletionMessage({
        toolCall: slot.toolCall,
        outcome,
        result: slot.result,
      }, slot.completion ?? this.completionFactory);
      closing.push({ slot, outcome, message: slot.completionMessage });
    }
    this.closePending = pending;
    if (closing.length === 0) return;
    void Promise.all(closing.map(async ({ slot, outcome, message }) => {
      try {
        return { slot, outcome, message: await message, failure: undefined };
      } catch (error) {
        const failed: AsyncToolOutcome = { type: 'failed', error };
        const input = { toolCall: slot.toolCall, outcome: failed, result: slot.result };
        let terminalMessage: UserMessage;
        const completion = slot.completion ?? this.completionFactory;
        try {
          terminalMessage = completion?.onRejected === undefined
            ? completionMessage(slot.toolCall, failed, slot.result)
            : await completion.onRejected(error, input);
        } catch {
          terminalMessage = completionMessage(slot.toolCall, failed, slot.result);
        }
        return { slot, outcome: failed, message: terminalMessage, failure: { error } };
      }
    })).then(
      (completions) => {
        this.post({ type: 'close.detached', completions });
        const failure = completions.find((item) => item.failure !== undefined)?.failure;
        if (failure !== undefined) this.post({ type: 'close.failed', error: failure.error });
        this.kick();
      },
      (error: unknown) => {
        this.post({ type: 'close.failed', error });
        this.kick();
      },
    );
  }

  private completeDetachedClose(
    completions: readonly { readonly slot: LiveTool; readonly outcome: AsyncToolOutcome; readonly message: UserMessage }[],
  ): void {
    for (const { slot, outcome, message } of completions) {
      if (this.tools.get(slot.key) !== slot) continue;
      this.tools.delete(slot.key);
      slot.completionPending = false;
      this.record({ type: 'tool.async_ended', taskId: slot.handler.taskId, toolCallId: slot.toolCall.id, outcome, message });
      this.notifyTool(slot);
    }
    this.closePending = Array.from(this.tools.values()).some((slot) => slot.detached);
  }

  private failClose(error: unknown): void {
    this.closePending = false;
    this.closeCompletion?.reject(error);
  }
}

export function createActorLoop(options: CreateLoopOptions): Loop {
  return new LoopActor(options);
}

function anonymousMessageKey(message: Message): string {
  const { attributes: _, ...body } = message;
  return JSON.stringify(body);
}

function mergeResetEntries<T extends Message>(
  live: readonly T[],
  restored: readonly T[],
  liveToolCallIds: ReadonlySet<string>,
): T[] {
  const identities = new Set<Message>(live);
  const promptIds = new Set<string>();
  const toolCallIds = new Set<string>(liveToolCallIds);
  const anonymous = new Set<string>();
  for (const message of live) {
    const attributes = message.attributes as { promptId?: unknown; toolCallId?: unknown; source?: unknown } | undefined;
    if (typeof attributes?.promptId === 'string') promptIds.add(attributes.promptId);
    if (attributes?.source === 'async-tool' && typeof attributes.toolCallId === 'string') toolCallIds.add(attributes.toolCallId);
    if (attributes?.promptId === undefined && attributes?.toolCallId === undefined) anonymous.add(anonymousMessageKey(message));
  }
  const merged = [...live];
  for (const message of restored) {
    const attributes = message.attributes as { promptId?: unknown; toolCallId?: unknown; source?: unknown } | undefined;
    if (identities.has(message)) continue;
    if (typeof attributes?.promptId === 'string' && promptIds.has(attributes.promptId)) continue;
    if (attributes?.source === 'async-tool' && typeof attributes.toolCallId === 'string' && toolCallIds.has(attributes.toolCallId)) continue;
    if (attributes?.promptId === undefined && attributes?.toolCallId === undefined && anonymous.has(anonymousMessageKey(message))) continue;
    merged.push(message);
  }
  return merged;
}

function isUserMessage(value: unknown): value is UserMessage {
  return isMessage(value) && value.role === 'user';
}

function isRemindMessage(value: unknown): value is RemindMessage {
  return isMessage(value);
}

function arrayOf(value: unknown, guard: (item: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(guard);
}

function isCount(value: unknown): boolean {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isUnfinishedTurn(value: unknown): value is UnfinishedTurn {
  if (!isObject(value)) return false;
  return (
    isCount(value['turnId']) &&
    (value['trigger'] === 'normal' || value['trigger'] === 'notify' || value['trigger'] === 'continue') &&
    isCount(value['step']) &&
    typeof value['stepUnfinished'] === 'boolean' &&
    typeof value['appended'] === 'boolean'
  );
}

function isToolDescription(value: unknown): value is ToolDescription {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolDescription).name === 'string' &&
    typeof (value as ToolDescription).description === 'string' &&
    isObject((value as ToolDescription).parameters)
  );
}

const SYSTEM_PROMPT_ERROR = 'systemPrompt must be a string';
const TOOLS_ERROR = 'tools must be an array of tool descriptions';

function inputError(input: LoopInput): string | undefined {
  if (input.messages !== undefined && !arrayOf(input.messages, isMessage)) {
    return 'messages must be an array of messages';
  }
  const inbox = input.inbox ?? {};
  if (inbox.normal !== undefined && !arrayOf(inbox.normal, isUserMessage)) {
    return 'inbox.normal must be an array of user messages';
  }
  if (inbox.notify !== undefined && !arrayOf(inbox.notify, isUserMessage)) {
    return 'inbox.notify must be an array of user messages';
  }
  if (inbox.remind !== undefined && !arrayOf(inbox.remind, isRemindMessage)) {
    return 'inbox.remind must be an array of messages';
  }
  if (input.nextTurnId !== undefined && !isCount(input.nextTurnId)) {
    return 'nextTurnId must be a non-negative integer';
  }
  if (input.historyRevision !== undefined && !isCount(input.historyRevision)) {
    return 'historyRevision must be a non-negative integer';
  }
  if (input.unfinished !== undefined && !isUnfinishedTurn(input.unfinished)) {
    return 'unfinished must describe an unfinished turn';
  }
  const profile = input.profile ?? {};
  if (profile.systemPrompt !== undefined && typeof profile.systemPrompt !== 'string') return SYSTEM_PROMPT_ERROR;
  if (profile.tools !== undefined && !arrayOf(profile.tools, isToolDescription)) return TOOLS_ERROR;
  return undefined;
}

function commandError(command: LoopCommand): string | undefined {
  switch (command.type) {
    case 'input.run_turn':
    case 'input.submit':
    case 'input.notify':
      return isUserMessage(command.message) ? undefined : 'message must be a user message';
    case 'input.remind':
      return isRemindMessage(command.message) ? undefined : 'message must be a message';
    case 'input.steer':
      return arrayOf(command.promptIds, (id) => typeof id === 'string')
        ? undefined
        : 'promptIds must be an array of strings';
    case 'input.cancel':
      return typeof command.promptId === 'string' ? undefined : 'promptId must be a string';
    case 'input.abort_tool':
    case 'input.detach_tool':
      return typeof command.toolCallId === 'string' ? undefined : 'toolCallId must be a string';
    case 'input.set_context':
      return arrayOf(command.messages, isMessage) ? undefined : 'messages must be an array of messages';
    case 'input.set_system_prompt':
      return typeof command.systemPrompt === 'string' ? undefined : 'systemPrompt must be a string';
    default:
      return undefined;
  }
}
