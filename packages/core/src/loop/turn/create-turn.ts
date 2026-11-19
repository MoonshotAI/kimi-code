import { createActor, type Actor, type ActorControl, type ProcessControl } from '#/actor/index';
import type { UserMessage } from '#/llm/message';
import type { LlmOutcome, LlmTiming } from '#/llm/response';
import { withAbort, type AbortScope } from '#/utils/abort';
import type { LlmMessageTiming } from '../contract/emitted';
import { STEERED, type Cause, type StepOutcome, type TurnOutcome } from '../contract/outcome';
import type { LoopProfile } from '../contract/profile';
import { hookFailureReports, runtimeFailure } from '#/hook/loop/failure';
import {
  runStepEnding as runStepEndingHooks,
  runStepStarting,
  runToolBatchStarting,
  type StepEndingInput,
  type StepEndingRun,
  type StepStartingRun,
  type ToolBatchStartingRun,
} from '#/hook/loop/run';
import { runLoopRequest, type FullLoopLlmRequester, type LoopRequestProgress } from '../request';
import type {
  Turn,
  TurnEmitted,
  TurnEnding,
  TurnHookContext,
  TurnInput,
  TurnMessage,
  TurnPhase,
  TurnRuntime,
  TurnState,
  TurnStep,
  TurnToolBatchResult,
} from './contract';

interface OwnerRun<D> {
  readonly decision?: D;
  readonly appended: readonly TurnMessage[];
}

function llmMessageTiming(timing: LlmTiming | undefined): LlmMessageTiming | undefined {
  if (timing === undefined) return undefined;
  return {
    llmFirstTokenLatencyMs: timing.firstTokenLatencyMs,
    llmStreamDurationMs: timing.streamDurationMs,
  };
}

type TurnControl = ActorControl<TurnState>;
type TurnProcess = ProcessControl<TurnState>;

function draftOutcome(step: TurnStep): StepOutcome {
  if (step.outcome !== undefined) return step.outcome;
  const llm = step.llm;
  if (llm === undefined) return { type: 'failed' };
  if (llm.type === 'aborted') return { type: 'aborted', reason: llm.reason };
  if (llm.type === 'failed') return { type: 'failed', error: llm.error };
  if (llm.message.toolCalls.length === 0) return { type: 'done' };
  return { type: 'continue' };
}

class ActorTurn implements Turn {
  readonly done: Promise<TurnOutcome>;

  private readonly scope: AbortScope;
  private readonly actor: Actor<TurnState>;
  private currentStep: TurnStep | undefined;
  private requester: FullLoopLlmRequester | undefined;
  private profile: LoopProfile | undefined;
  private requesterError: unknown;
  private requestId: string | undefined;
  private toolsSettled = false;
  private started = false;
  private abortFrom: 'created' | TurnPhase | undefined;
  private abortSettling = false;
  private abortGrace: ReturnType<typeof setTimeout> | undefined;
  private readonly expireAbortCallback: () => void;
  private activeBuffer: { active: boolean; messages: TurnMessage[] } | undefined;
  private uncommitted: TurnMessage[];
  private forceCloseRequested = false;
  private bypassCloseWait: (() => void) | undefined;
  private doneSettled = false;
  private resolveDone!: (outcome: TurnOutcome) => void;

  constructor(input: TurnInput, private readonly runtime: TurnRuntime) {
    this.scope = withAbort(runtime.signal);
    this.actor = createActor<TurnState>({
      initial: { ...input, phase: 'created' },
    });
    this.expireAbortCallback = this.actor.bind(() => this.expireAbort());
    this.uncommitted = [...input.initialPending];
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get id(): number {
    return this.state.id;
  }

  get state(): TurnState {
    return this.actor.state;
  }

  private get phase(): 'created' | TurnPhase {
    return this.actor.state.phase;
  }

  private get step(): number {
    return this.actor.state.step;
  }

  private get closing(): boolean {
    return this.phase === 'finishing';
  }

  private get finished(): boolean {
    return this.actor.state.phase === 'finished';
  }

  private setPhase(ctrl: TurnControl, phase: 'created' | TurnPhase, step = this.step): void {
    ctrl.setState({ ...ctrl.state, phase, step });
  }

  private setOutcome(ctrl: TurnControl, outcome: TurnOutcome): void {
    ctrl.setState({ ...ctrl.state, outcome });
  }

  start(): void {
    if (this.started || this.closing || this.finished) return;
    this.started = true;
    this.actor.act((ctrl) => {
      ctrl.spawn((proc) => this.execute(proc));
    });
  }

  interrupt(cause: Cause = STEERED): void {
    if (!this.started || this.closing || this.finished) return;
    this.actor.act(() => {
      if (!this.started || this.closing || this.finished) return;
      const step = this.currentStep;
      if (step === undefined || this.state.outcome?.type === 'aborted') return;
      if ((this.phase !== 'stepStarting' && this.phase !== 'requesting') || step.toolCallStreaming) return;
      step.steerRequested = true;
      step.scope.abort(cause);
    });
  }

  abort(reason?: unknown, options?: { readonly force?: boolean }): void {
    if (this.doneSettled || ((this.closing || this.finished) && options?.force !== true)) return;
    this.actor.act((ctrl) => {
      if (this.doneSettled) return;
      if (options?.force === true) {
        this.forceCloseRequested = true;
        this.bypassCloseWait?.();
      }
      if (this.closing || this.finished) return;
      if (!this.started) {
        this.started = true;
        this.abortFrom = 'created';
        this.setOutcome(ctrl, { type: 'aborted', reason });
        this.setPhase(ctrl, 'aborting');
        this.finishTurn();
        return;
      }
      if (this.state.outcome?.type === 'aborted') {
        if (options?.force === true) this.expireAbort();
        return;
      }
      const at = this.phase;
      this.abortFrom = at;
      this.setOutcome(ctrl, { type: 'aborted', reason });
      this.setPhase(ctrl, 'aborting');
      const step = this.currentStep;
      if (step !== undefined) {
        step.outcome = { type: 'aborted', reason };
        step.batch.aborted = { reason };
      }
      this.scope.abort(reason);
      if (step !== undefined && (at === 'batching' || at === 'acting')) {
        const result = this.runtime.abortBatch(step.batch, reason, options);
        if (result !== undefined) {
          this.completeToolBatch(step, result);
          this.finishTurn();
          return;
        }
      }
      if (at === 'requesting') {
        if (options?.force === true) {
          this.expireAbort();
        } else {
          this.abortGrace = setTimeout(this.expireAbortCallback, this.runtime.abortGraceMs ?? 2_500);
        }
        return;
      }
      if (at === 'acting') return;
      this.finishTurn();
    });
  }

  private async execute(proc: TurnProcess): Promise<void> {
    try {
      // 1. Snapshot the profile and requester once for the whole turn.
      const profile = this.runtime.read().profile;
      this.profile = {
        ...profile,
        tools: profile.tools === undefined ? undefined : [...profile.tools],
      };
      try {
        const requester = this.runtime.requester();
        this.requester = requester === undefined
          ? undefined
          : (this.runtime.decorateTurnRequester?.(requester) ?? requester);
      } catch (error) {
        this.requester = undefined;
        this.requesterError = error;
      }

      // 2. Let the owner run starting hooks and produce the initial message batch.
      this.setPhase(proc, 'starting');
      const starting = await proc.step(() => this.invokeOwner<Extract<TurnOutcome, { type: 'done' | 'blocked' }>>(
        'starting',
        this.state,
        this.scope.signal,
      ));
      if (!this.running()) return;

      // 3. A starting decision skips the initial commit and every later step.
      this.setPhase(proc, 'appending');
      if (starting.decision !== undefined) {
        this.uncommitted.push(...starting.appended);
        this.setOutcome(proc, starting.decision);
        return;
      }

      // 4. Commit one initial batch before entering the step loop.
      const appended = starting.appended.length > 0 ? starting.appended : this.state.initialPending;
      this.uncommitted = [];
      this.runtime.transition(() => {
        this.runtime.committed(this.id);
        for (const message of appended) this.commit(message);
      });
      if (!this.running()) return;

      // 5. Prompt-only turns finish after their initial append without requesting a model.
      if (this.state.promptOnly) {
        this.setOutcome(proc, { type: 'done', cause: { by: 'loop', reason: 'prompt_only' } });
        return;
      }

      // 6. Run complete steps until one produces a turn outcome or the turn closes.
      while (this.running() && this.state.outcome === undefined) {
        await this.executeStep(proc);
      }
    } catch (error) {
      // Preserve the first execution failure and let the shared close own terminal events.
      if (!this.closing && !this.finished) {
        this.setOutcome(proc, { type: 'failed', error });
        if (this.currentStep !== undefined) this.currentStep.outcome = { type: 'failed', error };
      }
    } finally {
      // Normal completion, failure, and abort all enter the same asynchronous close.
      this.finishTurn();
    }
  }

  private get point(): { readonly turnId: number; readonly step: number } {
    return { turnId: this.id, step: this.step };
  }

  private running(): boolean {
    return this.started && !this.closing && !this.finished;
  }

  private current(step: TurnStep): boolean {
    return this.running() && this.currentStep === step;
  }

  private accepts(step: TurnStep): boolean {
    return this.current(step) && this.phase !== 'aborting';
  }

  private acceptsAbort(step: TurnStep): boolean {
    return this.current(step) && this.phase === 'aborting';
  }

  private async invokeOwner<D>(
    point: 'starting' | 'requesting' | 'continuing',
    event: TurnState,
    signal: AbortSignal,
  ): Promise<OwnerRun<D>> {
    const hook = this.runtime.hooks[point] as ((event: never, ctx: TurnHookContext) => Promise<D | void>) | undefined;
    if (hook === undefined) return { appended: [] };
    const buffer: { active: boolean; messages: TurnMessage[] } = { active: true, messages: [] };
    this.activeBuffer = buffer;
    const close = (): void => {
      buffer.active = false;
      if (this.activeBuffer === buffer) this.activeBuffer = undefined;
    };
    try {
      const decision = await hook(event as never, {
        signal,
        append: (...messages) => {
          if (!buffer.active) throw new Error('turn hook context is no longer active');
          buffer.messages.push(...messages);
        },
      });
      return { decision: decision ?? undefined, appended: buffer.messages };
    } finally {
      close();
    }
  }

  private commit(message: TurnMessage): void {
    if (message.failure !== undefined) {
      this.runtime.report(
        'message.appending',
        this.point,
        [{ failure: message.failure, message: message.message as UserMessage }],
        false,
      );
    }
    this.runtime.emit({
      type: 'message.appended',
      ...this.point,
      source: message.kind,
      message: message.message,
      blocked: message.blocked,
    });
  }

  private emit(event: TurnEmitted): void {
    this.runtime.emit(event);
  }

  private async executeStep(proc: TurnProcess): Promise<void> {
    // 1. Create the step and publish its start before invoking any extension hook.
    const scope = withAbort(this.scope.signal);
    const number = this.step + 1;
    const step: TurnStep = {
      scope,
      batch: { turnId: this.id, step: number, calls: [], signal: scope.signal },
      steerRequested: false,
      toolCallStreaming: false,
    };
    this.setPhase(proc, 'stepStarting', number);
    this.currentStep = step;
    this.runtime.transition(() => {
      this.emit({ type: 'step.started', ...this.point });
    });
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return;

    // 2. Run step.starting and preserve its outcome before choosing the next phase.
    const starting = await proc.step(() => this.stepStarting(step));
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return;
    this.runtime.transition(() => {
      this.runtime.report(
        'step.starting',
        this.point,
        hookFailureReports('step.starting', starting.failures),
        true,
      );
      if (starting.blocked !== undefined) {
        step.outcome = { type: 'blocked', at: 'step.starting', cause: starting.blocked };
        this.setOutcome(proc, step.outcome);
      } else {
        this.setPhase(proc, 'requesting');
      }
    });
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return;

    // 3. A blocked start skips requesting and every regular step-ending hook.
    if (starting.blocked !== undefined) {
      this.finalizeStep(proc, step);
      return;
    }

    // 4. Let the owner settle completions, reminders, or a direct terminal decision.
    const requesting = await proc.step(() => this.invokeOwner<Extract<TurnOutcome, { type: 'done' }>>(
      'requesting',
      this.state,
      step.scope.signal,
    ));
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return;
    if (requesting.decision?.type === 'done') {
      this.uncommitted.push(...requesting.appended);
      step.outcome = requesting.decision;
      this.finalizeStep(proc, step);
      return;
    }

    this.runtime.transition(() => {
      for (const message of requesting.appended) this.commit(message);
    });
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return;

    const turnOutcome = this.state.outcome;
    const requester = this.requester;
    const profile = this.profile;

    // 5. Resolve short terminal paths before starting any new request work.
    if (turnOutcome?.type === 'aborted') {
      this.completeRequest(step, {
        type: 'aborted',
        message: null,
        usage: undefined,
        reason: turnOutcome.reason,
      });
      this.finalizeStep(proc, step);
      return;
    }
    if (requester === undefined || profile === undefined) {
      const error = this.requesterError ?? new Error('loop has no requester');
      step.outcome = { type: 'failed', error };
      this.setOutcome(proc, step.outcome);
      this.finalizeStep(proc, step);
      return;
    }
    if (!this.toolsSettled) {
      this.toolsSettled = true;
      this.runtime.transition(() => {
        if (profile.tools !== undefined) this.emit({ type: 'tools.settled', tools: [...profile.tools!] });
      });
    }

    // 6. Settle a late request through the abort-only path without normal batch hooks.
    const outcome = await this.executeRequest(proc, step, requester, profile);
    if (this.phase === 'aborting') {
      if (!this.acceptsAbort(step) || this.abortSettling) return;
      this.abortSettling = true;
      if (this.abortGrace !== undefined) clearTimeout(this.abortGrace);
      this.abortGrace = undefined;
      this.completeRequest(step, outcome);
      if (step.batch.calls.length === 0) {
        this.finishTurn();
        return;
      }
      const result = await proc.step(() => this.runtime.executeBatch(step.batch));
      this.completeAbortedBatch(step, result);
      return;
    }
    if (!this.accepts(step)) return;
    this.completeRequest(step, outcome);
    if (outcome.type !== 'done' && this.finishSteeredStep(proc, step)) return;

    if (step.batch.calls.length > 0) {
      // 7. Run blocked and regular batches through the same awaited runtime boundary.
      this.setPhase(proc, 'batching');
      const batchStarting = await proc.step(() => this.batchStarting(step));
      if (this.acceptsAbort(step)) {
        const result = await proc.step(() => this.runtime.executeBatch(step.batch));
        this.completeAbortedBatch(step, result);
        return;
      }
      if (!this.accepts(step)) return;
      const reports = hookFailureReports('tool.batch-starting', batchStarting.failures);
      let result: TurnToolBatchResult;
      if (batchStarting.blocked !== undefined) {
        step.batch.blocked = batchStarting.blocked;
        result = await proc.step(() => this.runtime.transition(() => {
          const pending = this.runtime.executeBatch(step.batch);
          this.runtime.report('tool.batch-starting', this.point, reports, true);
          return pending;
        }));
      } else {
        this.runtime.transition(() => {
          this.runtime.report('tool.batch-starting', this.point, reports, true);
        });
        if (!this.accepts(step)) return;
        this.setPhase(proc, 'acting');
        result = await proc.step(() => this.runtime.executeBatch(step.batch));
      }
      if (this.acceptsAbort(step)) {
        this.completeAbortedBatch(step, result);
        return;
      }
      if (!this.accepts(step)) return;
      this.completeToolBatch(step, result);
    }

    // 8. Aborts skip regular ending; every other outcome reuses one ending promise.
    if (this.state.outcome?.type === 'aborted') {
      this.finalizeStep(proc, step);
      return;
    }
    this.setPhase(proc, 'ending');
    const ending = await proc.step(() => {
      step.ending ??= this.stepEnding(step);
      return step.ending;
    });
    if (!this.accepts(step)) return;
    this.runtime.transition(() => {
      step.outcome = ending.outcome;
      if (ending.outcome.type !== 'continue') this.setOutcome(proc, ending.outcome);
      for (const { point, failure } of ending.failures) {
        this.runtime.report(point, this.point, hookFailureReports(point, [failure]), true);
      }
    });
    if (!this.accepts(step)) return;

    // 9. Terminal endings finish immediately; only continue invokes the owner.
    if (ending.outcome.type !== 'continue') {
      this.finalizeStep(proc, step);
      return;
    }
    const continuing = await proc.step(() => this.invokeOwner<Extract<TurnOutcome, { type: 'done' }>>(
      'continuing',
      this.state,
      this.scope.signal,
    ));
    if (!this.accepts(step)) return;
    if (continuing.decision?.type === 'done') {
      this.uncommitted.push(...continuing.appended);
      step.outcome = continuing.decision;
      this.finalizeStep(proc, step);
      return;
    }
    this.runtime.transition(() => {
      for (const message of continuing.appended) this.commit(message);
    });
    if (!this.accepts(step)) return;
    this.finalizeStep(proc, step);
  }

  private async stepStarting(step: TurnStep): Promise<StepStartingRun> {
    try {
      const { messages, profile } = this.runtime.read();
      return await runStepStarting(
        this.runtime.extensions,
        { ...this.point, messages, profile },
        step.scope.signal,
      );
    } catch (error) {
      return { failures: [runtimeFailure(error)] };
    }
  }

  private finishSteeredStep(proc: TurnProcess, step: TurnStep): boolean {
    if (!step.steerRequested || this.state.outcome?.type === 'aborted') return false;
    step.outcome = { type: 'done', cause: STEERED };
    this.runtime.transition(() => {
      this.emit(this.endedStep(step));
    });
    this.currentStep = undefined;
    this.setOutcome(proc, step.outcome);
    return true;
  }

  private executeRequest(
    proc: TurnProcess,
    step: TurnStep,
    requester: FullLoopLlmRequester,
    profile: LoopProfile,
  ): Promise<LlmOutcome> {
    this.setPhase(proc, 'requesting');
    return proc.step((_signal, requestStep) => {
      const onProgress = requestStep.bind((_ctrl, event: LoopRequestProgress) => {
        if (!this.accepts(step) || this.phase !== 'requesting') return;
        this.runtime.transition(() => this.requestProgress(step, event));
      });
      return runLoopRequest(
        requester,
        {
          messages: [...this.runtime.read().messages],
          profile,
          policy: this.runtime.policy.asPolicy(),
          signal: step.scope.signal,
        },
        onProgress,
      );
    });
  }

  private requestProgress(step: TurnStep, event: LoopRequestProgress): void {
    if (!this.accepts(step) || this.phase !== 'requesting') return;
    if (event.type === 'llm.delta.request_id') this.requestId = event.requestId;
    if (event.type === 'llm.delta.part' && (event.part.type === 'function' || event.part.type === 'tool_call_part')) {
      step.toolCallStreaming = true;
    }
    this.emit(event);
  }

  private completeRequest(step: TurnStep, outcome: LlmOutcome): void {
    if (!this.current(step)) return;
    this.runtime.transition(() => {
      step.llm = outcome;
      if (typeof outcome.requestId === 'string') this.requestId = outcome.requestId;
      const toolCalls = outcome.type === 'done' ? outcome.message.toolCalls : [];
      step.batch.calls.push(...toolCalls.map((toolCall, index) => ({ key: `${this.id}:${this.step}:${index}`, toolCall })));
      this.emit({ type: 'llm.ended', outcome });
      const message = outcome.message;
      if (message !== undefined && message !== null) {
        this.emit({
          type: 'message.appended',
          ...this.point,
          source: outcome.type === 'failed' ? 'partial' : 'llm',
          message,
        });
      }
    });
  }

  private completeAbortedBatch(step: TurnStep, result: TurnToolBatchResult): void {
    if (!this.acceptsAbort(step)) return;
    this.completeToolBatch(step, result);
    this.finishTurn();
  }

  private async batchStarting(step: TurnStep): Promise<ToolBatchStartingRun> {
    try {
      return await runToolBatchStarting(
        this.runtime.extensions,
        { ...this.point, toolCalls: step.batch.calls.map((call) => call.toolCall) },
        this.scope.signal,
      );
    } catch (error) {
      return { failures: [runtimeFailure(error)] };
    }
  }

  private completeToolBatch(step: TurnStep, result: TurnToolBatchResult): void {
    if (!this.current(step)) return;
    this.runtime.transition(() => {
      if (result.failure !== undefined) {
        step.outcome = { type: 'failed', error: result.failure };
      }
      for (const [index] of step.batch.calls.entries()) {
        const outcome = result.outcomes[index];
        if (outcome === undefined || outcome === null) continue;
        this.emit({
          type: 'message.appended',
          ...this.point,
          source: 'tool',
          message: outcome.message,
        });
      }
    });
  }

  private async stepEnding(step: TurnStep): Promise<StepEndingRun> {
    const draft = draftOutcome(step);
    try {
      const input: StepEndingInput = {
        ...this.point,
        draft,
        messages: this.runtime.read().messages,
      };
      return await runStepEndingHooks(this.runtime.extensions, input, this.scope.signal);
    } catch (error) {
      return {
        outcome: draft,
        failures: [{ point: draft.type === 'continue' ? 'step.continuing' : 'step.stopping', failure: runtimeFailure(error) }],
      };
    }
  }

  private endedStep(step: TurnStep): Extract<TurnEmitted, { type: 'step.ended' }> {
    return {
      type: 'step.ended',
      ...this.point,
      outcome: step.outcome ?? { type: 'aborted' },
      timing: step.llm?.timing,
      llmTiming: llmMessageTiming(step.llm?.timing),
    };
  }

  private finalizeStep(ctrl: TurnControl, step: TurnStep): void {
    if (this.currentStep !== step) return;
    const outcome = step.outcome ?? { type: 'aborted' as const };
    step.outcome = outcome;
    this.runtime.transition(() => {
      this.emit(this.endedStep(step));
    });
    this.currentStep = undefined;
    if (outcome.type === 'continue') return;
    const current = this.state.outcome;
    if (current?.type === 'aborted') {
      step.outcome = current;
      return;
    }
    this.setOutcome(ctrl, outcome);
  }

  private expireAbort(): void {
    const turnOutcome = this.state.outcome;
    if (!this.running() || turnOutcome?.type !== 'aborted' || this.abortSettling) return;
    if (this.abortGrace !== undefined) clearTimeout(this.abortGrace);
    this.abortGrace = undefined;
    const at = this.abortFrom;
    if (at === 'requesting' && this.currentStep !== undefined) {
      this.abortSettling = true;
      this.completeRequest(this.currentStep, {
        type: 'aborted',
        message: null,
        usage: undefined,
        reason: turnOutcome.reason,
      });
      this.finishTurn();
      return;
    }
    const step = this.currentStep;
    if (step !== undefined && (at === 'batching' || at === 'acting')) {
      const result = this.runtime.abortBatch(step.batch, turnOutcome.reason, { force: true });
      if (result !== undefined) {
        this.completeToolBatch(step, result);
        this.finishTurn();
      }
      return;
    }
    this.finishTurn();
  }

  private finishTurn(): void {
    if (this.closing || this.finished) return;
    this.actor.act((ctrl) => {
      if (this.closing || this.finished) return;
      const at = this.abortFrom ?? this.phase;
      this.setPhase(ctrl, 'finishing');
      if (this.abortGrace !== undefined) clearTimeout(this.abortGrace);
      this.abortGrace = undefined;
      if (this.activeBuffer !== undefined) {
        this.activeBuffer.active = false;
        this.uncommitted.push(...this.activeBuffer.messages);
        this.activeBuffer = undefined;
      }
      const step = this.currentStep;
      ctrl.spawn((proc) => this.closeTurn(proc, at, step));
    });
  }

  private closeStep<T>(proc: TurnProcess, task: () => Promise<T> | T): Promise<T | undefined> {
    return proc.step<T | undefined>((_signal, step) => {
      const bypass = () => step.resolve(undefined);
      this.bypassCloseWait = bypass;
      step.onExit(() => {
        if (this.bypassCloseWait === bypass) this.bypassCloseWait = undefined;
      });
      if (this.forceCloseRequested) bypass();
      return task();
    });
  }

  private async closeTurn(
    proc: TurnProcess,
    at: TurnEnding['at'],
    step: TurnStep | undefined,
  ): Promise<void> {
    let ending: StepEndingRun | undefined;
    if (step !== undefined && this.state.outcome?.type === 'aborted') {
      try {
        ending = await this.closeStep(proc, () => {
          step.ending ??= this.stepEnding(step);
          return step.ending;
        });
      } catch (error) {
        ending = {
          outcome: step.outcome ?? { type: 'aborted' },
          failures: [{ point: 'step.stopping', failure: runtimeFailure(error) }],
        };
      }
    }
    this.runtime.transition(() => {
      if (step !== undefined) {
        if (this.state.outcome?.type === 'aborted') step.outcome = this.state.outcome;
        else if (ending !== undefined) step.outcome = ending.outcome;
        for (const { point, failure } of ending?.failures ?? []) {
          this.runtime.report(point, this.point, hookFailureReports(point, [failure]), true);
        }
        this.finalizeStep(proc, step);
      }
      const outcome = this.state.outcome ?? { type: 'aborted' as const };
      this.setOutcome(proc, outcome);
      this.setPhase(proc, 'finished');
    });
    let outcome: TurnOutcome = this.state.outcome ?? { type: 'aborted' };
    const appended: TurnMessage[] = [];
    const buffer = { active: true, messages: appended };
    this.activeBuffer = buffer;
    const turnEnding: TurnEnding = {
      turn: { ...this.state, outcome },
      at,
      uncommitted: this.uncommitted,
    };
    try {
      await this.closeStep(proc, async () => {
        await this.runtime.hooks.ending?.(turnEnding, {
          append: (...messages) => {
            if (!buffer.active) throw new Error('turn hook context is no longer active');
            buffer.messages.push(...messages);
          },
        });
      });
    } catch (error) {
      outcome = { type: 'failed', error };
      this.setOutcome(proc, outcome);
    } finally {
      buffer.active = false;
      this.activeBuffer = undefined;
    }
    this.runtime.transition(() => {
      this.doneSettled = true;
      for (const message of appended) this.commit(message);
      this.uncommitted = [];
      this.emit({ type: 'turn.ended', turnId: this.id, outcome, requestId: this.requestId });
      this.resolveDone(outcome);
      proc.defer(() => {
        void this.actor.close();
      });
    });
  }
}

export function createTurn(input: TurnInput, runtime: TurnRuntime): Turn {
  return new ActorTurn(input, runtime);
}
