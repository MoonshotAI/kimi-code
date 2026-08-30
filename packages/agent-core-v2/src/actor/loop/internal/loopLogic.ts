import { createControlledPromise } from '@antfu/utils';
import { assign, enqueueActions, fromCallback, setup } from 'xstate';

import { toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { defineState } from '#/state/state';
import { abortError, userCancellationReason } from '#/_base/utils/abort';
import { BugIndicatingError } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import { IAgentHostService, type AgentHost } from '#/agent/host/agentHost';
import { IConfigService } from '#/app/config/config';
import { IAgentLifecycleService } from '#/session/agentLifecycle/agentLifecycle';
import { AgentContextMemory } from '#/actor/contextMemory/contextMemoryAgentRuntime';
import { AgentLlmRequester } from '#/actor/llmRequester/llmRequesterAgentRuntime';
import { AgentTools } from '#/actor/toolExecutor/toolExecutorAgentRuntime';
import type { AgentRuntimeContext, AgentRuntimeRestoreEvent } from '#/actor/agentRuntime';
import {
  isDisplayablePromptOrigin,
  turnPromptAttachments,
  turnPromptText,
  TurnStarted,
} from '#/actor/loop/turnEvents';
import { TurnCancel, TurnPrompt } from '#/actor/loop/turnOps';
import { registerLoopControl, type LoopDurableState } from './access';
import type { LoopResult } from '../loop';
import {
  type AgentLoopStatus,
  type EnqueueReceipt,
  type LoopControl,
  type LoopErrorHandler,
  type LoopErrorHandlerRegistrationOptions,
  type LoopPhaseState,
  type LoopRunOptions,
  type LoopRunResult,
  type StepAssignment,
  type StepEnqueueOptions,
  type Turn,
  type TurnResult,
} from './loop';
import type { StepRequest, TurnSeed } from './stepRequest';
import { StepRequestQueue } from './stepRequestQueue';
import { AgentStepRetry } from './stepRetry';
import { AgentLoopContinuation } from './loopContinuation';
import {
  cancelReasonFor,
  enqueueStepIn,
  notifyPhaseFor,
  runLoop,
  runTurnProcess,
  type ControlledPromise,
  type HeldAdmission,
  type LoopPhaseNotice,
  type LoopProcessDeps,
  type LoopPumpNotice,
  type LoopTraceSlot,
  type MutableTurn,
  type TurnJobHandle,
  type TurnProcessInput,
  type TurnProcessNotice,
  type TurnReleasedNotice,
} from './turnProcess';

export type { LoopInterruptReason } from './turnProcess';

export const loopNextReservedTurnIdKey = defineState<number | undefined>(
  'loop.nextReservedTurnId',
  () => undefined as number | undefined,
);
export const loopLastRequestTraceIdKey = defineState<string | undefined>(
  'loop.lastRequestTraceId',
  () => undefined as string | undefined,
);
export const loopDisposingKey = defineState<boolean>('loop.disposing', () => false);

export interface LoopMachineContext {
  readonly runtime: AgentRuntimeContext<LoopDurableState>;
  readonly host: AgentHost;
  readonly deps: LoopProcessDeps;
  readonly hooks: LoopControl['hooks'];
  readonly errorHandlers: LoopErrorHandler[];
  readonly startEmitter: Emitter<number>;
  readonly endEmitter: Emitter<{ readonly turnId: number; readonly result: TurnResult }>;
  readonly phaseEmitter: Emitter<LoopPhaseState>;
  readonly standaloneQueue: StepRequestQueue;
  readonly pendingAssignments: Map<StepRequest, ControlledPromise<StepAssignment>>;
  readonly settleWaiters: Array<() => void>;
  readonly traceSlot: LoopTraceSlot;
  state: LoopDurableState;
  pendingTurns: readonly TurnJobHandle[];
  heldAdmissions: readonly HeldAdmission[];
  activeTurn: TurnJobHandle | undefined;
  lastResult: LoopResult;
  phase: LoopPhaseState;
}

interface LoopCommitEvent {
  readonly type: 'loop.commit';
  readonly state: LoopDurableState;
}

interface LoopEnqueueEvent {
  readonly type: 'loop.enqueue';
  readonly request: StepRequest;
  readonly options?: StepEnqueueOptions;
  readonly assignment: ControlledPromise<StepAssignment>;
  readonly reply: { error?: unknown };
}

interface LoopAdmitEvent {
  readonly type: 'loop.admit';
  readonly request: StepRequest;
  readonly options?: StepEnqueueOptions;
}

interface LoopCancelEvent {
  readonly type: 'loop.cancel';
  readonly turnId?: number;
  readonly cancellation?: unknown;
  readonly reply: { value: boolean };
}

interface LoopAbortRequestEvent {
  readonly type: 'loop.abortRequest';
  readonly request: StepRequest;
  readonly reason?: unknown;
  readonly reply: { value: boolean };
}

interface LoopAcquireEvent {
  readonly type: 'loop.acquire';
  readonly reply: { value?: IDisposable };
}

interface LoopReleaseEvent {
  readonly type: 'loop.release';
}

type LoopMachineEvent =
  | LoopCommitEvent
  | LoopEnqueueEvent
  | LoopAdmitEvent
  | LoopCancelEvent
  | LoopAbortRequestEvent
  | LoopAcquireEvent
  | LoopReleaseEvent
  | TurnProcessNotice
  | AgentRuntimeRestoreEvent;

interface MachineEffects {
  assign(updates: Partial<LoopMachineContext>): void;
  raise(event: LoopPumpNotice | LoopAdmitEvent): void;
}

function machineOf(runtime: AgentRuntimeContext<LoopDurableState>): LoopMachineContext {
  return runtime.getLogicState<LoopMachineContext>();
}

function createLoopProcessDeps(
  runtime: AgentRuntimeContext<LoopDurableState>,
  host: AgentHost,
  parts: {
    readonly hooks: LoopControl['hooks'];
    readonly errorHandlers: LoopErrorHandler[];
    readonly endEmitter: LoopMachineContext['endEmitter'];
    readonly standaloneQueue: StepRequestQueue;
    readonly traceSlot: LoopTraceSlot;
  },
): LoopProcessDeps {
  return {
    agentId: runtime.agent.agentId,
    dispatcher: host.dispatcher,
    telemetry: host.telemetry,
    telemetryContext: host.telemetryContext,
    get config() {
      return runtime.get(IConfigService);
    },
    hooks: parts.hooks,
    endEmitter: parts.endEmitter,
    standaloneQueue: parts.standaloneQueue,
    traceSlot: parts.traceSlot,
    errorHandlers: () => parts.errorHandlers,
    activeTurn: () => machineOf(runtime).activeTurn,
    llmRequester: () =>
      runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentLlmRequester),
    toolExecutor: () => runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentTools),
    contextMemory: () =>
      runtime.get(IAgentLifecycleService).resolve(runtime.agent, AgentContextMemory),
    lastRequestTraceId: {
      get: () => host.state.get(loopLastRequestTraceIdKey),
      set: (value) => {
        host.state.set(loopLastRequestTraceIdKey, value);
      },
    },
  };
}

function reserveTurnId(context: LoopMachineContext): number {
  const states = context.host.state;
  const modelNextId = context.runtime.getState().nextTurnId ?? 0;
  const id = Math.max(modelNextId, states.get(loopNextReservedTurnIdKey) ?? modelNextId);
  states.set(loopNextReservedTurnIdKey, id + 1);
  return id;
}

function rejectAssignment(context: LoopMachineContext, request: StepRequest, reason: unknown): void {
  const assignment = context.pendingAssignments.get(request);
  assignment?.reject(reason instanceof Error ? reason : abortError('Step request aborted'));
  context.pendingAssignments.delete(request);
}

function assignStepTo(
  context: LoopMachineContext,
  job: TurnJobHandle,
  request: StepRequest,
  options?: StepEnqueueOptions,
): void {
  const step = enqueueStepIn(job, request, options);
  const assignment = context.pendingAssignments.get(request);
  assignment?.resolve({ turn: job.turn, step });
  context.pendingAssignments.delete(request);
}

function moveStandaloneStepsTo(context: LoopMachineContext, job: TurnJobHandle): void {
  for (const pending of context.standaloneQueue.drain()) {
    if (!pending.aborted) assignStepTo(context, job, pending);
  }
}

function createTurnJobHandle(
  context: LoopMachineContext,
  request: StepRequest,
  seed: TurnSeed,
): TurnJobHandle {
  const id = reserveTurnId(context);
  const controller = new AbortController();
  const ready = createControlledPromise<void>();
  const result = createControlledPromise<TurnResult>();
  void ready.catch(() => undefined);
  const runtime = context.runtime;
  const turn: MutableTurn = {
    id,
    state: 'queued',
    signal: controller.signal,
    ready,
    result,
    cancel: (reason) => {
      const reply = { value: false };
      runtime.send({ type: 'loop.cancel', turnId: id, cancellation: reason, reply });
      return reply.value;
    },
  };
  const job: TurnJobHandle = {
    request,
    seed,
    controller,
    ready,
    result,
    queue: new StepRequestQueue(),
    steps: new Map(),
    turn,
    phaseSlot: { last: undefined },
    finished: false,
  };
  assignStepTo(context, job, request);
  moveStandaloneStepsTo(context, job);
  return job;
}

function admitRequest(
  context: LoopMachineContext,
  effects: MachineEffects,
  request: StepRequest,
  options?: StepEnqueueOptions,
): { error?: unknown } {
  const active = context.activeTurn;
  const queueNewTurn = (): { error?: unknown } => {
    const seed = request.turnSeed;
    if (seed === undefined) {
      const error = new BugIndicatingError(
        `Step request "${request.kind}" cannot start a turn without turnSeed`,
      );
      rejectAssignment(context, request, error);
      return { error };
    }
    const job = createTurnJobHandle(context, request, seed);
    effects.assign({ pendingTurns: [...context.pendingTurns, job] });
    effects.raise({ type: 'loop.pump' });
    return {};
  };
  switch (request.admission) {
    case 'newTurn':
      return queueNewTurn();
    case 'activeOrNewTurn':
      if (active === undefined) return queueNewTurn();
      assignStepTo(context, active, request, options);
      return {};
    case 'activeOrNextTurn':
      if (active === undefined) {
        context.standaloneQueue.enqueue(request, options?.at ?? 'tail');
        return {};
      }
      assignStepTo(context, active, request, options);
      return {};
    case 'activeTurnOnly': {
      if (active === undefined) {
        const error = new BugIndicatingError(
          `Step request "${request.kind}" requires an active turn`,
        );
        rejectAssignment(context, request, error);
        return { error };
      }
      assignStepTo(context, active, request, options);
      return {};
    }
  }
}

function maybeSettleWith(
  context: LoopMachineContext,
  counts?: {
    readonly pendingTurns?: number;
    readonly heldAdmissions?: number;
    readonly activeCleared?: boolean;
  },
): void {
  const active = counts?.activeCleared === true ? undefined : context.activeTurn;
  const pendingCount = counts?.pendingTurns ?? context.pendingTurns.length;
  const heldCount = counts?.heldAdmissions ?? context.heldAdmissions.length;
  if (active !== undefined || pendingCount > 0 || heldCount > 0) return;
  if (context.settleWaiters.length === 0) return;
  const waiters = context.settleWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

function dispatchTurnCancel(
  context: LoopMachineContext,
  turnId: number,
  target: 'active' | 'queued',
  cancellation: unknown,
): void {
  void context.deps.dispatcher.dispatch(
    new TurnCancel({
      agentId: context.runtime.agent.agentId,
      turnId,
      target,
      reason: cancelReasonFor(cancellation),
    }),
  );
}

function cancelActiveIn(
  context: LoopMachineContext,
  turnId: number | undefined,
  cancellation: unknown,
): boolean {
  const job = context.activeTurn;
  if (job === undefined || (turnId !== undefined && job.turn.id !== turnId)) return false;
  if (job.controller.signal.aborted) return true;
  dispatchTurnCancel(context, job.turn.id, 'active', cancellation);
  job.controller.abort(cancellation);
  return true;
}

function settleCancelledQueuedTurn(job: TurnJobHandle, cancellation: unknown): void {
  for (const step of job.steps.values()) step.cancel(cancellation);
  job.controller.abort(cancellation);
  job.turn.state = 'cancelled';
  job.ready.reject(cancellation instanceof Error ? cancellation : abortError('Turn cancelled'));
  job.result.resolve({ type: 'cancelled', steps: 0, reason: cancellation });
}

function cancelTurnIn(
  context: LoopMachineContext,
  effects: MachineEffects,
  turnId: number | undefined,
  cancellation: unknown,
): boolean {
  if (cancelActiveIn(context, turnId, cancellation)) return true;
  if (turnId === undefined) return false;
  const index = context.pendingTurns.findIndex((job) => job.turn.id === turnId);
  if (index < 0) return false;
  const job = context.pendingTurns[index]!;
  const remaining = context.pendingTurns.filter((_, i) => i !== index);
  effects.assign({ pendingTurns: remaining });
  if (job.turn.state !== 'queued') return false;
  dispatchTurnCancel(context, turnId, 'queued', cancellation);
  settleCancelledQueuedTurn(job, cancellation);
  maybeSettleWith(context, { pendingTurns: remaining.length });
  return true;
}

function abortRequestIn(
  context: LoopMachineContext,
  effects: MachineEffects,
  request: StepRequest,
  reason: unknown,
): boolean {
  const heldIndex = context.heldAdmissions.findIndex((entry) => entry.request === request);
  if (heldIndex >= 0) {
    const remaining = context.heldAdmissions.filter((_, i) => i !== heldIndex);
    effects.assign({ heldAdmissions: remaining });
    if (!request.abort()) return false;
    rejectAssignment(context, request, reason ?? userCancellationReason());
    maybeSettleWith(context, { heldAdmissions: remaining.length });
    return true;
  }
  for (const job of [context.activeTurn, ...context.pendingTurns]) {
    if (job === undefined) continue;
    if (job.turn.state === 'queued' && job.request === request) {
      return cancelTurnIn(context, effects, job.turn.id, reason ?? userCancellationReason());
    }
    const step = job.steps.get(request.id);
    if (step !== undefined) return step.cancel(reason);
  }
  if (!request.abort()) return false;
  rejectAssignment(context, request, reason ?? userCancellationReason());
  return true;
}

export function registerErrorHandlerIn(
  handlers: LoopErrorHandler[],
  handler: LoopErrorHandler,
  options: LoopErrorHandlerRegistrationOptions = {},
): IDisposable {
  if (options.before !== undefined && options.after !== undefined) {
    throw new BugIndicatingError('Loop error handler registration cannot specify both before and after');
  }
  const remove = (id: string): boolean => {
    const index = handlers.findIndex((entry) => entry.id === id);
    if (index < 0) return false;
    handlers.splice(index, 1);
    return true;
  };
  remove(handler.id);
  const target = options.before ?? options.after;
  if (target === undefined) {
    handlers.push(handler);
  } else {
    const targetIndex = handlers.findIndex((entry) => entry.id === target);
    if (targetIndex < 0) {
      throw new BugIndicatingError(`Loop error handler target "${target}" is not registered`);
    }
    const insertAt = options.before !== undefined ? targetIndex : targetIndex + 1;
    handlers.splice(insertAt, 0, handler);
  }
  return toDisposable(() => {
    remove(handler.id);
  });
}

function loopResultOf(result: TurnResult): LoopResult {
  return {
    status:
      result.type === 'completed' ? 'settled' : result.type === 'cancelled' ? 'cancelled' : 'idle',
  };
}

function phaseChanged(context: LoopMachineContext, event: LoopMachineEvent): boolean {
  const e = event as LoopPhaseNotice;
  return context.phase.phase !== e.phase || context.phase.stream !== e.stream;
}

const turnProcess = fromCallback(({ input }: { input: TurnProcessInput }) => {
  void runTurnProcess(input).then(input.handle.result.resolve, input.handle.result.reject);
  return () => {
    const handle = input.handle;
    if (handle.finished) return;
    const reason = abortError('Agent loop disposed');
    if (!handle.controller.signal.aborted) {
      void input.deps.dispatcher.dispatch(
        new TurnCancel({
          agentId: input.deps.agentId,
          turnId: handle.turn.id,
          target: 'active',
          reason: cancelReasonFor(reason),
        }),
      );
      handle.controller.abort(reason);
    }
  };
});

function disposeQueuedTurn(context: LoopMachineContext, job: TurnJobHandle, reason: Error): void {
  if (job.turn.state !== 'queued') return;
  dispatchTurnCancel(context, job.turn.id, 'queued', reason);
  settleCancelledQueuedTurn(job, reason);
}

function disposeLoop(runtime: AgentRuntimeContext<LoopDurableState>): void {
  const states = machineOf(runtime).host.state;
  if (states.get(loopDisposingKey)) return;
  states.set(loopDisposingKey, true);
  const reason = abortError('Agent loop disposed');
  const context = machineOf(runtime);
  for (const job of context.pendingTurns) disposeQueuedTurn(context, job, reason);
  const active = context.activeTurn;
  if (active !== undefined && !active.controller.signal.aborted) {
    dispatchTurnCancel(context, active.turn.id, 'active', reason);
    active.controller.abort(reason);
  }
  for (const request of context.standaloneQueue.drain()) {
    request.abort();
    rejectAssignment(context, request, reason);
  }
  for (const { request } of context.heldAdmissions) {
    request.abort();
    rejectAssignment(context, request, reason);
  }
  const waiters = context.settleWaiters.splice(0);
  for (const resolve of waiters) resolve();
}

const loopEffects = fromCallback(
  ({ input }: { input: AgentRuntimeContext<LoopDurableState> }) => {
    const runtime = input;
    const host = machineOf(runtime).host;
    host.state.contributeState(loopNextReservedTurnIdKey);
    host.state.contributeState(loopLastRequestTraceIdKey);
    host.state.contributeState(loopDisposingKey);
    const control = new MachineLoopControl(runtime);
    registerLoopControl(runtime.agent, control, () => runtime.getState());
    const stepRetry = new AgentStepRetry(
      control,
      runtime.get(IConfigService),
      host.eventBus,
      host.dispatcher,
      host.scopeContext,
      host.state,
      () => {
        const active = machineOf(runtime).activeTurn;
        if (active === undefined) return;
        notifyPhaseFor(active, (notice) => runtime.send(notice))('retrying');
      },
    );
    const continuation = new AgentLoopContinuation(control);
    return () => {
      disposeLoop(runtime);
      stepRetry.dispose();
      continuation.dispose();
    };
  },
);

export const loopActorLogic = setup({
  types: {} as {
    context: LoopMachineContext;
    input: AgentRuntimeContext<LoopDurableState>;
    events: LoopMachineEvent;
  },
  actors: { loopEffects, turnProcess },
  actions: {
    commitState: assign({
      state: ({ event }) => (event as LoopCommitEvent).state,
    }),
    handleEnqueue: enqueueActions(({ context, event, enqueue }) => {
      const e = event as LoopEnqueueEvent;
      const effects: MachineEffects = {
        assign: (updates) => {
          enqueue.assign(updates);
        },
        raise: (raised) => {
          enqueue.raise(raised);
        },
      };
      context.pendingAssignments.set(e.request, e.assignment);
      const outcome = admitRequest(context, effects, e.request, e.options);
      if (outcome.error !== undefined) e.reply.error = outcome.error;
    }),
    handleAdmit: enqueueActions(({ context, event, enqueue }) => {
      const e = event as LoopAdmitEvent;
      if (e.request.aborted) return;
      const effects: MachineEffects = {
        assign: (updates) => {
          enqueue.assign(updates);
        },
        raise: (raised) => {
          enqueue.raise(raised);
        },
      };
      const outcome = admitRequest(context, effects, e.request, e.options);
      if (outcome.error !== undefined) {
        e.request.abort();
        rejectAssignment(context, e.request, outcome.error);
      }
    }),
    holdAdmission: enqueueActions(({ context, event, enqueue }) => {
      const e = event as LoopEnqueueEvent;
      context.pendingAssignments.set(e.request, e.assignment);
      enqueue.assign({
        heldAdmissions: [...context.heldAdmissions, { request: e.request, options: e.options }],
      });
    }),
    handleRelease: enqueueActions(({ context, enqueue }) => {
      const held = context.heldAdmissions;
      enqueue.assign({ heldAdmissions: [] });
      enqueue.raise({ type: 'loop.pump' });
      for (const admission of held) {
        enqueue.raise({
          type: 'loop.admit',
          request: admission.request,
          options: admission.options,
        });
      }
      enqueue.raise({ type: 'loop.pump' });
    }),
    replyAcquired: ({ context, event }) => {
      (event as LoopAcquireEvent).reply.value = toDisposable(() => {
        context.runtime.send({ type: 'loop.release' });
      });
    },
    popNextTurn: assign(({ context }) => ({
      pendingTurns: context.pendingTurns.slice(1),
      activeTurn: context.pendingTurns[0],
      phase: { phase: 'working' } as LoopPhaseState,
    })),
    startTurnEffects: ({ context }) => {
      const job = context.activeTurn!;
      const origin = job.seed.origin;
      void context.deps.dispatcher.dispatch(
        new TurnPrompt({ agentId: context.runtime.agent.agentId, input: job.seed.input, origin }),
      );
      job.turn.state = 'running';
      context.startEmitter.fire(job.turn.id);
      void context.deps.dispatcher.dispatch(
        new TurnStarted({
          agentId: context.runtime.agent.agentId,
          turnId: job.turn.id,
          origin,
          prompt: isDisplayablePromptOrigin(origin)
            ? turnPromptText(job.seed.input, origin)
            : undefined,
          promptAttachments: turnPromptAttachments(job.seed.input),
        }),
      );
      context.phaseEmitter.fire(context.phase);
    },
    settleIfIdle: ({ context }) => {
      maybeSettleWith(context);
    },
    applyPhase: assign(({ event }) => {
      const e = event as LoopPhaseNotice;
      return { phase: { phase: e.phase, stream: e.stream } as LoopPhaseState };
    }),
    firePhase: ({ context }) => {
      context.phaseEmitter.fire(context.phase);
    },
    releaseTurnHandle: ({ event }) => {
      const e = event as TurnReleasedNotice;
      const handle = e.handle;
      handle.turn.state = e.result?.type ?? 'failed';
      const reason = e.result?.type === 'cancelled' ? e.result.reason : abortError('Turn ended');
      for (const step of handle.steps.values()) {
        if (step.state === 'queued' || step.state === 'running') step.cancel(reason);
      }
    },
    clearActiveTurn: assign(({ context, event }) => {
      const e = event as TurnReleasedNotice;
      return {
        activeTurn: undefined,
        phase: { phase: 'idle' } as LoopPhaseState,
        lastResult: e.result === undefined ? context.lastResult : loopResultOf(e.result),
      };
    }),
    afterTurnReleased: ({ context }) => {
      context.phaseEmitter.fire(context.phase);
      maybeSettleWith(context);
    },
    markStaleTurnReleased: ({ event }) => {
      const e = event as TurnReleasedNotice;
      e.handle.turn.state = e.result?.type ?? 'failed';
    },
    handleCancel: enqueueActions(({ context, event, enqueue }) => {
      const e = event as LoopCancelEvent;
      const effects: MachineEffects = {
        assign: (updates) => {
          enqueue.assign(updates);
        },
        raise: (raised) => {
          enqueue.raise(raised);
        },
      };
      const cancellation = e.cancellation ?? userCancellationReason();
      e.reply.value = cancelTurnIn(context, effects, e.turnId, cancellation);
    }),
    handleAbortRequest: enqueueActions(({ context, event, enqueue }) => {
      const e = event as LoopAbortRequestEvent;
      const effects: MachineEffects = {
        assign: (updates) => {
          enqueue.assign(updates);
        },
        raise: (raised) => {
          enqueue.raise(raised);
        },
      };
      e.reply.value = abortRequestIn(context, effects, e.request, e.reason);
    }),
  },
  guards: {
    hasQueuedTurn: ({ context }) =>
      context.pendingTurns.length > 0 && !context.host.state.get(loopDisposingKey),
    canAcquire: ({ context }) =>
      context.pendingTurns.length === 0 &&
      !context.standaloneQueue.hasPendingRequests() &&
      !context.heldAdmissions.some(({ request }) => !request.aborted),
    turnReleasedMatches: ({ context, event }) =>
      context.activeTurn === (event as TurnReleasedNotice).handle,
    phaseStreaming: ({ context, event }) =>
      (event as LoopPhaseNotice).phase === 'streaming' && phaseChanged(context, event),
    phaseToolCalling: ({ context, event }) =>
      (event as LoopPhaseNotice).phase === 'toolCalling' && phaseChanged(context, event),
    phaseRetrying: ({ context, event }) =>
      (event as LoopPhaseNotice).phase === 'retrying' && phaseChanged(context, event),
    phaseWorking: ({ context, event }) =>
      (event as LoopPhaseNotice).phase === 'working' && phaseChanged(context, event),
  },
}).createMachine({
  context: ({ input }) => {
    const host = input.get(IAgentHostService).of(input.agent);
    const hooks: LoopControl['hooks'] = {
      onWillBeginStep: new OrderedHookSlot(),
      onDidFinishStep: new OrderedHookSlot(),
    };
    const errorHandlers: LoopErrorHandler[] = [];
    const endEmitter = new Emitter<{ readonly turnId: number; readonly result: TurnResult }>();
    const standaloneQueue = new StepRequestQueue();
    const traceSlot: LoopTraceSlot = { current: undefined };
    return {
      runtime: input,
      host,
      deps: createLoopProcessDeps(input, host, {
        hooks,
        errorHandlers,
        endEmitter,
        standaloneQueue,
        traceSlot,
      }),
      hooks,
      errorHandlers,
      startEmitter: new Emitter<number>(),
      endEmitter,
      phaseEmitter: new Emitter<LoopPhaseState>(),
      standaloneQueue,
      pendingAssignments: new Map(),
      settleWaiters: [],
      traceSlot,
      state: { nextTurnId: 0, cancelledTurnIds: [] },
      pendingTurns: [],
      heldAdmissions: [],
      activeTurn: undefined,
      lastResult: { status: 'idle' },
      phase: { phase: 'idle' },
    };
  },
  invoke: {
    src: 'loopEffects',
    input: ({ context }) => context.runtime,
  },
  initial: 'idle',
  states: {
    idle: {
      on: {
        'loop.enqueue': { actions: 'handleEnqueue' },
        'loop.admit': { actions: 'handleAdmit' },
        'loop.acquire': {
          guard: 'canAcquire',
          target: 'quiescent',
          actions: 'replyAcquired',
        },
        'loop.pump': [
          {
            guard: 'hasQueuedTurn',
            target: 'running',
            actions: ['popNextTurn', 'startTurnEffects'],
          },
          { actions: 'settleIfIdle' },
        ],
      },
    },
    quiescent: {
      on: {
        'loop.enqueue': { actions: 'holdAdmission' },
        'loop.release': {
          target: 'idle',
          actions: 'handleRelease',
        },
      },
    },
    running: {
      invoke: {
        src: 'turnProcess',
        input: ({ context }): TurnProcessInput => ({
          deps: context.deps,
          handle: context.activeTurn!,
          send: (notice: TurnProcessNotice) => {
            context.runtime.send(notice);
          },
        }),
      },
      initial: 'working',
      states: {
        working: {},
        streaming: {},
        toolCalling: {},
        retrying: {},
      },
      on: {
        'loop.enqueue': { actions: 'handleEnqueue' },
        'loop.admit': { actions: 'handleAdmit' },
        'loop.phase': [
          { guard: 'phaseStreaming', target: '.streaming', actions: ['applyPhase', 'firePhase'] },
          { guard: 'phaseToolCalling', target: '.toolCalling', actions: ['applyPhase', 'firePhase'] },
          { guard: 'phaseRetrying', target: '.retrying', actions: ['applyPhase', 'firePhase'] },
          { guard: 'phaseWorking', target: '.working', actions: ['applyPhase', 'firePhase'] },
        ],
        'loop.turnReleased': [
          {
            guard: 'turnReleasedMatches',
            target: 'settling',
            actions: ['releaseTurnHandle', 'clearActiveTurn', 'afterTurnReleased'],
          },
          { actions: 'markStaleTurnReleased' },
        ],
      },
    },
    settling: {
      on: {
        'loop.enqueue': { actions: 'handleEnqueue' },
        'loop.admit': { actions: 'handleAdmit' },
        'loop.acquire': {
          guard: 'canAcquire',
          target: 'quiescent',
          actions: 'replyAcquired',
        },
        'loop.pump': [
          {
            guard: 'hasQueuedTurn',
            target: 'running',
            actions: ['popNextTurn', 'startTurnEffects'],
          },
          { target: 'idle', actions: 'settleIfIdle' },
        ],
      },
    },
  },
  on: {
    'loop.commit': { actions: 'commitState' },
    'loop.cancel': { actions: 'handleCancel' },
    'loop.abortRequest': { actions: 'handleAbortRequest' },
    'runtime.restore': {},
  },
});

export class MachineLoopControl implements LoopControl {
  constructor(private readonly runtime: AgentRuntimeContext<LoopDurableState>) {}

  private get machine(): LoopMachineContext {
    return machineOf(this.runtime);
  }

  private get disposing(): boolean {
    return this.machine.host.state.get(loopDisposingKey);
  }

  get hooks(): LoopControl['hooks'] {
    return this.machine.hooks;
  }

  get onDidChangePhase(): Event<LoopPhaseState> {
    return this.machine.phaseEmitter.event;
  }

  phase(): LoopPhaseState {
    return this.machine.phase;
  }

  onDidStartTurn(listener: (turnId: number) => void): IDisposable {
    return this.machine.startEmitter.event(listener);
  }

  onDidEndTurn(
    listener: (ended: { readonly turnId: number; readonly result: TurnResult }) => void,
  ): IDisposable {
    return this.machine.endEmitter.event(listener);
  }

  enqueue(request: StepRequest, options?: StepEnqueueOptions): EnqueueReceipt {
    if (this.disposing) throw abortError('Agent loop disposed');
    const assignment = createControlledPromise<StepAssignment>();
    void assignment.catch(() => undefined);
    const reply: { error?: unknown } = {};
    this.runtime.send({ type: 'loop.enqueue', request, options, assignment, reply });
    if (reply.error !== undefined) throw reply.error;
    return {
      assigned: assignment,
      abort: (reason) => this.abortRequest(request, reason),
    };
  }

  private abortRequest(request: StepRequest, reason?: unknown): boolean {
    const reply = { value: false };
    this.runtime.send({ type: 'loop.abortRequest', request, reason, reply });
    return reply.value;
  }

  run(options: LoopRunOptions): Promise<LoopRunResult> {
    return runLoop(this.machine.deps, options);
  }

  activeTurn(): Turn | undefined {
    return this.machine.activeTurn?.turn;
  }

  dispose(): void {
    if (this.disposing) return;
    this.machine.host.state.set(loopDisposingKey, true);
    const reason = abortError('Agent loop disposed');
    const context = this.machine;
    for (const job of context.pendingTurns.slice()) {
      this.cancel(job.turn.id, reason);
    }
    if (context.activeTurn !== undefined) {
      this.cancel(context.activeTurn.turn.id, reason);
    }
    for (const request of context.standaloneQueue.drain()) {
      this.abortRequest(request, reason);
    }
    for (const { request } of context.heldAdmissions.slice()) {
      this.abortRequest(request, reason);
    }
    maybeSettleWith(this.machine);
  }

  status(): AgentLoopStatus {
    const context = this.machine;
    return {
      state: context.activeTurn === undefined ? 'idle' : 'running',
      activeTurnId: context.activeTurn?.turn.id,
      pendingTurnIds: context.pendingTurns.map((job) => job.turn.id),
      hasPendingRequests: this.hasPendingRequests(),
      activeTraceId: context.traceSlot.current?.traceId,
    };
  }

  cancel(turnId?: number, reason?: unknown): boolean {
    const reply = { value: false };
    this.runtime.send({ type: 'loop.cancel', turnId, cancellation: reason, reply });
    return reply.value;
  }

  cancelFromUser(turnId?: number): void {
    const status = this.status();
    if (status.state === 'running') {
      this.machine.host.telemetry.track2('cancel', {
        from: 'streaming',
        trace_id: status.activeTraceId,
      });
    }
    this.cancel(turnId);
  }

  tryAcquireQuiescence(): IDisposable | undefined {
    if (this.disposing) throw abortError('Agent loop disposed');
    const reply: { value?: IDisposable } = {};
    this.runtime.send({ type: 'loop.acquire', reply });
    return reply.value;
  }

  settled(): Promise<void> {
    if (this.disposing) return Promise.resolve();
    const context = this.machine;
    if (
      context.activeTurn === undefined &&
      context.pendingTurns.length === 0 &&
      context.heldAdmissions.length === 0
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      context.settleWaiters.push(resolve);
    });
  }

  hasPendingRequests(): boolean {
    const context = this.machine;
    return (
      context.activeTurn?.queue.hasPendingRequests() === true ||
      context.standaloneQueue.hasPendingRequests() ||
      context.pendingTurns.length > 0 ||
      context.heldAdmissions.some(({ request }) => !request.aborted)
    );
  }

  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ): IDisposable {
    return registerErrorHandlerIn(this.machine.errorHandlers, handler, options);
  }
}
