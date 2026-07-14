/**
 * `loop` domain (L4) — `IAgentLoopService` implementation.
 *
 * Owns a FIFO of Turn jobs, each with its own `StepRequestQueue`. Admission
 * reserves a stable Turn handle immediately; the head job alone takes the
 * activity lease, records `turn.prompt`, publishes `turn.started`, and drains
 * its Steps. Ending publishes `turn.ended` after `lease.end()` and pumps the
 * next queued Turn. Requests without an active Turn remain in the Loop-owned
 * pending-input queue and bind to the next admitted Turn.
 *
 * The run drains the queue one batch per step: each batch's driver request
 * (plus any mergeable requests folded into it) materializes its context
 * messages, then one LLM step runs (`onWillBeginStep` → streamed request → content
 * parts → tool execution → `step.end` → `onDidFinishStep`). The loop itself never
 * enqueues — it only runs requests and dispatches errors. What drives the
 * next step lives entirely in the aspects: the `loopContinuation` aspect
 * enqueues a `ContinuationStepRequest` when a step executed tools (a plain
 * assistant message enqueues nothing, so the queue empties and the turn
 * completes), and orchestrators (`prompt`, `goal`, `externalHooks`, `task`)
 * steer the turn by enqueueing further requests. A failed step is dispatched
 * to the registered error handlers (first match wins); a handler that claims
 * and catches the error has already enqueued the turn's continuation itself —
 * `stepRetry` re-enqueues the failed driver after backoff, `fullCompaction`
 * compacts and re-enqueues it — so the loop only learns caught-or-not, while
 * an unclaimed or uncaught error fails the turn. Emits `turn.*` / delta
 * events through `event`, persists loop events through `contextMemory`, and
 * reads the step budget from `config`. Bound at Agent scope.
 */

import { randomUUID } from 'node:crypto';

import { createControlledPromise } from '@antfu/utils';

import { InstantiationType } from '#/_base/di/extensions';
import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { abortError, isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import type {
  AssistantDeltaEvent,
  ThinkingDeltaEvent,
  ToolCallDeltaEvent,
  TurnEndedEvent,
  TurnStartedEvent,
  TurnStepCompletedEvent,
  TurnStepInterruptedEvent,
  TurnStepStartedEvent,
} from '@moonshot-ai/protocol';
import { IAgentLLMRequesterService, type LLMRequestFinish } from '#/agent/llmRequester/llmRequester';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { type FinishReason } from '#/app/llmProtocol/finishReason';
import { type StreamedMessagePart } from '#/app/llmProtocol/message';
import { type TokenUsage } from '#/app/llmProtocol/usage';
import { BugIndicatingError, ErrorCodes, Error2, isError2, toKimiErrorPayload } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import type { ActivityLease } from '#/activity/activity';
import { IAgentActivityService } from '#/activity/activity';
import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import type {
  TurnEndedEvent as TurnEndedTelemetryEvent,
  TurnInterruptedEvent,
  TurnStartedEvent as TurnStartedTelemetryEvent,
} from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  isMaxStepsExceededError,
  type AfterStepContext,
  type AgentLoopStatus,
  type EnqueueReceipt,
  type LoopErrorContext,
  type LoopErrorHandler,
  type LoopErrorHandlerRegistrationOptions,
  type LoopRunOptions,
  type LoopRunResult,
  type Step,
  type StepEnqueueOptions,
  type StepResult,
  type Turn,
  type TurnResult,
} from './loop';
import {
  type StepRequest,
  type TurnSeed,
} from './stepRequest';
import { StepRequestQueue, type StepRequestBatch } from './stepRequestQueue';
import { cancelTurn, promptTurn, TurnModel } from './turnOps';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.started': TurnStartedEvent;
    'turn.ended': TurnEndedEvent;
    'turn.step.started': TurnStepStartedEvent;
    'turn.step.completed': TurnStepCompletedEvent;
    'turn.step.interrupted': TurnStepInterruptedEvent;
    'assistant.delta': AssistantDeltaEvent;
    'thinking.delta': ThinkingDeltaEvent;
    'tool.call.delta': ToolCallDeltaEvent;
  }
}

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export class AgentLoopService extends Disposable implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot(),
    onDidFinishStep: new OrderedHookSlot(),
  };

  private readonly standaloneStepQueue = new StepRequestQueue();
  private readonly pendingAssignments = new Map<StepRequest, ReturnType<typeof createControlledPromise<import('./loop').StepAssignment>>>();
  private readonly errorHandlers: LoopErrorHandler[] = [];
  private readonly pendingTurns: TurnJob[] = [];
  private activeTurnJob: TurnJob | undefined;
  private nextReservedTurnId: number | undefined;
  private disposing = false;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IEventBus private readonly eventBus: IEventBus,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IConfigService private readonly config: IConfigService,
    @IAgentActivityService private readonly activity: IAgentActivityService,
    @IAgentWireService private readonly wire: IWireService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
  ) {
    super();
  }

  override dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const reason = abortError('Agent loop disposed');
    for (const job of this.pendingTurns.slice()) this.cancel(job.turn.id, reason);
    this.activeTurnJob?.turn.cancel(reason);
    for (const request of this.standaloneStepQueue.drain()) {
      request.abort();
      this.rejectAssignment(request, reason);
    }
    super.dispose();
  }

  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt {
    if (this.disposing) throw abortError('Agent loop disposed');
    const assignment = createControlledPromise<import('./loop').StepAssignment>();
    void assignment.catch(() => undefined);
    this.pendingAssignments.set(request, assignment);

    const active = this.activeTurnJob;
    switch (request.admission) {
      case 'newTurn':
        this.createAndQueueTurn(request);
        break;
      case 'activeOrNewTurn':
        if (active === undefined) this.createAndQueueTurn(request);
        else this.assignStep(active, request, options);
        break;
      case 'activeOrNextTurn':
        if (active === undefined) this.standaloneStepQueue.enqueue(request, options?.at ?? 'tail');
        else this.assignStep(active, request, options);
        break;
      case 'activeTurnOnly':
        if (active === undefined) {
          const error = new BugIndicatingError(`Step request "${request.kind}" requires an active turn`);
          this.rejectAssignment(request, error);
          throw error;
        }
        this.assignStep(active, request, options);
        break;
    }
    return {
      assigned: assignment,
      abort: (reason) => this.abortRequest(request, reason),
    };
  }

  private createAndQueueTurn(request: StepRequest): void {
    const seed = request.turnSeed;
    if (seed === undefined) {
      const error = new BugIndicatingError(`Step request "${request.kind}" cannot start a turn without turnSeed`);
      this.rejectAssignment(request, error);
      throw error;
    }
    const job = this.createPendingTurn(request, seed);
    this.pendingTurns.push(job);
    this.pumpTurns();
  }

  status(): AgentLoopStatus {
    return {
      state: this.activeTurnJob === undefined ? 'idle' : 'running',
      activeTurnId: this.activeTurnJob?.turn.id,
      pendingTurnIds: this.pendingTurns.map((job) => job.turn.id),
      hasPendingRequests: this.hasPendingRequests(),
    };
  }

  cancel(turnId?: number, reason?: unknown): boolean {
    const cancellation = reason ?? userCancellationReason();
    return (
      this.cancelActiveTurn(turnId, cancellation) ||
      (turnId !== undefined && this.cancelQueuedTurn(turnId, cancellation))
    );
  }

  private cancelActiveTurn(turnId: number | undefined, cancellation: unknown): boolean {
    const turn = this.activeTurnJob?.turn;
    if (turn === undefined || (turnId !== undefined && turn.id !== turnId)) return false;
    this.wire.dispatch(cancelTurn({ turnId }));
    return this.activity.cancel(cancellation);
  }

  private cancelQueuedTurn(turnId: number, cancellation: unknown): boolean {
    const index = this.pendingTurns.findIndex((job) => job.turn.id === turnId);
    if (index < 0) return false;
    const [job] = this.pendingTurns.splice(index, 1);
    if (job === undefined || job.turn.state !== 'queued') return false;
    this.wire.dispatch(cancelTurn({ turnId }));
    for (const step of job.steps.values()) step.cancel(cancellation);
    job.controller.abort(cancellation);
    job.turn.state = 'cancelled';
    job.ready.reject(cancellation instanceof Error ? cancellation : abortError('Turn cancelled'));
    job.result.resolve({ type: 'cancelled', steps: 0, reason: cancellation });
    return true;
  }

  hasPendingRequests(): boolean {
    return (
      this.activeTurnJob?.queue.hasPendingRequests() === true ||
      this.standaloneStepQueue.hasPendingRequests() ||
      this.pendingTurns.length > 0
    );
  }

  private createPendingTurn(request: StepRequest, seed: TurnSeed): TurnJob {
    const id = this.reserveTurnId();
    const controller = new AbortController();
    const ready = createControlledPromise<void>();
    const result = createControlledPromise<TurnResult>();
    const queue = new StepRequestQueue();
    const steps = new Map<string, MutableStep>();
    void ready.catch(() => undefined);
    const turn: MutableTurn = {
      id,
      state: 'queued',
      signal: controller.signal,
      ready,
      result,
      cancel: (reason) => this.cancel(id, reason),
    };
    const job = { request, seed, controller, ready, result, queue, steps, turn };
    this.assignStep(job, request);
    this.moveStandaloneStepsTo(job);
    return job;
  }

  private reserveTurnId(): number {
    const modelNextId = this.wire.getModel(TurnModel).nextTurnId;
    const id = Math.max(modelNextId, this.nextReservedTurnId ?? modelNextId);
    this.nextReservedTurnId = id + 1;
    return id;
  }

  private moveStandaloneStepsTo(job: TurnJob): void {
    for (const pending of this.standaloneStepQueue.drain()) {
      if (!pending.aborted) this.assignStep(job, pending);
    }
  }

  private assignStep(job: TurnJob, request: StepRequest, options?: StepEnqueueOptions): Step {
    const step = this.enqueueStep(job, request, options);
    const assignment = this.pendingAssignments.get(request);
    assignment?.resolve({ turn: job.turn, step });
    this.pendingAssignments.delete(request);
    return step;
  }

  private rejectAssignment(request: StepRequest, reason: unknown): void {
    const assignment = this.pendingAssignments.get(request);
    assignment?.reject(reason instanceof Error ? reason : abortError('Step request aborted'));
    this.pendingAssignments.delete(request);
  }

  private abortRequest(request: StepRequest, reason?: unknown): boolean {
    for (const job of [this.activeTurnJob, ...this.pendingTurns]) {
      if (job === undefined) continue;
      if (job.turn.state === 'queued' && job.request === request) {
        return this.cancel(job.turn.id, reason);
      }
      const step = job.steps.get(request.id);
      if (step !== undefined) return step.cancel(reason);
    }
    if (!request.abort()) return false;
    this.rejectAssignment(request, reason ?? userCancellationReason());
    return true;
  }

  private enqueueStep(job: TurnJob, request: StepRequest, options?: StepEnqueueOptions): Step {
    const existing = job.steps.get(request.id);
    if (existing !== undefined && existing.state !== 'cancelled') {
      job.queue.enqueue(request, options?.at ?? 'tail');
      existing.state = 'queued';
      return existing;
    }
    const controller = new AbortController();
    const result = createControlledPromise<StepResult>();
    const step: MutableStep = {
      id: request.id,
      turnId: job.turn.id,
      state: 'queued',
      signal: controller.signal,
      result,
      controller,
      resultControl: result,
      cancel: (reason) => this.cancelStep(job, step, request, reason),
    };
    job.steps.set(step.id, step);
    job.queue.enqueue(request, options?.at ?? 'tail');
    return step;
  }

  private cancelStep(job: TurnJob, step: MutableStep, request: StepRequest, reason?: unknown): boolean {
    if (step.state === 'completed' || step.state === 'failed' || step.state === 'cancelled') return false;
    const cancellation = reason ?? userCancellationReason();
    step.state = 'cancelled';
    request.abort();
    step.controller?.abort(cancellation);
    step.resultControl?.resolve({ type: 'cancelled', reason: cancellation });
    return true;
  }

  private pumpTurns(): void {
    if (this.disposing || this.activeTurnJob !== undefined) return;
    const job = this.pendingTurns.shift();
    if (job === undefined) return;
    this.startTurn(job);
  }

  private startTurn(job: TurnJob): void {
    const lease = this.activity.begin('turn', { origin: job.seed.origin, turnId: job.turn.id });
    this.wire.dispatch(promptTurn({ input: job.seed.input, origin: lease.origin }));
    job.turn.state = 'running';
    job.turn.signal = lease.signal;
    this.activeTurnJob = job;
    this.eventBus.publish({ type: 'turn.started', turnId: job.turn.id, origin: lease.origin });
    void this.runTurn(job.turn, lease, job.ready).then(job.result.resolve, job.result.reject);
  }

  private async runTurn(
    turn: Turn,
    lease: ActivityLease,
    ready: ReturnType<typeof createControlledPromise<void>>,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    const telemetryContext = this.telemetryContext.get();
    const turnTelemetry = this.telemetry.withContext(telemetryContext);
    const { mode, provider_type, protocol } = telemetryContext;
    let result: TurnResult | undefined;
    try {
      const started: TurnStartedTelemetryEvent = { mode, provider_type, protocol };
      turnTelemetry.track2('turn_started', started);
      result = await this.run({
        turnId: turn.id,
        signal: lease.signal,
        onStarted: () => ready.resolve(),
      });
      return result;
    } catch (error) {
      result = this.resultFromTurnError(lease, error);
      return result;
    } finally {
      this.settleTurnReady(ready, result);
      this.releaseActiveTurn(turn, result);
      const outcome = result?.type ?? 'failed';
      lease.end(outcome, result?.type === 'failed' ? { error: result.error } : undefined);
      if (result !== undefined) {
        const error = result.type === 'failed' ? toKimiErrorPayload(result.error) : undefined;
        this.eventBus.publish({
          type: 'turn.ended',
          turnId: turn.id,
          reason: result.type,
          error,
          durationMs: Date.now() - startedAt,
        });
        if (error !== undefined) this.eventBus.publish({ type: 'error', ...error });
        if (result.type !== 'completed') {
          const interrupted: TurnInterruptedEvent = {
            at_step: result.steps,
            mode,
            interrupt_reason: interruptReasonFor(result),
            provider_type,
            protocol,
          };
          turnTelemetry.track2('turn_interrupted', interrupted);
        }
      }
      const ended: TurnEndedTelemetryEvent = {
        reason: result?.type ?? 'failed',
        duration_ms: Date.now() - startedAt,
        mode,
        provider_type,
        protocol,
      };
      turnTelemetry.track2('turn_ended', ended);
      this.pumpTurns();
    }
  }

  private resultFromTurnError(lease: ActivityLease, error: unknown): TurnResult {
    if (!lease.signal.aborted) return { type: 'failed', error, steps: 0 };
    return { type: 'cancelled', steps: 0, reason: lease.signal.reason ?? error };
  }

  private settleTurnReady(
    ready: ReturnType<typeof createControlledPromise<void>>,
    result: TurnResult | undefined,
  ): void {
    if (result?.type === 'failed') {
      ready.reject(result.error);
    } else if (result?.type === 'cancelled') {
      ready.reject(result.reason instanceof Error ? result.reason : abortError('Turn cancelled'));
    } else {
      ready.reject(new Error2(ErrorCodes.INTERNAL, 'Turn ended before first step'));
    }
  }

  private releaseActiveTurn(turn: Turn, result: TurnResult | undefined): void {
    (turn as MutableTurn).state = result?.type ?? 'failed';
    const job = this.activeTurnJob?.turn === turn ? this.activeTurnJob : undefined;
    if (job === undefined) return;
    const reason = result?.type === 'cancelled' ? result.reason : abortError('Turn ended');
    for (const step of job.steps.values()) {
      if (step.state === 'queued' || step.state === 'running') step.cancel(reason);
    }
    this.activeTurnJob = undefined;
  }

  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ): IDisposable {
    if (options.before !== undefined && options.after !== undefined) {
      throw new Error('Loop error handler registration cannot specify both before and after');
    }
    this.deleteErrorHandler(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) {
      this.errorHandlers.push(handler);
    } else {
      const targetIndex = this.errorHandlers.findIndex((entry) => entry.id === target);
      if (targetIndex < 0) {
        throw new Error(`Loop error handler target "${target}" is not registered`);
      }
      const insertAt = options.before !== undefined ? targetIndex : targetIndex + 1;
      this.errorHandlers.splice(insertAt, 0, handler);
    }
    return toDisposable(() => {
      this.deleteErrorHandler(handler.id);
    });
  }

  private deleteErrorHandler(id: string): boolean {
    const index = this.errorHandlers.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    this.errorHandlers.splice(index, 1);
    return true;
  }

  async run(options: LoopRunOptions): Promise<LoopRunResult> {
    const runtime = this.createLoopRuntime(options);
    try {
      while (true) {
        try {
          const begun = this.beginLoopStep(runtime);
          if ('result' in begun) return begun.result;
          runtime.current = begun.step;
          const result = await this.executeLoopStep(
            runtime.turnId,
            begun.step.signal,
            begun.step.number,
            begun.step.uuid,
            options.onStarted,
          );
          const completed = this.completeLoopStep(runtime, result);
          if (completed !== undefined) return completed;
        } catch (error) {
          const disposition = await this.handleLoopStepError(runtime, error);
          if (disposition.type === 'return') return disposition.result;
        }
      }
    } finally {
      runtime.queue.abortTurnScoped();
    }
  }

  private createLoopRuntime(options: LoopRunOptions): LoopRuntime {
    const job = this.activeTurnJob?.turn.id === options.turnId ? this.activeTurnJob : undefined;
    return {
      turnId: options.turnId,
      turnSignal: options.signal ?? new AbortController().signal,
      job,
      queue: job?.queue ?? this.standaloneStepQueue,
      steps: 0,
      lastStopReason: undefined,
      current: undefined,
    };
  }

  private beginLoopStep(runtime: LoopRuntime): BeginStepResult {
    runtime.current = undefined;
    runtime.turnSignal.throwIfAborted();
    if (!runtime.queue.hasPendingRequests()) {
      return {
        result: {
          type: 'completed',
          steps: runtime.steps,
          truncated: runtime.lastStopReason === 'truncated',
        },
      };
    }
    const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
    if (maxSteps !== undefined && maxSteps > 0 && runtime.steps >= maxSteps) {
      throw createMaxStepsExceededError(maxSteps);
    }
    const batch = runtime.queue.takeNextBatch()!;
    const mutableStep = runtime.job?.steps.get(batch.driver.id);
    if (mutableStep !== undefined) {
      mutableStep.state = 'running';
      mutableStep.controller = new AbortController();
      mutableStep.signal = mutableStep.controller.signal;
    }
    const step: StepRuntime = {
      number: ++runtime.steps,
      uuid: randomUUID(),
      batch,
      mutableStep,
      signal: mutableStep?.controller === undefined
        ? runtime.turnSignal
        : AbortSignal.any([runtime.turnSignal, mutableStep.controller.signal]),
    };
    this.materializeBatch(batch);
    return { step };
  }

  private completeLoopStep(
    runtime: LoopRuntime,
    result: StepExecutionResult,
  ): LoopRunResult | undefined {
    const current = runtime.current!;
    if (current.mutableStep !== undefined) {
      current.mutableStep.state = 'completed';
      current.mutableStep.resultControl?.resolve({ type: 'completed' });
    }
    runtime.current = undefined;
    runtime.lastStopReason = result.stopReason;
    if (result.stopReason === 'filtered') {
      throw new Error2(ErrorCodes.PROVIDER_FILTERED, 'Provider safety policy blocked the response.', {
        name: 'ProviderFilteredError',
        details: { finishReason: 'filtered' },
      });
    }
    if (!result.hookStopTurn) return undefined;
    return { type: 'completed', steps: runtime.steps, truncated: result.stopReason === 'truncated' };
  }

  private async handleLoopStepError(
    runtime: LoopRuntime,
    error: unknown,
  ): Promise<LoopErrorDisposition> {
    const cancellation = this.handleLoopCancellation(runtime, error);
    if (cancellation !== undefined) return cancellation;
    const recovery = await this.tryRecoverLoopError(runtime, error);
    return recovery ?? this.failLoopStep(runtime, error);
  }

  private handleLoopCancellation(
    runtime: LoopRuntime,
    error: unknown,
  ): LoopErrorDisposition | undefined {
    const step = runtime.current?.mutableStep;
    if (!isAbortError(error) && !runtime.turnSignal.aborted && step?.signal.aborted !== true) return undefined;
    const reason = runtime.turnSignal.reason ?? step?.signal.reason ?? error;
    this.emitStepInterrupted(
      runtime.turnId,
      runtime.current?.number,
      'aborted',
      isUserCancellation(reason) ? undefined : toErrorMessage(reason),
    );
    if (!runtime.turnSignal.aborted && step?.state === 'cancelled') {
      runtime.current = undefined;
      return { type: 'continue' };
    }
    return { type: 'return', result: { type: 'cancelled', reason, steps: runtime.steps } };
  }

  private async tryRecoverLoopError(
    runtime: LoopRuntime,
    error: unknown,
  ): Promise<LoopErrorDisposition | undefined> {
    const current = runtime.current;
    const context: LoopErrorContext = {
      currentStep: current?.mutableStep,
      turnId: runtime.turnId,
      step: current?.number,
      stepId: current?.uuid,
      signal: runtime.turnSignal,
      error,
      failedDriver: current?.batch.driver,
      retry: (request, options) => {
        if (runtime.job !== undefined) return this.enqueueStep(runtime.job, request, options);
        runtime.queue.enqueue(request, options?.at ?? 'tail');
        return current?.mutableStep ?? {
          id: request.id,
          turnId: runtime.turnId,
          state: 'queued',
          signal: runtime.turnSignal,
          result: Promise.resolve({ type: 'completed' }),
          cancel: () => request.abort(),
        };
      },
    };
    const handler = this.errorHandlers.find((entry) => entry.match(context));
    if (handler === undefined) return undefined;
    try {
      if (await handler.handle(context)) {
        runtime.current = undefined;
        return { type: 'continue' };
      }
      return undefined;
    } catch (handlerError) {
      return this.handleLoopCancellation(runtime, handlerError) ?? this.failLoopStep(runtime, handlerError);
    }
  }

  private failLoopStep(runtime: LoopRuntime, error: unknown): LoopErrorDisposition {
    const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
    this.emitStepInterrupted(runtime.turnId, runtime.current?.number, reason, toErrorMessage(error));
    return { type: 'return', result: { type: 'failed', error, steps: runtime.steps } };
  }

  private materializeBatch(batch: StepRequestBatch): void {
    this.materializeRequest(batch.driver);
    for (const request of batch.merged) {
      this.materializeRequest(request);
    }
  }

  private materializeRequest(request: StepRequest): void {
    if (request.state !== 'pending') return;
    request.onWillMaterialize();
    const messages = request.resolveContextMessages();
    if (messages.length > 0) {
      this.context.append(...messages);
    }
    request.markMaterialized();
  }

  private async executeLoopStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    onStarted: ((step: number) => void) | undefined,
  ): Promise<StepExecutionResult> {
    await this.hooks.onWillBeginStep.run({ turnId, step: currentStep, signal });
    const markStepStarted = this.beginStep(turnId, signal, currentStep, stepUuid, onStarted);
    const response = await this.llmRequester.request(
      { source: { type: 'turn', turnId, step: currentStep } },
      this.createStreamPartHandler(turnId, markStepStarted),
      signal,
    );
    this.appendResponseContent(turnId, currentStep, stepUuid, response);
    const finishReason = await this.executeStepTools(
      turnId,
      signal,
      currentStep,
      stepUuid,
      response,
    );
    this.finishStep(turnId, signal, currentStep, stepUuid, response, finishReason, markStepStarted);
    const hookStopTurn = await this.runAfterStep(
      turnId,
      signal,
      currentStep,
      response.usage,
      finishReason,
    );
    return { stopReason: finishReason, hookStopTurn };
  }

  private beginStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    onStarted: ((step: number) => void) | undefined,
  ): () => void {
    signal.throwIfAborted();
    this.eventBus.publish({ type: 'turn.step.started', turnId, step: currentStep, stepId: stepUuid });
    this.context.appendLoopEvent({
      type: 'step.begin',
      uuid: stepUuid,
      turnId: String(turnId),
      step: currentStep,
    });
    let stepStarted = false;
    return () => {
      if (stepStarted) return;
      stepStarted = true;
      onStarted?.(currentStep);
    };
  }

  private appendResponseContent(
    turnId: number,
    currentStep: number,
    stepUuid: string,
    response: LLMRequestFinish,
  ): void {
    for (const part of response.message.content) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: String(turnId),
        step: currentStep,
        stepUuid,
        part,
      });
    }
  }

  private async executeStepTools(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    response: LLMRequestFinish,
  ): Promise<FinishReason> {
    let finishReason = response.providerFinishReason ?? 'completed';
    if (response.message.toolCalls.length === 0) {
      return finishReason === 'tool_calls' ? 'other' : finishReason;
    }
    const toolCallUuids = new Map<string, string>();
    let stopTurn = false;
    for await (const toolResult of this.toolExecutor.execute(response.message.toolCalls, {
      signal,
      turnId,
      onToolCall: ({ toolCallId, name, args }) => {
        const callUuid = randomUUID();
        toolCallUuids.set(toolCallId, callUuid);
        this.context.appendLoopEvent({
          type: 'tool.call',
          uuid: callUuid,
          turnId: String(turnId),
          step: currentStep,
          stepUuid,
          toolCallId,
          name,
          args,
        });
      },
    })) {
      const { result } = toolResult;
      this.context.appendLoopEvent({
        type: 'tool.result',
        parentUuid: toolCallUuids.get(toolResult.toolCallId) ?? randomUUID(),
        toolCallId: toolResult.toolCallId,
        result: { output: result.output, isError: result.isError, note: result.note },
      });
      if (result.stopTurn === true) stopTurn = true;
    }
    finishReason = stopTurn ? 'completed' : 'tool_calls';
    return finishReason;
  }

  private finishStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    stepUuid: string,
    response: LLMRequestFinish,
    finishReason: FinishReason,
    markStepStarted: () => void,
  ): void {
    signal.throwIfAborted();
    markStepStarted();
    const timing = response.timing;
    const stepFinishReason = normalizeFinishReason(finishReason);
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: stepUuid,
      turnId: String(turnId),
      step: currentStep,
      finishReason: stepFinishReason,
      usage: response.usage,
      llmFirstTokenLatencyMs: timing?.firstTokenLatencyMs,
      llmStreamDurationMs: timing?.streamDurationMs,
      llmRequestBuildMs: timing?.requestBuildMs,
      llmServerFirstTokenMs: timing?.serverFirstTokenMs,
      llmServerDecodeMs: timing?.serverDecodeMs,
      llmClientConsumeMs: timing?.clientConsumeMs,
      messageId: response.providerMessageId,
      providerFinishReason: response.providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
    this.emitStepCompleted(
      turnId,
      currentStep,
      stepUuid,
      response.usage,
      stepFinishReason,
      response,
    );
  }

  private async runAfterStep(
    turnId: number,
    signal: AbortSignal,
    currentStep: number,
    usage: TokenUsage,
    finishReason: FinishReason,
  ): Promise<boolean> {
    const context: AfterStepContext = {
      turnId,
      step: currentStep,
      signal,
      usage,
      finishReason,
      stopTurn: false,
    };
    try {
      await this.hooks.onDidFinishStep.run(context);
    } catch (error) {
      if (isAbortError(error) || signal.aborted) throw error;
    }
    return context.stopTurn;
  }

  private emitStepCompleted(
    turnId: number,
    step: number,
    stepId: string,
    usage: TokenUsage,
    finishReason: string,
    response: LLMRequestFinish,
  ): void {
    this.eventBus.publish({
      type: 'turn.step.completed',
      turnId,
      step,
      stepId,
      usage,
      finishReason,
      llmFirstTokenLatencyMs: response.timing?.firstTokenLatencyMs,
      llmStreamDurationMs: response.timing?.streamDurationMs,
      llmRequestBuildMs: response.timing?.requestBuildMs,
      llmServerFirstTokenMs: response.timing?.serverFirstTokenMs,
      llmServerDecodeMs: response.timing?.serverDecodeMs,
      llmClientConsumeMs: response.timing?.clientConsumeMs,
      providerFinishReason: response.providerFinishReason,
      rawFinishReason: response.rawFinishReason,
    });
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    this.eventBus.publish({
      type: 'turn.step.interrupted',
      turnId,
      step: activeStep,
      reason,
      message,
    });
  }

  private createStreamPartHandler(
    turnId: number,
    onResponseEvent: () => void,
  ): (part: StreamedMessagePart) => void {
    const callsByIndex = new Map<number | string | undefined, { id: string; name: string }>();

    return (part) => {
      switch (part.type) {
        case 'text':
          onResponseEvent();
          this.eventBus.publish({ type: 'assistant.delta', turnId, delta: part.text });
          return;
        case 'think':
          onResponseEvent();
          this.eventBus.publish({ type: 'thinking.delta', turnId, delta: part.think });
          return;
        case 'image_url':
        case 'audio_url':
        case 'video_url':
          return;
        case 'function': {
          onResponseEvent();
          callsByIndex.set(part._streamIndex, { id: part.id, name: part.name });
          this.eventBus.publish({
            type: 'tool.call.delta',
            turnId,
            toolCallId: part.id,
            name: part.name,
            argumentsPart: part.arguments ?? undefined,
          });
          return;
        }
        case 'tool_call_part': {
          if (part.argumentsPart === null) return;
          const toolCall = callsByIndex.get(part.index);
          if (toolCall === undefined) return;
          onResponseEvent();
          this.eventBus.publish({
            type: 'tool.call.delta',
            turnId,
            toolCallId: toolCall.id,
            name: toolCall.name,
            argumentsPart: part.argumentsPart,
          });
          return;
        }
        default: {
          const _exhaustive: never = part;
          return _exhaustive;
        }
      }
    };
  }
}

function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

type MutableStep = {
  -readonly [K in keyof Step]: Step[K];
} & {
  controller?: AbortController;
  resultControl?: ReturnType<typeof createControlledPromise<StepResult>>;
};

interface TurnJob {
  readonly request: StepRequest;
  readonly seed: TurnSeed;
  readonly controller: AbortController;
  readonly ready: ReturnType<typeof createControlledPromise<void>>;
  readonly result: ReturnType<typeof createControlledPromise<TurnResult>>;
  readonly queue: StepRequestQueue;
  readonly steps: Map<string, MutableStep>;
  readonly turn: MutableTurn;
}

interface LoopRuntime {
  readonly turnId: number;
  readonly turnSignal: AbortSignal;
  readonly job: TurnJob | undefined;
  readonly queue: StepRequestQueue;
  steps: number;
  lastStopReason: FinishReason | undefined;
  current: StepRuntime | undefined;
}

interface StepRuntime {
  readonly number: number;
  readonly uuid: string;
  readonly batch: StepRequestBatch;
  readonly mutableStep: MutableStep | undefined;
  readonly signal: AbortSignal;
}

type BeginStepResult = { readonly step: StepRuntime } | { readonly result: LoopRunResult };

function interruptReasonFor(
  result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>,
): TurnInterruptedEvent['interrupt_reason'] {
  if (result.type === 'cancelled') {
    return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  }
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) {
    return 'filtered';
  }
  return 'error';
}

type StepExecutionResult = {
  readonly stopReason: FinishReason;
  readonly hookStopTurn: boolean;
};

type LoopErrorDisposition =
  | { readonly type: 'continue' }
  | { readonly type: 'return'; readonly result: LoopRunResult };

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  InstantiationType.Delayed,
  'loop',
);
