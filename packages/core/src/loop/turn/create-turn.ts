import type { UserMessage } from '#/llm/message';
import type { LlmOutcome } from '#/llm/response';
import { withAbort, type AbortScope } from '#/utils/abort';
import { isPromiseLike } from '#/hook/result';
import { llmMessageTiming } from '../contract/emitted';
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
  TurnOwnerStartingEvent,
  TurnPhase,
  TurnPoint,
  TurnRuntime,
  TurnStartDecision,
  TurnState,
  TurnStep,
  TurnToolBatch,
  TurnToolBatchResult,
  TurnYield,
} from './contract';

interface OwnerRun<D> {
  readonly decision?: D;
  readonly appended: readonly TurnMessage[];
}

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
  readonly id: number;
  readonly done: Promise<TurnOutcome>;

  private readonly scope: AbortScope;
  private readonly promptOnly: boolean;
  private readonly resumed: boolean;
  private readonly trigger: TurnState['trigger'];
  private readonly initialPending: TurnInput['start'];
  private readonly initialMessages: TurnMessage[];
  private phase: 'created' | TurnPhase = 'created';
  private step = 0;
  private currentStep: TurnStep | undefined;
  private outcome: TurnOutcome | undefined;
  private requester: LoopLlmRequester | undefined;
  private profile: LoopProfile | undefined;
  private requesterError: unknown;
  private requestId: string | undefined;
  private toolsSettled = false;
  private started = false;
  private closing = false;
  private finished = false;
  private abortGrace: ReturnType<typeof setTimeout> | undefined;
  private activeBuffer: { active: boolean; messages: TurnMessage[] } | undefined;
  private uncommitted: TurnMessage[];
  private resolveDone!: (outcome: TurnOutcome) => void;

  constructor(private readonly input: TurnInput, private readonly runtime: TurnRuntime) {
    this.id = input.id;
    this.scope = withAbort(runtime.signal);
    this.promptOnly = input.start.type === 'prompt' && input.start.promptOnly === true;
    this.resumed = input.start.type === 'resume';
    this.trigger = input.start.type === 'continue' ? 'continue' : input.start.trigger;
    this.step = input.start.type === 'resume' ? input.start.step : 0;
    this.initialPending = input.start;
    this.initialMessages = input.start.type === 'prompt'
      ? input.start.pending.map((item) => ({ source: item.kind, message: item.message }))
      : [];
    this.uncommitted = [...this.initialMessages];
    this.done = new Promise((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get state(): TurnState {
    return {
      id: this.id,
      trigger: this.trigger,
      phase: this.phase,
      step: this.step,
      outcome: this.outcome,
      bypassMaxSteps: this.input.bypassMaxSteps === true,
    };
  }

  start(): void {
    if (this.started || this.closing || this.finished) return;
    this.started = true;
    void this.execute();
  }

  interrupt(cause: Cause = STEERED): void {
    if (!this.started || this.closing || this.finished) return;
    const step = this.currentStep;
    if (step === undefined || this.outcome?.type === 'aborted') return;
    if ((this.phase !== 'stepStarting' && this.phase !== 'requesting') || step.toolCallStreaming) return;
    step.steerRequested = true;
    step.scope.abort(cause);
  }

  abort(reason?: unknown, options?: { readonly force?: boolean }): void {
    if (this.closing || this.finished) return;
    if (!this.started) {
      this.started = true;
      this.outcome = { type: 'aborted', reason };
      this.finishTurn();
      return;
    }
    if (this.outcome?.type === 'aborted') {
      if (options?.force === true) this.expireAbort();
      return;
    }
    this.outcome = { type: 'aborted', reason };
    if (this.currentStep !== undefined) this.currentStep.outcome = { type: 'aborted', reason };
    this.scope.abort(reason);
    const step = this.currentStep;
    if (step !== undefined && (this.phase === 'batching' || this.phase === 'acting')) {
      const result = this.runtime.tools.abortBatch(this.toolBatch(step), reason, options);
      if (result !== undefined) {
        this.completeToolBatch(step, result);
        this.finishTurn();
        return;
      }
    }
    if (this.phase === 'requesting') {
      if (options?.force === true) {
        this.expireAbort();
      } else {
        this.abortGrace = setTimeout(() => this.expireAbort(), this.runtime.abortGraceMs ?? 2_500);
      }
      return;
    }
    if (this.phase === 'acting') return;
    this.finishTurn();
  }

  private async execute(): Promise<void> {
    try {
      const profile = this.runtime.host.read().profile;
      this.profile = {
        ...profile,
        tools: profile.tools === undefined ? undefined : [...profile.tools],
      };
      try {
        const template = this.runtime.request.current();
        this.requester = template?.snapshot?.() ?? template;
      } catch (error) {
        this.requester = undefined;
        this.requesterError = error;
      }
      this.phase = 'starting';
      const starting = await this.invokeOwner<TurnStartDecision>(
        'starting',
        this.startingEvent(),
        this.scope.signal,
      );
      if (!this.running()) return;
      this.phase = 'appending';
      if (starting.decision?.done !== undefined || starting.decision?.blocked !== undefined) {
        this.uncommitted.push(...starting.appended);
        this.outcome = starting.decision.done !== undefined
          ? { type: 'done', cause: starting.decision.done }
          : { type: 'blocked', at: 'turn.starting', cause: starting.decision.blocked! };
        return;
      }
      const appended = starting.appended.length > 0 ? starting.appended : this.initialMessages;
      this.uncommitted = [];
      this.runtime.host.transition(() => {
        this.runtime.host.committed(this.id);
        for (const message of appended) this.commit(message);
      });
      if (!this.running()) return;
      if (this.promptOnly) {
        this.outcome = { type: 'done', cause: { by: 'loop', reason: 'prompt_only' } };
        return;
      }
      while (this.running() && this.outcome === undefined) {
        const next = await this.executeStep();
        if (!next) break;
      }
    } catch (error) {
      if (!this.closing && !this.finished) {
        this.outcome = { type: 'failed', error };
        if (this.currentStep !== undefined) this.currentStep.outcome = { type: 'failed', error };
      }
    } finally {
      this.finishTurn();
    }
  }

  private startingEvent(): TurnOwnerStartingEvent {
    return {
      turnId: this.id,
      step: this.step,
      trigger: this.trigger,
      pending: this.initialPending.type === 'prompt' ? this.initialPending.pending : [],
      resumed: this.resumed,
    };
  }

  private running(): boolean {
    return this.started && !this.closing && !this.finished;
  }

  private accepts(step: TurnStep): boolean {
    return this.running() && this.currentStep === step;
  }

  private invokeOwner<D>(
    point: 'starting' | 'requesting' | 'continuing',
    event: TurnOwnerStartingEvent | TurnPoint,
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
      this.runtime.host.report(
        'message.appending',
        { turnId: this.id, step: this.step },
        [{ failure: message.failure, message: message.message as UserMessage }],
        false,
      );
    }
    this.runtime.host.emit({
      type: 'message.appended',
      turnId: this.id,
      step: this.step,
      source: message.source,
      message: message.message,
      blocked: message.blocked,
    });
  }

  private emit(event: TurnEmitted): void {
    this.runtime.host.emit(event);
  }

  private async executeStep(): Promise<boolean> {
    const step: TurnStep = {
      scope: withAbort(this.scope.signal),
      steerRequested: false,
      toolCallStreaming: false,
      calls: [],
    };
    this.step += 1;
    this.phase = 'stepStarting';
    this.currentStep = step;
    this.runtime.host.transition(() => {
      this.emit({ type: 'step.started', turnId: this.id, step: this.step });
    });
    if (!this.accepts(step) || this.finishSteeredStep(step)) return false;

    const starting = await this.stepStarting(step);
    if (!this.accepts(step) || this.finishSteeredStep(step)) return false;
    this.runtime.host.transition(() => {
      if (starting.rewrittenBy !== undefined) {
        this.emit({ type: 'context.settled', messages: [...starting.messages], reason: starting.rewrittenBy });
      }
      this.runtime.host.report(
        'step.starting',
        { turnId: this.id, step: this.step },
        hookFailureReports('step.starting', starting.failures),
        true,
      );
      if (starting.blocked !== undefined) {
        step.outcome = { type: 'blocked', at: 'step.starting', cause: starting.blocked };
        this.outcome = step.outcome;
      } else {
        this.phase = 'requesting';
      }
    });
    if (!this.accepts(step) || this.finishSteeredStep(step)) return false;
    if (step.outcome !== undefined) {
      this.finalizeStep(step);
      return false;
    }

    const requestingRun = this.invokeOwner<TurnYield>(
      'requesting',
      { turnId: this.id, step: this.step },
      step.scope.signal,
    );
    const requesting = isPromiseLike(requestingRun) ? await requestingRun : requestingRun;
    if (!this.accepts(step) || this.finishSteeredStep(step)) return false;
    if (requesting.decision?.type === 'done') {
      this.uncommitted.push(...requesting.appended);
      step.outcome = { type: 'done', cause: requesting.decision.cause };
      this.finalizeStep(step);
      return false;
    }
    this.runtime.host.transition(() => {
      for (const message of requesting.appended) this.commit(message);
    });
    if (!this.accepts(step) || this.finishSteeredStep(step)) return false;
    if (this.outcome?.type === 'aborted') {
      this.completeRequest(step, {
        type: 'aborted',
        message: null,
        usage: undefined,
        reason: this.outcome.reason,
      });
      this.finalizeStep(step);
      return false;
    }
    const requester = this.requester;
    const profile = this.profile;
    if (requester === undefined || profile === undefined) {
      const error = this.requesterError ?? new Error('loop has no requester');
      step.outcome = { type: 'failed', error };
      this.outcome = step.outcome;
      this.finalizeStep(step);
      return false;
    }
    if (!this.toolsSettled) {
      this.toolsSettled = true;
      this.runtime.host.transition(() => {
        if (profile.tools !== undefined) this.emit({ type: 'tools.settled', tools: [...profile.tools!] });
      });
    }

    const outcome = await this.executeRequest(step, requester, profile);
    if (!this.accepts(step)) return false;
    this.completeRequest(step, outcome);
    if (outcome.type !== 'done' && this.finishSteeredStep(step)) return false;
    if (step.calls.length > 0) return this.executeBatch(step);
    if ((this.outcome as TurnOutcome | undefined)?.type === 'aborted') {
      this.finalizeStep(step);
      return false;
    }
    return this.finishStep(step);
  }

  private async stepStarting(step: TurnStep): Promise<StepStartingRun> {
    try {
      const { messages, profile } = this.runtime.host.read();
      return await runStepStarting(
        this.runtime.extensions,
        { turnId: this.id, step: this.step, messages, profile },
        step.scope.signal,
      );
    } catch (error) {
      return { messages: this.runtime.host.read().messages, failures: [runtimeFailure(error)] };
    }
  }

  private finishSteeredStep(step: TurnStep): boolean {
    if (!step.steerRequested || this.outcome?.type === 'aborted') return false;
    step.outcome = { type: 'done', cause: STEERED };
    this.runtime.host.transition(() => {
      this.emit(this.endedStep(step));
    });
    this.currentStep = undefined;
    this.outcome = step.outcome;
    return true;
  }

  private executeRequest(step: TurnStep, requester: LoopLlmRequester, profile: LoopProfile): Promise<LlmOutcome> {
    this.phase = 'requesting';
    return runLoopRequest(
      requester,
      {
        messages: [...this.runtime.host.read().messages],
        profile,
        policy: this.runtime.request.policy.asPolicy(),
        signal: step.scope.signal,
      },
      (event) => {
        if (!this.accepts(step) || this.phase !== 'requesting') return;
        this.runtime.host.transition(() => this.requestProgress(step, event));
      },
    );
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
    this.runtime.host.transition(() => {
      step.llm = outcome;
      if (typeof outcome.requestId === 'string') this.requestId = outcome.requestId;
      const toolCalls = outcome.type === 'done' ? outcome.message.toolCalls : [];
      step.calls.push(...toolCalls.map((toolCall, index) => ({ key: `${this.id}:${this.step}:${index}`, toolCall })));
      this.emit({ type: 'llm.ended', outcome });
      const message = outcome.message;
      if (message !== undefined && message !== null) {
        this.emit({
          type: 'message.appended',
          turnId: this.id,
          step: this.step,
          source: outcome.type === 'failed' ? 'partial' : 'llm',
          message,
        });
      }
    });
  }

  private async executeBatch(step: TurnStep): Promise<boolean> {
    this.phase = 'batching';
    const starting = await this.batchStarting(step);
    if (!this.accepts(step)) return false;
    if (this.outcome?.type === 'aborted') {
      const result = await this.runtime.tools.executeBatch(this.toolBatch(step));
      if (!this.accepts(step)) return false;
      this.completeToolBatch(step, result);
      this.finalizeStep(step);
      return false;
    }
    const reports = hookFailureReports('tool.batch-starting', starting.failures);
    if (starting.blocked !== undefined) {
      const pending = this.runtime.host.transition(() => {
        const result = this.runtime.tools.executeBatch(this.toolBatch(step, starting.blocked));
        this.runtime.host.report(
          'tool.batch-starting',
          { turnId: this.id, step: this.step },
          reports,
          true,
        );
        return result;
      });
      const result = isPromiseLike(pending) ? await pending : pending;
      if (!this.accepts(step)) return false;
      this.completeToolBatch(step, result);
      return this.finishStep(step);
    }
    this.runtime.host.transition(() => {
      this.runtime.host.report(
        'tool.batch-starting',
        { turnId: this.id, step: this.step },
        reports,
        true,
      );
    });
    if (!this.accepts(step)) return false;
    this.phase = 'acting';
    const result = await this.runtime.tools.executeBatch(this.toolBatch(step));
    if (!this.accepts(step)) return false;
    this.completeToolBatch(step, result);
    if ((this.outcome as TurnOutcome | undefined)?.type === 'aborted') {
      this.finalizeStep(step);
      return false;
    }
    return this.finishStep(step);
  }

  private advanceStep(next: boolean | Promise<boolean>): boolean | Promise<boolean> {
    const advance = (cont: boolean): boolean | Promise<boolean> => {
      if (cont) return this.executeStep();
      this.finishTurn();
      return false;
    };
    return isPromiseLike(next) ? next.then(advance) : advance(next);
  }

  private async batchStarting(step: TurnStep): Promise<ToolBatchStartingRun> {
    try {
      return await runToolBatchStarting(
        this.runtime.extensions,
        { turnId: this.id, step: this.step, toolCalls: step.calls.map((call) => call.toolCall) },
        this.scope.signal,
      );
    } catch (error) {
      return { failures: [runtimeFailure(error)] };
    }
  }

  private toolBatch(step: TurnStep, blocked?: TurnToolBatch['blocked']): TurnToolBatch {
    return {
      turnId: this.id,
      step: this.step,
      calls: step.calls,
      signal: step.scope.signal,
      blocked,
      aborted: this.outcome?.type === 'aborted' ? { reason: this.outcome.reason } : undefined,
    };
  }

  private completeToolBatch(step: TurnStep, result: TurnToolBatchResult): void {
    if (!this.accepts(step)) return;
    this.runtime.host.transition(() => {
      if (result.failure !== undefined) {
        step.outcome = { type: 'failed', error: result.failure };
      }
      for (const [index] of step.calls.entries()) {
        const outcome = result.outcomes[index];
        if (outcome === undefined || outcome === null) continue;
        this.emit({
          type: 'message.appended',
          turnId: this.id,
          step: this.step,
          source: 'tool',
          message: outcome.message,
        });
      }
    });
  }

  private finishStep(step: TurnStep): boolean | Promise<boolean> {
    if (!this.accepts(step)) return false;
    this.phase = 'ending';
    const ending = this.stepEnding(step);
    return isPromiseLike(ending)
      ? ending.then((run) => this.completeStepEnding(step, run))
      : this.completeStepEnding(step, ending);
  }

  private completeStepEnding(step: TurnStep, ending: StepEndingRun): boolean | Promise<boolean> {
    if (!this.accepts(step)) return false;
    this.runtime.host.transition(() => {
      step.outcome = ending.outcome;
      if (ending.outcome.type !== 'continue') this.outcome = ending.outcome;
      for (const { point, failure } of ending.failures) {
        this.runtime.host.report(
          point,
          { turnId: this.id, step: this.step },
          hookFailureReports(point, [failure]),
          true,
        );
      }
    });
    if (!this.accepts(step)) return false;
    if (ending.outcome.type !== 'continue') {
      this.finalizeStep(step);
      return this.advanceStep(false);
    }
    const continuing = this.invokeOwner<TurnYield>(
      'continuing',
      { turnId: this.id, step: this.step },
      this.scope.signal,
    );
    return isPromiseLike(continuing)
      ? continuing.then((run) => this.completeContinuing(step, run))
      : this.completeContinuing(step, continuing);
  }

  private completeContinuing(step: TurnStep, continuing: OwnerRun<TurnYield>): boolean | Promise<boolean> {
    if (!this.accepts(step)) return false;
    if (continuing.decision?.type === 'done') {
      this.uncommitted.push(...continuing.appended);
      step.outcome = { type: 'done', cause: continuing.decision.cause };
    } else {
      this.runtime.host.transition(() => {
        for (const message of continuing.appended) this.commit(message);
      });
    }
    if (!this.accepts(step)) return false;
    this.finalizeStep(step);
    return this.advanceStep(step.outcome?.type === 'continue');
  }

  private stepEnding(step: TurnStep): StepEndingRun | Promise<StepEndingRun> {
    const draft = draftOutcome(step);
    try {
      const input: StepEndingInput = {
        turnId: this.id,
        step: this.step,
        draft,
        messages: this.runtime.host.read().messages,
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
      turnId: this.id,
      step: this.step,
      outcome: step.outcome ?? { type: 'aborted' },
      timing: step.llm?.timing,
      llmTiming: llmMessageTiming(step.llm?.timing),
    };
  }

  private finalizeStep(step: TurnStep): void {
    if (this.currentStep !== step) return;
    const outcome = step.outcome ?? { type: 'aborted' as const };
    step.outcome = outcome;
    this.runtime.host.transition(() => {
      this.emit(this.endedStep(step));
    });
    this.currentStep = undefined;
    if (outcome.type === 'continue') return;
    this.outcome = outcome;
  }

  private expireAbort(): void {
    if (!this.running() || this.outcome?.type !== 'aborted') return;
    if (this.abortGrace !== undefined) clearTimeout(this.abortGrace);
    this.abortGrace = undefined;
    if (this.phase === 'requesting' && this.currentStep !== undefined) {
      const step = this.currentStep;
      this.completeRequest(step, {
        type: 'aborted',
        message: null,
        usage: undefined,
        reason: this.outcome.reason,
      });
      this.finalizeStep(step);
      this.finishTurn();
      return;
    }
    const step = this.currentStep;
    if (step !== undefined && (this.phase === 'batching' || this.phase === 'acting')) {
      const result = this.runtime.tools.abortBatch(this.toolBatch(step), this.outcome.reason, { force: true });
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
    this.closing = true;
    const at = this.phase;
    if (this.abortGrace !== undefined) clearTimeout(this.abortGrace);
    this.abortGrace = undefined;
    if (this.activeBuffer !== undefined) {
      this.activeBuffer.active = false;
      this.uncommitted.push(...this.activeBuffer.messages);
      this.activeBuffer = undefined;
    }
    this.runtime.host.transition(() => {
      if (this.currentStep !== undefined) this.finalizeStep(this.currentStep);
      let outcome = this.outcome ?? { type: 'aborted' as const };
      this.outcome = outcome;
      this.phase = 'finished';
      const appended: TurnMessage[] = [];
      const buffer = { active: true, messages: appended };
      this.activeBuffer = buffer;
      const ending: TurnEnding = {
        turnId: this.id,
        outcome,
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
        this.outcome = outcome;
      } finally {
        buffer.active = false;
        this.activeBuffer = undefined;
      }
      for (const message of appended) this.commit(message);
      this.uncommitted = [];
      this.emit({ type: 'turn.ended', turnId: this.id, outcome, requestId: this.requestId });
      this.finished = true;
      this.resolveDone(outcome);
    });
  }
}

export function createTurn(input: TurnInput, runtime: TurnRuntime): Turn {
  return new ActorTurn(input, runtime);
}
