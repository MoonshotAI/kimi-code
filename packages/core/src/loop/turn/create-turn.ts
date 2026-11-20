import { createActor, type Actor, type ActorControl, type ProcessControl } from '#/actor/index';
import type { UserMessage } from '#/llm/message';
import type { LlmOutcome, LlmTiming } from '#/llm/response';
import { withAbort, type AbortScope } from '#/utils/abort';
import { isPromiseLike } from '#/hook/result';
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
import { runLoopRequest, type LoopLlmRequester, type LoopRequestProgress } from '../request';
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
  private requester: LoopLlmRequester | undefined;
  private profile: LoopProfile | undefined;
  private requesterError: unknown;
  private requestId: string | undefined;
  private toolsSettled = false;
  private started = false;
  private closing = false;
  private abortGrace: ReturnType<typeof setTimeout> | undefined;
  private readonly expireAbortCallback: () => void;
  private activeBuffer: { active: boolean; messages: TurnMessage[] } | undefined;
  private uncommitted: TurnMessage[];
  private resolveDone!: (outcome: TurnOutcome) => void;

  constructor(input: TurnInput, private readonly runtime: TurnRuntime) {
    this.scope = withAbort(runtime.signal);
    this.actor = createActor<TurnState>({
      initial: { ...input, phase: 'created' },
    });
    this.expireAbortCallback = this.actor.bind((ctrl) => this.expireAbort(ctrl));
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
    if (this.closing || this.finished) return;
    this.actor.act((ctrl) => {
      if (this.closing || this.finished) return;
      if (!this.started) {
        this.started = true;
        this.setOutcome(ctrl, { type: 'aborted', reason });
        this.finishTurn();
        return;
      }
      if (this.state.outcome?.type === 'aborted') {
        if (options?.force === true) this.expireAbort(ctrl);
        return;
      }
      this.setOutcome(ctrl, { type: 'aborted', reason });
      const step = this.currentStep;
      if (step !== undefined) {
        step.outcome = { type: 'aborted', reason };
        step.batch.aborted = { reason };
      }
      this.scope.abort(reason);
      if (step !== undefined && (this.phase === 'batching' || this.phase === 'acting')) {
        const result = this.runtime.abortBatch(step.batch, reason, options);
        if (result !== undefined) {
          this.completeToolBatch(step, result);
          this.finishTurn();
          return;
        }
      }
      if (this.phase === 'requesting') {
        if (options?.force === true) {
          this.expireAbort(ctrl);
        } else {
          this.abortGrace = setTimeout(this.expireAbortCallback, this.runtime.abortGraceMs ?? 2_500);
        }
        return;
      }
      if (this.phase === 'acting') return;
      this.finishTurn();
    });
  }

  private async execute(proc: TurnProcess): Promise<void> {
    try {
      const profile = this.runtime.read().profile;
      this.profile = {
        ...profile,
        tools: profile.tools === undefined ? undefined : [...profile.tools],
      };
      try {
        const template = this.runtime.requester();
        this.requester = template?.snapshot?.() ?? template;
      } catch (error) {
        this.requester = undefined;
        this.requesterError = error;
      }
      this.setPhase(proc, 'starting');
      const starting = await proc.step(() => this.invokeOwner<Extract<TurnOutcome, { type: 'done' | 'blocked' }>>(
        'starting',
        this.state,
        this.scope.signal,
      ));
      if (!this.running()) return;
      this.setPhase(proc, 'appending');
      if (starting.decision !== undefined) {
        this.uncommitted.push(...starting.appended);
        this.setOutcome(proc, starting.decision);
        return;
      }
      const appended = starting.appended.length > 0 ? starting.appended : this.state.initialPending;
      this.uncommitted = [];
      this.runtime.transition(() => {
        this.runtime.committed(this.id);
        for (const message of appended) this.commit(message);
      });
      if (!this.running()) return;
      if (this.state.promptOnly) {
        this.setOutcome(proc, { type: 'done', cause: { by: 'loop', reason: 'prompt_only' } });
        return;
      }
      while (this.running() && this.state.outcome === undefined) {
        const next = await this.executeStep(proc);
        if (!next) break;
      }
    } catch (error) {
      if (!this.closing && !this.finished) {
        this.setOutcome(proc, { type: 'failed', error });
        if (this.currentStep !== undefined) this.currentStep.outcome = { type: 'failed', error };
      }
    } finally {
      this.finishTurn();
    }
  }

  private get point(): { readonly turnId: number; readonly step: number } {
    return { turnId: this.id, step: this.step };
  }

  private running(): boolean {
    return this.started && !this.closing && !this.finished;
  }

  private accepts(step: TurnStep): boolean {
    return this.running() && this.currentStep === step;
  }

  private invokeOwner<D>(
    point: 'starting' | 'requesting' | 'continuing',
    event: TurnState,
    signal: AbortSignal,
  ): OwnerRun<D> | Promise<OwnerRun<D>> {
    const hook = this.runtime.hooks[point] as ((event: never, ctx: TurnHookContext) => D | void | Promise<D | void>) | undefined;
    if (hook === undefined) return { appended: [] };
    const buffer: { active: boolean; messages: TurnMessage[] } = { active: true, messages: [] };
    this.activeBuffer = buffer;
    const close = (): void => {
      buffer.active = false;
      if (this.activeBuffer === buffer) this.activeBuffer = undefined;
    };
    const settle = (decision: D | void): OwnerRun<D> => ({
      decision: decision ?? undefined,
      appended: buffer.messages,
    });
    try {
      const returned = hook(event as never, {
        signal,
        append: (...messages) => {
          if (!buffer.active) throw new Error('turn hook context is no longer active');
          buffer.messages.push(...messages);
        },
      });
      if (isPromiseLike(returned)) {
        return Promise.resolve(returned).then(settle).finally(close);
      }
      const run = settle(returned);
      close();
      return run;
    } catch (error) {
      close();
      throw error;
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

  private async executeStep(proc: TurnProcess): Promise<boolean> {
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
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return false;

    const starting = await proc.step(() => this.stepStarting(step));
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return false;
    this.runtime.transition(() => {
      if (starting.rewrittenBy !== undefined) {
        this.emit({ type: 'context.settled', messages: [...starting.messages], reason: starting.rewrittenBy });
      }
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
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return false;
    if (step.outcome !== undefined) {
      this.finalizeStep(proc, step);
      return false;
    }

    const requestingRun = this.invokeOwner<Extract<TurnOutcome, { type: 'done' }>>(
      'requesting',
      this.state,
      step.scope.signal,
    );
    const requesting = isPromiseLike(requestingRun) ? await proc.step(() => requestingRun) : requestingRun;
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return false;
    if (requesting.decision?.type === 'done') {
      this.uncommitted.push(...requesting.appended);
      step.outcome = requesting.decision;
      this.finalizeStep(proc, step);
      return false;
    }
    this.runtime.transition(() => {
      for (const message of requesting.appended) this.commit(message);
    });
    if (!this.accepts(step) || this.finishSteeredStep(proc, step)) return false;
    const turnOutcome = this.state.outcome;
    if (turnOutcome?.type === 'aborted') {
      this.completeRequest(step, {
        type: 'aborted',
        message: null,
        usage: undefined,
        reason: turnOutcome.reason,
      });
      this.finalizeStep(proc, step);
      return false;
    }
    const requester = this.requester;
    const profile = this.profile;
    if (requester === undefined || profile === undefined) {
      const error = this.requesterError ?? new Error('loop has no requester');
      step.outcome = { type: 'failed', error };
      this.setOutcome(proc, step.outcome);
      this.finalizeStep(proc, step);
      return false;
    }
    if (!this.toolsSettled) {
      this.toolsSettled = true;
      this.runtime.transition(() => {
        if (profile.tools !== undefined) this.emit({ type: 'tools.settled', tools: [...profile.tools!] });
      });
    }

    const outcome = await this.executeRequest(proc, step, requester, profile);
    if (!this.accepts(step)) return false;
    this.completeRequest(step, outcome);
    if (outcome.type !== 'done' && this.finishSteeredStep(proc, step)) return false;
    if (step.batch.calls.length > 0) return this.executeBatch(proc, step);
    if (this.state.outcome?.type === 'aborted') {
      this.finalizeStep(proc, step);
      return false;
    }
    return this.finishStep(proc, step);
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
      return { messages: this.runtime.read().messages, failures: [runtimeFailure(error)] };
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
    requester: LoopLlmRequester,
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
    if (!this.accepts(step)) return;
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

  private async executeBatch(proc: TurnProcess, step: TurnStep): Promise<boolean> {
    this.setPhase(proc, 'batching');
    const starting = await proc.step(() => this.batchStarting(step));
    if (!this.accepts(step)) return false;
    if (this.state.outcome?.type === 'aborted') {
      const result = await proc.step(() => this.runtime.executeBatch(step.batch));
      if (!this.accepts(step)) return false;
      this.completeToolBatch(step, result);
      this.finalizeStep(proc, step);
      return false;
    }
    const reports = hookFailureReports('tool.batch-starting', starting.failures);
    if (starting.blocked !== undefined) {
      step.batch.blocked = starting.blocked;
      const pending = this.runtime.transition(() => {
        const result = this.runtime.executeBatch(step.batch);
        this.runtime.report(
          'tool.batch-starting',
          this.point,
          reports,
          true,
        );
        return result;
      });
      const result = isPromiseLike(pending) ? await proc.step(() => pending) : pending;
      if (!this.accepts(step)) return false;
      this.completeToolBatch(step, result);
      return this.finishStep(proc, step);
    }
    this.runtime.transition(() => {
      this.runtime.report(
        'tool.batch-starting',
        this.point,
        reports,
        true,
      );
    });
    if (!this.accepts(step)) return false;
    this.setPhase(proc, 'acting');
    const result = await proc.step(() => this.runtime.executeBatch(step.batch));
    if (!this.accepts(step)) return false;
    this.completeToolBatch(step, result);
    if ((this.state.outcome as TurnOutcome | undefined)?.type === 'aborted') {
      this.finalizeStep(proc, step);
      return false;
    }
    return this.finishStep(proc, step);
  }

  private advanceStep(proc: TurnProcess, next: boolean | Promise<boolean>): boolean | Promise<boolean> {
    const advance = (cont: boolean): boolean | Promise<boolean> => {
      if (cont) return this.executeStep(proc);
      this.finishTurn();
      return false;
    };
    return isPromiseLike(next) ? next.then(advance) : advance(next);
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
    if (!this.accepts(step)) return;
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

  private finishStep(proc: TurnProcess, step: TurnStep): boolean | Promise<boolean> {
    if (!this.accepts(step)) return false;
    this.setPhase(proc, 'ending');
    const ending = this.stepEnding(step);
    return isPromiseLike(ending)
      ? ending.then((run) => this.completeStepEnding(proc, step, run))
      : this.completeStepEnding(proc, step, ending);
  }

  private completeStepEnding(proc: TurnProcess, step: TurnStep, ending: StepEndingRun): boolean | Promise<boolean> {
    if (!this.accepts(step)) return false;
    this.runtime.transition(() => {
      step.outcome = ending.outcome;
      if (ending.outcome.type !== 'continue') this.setOutcome(proc, ending.outcome);
      for (const { point, failure } of ending.failures) {
        this.runtime.report(
          point,
          this.point,
          hookFailureReports(point, [failure]),
          true,
        );
      }
    });
    if (!this.accepts(step)) return false;
    if (ending.outcome.type !== 'continue') {
      this.finalizeStep(proc, step);
      return this.advanceStep(proc, false);
    }
    const continuing = this.invokeOwner<Extract<TurnOutcome, { type: 'done' }>>(
      'continuing',
      this.state,
      this.scope.signal,
    );
    return isPromiseLike(continuing)
      ? continuing.then((run) => this.completeContinuing(proc, step, run))
      : this.completeContinuing(proc, step, continuing);
  }

  private completeContinuing(
    proc: TurnProcess,
    step: TurnStep,
    continuing: OwnerRun<Extract<TurnOutcome, { type: 'done' }>>,
  ): boolean | Promise<boolean> {
    if (!this.accepts(step)) return false;
    if (continuing.decision?.type === 'done') {
      this.uncommitted.push(...continuing.appended);
      step.outcome = continuing.decision;
    } else {
      this.runtime.transition(() => {
        for (const message of continuing.appended) this.commit(message);
      });
    }
    if (!this.accepts(step)) return false;
    this.finalizeStep(proc, step);
    return this.advanceStep(proc, step.outcome?.type === 'continue');
  }

  private stepEnding(step: TurnStep): StepEndingRun | Promise<StepEndingRun> {
    const draft = draftOutcome(step);
    try {
      const input: StepEndingInput = {
        ...this.point,
        draft,
        messages: this.runtime.read().messages,
      };
      return runStepEndingHooks(this.runtime.extensions, input, this.scope.signal);
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
    this.setOutcome(ctrl, outcome);
  }

  private expireAbort(ctrl: TurnControl): void {
    const turnOutcome = this.state.outcome;
    if (!this.running() || turnOutcome?.type !== 'aborted') return;
    if (this.abortGrace !== undefined) clearTimeout(this.abortGrace);
    this.abortGrace = undefined;
    if (this.phase === 'requesting' && this.currentStep !== undefined) {
      const step = this.currentStep;
      this.completeRequest(step, {
        type: 'aborted',
        message: null,
        usage: undefined,
        reason: turnOutcome.reason,
      });
      this.finalizeStep(ctrl, step);
      this.finishTurn();
      return;
    }
    const step = this.currentStep;
    if (step !== undefined && (this.phase === 'batching' || this.phase === 'acting')) {
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
      this.closing = true;
      const at = this.phase;
      if (this.abortGrace !== undefined) clearTimeout(this.abortGrace);
      this.abortGrace = undefined;
      if (this.activeBuffer !== undefined) {
        this.activeBuffer.active = false;
        this.uncommitted.push(...this.activeBuffer.messages);
        this.activeBuffer = undefined;
      }
      this.runtime.transition(() => {
        if (this.currentStep !== undefined) this.finalizeStep(ctrl, this.currentStep);
        let outcome = this.state.outcome ?? { type: 'aborted' as const };
        this.setOutcome(ctrl, outcome);
        this.setPhase(ctrl, 'finished');
        const appended: TurnMessage[] = [];
        const buffer = { active: true, messages: appended };
        this.activeBuffer = buffer;
        const ending: TurnEnding = {
          turn: { ...this.state, outcome },
          at,
          uncommitted: this.uncommitted,
        };
        try {
          const result = this.runtime.hooks.ending?.(ending, {
            append: (...messages) => {
              if (!buffer.active) throw new Error('turn hook context is no longer active');
              buffer.messages.push(...messages);
            },
          });
          if (isPromiseLike(result)) throw new Error('turn ending hook must be synchronous');
        } catch (error) {
          outcome = { type: 'failed', error };
          this.setOutcome(ctrl, outcome);
        } finally {
          buffer.active = false;
          this.activeBuffer = undefined;
        }
        for (const message of appended) this.commit(message);
        this.uncommitted = [];
        this.emit({ type: 'turn.ended', turnId: this.id, outcome, requestId: this.requestId });
        this.resolveDone(outcome);
        ctrl.defer(() => {
          void this.actor.close();
        });
      });
    });
  }
}

export function createTurn(input: TurnInput, runtime: TurnRuntime): Turn {
  return new ActorTurn(input, runtime);
}
