import { randomUUID } from 'node:crypto';

import { createControlledPromise } from '@antfu/utils';

import { abortError, isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import type { Emitter } from '#/_base/event';
import type { IConfigService } from '#/app/config/config';
import { AgentErrorEvent } from '#/app/event/agentEvents';
import type { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import type {
  TurnEndedEvent as TurnEndedTelemetryEvent,
  TurnInterruptedEvent,
  TurnStartedEvent as TurnStartedTelemetryEvent,
} from '#/app/telemetry/events';
import type { ITelemetryService } from '#/app/telemetry/telemetry';
import type { IEventDispatcher } from '#/state/eventDispatcher';
import type { FinishReason } from '#/kosong/contract/provider';
import { mergeInPlace, type ContentPart, type StreamedMessagePart } from '#/kosong/contract/message';
import type { TokenUsage } from '#/kosong/contract/usage';
import type { LLMRequestTrace } from '#/kosong/contract/requestTrace';
import { ErrorCodes, Error2, isError2, toKimiErrorPayload } from '#/errors';
import type { ContextMemoryRuntime } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import { ContextAppendLoopEvent } from '#/actor/contextMemory/contextEvents';
import type { LoopRecordedEvent } from '#/actor/contextMemory/loopEventFold';
import { isVacuousContentPart } from '#/actor/contextMemory/vacuousContent';
import type { AgentLLMRequestFinish } from '#/actor/llmRequester/llmRequester';
import type { LlmRequesterRuntime } from '#/actor/llmRequester/llmRequesterAgentRuntime';
import type { AgentToolsRuntime } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import {
  AssistantDelta,
  ThinkingDelta,
  ToolCallDelta,
  TurnStepCompleted,
  TurnStepInterrupted,
  TurnStepStarted,
  type TurnInterruptReason,
} from '#/actor/loop/turnEvents';
import { TurnEnded } from '#/actor/loop/turnOps';
import type {
  LoopInterruptReason,
  LoopRetryActivity,
  LoopStreamKind,
  LoopTurnPhase,
} from '../loop';
import { LOOP_CONTROL_SECTION, type LoopControl as LoopControlConfig } from '../configSection';
import {
  createMaxStepsExceededError,
  isMaxStepsExceededError,
  type AfterStepContext,
  type LoopControl,
  type LoopErrorContext,
  type LoopErrorHandler,
  type LoopRunOptions,
  type LoopRunResult,
  type Step,
  type StepEnqueueOptions,
  type StepResult,
  type Turn,
  type TurnResult,
} from './loop';
import type { StepRequest, TurnSeed } from './stepRequest';
import { StepRequestQueue, type StepRequestBatch } from './stepRequestQueue';

export type { LoopInterruptReason } from '../loop';

export type ControlledPromise<T> = ReturnType<typeof createControlledPromise<T>>;

export type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

export type MutableStep = {
  -readonly [K in keyof Step]: Step[K];
} & {
  controller?: AbortController;
  resultControl?: ControlledPromise<StepResult>;
};

export interface LoopTraceSlot {
  current: LLMRequestTrace | undefined;
}

export interface LoopPhaseUpdate {
  readonly phase: LoopTurnPhase;
  readonly stream?: LoopStreamKind;
  readonly step?: number;
  readonly retry?: LoopRetryActivity;
}

export interface LoopPhaseSlot {
  last: LoopPhaseUpdate | undefined;
}

export interface TurnJobHandle {
  readonly request: StepRequest;
  readonly seed: TurnSeed;
  readonly controller: AbortController;
  readonly ready: ControlledPromise<void>;
  readonly result: ControlledPromise<TurnResult>;
  readonly queue: StepRequestQueue;
  readonly steps: Map<string, MutableStep>;
  readonly turn: MutableTurn;
  readonly phaseSlot: LoopPhaseSlot;
  finished: boolean;
}

export interface HeldAdmission {
  readonly request: StepRequest;
  readonly options?: StepEnqueueOptions;
}

export interface LoopProcessDeps {
  readonly agentId: string;
  readonly dispatcher: IEventDispatcher;
  readonly telemetry: ITelemetryService;
  readonly telemetryContext: IAgentTelemetryContextService;
  readonly config: IConfigService;
  readonly hooks: LoopControl['hooks'];
  readonly endEmitter: Emitter<{ readonly turnId: number; readonly result: TurnResult }>;
  readonly standaloneQueue: StepRequestQueue;
  readonly traceSlot: LoopTraceSlot;
  readonly errorHandlers: () => readonly LoopErrorHandler[];
  readonly activeTurn: () => TurnJobHandle | undefined;
  readonly llmRequester: () => LlmRequesterRuntime;
  readonly toolExecutor: () => AgentToolsRuntime;
  readonly contextMemory: () => ContextMemoryRuntime;
  readonly lastRequestTraceId: {
    get(): string | undefined;
    set(value: string | undefined): void;
  };
  readonly notifyStepInterrupted?: (turnId: number, reason: LoopInterruptReason) => void;
}

export interface TurnReleasedNotice {
  readonly type: 'loop.turnReleased';
  readonly handle: TurnJobHandle;
  readonly result?: TurnResult;
}

export interface LoopPumpNotice {
  readonly type: 'loop.pump';
}

export interface LoopPhaseNotice extends LoopPhaseUpdate {
  readonly type: 'loop.phase';
}

export interface LoopStepInterruptedNotice {
  readonly type: 'loop.stepInterrupted';
  readonly turnId: number;
  readonly reason: LoopInterruptReason;
}

export type TurnProcessNotice =
  | TurnReleasedNotice
  | LoopPumpNotice
  | LoopPhaseNotice
  | LoopStepInterruptedNotice;

export type NotifyPhase = (update: LoopPhaseUpdate) => void;

export function notifyPhaseFor(
  handle: TurnJobHandle,
  send: (notice: TurnProcessNotice) => void,
): NotifyPhase {
  return (update) => {
    if (handle.finished) return;
    const last = handle.phaseSlot.last;
    if (
      last !== undefined &&
      last.phase === update.phase &&
      last.stream === update.stream &&
      (update.step === undefined || last.step === update.step) &&
      last.retry?.nextAttempt === update.retry?.nextAttempt
    ) {
      return;
    }
    handle.phaseSlot.last = { ...update, step: update.step ?? last?.step };
    send({ type: 'loop.phase', ...update });
  };
}

export function enqueueStepIn(
  job: TurnJobHandle,
  request: StepRequest,
  options?: StepEnqueueOptions,
): Step {
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
    cancel: (reason) => cancelStepIn(step, request, reason),
  };
  job.steps.set(step.id, step);
  job.queue.enqueue(request, options?.at ?? 'tail');
  return step;
}

export function cancelStepIn(step: MutableStep, request: StepRequest, reason?: unknown): boolean {
  if (step.state === 'completed' || step.state === 'failed' || step.state === 'cancelled') return false;
  const cancellation = reason ?? userCancellationReason();
  step.state = 'cancelled';
  request.abort();
  step.controller?.abort(cancellation);
  step.resultControl?.resolve({ type: 'cancelled', reason: cancellation });
  return true;
}

export interface TurnProcessInput {
  readonly deps: LoopProcessDeps;
  readonly handle: TurnJobHandle;
  readonly send: (notice: TurnProcessNotice) => void;
}

export async function runTurnProcess(input: TurnProcessInput): Promise<TurnResult> {
  const { deps, handle, send } = input;
  const turn = handle.turn;
  const ready = handle.ready;
  const notifyPhase = notifyPhaseFor(handle, send);
  const startedAt = Date.now();
  deps.telemetryContext.set({ turn_id: turn.id });
  const telemetryContext = deps.telemetryContext.get();
  const turnTelemetry = deps.telemetry.withContext(telemetryContext);
  const { mode, provider_type, protocol } = telemetryContext;
  let thinkingEffort: string | undefined;
  let result: TurnResult | undefined;
  try {
    thinkingEffort = deps.llmRequester().getRequestConfig(turn.id)?.thinkingEffort;
    const started: TurnStartedTelemetryEvent = {
      turn_id: turn.id,
      mode,
      provider_type,
      protocol,
      thinking_effort: thinkingEffort,
    };
    turnTelemetry.track2('turn_started', started);
    result = await runLoop(
      deps,
      {
        turnId: turn.id,
        signal: turn.signal,
        onStarted: () => ready.resolve(),
      },
      handle,
      notifyPhase,
    );
    return result;
  } catch (error) {
    result = resultFromTurnError(turn, error);
    return result;
  } finally {
    settleTurnReady(ready, result);
    handle.finished = true;
    const traceId =
      result?.type === 'completed'
        ? deps.lastRequestTraceId.get()
        : deps.traceSlot.current?.traceId;
    if (result !== undefined) {
      deps.endEmitter.fire({ turnId: turn.id, result });
      const error = result.type === 'failed' ? toKimiErrorPayload(result.error) : undefined;
      const interruptReason =
        result.type === 'completed' ? undefined : interruptReasonFor(result);
      const durationMs = Date.now() - startedAt;
      void deps.dispatcher.dispatch(
        new TurnEnded({
          agentId: deps.agentId,
          turnId: turn.id,
          reason: result.type,
          error,
          durationMs,
          interruptReason,
        }),
      );
      if (error !== undefined) {
        void deps.dispatcher.dispatch(new AgentErrorEvent({ ...error, agentId: deps.agentId }));
      }
      if (interruptReason !== undefined) {
        const interrupted: TurnInterruptedEvent = {
          turn_id: turn.id,
          at_step: result.steps,
          mode,
          interrupt_reason: interruptReason,
          provider_type,
          protocol,
          thinking_effort: thinkingEffort,
          trace_id: traceId,
        };
        turnTelemetry.track2('turn_interrupted', interrupted);
      }
    }
    send({ type: 'loop.turnReleased', handle, result });
    const ended: TurnEndedTelemetryEvent = {
      turn_id: turn.id,
      reason: result?.type ?? 'failed',
      duration_ms: Date.now() - startedAt,
      mode,
      provider_type,
      protocol,
      thinking_effort: thinkingEffort,
      trace_id: traceId,
    };
    turnTelemetry.track2('turn_ended', ended);
    deps.traceSlot.current = undefined;
    deps.lastRequestTraceId.set(undefined);
    send({ type: 'loop.pump' });
  }
}

function resultFromTurnError(turn: Turn, error: unknown): TurnResult {
  const signal = turn.signal;
  if (!signal?.aborted) return { type: 'failed', error, steps: 0 };
  return { type: 'cancelled', steps: 0, reason: signal.reason ?? error };
}

function settleTurnReady(
  ready: ControlledPromise<void>,
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

interface LoopRuntimeBag {
  readonly turnId: number;
  readonly turnSignal: AbortSignal;
  readonly job: TurnJobHandle | undefined;
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

interface StreamPartCollector {
  readonly handle: (part: StreamedMessagePart) => void;
  drainInterruptedContent(): ContentPart[];
}

type LoopErrorDisposition =
  | { readonly type: 'continue' }
  | { readonly type: 'return'; readonly result: LoopRunResult };

type StepExecutionResult = {
  readonly stopReason: FinishReason;
  readonly hookStopTurn: boolean;
};

export async function runLoop(
  deps: LoopProcessDeps,
  options: LoopRunOptions,
  jobOverride?: TurnJobHandle,
  notifyPhase?: NotifyPhase,
): Promise<LoopRunResult> {
  const notify: NotifyPhase = notifyPhase ?? ((_update) => {});
  const runtime = createLoopRuntimeBag(deps, options, jobOverride);
  try {
    while (true) {
      try {
        const begun = beginLoopStep(deps, runtime);
        if ('result' in begun) return begun.result;
        runtime.current = begun.step;
        const result = await executeLoopStep(
          deps,
          runtime.turnId,
          begun.step.signal,
          runtime.turnSignal,
          begun.step.number,
          runtime.job !== undefined && begun.step.number === 1,
          begun.step.uuid,
          options.onStarted,
          notify,
        );
        const completed = completeLoopStep(runtime, result);
        if (completed !== undefined) return completed;
      } catch (error) {
        const disposition = await handleLoopStepError(deps, runtime, error);
        if (disposition.type === 'return') return disposition.result;
      }
    }
  } finally {
    runtime.queue.abortTurnScoped();
  }
}

function createLoopRuntimeBag(
  deps: LoopProcessDeps,
  options: LoopRunOptions,
  jobOverride?: TurnJobHandle,
): LoopRuntimeBag {
  const active = deps.activeTurn();
  const job = jobOverride ?? (active?.turn.id === options.turnId ? active : undefined);
  return {
    turnId: options.turnId,
    turnSignal: options.signal ?? new AbortController().signal,
    job,
    queue: job?.queue ?? deps.standaloneQueue,
    steps: 0,
    lastStopReason: undefined,
    current: undefined,
  };
}

function beginLoopStep(deps: LoopProcessDeps, runtime: LoopRuntimeBag): BeginStepResult {
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
  const maxSteps = deps.config.get<LoopControlConfig>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
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
  materializeBatch(deps, batch);
  return { step };
}

function completeLoopStep(
  runtime: LoopRuntimeBag,
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

async function handleLoopStepError(
  deps: LoopProcessDeps,
  runtime: LoopRuntimeBag,
  error: unknown,
): Promise<LoopErrorDisposition> {
  const cancellation = handleLoopCancellation(deps, runtime, error);
  if (cancellation !== undefined) return cancellation;
  const recovery = await tryRecoverLoopError(deps, runtime, error);
  return recovery ?? failLoopStep(deps, runtime, error);
}

function handleLoopCancellation(
  deps: LoopProcessDeps,
  runtime: LoopRuntimeBag,
  error: unknown,
): LoopErrorDisposition | undefined {
  const step = runtime.current?.mutableStep;
  if (!isAbortError(error) && !runtime.turnSignal.aborted && step?.signal.aborted !== true) return undefined;
  const reason = runtime.turnSignal.reason ?? step?.signal.reason ?? error;
  emitStepInterrupted(
    deps,
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

async function tryRecoverLoopError(
  deps: LoopProcessDeps,
  runtime: LoopRuntimeBag,
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
    retry: (request, retryOptions) => {
      if (runtime.job !== undefined) return enqueueStepIn(runtime.job, request, retryOptions);
      runtime.queue.enqueue(request, retryOptions?.at ?? 'tail');
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
  const handler = deps.errorHandlers().find((entry) => entry.match(context));
  if (handler === undefined) return undefined;
  try {
    if (await handler.handle(context)) {
      runtime.current = undefined;
      return { type: 'continue' };
    }
    return undefined;
  } catch (handlerError) {
    return (
      handleLoopCancellation(deps, runtime, handlerError) ?? failLoopStep(deps, runtime, handlerError)
    );
  }
}

function failLoopStep(
  deps: LoopProcessDeps,
  runtime: LoopRuntimeBag,
  error: unknown,
): LoopErrorDisposition {
  const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
  const interruptedError =
    isError2(error) && error.code === ErrorCodes.INTERNAL && error.cause !== undefined ? error.cause : error;
  emitStepInterrupted(deps, runtime.turnId, runtime.current?.number, reason, toErrorMessage(interruptedError));
  return { type: 'return', result: { type: 'failed', error, steps: runtime.steps } };
}

function materializeBatch(deps: LoopProcessDeps, batch: StepRequestBatch): void {
  materializeRequest(deps, batch.driver);
  for (const request of batch.merged) {
    materializeRequest(deps, request);
  }
}

function materializeRequest(deps: LoopProcessDeps, request: StepRequest): void {
  if (request.state !== 'pending') return;
  request.onWillMaterialize();
  const messages = request.resolveContextMessages();
  if (messages.length > 0) {
    void deps.contextMemory().append(...messages);
  }
  request.markMaterialized();
}

function appendLoopEvent(deps: LoopProcessDeps, event: LoopRecordedEvent): void {
  void deps.dispatcher.dispatch(new ContextAppendLoopEvent({ agentId: deps.agentId, event }));
}

async function executeLoopStep(
  deps: LoopProcessDeps,
  turnId: number,
  signal: AbortSignal,
  turnSignal: AbortSignal,
  currentStep: number,
  firstStepOfTurn: boolean,
  stepUuid: string,
  onStarted: ((step: number) => void) | undefined,
  notify: NotifyPhase,
): Promise<StepExecutionResult> {
  deps.traceSlot.current = undefined;
  await deps.hooks.onWillBeginStep.run({ turnId, step: currentStep, firstStepOfTurn, signal });
  const markStepStarted = beginStep(deps, turnId, signal, currentStep, stepUuid, onStarted, notify);
  let stepEndAppended = false;
  try {
    const streamParts = createStreamPartHandler(deps, turnId, markStepStarted, notify);
    const request = deps.llmRequester().stream(
      { source: { type: 'turn', turnId, step: currentStep } },
      streamParts.handle,
      signal,
    );
    deps.traceSlot.current = request.trace;
    let response: AgentLLMRequestFinish;
    try {
      response = await request.result;
    } catch (error) {
      appendInterruptedStreamContent(deps, turnId, currentStep, stepUuid, streamParts, turnSignal);
      throw error;
    }
    deps.lastRequestTraceId.set(request.trace.traceId);
    appendResponseContent(deps, turnId, currentStep, stepUuid, response);
    const finishReason = await executeStepTools(
      deps,
      turnId,
      signal,
      currentStep,
      stepUuid,
      response,
      request.trace,
      notify,
    );
    finishStep(deps, turnId, signal, currentStep, stepUuid, response, finishReason, markStepStarted);
    notify({ phase: 'working' });
    stepEndAppended = true;
    const hookStopTurn = await runAfterStep(
      deps,
      turnId,
      signal,
      currentStep,
      firstStepOfTurn,
      response.usage,
      finishReason,
    );
    return { stopReason: finishReason, hookStopTurn };
  } catch (error) {
    if (!stepEndAppended) {
      appendLoopEvent(deps, {
        type: 'step.end',
        uuid: stepUuid,
        turnId: String(turnId),
        step: currentStep,
        finishReason:
          isAbortError(error) || signal.aborted || turnSignal.aborted ? 'interrupted' : 'error',
      });
    }
    throw error;
  }
}

function beginStep(
  deps: LoopProcessDeps,
  turnId: number,
  signal: AbortSignal,
  currentStep: number,
  stepUuid: string,
  onStarted: ((step: number) => void) | undefined,
  notify: NotifyPhase,
): () => void {
  signal.throwIfAborted();
  void deps.dispatcher.dispatch(
    new TurnStepStarted({
      agentId: deps.agentId,
      turnId,
      step: currentStep,
      stepId: stepUuid,
    }),
  );
  notify({ phase: 'working', step: currentStep });
  appendLoopEvent(deps, {
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

function appendResponseContent(
  deps: LoopProcessDeps,
  turnId: number,
  currentStep: number,
  stepUuid: string,
  response: AgentLLMRequestFinish,
): void {
  for (const part of response.message.content) {
    appendLoopEvent(deps, {
      type: 'content.part',
      uuid: randomUUID(),
      turnId: String(turnId),
      step: currentStep,
      stepUuid,
      part,
    });
  }
}

function appendInterruptedStreamContent(
  deps: LoopProcessDeps,
  turnId: number,
  currentStep: number,
  stepUuid: string,
  streamParts: StreamPartCollector,
  turnSignal: AbortSignal,
): void {
  if (!turnSignal.aborted) return;
  for (const part of streamParts.drainInterruptedContent()) {
    appendLoopEvent(deps, {
      type: 'content.part',
      uuid: randomUUID(),
      turnId: String(turnId),
      step: currentStep,
      stepUuid,
      part,
    });
  }
}

async function executeStepTools(
  deps: LoopProcessDeps,
  turnId: number,
  signal: AbortSignal,
  currentStep: number,
  stepUuid: string,
  response: AgentLLMRequestFinish,
  trace: LLMRequestTrace,
  notify: NotifyPhase,
): Promise<FinishReason> {
  let finishReason = response.providerFinishReason ?? 'completed';
  if (response.message.toolCalls.length === 0) {
    return finishReason === 'tool_calls' ? 'other' : finishReason;
  }
  const toolCallUuids = new Map<string, string>();
  let stopTurn = false;
  for await (const toolResult of deps.toolExecutor().execute(response.message.toolCalls, {
    signal,
    turnId,
    trace,
    onToolCall: ({ toolCallId, name, args }) => {
      notify({ phase: 'toolCalling' });
      const callUuid = randomUUID();
      toolCallUuids.set(toolCallId, callUuid);
      const extras = response.message.toolCalls.find((t) => t.id === toolCallId)?.extras;
      appendLoopEvent(deps, {
        type: 'tool.call',
        uuid: callUuid,
        turnId: String(turnId),
        step: currentStep,
        stepUuid,
        toolCallId,
        name,
        args,
        extras,
      });
    },
  })) {
    const { result } = toolResult;
    appendLoopEvent(deps, {
      type: 'tool.result',
      parentUuid: toolCallUuids.get(toolResult.toolCallId) ?? randomUUID(),
      toolCallId: toolResult.toolCallId,
      result: { output: result.output, isError: result.isError, note: result.note },
    });
    if (result.stopTurn === true) stopTurn = true;
  }
  notify({ phase: 'working' });
  finishReason = stopTurn ? 'completed' : 'tool_calls';
  return finishReason;
}

function finishStep(
  deps: LoopProcessDeps,
  turnId: number,
  signal: AbortSignal,
  currentStep: number,
  stepUuid: string,
  response: AgentLLMRequestFinish,
  finishReason: FinishReason,
  markStepStarted: () => void,
): void {
  signal.throwIfAborted();
  markStepStarted();
  const timing = response.timing;
  const stepFinishReason = normalizeFinishReason(finishReason);
  appendLoopEvent(deps, {
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
  emitStepCompleted(deps, turnId, currentStep, stepUuid, response.usage, stepFinishReason, response);
}

async function runAfterStep(
  deps: LoopProcessDeps,
  turnId: number,
  signal: AbortSignal,
  currentStep: number,
  firstStepOfTurn: boolean,
  usage: TokenUsage,
  finishReason: FinishReason,
): Promise<boolean> {
  const context: AfterStepContext = {
    turnId,
    step: currentStep,
    firstStepOfTurn,
    signal,
    usage,
    finishReason,
    stopTurn: false,
  };
  try {
    await deps.hooks.onDidFinishStep.run(context);
  } catch (error) {
    if (isAbortError(error) || signal.aborted) throw error;
  }
  return context.stopTurn;
}

function emitStepCompleted(
  deps: LoopProcessDeps,
  turnId: number,
  step: number,
  stepId: string,
  usage: TokenUsage,
  finishReason: string,
  response: AgentLLMRequestFinish,
): void {
  void deps.dispatcher.dispatch(
    new TurnStepCompleted({
      agentId: deps.agentId,
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
    }),
  );
}

export function emitStepInterrupted(
  deps: Pick<LoopProcessDeps, 'agentId' | 'dispatcher' | 'notifyStepInterrupted'>,
  turnId: number,
  activeStep: number | undefined,
  reason: LoopInterruptReason,
  message?: string,
): void {
  if (activeStep === undefined) return;
  void deps.dispatcher.dispatch(
    new TurnStepInterrupted({
      agentId: deps.agentId,
      turnId,
      step: activeStep,
      reason,
      message,
    }),
  );
  deps.notifyStepInterrupted?.(turnId, reason);
}

function createStreamPartHandler(
  deps: LoopProcessDeps,
  turnId: number,
  onResponseEvent: () => void,
  notify: NotifyPhase,
): StreamPartCollector {
  const callsByIndex = new Map<number | string | undefined, { id: string; name: string }>();
  const partialContent: ContentPart[] = [];
  let forceContentPartBoundary = false;
  const accumulate = (part: ContentPart): void => {
    const last = partialContent.at(-1);
    if (!forceContentPartBoundary && last !== undefined && mergeInPlace(last, part)) return;
    forceContentPartBoundary = false;
    partialContent.push({ ...part });
  };

  return {
    handle: (part) => {
      switch (part.type) {
        case 'text':
          onResponseEvent();
          accumulate(part);
          void deps.dispatcher.dispatch(
            new AssistantDelta({ agentId: deps.agentId, turnId, delta: part.text }),
          );
          notify({ phase: 'streaming', stream: 'assistant' });
          return;
        case 'think':
          onResponseEvent();
          accumulate(part);
          void deps.dispatcher.dispatch(
            new ThinkingDelta({ agentId: deps.agentId, turnId, delta: part.think }),
          );
          notify({ phase: 'streaming', stream: 'thinking' });
          return;
        case 'image_url':
        case 'audio_url':
        case 'video_url':
          return;
        case 'function': {
          onResponseEvent();
          forceContentPartBoundary = true;
          callsByIndex.set(part._streamIndex, { id: part.id, name: part.name });
          void deps.dispatcher.dispatch(
            new ToolCallDelta({
              agentId: deps.agentId,
              turnId,
              toolCallId: part.id,
              name: part.name,
              argumentsPart: part.arguments ?? undefined,
            }),
          );
          notify({ phase: 'streaming', stream: 'tool_call' });
          return;
        }
        case 'tool_call_part': {
          if (part.argumentsPart === null) return;
          const toolCall = callsByIndex.get(part.index);
          if (toolCall === undefined) return;
          onResponseEvent();
          void deps.dispatcher.dispatch(
            new ToolCallDelta({
              agentId: deps.agentId,
              turnId,
              toolCallId: toolCall.id,
              name: toolCall.name,
              argumentsPart: part.argumentsPart,
            }),
          );
          notify({ phase: 'streaming', stream: 'tool_call' });
          return;
        }
        default: {
          const _exhaustive: never = part;
          return _exhaustive;
        }
      }
    },
    drainInterruptedContent: () =>
      partialContent.splice(0).filter((part) => !isVacuousContentPart(part)),
  };
}

function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

export function interruptReasonFor(
  result: Extract<TurnResult, { readonly type: 'cancelled' | 'failed' }>,
): TurnInterruptReason {
  if (result.type === 'cancelled') {
    return isUserCancellation(result.reason) ? 'user_cancelled' : 'aborted';
  }
  if (isMaxStepsExceededError(result.error)) return 'max_steps';
  if (isError2(result.error) && result.error.code === ErrorCodes.PROVIDER_FILTERED) {
    return 'filtered';
  }
  return 'error';
}

export function cancelReasonFor(cancellation: unknown): 'user_cancelled' | 'aborted' {
  return isUserCancellation(cancellation) ? 'user_cancelled' : 'aborted';
}
