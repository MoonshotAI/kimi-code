import type { HistoryMessage, UserEntry } from '#human/agent/turn';
import type { ToolDescription } from '#human/llm/message';
import type { LlmOutcome } from '#human/llm/response';
import { createPolicyRegistry, type PolicyRegistry } from '#human/llm/policy/registry';
import { isToolDetachAck, type ToolExecutionResponse, type ToolResult } from '#/tool/executor';
import { createAbortScope, withAbort, type AbortScope } from '#human/utils/abort';
import { waitEvent, type WaitOpts } from '#human/utils/wait';
import type { CreateLoopOptions, Loop, LoopToolContext, LoopToolExecutor } from './create-loop';
import type { LoopCommand, LoopInput, UnfinishedTurn } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { HookLifecycleEvent, HookPoint } from './contract/hook';
import type { Inbox, QueuedItem, RemindEntry } from './contract/inbox';
import { CLOSED, CRASHED, STEERED, type AsyncToolOutcome, type StepOutcome, type TurnOutcome } from './contract/outcome';
import type { LoopProfile } from './contract/profile';
import { isEntry, isObject } from './guards';
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
import {
  createMediaRecoveryStore,
  runLoopRequest,
  type LoopLlmRequester,
  type LoopRequestProgress,
  type LoopRequestRuntime,
  type TurnExecution,
  type TurnExecutionFactory,
} from './request';
import { loopProjection, type LoopRecord, type LoopRecordState } from './record';
import {
  allSettled,
  assistantEntryOf,
  canContinue,
  createTurn,
  draftOutcome,
  isResumable,
  normalizeUserEntry,
  settle,
  trailingCalls,
  type AppendedItem,
  type LiveTool,
  type LiveTurn,
  type LoopState,
  type StepState,
  type TurnCompletion,
} from './state';
import {
  abortedToolOutcome,
  blockedToolOutcome,
  completionEntry,
  resolveCompletionEntry,
  toolEntry,
  type ToolCompletionFactory,
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
  const result = slot.result!;
  const outcome = result.outcome;
  const entry = toolEntry(slot.toolCall, result);
  switch (outcome.type) {
    case 'success':
      return { type: 'succeeded' as const, entry };
    case 'aborted':
      return { type: 'aborted' as const, entry, reason: outcome.error.data ?? outcome.error.reason };
    default:
      return { type: 'failed' as const, entry, error: outcome.error };
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

  get hasNotify(): boolean {
    return this.notifyEntries.length > 0;
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

  remind(entries: readonly RemindEntry[]): LoopAck<'prompt.reminded'> | undefined {
    this.reminders.push(...entries);
    let ack: LoopAck<'prompt.reminded'> | undefined;
    for (const entry of entries) {
      ack = { type: 'prompt.reminded', entry };
      this.emit(ack);
    }
    return ack;
  }

  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> {
    const entries = this.normal.filter(
      (entry) => entry.meta?.promptId !== undefined && promptIds.includes(entry.meta.promptId),
    );
    const ids = entries.map((entry) => entry.meta?.promptId as string);
    if (entries.length === 0) {
      const ack: LoopAck<'prompt.steered'> = { type: 'prompt.steered', promptIds: ids };
      this.emit(ack);
      return ack;
    }
    this.normal = this.normal.filter((item) => !entries.includes(item));
    this.notifyEntries.push(...entries);
    const ack: LoopAck<'prompt.steered'> = { type: 'prompt.steered', promptIds: ids, entries };
    this.emit(ack);
    return ack;
  }

  cancel(promptId: string): LoopAck<'prompt.canceled'> {
    const normal = this.normal.filter((entry) => entry.meta?.promptId !== promptId);
    const notify = this.notifyEntries.filter((entry) => entry.meta?.promptId !== promptId);
    const canceled = normal.length !== this.normal.length || notify.length !== this.notifyEntries.length;
    this.normal = normal;
    this.notifyEntries = notify;
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
    const normalHead = this.normal[0];
    const head = normalHead ?? this.notifyEntries[0];
    if (head === undefined) return undefined;
    const kind = normalHead === undefined ? 'notify' as const : 'normal' as const;
    const remainingNotify = normalHead === undefined ? this.notifyEntries.slice(1) : this.notifyEntries;
    const promptOnly = remainingNotify.length > 0;
    this.normal = normalHead === undefined ? this.normal : this.normal.slice(1);
    this.notifyEntries = remainingNotify;
    const reminders = promptOnly ? [] : this.drainReminders();
    return {
      kind,
      pending: [
        { kind, entry: head },
        ...reminders.map((entry) => ({ kind: 'remind' as const, entry })),
      ],
      promptOnly,
    };
  }

  drainReminders(): RemindEntry[] {
    const entries = this.reminders;
    this.reminders = [];
    return entries;
  }

  clearReminders(): void {
    this.reminders = [];
  }
}

type ActorMessage =
  | { readonly type: 'turn.start'; readonly turn: LiveTurn }
  | { readonly type: 'turn.started'; readonly turn: LiveTurn; readonly run: TurnStartingRun }
  | { readonly type: 'turn.append'; readonly turn: LiveTurn }
  | { readonly type: 'turn.appended'; readonly turn: LiveTurn; readonly appended: AppendedItem[] }
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
  | { readonly type: 'request.prepare'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'request.prepared'; readonly turn: LiveTurn; readonly step: StepState; readonly profile: LoopProfile }
  | { readonly type: 'request.prepare_failed'; readonly turn: LiveTurn; readonly step: StepState; readonly error: unknown }
  | { readonly type: 'request.start'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'llm.progress'; readonly turn: LiveTurn; readonly step: StepState; readonly event: LoopRequestProgress }
  | { readonly type: 'llm.completed'; readonly turn: LiveTurn; readonly step: StepState; readonly outcome: LlmOutcome }
  | { readonly type: 'batch.start'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'batch.started'; readonly turn: LiveTurn; readonly step: StepState; readonly run: ToolBatchStartingRun }
  | { readonly type: 'tools.start'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'tools.execute'; readonly turn: LiveTurn; readonly step: StepState; readonly slots: LiveTool[] }
  | { readonly type: 'tool.prepared'; readonly slot: LiveTool }
  | { readonly type: 'tool.responded'; readonly slot: LiveTool; readonly response: ToolExecutionResponse }
  | { readonly type: 'tool.failed'; readonly slot: LiveTool; readonly error: unknown }
  | { readonly type: 'tool.completed'; readonly slot: LiveTool; readonly result: ToolResult }
  | { readonly type: 'tool.detached_completed'; readonly slot: LiveTool; readonly outcome: AsyncToolOutcome; readonly entry: UserEntry }
  | { readonly type: 'tool.detached_rejected'; readonly slot: LiveTool; readonly outcome: AsyncToolOutcome; readonly entry: UserEntry }
  | { readonly type: 'tool.abort'; readonly toolCallId: string; readonly reason?: unknown }
  | { readonly type: 'acting.complete'; readonly turn: LiveTurn; readonly step: StepState }
  | { readonly type: 'abort.requested'; readonly turn?: LiveTurn; readonly reason?: unknown; readonly continueAfterAbort: boolean }
  | { readonly type: 'abort.expired'; readonly turn: LiveTurn }
  | { readonly type: 'continue'; readonly force: boolean }
  | { readonly type: 'close' }
  | {
    readonly type: 'close.detached';
    readonly entries: readonly { readonly slot: LiveTool; readonly outcome: AsyncToolOutcome; readonly entry: UserEntry }[];
  }
  | { readonly type: 'close.failed'; readonly error: unknown };

class LoopActor implements Loop {
  readonly executor: LoopToolExecutor;
  readonly hooks: HookRegistry;
  readonly policy: PolicyRegistry;
  readonly waitForTasks: WaitForTasks;

  private readonly registry: ReturnType<typeof createHookRegistry>;
  private readonly root: AbortScope = createAbortScope();
  private readonly projection = loopProjection();
  private mailbox: LoopMailbox;
  private readonly listeners = new Set<(event: LoopEmitted) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly messages: ActorMessage[] = [];
  private readonly events: LoopEmitted[] = [];
  private readonly completedTurns: LiveTurn[] = [];
  private readonly toolContext?: CreateLoopOptions['toolContext'];
  private readonly completionFactory?: CreateLoopOptions['completionEntry'];
  private readonly abortGraceMs: number;
  private readonly onListenerError?: CreateLoopOptions['onListenerError'];
  private phase: 'idle' | 'running' | 'closed' = 'idle';
  private held = true;
  private durable: LoopRecordState;
  private turn: LiveTurn | undefined;
  private step: StepState | undefined;
  private readonly tools = new Map<string, LiveTool>();
  private factory: TurnExecutionFactory | undefined;
  private execution: TurnExecution | undefined;
  private executionError: unknown;
  private revision = 0;
  private seq = 0;
  private readonly mediaRecovery = createMediaRecoveryStore();
  private kicking = false;
  private dispatching = false;
  private resetting = false;
  private closePending = false;
  private closeCompletion?: Deferred<void>;
  private completionContinuation?: () => void;
  private completionHandoff = false;

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
    this.factory = options.createTurnExecution;
    this.executor = options.executor;
    this.toolContext = options.toolContext;
    this.completionFactory = options.completionEntry;
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
      bypassMaxSteps: false,
    });
    return {
      status: this.phase === 'running' ? 'running' : unfinished !== undefined ? 'interrupted' : 'idle',
      held: this.held,
      resetting: this.resetting,
      inbox: this.mailbox.snapshot,
      profile,
      messages,
      nextTurnId,
      completionPending: this.hasPendingCompletions,
      ...(current === undefined ? {} : { turn: { id: current.id, trigger: current.trigger, step: current.step, bypassMaxSteps: current.bypassMaxSteps } }),
      calls: Array.from(this.tools.values(), (slot) => ({
        toolCall: slot.toolCall,
        turnId: slot.turnId,
        detached: slot.detached,
      })),
    };
  }

  get turnExecution(): TurnExecution | undefined {
    return this.execution;
  }

  get historyRevision(): number {
    return this.revision;
  }

  operation<T>(create: (runtime: LoopRequestRuntime) => T): T {
    return create({
      historyRevision: () => this.revision,
      mediaRecovery: this.mediaRecovery,
    });
  }

  private open(): boolean {
    return this.phase !== 'closed';
  }

  private createExecution(turn: LiveTurn): TurnExecution {
    const factory = this.factory;
    if (factory === undefined) throw new Error('loop has no requester');
    const profile = this.durable.profile;
    return factory({
      turnId: turn.id,
      profile: {
        ...profile,
        tools: profile.tools === undefined ? undefined : [...profile.tools],
      },
      step: () => turn.step,
      historyRevision: () => this.revision,
      mediaRecovery: this.mediaRecovery,
    });
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
    if (event.type === 'context.settled') this.revision += 1;
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
    if (this.resetting || this.phase === 'running' || this.messages.length > 0 || this.events.length > 0 || this.hasPendingCompletions || this.canSchedule()) return;
    const waiters = Array.from(this.idleWaiters);
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
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

  private canSchedule(): boolean {
    return !this.resetting && this.phase === 'idle' && !this.held && !this.hasPendingCompletions && this.mailbox.hasTrigger;
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
      bypassMaxSteps: next.pending.some((item) => item.kind !== 'remind' && item.entry.meta?.bypassMaxSteps === true),
      promptOnly: next.promptOnly ? true : undefined,
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
    if (!this.resetting) this.held = false;
    if (!this.kicking && !this.dispatching) this.schedule();
  }

  private abortRequest(): void {
    const turn = this.turn;
    const step = this.step;
    if (turn === undefined || step === undefined || turn.outcome?.type === 'aborted') return;
    if ((turn.phase !== 'stepStarting' && turn.phase !== 'requesting') || step.toolCallStreaming) return;
    step.steerRequested = true;
    step.scope.abort(STEERED);
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
        this.afterStepFinished(message.turn, message.step);
        return;
      case 'request.prepare':
        this.prepareRequest(message.turn, message.step);
        return;
      case 'request.prepared':
        this.completeRequestPreparation(message.turn, message.step, message.profile);
        return;
      case 'request.prepare_failed':
        this.failRequestPreparation(message.turn, message.step, message.error);
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
        this.completeDetached(message.slot, message.outcome, message.entry);
        return;
      case 'tool.detached_rejected':
        if (this.phase !== 'closed') this.completeDetached(message.slot, message.outcome, message.entry);
        return;
      case 'tool.abort':
        this.abortToolCall(message.toolCallId, message.reason);
        return;
      case 'acting.complete':
        this.completeActing(message.turn, message.step);
        return;
      case 'abort.requested':
        this.requestAbort(message.turn ?? this.turn, message.reason, message.continueAfterAbort);
        return;
      case 'abort.expired':
        this.expireAbort(message.turn);
        return;
      case 'continue':
        this.continueTurn(message.force);
        return;
      case 'close':
        this.closeRuntime();
        return;
      case 'close.detached':
        this.completeDetachedClose(message.entries);
        return;
      case 'close.failed':
        this.failClose(message.error);
    }
  }

  private hookChanged(event: HookLifecycleEvent): void {
    if (!this.open()) return;
    this.record(event);
    this.kick();
  }

  submit(entry: UserEntry): LoopAck<'prompt.submitted'> | undefined {
    const normalized = normalizeUserEntry(entry);
    this.check({ type: 'input.submit', entry: normalized });
    if (!this.open()) return undefined;
    const ack = this.mailbox.submit(normalized);
    this.releaseIntake();
    this.kick();
    return ack;
  }

  notify(entry: UserEntry): LoopAck<'prompt.notified'> | undefined {
    const normalized = normalizeUserEntry(entry);
    this.check({ type: 'input.notify', entry: normalized });
    if (!this.open()) return undefined;
    const ack = this.mailbox.notify(normalized);
    this.releaseIntake();
    this.kick();
    return ack;
  }

  remind(...entries: readonly RemindEntry[]): LoopAck<'prompt.reminded'> | undefined {
    for (const entry of entries) this.check({ type: 'input.remind', entry });
    if (!this.open() || entries.length === 0) return undefined;
    const ack = this.mailbox.remind(entries);
    this.kick();
    return ack;
  }

  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined {
    this.check({ type: 'input.steer', promptIds });
    if (!this.open()) return undefined;
    const ack = this.mailbox.steer(promptIds);
    if ((ack.entries?.length ?? 0) > 0) {
      this.releaseIntake();
      if (this.turn?.phase === 'requesting') this.abortRequest();
    }
    this.kick();
    return ack;
  }

  sendNow(entry: UserEntry): LoopAck<'prompt.notified'> | undefined;
  sendNow(promptIds: readonly string[]): void;
  sendNow(input: UserEntry | readonly string[]): LoopAck<'prompt.notified'> | undefined | void {
    const entry = Array.isArray(input) ? undefined : input as UserEntry;
    if (entry !== undefined) {
      const normalized = normalizeUserEntry(entry);
      this.check({ type: 'input.notify', entry: normalized });
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
    const normal = new Set(inbox.normal.map((item) => item.meta?.promptId));
    const notify = new Set(inbox.notify.map((item) => item.meta?.promptId));
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
      this.step = undefined;
      this.execution = undefined;
      this.executionError = undefined;
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
    this.factory = requester === undefined
      ? undefined
      : ({ profile }) => ({ profile, requester });
  }

  setContext(messages: HistoryMessage[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined {
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
    if (this.phase === 'running') return this.turn?.phase === 'ending' || this.turn?.phase === 'stepStarting';
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
        pending: [
          { kind: 'normal', entry },
          ...this.mailbox.drainReminders().map((reminder) => ({ kind: 'remind' as const, entry: reminder })),
        ],
        bypassMaxSteps: entry.meta?.bypassMaxSteps === true,
        completion,
        ...(signal === undefined ? {} : { signal }),
      });
      if (signal !== undefined) {
        turn.onAbort = () => {
          if (this.turn !== turn || !this.open()) return;
          this.post({ type: 'abort.requested', turn, reason: signal.reason, continueAfterAbort: false });
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

  private isCurrentStep(turn: LiveTurn, step: StepState, phase?: LiveTurn['phase']): boolean {
    return this.isCurrent(turn) && this.step === step && (phase === undefined || turn.phase === phase);
  }

  private announceTurn(turn: LiveTurn): void {
    if (turn.announced) return;
    turn.announced = true;
    if (turn.resumed === true) this.record({ type: 'turn.resumed', turnId: turn.id, step: turn.step });
    else this.record({
      type: 'turn.started',
      turnId: turn.id,
      trigger: turn.trigger,
      promptOnly: turn.promptOnly,
      entry: turn.pending.find((item): item is Extract<QueuedItem, { kind: 'normal' | 'notify' }> => item.kind !== 'remind')?.entry,
    });
  }

  private report(
    point: HookPoint,
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
    if (notify) {
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

  private settleBlockedTurn(
    turn: LiveTurn,
    outcome: Extract<TurnOutcome, { type: 'blocked' }>,
  ): void {
    const pending = turn.pending;
    turn.pending = [];
    turn.outcome = outcome;
    this.mailbox.restore(pending.filter((item) => item.kind === 'notify'));
    const reminders = [
      ...pending.flatMap((item) => item.kind === 'remind' ? [item.entry] : []),
      ...this.mailbox.drainReminders(),
    ];
    this.held = true;
    this.announceTurn(turn);
    for (const item of pending) {
      if (item.kind === 'normal') {
        this.record({ type: 'message.appended', turnId: turn.id, step: 0, source: 'normal', entry: item.entry });
      }
    }
    for (const entry of reminders) {
      this.record({ type: 'message.appended', turnId: turn.id, step: 0, source: 'remind', entry });
    }
  }

  private requestAbort(turn: LiveTurn | undefined, reason: unknown, continueAfterAbort: boolean): void {
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
    turn.continueAfterAbort = continueAfterAbort || turn.continueAfterAbort === true;
    this.releaseTurn(turn, { type: 'aborted', reason });
    if (this.step !== undefined) this.step.outcome = { type: 'aborted', reason };
    turn.scope.abort(reason);
    for (const slot of this.tools.values()) {
      if (slot.turnId === turn.id && slot.step === turn.step && !slot.detached && !slot.done) {
        void slot.handler.stop(reason);
      }
    }
    if (turn.phase === 'requesting') {
      turn.abortGrace = setTimeout(() => {
        this.post({ type: 'abort.expired', turn });
        this.kick();
      }, this.abortGraceMs);
      return;
    }
    if (turn.phase === 'acting') {
      if (this.step !== undefined) {
        this.settleUnstartedTools(turn, this.step, reason);
        if (allSettled(this.step)) this.post({ type: 'acting.complete', turn, step: this.step });
      }
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
      this.settleToolsAndFinish(turn);
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
    try {
      this.execution = this.createExecution(turn);
      this.executionError = undefined;
    } catch (error) {
      this.execution = undefined;
      this.executionError = error;
    }
    if (turn.resumed === true) {
      this.announceTurn(turn);
      if (this.mailbox.hasNotify) turn.outcome = { type: 'done', cause: { by: 'loop', reason: 'notify' } };
      this.post({ type: turn.outcome?.type === 'done' ? 'turn.finish' : 'step.start', turn });
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
      this.settleBlockedTurn(turn, { type: 'blocked', at: 'turn.starting', cause: blocked });
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

  private startStep(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    if (turn.outcome?.type === 'aborted') {
      this.post({ type: 'turn.finish', turn });
      return;
    }
    const step: StepState = {
      scope: withAbort(turn.scope.signal),
      steerRequested: false,
      toolCallStreaming: false,
      calls: [],
      settled: {},
    };
    turn.step += 1;
    turn.phase = 'stepStarting';
    this.step = step;
    if (turn.promptOnly !== true) this.record({ type: 'step.started', turnId: turn.id, step: turn.step });
    this.post({ type: 'step.hooks', turn, step });
  }

  private startStepStarting(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'stepStarting')) return;
    if (this.finishSteeredStep(turn, step)) return;
    this.complete(turn, this.stepStarting(turn, step), (run) => ({ type: 'step.started', turn, step, run }));
  }

  private async stepStarting(turn: LiveTurn, step: StepState): Promise<StepStartingRun> {
    try {
      return await runStepStarting(
        this.registry,
        {
          turnId: turn.id,
          step: turn.step,
          messages: this.durable.messages,
          profile: this.durable.profile,
        },
        step.scope.signal,
      );
    } catch (error) {
      return { messages: this.durable.messages, failures: [runtimeFailure(error)] };
    }
  }

  private finishSteeredStep(turn: LiveTurn, step: StepState): boolean {
    if (!step.steerRequested || turn.outcome?.type === 'aborted') return false;
    step.outcome = { type: 'done', cause: STEERED };
    if (turn.promptOnly !== true) {
      this.record({ type: 'step.ended', turnId: turn.id, step: turn.step, outcome: step.outcome });
    }
    this.step = undefined;
    turn.outcome = step.outcome;
    turn.phase = 'finished';
    this.post({ type: 'turn.finish', turn });
    return true;
  }

  private completeStepStarting(turn: LiveTurn, step: StepState, run: StepStartingRun): void {
    if (!this.isCurrentStep(turn, step, 'stepStarting')) return;
    if (this.finishSteeredStep(turn, step)) return;
    const reports = hookFailureReports('step.starting', run.failures);
    if (run.rewrittenBy !== undefined) {
      this.record({ type: 'context.settled', messages: [...run.messages], reason: run.rewrittenBy });
    }
    this.report('step.starting', turn, reports, true);
    if (run.blocked !== undefined) {
      step.outcome = { type: 'blocked', at: 'step.starting', cause: run.blocked };
      turn.outcome = step.outcome;
    } else if (turn.promptOnly === true) {
      step.outcome = { type: 'done', cause: { by: 'loop', reason: 'prompt_only' } };
      turn.outcome = step.outcome;
    } else {
      turn.phase = 'requesting';
    }
    this.post({ type: 'step.after_starting', turn, step });
  }

  private afterStepStarting(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step)) return;
    if (step.outcome?.type === 'blocked' || turn.promptOnly === true) {
      this.post({ type: 'step.finish', turn, step });
      return;
    }
    if (this.finishSteeredStep(turn, step)) return;
    if (this.deferForRequest(turn, step, () => this.afterStepStarting(turn, step))) return;
    this.appendReminders(turn, step);
    this.post({ type: 'request.prepare', turn, step });
  }

  flushReminders(): void {
    if (!this.open()) return;
    const entries = this.mailbox.drainReminders();
    for (const entry of entries) {
      this.record({
        type: 'message.appended',
        turnId: this.turn?.id ?? this.durable.nextTurnId,
        step: this.turn?.step ?? 0,
        source: 'remind',
        entry,
      });
    }
    this.kick();
  }

  private appendReminders(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    const entries = this.mailbox.drainReminders();
    for (const entry of entries) {
      this.record({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'remind', entry });
    }
  }

  private prepareRequest(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    if (this.finishSteeredStep(turn, step)) return;
    const execution = this.execution;
    if (execution === undefined) {
      this.fail(turn, this.executionError ?? new Error('turn has no execution'));
      return;
    }
    if (execution.prepare === undefined) {
      this.startRequest(turn, step);
      return;
    }
    this.complete(
      turn,
      execution.prepare(step.scope.signal),
      (profile) => ({ type: 'request.prepared', turn, step, profile }),
      (error) => ({ type: 'request.prepare_failed', turn, step, error }),
    );
  }

  private completeRequestPreparation(turn: LiveTurn, step: StepState, profile: LoopProfile): void {
    if (!this.isCurrentStep(turn, step)) return;
    if (this.finishSteeredStep(turn, step)) return;
    if (turn.scope.signal.aborted) {
      turn.outcome = { type: 'aborted', reason: turn.scope.signal.reason };
      this.post({ type: 'turn.finish', turn });
      return;
    }
    if (this.deferForRequest(turn, step, () => this.completeRequestPreparation(turn, step, profile))) return;
    if (profile.tools !== undefined) this.record({ type: 'tools.settled', tools: [...profile.tools] });
    if (this.execution !== undefined) this.execution = { ...this.execution, profile, prepare: undefined };
    this.post({ type: 'request.start', turn, step });
  }

  private failRequestPreparation(turn: LiveTurn, step: StepState, error: unknown): void {
    if (!this.isCurrent(turn)) return;
    if (this.finishSteeredStep(turn, step)) return;
    if (!turn.scope.signal.aborted) {
      this.fail(turn, error);
      return;
    }
    turn.outcome = { type: 'aborted', reason: turn.scope.signal.reason };
    this.post({ type: 'turn.finish', turn });
  }

  private startRequest(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    if (this.finishSteeredStep(turn, step)) return;
    if (this.deferForRequest(turn, step, () => this.startRequest(turn, step))) return;
    const execution = this.execution;
    if (execution === undefined) {
      this.fail(turn, this.executionError ?? new Error('turn has no execution'));
      return;
    }
    const outcome = runLoopRequest(
      { ...execution, requester: execution.requester.with({ policy: this.policy.asPolicy() }) },
      {
        messages: [...this.durable.messages],
        signal: step.scope.signal,
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
    if (event.type === 'llm.prepared') {
      step.model = event.model;
      return;
    }
    if (event.type === 'llm.streaming.part' && (event.part.type === 'function' || event.part.type === 'tool_call_part')) {
      step.toolCallStreaming = true;
    }
    if (event.type === 'llm.retrying') {
      const entry = assistantEntryOf({
        type: 'failed',
        error: event.error,
        message: event.message ?? undefined,
        usage: event.usage,
        headers: event.headers,
        finish: event.finish,
        messageId: event.messageId,
        requestId: event.requestId,
        timing: event.timing,
      }, step.model);
      if (entry !== undefined) {
        this.record({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'partial', entry });
        step.partialMessage = event.message ?? undefined;
      }
    }
    this.record(event);
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
    if (entry !== undefined && step.partialMessage !== outcome.message) {
      this.record({
        type: 'message.appended',
        turnId: turn.id,
        step: turn.step,
        source: outcome.type === 'failed' ? 'partial' : 'llm',
        entry,
      });
    }
    step.partialMessage = undefined;
    if (outcome.type !== 'done' && this.finishSteeredStep(turn, step)) return;
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
      this.settleUnstartedTools(turn, step, turn.outcome.reason);
    } else {
      for (const call of step.calls) {
        if (step.settled[call.key] !== undefined) continue;
        const context: LoopToolContext = {
          turnId: turn.id,
          step: turn.step,
          ...this.toolContext?.(turn.id),
        };
        const handler = this.executor.execute(call.toolCall, context);
        const slot: LiveTool = {
          key: call.key,
          toolCall: call.toolCall,
          turnId: turn.id,
          step: turn.step,
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
    }
    this.post({ type: 'tools.execute', turn, step, slots });
  }

  private executeTools(turn: LiveTurn, step: StepState, slots: LiveTool[]): void {
    if (!this.isCurrentStep(turn, step, 'acting')) return;
    for (const slot of slots) this.executeTool(slot);
    if (allSettled(step)) this.post({ type: 'acting.complete', turn, step });
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
    const prepared = slot.handler.snapshot().prepared as { display?: import('#/tool/toolInputDisplay').ToolInputDisplay } | undefined;
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
    const turn = this.turn;
    const step = this.step;
    if (turn?.id !== slot.turnId || turn.step !== slot.step || step === undefined) return;
    step.outcome = { type: 'failed', error };
    step.settled[slot.key] = null;
    if (allSettled(step)) this.post({ type: 'acting.complete', turn, step });
  }

  private respondToTool(slot: LiveTool, response: ToolExecutionResponse): void {
    if (slot.responded) return;
    slot.responded = true;
    if (isToolDetachAck(response)) {
      slot.detached = true;
      const outcome = {
        type: 'succeeded' as const,
        entry: toolEntry(slot.toolCall, response, true),
      };
      this.record({
        type: 'tool.ended',
        taskId: slot.handler.taskId,
        toolCallId: slot.toolCall.id,
        outcome,
        detached: true,
      });
    } else {
      slot.result = response;
      const outcome = toolOutcomeOf(slot);
      this.record({
        type: 'tool.ended',
        taskId: slot.handler.taskId,
        toolCallId: slot.toolCall.id,
        outcome,
        detached: false,
      });
    }
    const turn = this.turn;
    const step = this.step;
    if (turn?.id !== slot.turnId || turn.step !== slot.step || step === undefined) return;
    const outcome = isToolDetachAck(response)
      ? { type: 'succeeded' as const, entry: toolEntry(slot.toolCall, response, true) }
      : toolOutcomeOf(slot);
    settle(step, slot.key, outcome);
    if (allSettled(step)) this.post({ type: 'acting.complete', turn, step });
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
        const entry = completionEntry(slot.toolCall, outcome, result);
        slot.completionEntry = Promise.resolve(entry);
        this.post({ type: 'tool.detached_completed', slot, outcome, entry });
      } else {
        slot.completionEntry = resolveCompletionEntry({
          toolCall: slot.toolCall,
          outcome,
          result,
        }, completion);
        void slot.completionEntry.then((entry) => {
          this.post({ type: 'tool.detached_completed', slot, outcome, entry });
          this.kick();
        }, (error: unknown) => {
          if (this.phase === 'closed') {
            this.closeDetached();
            this.kick();
            return;
          }
          const failed: AsyncToolOutcome = { type: 'failed', error };
          const input = { toolCall: slot.toolCall, outcome: failed, result };
          const fallback = async (): Promise<UserEntry> => {
            try {
              if (completion.onRejected !== undefined) {
                return await completion.onRejected(error, input);
              }
            } catch {
            }
            return completionEntry(slot.toolCall, failed, result);
          };
          void fallback().then((entry) => {
            if (this.phase === 'closed') return;
            this.post({ type: 'tool.detached_rejected', slot, outcome: failed, entry });
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

  private completeDetached(slot: LiveTool, outcome: AsyncToolOutcome, entry: UserEntry): void {
    if (this.tools.get(slot.key) !== slot) return;
    if (this.phase === 'closed') {
      this.completeDetachedClose([{ slot, outcome, entry }]);
      return;
    }
    slot.completionOutcome = outcome;
    slot.completionEntryValue = entry;
    this.drainDetachedCompletions();
  }

  private drainDetachedCompletions(): void {
    let drained = false;
    for (const slot of Array.from(this.tools.values())) {
      const entry = slot.completionEntryValue;
      const outcome = slot.completionOutcome;
      if (entry === undefined || outcome === undefined) continue;
      this.tools.delete(slot.key);
      slot.completionPending = false;
      this.notifyTool(slot);
      this.record({ type: 'tool.async_ended', taskId: slot.handler.taskId, toolCallId: slot.toolCall.id, outcome, entry });
      this.record({ type: 'prompt.notified', entry });
      if (this.turn !== undefined) this.completionHandoff = true;
      this.mailbox.queue([entry]);
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

  private deferForRequest(turn: LiveTurn, step: StepState, continuation: () => void): boolean {
    if (this.deferForCompletion(continuation)) return true;
    if (!this.completionHandoff) return false;
    this.completionHandoff = false;
    step.outcome = { type: 'done', cause: { by: 'loop', reason: 'notify' } };
    this.finalizeStep(turn, step);
    this.post({ type: 'turn.finish', turn });
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

  private settleUnstartedTools(turn: LiveTurn, step: StepState, reason: unknown): void {
    for (const call of step.calls) {
      if (step.settled[call.key] !== undefined || this.tools.has(call.key)) continue;
      this.record({ type: 'tool.started', turnId: turn.id, step: turn.step, toolCall: call.toolCall });
      const outcome = abortedToolOutcome(call.toolCall, reason);
      this.record({ type: 'tool.ended', toolCallId: call.toolCall.id, outcome, detached: false });
      settle(step, call.key, outcome);
    }
  }

  private appendToolEntries(turn: LiveTurn, step: StepState): void {
    const entries = step.calls.flatMap((call) => step.settled[call.key] ?? []);
    for (const entry of entries) {
      this.record({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'tool', entry });
    }
  }

  private settleToolsAndFinish(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    const step = this.step;
    if (step === undefined) {
      this.post({ type: 'turn.finish', turn });
      return;
    }
    this.settleUnstartedTools(turn, step, turn.outcome?.type === 'aborted' ? turn.outcome.reason : undefined);
    if (!allSettled(step)) return;
    this.appendToolEntries(turn, step);
    this.finalizeStep(turn, step);
    this.post({ type: 'turn.finish', turn });
  }

  private completeActing(turn: LiveTurn, step: StepState): void {
    if (this.turn !== turn || this.step !== step || turn.phase !== 'acting' || !allSettled(step)) return;
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
    if (step.outcome?.type === 'continue' && this.deferForCompletion(() => this.finishStep(turn, step))) return;
    this.finalizeStep(turn, step);
    this.post({ type: 'step.finished', turn, step });
  }

  private afterStepFinished(turn: LiveTurn, _step: StepState): void {
    if (this.turn !== turn || this.step !== undefined) return;
    if (turn.outcome?.type === 'aborted' || turn.phase === 'finished') this.post({ type: 'turn.finish', turn });
    else this.post({ type: 'step.start', turn });
  }

  private finalizeStep(turn: LiveTurn, step: StepState): void {
    const draft = step.outcome ?? { type: 'aborted' as const };
    const outcome = draft.type === 'continue' && this.mailbox.hasNotify
      ? { type: 'done' as const, cause: { by: 'loop', reason: 'notify' } }
      : draft;
    step.outcome = outcome;
    if (turn.promptOnly !== true) this.record({ type: 'step.ended', turnId: turn.id, step: turn.step, outcome });
    this.step = undefined;
    if (outcome.type === 'continue') return;
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
    if (outcome.type === 'aborted') this.appendPendingReminders(turn);
    this.record({ type: 'turn.ended', turnId: turn.id, outcome });
    this.completionHandoff = false;
    this.completionContinuation = undefined;
    this.turn = undefined;
    this.phase = this.phase === 'closed' ? 'closed' : 'idle';
    this.execution = undefined;
    this.completedTurns.push(turn);
    if (outcome.type === 'aborted' && turn.continueAfterAbort === true) this.held = false;
    this.schedule();
  }

  private appendPendingReminders(turn: LiveTurn): void {
    for (const entry of this.mailbox.drainReminders()) {
      this.record({
        type: 'message.appended',
        turnId: turn.id,
        step: turn.step,
        source: 'remind',
        entry,
      });
    }
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

  private continueTurn(force: boolean): void {
    if (this.resetting || this.phase !== 'idle') return;
    if (this.deferForCompletion(() => this.continueTurn(force))) return;
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
    if (!this.mailbox.hasTrigger && (force || canContinue(this.durable.messages))) {
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
      this.closeDetached();
      this.phase = 'closed';
      const turn = this.turn;
      if (turn !== undefined) this.closeTurn(turn);
      this.root.abort();
    }
  }

  private closeTurn(turn: LiveTurn): void {
    const reason = turn.outcome?.type === 'aborted' ? turn.outcome.reason : CLOSED;
    if (turn.outcome?.type !== 'aborted') this.releaseTurn(turn, { type: 'aborted', reason: CLOSED });
    const step = this.step;
    if (step !== undefined && step.outcome?.type !== 'aborted') step.outcome = { type: 'aborted', reason };
    turn.scope.abort(reason);
    for (const slot of this.tools.values()) {
      if (slot.turnId === turn.id && slot.step === turn.step && !slot.detached && !slot.done) {
        void slot.handler.stop(reason);
      }
    }
    if (turn.phase === 'requesting' && step !== undefined) {
      const outcome: LlmOutcome = { type: 'aborted', message: null, usage: undefined, reason: undefined };
      step.llm = outcome;
      this.record({ type: 'llm.ended', outcome });
      const entry = assistantEntryOf(outcome, step.model);
      if (entry !== undefined) {
        this.record({ type: 'message.appended', turnId: turn.id, step: turn.step, source: 'llm', entry });
      }
      this.finalizeStep(turn, step);
      this.finishTurn(turn);
      return;
    }
    if ((turn.phase === 'batching' || turn.phase === 'acting') && step !== undefined) {
      this.settleUnstartedTools(turn, step, reason);
      if (!allSettled(step)) {
        turn.phase = 'acting';
        return;
      }
      this.appendToolEntries(turn, step);
      this.finalizeStep(turn, step);
      this.finishTurn(turn);
      return;
    }
    if (step !== undefined) this.finalizeStep(turn, step);
    this.finishTurn(turn);
  }

  private closeDetached(): void {
    const closing: { slot: LiveTool; outcome: AsyncToolOutcome; entry: Promise<UserEntry> }[] = [];
    let pending = false;
    for (const slot of this.tools.values()) {
      if (!slot.detached) continue;
      pending = true;
      void slot.handler.stop(CLOSED);
      if (!slot.done) continue;
      const outcome = asyncOutcomeOf(slot);
      slot.completionEntry ??= resolveCompletionEntry({
        toolCall: slot.toolCall,
        outcome,
        result: slot.result,
      }, slot.completion ?? this.completionFactory);
      closing.push({ slot, outcome, entry: slot.completionEntry });
    }
    this.closePending = pending;
    if (closing.length === 0) return;
    void Promise.all(closing.map(async ({ slot, outcome, entry }) => {
      try {
        return { slot, outcome, entry: await entry, failure: undefined };
      } catch (error) {
        const failed: AsyncToolOutcome = { type: 'failed', error };
        const input = { toolCall: slot.toolCall, outcome: failed, result: slot.result };
        let terminalEntry: UserEntry;
        const completion = slot.completion ?? this.completionFactory;
        try {
          terminalEntry = completion?.onRejected === undefined
            ? completionEntry(slot.toolCall, failed, slot.result)
            : await completion.onRejected(error, input);
        } catch {
          terminalEntry = completionEntry(slot.toolCall, failed, slot.result);
        }
        return { slot, outcome: failed, entry: terminalEntry, failure: { error } };
      }
    })).then(
      (entries) => {
        this.post({ type: 'close.detached', entries });
        const failure = entries.find((entry) => entry.failure !== undefined)?.failure;
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
    entries: readonly { readonly slot: LiveTool; readonly outcome: AsyncToolOutcome; readonly entry: UserEntry }[],
  ): void {
    for (const { slot, outcome, entry } of entries) {
      if (this.tools.get(slot.key) !== slot) continue;
      this.tools.delete(slot.key);
      slot.completionPending = false;
      this.record({ type: 'tool.async_ended', taskId: slot.handler.taskId, toolCallId: slot.toolCall.id, outcome, entry });
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

function mergeResetEntries<T extends HistoryMessage>(
  live: readonly T[],
  restored: readonly T[],
  liveToolCallIds: ReadonlySet<string>,
): T[] {
  const identities = new Set<HistoryMessage>(live);
  const promptIds = new Set<string>();
  const toolCallIds = new Set<string>(liveToolCallIds);
  const anonymous = new Set<string>();
  for (const entry of live) {
    const meta = entry.meta as { promptId?: unknown; toolCallId?: unknown; source?: unknown } | undefined;
    if (typeof meta?.promptId === 'string') promptIds.add(meta.promptId);
    if (meta?.source === 'async-tool' && typeof meta.toolCallId === 'string') toolCallIds.add(meta.toolCallId);
    if (meta?.promptId === undefined && meta?.toolCallId === undefined) anonymous.add(JSON.stringify(entry.message));
  }
  const merged = [...live];
  for (const entry of restored) {
    const meta = entry.meta as { promptId?: unknown; toolCallId?: unknown; source?: unknown } | undefined;
    if (identities.has(entry)) continue;
    if (typeof meta?.promptId === 'string' && promptIds.has(meta.promptId)) continue;
    if (meta?.source === 'async-tool' && typeof meta.toolCallId === 'string' && toolCallIds.has(meta.toolCallId)) continue;
    if (meta?.promptId === undefined && meta?.toolCallId === undefined && anonymous.has(JSON.stringify(entry.message))) continue;
    merged.push(entry);
  }
  return merged;
}

function isUserEntry(value: unknown): value is UserEntry {
  return isEntry(value) && value.message.role === 'user';
}

function isRemindEntry(value: unknown): value is RemindEntry {
  return isEntry(value);
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
    isObject(value) &&
    typeof value['name'] === 'string' &&
    typeof value['description'] === 'string' &&
    isObject(value['parameters'])
  );
}

const SYSTEM_PROMPT_ERROR = 'systemPrompt must be a string';
const TOOLS_ERROR = 'tools must be an array of tool descriptions';

function inputError(input: LoopInput): string | undefined {
  if (input.messages !== undefined && !arrayOf(input.messages, isEntry)) {
    return 'messages must be an array of history entries';
  }
  const inbox = input.inbox ?? {};
  if (inbox.normal !== undefined && !arrayOf(inbox.normal, isUserEntry)) {
    return 'inbox.normal must be an array of user entries';
  }
  if (inbox.notify !== undefined && !arrayOf(inbox.notify, isUserEntry)) {
    return 'inbox.notify must be an array of user entries';
  }
  if (inbox.remind !== undefined && !arrayOf(inbox.remind, isRemindEntry)) {
    return 'inbox.remind must be an array of user or system entries';
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
      return isUserEntry(command.entry) ? undefined : 'entry must be a user entry';
    case 'input.remind':
      return isRemindEntry(command.entry) ? undefined : 'entry must be a user or system entry';
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
      return arrayOf(command.messages, isEntry) ? undefined : 'messages must be an array of history entries';
    case 'input.set_system_prompt':
      return typeof command.systemPrompt === 'string' ? undefined : SYSTEM_PROMPT_ERROR;
    default:
      return undefined;
  }
}
