import type { HistoryMessage, UserEntry } from '#human/agent/turn';
import type { ToolDescription } from '#human/llm/message';
import { errorText } from '#human/llm/protocol/errors';
import type { LlmOutcome } from '#human/llm/response';
import { createPolicyRegistry, type PolicyRegistry } from '#human/llm/policy/registry';
import { isToolExecutorHost, type ToolExecutor, type ToolHookFailure, type ToolHookPoint } from '#human/tool/executor';
import { createAbortScope, withAbort, type AbortScope } from '#human/utils/abort';
import { waitEvent, type WaitOpts } from '#human/utils/wait';
import type { CreateLoopOptions, Loop } from './create-loop';
import type { LoopCommand, LoopInput, UnfinishedTurn } from './contract/command';
import type { LoopAck, LoopEmitted } from './contract/emitted';
import type { HookLifecycleEvent, HookPoint } from './contract/hook';
import type { QueuedItem, RemindEntry } from './contract/inbox';
import { CLOSED, type TurnOutcome } from './contract/outcome';
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
import {
  allSettled,
  assistantEntryOf,
  closeUnfinished,
  cont,
  createTransaction,
  createTurn,
  draftOutcome,
  editable,
  effect,
  initialState,
  normalizeUserEntry,
  patch,
  queueNotify,
  record,
  release,
  restorePending,
  schedule,
  settle,
  start,
  steer,
  viewOf,
  type AgentState,
  type AppendedItem,
  type LiveTool,
  type LiveTurn,
  type LoopState,
  type StateOutput,
  type StateTx,
  type StepState,
  type TurnCompletion,
} from './state';
import { executeLoopTool, type ToolExecOutput } from './tool/execute';
import { abortedToolOutput } from '#/agent/toolExecutor/toolExecutorService';
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

export class AgentMachine implements Loop {
  readonly executor: ToolExecutor;
  readonly hooks: HookRegistry;
  readonly policy: PolicyRegistry;
  readonly waitForTasks: WaitForTasks;

  private readonly registry: ReturnType<typeof createHookRegistry>;
  private readonly root: AbortScope = createAbortScope();
  private readonly outputs: StateOutput[] = [];
  private readonly listeners = new Set<(event: LoopEmitted) => void>();
  private readonly idleWaiters = new Set<() => void>();
  private readonly adjudicates: boolean;
  private readonly abortGraceMs: number;
  private readonly onListenerError?: CreateLoopOptions['onListenerError'];
  private context: AgentState;
  private factory: TurnExecutionFactory | undefined;
  private execution: TurnExecution | undefined;
  private executionError: unknown;
  private revision = 0;
  private readonly mediaRecovery = createMediaRecoveryStore();
  private flushing = false;
  private closeCompletion?: Deferred<void>;

  constructor(options: CreateLoopOptions) {
    const input = options.input ?? {};
    const invalid = inputError(input);
    if (invalid !== undefined) throw new TypeError(invalid);
    this.revision = input.historyRevision ?? 0;
    this.context = initialState(input);
    this.factory = options.createTurnExecution;
    this.executor = options.executor;
    this.adjudicates = options.executor.adjudicates === true || isToolExecutorHost(options.executor);
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
      Array.from(this.context.tools.values()).filter((slot) => slot.detached && !slot.done),
    );
    this.registry.attach((event) => this.hookChanged(event));
  }

  get state(): LoopState {
    return viewOf(this.context);
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
    return this.context.phase !== 'closed';
  }

  private createExecution(turn: LiveTurn): TurnExecution {
    const factory = this.factory;
    if (factory === undefined) throw new Error('loop has no requester');
    const profile = this.context.durable.profile;
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

  private transact<T>(body: (tx: StateTx) => T): T {
    const tx = createTransaction(this.context, this.root);
    const result = body(tx);
    for (const output of tx.out) {
      if (output.type === 'event' && output.event.type === 'context.settled') this.revision += 1;
    }
    this.context = tx.ctx;
    this.outputs.push(...tx.out);
    try {
      this.flush();
    } finally {
      this.settleIdle();
    }
    return result;
  }

  private flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    let failed = false;
    let failure: unknown;
    const capture = (error: unknown): void => {
      if (failed) return;
      failed = true;
      failure = error;
    };
    try {
      for (let output = this.outputs.shift(); output !== undefined; output = this.outputs.shift()) {
        if (output.type === 'start') {
          const { turn } = output;
          if (this.context.turn === turn && this.context.phase === 'running') {
            void this.executeTurn(turn).catch((error: unknown) => this.fail(turn, error));
          }
          continue;
        }
        if (output.type === 'effect') {
          try {
            output.effect();
          } catch (error) {
            capture(error);
          }
          continue;
        }
        for (const listener of Array.from(this.listeners)) {
          try {
            listener(output.event);
          } catch (error) {
            if (this.onListenerError === undefined) capture(error);
            else {
              try {
                this.onListenerError(error, output.event);
              } catch (listenerError) {
                capture(listenerError);
              }
            }
          }
        }
      }
    } finally {
      this.flushing = false;
    }
    if (failed) throw failure;
  }

  private settleIdle(): void {
    if (this.context.phase === 'running' || this.idleWaiters.size === 0) return;
    const waiters = Array.from(this.idleWaiters);
    this.idleWaiters.clear();
    for (const resolve of waiters) resolve();
  }

  private hookChanged(event: HookLifecycleEvent): void {
    if (!this.open()) return;
    this.transact((tx) => {
      record(tx, event);
    });
  }

  submit(entry: UserEntry): LoopAck<'prompt.submitted'> | undefined {
    const normalized = normalizeUserEntry(entry);
    this.check({ type: 'input.submit', entry: normalized });
    if (!this.open()) return undefined;
    return this.transact((tx) => {
      patch(tx, { inbox: { ...tx.ctx.inbox, normal: [...tx.ctx.inbox.normal, normalized] } });
      const ack = record(tx, { type: 'prompt.submitted', entry: normalized });
      release(tx);
      return ack;
    });
  }

  notify(entry: UserEntry): LoopAck<'prompt.notified'> | undefined {
    const normalized = normalizeUserEntry(entry);
    this.check({ type: 'input.notify', entry: normalized });
    if (!this.open()) return undefined;
    return this.transact((tx) => {
      patch(tx, { inbox: { ...tx.ctx.inbox, notify: [...tx.ctx.inbox.notify, normalized] } });
      const ack = record(tx, { type: 'prompt.notified', entry: normalized });
      release(tx);
      return ack;
    });
  }

  remind(...entries: readonly RemindEntry[]): LoopAck<'prompt.reminded'> | undefined {
    for (const entry of entries) this.check({ type: 'input.remind', entry });
    if (!this.open() || entries.length === 0) return undefined;
    return this.transact((tx) => {
      patch(tx, { inbox: { ...tx.ctx.inbox, remind: [...tx.ctx.inbox.remind, ...entries] } });
      let ack: LoopAck<'prompt.reminded'> | undefined;
      for (const entry of entries) ack = record(tx, { type: 'prompt.reminded', entry });
      return ack;
    });
  }

  steer(promptIds: readonly string[]): LoopAck<'prompt.steered'> | undefined {
    this.check({ type: 'input.steer', promptIds });
    if (!this.open()) return undefined;
    return this.transact((tx) => steer(tx, promptIds));
  }

  cancel(promptId: string): LoopAck<'prompt.canceled'> | undefined {
    this.check({ type: 'input.cancel', promptId });
    if (!this.open()) return undefined;
    return this.transact((tx) => {
      const normal = tx.ctx.inbox.normal.filter((entry) => entry.meta?.promptId !== promptId);
      const canceled = normal.length !== tx.ctx.inbox.normal.length;
      patch(tx, { inbox: { ...tx.ctx.inbox, normal } });
      return record(tx, { type: 'prompt.canceled', promptId, canceled });
    });
  }

  continue(): void {
    if (!this.open()) return;
    this.transact((tx) => {
      cont(tx);
    });
  }

  abort(reason?: unknown): void {
    if (!this.open()) return;
    this.transact((tx) => {
      if (tx.ctx.phase === 'idle') {
        closeUnfinished(tx);
        return;
      }
      const turn = tx.ctx.turn;
      if (turn !== undefined) this.requestAbort(tx, turn, reason);
    });
  }

  abortTool(toolCallId: string, reason?: unknown): void {
    this.check({ type: 'input.abort_tool', toolCallId });
    if (!this.open()) return;
    this.transact((tx) => {
      for (const slot of this.context.tools.values()) {
        if (slot.toolCall.id === toolCallId && !slot.done) effect(tx, () => slot.scope.abort(reason));
      }
    });
  }

  detachTool(toolCallId: string, text?: string): void {
    this.check({ type: 'input.detach_tool', toolCallId });
    if (!this.open()) return;
    for (const slot of Array.from(this.context.tools.values())) {
      if (slot.toolCall.id === toolCallId && !slot.detached) {
        this.detach(slot, text ?? `moved to background by the user: ${slot.toolCall.name} (tool_call_id=${toolCallId})`);
      }
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
    return this.transact((tx) => {
      if (!editable(tx.ctx) && reason !== 'compaction' && reason !== 'clear' && reason !== 'context.clear') {
        return record(tx, { type: 'context.rejected', messages, reason });
      }
      if (reason === 'compaction') patch(tx, { inbox: { ...tx.ctx.inbox, remind: [] } });
      return record(tx, { type: 'context.settled', messages, reason });
    });
  }

  setSystemPrompt(systemPrompt: string): LoopAck<'system_prompt.settled'> | undefined {
    this.check({ type: 'input.set_system_prompt', systemPrompt });
    if (!this.open()) return undefined;
    return this.transact((tx) => record(tx, { type: 'system_prompt.settled', systemPrompt }));
  }

  setTools(tools: readonly ToolDescription[]): LoopAck<'tools.settled'> | undefined {
    this.check({ type: 'input.set_tools', tools });
    if (!this.open()) return undefined;
    return this.transact((tx) => record(tx, { type: 'tools.settled', tools: [...tools] }));
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
      if (!this.open() || this.context.phase !== 'idle') {
        return Promise.reject(new Error('runTurn is only accepted while idle'));
      }
      const completion = turnCompletion();
      this.transact((tx) => {
        closeUnfinished(tx);
        const turn = createTurn(this.root, {
          id: tx.ctx.durable.nextTurnId,
          trigger: 'normal',
          step: 0,
          pending: [
            { kind: 'normal', entry },
            ...tx.ctx.inbox.remind.map((reminder) => ({
              kind: 'remind' as const,
              entry: reminder,
            })),
          ],
          completion,
          ...(signal === undefined ? {} : { signal }),
        });
        if (signal !== undefined) {
          turn.onAbort = () => {
            if (this.context.turn !== turn || !this.open()) return;
            this.transact((current) => {
              if (current.ctx.turn === turn) this.requestAbort(current, turn, signal.reason);
            });
          };
          signal.addEventListener('abort', turn.onAbort, { once: true });
        }
        patch(tx, { inbox: { ...tx.ctx.inbox, remind: [] } });
        record(tx, { type: 'prompt.submitted', entry });
        start(tx, turn);
      });
      return completion.promise;
    } catch (error) {
      return Promise.reject(error);
    }
  }

  waitForIdle(): Promise<void> {
    if (this.context.phase !== 'running') return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.add(resolve);
    });
  }

  close(): Promise<void> {
    if (this.closeCompletion !== undefined) return this.closeCompletion.promise;
    const completion = deferred<void>();
    this.closeCompletion = completion;
    try {
      this.transact((tx) => {
        if (tx.ctx.phase !== 'closed') {
          patch(tx, { phase: 'closed' });
          const turn = tx.ctx.turn;
          if (turn !== undefined) this.closeTurn(tx, turn);
          this.closeDetached(tx);
          effect(tx, () => this.root.abort());
        }
        effect(tx, () => completion.resolve());
      });
    } catch (error) {
      completion.reject(error);
    }
    return completion.promise;
  }

  private isCurrent(turn: LiveTurn): boolean {
    return this.context.turn === turn && this.context.phase === 'running';
  }

  private isCurrentStep(turn: LiveTurn, step: StepState, phase?: LiveTurn['phase']): boolean {
    return this.isCurrent(turn) && this.context.step === step && (phase === undefined || turn.phase === phase);
  }

  private announceTurn(tx: StateTx, turn: LiveTurn): void {
    if (turn.announced) return;
    turn.announced = true;
    if (turn.resumed === true) record(tx, { type: 'turn.resumed', turnId: turn.id, step: turn.step });
    else record(tx, {
      type: 'turn.started',
      turnId: turn.id,
      trigger: turn.trigger,
      promptOnly: turn.promptOnly,
      entry: turn.promptOnly === true
        ? turn.pending.find((item): item is Extract<QueuedItem, { kind: 'normal' | 'notify' }> => item.kind !== 'remind')?.entry
        : undefined,
    });
  }

  private report(
    tx: StateTx,
    point: HookPoint | ToolHookPoint,
    turn: LiveTurn,
    reports: readonly HookFailureReport[],
    notify: boolean,
  ): void {
    const entries: UserEntry[] = [];
    for (const { failure, entry } of reports) {
      record(tx, hookFailedEvent(point, turn.id, turn.step, failure));
      record(tx, { type: 'prompt.notified', entry });
      entries.push(entry);
      if (failure.paused && failure.hookId !== undefined) {
        const hookId = failure.hookId;
        effect(tx, () => this.registry.suspend(hookId));
      }
    }
    if (notify) queueNotify(tx, entries);
  }

  private releaseTurn(tx: StateTx, turn: LiveTurn, outcome: TurnOutcome): void {
    const pending = turn.pending;
    turn.pending = [];
    turn.outcome = outcome;
    patch(tx, { inbox: restorePending(tx.ctx.inbox, pending), held: true });
  }

  private settleBlockedTurn(
    tx: StateTx,
    turn: LiveTurn,
    outcome: Extract<TurnOutcome, { type: 'blocked' }>,
  ): void {
    const pending = turn.pending;
    turn.pending = [];
    turn.outcome = outcome;
    const inbox = restorePending(tx.ctx.inbox, pending.filter((item) => item.kind === 'notify'));
    const reminders = [
      ...pending.flatMap((item) => item.kind === 'remind' ? [item.entry] : []),
      ...inbox.remind,
    ];
    patch(tx, { inbox: { ...inbox, remind: [] }, held: true });
    this.announceTurn(tx, turn);
    for (const item of pending) {
      if (item.kind === 'normal') {
        record(tx, { type: 'message.appended', turnId: turn.id, step: 0, source: 'normal', entry: item.entry });
      }
    }
    for (const entry of reminders) {
      record(tx, { type: 'message.appended', turnId: turn.id, step: 0, source: 'remind', entry });
    }
  }

  private requestAbort(tx: StateTx, turn: LiveTurn, reason: unknown): void {
    if (turn.outcome?.type === 'aborted') {
      if (turn.abortGrace !== undefined) clearTimeout(turn.abortGrace);
      effect(tx, () => this.expireAbort(turn));
      return;
    }
    this.releaseTurn(tx, turn, { type: 'aborted', reason });
    if (tx.ctx.step !== undefined) tx.ctx.step.outcome = { type: 'aborted', reason };
    effect(tx, () => turn.scope.abort(reason));
    for (const slot of tx.ctx.tools.values()) {
      if (slot.turnId === turn.id && !slot.detached && !slot.done) {
        effect(tx, () => slot.scope.abort(reason));
      }
    }
    if (turn.phase === 'requesting' || turn.phase === 'acting') {
      effect(tx, () => {
        turn.abortGrace = setTimeout(() => this.expireAbort(turn), this.abortGraceMs);
      });
      return;
    }
    if (turn.phase === 'batching') effect(tx, () => this.expireToolsAndFinish(turn));
    else effect(tx, () => this.finishTurn(turn));
  }

  private expireAbort(turn: LiveTurn): void {
    if (!this.isCurrent(turn) || turn.outcome?.type !== 'aborted') return;
    const step = this.context.step;
    if (turn.phase === 'requesting' && step !== undefined) {
      this.completeRequest(turn, step, { type: 'aborted', message: null, usage: undefined, reason: undefined });
      return;
    }
    if (turn.phase === 'acting' || turn.phase === 'batching') {
      this.expireToolsAndFinish(turn);
      return;
    }
    this.finishTurn(turn);
  }

  private fail(turn: LiveTurn, error: unknown): void {
    if (this.context.turn !== turn) return;
    this.transact((tx) => {
      turn.outcome = { type: 'failed', error };
      if (tx.ctx.step !== undefined) tx.ctx.step.outcome = { type: 'failed', error };
      this.finishTurnTx(tx, turn);
    });
  }

  private async executeTurn(turn: LiveTurn): Promise<void> {
    if (!this.isCurrent(turn)) return;
    if (turn.outcome?.type === 'aborted') {
      this.finishTurn(turn);
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
      this.transact((tx) => {
        this.announceTurn(tx, turn);
        if (tx.ctx.inbox.notify.length > 0) {
          turn.outcome = { type: 'done', cause: { by: 'loop', reason: 'notify' } };
        }
      });
      if (turn.outcome?.type === 'done') this.finishTurn(turn);
      else this.startStep(turn);
      return;
    }
    let run: TurnStartingRun;
    try {
      run = await runTurnStarting(
        this.registry,
        { turnId: turn.id, trigger: turn.trigger, pending: turn.pending },
        turn.scope.signal,
      );
    } catch (error) {
      run = { failures: [runtimeFailure(error)] };
    }
    if (!this.isCurrent(turn)) return;
    const blocked = run.blocked;
    this.transact((tx) => {
      const reports = hookFailureReports('turn.starting', run.failures);
      turn.pending.push(...reports.map(({ entry }) => ({ kind: 'notify' as const, entry })));
      this.report(tx, 'turn.starting', turn, reports, false);
      if (blocked !== undefined) this.settleBlockedTurn(tx, turn, { type: 'blocked', at: 'turn.starting', cause: blocked });
      else this.announceTurn(tx, turn);
    });
    if (blocked !== undefined) {
      this.finishTurn(turn);
      return;
    }
    await this.appendPending(turn);
  }

  private async appendPending(turn: LiveTurn): Promise<void> {
    if (!this.isCurrent(turn)) return;
    this.transact(() => {
      turn.phase = 'appending';
    });
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
    if (!this.isCurrent(turn)) return;
    this.transact((tx) => {
      turn.pending = [];
      for (const item of appended) {
        if ('failure' in item) {
          this.report(tx, 'message.appending', turn, [{ failure: item.failure, entry: item.entry }], false);
        }
        record(tx, {
          type: 'message.appended',
          turnId: turn.id,
          step: turn.step,
          source: item.source,
          entry: item.entry,
          ...('blocked' in item && item.blocked !== undefined ? { blocked: item.blocked } : {}),
        });
      }
    });
    this.startStep(turn);
  }

  private startStep(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    if (turn.outcome?.type === 'aborted') {
      this.finishTurn(turn);
      return;
    }
    const step: StepState = { calls: [], settled: {} };
    this.transact((tx) => {
      turn.step += 1;
      turn.phase = 'stepStarting';
      patch(tx, { step });
      if (turn.promptOnly !== true) record(tx, { type: 'step.started', turnId: turn.id, step: turn.step });
    });
    void this.runStepStarting(turn, step);
  }

  private async runStepStarting(turn: LiveTurn, step: StepState): Promise<void> {
    let run: StepStartingRun;
    try {
      run = await runStepStarting(
        this.registry,
        {
          turnId: turn.id,
          step: turn.step,
          messages: this.context.durable.messages,
          profile: this.context.durable.profile,
        },
        turn.scope.signal,
      );
    } catch (error) {
      run = { messages: this.context.durable.messages, failures: [runtimeFailure(error)] };
    }
    if (!this.isCurrentStep(turn, step, 'stepStarting')) return;
    this.transact((tx) => {
      const reports = hookFailureReports('step.starting', run.failures);
      if (run.rewrittenBy !== undefined) {
        record(tx, { type: 'context.settled', messages: [...run.messages], reason: run.rewrittenBy });
      }
      this.report(tx, 'step.starting', turn, reports, true);
      if (run.blocked !== undefined) {
        step.outcome = { type: 'blocked', at: 'step.starting', cause: run.blocked };
        turn.outcome = step.outcome;
      } else if (turn.promptOnly === true) {
        step.outcome = { type: 'done', cause: { by: 'loop', reason: 'prompt_only' } };
        turn.outcome = step.outcome;
      } else {
        turn.phase = 'requesting';
      }
    });
    if (run.blocked !== undefined || turn.promptOnly === true) {
      this.finishStep(turn, step);
      return;
    }
    this.appendReminders(turn, step);
    let execution = this.execution;
    if (execution === undefined) {
      this.fail(turn, this.executionError ?? new Error('turn has no execution'));
      return;
    }
    if (execution.prepare !== undefined) {
      let profile = execution.profile;
      try {
        profile = await execution.prepare(turn.scope.signal);
      } catch (error) {
        if (!turn.scope.signal.aborted) {
          this.fail(turn, error);
          return;
        }
        turn.outcome = { type: 'aborted', reason: turn.scope.signal.reason };
        this.finishTurn(turn);
        return;
      }
      if (!this.isCurrentStep(turn, step)) return;
      if (turn.scope.signal.aborted) {
        turn.outcome = { type: 'aborted', reason: turn.scope.signal.reason };
        this.finishTurn(turn);
        return;
      }
      if (profile.tools !== undefined) this.setTools(profile.tools);
      execution = { ...execution, profile, prepare: undefined };
      this.execution = execution;
    }
    const outcome = await runLoopRequest(
      { ...execution, requester: execution.requester.with({ policy: this.policy.asPolicy() }) },
      {
        messages: [...this.context.durable.messages],
        signal: turn.scope.signal,
      },
      (event) => this.requestProgress(turn, step, event),
    );
    this.completeRequest(turn, step, outcome);
  }

  flushReminders(): void {
    if (!this.open()) return;
    const turn = this.context.turn;
    this.transact((tx) => {
      const entries = tx.ctx.inbox.remind;
      if (entries.length === 0) return;
      patch(tx, { inbox: { ...tx.ctx.inbox, remind: [] } });
      for (const entry of entries) {
        record(tx, {
          type: 'message.appended',
          turnId: turn?.id ?? tx.ctx.durable.nextTurnId,
          step: turn?.step ?? 0,
          source: 'remind',
          entry: (entry),
        });
      }
    });
  }

  private appendReminders(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    this.transact((tx) => {
      const entries = tx.ctx.inbox.remind;
      if (entries.length === 0) return;
      patch(tx, { inbox: { ...tx.ctx.inbox, remind: [] } });
      for (const entry of entries) {
        record(tx, { type: 'message.appended', turnId: turn.id, step: turn.step, source: 'remind', entry });
      }
    });
  }

  private requestProgress(turn: LiveTurn, step: StepState, event: LoopRequestProgress): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    this.transact((tx) => {
      if (event.type === 'llm.prepared') step.model = event.model;
      else record(tx, event);
    });
  }

  private completeRequest(turn: LiveTurn, step: StepState, outcome: LlmOutcome): void {
    if (!this.isCurrentStep(turn, step, 'requesting')) return;
    this.transact((tx) => {
      step.llm = outcome;
      const toolCalls = outcome.type === 'done' ? outcome.message.toolCalls : [];
      step.calls.push(
        ...toolCalls.map((toolCall, index) => ({ key: `${turn.id}:${turn.step}:${index}`, toolCall })),
      );
      record(tx, { type: 'llm.ended', outcome });
      const entry = assistantEntryOf(outcome, step.model);
      if (entry !== undefined) {
        record(tx, {
          type: 'message.appended',
          turnId: turn.id,
          step: turn.step,
          source: outcome.type === 'failed' ? 'partial' : 'llm',
          entry,
        });
      }
      if (toolCalls.length > 0) turn.phase = 'batching';
      else if (turn.outcome?.type !== 'aborted') turn.phase = 'ending';
    });
    if (step.calls.length > 0) {
      void this.runBatch(turn, step);
      return;
    }
    if (turn.outcome?.type === 'aborted') this.finishStep(turn, step);
    else void this.runStepEnding(turn, step);
  }

  private async runBatch(turn: LiveTurn, step: StepState): Promise<void> {
    if (turn.outcome?.type === 'aborted') {
      this.startActing(turn, step);
      return;
    }
    let run: ToolBatchStartingRun;
    try {
      run = await runToolBatchStarting(
        this.registry,
        {
          turnId: turn.id,
          step: turn.step,
          toolCalls: step.calls.map((call) => call.toolCall),
        },
        turn.scope.signal,
      );
    } catch (error) {
      run = { failures: [runtimeFailure(error)] };
    }
    if (!this.isCurrentStep(turn, step, 'batching')) return;
    this.transact((tx) => {
      const reports = hookFailureReports('tool.batch-starting', run.failures);
      if (run.blocked !== undefined) {
        const blocked = run.blocked;
        for (const { key, toolCall } of step.calls) {
          const outcome = blockedToolOutcome(toolCall, blocked.cause, blocked.result);
          record(tx, { type: 'tool.started', turnId: turn.id, step: turn.step, toolCall });
          record(tx, { type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
          step.settled[key] = outcome.entry;
        }
      }
      this.report(tx, 'tool.batch-starting', turn, reports, true);
      turn.phase = 'acting';
    });
    this.startActing(turn, step);
  }

  private startActing(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'acting')) return;
    const slots: LiveTool[] = [];
    this.transact((tx) => {
      if (turn.outcome?.type === 'aborted') {
        this.expireToolsTx(tx, turn, step, turn.outcome.reason);
        return;
      }
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
        tx.ctx.tools.set(call.key, slot);
        slots.push(slot);
        if (!this.adjudicates) {
          slot.announced = true;
          record(tx, { type: 'tool.started', turnId: turn.id, step: turn.step, toolCall: slot.toolCall });
        }
      }
    });
    for (const slot of slots) {
      if (!slot.done) void this.executeTool(slot);
    }
    if (allSettled(step)) this.completeActing(turn, step);
  }

  private async executeTool(slot: LiveTool): Promise<void> {
    const output = await executeLoopTool(this.executor, {
      toolCall: slot.toolCall,
      signal: slot.scope.signal,
      turnId: slot.turnId,
      step: slot.step,
      onAdjudicated: (toolCall) => {
        if (slot.done || this.context.tools.get(slot.key) !== slot) return;
        this.transact((tx) => {
          slot.toolCall = toolCall;
          if (!slot.announced) {
            slot.announced = true;
            record(tx, { type: 'tool.started', turnId: slot.turnId, step: slot.step, toolCall });
          }
        });
      },
      onHookFailure: (point: ToolHookPoint, failure: ToolHookFailure) => {
        if (slot.done || this.context.tools.get(slot.key) !== slot) return;
        this.transact((tx) => {
          record(tx, hookFailedEvent(point, slot.turnId, slot.step, failure));
          if (failure.paused && failure.hookId !== undefined) {
            const hookId = failure.hookId;
            effect(tx, () => this.registry.suspend(hookId));
          }
        });
      },
      onUpdate: (update) => {
        if (slot.done || slot.detached || this.context.tools.get(slot.key) !== slot) return;
        this.transact((tx) => {
          record(tx, { type: 'tool.delta', toolCallId: slot.toolCall.id, update });
        });
      },
      detach: (input) => this.detach(slot, typeof input === 'string' ? input : input.text),
    });
    this.completeTool(slot, output);
  }

  private detach(slot: LiveTool, text?: string): void {
    if (slot.done || slot.detached || this.context.tools.get(slot.key) !== slot) return;
    const turn = this.context.turn;
    const step = this.context.step;
    this.transact((tx) => {
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
      record(tx, { type: 'tool.ended', toolCallId: slot.toolCall.id, outcome, detached: true });
      if (turn?.id === slot.turnId && turn.step === slot.step && step !== undefined) settle(step, slot.key, outcome);
    });
    if (turn?.id === slot.turnId && turn.step === slot.step && step !== undefined && allSettled(step)) {
      this.completeActing(turn, step);
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
      slot.result = errorResult(abortedToolOutput(slot.toolCall.name, slot.reason));
    } else {
      slot.status = 'failed';
      slot.error = output.error;
      slot.result = output.result ?? errorResult(errorText(output.error));
    }
    const turn = this.context.turn;
    const step = this.context.step;
    this.transact((tx) => {
      tx.ctx.tools.delete(slot.key);
      effect(tx, () => this.notifyTool(slot));
      if (slot.detached) {
        const outcome = asyncOutcomeOf(slot);
        const entry = completionEntry(slot.toolCall, outcome, slot.result);
        record(tx, { type: 'tool.async_ended', toolCallId: slot.toolCall.id, outcome, entry });
        record(tx, { type: 'prompt.notified', entry });
        queueNotify(tx, [entry]);
        return;
      }
      if (turn?.id !== slot.turnId || turn.step !== slot.step || step === undefined) return;
      const outcome = toolOutcomeOf(slot);
      record(tx, { type: 'tool.ended', toolCallId: slot.toolCall.id, outcome, detached: false });
      settle(step, slot.key, outcome);
    });
    if (!slot.detached && turn?.id === slot.turnId && turn.step === slot.step && step !== undefined && allSettled(step)) {
      this.completeActing(turn, step);
    }
  }

  private notifyTool(slot: LiveTool): void {
    for (const notify of Array.from(slot.waiters)) notify();
  }

  private expireToolsTx(tx: StateTx, turn: LiveTurn, step: StepState, reason: unknown): void {
    for (const call of step.calls) {
      if (step.settled[call.key] !== undefined) continue;
      const slot = tx.ctx.tools.get(call.key);
      const toolCall = slot?.toolCall ?? call.toolCall;
      if (slot === undefined || !slot.announced) {
        record(tx, { type: 'tool.started', turnId: turn.id, step: turn.step, toolCall });
      }
      if (slot !== undefined) {
        slot.done = true;
        tx.ctx.tools.delete(call.key);
        effect(tx, () => this.notifyTool(slot));
      }
      const outcome = abortedToolOutcome(toolCall, reason);
      record(tx, { type: 'tool.ended', toolCallId: toolCall.id, outcome, detached: false });
      settle(step, call.key, outcome);
    }
  }

  private appendToolEntriesTx(tx: StateTx, turn: LiveTurn, step: StepState): void {
    const entries = step.calls.flatMap((call) => step.settled[call.key] ?? []);
    for (const entry of entries) {
      record(tx, { type: 'message.appended', turnId: turn.id, step: turn.step, source: 'tool', entry });
    }
  }

  private expireToolsAndFinish(turn: LiveTurn): void {
    if (!this.isCurrent(turn)) return;
    const step = this.context.step;
    if (step === undefined) {
      this.finishTurn(turn);
      return;
    }
    this.transact((tx) => {
      this.expireToolsTx(tx, turn, step, turn.outcome?.type === 'aborted' ? turn.outcome.reason : undefined);
      this.appendToolEntriesTx(tx, turn, step);
      this.finishStepTx(tx, turn, step);
    });
    this.finishTurn(turn);
  }

  private completeActing(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step, 'acting') || !allSettled(step)) return;
    this.transact((tx) => {
      this.appendToolEntriesTx(tx, turn, step);
      if (turn.outcome?.type === 'aborted') this.finishStepTx(tx, turn, step);
      else turn.phase = 'ending';
    });
    if (turn.outcome?.type === 'aborted') this.finishTurn(turn);
    else void this.runStepEnding(turn, step);
  }

  private async runStepEnding(turn: LiveTurn, step: StepState): Promise<void> {
    const draft = draftOutcome(step);
    let run: StepEndingRun;
    try {
      const input: StepEndingInput = {
        turnId: turn.id,
        step: turn.step,
        draft,
        messages: this.context.durable.messages,
      };
      run = await runStepEndingHooks(this.registry, input, turn.scope.signal);
    } catch (error) {
      run = {
        outcome: draft,
        failures: [{ point: draft.type === 'continue' ? 'step.continuing' : 'step.stopping', failure: runtimeFailure(error) }],
      };
    }
    if (!this.isCurrentStep(turn, step, 'ending')) return;
    this.transact((tx) => {
      step.outcome = run.outcome;
      if (run.outcome.type !== 'continue') turn.outcome = run.outcome;
      for (const { point, failure } of run.failures) {
        this.report(tx, point, turn, hookFailureReports(point, [failure]), true);
      }
    });
    this.finishStep(turn, step);
  }

  private finishStep(turn: LiveTurn, step: StepState): void {
    if (!this.isCurrentStep(turn, step)) return;
    this.transact((tx) => {
      this.finishStepTx(tx, turn, step);
    });
    if (turn.outcome?.type === 'aborted' || turn.phase === 'finished') this.finishTurn(turn);
    else this.startStep(turn);
  }

  private finishStepTx(tx: StateTx, turn: LiveTurn, step: StepState): void {
    const draft = step.outcome ?? { type: 'aborted' as const };
    const outcome = draft.type === 'continue' && tx.ctx.inbox.notify.length > 0
      ? { type: 'done' as const, cause: { by: 'loop', reason: 'notify' } }
      : draft;
    step.outcome = outcome;
    if (turn.promptOnly !== true) record(tx, { type: 'step.ended', turnId: turn.id, step: turn.step, outcome });
    patch(tx, { step: undefined });
    if (outcome.type === 'continue') return;
    turn.outcome = outcome;
    turn.phase = 'finished';
  }

  private finishTurn(turn: LiveTurn): void {
    if (this.context.turn !== turn) return;
    this.transact((tx) => {
      this.finishTurnTx(tx, turn);
    });
  }

  private finishTurnTx(tx: StateTx, turn: LiveTurn): void {
    if (tx.ctx.turn !== turn) return;
    if (turn.abortGrace !== undefined) clearTimeout(turn.abortGrace);
    this.announceTurn(tx, turn);
    if (tx.ctx.step !== undefined) this.finishStepTx(tx, turn, tx.ctx.step);
    for (const [key, slot] of tx.ctx.tools) {
      if (slot.turnId !== turn.id || slot.detached) continue;
      slot.done = true;
      tx.ctx.tools.delete(key);
      effect(tx, () => this.notifyTool(slot));
    }
    const outcome = turn.outcome ?? { type: 'aborted' as const };
    turn.phase = 'finished';
    record(tx, { type: 'turn.ended', turnId: turn.id, outcome });
    patch(tx, { turn: undefined, phase: tx.ctx.phase === 'closed' ? 'closed' : 'idle' });
    this.execution = undefined;
    if (turn.completion !== undefined) {
      const completion = turn.completion;
      effect(tx, () => {
        if (turn.signal !== undefined && turn.onAbort !== undefined) {
          turn.signal.removeEventListener('abort', turn.onAbort);
        }
        completion.resolve(outcome);
      });
    }
    schedule(tx);
  }

  private closeTurn(tx: StateTx, turn: LiveTurn): void {
    const reason = turn.outcome?.type === 'aborted' ? turn.outcome.reason : CLOSED;
    if (turn.outcome?.type !== 'aborted') this.releaseTurn(tx, turn, { type: 'aborted', reason: CLOSED });
    const step = tx.ctx.step;
    if (step !== undefined && step.outcome?.type !== 'aborted') step.outcome = { type: 'aborted', reason };
    effect(tx, () => turn.scope.abort(reason));
    if (turn.phase === 'requesting' && step !== undefined) {
      const outcome: LlmOutcome = { type: 'aborted', message: null, usage: undefined, reason: undefined };
      step.llm = outcome;
      record(tx, { type: 'llm.ended', outcome });
      const entry = assistantEntryOf(outcome, step.model);
      if (entry !== undefined) {
        record(tx, { type: 'message.appended', turnId: turn.id, step: turn.step, source: 'llm', entry });
      }
      this.finishStepTx(tx, turn, step);
    } else if ((turn.phase === 'batching' || turn.phase === 'acting') && step !== undefined) {
      this.expireToolsTx(tx, turn, step, reason);
      this.appendToolEntriesTx(tx, turn, step);
      this.finishStepTx(tx, turn, step);
    } else if (step !== undefined) {
      this.finishStepTx(tx, turn, step);
    }
    this.finishTurnTx(tx, turn);
  }

  private closeDetached(tx: StateTx): void {
    for (const [key, slot] of tx.ctx.tools) {
      if (!slot.detached) continue;
      slot.done = true;
      tx.ctx.tools.delete(key);
      const outcome = { type: 'aborted' as const, reason: CLOSED };
      record(tx, {
        type: 'tool.async_ended',
        toolCallId: slot.toolCall.id,
        outcome,
        entry: completionEntry(slot.toolCall, outcome),
      });
      effect(tx, () => this.notifyTool(slot));
    }
  }
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
    case 'input.set_tools':
      return arrayOf(command.tools, isToolDescription) ? undefined : TOOLS_ERROR;
    default:
      return undefined;
  }
}
