import { createActor, type Actor, type ActorControl } from '#/actor/index';
import type { Message, ToolDescription, UserMessage } from '#/llm/message';
import { createPolicyRegistry, type PolicyRegistry } from '#/llm/policy/registry';
import { isToolDetachAck } from '#/tool/tool-executor';
import type { ToolExecutionResponse, ToolResult } from '#/tool/types';
import type { WaitOpts } from '#/utils/wait';
import type { CreateLoopOptions, Loop, LoopToolExecutor } from './create-loop';
import type { LoopInput, UnfinishedTurn } from './contract/command';
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
  type LoopState,
} from './state';
import type { LiveTool } from './live';
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
  type Turn,
  type TurnEnding,
  type TurnHookContext,
  type TurnInput,
  type TurnMessage,
  type TurnRuntime,
  type TurnState,
  type TurnToolBatch,
  type TurnToolBatchResult,
} from './turn';

type LoopCommand =
  | { type: 'input.run_turn'; message: UserMessage }
  | { type: 'input.submit'; message: UserMessage }
  | { type: 'input.cancel'; promptId: string }
  | { type: 'input.steer'; promptIds: readonly string[] }
  | { type: 'input.notify'; message: UserMessage }
  | { type: 'input.remind'; message: RemindMessage }
  | { type: 'input.abort_tool'; toolCallId: string }
  | { type: 'input.detach_tool'; toolCallId: string }
  | { type: 'input.set_context'; messages: Message[] }
  | { type: 'input.set_system_prompt'; systemPrompt: string };

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

  take(id: number): TurnInput | undefined {
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
    const pending: QueuedItem[] = [
      { kind, message: head },
      ...reminders.map((message) => ({ kind: 'remind' as const, message })),
    ];
    return {
      id,
      kind: 'prompt',
      trigger: kind,
      initialPending: pending,
      promptOnly,
      bypassMaxSteps: pending.some((item) => item.kind !== 'remind' && item.message.attributes?.bypassMaxSteps === true),
      step: 0,
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

type LoopActorState =
  | { readonly status: 'idle'; readonly pendingContinue?: { readonly force: boolean } }
  | {
      readonly status: 'running';
      readonly machine: Turn;
      pending: QueuedItem[];
      announced: boolean;
      readonly completion?: Deferred<TurnOutcome>;
      readonly signal?: AbortSignal;
      onAbort?: () => void;
      continueAfterAbort?: boolean;
    }
  | { readonly status: 'resetting' };

type RunningTurn = Extract<LoopActorState, { status: 'running' }>;
type LoopControl = ActorControl<LoopActorState, LoopEmitted>;

function turnOf(state: LoopActorState): RunningTurn | undefined {
  return state.status === 'running' ? state : undefined;
}

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
  private readonly projection = loopProjection();
  private readonly actor: Actor<LoopActorState, LoopEmitted>;
  private mailbox: LoopMailbox;
  private readonly toolContext?: CreateLoopOptions['toolContext'];
  private readonly completionFactory?: CreateLoopOptions['completionMessage'];
  private readonly shouldQueueTaskNotification?: CreateLoopOptions['shouldQueueTaskNotification'];
  private readonly abortGraceMs: number;
  private held = true;
  private durable: LoopRecordState;
  private readonly tools = new Map<string, LiveTool>();
  private toolBatch: ActiveToolBatch | undefined;
  private completedToolBatch: { readonly turnId: number; readonly step: number; readonly result: TurnToolBatchResult } | undefined;
  private requesterTemplate: LoopLlmRequester | undefined;
  private revision = 0;
  private seq = 0;
  private readonly completionWaiters = new Set<() => void>();
  private readonly detachedCloseWaiters = new Set<() => void>();
  private closeFailure: { readonly error: unknown } | undefined;
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
        // jscpd:ignore-start
        ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
        ...(profile.tools === undefined ? {} : { tools: [...profile.tools] }),
        // jscpd:ignore-end
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
    this.hook = options.hook ?? {};
    this.policy = createPolicyRegistry();
    this.waitForTasks = createWaitForTasks(() =>
      Array.from(this.tools.values()).filter((slot) => slot.detached && !slot.done),
    );
    this.actor = createActor<LoopActorState, LoopEmitted>({
      initial: { status: 'idle' },
      onListenerError: options.onListenerError,
      onEmit: (event) => {
        this.durable = this.projection.reduce(this.durable, {
          seq: this.seq,
          time: 0,
          event: event as LoopRecord,
        });
        this.seq += 1;
        if (event.type === 'context.settled') this.revision += 1;
      },
      onSchedule: (ctrl) => {
        if (ctrl.state.status !== 'idle' || this.hasPendingCompletions) return;
        if (ctrl.state.pendingContinue !== undefined) {
          const { force } = ctrl.state.pendingContinue;
          ctrl.setState({ status: 'idle' });
          this.continueTurn(ctrl, force);
          return;
        }
        this.schedule(ctrl);
      },
      onIdle: () => this.settleLifecycle(),
      onClose: (ctrl) => this.closeRuntime(ctrl),
      isIdle: (state) => state.status === 'idle' && !this.hasPendingCompletions && !this.canSchedule(state),
    });
    this.turnHooks.registerTurnHooks({
      starting: (event, ctx) => this.actor.act(() => this.ownerStarting(event, ctx)),
      requesting: (event, ctx) => this.actor.act(() => this.ownerRequesting(event, ctx)),
      continuing: (event, ctx) => this.actor.act(() => this.ownerContinuing(event, ctx)),
      ending: (event, ctx) => this.actor.act(() => this.ownerEnding(event, ctx)),
    });
    const rootSignal = this.actor.act((ctrl) => ctrl.rootSignal);
    this.turnRuntime = {
      requester: () => this.requesterTemplate,
      policy: this.policy,
      executeBatch: (batch) => this.actor.act(() => this.executeToolBatch(batch)),
      abortBatch: (batch, reason, options) => this.actor.act(() => this.abortToolBatch(batch, reason, options)),
      hooks: this.turnHooks.hook,
      extensions: this.hook,
      read: () => ({ messages: this.durable.messages, profile: this.durable.profile }),
      emit: (event) => {
        this.record(event);
        if (event.type === 'turn.ended' && this.turn?.machine.id === event.turnId) {
          this.finishTurn(this.turn, event.outcome);
        }
      },
      transition: (run) => this.transition(run),
      report: (point, event, reports, notify) => {
        if (this.turn?.machine.id === event.turnId) this.report(point, this.turn, event.step, reports, notify);
      },
      committed: (turnId) => {
        if (this.turn?.machine.id === turnId) this.turn.pending = [];
      },
      signal: rootSignal,
      abortGraceMs: this.abortGraceMs,
    };
  }

  private get turn(): RunningTurn | undefined {
    return turnOf(this.actor.state);
  }

  private get phase(): 'idle' | 'running' | 'closed' {
    if (this.actor.closing || this.actor.closed) return 'closed';
    return this.actor.state.status === 'running' ? 'running' : 'idle';
  }

  private get resetting(): boolean {
    return this.actor.state.status === 'resetting';
  }

  get state(): LoopState {
    const { profile, messages, nextTurnId, unfinished } = this.durable;
    const live = this.turn;
    const current = live !== undefined
      ? {
          id: live.machine.id,
          trigger: live.machine.state.trigger,
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
    if (this.actor.closed) return event;
    return this.actor.act((ctrl) => ctrl.emit(event));
  }

  private transition<T>(run: () => T): T {
    return this.actor.act(() => run());
  }

  private settleLifecycle(): void {
    const idle = !this.hasActiveBackgroundTasks;
    if (!idle) this.lifecycleIdle = false;
    const publishDrained = this.open() && !this.lifecycleDrained;
    const publishIdle = this.open() && idle && this.lifecycleDrained && !this.lifecycleIdle;
    if (publishDrained) {
      this.lifecycleDrained = true;
      this.record({ type: 'loop.drained', generation: this.lifecycleGeneration });
    }
    if (publishIdle) {
      this.lifecycleIdle = true;
      this.record({ type: 'loop.idle', generation: this.lifecycleGeneration });
    }
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

  private get hasDetachedTools(): boolean {
    for (const slot of this.tools.values()) {
      if (slot.detached) return true;
    }
    return false;
  }

  private canSchedule(state: LoopActorState): boolean {
    return (
      this.open() &&
      state.status === 'idle' &&
      !this.held &&
      !this.hasPendingCompletions &&
      (this.mailbox.hasTrigger || this.mailbox.hasReminders)
    );
  }

  private schedule(ctrl: LoopControl): boolean {
    if (!this.canSchedule(ctrl.state)) return false;
    this.closeUnfinished();
    if (!this.mailbox.hasTrigger) {
      this.flushReminders();
      return true;
    }
    const next = this.mailbox.take(this.durable.nextTurnId);
    if (next === undefined) return false;
    this.activate(ctrl, next);
    return true;
  }

  private activate(
    ctrl: LoopControl,
    input: TurnInput,
    completion?: Deferred<TurnOutcome>,
    signal?: AbortSignal,
  ): RunningTurn | undefined {
    if (ctrl.state.status !== 'idle' || this.turn !== undefined) return undefined;
    const machine = createTurn(input, this.turnRuntime);
    const turn: RunningTurn = {
      status: 'running',
      machine,
      pending: [...input.initialPending],
      announced: false,
      completion,
      signal,
    };
    this.held = false;
    ctrl.setState(turn);
    ctrl.defer(() => {
      if (this.isCurrent(turn)) turn.machine.start();
    });
    return turn;
  }

  private releaseIntake(): void {
    if (!this.resetting) this.held = false;
  }

  private abortRequest(): void {
    this.turn?.machine.interrupt(STEERED);
  }

  submit(message: UserMessage): LoopAck<'prompt.submitted'> | undefined {
    const normalized = normalizeUserMessage(message);
    this.check({ type: 'input.submit', message: normalized });
    if (!this.open()) return undefined;
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      const ack = this.mailbox.submit(normalized);
      this.releaseIntake();
      return ack;
    });
  }

  notify(message: UserMessage): LoopAck<'prompt.notified'> | undefined {
    // jscpd:ignore-start
    const normalized = normalizeUserMessage(message);
    this.check({ type: 'input.notify', message: normalized });
    if (!this.open()) return undefined;
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      const ack = this.mailbox.notify(normalized);
      this.releaseIntake();
      return ack;
    });
    // jscpd:ignore-end
  }

  recordNotification(message: UserMessage): LoopAck<'prompt.notified'> | undefined {
    const normalized = normalizeUserMessage({
      ...message,
      attributes: { ...message.attributes, promptOnly: true },
    });
    this.check({ type: 'input.notify', message: normalized });
    if (!this.open()) return undefined;
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      return this.mailbox.notify(normalized);
    });
  }

  remind(...messages: readonly RemindMessage[]): LoopAck<'prompt.reminded'> | undefined {
    for (const message of messages) this.check({ type: 'input.remind', message });
    if (!this.open() || messages.length === 0) return undefined;
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      return this.mailbox.remind(messages);
    });
  }

  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined {
    this.check({ type: 'input.steer', promptIds });
    if (!this.open()) return undefined;
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      const ack = this.mailbox.steer(promptIds);
      if ((ack.messages?.length ?? 0) > 0) {
        this.releaseIntake();
        if (this.turn?.machine.state.phase === 'requesting') this.abortRequest();
      }
      return ack;
    });
  }

  sendNow(message: UserMessage): LoopAck<'prompt.notified'> | undefined {
    // jscpd:ignore-start
    const normalized = normalizeUserMessage(message);
    this.check({ type: 'input.notify', message: normalized });
    if (!this.open()) return undefined;
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      const ack = this.mailbox.notify(normalized);
      this.releaseIntake();
      this.abortRequest();
      return ack;
    });
    // jscpd:ignore-end
  }

  sendNowQueued(promptIds: readonly string[]): void {
    this.check({ type: 'input.steer', promptIds });
    if (!this.open()) return;
    this.actor.act(() => {
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
    });
  }

  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined {
    this.check({ type: 'input.cancel', promptId });
    if (!this.open()) return undefined;
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      return this.mailbox.cancel(promptId);
    });
  }

  start(): void {
    if (!this.open()) return;
    this.actor.act(() => {
      if (!this.open()) return;
      this.releaseIntake();
    });
  }

  resume(): void {
    if (this.durable.unfinished === undefined || !isResumable(this.durable)) return;
    this.continue();
  }

  continue(options?: { readonly force?: boolean }): void {
    if (!this.open()) return;
    const force = options?.force === true;
    this.actor.act((ctrl) => {
      ctrl.defer((nextCtrl) => {
        if (!this.open() || nextCtrl.state.status !== 'idle') return;
        this.drainDetachedCompletions();
        if (this.hasPendingCompletions) {
          nextCtrl.setState({ status: 'idle', pendingContinue: { force } });
          return;
        }
        this.continueTurn(nextCtrl, force);
      });
    });
  }

  abort(reason?: unknown, options?: { readonly continue?: boolean }): void {
    if (!this.open()) return;
    const continueAfterAbort = options?.continue === true;
    this.actor.act((ctrl) => {
      ctrl.defer(() => {
        if (!this.open()) return;
        this.requestAbort(this.turn, reason, continueAfterAbort);
      });
    });
  }

  abortTool(toolCallId: string, reason?: unknown): void {
    this.check({ type: 'input.abort_tool', toolCallId });
    if (!this.open()) return;
    this.actor.act((ctrl) => {
      ctrl.defer(() => this.abortToolCall(toolCallId, reason));
    });
  }

  detachTool(toolCallId: string, text?: string, completion?: ToolCompletionFactory): void {
    this.check({ type: 'input.detach_tool', toolCallId });
    if (!this.open()) return;
    this.actor.act((ctrl) => {
      if (!this.open()) return;
      for (const slot of Array.from(this.tools.values())) {
        if (slot.toolCall.id === toolCallId && !slot.detached) {
          slot.completion = completion;
          const acknowledgement = text ?? `moved to background by the user: ${slot.toolCall.name} (tool_call_id=${toolCallId})`;
          const response = slot.handler.detach(acknowledgement, {
            content: [{ type: 'text', text: acknowledgement }],
          });
          if (response !== undefined) ctrl.defer(() => this.respondToTool(slot, response));
        }
      }
    });
  }

  async reset(prepare: () => Promise<LoopInput>): Promise<void> {
    if (!this.open() || this.actor.state.status !== 'idle') {
      throw new Error('Loop reset requires an idle open loop');
    }
    const previousHeld = this.held;
    const liveToolCallIds = new Set(
      Array.from(this.tools.values()).filter((slot) => slot.detached).map((slot) => slot.toolCall.id),
    );
    this.actor.act((ctrl) => {
      this.held = true;
      ctrl.setState({ status: 'resetting' });
    });
    if (!this.open()) return;
    try {
      const input = await prepare();
      if (!this.open()) return;
      this.actor.act((ctrl) => {
        if (!this.open() || ctrl.state.status !== 'resetting') return;
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
            // jscpd:ignore-start
            ...(profile.systemPrompt === undefined ? {} : { systemPrompt: profile.systemPrompt }),
            ...(profile.tools === undefined ? {} : { tools: [...profile.tools] }),
            // jscpd:ignore-end
          },
          messages: [...(input.messages ?? [])],
          nextTurnId,
          ...(unfinished === undefined ? {} : { unfinished: { ...unfinished } }),
        };
        this.revision = revision;
        this.mailbox = new LoopMailbox({ normal, notify, remind }, (event) => {
          this.record(event);
        });
        this.toolBatch = undefined;
        this.completedToolBatch = undefined;
        this.completionHandoff = false;
        this.held = true;
        ctrl.setState({ status: 'idle' });
      });
    } catch (error) {
      if (this.open()) {
        this.actor.act((ctrl) => {
          if (!this.open() || ctrl.state.status !== 'resetting') return;
          this.held = previousHeld;
          ctrl.setState({ status: 'idle' });
        });
      }
      throw error;
    }
  }

  setRequester(requester: LoopLlmRequester | undefined): void {
    if (!this.open()) return;
    this.actor.act(() => {
      if (!this.open()) return;
      this.requesterTemplate = requester;
    });
  }

  setContext(messages: Message[], reason?: string): LoopAck<'context.settled' | 'context.rejected'> | undefined {
    this.check({ type: 'input.set_context', messages });
    if (!this.open()) return undefined;
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      if (!this.editable() && reason !== 'compaction' && reason !== 'clear' && reason !== 'context.clear') {
        return this.record({ type: 'context.rejected', messages, reason });
      }
      if (reason === 'compaction') this.mailbox.clearReminders();
      return this.record({ type: 'context.settled', messages, reason });
    });
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
    return this.actor.act(() => {
      if (!this.open()) return undefined;
      return this.record({ type: 'system_prompt.settled', systemPrompt });
    });
  }

  subscribe(listener: (event: LoopEmitted) => void): () => void {
    return this.actor.subscribe(listener);
  }

  wait<T extends LoopEmitted['type']>(type: T, opts?: WaitOpts<LoopAck<T>>): Promise<LoopAck<T>> {
    return this.actor.wait(type, opts);
  }

  runTurn(message: UserMessage, opts?: { readonly signal?: AbortSignal }): Promise<TurnOutcome> {
    const signal = opts?.signal;
    if (signal?.aborted) return Promise.resolve({ type: 'aborted', reason: signal.reason });
    try {
      this.check({ type: 'input.run_turn', message });
      if (!this.open() || this.actor.state.status !== 'idle') {
        return Promise.reject(new Error('runTurn is only accepted while idle'));
      }
      return this.actor.act((ctrl) => {
        const completion = deferred<TurnOutcome>();
        this.closeUnfinished();
        const turn = this.activate(ctrl, {
          id: this.durable.nextTurnId,
          kind: 'prompt',
          trigger: 'normal',
          initialPending: [
            { kind: 'normal', message },
            ...this.mailbox.drainReminders().map((reminder) => ({ kind: 'remind' as const, message: reminder })),
          ],
          promptOnly: false,
          bypassMaxSteps: message.attributes?.bypassMaxSteps === true,
          step: 0,
        }, completion, signal)!;
        if (signal !== undefined) {
          turn.onAbort = this.actor.bind(() => {
            if (this.turn !== turn || !this.open()) return;
            this.requestAbort(turn, signal.reason, false);
          });
          signal.addEventListener('abort', turn.onAbort, { once: true });
        }
        this.record({ type: 'prompt.submitted', message });
        return completion.promise;
      });
    } catch (error) {
      return Promise.reject(error);
    }
  }

  waitForIdle(): Promise<void> {
    return this.actor.waitForIdle();
  }

  close(): Promise<void> {
    return this.actor.close();
  }

  private isCurrent(turn: RunningTurn): boolean {
    return this.turn === turn && this.phase === 'running';
  }

  private announceTurn(turn: RunningTurn): void {
    if (turn.announced) return;
    turn.announced = true;
    if (turn.machine.state.kind === 'resume') {
      this.record({ type: 'turn.resumed', turnId: turn.machine.id, step: turn.machine.state.step });
    } else this.record({
      type: 'turn.started',
      turnId: turn.machine.id,
      trigger: turn.machine.state.trigger,
      promptOnly: turn.machine.state.promptOnly ? true : undefined,
      message: turn.pending.find((item): item is Extract<QueuedItem, { kind: 'normal' | 'notify' }> => item.kind !== 'remind')?.message,
    });
  }

  private report(
    point: HookPoint,
    turn: RunningTurn,
    step: number,
    reports: readonly HookFailureReport[],
    notify: boolean,
  ): void {
    const messages: UserMessage[] = [];
    for (const { failure, message } of reports) {
      this.record(hookFailedEvent(point, turn.machine.id, step, failure));
      this.record({ type: 'prompt.notified', message });
      messages.push(message);
      failure.suspend?.();
    }
    if (notify) {
      this.mailbox.queue(messages);
      this.held = false;
    }
  }

  private releaseTurn(turn: RunningTurn): void {
    const pending = turn.pending;
    turn.pending = [];
    this.mailbox.restore(pending);
    this.held = true;
  }

  private settleBlockedTurn(
    turn: RunningTurn,
    ctx: Pick<TurnHookContext, 'append'>,
  ): void {
    const pending = turn.pending;
    turn.pending = [];
    this.mailbox.restore(pending.filter((item) => item.kind === 'notify'));
    const reminders = [
      ...pending.flatMap((item) => item.kind === 'remind' ? [item.message] : []),
      ...this.mailbox.drainReminders(),
    ];
    this.held = true;
    this.announceTurn(turn);
    for (const item of pending) {
      if (item.kind === 'normal') ctx.append(item);
    }
    for (const message of reminders) ctx.append({ kind: 'remind', message });
  }

  private requestAbort(turn: RunningTurn | undefined, reason: unknown, continueAfterAbort: boolean): void {
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
    this.releaseTurn(turn);
    turn.machine.abort(reason);
  }

  private async ownerStarting(
    state: TurnState,
    ctx: TurnHookContext,
  ): Promise<Extract<TurnOutcome, { type: 'done' | 'blocked' }> | void> {
    const turn = this.turn;
    if (turn === undefined || turn.machine.id !== state.id) throw new Error('turn is no longer active');
    if (state.kind === 'resume') {
      this.announceTurn(turn);
      if (this.mailbox.hasNotify) return { type: 'done', cause: { by: 'loop', reason: 'notify' } };
      return;
    }
    const run = await (async (): Promise<TurnStartingRun> => {
      try {
        return await runTurnStarting(
          this.hook,
          { turnId: state.id, trigger: state.trigger, pending: turn.pending },
          ctx.signal,
        );
      } catch (error) {
        return { failures: [runtimeFailure(error)] };
      }
    })();
    if (this.turn !== turn || ctx.signal.aborted) return;
    this.transition(() => {
      const reports = hookFailureReports('turn.starting', run.failures);
      turn.pending.push(...reports.map(({ message }) => ({ kind: 'notify' as const, message })));
      this.report('turn.starting', turn, state.step, reports, false);
      if (run.blocked === undefined) this.announceTurn(turn);
    });
    if (run.blocked !== undefined) return { type: 'blocked', at: 'turn.starting', cause: run.blocked };
    const items = await this.appendPendingItems(turn, ctx.signal);
    if (this.turn !== turn || ctx.signal.aborted) return;
    ctx.append(...items);
  }

  private async appendPendingItems(turn: RunningTurn, signal: AbortSignal): Promise<TurnMessage[]> {
    const items = turn.pending;
    const appended: TurnMessage[] = [];
    try {
      for (const item of items) {
        const run = await runMessageAppending(
          this.hook,
          { turnId: turn.machine.id, step: turn.machine.state.step, item },
          signal,
        );
        appended.push({ kind: item.kind, message: run.message, blocked: run.blocked });
        for (const failure of run.failures) {
          appended.push({ kind: 'notify', message: hookFailureMessage('message.appending', failure.error), failure });
        }
      }
    } catch (error) {
      appended.length = 0;
      appended.push(...items);
      appended.push({
        kind: 'notify',
        message: hookFailureMessage('message.appending', error),
        failure: runtimeFailure(error),
      });
    }
    return appended;
  }

  private async ownerRequesting(
    state: TurnState,
    ctx: TurnHookContext,
  ): Promise<Extract<TurnOutcome, { type: 'done' }> | void> {
    if (this.turn?.machine.id !== state.id) return;
    await this.settleCompletions();
    if (this.turn?.machine.id !== state.id || ctx.signal.aborted) return;
    if (this.completionHandoff) {
      this.completionHandoff = false;
      return { type: 'done', cause: { by: 'loop', reason: 'notify' } };
    }
    ctx.append(...this.mailbox.drainReminders().map((message) => ({ kind: 'remind' as const, message })));
  }

  private async ownerContinuing(
    state: TurnState,
    _ctx: TurnHookContext,
  ): Promise<Extract<TurnOutcome, { type: 'done' }> | void> {
    if (this.turn?.machine.id !== state.id) return;
    await this.settleCompletions();
    if (this.turn?.machine.id !== state.id) return;
    if (this.mailbox.hasNotify) return { type: 'done', cause: { by: 'loop', reason: 'notify' } };
  }

  private async settleCompletions(): Promise<void> {
    while (true) {
      this.drainDetachedCompletions();
      if (!this.hasPendingCompletions) return;
      await new Promise<void>((resolve) => {
        this.completionWaiters.add(resolve);
      });
    }
  }

  private async ownerEnding(event: TurnEnding, ctx: Pick<TurnHookContext, 'append'>): Promise<void> {
    const turn = this.turn;
    if (turn === undefined || turn.machine.id !== event.turn.id) return;
    if (event.turn.outcome.type === 'blocked' && event.turn.outcome.at === 'turn.starting') {
      this.settleBlockedTurn(turn, ctx);
      return;
    }
    this.announceTurn(turn);
    if (event.at === 'requesting') {
      this.mailbox.restore(event.uncommitted.filter(
        (item): item is TurnMessage & { readonly kind: 'remind' } => item.kind === 'remind',
      ));
    }
    if (event.turn.outcome.type !== 'aborted') return;
    for (const message of this.mailbox.drainReminders()) ctx.append({ kind: 'remind', message });
  }

  flushReminders(): void {
    if (!this.open()) return;
    this.actor.act(() => {
      if (!this.open()) return;
      const messages = this.mailbox.drainReminders();
      for (const message of messages) {
        this.record({
          type: 'message.appended',
          turnId: this.turn?.machine.id ?? this.durable.nextTurnId,
          step: this.turn?.machine.state.step ?? 0,
          source: 'remind',
          message,
        });
      }
    });
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

  private continueTurn(ctrl: LoopControl, force: boolean): void {
    if (ctrl.state.status !== 'idle') return;
    const unfinished = this.durable.unfinished;
    if (unfinished !== undefined && isResumable(this.durable)) {
      this.settleUnfinished({ type: 'continue', cause: CRASHED });
      this.activate(ctrl, {
        id: unfinished.turnId,
        kind: 'resume',
        trigger: unfinished.trigger,
        initialPending: [],
        promptOnly: false,
        bypassMaxSteps: false,
        step: unfinished.step,
      });
      return;
    }
    this.closeUnfinished();
    if (!this.mailbox.hasTrigger && (force || canContinue(this.durable.messages))) {
      this.activate(ctrl, {
        id: this.durable.nextTurnId,
        kind: 'continue',
        trigger: 'continue',
        initialPending: [],
        promptOnly: false,
        bypassMaxSteps: false,
        step: 0,
      });
      return;
    }
    this.held = false;
  }

  private finishTurn(turn: RunningTurn, outcome: TurnOutcome): void {
    if (this.turn !== turn) return;
    this.actor.act((ctrl) => {
      if (this.turn !== turn) return;
      this.announceTurn(turn);
      for (const [key, slot] of this.tools) {
        if (slot.turnId !== turn.machine.id || slot.detached) continue;
        slot.done = true;
        this.tools.delete(key);
        this.notifyTool(slot);
      }
      const batch = this.toolBatch;
      if (batch?.turnId === turn.machine.id) {
        this.toolBatch = undefined;
        batch.resolve({
          outcomes: batch.calls.map((_, index) => batch.outcomes[index] ?? null),
          failure: batch.failure,
        });
      }
      if (this.completedToolBatch?.turnId === turn.machine.id) this.completedToolBatch = undefined;
      this.completionHandoff = false;
      if (outcome.type === 'aborted' && turn.continueAfterAbort === true && !this.actor.closing) this.held = false;
      ctrl.setState({ status: 'idle' });
      ctrl.afterDeliver(() => {
        if (turn.completion === undefined) return;
        if (turn.signal !== undefined && turn.onAbort !== undefined) {
          turn.signal.removeEventListener('abort', turn.onAbort);
        }
        turn.completion.resolve(turn.machine.state.outcome ?? { type: 'aborted' });
      });
    });
  }

  private closeRuntime(ctrl: LoopControl): Promise<void> | void {
    this.closeDetached();
    const turn = turnOf(ctrl.state);
    if (turn !== undefined) this.closeTurn(turn);
    if (turn === undefined && !this.hasDetachedTools) return;
    return (async () => {
      await Promise.all([
        turn?.machine.done ?? Promise.resolve({ type: 'aborted' as const }),
        new Promise<void>((resolve) => {
          if (!this.hasDetachedTools) {
            resolve();
            return;
          }
          this.detachedCloseWaiters.add(resolve);
        }),
      ]);
      if (this.closeFailure !== undefined) throw this.closeFailure.error;
    })();
  }

  private closeTurn(turn: RunningTurn): void {
    const outcome = turn.machine.state.outcome;
    const reason = outcome?.type === 'aborted' ? outcome.reason : CLOSED;
    if (outcome?.type !== 'aborted') this.releaseTurn(turn);
    turn.machine.abort(reason, { force: true });
  }

  private executeToolBatch(batch: TurnToolBatch): TurnToolBatchResult | Promise<TurnToolBatchResult> {
    if (batch.blocked !== undefined) {
      return this.transition(() => {
        // jscpd:ignore-start
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
        // jscpd:ignore-end
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
      // jscpd:ignore-start
      const outcomes = batch.calls.map(({ toolCall }) => {
        this.record({ type: 'tool.started', turnId: batch.turnId, step: batch.step, toolCall });
        const outcome = abortedToolOutcome(toolCall, reason);
        this.record({ type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
        return outcome;
      });
      const result = { outcomes };
      this.completedToolBatch = { turnId: batch.turnId, step: batch.step, result };
      return result;
      // jscpd:ignore-end
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
    const prepared = this.actor.bind(() => this.announceTool(slot));
    const responded = this.actor.bind((_ctrl, response: ToolExecutionResponse) => this.respondToTool(slot, response));
    const failed = this.actor.bind((_ctrl, error: unknown) => this.failTool(slot, error));
    const completed = this.actor.bind((_ctrl, result: ToolResult) => this.completeTool(slot, result));
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
      responded(response);
    }, (error: unknown) => {
      unsubscribe();
      failed(error);
    });
    void slot.handler.wait().then((result) => {
      unsubscribe();
      completed(result);
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
      const settled = this.actor.bind((_ctrl, settledOutcome: AsyncToolOutcome, message: UserMessage) => {
        this.completeDetached(slot, settledOutcome, message);
      });
      if (completion === undefined) {
        const message = completionMessage(slot.toolCall, outcome, result);
        slot.completionMessage = Promise.resolve(message);
        settled(outcome, message);
      } else {
        slot.completionMessage = resolveCompletionMessage({
          toolCall: slot.toolCall,
          outcome,
          result,
        }, completion);
        void slot.completionMessage.then((message) => {
          settled(outcome, message);
        }, (error: unknown) => {
          if (this.phase === 'closed') {
            this.closeDetached();
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
            settled(failed, message);
          });
        });
      }
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
    if (drained && !this.resetting) this.held = false;
    this.notifyCompletionWaiters();
  }

  private notifyCompletionWaiters(): void {
    if (this.hasPendingCompletions || this.completionWaiters.size === 0) return;
    const waiters = Array.from(this.completionWaiters);
    this.completionWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private notifyDetachedCloseWaiters(): void {
    if ((this.hasDetachedTools && this.closeFailure === undefined) || this.detachedCloseWaiters.size === 0) return;
    const waiters = Array.from(this.detachedCloseWaiters);
    this.detachedCloseWaiters.clear();
    for (const resolve of waiters) resolve();
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
    for (const slot of this.tools.values()) {
      if (!slot.detached) continue;
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
    if (closing.length === 0) return;
    const completed = this.actor.bind((
      _ctrl,
      completions: readonly {
        readonly slot: LiveTool;
        readonly outcome: AsyncToolOutcome;
        readonly message: UserMessage;
        readonly failure?: { readonly error: unknown };
      }[],
    ) => {
      this.completeDetachedClose(completions);
      const failure = completions.find((item) => item.failure !== undefined)?.failure;
      if (failure !== undefined) this.failClose(failure.error);
    });
    const failed = this.actor.bind((_ctrl, error: unknown) => this.failClose(error));
    void Promise.all(closing.map(async ({ slot, outcome, message }) => {
      try {
        return { slot, outcome, message: await message, failure: undefined };
      } catch (error) {
        const failedOutcome: AsyncToolOutcome = { type: 'failed', error };
        const input = { toolCall: slot.toolCall, outcome: failedOutcome, result: slot.result };
        let terminalMessage: UserMessage;
        const completion = slot.completion ?? this.completionFactory;
        try {
          terminalMessage = completion?.onRejected === undefined
            ? completionMessage(slot.toolCall, failedOutcome, slot.result)
            : await completion.onRejected(error, input);
        } catch {
          terminalMessage = completionMessage(slot.toolCall, failedOutcome, slot.result);
        }
        return { slot, outcome: failedOutcome, message: terminalMessage, failure: { error } };
      }
    })).then(completed, failed);
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
    this.notifyCompletionWaiters();
    this.notifyDetachedCloseWaiters();
  }

  private failClose(error: unknown): void {
    if (this.closeFailure === undefined) this.closeFailure = { error };
    this.notifyDetachedCloseWaiters();
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
