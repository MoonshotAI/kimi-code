import {
  createUserEntry,
  mergeSteerMessages,
  type HistoryMessage,
  type UserEntry,
} from '#/history/message';
import type { ToolDescription } from '#/llm/message';
import { errorText } from '#/llm/protocol/errors';
import type { LlmOutcome } from '#/llm/response';
import { createPolicyRegistry, type PolicyRegistry } from '#/llm/policy/registry';
import { isToolExecutorHost, type ToolExecutor, type ToolHookFailure, type ToolHookPoint } from '#/tool/index';
import { createAbortScope, withAbort, type AbortScope } from '#/utils/abort';
import { waitEvent, type WaitOpts } from '#/utils/wait';
import type { CreateLoopOptions, Loop } from './create-loop';
import { commandError, inputError, type LoopCommand, type LoopInput } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { HookLifecycleEvent, HookPoint } from './contract/hook';
import type { Inbox, QueuedItem, RemindEntry } from './contract/inbox';
import { CLOSED, CRASHED, type StepOutcome, type TurnOutcome } from './contract/outcome';
import { createHookRegistry, type HookRegistry } from './hook/registry';
import {
  hookFailedEvent,
  hookFailureEntry,
  hookFailureReports,
  runtimeFailure,
  type HookFailureReport,
} from './hook/failure';
import {
  runMessageAppending,
  runStepEnding as runStepEndingHooks,
  runStepStarting,
  runToolBatchStarting,
  runTurnStarting,
  type StepEndingInput,
  type StepEndingRun,
  type StepStartingRun,
  type ToolBatchStartingRun,
  type TurnStartingRun,
} from './hook/run';
import { createLoopRequester } from './requester';
import { runLoopRequest, type LoopLlmRequester, type LoopRequestProgress } from './request';
import { loopProjection, type LoopRecord, type LoopRecordState } from './record';
import {
  allSettled,
  assistantEntryOf,
  canContinue,
  createTurn,
  draftOutcome,
  isResumable,
  settle,
  trailingCalls,
  type AppendedItem,
  type LiveTool,
  type LiveTurn,
  type LoopState,
  type StepState,
  type TurnCompletion,
} from './state';
import { executeLoopTool, type ToolExecOutput } from './tool/execute';
import {
  abortedToolOutcome,
  blockedToolOutcome,
  completionEntry,
  errorResult,
  toolEntry,
} from './tool/outcome';
import { createWaitForTasks, type WaitForTasks } from './tool/tasks';

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

function toolOutcomeOf(slot: LiveTool) {
  const result = slot.result ?? errorResult('missing tool result');
  if (result.blocked !== undefined) return blockedToolOutcome(slot.toolCall, result.blocked, result);
  const stops = slot.status !== 'aborted' && result.stopTurn === true;
  const entry = toolEntry(slot.toolCall, stops ? { ...result, stopTurn: true } : result);
  switch (slot.status) {
    case 'succeeded':
      return stops ? { type: 'succeeded' as const, entry, stopTurn: true as const } : { type: 'succeeded' as const, entry };
    case 'aborted':
      return { type: 'aborted' as const, entry, reason: slot.reason };
    default:
      return { type: 'failed' as const, entry, error: slot.error };
  }
}

function asyncOutcomeOf(slot: LiveTool) {
  if (slot.status === 'succeeded') return { type: 'succeeded' as const };
  if (slot.status === 'aborted') return { type: 'aborted' as const, reason: slot.reason };
  return { type: 'failed' as const, error: slot.error };
}

interface MailboxTurn {
  readonly kind: 'normal' | 'notify';
  readonly pending: QueuedItem[];
}

class LoopMailbox {
  private normal: UserEntry[];
  private notifyEntries: UserEntry[];
  private reminders: RemindEntry[];

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

  submit(entry: UserEntry): LoopAck<'prompt.submitted'> {
    this.normal.push(entry);
    const ack: LoopAck<'prompt.submitted'> = { type: 'prompt.submitted', entry };
    this.emit(ack);
    return ack;
  }

  notify(entry: UserEntry): LoopAck<'prompt.notified'> {
    this.notifyEntries.push(entry);
    const ack: LoopAck<'prompt.notified'> = { type: 'prompt.notified', entry };
    this.emit(ack);
    return ack;
  }

  remind(entry: RemindEntry): LoopAck<'prompt.reminded'> {
    this.reminders.push(entry);
    const ack: LoopAck<'prompt.reminded'> = { type: 'prompt.reminded', entry };
    this.emit(ack);
    return ack;
  }

  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> {
    const steered = this.normal.filter(
      (entry) => entry.meta?.promptId !== undefined && promptIds.includes(entry.meta.promptId),
    );
    const ids = steered.map((entry) => entry.meta?.promptId as string);
    if (steered.length === 0) {
      const ack: LoopAck<'prompt.steered'> = { type: 'prompt.steered', promptIds: ids };
      this.emit(ack);
      return ack;
    }
    const merged = mergeSteerMessages(
      steered.map((entry) => ({ content: entry.message.content, origin: entry.meta?.origin })),
    );
    const entry = createUserEntry({ role: 'user', content: merged.content }, { source: 'input', origin: merged.origin });
    this.normal = this.normal.filter((item) => !steered.includes(item));
    this.notifyEntries.push(entry);
    const ack: LoopAck<'prompt.steered'> = { type: 'prompt.steered', promptIds: ids, entry };
    this.emit(ack);
    return ack;
  }

  cancel(promptId: string): LoopAck<'prompt.canceled'> {
    const normal = this.normal.filter((entry) => entry.meta?.promptId !== promptId);
    const canceled = normal.length !== this.normal.length;
    this.normal = normal;
    const ack: LoopAck<'prompt.canceled'> = { type: 'prompt.canceled', promptId, canceled };
    this.emit(ack);
    return ack;
  }

  queue(entries: readonly UserEntry[]): void {
    this.notifyEntries.push(...entries);
  }

  restore(pending: readonly QueuedItem[]): void {
    const restored: Inbox = { normal: [], notify: [], remind: [] };
    for (const item of pending) {
      if (item.kind === 'remind') restored.remind.push(item.entry);
      else restored[item.kind].push(item.entry);
    }
    this.normal = [...restored.normal, ...this.normal];
    this.notifyEntries = [...restored.notify, ...this.notifyEntries];
    this.reminders = [...restored.remind, ...this.reminders];
  }

  take(): MailboxTurn | undefined {
    const head = this.normal[0];
    if (head === undefined && this.notifyEntries.length === 0) return undefined;
    const pending: QueuedItem[] = [
      ...(head === undefined ? [] : [{ kind: 'normal' as const, entry: head }]),
      ...this.notifyEntries.map((entry) => ({ kind: 'notify' as const, entry })),
      ...this.reminders.map((entry) => ({ kind: 'remind' as const, entry })),
    ];
    if (head !== undefined) this.normal = this.normal.slice(1);
    this.notifyEntries = [];
    this.reminders = [];
    return { kind: head === undefined ? 'notify' : 'normal', pending };
  }

  takeSide(): QueuedItem[] {
    const pending: QueuedItem[] = [
      ...this.notifyEntries.map((entry) => ({ kind: 'notify' as const, entry })),
      ...this.reminders.map((entry) => ({ kind: 'remind' as const, entry })),
    ];
    this.notifyEntries = [];
    this.reminders = [];
    return pending;
  }
}

type ActorMessage =
  | { readonly type: 'turn.start'; readonly turn: LiveTurn }
  | { readonly type: 'turn.started'; readonly turn: LiveTurn; readonly run: TurnStartingRun }
  | { readonly type: 'turn.append'; readonly turn: LiveTurn }
  | { readonly type: 'turn.appended'; readonly turn: LiveTurn; readonly appended: AppendedItem[] }
  | { readonly type: 'turn.drain'; readonly turn: LiveTurn }
  | { readonly type: 'turn.finish'; readonly turn: LiveTurn }
  | { readonly type: 'turn.failed'; readonly turn: LiveTurn; readonly error: unknown }
  | { readonly type: 'step.start'; readonly turn: LiveTurn }
  | { readonly type: 'step.hooks'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'step.started'; readonly turn: LiveTurn; readonly step: StepState; readonly run: StepStartingRun }
  | { readonly type: 'step.after_starting'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'step.ending'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'step.ended'; readonly turn: LiveTurn; readonly step: StepState; readonly run: StepEndingRun }
  | { readonly type: 'step.finish'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'step.finished'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'request.start'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'llm.progress'; readonly turn: LiveTurn; readonly step: StepState; readonly event: LoopRequestProgress }
  | { readonly type: 'llm.completed'; readonly turn: LiveTurn; readonly step: StepState; readonly outcome: LlmOutcome }
  | { readonly type: 'batch.start'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'batch.started'; readonly turn: LiveTurn; readonly step: StepState; readonly run: ToolBatchStartingRun }
  | { readonly type: 'tools.start'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'tools.execute'; readonly turn: LiveTurn; readonly step: StepState; readonly slots: LiveTool[] }
  | { readonly type: 'tool.adjudicated'; readonly slot: LiveTool; readonly toolCall: LiveTool['toolCall'] }
  | { readonly type: 'tool.hook_failed'; readonly slot: LiveTool; readonly point: ToolHookPoint; readonly failure: ToolHookFailure }
  | { readonly type: 'tool.updated'; readonly slot: LiveTool; readonly update: Parameters<NonNullable<Parameters<ToolExecutor['execute']>[0]['onUpdate']>>[0] }
  | { readonly type: 'tool.detach'; readonly slot: LiveTool; readonly text?: string }
  | { readonly type: 'tool.completed'; readonly slot: LiveTool; readonly output: ToolExecOutput }
  | { readonly type: 'tool.abort'; readonly toolCallId: string; readonly reason?: unknown }
  | { readonly type: 'acting.complete'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'abort.requested'; readonly turn?: LiveTurn; readonly reason?: unknown }
  | { readonly type: 'abort.expired'; readonly turn: LiveTurn }
  | { readonly type: 'continue' }
  | { readonly type: 'close' };

class LoopActor implements Loop {
  readonly executor: ToolExecutor;
  readonly hooks: HookRegistry;
  readonly policy: PolicyRegistry;
  readonly requester: LoopLlmRequester;
  readonly waitForTasks: WaitForTasks;

  private readonly registry: ReturnType<typeof createHookRegistry>;
  private readonly root: AbortScope = createAbortScope();
  private readonly projection = loopProjection();
  private readonly mailbox: LoopMailbox;
  private readonly listeners = new Set<(event: LoopEmitted) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly messages: ActorMessage[] = [];
  private readonly events: LoopEmitted[] = [];
  private readonly completedTurns: LiveTurn[] = [];
  private readonly adjudicates: boolean;
  private readonly abortGraceMs: number;
  private readonly onListenerError?: CreateLoopOptions['onListenerError'];
  private phase: 'idle' | 'running' | 'closed' = 'idle';
  private held = true;
  private durable: LoopRecordState;
  private turn: LiveTurn | undefined;
  private step: StepState | undefined;
  private readonly tools = new Map<string, LiveTool>();
  private base: LoopLlmRequester | undefined;
  private seq = 0;
  private kicking = false;
  private dispatching = false;
  private closeCompletion?: Deferred<void>;

  constructor(options: CreateLoopOptions) {
    const input = options.input ?? {};
    const invalid = inputError(input);
    if (invalid !== undefined) throw new TypeError(invalid);
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
    this.base = options.requester;
    this.executor = options.executor;
    this.adjudicates = isToolExecutorHost(options.executor);
    this.abortGraceMs = options.abortGraceMs ?? 2_500;
    this.onListenerError = options.onListenerError;
    this.registry = createHookRegistry();
    for (const registration of options.hooks ?? []) this.registry.add(registration);
    this.policy = createPolicyRegistry();
    this.hooks = {
      add: (registration) => this.registry.add(registration),
      pause: (id) => this.registry.pause(id),
      resume: (id) => this.registry.resume(id),
      remove: (id) => this.registry.remove(id),
      list: () => this.registry.list(),
    };
    this.requester = createLoopRequester(
      () => this.requesterForStep(),
      () => this.durable.messages,
      () => this.durable.profile,
    );
    this.waitForTasks = createWaitForTasks(() =>
      Array.from(this.tools.values()).filter((slot) => slot.detached && !slot.done),
    );
    this.registry.attach((event) => this.hookChanged(event));
  }

  get state(): LoopState {
    const { profile, messages, nextTurnId, unfinished } = this.durable;
    const current = this.turn ?? (unfinished === undefined ? undefined : {
      id: unfinished.turnId,
      trigger: unfinished.trigger,
      step: unfinished.step,
    });
    return {
      status: this.phase === 'running' ? 'running' : unfinished !== undefined ? 'interrupted' : 'idle',
      held: this.held,
      inbox: this.mailbox.snapshot,
      profile,
      messages,
      nextTurnId,
      ...(current === undefined ? {} : { turn: { id: current.id, trigger: current.trigger, step: current.step } }),
      calls: Array.from(this.tools.values(), (slot) => ({
        toolCall: slot.toolCall,
        turnId: slot.turnId,
        detached: slot.detached,
      })),
    };
  }

  get baseRequester(): LoopLlmRequester | undefined {
    return this.base;
  }

  private open(): boolean {
    return this.phase !== 'closed';
  }

  private requesterForStep(): LoopLlmRequester {
    const base = this.base;
    if (base === undefined) throw new Error('loop has no requester');
    return base.with({ policy: this.policy.asPolicy() });
  }

  private check(command: LoopCommand): void {
    const reason = commandError(command);
    if (reason !== undefined) throw new TypeError(reason);
  }

  private record<E extends LoopEmitted>(event: E): E {
    this.durable = this.projection.reduce(this.durable, {
      seq: this.seq,
      time: 0,
      event: event as LoopRecord,
    });
    this.seq += 1;
    this.events.push(event);
    return event;
  }

  private post(message: ActorMessage): void {
    this.messages.push(message);
  }

  private complete<T>(
    turn: LiveTurn,
    promise: Promise<T>,
    done: (value: T) => ActorMessage,
    failed: (error: unknown) => ActorMessage = (error) => ({ type: 'turn.failed', turn, error }),
  ): void {
    void promise.then(
      (value) => {
        this.post(done(value));
        this.kick();
      },
      (error: unknown) => {
        this.post(failed(error));
        this.kick();
      },
    );
  }

  private kick(): void {
    if (this.kicking || this.dispatching) return;
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
    if (this.phase === 'running' || this.messages.length > 0 || this.events.length > 0 || this.canSchedule()) return;
    const waiters = Array.from(this.idleWaiters);
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private settleClose(): void {
    if (this.phase !== 'closed' || this.messages.length > 0 || this.events.length > 0) return;
    this.closeCompletion?.resolve();
  }

  private canSchedule(): boolean {
    return this.phase === 'idle' && !this.held && this.mailbox.hasTrigger;
  }

  private schedule(): boolean {
    if (!this.canSchedule()) return false;
    this.closeUnfinished();
    const next = this.mailbox.take();
    if (next === undefined) return false;
    const turn = createTurn(this.root, {
      id: this.durable.nextTurnId,
      trigger: next.kind,
      step: 0,
      pending: next.pending,
    });
    this.activate(turn);
    return true;
  }

  private activate(turn: LiveTurn): void {
    this.phase = 'running';
    this.held = false;
    this.turn = turn;
    this.step = undefined;
    this.post({ type: 'turn.start', turn });
  }

  private releaseIntake(): void {
    this.held = false;
    if (!this.kicking && !this.dispatching) this.schedule();
  }

  private handle(message: ActorMessage): void {
    switch (message.type) {
      case 'turn.start':
        this.startTurn(message.turn);
        return;
      case 'turn.started':
        this.completeTurnStarting(message.turn, message.run);
        return;
      case 'turn.append':
        this.appendPending(message.turn);
        return;
      case 'turn.appended':
        this.completeAppending(message.turn, message.appended);
        return;
      case 'turn.drain':
        this.drain(message.turn);
        return;
      case 'turn.finish':
        this.finishTurn(message.turn);
        return;
      case 'turn.failed':
        this.fail(message.turn, message.error);
        return;
      case 'step.start':
        this.startStep(message.turn);
        return;
      case 'step.hooks':
        this.startStepStarting(message.turn, message.step);
        return;
      case 'step.started':
        this.completeStepStarting(message.turn, message.step, message.run);
        return;
      case 'step.after_starting':
        this.afterStepStarting(message.turn, message.step);
        return;
      case 'step.ending':
        this.startStepEnding(message.turn, message.step);
        return;
      case 'step.ended':
        this.completeStepEnding(message.turn, message.step, message.run);
        return;
      case 'step.finish':
        this.finishStep(message.turn, message.step);
        return;
      case 'step.finished':
        this.afterStepFinished(message.turn);
        return;
      case 'request.start':
        this.startRequest(message.turn, message.step);
        return;
      case 'llm.progress':
        this.requestProgress(message.turn, message.step, message.event);
        return;
      case 'llm.completed':
        this.completeRequest(message.turn, message.step, message.outcome);
        return;
      case 'batch.start':
        this.startBatch(message.turn, message.step);
        return;
      case 'batch.started':
        this.completeBatchStarting(message.turn, message.step, message.run);
        return;
      case 'tools.start':
        this.startActing(message.turn, message.step);
        return;
      case 'tools.execute':
        this.executeTools(message.turn, message.step, message.slots);
        return;
      case 'tool.adjudicated':
        this.adjudicateTool(message.slot, message.toolCall);
        return;
      case 'tool.hook_failed':
        this.failToolHook(message.slot, message.point, message.failure);
        return;
      case 'tool.updated':
        this.updateTool(message.slot, message.update);
        return;
      case 'tool.detach':
        this.detach(message.slot, message.text);
        return;
      case 'tool.completed':
        this.completeTool(message.slot, message.output);
        return;
      case 'tool.abort':
        this.abortToolCall(message.toolCallId, message.reason);
        return;
      case 'acting.complete':
        this.completeActing(message.turn, message.step);
        return;
      case 'abort.requested':
        this.requestAbort(message.turn ?? this.turn, message.reason);
        return;
      case 'abort.expired':
        this.expireAbort(message.turn);
        return;
      case 'continue':
        this.continueTurn();
        return;
      case 'close':
        this.closeRuntime();
    }
  }

  private hookChanged(event: HookLifecycleEvent): void {
    if (!this.open()) return;
    this.record(event);
    this.kick();
  }

  submit(entry: UserEntry): LoopAck<'prompt.submitted'> | undefined {
    this.check({ type: 'input.submit', entry });
    if (!this.open()) return undefined;
    const ack = this.mailbox.submit(entry);
    this.releaseIntake();
    this.kick();
    return ack;
  }

  notify(entry: UserEntry): LoopAck<'prompt.notified'> | undefined {
    this.check({ type: 'input.notify', entry });
    if (!this.open()) return undefined;
    const ack = this.mailbox.notify(entry);
    this.releaseIntake();
    this.kick();
    return ack;
  }

  remind(entry: RemindEntry): LoopAck<'prompt.reminded'> | undefined {
    this.check({ type: 'input.remind', entry });
    if (!this.open()) return undefined;
    const ack = this.mailbox.remind(entry);
    this.kick();
    return ack;
  }

  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined {
    this.check({ type: 'input.steer', promptIds });
    if (!this.open()) return undefined;
    const ack = this.mailbox.steer(promptIds);
    if (ack.entry !== undefined) this.releaseIntake();
    this.kick();
    return ack;
  }

  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined {
    this.check({ type: 'input.cancel', promptId });
    if (!this.open()) return undefined;
    const ack = this.mailbox.cancel(promptId);
    this.kick();
    return ack;
  }

  continue(): void {
    if (!this.open()) return;
    this.post({ type: 'continue' });
    this.kick();
  }

  abort(reason?: unknown): void {
    if (!this.open()) return;
    this.post({ type: 'abort.requested', reason });
    this.kick();
  }

  abortTool(toolCallId: string, reason?: unknown): void {
    this.check({ type: 'input.abort_tool', toolCallId });
    if (!this.open()) return;
    this.post({ type: 'tool.abort', toolCallId, reason });
    this.kick();
  }

  detachTool(toolCallId: string): void {
    this.check({ type: 'input.detach_tool', toolCallId });
    if (!this.open()) return;
    for (const slot of Array.from(this.tools.values())) {
      if (slot.toolCall.id === toolCallId && !slot.detached) {
        this.post({
          type: 'tool.detach',
          slot,
          text: `moved to background by the user: ${slot.toolCall.name} (tool_call_id=${toolCallId})`,
        });
      }
    }
    this.kick();
  }

  setRequester(requester: LoopLlmRequester | undefined): void {
    if (this.open()) this.base = requester;
  }

  setContext(messages: HistoryMessage[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined {
    this.check({ type: 'input.set_context', messages });
    if (!this.open()) return undefined;
    if (!this.editable()) {
      const ack = this.record({ type: 'context.rejected', messages, reason });
      this.kick();
      return ack;
    }
    const ack = this.record({ type: 'context.settled', messages, reason });
    this.kick();
    return ack;
  }

  private editable(): boolean {
    if (this.phase === 'running') return this.turn?.phase === 'ending';
    return this.phase === 'idle' && this.durable.unfinished === undefined;
  }

  setSystemPrompt(systemPrompt: string): LoopAck<'system_prompt.settled'> | undefined {
    this.check({ type: 'input.set_system_prompt', systemPrompt });
    if (!this.open()) return undefined;
    const ack = this.record({ type: 'system_prompt.settled', systemPrompt });
    this.kick();
    return ack;
  }

  setTools(tools: readonly ToolDescription[]): LoopAck<'tools.settled'> | undefined {
    this.check({ type: 'input.set_tools', tools });
    if (!this.open()) return undefined;
    const ack = this.record({ type: 'tools.settled', tools: [...tools] });
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

  runTurn(entry: UserEntry, opts?: { readonly signal?: AbortSignal }): Promise<TurnOutcome> {
    const signal = opts?.signal;
    if (signal?.aborted) return Promise.resolve({ type: 'aborted', reason: signal.reason });
    try {
      this.check({ type: 'input.run_turn', entry });
      if (!this.open() || this.phase !== 'idle') {
        return Promise.reject(new Error('runTurn is only accepted while idle'));
      }
      const completion = turnCompletion();
      this.closeUnfinished();
      const turn = createTurn(this.root, {
        id: this.durable.nextTurnId,
        trigger: 'normal',
        step: 0,
        pending: [{ kind: 'normal', entry }, ...this.mailbox.takeSide()],
        completion,
        ...(signal === undefined ? {} : { signal }),
      });
      if (signal !== undefined) {
        turn.onAbort = () => {
          if (this.turn !== turn || !this.open()) return;
          this.post({ type: 'abort.requested', turn, reason: signal.reason });
          this.kick();
        };
        signal.addEventListener('abort', turn.onAbort, { once: true });
      }
      this.record({ type: 'prompt.submitted', entry });
      this.activate(turn);
      this.kick();
      return completion.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  waitForIdle(): Promise<void> {
    if (
      this.phase !== 'running' &&
      !this.kicking &&
      !this.dispatching &&
      this.messages.length === 0 &&
      this.events.length === 0 &&
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

  private isCurrentStep(turn: LiveTurn, step: StepState, phase?: LiveTurn['phase']): boolean {
    return this.isCurrent(turn) && this.step === step && (phase === undefined || turn.phase === phase);
  }

  private announceTurn(turn: LiveTurn): void {
    if (turn.announced) return;
    turn.announced = true;
    if (turn.resumed === true) this.record({ type: 'turn.resumed', turnId: turn.id, step: turn.step });
    else this.record({ type: 'turn.started', turnId: turn.id, trigger: turn.trigger });
  }

  private report(
    point: HookPoint | ToolHookPoint,
    turn: LiveTurn,
    reports: readonly HookFailureReport[],
    notify: boolean,
  ): void {
    const entries: UserEntry[] = [];
    for (const { failure, entry } of reports) {
      this.record(hookFailedEvent(point, turn.id, turn.step, failure));
      this.record({ type: 'prompt.notified', entry });
      entries.push(entry);
      if (failure.paused && failure.hookId !== undefined) this.registry.suspend(failure.hookId);
    }
    if (notify && entries.length > 0) {
      this.mailbox.queue(entries);
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

  private requestAbort(turn: LiveTurn | undefined, reason: unknown): void {
    if (turn === undefined) {
      if (this.phase === 'idle') this.closeUnfinished();
      return;
    }
    if (!this.isCurrent(turn)) return;
    if (turn.outcome?.type === 'aborted') {
      if (turn.abortGrace !== undefined) clearTimeout(turn.abortGrace);
      this.post({ type: 'abort.expired', turn });
      return;
    }
    this.releaseTurn(turn, { type: 'aborted', reason });
    if (this.step !== undefined) this.step.outcome = { type: 'aborted', reason };
    turn.scope.abort(reason);
    for (const slot of this.tools.values()) {
      if (slot.turnId === turn.id && !slot.detached && !slot.done) slot.scope.abort(reason);
    }
    if (turn.phase === 'requesting' || turn.phase === 'acting') {
      turn.abortGrace = setTimeout(() => {
        this.post({ type: 'abort.expired', turn });
        this.kick();
      }, this.abortGraceMs);
      return;
    }
    this.post({ type: 'abort.expired', turn });
  }

  private expireAbort(turn: LiveTurn): void {
    if (!this.isCurrent(turn) || turn.outcome?.type !== 'aborted') return;
    const step = this.step;
    if (turn.phase === 'requesting' && step !== undefined) {
      this.completeRequest(turn, step, { type: 'aborted', message: null, usage: undefined, reason: undefined });
      return;
    }
    if (turn.phase === 'acting' || turn.phase === 'batching') {
      this.expireToolsAndFinish(turn);
      return;
    }
    this.post({ type: 'turn.finish', turn });
  }

  private fail(turn: LiveTurn, error: unknown): void {
    if (this.turn !== turn) return;
    turn.outcome = { type: 'failed', error };
    if (this.step !== undefined) this.step.outcome = { type: 'failed', error };
    this.finishTurn(turn);
  }

  private startTurn(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    if (turn.outcome?.type === 'aborted') {
      this.post({ type: 'turn.finish', turn });
      return;
    }
    if (turn.resumed === true) {
      this.announceTurn(turn);
      this.post({ type: 'turn.drain', turn });
      return;
    }
    this.complete(turn, this.turnStarting(turn), (run) => ({ type: 'turn.started', turn, run }));
  }

  private async turnStarting(turn: LiveTurn): Promise<TurnStartingRun> {
    try {
      return await runTurnStarting(
        this.registry,
        { turnId: turn.id, trigger: turn.trigger, pending: turn.pending },
        turn.scope.signal,
      );
    } catch (error) {
      return { failures: [runtimeFailure(error)] };
    }
  }

  private completeTurnStarting(turn: LiveTurn, run: TurnStartingRun): void {
    if (!this.isCurrent(turn)) return;
    const blocked = run.blocked;
    const reports = hookFailureReports('turn.starting', run.failures);
    turn.pending.push(...reports.map(({ entry }) => ({ kind: 'notify' as const, entry })));
    this.report('turn.starting', turn, reports, false);
    if (blocked !== undefined) {
      this.releaseTurn(turn, { type: 'blocked', at: 'turn.starting', cause: blocked });
      this.post({ type: 'turn.finish', turn });
    } else {
      this.announceTurn(turn);
      this.post({ type: 'turn.append', turn });
    }
  }

  private appendPending(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    turn.phase = 'appending';
    this.complete(turn, this.appendPendingItems(turn), (appended) => ({ type: 'turn.appended', turn, appended }));
  }

  private async appendPendingItems(turn: LiveTurn): Promise<AppendedItem[]> {
    const items = turn.pending;
    const appended: AppendedItem[] = [];
    try {
      for (const item of items) {
        const run = await runMessageAppending(
          this.registry,
          { turnId: turn.id, step: turn.step, item },
          turn.scope.signal,
        );
        appended.push({ source: item.kind, entry: run.entry, ...(run.blocked === undefined ? {} : { blocked: run.blocked }) });
        for (const failure of run.failures) {
          appended.push({ source: 'notify', entry: hookFailureEntry('message.appending', failure.error), failure });
        }
      }
    } catch (error) {
      appended.length = 0;
      appended.push(...items.map((item) => ({ source: item.kind, entry: item.entry })));
      appended.push({
        source: 'notify',
        entry: hookFailureEntry('message.appending', error),
        failure: runtimeFailure(error),
      });
    }
    return appended;
  }

  private completeAppending(turn: LiveTurn, appended: AppendedItem[]): void {
    if (!this.isCurrent(turn)) return;
    turn.pending = [];
    for (const item of appended) {
      if ('failure' in item) this.report('message.appending', turn, [{ failure: item.failure, entry: item.entry }], false);
      this.record({
        type: 'message.appended',
        turnId: turn.id,
        step: turn.step,
        source: item.source,
        entry: item.entry,
        ...('blocked' in item && item.blocked !== undefined ? { blocked: item.blocked } : {}),
      });
    }
    this.post({ type: 'step.start', turn });
  }

  private drain(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    if (turn.outcome?.type === 'aborted') {
      this.post({ type: 'turn.finish', turn });
      return;
    }
    turn.phase = 'draining';
    turn.pending = this.mailbox.takeSide();
    this.post({ type: turn.pending.length > 0 ? 'turn.append' : 'step.start', turn });
  }

  private startStep(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    if (turn.outcome?.type === 'aborted') {
      this.post({ type: 'turn.finish', turn });
      return;
    }
    const step: StepState = { calls: [], settled: {} };
    turn.step += 1;
    turn.phase = 'stepStarting';
    this.step = step;
    this.record({ type: 'step.started', turnId: turn.id, step: turn.step });
    this.post({ type: 'step.hooks', turn, step });
  }

  private startStepStarting(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'stepStarting')) return;
    this.complete(turn, this.stepStarting(turn), (run) => ({ type: 'step.started', turn, step, run }));
  }

  private async stepStarting(turn: LiveTurn): Promise<StepStartingRun> {
    try {
      return await runStepStarting(
        this.registry,
        {
          turnId: turn.id,
          step: turn.step,
          messages: this.durable.messages,
          profile: this.durable.profile,
        },
        turn.scope.signal,
      );
    } catch (error) {
      return { messages: this.durable.messages, failures: [runtimeFailure(error)] };
    }
  }

  private completeStepStarting(turn: LiveTurn, step: StepState, run: StepStartingRun): void {
    if (!this.isCurrentStep(turn, step, 'stepStarting')) return;
    const reports = hookFailureReports('step.starting', run.failures);
    if (run.rewrittenBy !== undefined) {
      this.record({ type: 'context.settled', messages: [...run.messages], reason: run.rewrittenBy });
    }
    this.report('step.starting', turn, reports, true);
    if (run.blocked !== undefined) {
      step.outcome = { type: 'blocked', at: 'step.starting', cause: run.blocked };
      turn.outcome = step.outcome;
    } else {
      turn.phase = 'requesting';
    }
    this.post({ type: 'step.after_starting', turn, step });
  }

  private afterStepStarting(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step)) return;
    this.post({ type: step.outcome?.type === 'blocked' ? 'step.finish' : 'request.start', turn, step });
  }

  private startRequest(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    const outcome = runLoopRequest(
      () => this.requesterForStep(),
      {
        messages: [...this.durable.messages],
        profile: this.durable.profile,
        signal: turn.scope.signal,
      },
      (event) => {
        this.post({ type: 'llm.progress', turn, step, event });
        this.kick();
      },
    );
    this.complete(turn, outcome, (result) => ({ type: 'llm.completed', turn, step, outcome: result }));
  }

  private requestProgress(turn: LiveTurn, step: StepState, event: LoopRequestProgress): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    if (event.type === 'llm.prepared') step.model = event.model;
    else this.record(event);
  }

  private completeRequest(turn: LiveTurn, step: StepState, outcome: LlmOutcome): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    step.llm = outcome;
    const toolCalls = outcome.type === 'done' ? outcome.message.toolCalls : [];
    step.calls.push(
      ...toolCalls.map((toolCall, index) => ({ key: `${turn.id}:${turn.step}:${index}`, toolCall })),
    );
    this.record({ type: 'llm.ended', outcome });
    const entry = assistantEntryOf(outcome, step.model);
    if (entry !== undefined) {
      this.record({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'llm', entry });
    }
    if (toolCalls.length > 0) {
      turn.phase = 'batching';
      this.post({ type: 'batch.start', turn, step });
    } else {
      if (turn.outcome?.type !== 'aborted') turn.phase = 'ending';
      this.post({ type: turn.outcome?.type === 'aborted' ? 'step.finish' : 'step.ending', turn, step });
    }
  }

  private startBatch(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'batching')) return;
    if (turn.outcome?.type === 'aborted') {
      this.post({ type: 'tools.start', turn, step });
      return;
    }
    this.complete(turn, this.batchStarting(turn, step), (run) => ({ type: 'batch.started', turn, step, run }));
  }

  private async batchStarting(turn: LiveTurn, step: StepState): Promise<ToolBatchStartingRun> {
    try {
      return await runToolBatchStarting(
        this.registry,
        {
          turnId: turn.id,
          step: turn.step,
          toolCalls: step.calls.map((call) => call.toolCall),
        },
        turn.scope.signal,
      );
    } catch (error) {
      return { failures: [runtimeFailure(error)] };
    }
  }

  private completeBatchStarting(turn: LiveTurn, step: StepState, run: ToolBatchStartingRun): void {
    if (!this.isCurrentStep(turn, step, 'batching')) return;
    const reports = hookFailureReports('tool.batch-starting', run.failures);
    if (run.blocked !== undefined) {
      const blocked = run.blocked;
      for (const { key, toolCall } of step.calls) {
        const outcome = blockedToolOutcome(toolCall, blocked.cause, blocked.result);
        this.record({ type: 'tool.started', turnId: turn.id, step: turn.step, toolCall });
        this.record({ type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
        step.settled[key] = outcome.entry;
      }
    }
    this.report('tool.batch-starting', turn, reports, true);
    turn.phase = 'acting';
    this.post({ type: 'tools.start', turn, step });
  }

  private startActing(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'acting')) return;
    const slots: LiveTool[] = [];
    if (turn.outcome?.type === 'aborted') {
      this.expireTools(turn, step, turn.outcome.reason);
    } else {
      for (const call of step.calls) {
        if (step.settled[call.key] !== undefined) continue;
        const slot: LiveTool = {
          key: call.key,
          toolCall: call.toolCall,
          turnId: turn.id,
          step: turn.step,
          scope: withAbort(this.root.signal),
          detached: false,
          announced: false,
          done: false,
          waiters: new Set(),
        };
        this.tools.set(call.key, slot);
        slots.push(slot);
        if (!this.adjudicates) {
          slot.announced = true;
          this.record({ type: 'tool.started', turnId: turn.id, step: turn.step, toolCall: slot.toolCall });
        }
      }
    }
    this.post({ type: 'tools.execute', turn, step, slots });
  }

  private executeTools(turn: LiveTurn, step: StepState, slots: LiveTool[]): void {
    if (!this.isCurrentStep(turn, step, 'acting')) return;
    for (const slot of slots) {
      if (!slot.done) this.executeTool(slot);
    }
    if (allSettled(step)) this.post({ type: 'acting.complete', turn, step });
  }

  private executeTool(slot: LiveTool): void {
    const output = executeLoopTool(this.executor, {
      toolCall: slot.toolCall,
      signal: slot.scope.signal,
      turnId: slot.turnId,
      step: slot.step,
      onAdjudicated: (toolCall) => {
        this.post({ type: 'tool.adjudicated', slot, toolCall });
        this.kick();
      },
      onHookFailure: (point: ToolHookPoint, failure: ToolHookFailure) => {
        this.post({ type: 'tool.hook_failed', slot, point, failure });
        this.kick();
      },
      onUpdate: (update) => {
        this.post({ type: 'tool.updated', slot, update });
        this.kick();
      },
      detach: (text) => {
        this.post({ type: 'tool.detach', slot, text });
        this.kick();
      },
    });
    void output.then(
      (result) => {
        this.post({ type: 'tool.completed', slot, output: result });
        this.kick();
      },
      (error: unknown) => {
        this.post({ type: 'tool.completed', slot, output: { type: 'failed', error } });
        this.kick();
      },
    );
  }

  private adjudicateTool(slot: LiveTool, toolCall: LiveTool['toolCall']): void {
    if (slot.done || this.tools.get(slot.key) !== slot) return;
    slot.toolCall = toolCall;
    if (!slot.announced) {
      slot.announced = true;
      this.record({ type: 'tool.started', turnId: slot.turnId, step: slot.step, toolCall });
    }
  }

  private failToolHook(slot: LiveTool, point: ToolHookPoint, failure: ToolHookFailure): void {
    if (slot.done || this.tools.get(slot.key) !== slot) return;
    this.record(hookFailedEvent(point, slot.turnId, slot.step, failure));
    if (failure.paused && failure.hookId !== undefined) this.registry.suspend(failure.hookId);
  }

  private updateTool(slot: LiveTool, update: Extract<ActorMessage, { type: 'tool.updated' }>['update']): void {
    if (slot.done || slot.detached || this.tools.get(slot.key) !== slot) return;
    this.record({ type: 'tool.delta', toolCallId: slot.toolCall.id, update });
  }

  private detach(slot: LiveTool, text?: string): void {
    if (slot.done || slot.detached || this.tools.get(slot.key) !== slot) return;
    slot.detached = true;
    const outcome = {
      type: 'succeeded' as const,
      entry: toolEntry(
        slot.toolCall,
        {
          content: [
            {
              type: 'text' as const,
              text: text === undefined || text === '' ? `async running: ${slot.toolCall.name}` : text,
            },
          ],
        },
        true,
      ),
    };
    this.record({ type: 'tool.ended', toolCallId: slot.toolCall.id, outcome, detached: true });
    const turn = this.turn;
    const step = this.step;
    if (turn?.id === slot.turnId && turn.step === slot.step && step !== undefined) {
      settle(step, slot.key, outcome);
      if (allSettled(step)) this.post({ type: 'acting.complete', turn, step });
    }
  }

  private completeTool(slot: LiveTool, output: ToolExecOutput): void {
    if (slot.done) return;
    slot.done = true;
    if (output.type === 'succeeded') {
      slot.status = 'succeeded';
      slot.result = output.result;
    } else if (output.type === 'aborted') {
      slot.status = 'aborted';
      slot.reason = output.reason;
      slot.result = errorResult('aborted');
    } else {
      slot.status = 'failed';
      slot.error = output.error;
      slot.result = output.result ?? errorResult(errorText(output.error));
    }
    this.tools.delete(slot.key);
    this.notifyTool(slot);
    if (slot.detached) {
      const outcome = asyncOutcomeOf(slot);
      const entry = completionEntry(slot.toolCall, outcome, slot.result);
      this.record({ type: 'tool.async_ended', toolCallId: slot.toolCall.id, outcome, entry });
      this.record({ type: 'prompt.notified', entry });
      this.mailbox.queue([entry]);
      this.held = false;
      this.schedule();
      return;
    }
    const turn = this.turn;
    const step = this.step;
    if (turn?.id !== slot.turnId || turn.step !== slot.step || step === undefined) return;
    const outcome = toolOutcomeOf(slot);
    this.record({ type: 'tool.ended', toolCallId: slot.toolCall.id, outcome, detached: false });
    settle(step, slot.key, outcome);
    if (allSettled(step)) this.post({ type: 'acting.complete', turn, step });
  }

  private notifyTool(slot: LiveTool): void {
    for (const notify of Array.from(slot.waiters)) notify();
  }

  private abortToolCall(toolCallId: string, reason: unknown): void {
    for (const slot of this.tools.values()) {
      if (slot.toolCall.id === toolCallId && !slot.done) slot.scope.abort(reason);
    }
  }

  private expireTools(turn: LiveTurn, step: StepState, reason: unknown): void {
    for (const call of step.calls) {
      if (step.settled[call.key] !== undefined) continue;
      const slot = this.tools.get(call.key);
      const toolCall = slot?.toolCall ?? call.toolCall;
      if (slot === undefined || !slot.announced) {
        this.record({ type: 'tool.started', turnId: turn.id, step: turn.step, toolCall });
      }
      if (slot !== undefined) {
        slot.done = true;
        this.tools.delete(call.key);
        this.notifyTool(slot);
      }
      const outcome = abortedToolOutcome(toolCall, reason);
      this.record({ type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
      settle(step, call.key, outcome);
    }
  }

  private appendToolEntries(turn: LiveTurn, step: StepState): void {
    const entries = step.calls.flatMap((call) => step.settled[call.key] ?? []);
    for (const entry of entries) {
      this.record({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'tool', entry });
    }
  }

  private expireToolsAndFinish(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    const step = this.step;
    if (step === undefined) {
      this.post({ type: 'turn.finish', turn });
      return;
    }
    this.expireTools(turn, step, turn.outcome?.type === 'aborted' ? turn.outcome.reason : undefined);
    this.appendToolEntries(turn, step);
    this.finalizeStep(turn, step);
    this.post({ type: 'turn.finish', turn });
  }

  private completeActing(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'acting') || !allSettled(step)) return;
    this.appendToolEntries(turn, step);
    if (turn.outcome?.type === 'aborted') {
      this.finalizeStep(turn, step);
      this.post({ type: 'turn.finish', turn });
    } else {
      turn.phase = 'ending';
      this.post({ type: 'step.ending', turn, step });
    }
  }

  private startStepEnding(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'ending')) return;
    this.complete(turn, this.stepEnding(turn, step), (run) => ({ type: 'step.ended', turn, step, run }));
  }

  private async stepEnding(turn: LiveTurn, step: StepState): Promise<StepEndingRun> {
    const draft = draftOutcome(step);
    try {
      const input: StepEndingInput = {
        turnId: turn.id,
        step: turn.step,
        draft,
        messages: this.durable.messages,
      };
      return await runStepEndingHooks(this.registry, input, turn.scope.signal);
    } catch (error) {
      return {
        outcome: draft,
        failures: [{ point: draft.type === 'continue' ? 'step.continuing' : 'step.stopping', failure: runtimeFailure(error) }],
      };
    }
  }

  private completeStepEnding(turn: LiveTurn, step: StepState, run: StepEndingRun): void {
    if (!this.isCurrentStep(turn, step, 'ending')) return;
    step.outcome = run.outcome;
    if (run.outcome.type !== 'continue') turn.outcome = run.outcome;
    for (const { point, failure } of run.failures) {
      this.report(point, turn, hookFailureReports(point, [failure]), true);
    }
    this.post({ type: 'step.finish', turn, step });
  }

  private finishStep(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step)) return;
    this.finalizeStep(turn, step);
    this.post({ type: 'step.finished', turn, step });
  }

  private afterStepFinished(turn: LiveTurn): void {
    if (this.turn !== turn || this.step !== undefined) return;
    if (turn.outcome?.type === 'aborted' || turn.phase === 'finished') this.post({ type: 'turn.finish', turn });
    else this.post({ type: 'turn.drain', turn });
  }

  private finalizeStep(turn: LiveTurn, step: StepState): void {
    const outcome = step.outcome ?? { type: 'aborted' as const };
    this.record({ type: 'step.ended', turnId: turn.id, step: turn.step, outcome });
    this.step = undefined;
    if (outcome.type === 'continue') {
      turn.phase = 'draining';
      return;
    }
    turn.outcome = outcome;
    turn.phase = 'finished';
  }

  private finishTurn(turn: LiveTurn): void {
    if (this.turn !== turn) return;
    if (turn.abortGrace !== undefined) clearTimeout(turn.abortGrace);
    this.announceTurn(turn);
    if (this.step !== undefined) this.finalizeStep(turn, this.step);
    for (const [key, slot] of this.tools) {
      if (slot.turnId !== turn.id || slot.detached) continue;
      slot.done = true;
      this.tools.delete(key);
      this.notifyTool(slot);
    }
    const outcome = turn.outcome ?? { type: 'aborted' as const };
    turn.outcome = outcome;
    turn.phase = 'finished';
    this.record({ type: 'turn.ended', turnId: turn.id, outcome });
    this.turn = undefined;
    this.phase = this.phase === 'closed' ? 'closed' : 'idle';
    this.completedTurns.push(turn);
    this.schedule();
  }

  private settleUnfinished(outcome: StepOutcome): void {
    const unfinished = this.durable.unfinished;
    if (unfinished === undefined) return;
    const { turnId, step } = unfinished;
    for (const toolCall of trailingCalls(this.durable.messages).unresolved) {
      const result = abortedToolOutcome(toolCall, CRASHED);
      this.record({ type: 'tool.ended', toolCallId: toolCall.id, outcome: result, detached: false });
      this.record({ type: 'message.appended', turnId, step, source: 'tool', entry: result.entry });
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

  private continueTurn(): void {
    if (this.phase !== 'idle') return;
    const unfinished = this.durable.unfinished;
    if (unfinished !== undefined && isResumable(this.durable)) {
      this.settleUnfinished({ type: 'continue', cause: CRASHED });
      this.activate(createTurn(this.root, {
        id: unfinished.turnId,
        trigger: unfinished.trigger,
        step: unfinished.step,
        pending: [],
        resumed: true,
      }));
      return;
    }
    this.closeUnfinished();
    if (!this.mailbox.hasTrigger && canContinue(this.durable.messages)) {
      this.activate(createTurn(this.root, {
        id: this.durable.nextTurnId,
        trigger: 'continue',
        step: 0,
        pending: [],
      }));
      return;
    }
    this.held = false;
    this.schedule();
  }

  private closeRuntime(): void {
    if (this.phase !== 'closed') {
      this.phase = 'closed';
      const turn = this.turn;
      if (turn !== undefined) this.closeTurn(turn);
      this.closeDetached();
      this.root.abort();
    }
  }

  private closeTurn(turn: LiveTurn): void {
    const reason = turn.outcome?.type === 'aborted' ? turn.outcome.reason : CLOSED;
    if (turn.outcome?.type !== 'aborted') this.releaseTurn(turn, { type: 'aborted', reason: CLOSED });
    const step = this.step;
    if (step !== undefined && step.outcome?.type !== 'aborted') step.outcome = { type: 'aborted', reason };
    turn.scope.abort(reason);
    if (turn.phase === 'requesting' && step !== undefined) {
      const outcome: LlmOutcome = { type: 'aborted', message: null, usage: undefined, reason: undefined };
      step.llm = outcome;
      this.record({ type: 'llm.ended', outcome });
      const entry = assistantEntryOf(outcome, step.model);
      if (entry !== undefined) {
        this.record({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'llm', entry });
      }
      this.finalizeStep(turn, step);
    } else if ((turn.phase === 'batching' || turn.phase === 'acting') && step !== undefined) {
      this.expireTools(turn, step, reason);
      this.appendToolEntries(turn, step);
      this.finalizeStep(turn, step);
    } else if (step !== undefined) {
      this.finalizeStep(turn, step);
    }
    this.finishTurn(turn);
  }

  private closeDetached(): void {
    for (const [key, slot] of this.tools) {
      if (!slot.detached) continue;
      slot.done = true;
      this.tools.delete(key);
      const outcome = { type: 'aborted' as const, reason: CLOSED };
      this.record({
        type: 'tool.async_ended',
        toolCallId: slot.toolCall.id,
        outcome,
        entry: completionEntry(slot.toolCall, outcome),
      });
      this.notifyTool(slot);
    }
  }
}

export function createActorLoop(options: CreateLoopOptions): Loop {
  return new LoopActor(options);
}
