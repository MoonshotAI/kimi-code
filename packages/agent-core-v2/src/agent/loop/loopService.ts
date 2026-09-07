import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

import { createControlledPromise } from '@antfu/utils';

import { Disposable, toDisposable, type IDisposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import { abortError, isAbortError, isUserCancellation, userCancellationReason } from '#/_base/utils/abort';
import { toErrorMessage } from '#/_base/errors/errorMessage';
import { retryErrorFields } from '#/_base/utils/retry';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import type { LLMRequestTrace } from '#/llm-adapter/contract/request-trace';
import type { ModelRequestTiming } from '#/llm-adapter/model/model-requester';
import { IAgentToolExecutorService } from '#/agent/toolExecutor/toolExecutor';
import { abortedToolOutput } from '#/agent/toolExecutor/toolExecutorService';
import { IAgentToolRegistryService } from '#/agent/toolRegistry/toolRegistry';
import { IConfigService } from '#/app/config/config';
import { AgentErrorEvent } from '#/agent/mcp/mcpEvents';
import { type FinishReason } from '#human/llm/finish-reason';
import { UNKNOWN_CAPABILITY } from '#human/llm/capability';
import { mergeInPlace } from '#/llm-adapter/contract/message';
import type { ContentPart, UserMessage } from '#human/llm/message';
import { emptyUsage, type TokenUsage } from '#human/llm/usage';
import { BugIndicatingError, ErrorCodes, Error2, isError2, toKimiErrorPayload } from '#/errors';
import { OrderedHookSlot } from '#/hooks';

import { IAgentContextMemoryService } from '#/agent/contextMemory/contextMemory';
import { isVacuousContentPart } from '#/agent/contextMemory/vacuousContent';
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import type {
  TurnEndedEvent as TurnEndedTelemetryEvent,
  TurnInterruptedEvent,
  TurnStartedEvent as TurnStartedTelemetryEvent,
} from '#/app/telemetry/events';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IEventDispatcher } from '#/state/eventDispatcher';
import { IWireService } from '#/wire/wire';
import { LOOP_CONTROL_SECTION, type LoopControl } from './configSection';
import {
  createMaxStepsExceededError,
  IAgentLoopService,
  isMaxStepsExceededError,
  type AfterStepContext,
  type AgentLoopStatus,
  type LoopError,
  type LoopErrorContext,
  type LoopErrorHandler,
  type LoopErrorHandlerRegistrationOptions,
  type LoopNotify,
  type LoopNotifyHandle,
  type LoopPromptSubmit,
  type LoopRunResult,
  type Turn,
  type TurnResult,
} from './loop';
import {
  AssistantDelta,
  isDisplayablePromptOrigin,
  ThinkingDelta,
  ToolCallDelta,
  turnPromptAttachments,
  turnPromptText,
  TurnStarted,
  TurnStepCompleted,
  TurnStepInterrupted,
  TurnStepRetrying,
  TurnStepStarted,
  type TurnInterruptReason,
} from './turnEvents';
import { TurnCancel, TurnEnded, turnKey, TurnPrompt } from './turnOps';
import {
  createMachineEngine,
  EMPTY_MACHINE_PROMPT,
  historyFromContext,
  type MachineEngine,
  type MachineEngineEvent,
  type MachineTurnOutcome,
} from './machine';

export type LoopInterruptReason = 'aborted' | 'max_steps' | 'error';

export const loopNextReservedTurnIdKey = defineState<number | undefined>(
  'loop.nextReservedTurnId',
  () => undefined as number | undefined,
);
export const loopLastRequestTraceIdKey = defineState<string | undefined>(
  'loop.lastRequestTraceId',
  () => undefined as string | undefined,
);
export const loopDisposingKey = defineState<boolean>('loop.disposing', () => false);

const MAX_STEP_SIGNAL_LISTENERS = 64;

const MACHINE_LOOP_MODEL = {
  provider: 'agent-loop',
  model: 'agent-loop',
  capability: UNKNOWN_CAPABILITY,
};

export class AgentLoopService extends Disposable implements IAgentLoopService {
  declare readonly _serviceBrand: undefined;

  readonly hooks: IAgentLoopService['hooks'] = {
    onWillBeginStep: new OrderedHookSlot(),
    onDidFinishStep: new OrderedHookSlot(),
  };

  private readonly errorHandlers: LoopErrorHandler[] = [];
  private readonly reservations: TurnReservation[] = [];
  private readonly nudges: Nudge[] = [];
  private nudgeCursor = 0;
  private active: ActiveTurn | undefined;
  private machineTurnUnbound = false;
  private machineTurnSuppressed = false;
  private unboundDrained: TurnReservation | undefined;
  private readonly pendingMachineQueueIds = new Set<string>();
  private readonly settleWaiters: Array<() => void> = [];
  private quiescenceDepth = 0;
  private activeRequestTrace: LLMRequestTrace | undefined;
  private engine: MachineEngine | undefined;

  constructor(
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentToolExecutorService private readonly toolExecutor: IAgentToolExecutorService,
    @IAgentToolRegistryService private readonly toolRegistry: IAgentToolRegistryService,
    @IConfigService private readonly config: IConfigService,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentStateService private readonly states: IAgentStateService,
    @IWireService private readonly wire: IWireService,
  ) {
    super();
    this.states.contributeState(turnKey);
    this.states.contributeState(loopNextReservedTurnIdKey);
    this.states.contributeState(loopLastRequestTraceIdKey);
    this.states.contributeState(loopDisposingKey);
  }

  private get nextReservedTurnId(): number | undefined {
    return this.states.get(loopNextReservedTurnIdKey);
  }

  private set nextReservedTurnId(value: number | undefined) {
    this.states.set(loopNextReservedTurnIdKey, value);
  }

  private get lastRequestTraceId(): string | undefined {
    return this.states.get(loopLastRequestTraceIdKey);
  }

  private set lastRequestTraceId(value: string | undefined) {
    this.states.set(loopLastRequestTraceIdKey, value);
  }

  private get disposing(): boolean {
    return this.states.get(loopDisposingKey);
  }

  private set disposing(value: boolean) {
    this.states.set(loopDisposingKey, value);
  }

  private machineEngine(): MachineEngine {
    if (this.engine === undefined) {
      this.engine = createMachineEngine({
        model: MACHINE_LOOP_MODEL,
        llmRequester: this.llmRequester,
        toolExecutor: this.toolExecutor,
        toolInfos: this.toolRegistry.list(),
        maxAttemptsPerStep: this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep,
        trace: () => this.activeRequestTrace,
        toolTurnId: () => this.active?.id,
        source: () =>
          this.active === undefined
            ? undefined
            : {
                type: 'turn',
                turnId: this.active.id,
                step: this.active.gatedSteps,
              },
        gate: (signal) => this.gate(signal),
        onTrace: (trace) => {
          this.activeRequestTrace = trace;
        },
        onEvent: (event) => this.projectMachineEvent(event),
        onToolResult: (toolCallId, result) => this.appendMachineToolResult(toolCallId, result),
      });
    }
    return this.engine;
  }

  override dispose(): void {
    if (this.disposing) return;
    this.disposing = true;
    const reason = abortError('Agent loop disposed');
    for (const reservation of this.reservations.splice(0)) {
      this.settleReservationCancelled(reservation, reason);
    }
    this.pendingMachineQueueIds.clear();
    this.active?.turn.cancel(reason);
    this.engine?.stop();
    this.maybeSettle();
    super.dispose();
  }

  submit(prompt: LoopPromptSubmit): { readonly turn: Turn } {
    if (this.disposing) throw abortError('Agent loop disposed');
    const reservation = this.createReservation(prompt);
    this.reservations.push(reservation);
    if (this.quiescenceDepth === 0) {
      this.launchReservation(reservation);
    }
    return { turn: reservation.turn };
  }

  steer(prompt: LoopPromptSubmit): Turn | undefined {
    if (this.disposing) throw abortError('Agent loop disposed');
    const active = this.active;
    if (active === undefined) return undefined;
    const message = normalizePromptMessage(prompt);
    const id = prompt.promptId ?? randomUUID();
    this.nudges.push({
      contextMessage: message,
      bypassMaxSteps: false,
      turnScoped: false,
      onConsume: prompt.onMaterialize,
      onDrop: undefined,
    });
    this.machineEngine().submit({ id, message: machineUserMessage(message) });
    this.machineEngine().steer(id);
    return active.turn;
  }

  notify(note: LoopNotify = {}): LoopNotifyHandle {
    if (this.disposing) throw abortError('Agent loop disposed');
    const nudge: Nudge = {
      contextMessage: note.message,
      bypassMaxSteps: note.bypassMaxSteps ?? false,
      turnScoped: note.turnScoped ?? true,
      onConsume: note.onConsume,
      onDrop: note.onDrop,
    };
    this.nudges.push(nudge);
    if (this.quiescenceDepth === 0) {
      nudge.sentToMachine = true;
      this.machineEngine().notify(machineUserMessage(note.message));
    }
    return {
      get dropped() {
        return nudge.dropped === true;
      },
      drop: () => {
        if (nudge.dropped === true || nudge.consumed === true) return;
        nudge.dropped = true;
        nudge.onDrop?.();
        this.maybeSettle();
      },
    };
  }

  private createReservation(prompt: LoopPromptSubmit): TurnReservation {
    const id = this.reserveTurnId();
    const controller = new AbortController();
    const ready = createControlledPromise<void>();
    const result = createControlledPromise<TurnResult>();
    void ready.catch(() => undefined);
    const message = normalizePromptMessage(prompt);
    const turn: MutableTurn = {
      id,
      state: 'queued',
      signal: controller.signal,
      ready,
      result,
      cancel: (reason) => this.cancel(id, reason),
    };
    return {
      id,
      machineQueueId: prompt.promptId ?? `turn-${String(id)}`,
      message,
      origin: message.origin ?? { kind: 'user' },
      promptId: prompt.promptId,
      onMaterialize: prompt.onMaterialize,
      cancelled: false,
      controller,
      ready,
      result,
      turn,
    };
  }

  private launchReservation(reservation: TurnReservation): void {
    if (reservation.cancelled || reservation.launched) return;
    reservation.launched = true;
    this.pendingMachineQueueIds.add(reservation.machineQueueId);
    this.machineEngine().submit({
      id: reservation.machineQueueId,
      message: machineUserMessage(reservation.message),
    });
  }

  private reserveTurnId(): number {
    const modelNextId = this.states.get(turnKey).nextTurnId;
    const id = Math.max(modelNextId, this.nextReservedTurnId ?? modelNextId);
    this.nextReservedTurnId = id + 1;
    return id;
  }

  status(): AgentLoopStatus {
    return {
      state: this.active === undefined ? 'idle' : 'running',
      activeTurnId: this.active?.id,
      pendingTurnIds: this.reservations
        .filter((reservation) => !reservation.cancelled)
        .map((reservation) => reservation.id),
      hasPendingRequests: this.hasPendingRequests(),
      activeTraceId: this.activeRequestTrace?.traceId,
    };
  }

  cancel(turnId?: number, reason?: unknown): boolean {
    const cancellation = reason ?? userCancellationReason();
    return (
      this.cancelActiveTurn(turnId, cancellation) ||
      (turnId !== undefined && this.cancelQueuedTurn(turnId, cancellation))
    );
  }

  cancelFromUser(turnId?: number): void {
    const status = this.status();
    if (status.state === 'running') {
      this.telemetry.track2('cancel', {
        from: 'streaming',
        trace_id: status.activeTraceId,
      });
    }
    this.cancel(turnId);
  }

  tryAcquireQuiescence(): IDisposable | undefined {
    if (this.disposing) throw abortError('Agent loop disposed');
    if (
      this.quiescenceDepth > 0 ||
      this.active !== undefined ||
      this.hasPendingRequests() ||
      this.machineTurnUnbound
    ) {
      return undefined;
    }
    this.quiescenceDepth += 1;
    return toDisposable(() => this.releaseQuiescence());
  }

  private releaseQuiescence(): void {
    if (this.quiescenceDepth === 0) return;
    this.quiescenceDepth -= 1;
    if (this.quiescenceDepth > 0 || this.disposing) return;
    for (const reservation of this.reservations) {
      if (!reservation.cancelled) this.launchReservation(reservation);
    }
    for (const nudge of this.nudges.slice(this.nudgeCursor)) {
      if (!nudge.dropped && !nudge.sentToMachine) {
        nudge.sentToMachine = true;
        this.machineEngine().notify(machineUserMessage(nudge.contextMessage));
      }
    }
    this.maybeSettle();
  }

  private cancelActiveTurn(turnId: number | undefined, cancellation: unknown): boolean {
    const active = this.active;
    if (active === undefined || (turnId !== undefined && active.id !== turnId)) return false;
    if (active.controller.signal.aborted) {
      this.machineEngine().abort();
      return true;
    }
    void this.dispatcher.dispatch(
      new TurnCancel({
        agentId: this.scopeContext.agentId,
        turnId: active.id,
        target: 'active',
        reason: cancelReasonFor(cancellation),
      }),
    );
    active.controller.abort(cancellation);
    this.machineEngine().abort();
    return true;
  }

  private cancelQueuedTurn(turnId: number, cancellation: unknown): boolean {
    const index = this.reservations.findIndex((entry) => entry.id === turnId);
    if (index < 0) return false;
    const reservation = this.reservations[index]!;
    if (reservation.cancelled) return false;
    reservation.cancelled = true;
    void this.dispatcher.dispatch(
      new TurnCancel({
        agentId: this.scopeContext.agentId,
        turnId,
        target: 'queued',
        reason: cancelReasonFor(cancellation),
      }),
    );
    if (!reservation.launched) {
      this.reservations.splice(index, 1);
    }
    this.settleReservationCancelled(reservation, cancellation);
    return true;
  }

  private settleReservationCancelled(reservation: TurnReservation, cancellation: unknown): void {
    reservation.cancelled = true;
    reservation.controller.abort(cancellation);
    reservation.turn.state = 'cancelled';
    reservation.ready.reject(
      cancellation instanceof Error ? cancellation : abortError('Turn cancelled'),
    );
    reservation.result.resolve({ type: 'cancelled', steps: 0, reason: cancellation });
    this.maybeSettle();
  }

  hasPendingRequests(): boolean {
    return (
      this.reservations.some((reservation) => !reservation.cancelled) ||
      this.nudges.slice(this.nudgeCursor).some((nudge) => !nudge.dropped)
    );
  }

  settled(): Promise<void> {
    if (
      this.active === undefined &&
      !this.hasPendingRequests() &&
      !this.machineTurnUnbound
    ) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.settleWaiters.push(resolve);
    });
  }

  private maybeSettle(): void {
    if (
      this.active !== undefined ||
      this.machineTurnUnbound ||
      this.hasPendingRequests()
    ) return;
    if (this.settleWaiters.length === 0) return;
    const waiters = this.settleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  registerLoopErrorHandler(
    handler: LoopErrorHandler,
    options: LoopErrorHandlerRegistrationOptions = {},
  ): IDisposable {
    if (options.before !== undefined && options.after !== undefined) {
      throw new BugIndicatingError('Loop error handler registration cannot specify both before and after');
    }
    this.deleteErrorHandler(handler.id);
    const target = options.before ?? options.after;
    if (target === undefined) {
      this.errorHandlers.push(handler);
    } else {
      const targetIndex = this.errorHandlers.findIndex((entry) => entry.id === target);
      if (targetIndex < 0) {
        throw new BugIndicatingError(`Loop error handler target "${target}" is not registered`);
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

  private async gate(machineSignal: AbortSignal): Promise<MachineGateDecision> {


    const active = this.active;
    if (active !== undefined) await active.afterChain;
    if (this.machineTurnUnbound && !this.bindMachineTurn()) {
      return { type: 'fail' };
    }
    const turn = this.active;
    if (turn === undefined) return { type: 'fail' };
    if (turn.controller.signal.aborted || machineSignal.aborted) return { type: 'fail' };
    if (turn.stopRequested) return { type: 'fail' };
    if (turn.failedStep !== undefined) return { type: 'fail' };
    const consumed = this.mirrorConsumedNudges(turn);
    if (turn.toolStopRequested && consumed.live === 0) return { type: 'fail' };
    const maxSteps = this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxStepsPerTurn;
    if (
      maxSteps !== undefined &&
      maxSteps > 0 &&
      turn.steps >= maxSteps &&
      !consumed.bypass
    ) {
      turn.maxStepsError = createMaxStepsExceededError(maxSteps);
      return { type: 'fail' };
    }
    turn.steps += 1;
    turn.gatedSteps = turn.steps;
    const step: MachineStepState = {
      number: turn.steps,
      uuid: randomUUID(),
      signal: turn.controller.signal,
      contentAppended: false,
      entry: undefined,
      usage: undefined,
      timing: undefined,
      providerFinishReason: undefined,
      rawFinishReason: undefined,
      messageId: undefined,
      pendingToolIds: new Set(),
      toolCallUuids: new Map(),
      resolvedToolIds: new Set(),
      toolStopTurn: false,
    };
    turn.current = step;
    turn.interruptStep = step.number;
    this.activeRequestTrace = undefined;
    this.telemetry.setContext({ trace_id: undefined });
    EventEmitter.setMaxListeners(MAX_STEP_SIGNAL_LISTENERS, turn.controller.signal);
    try {

      await this.hooks.onWillBeginStep.run({
        turnId: turn.id,
        step: step.number,
        firstStepOfTurn: step.number === 1,
        signal: step.signal,
      });

    } catch (error) {

      return this.failMachineGate(turn, step, error);
    }
    if (step.signal.aborted) {
      return this.failMachineGate(turn, step, step.signal.reason ?? abortError('Step aborted'));
    }
    return { type: 'proceed', signal: step.signal, step: step.number };
  }

  private failMachineGate(
    turn: ActiveTurn,
    step: MachineStepState,
    error: unknown,
  ): MachineGateDecision {
    if (turn.controller.signal.aborted || isAbortError(error) || step.signal.aborted) {
      turn.abortReason = turn.controller.signal.aborted ? turn.controller.signal.reason : error;
      return { type: 'fail' };
    }
    turn.failedStep = {
      number: step.number,
      uuid: step.uuid,
      error,
    };
    return { type: 'fail' };
  }

  private bindMachineTurn(): boolean {
    this.machineTurnUnbound = false;
    if (this.active !== undefined) return true;
    const drained = this.unboundDrained;
    this.unboundDrained = undefined;
    if (drained !== undefined) {
      const index = this.reservations.indexOf(drained);
      if (index >= 0) this.reservations.splice(index, 1);
      if (drained.cancelled) {
        this.machineTurnSuppressed = true;
        return false;
      }
      this.beginActiveTurn(drained.turn, drained.controller, drained);
      drained.onMaterialize?.();
      this.materializeMessage(drained.message);
      return true;
    }
    const seeded = this.nudges.slice(this.nudgeCursor).find(
      (nudge) => !nudge.dropped && nudge.contextMessage !== undefined && nudge.contextMessage.content.length > 0,
    );
    if (seeded === undefined) {
      this.machineTurnSuppressed = true;
      return false;
    }
    const message = seeded.contextMessage as ContextMessage;
    const id = this.reserveTurnId();
    const controller = new AbortController();
    const ready = createControlledPromise<void>();
    const result = createControlledPromise<TurnResult>();
    void ready.catch(() => undefined);
    const turn: MutableTurn = {
      id,
      state: 'queued',
      signal: controller.signal,
      ready,
      result,
      cancel: (reason) => this.cancel(id, reason),
    };
    const origin = message.origin ?? { kind: 'user' };
    this.beginActiveTurn(turn, controller, {
      id,
      machineQueueId: `turn-${String(id)}`,
      message,
      origin,
      promptId: message.id,
      onMaterialize: undefined,
      cancelled: false,
      controller,
      ready,
      result,
      turn,
    });
    return true;
  }

  private beginActiveTurn(
    turn: MutableTurn,
    controller: AbortController,
    reservation: TurnReservation,
  ): void {

    const id = reservation.id;
    const active: ActiveTurn = {
      id,
      reservation,
      controller,
      turn,
      startedAt: Date.now(),
      steps: 0,
      gatedSteps: 0,
      nudgeCursor: this.nudgeCursor,
      current: undefined,
      interruptStep: undefined,
      failedStep: undefined,
      stopRequested: false,
      toolStopRequested: false,
      forcedStopReason: undefined,
      lastStopReason: undefined,
      filtered: false,
      maxStepsError: undefined,
      abortReason: undefined,
      retryRequested: false,
      afterChain: Promise.resolve(),
      partials: [],
      forceContentPartBoundary: false,
      readyResolved: false,
      mode: undefined,
      providerType: undefined,
      protocol: undefined,
    };
    this.active = active;
    active.mode = this.telemetry.getContext().mode;
    const { provider_type, protocol } = this.telemetry.getContext();
    active.providerType = provider_type;
    active.protocol = protocol;
    this.telemetry.setContext({ turn_id: id });
    const thinkingEffort = this.llmRequester.prepareTurnConfig(id)?.thinkingEffort;
    this.telemetry.setContext({ thinking_effort: thinkingEffort });
    void this.dispatcher.dispatch(
      new TurnPrompt({
        agentId: this.scopeContext.agentId,
        input: reservation.message.content,
        origin: reservation.origin,
        promptId: reservation.promptId,
      }),
    );
    turn.state = 'running';
    void this.dispatcher.dispatch(
      new TurnStarted({
        agentId: this.scopeContext.agentId,
        turnId: id,
        promptId: reservation.promptId,
        origin: reservation.origin,
        prompt: isDisplayablePromptOrigin(reservation.origin)
          ? turnPromptText(reservation.message.content, reservation.origin)
          : undefined,
        promptAttachments: turnPromptAttachments(reservation.message.content, reservation.origin),
      }),
    );
    const started: TurnStartedTelemetryEvent = {
      turn_id: id,
      mode: active.mode ?? 'agent',
      provider_type,
      protocol,
    };
    this.telemetry.track2('turn_started', started);
  }

  private materializeMessage(message: ContextMessage): void {
    if (message.content.length === 0) return;
    this.context.append(message);
  }

  private mirrorConsumedNudges(turn: ActiveTurn): { readonly live: number; readonly bypass: boolean } {
    const engine = this.engine;
    if (engine === undefined) return { live: 0, bypass: false };
    const notificationCount = engine.snapshot().notificationCount;
    let consumed = this.nudges.length - this.nudgeCursor - notificationCount;
    let live = 0;
    let bypass = false;
    while (consumed > 0 && this.nudgeCursor < this.nudges.length) {
      const nudge = this.nudges[this.nudgeCursor]!;
      this.nudgeCursor += 1;
      consumed -= 1;
      if (nudge.dropped) continue;
      live += 1;
      bypass = bypass || nudge.bypassMaxSteps;
      nudge.consumed = true;
      if (nudge.contextMessage !== undefined && nudge.contextMessage.content.length > 0) {
        this.materializeMessage(nudge.contextMessage);
      }
      nudge.onConsume?.();
    }
    turn.nudgeCursor = this.nudgeCursor;
    return { live, bypass };
  }

  private reconcileDrainedQueueEntry(): void {
    const engine = this.engine;
    if (engine === undefined) return;
    const queueIds = engine.snapshot().queueIds;
    const drainedIds: string[] = [];
    for (const id of this.pendingMachineQueueIds) {
      if (!queueIds.includes(id)) drainedIds.push(id);
    }
    for (const id of drainedIds) {
      this.pendingMachineQueueIds.delete(id);
      const reservation = this.reservations.find((entry) => entry.machineQueueId === id);
      if (reservation === undefined) continue;
      if (this.active === undefined) {
        this.unboundDrained = reservation;
      } else {
        this.pendingMachineQueueIds.add(reservation.machineQueueId);
        this.machineEngine().submit({
          id: reservation.machineQueueId,
          message: machineUserMessage(reservation.message),
        });
      }
    }
  }

  private projectMachineEvent(event: MachineEngineEvent): void {
    switch (event.type) {
      case 'turnStarted': {
        this.reconcileDrainedQueueEntry();
        this.machineTurnUnbound = true;
        this.machineTurnSuppressed = false;
        return;
      }
      case 'turnSettled': {
        const outcome = event;
        const active = this.active;
        if (this.machineTurnSuppressed) {
          this.machineTurnSuppressed = false;
          this.maybeSettle();
          return;
        }
        if (active === undefined) return;
        active.afterChain = active.afterChain.then(() => this.evaluateSettle(active, outcome));
        return;
      }
      case 'stepStarted': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        if (!turn.readyResolved) {
          turn.readyResolved = true;
          turn.reservation.ready.resolve();
        }
        void this.dispatcher.dispatch(
          new TurnStepStarted({
            agentId: this.scopeContext.agentId,
            turnId: turn.id,
            step: step.number,
            stepId: step.uuid,
          }),
        );
        this.context.appendLoopEvent({
          type: 'step.begin',
          uuid: step.uuid,
          turnId: String(turn.id),
          step: step.number,
        });
        turn.partials = [];
        turn.forceContentPartBoundary = false;
        return;
      }
      case 'delta': {
        const turn = this.active;
        if (turn === undefined) return;
        const delta = event.delta;
        switch (delta.kind) {
          case 'assistant':
            this.accumulateMachinePart(turn, { type: 'text', text: delta.delta });
            void this.dispatcher.dispatch(
              new AssistantDelta({ agentId: this.scopeContext.agentId, turnId: turn.id, delta: delta.delta }),
            );
            return;
          case 'thinking':
            this.accumulateMachinePart(turn, { type: 'think', think: delta.delta });
            void this.dispatcher.dispatch(
              new ThinkingDelta({ agentId: this.scopeContext.agentId, turnId: turn.id, delta: delta.delta }),
            );
            return;
          case 'toolCall':
            if (delta.started === true) turn.forceContentPartBoundary = true;
            void this.dispatcher.dispatch(
              new ToolCallDelta({
                agentId: this.scopeContext.agentId,
                turnId: turn.id,
                toolCallId: delta.toolCallId,
                name: delta.name,
                argumentsPart: delta.argumentsPart,
              }),
            );
            return;
        }
        return;
      }
      case 'stepCompleted': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        step.entry = event.entry;
        step.usage = event.usage;
        step.timing = event.timing;
        step.providerFinishReason = event.finish?.finishReason ?? undefined;
        step.rawFinishReason = event.finish?.rawFinishReason ?? undefined;
        step.messageId = event.messageId;
        for (const part of event.entry.message.content) {
          this.context.appendLoopEvent({
            type: 'content.part',
            uuid: randomUUID(),
            turnId: String(turn.id),
            step: step.number,
            stepUuid: step.uuid,
            part,
          });
        }
        step.contentAppended = true;
        this.lastRequestTraceId = this.activeRequestTrace?.traceId;
        const toolCalls = event.entry.message.toolCalls;
        if (toolCalls.length === 0) {
          const finishReason = step.providerFinishReason ?? 'completed';
          this.endOrInterruptMachineStep(turn, step, finishReason === 'tool_calls' ? 'other' : finishReason);
        } else {
          step.pendingToolIds = new Set(toolCalls.map((call) => call.id));
        }
        return;
      }
      case 'toolStarted': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        const callUuid = randomUUID();
        step.toolCallUuids.set(event.toolCallId, callUuid);
        const extras = step.entry?.message.toolCalls.find((call) => call.id === event.toolCallId)?.extras;
        this.context.appendLoopEvent({
          type: 'tool.call',
          uuid: callUuid,
          turnId: String(turn.id),
          step: step.number,
          stepUuid: step.uuid,
          toolCallId: event.toolCallId,
          name: event.name,
          args: event.args,
          extras,
        });
        return;
      }
      case 'toolDone': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        step.pendingToolIds.delete(event.toolCallId);
        if (this.isCannedUnknownToolResult(step, event.toolCallId, event.result)) {
          turn.afterChain = turn.afterChain.then(async () => {
            await this.executeUnknownToolCall(turn, step, event.toolCallId);
            if (turn.current === step && step.pendingToolIds.size === 0) {
              this.endOrInterruptMachineStep(turn, step, step.toolStopTurn ? 'completed' : 'tool_calls');
            }
          });
          return;
        }
        if (step.pendingToolIds.size === 0) {
          this.endOrInterruptMachineStep(turn, step, step.toolStopTurn ? 'completed' : 'tool_calls');
        }
        return;
      }
      case 'toolFailed': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        const message = event.error instanceof Error ? event.error.message : String(event.error);
        this.context.appendLoopEvent({
          type: 'tool.result',
          parentUuid: step.toolCallUuids.get(event.toolCallId) ?? randomUUID(),
          toolCallId: event.toolCallId,
          result: { output: message, isError: true },
        });
        step.resolvedToolIds.add(event.toolCallId);
        step.pendingToolIds.delete(event.toolCallId);
        if (step.pendingToolIds.size === 0) {
          this.endOrInterruptMachineStep(turn, step, step.toolStopTurn ? 'completed' : 'tool_calls');
        }
        return;
      }
      case 'toolBatchFailed': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        if (step.signal.aborted) return;
        this.closeFailedMachineStep(turn, step, 'error');
        turn.failedStep ??= {
          number: step.number,
          uuid: step.uuid,
          error: event.error,
        };
        turn.current = undefined;
        this.machineEngine().abort();
        return;
      }
      case 'retrying': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined) return;
        if (step !== undefined) {
          this.closeFailedMachineStep(turn, step, 'error');
        }
        const fields =
          event.rawError !== undefined
            ? retryErrorFields(event.rawError)
            : {
                errorName: event.errorName,
                errorMessage: event.errorMessage,
                statusCode: event.statusCode,
              };
        void this.dispatcher.dispatch(
          new TurnStepRetrying({
            agentId: this.scopeContext.agentId,
            turnId: turn.id,
            step: step?.number ?? turn.gatedSteps,
            stepId: step?.uuid,
            failedAttempt: event.failedAttempt,
            nextAttempt: event.nextAttempt,
            maxAttempts: event.maxAttempts,
            delayMs: event.delayMs,
            errorName: fields.errorName,
            errorMessage: fields.errorMessage,
            statusCode: fields.statusCode,
          }),
        );
        turn.current = undefined;
        return;
      }
      case 'stepFailed': {
        const turn = this.active;
        const step = turn?.current;
        if (turn === undefined || step === undefined) return;
        this.closeFailedMachineStep(turn, step, step.signal.aborted ? 'interrupted' : 'error');
        turn.failedStep ??= {
          number: step.number,
          uuid: step.uuid,
          error: event.rawError ?? event.error,
        };
        turn.current = undefined;
        return;
      }
      default:
        return;
    }
  }

  private isCannedUnknownToolResult(
    step: MachineStepState,
    toolCallId: string,
    result: { readonly content: readonly ContentPart[]; readonly isError?: boolean },
  ): boolean {
    if (step.toolCallUuids.has(toolCallId)) return false;
    if (result.isError !== true || result.content.length !== 1) return false;
    const part = result.content[0];
    const call = step.entry?.message.toolCalls.find((entry) => entry.id === toolCallId);
    return (
      part !== undefined &&
      part.type === 'text' &&
      call !== undefined &&
      part.text === `unknown tool: ${call.name}`
    );
  }

  private async executeUnknownToolCall(
    turn: ActiveTurn,
    step: MachineStepState,
    toolCallId: string,
  ): Promise<void> {
    const call = step.entry?.message.toolCalls.find((entry) => entry.id === toolCallId);
    if (call === undefined) return;
    try {
      for await (const result of this.toolExecutor.execute([call], {
        signal: turn.controller.signal,
        turnId: turn.id,
        trace: this.activeRequestTrace,
        onToolCall: (payload) => {
          const callUuid = randomUUID();
          step.toolCallUuids.set(payload.toolCallId, callUuid);
          const extras = step.entry?.message.toolCalls.find(
            (entry) => entry.id === payload.toolCallId,
          )?.extras;
          this.context.appendLoopEvent({
            type: 'tool.call',
            uuid: callUuid,
            turnId: String(turn.id),
            step: step.number,
            stepUuid: step.uuid,
            toolCallId: payload.toolCallId,
            name: payload.name,
            args: payload.args,
            extras,
          });
        },
      })) {
        if (result.toolCallId === toolCallId) {
          this.appendMachineToolResult(toolCallId, result.result);
        }
      }
    } catch (error) {
      if (this.active !== turn || turn.current !== step || step.signal.aborted) return;
      this.closeFailedMachineStep(turn, step, 'error');
      turn.failedStep ??= {
        number: step.number,
        uuid: step.uuid,
        error,
      };
      turn.current = undefined;
      this.machineEngine().abort();
    }
  }

  private accumulateMachinePart(turn: ActiveTurn, part: ContentPart): void {
    const last = turn.partials.at(-1);
    if (!turn.forceContentPartBoundary && last !== undefined && mergeInPlace(last, part)) return;
    turn.forceContentPartBoundary = false;
    turn.partials.push({ ...part });
  }

  private appendMachineToolResult(
    toolCallId: string,
    result: {
      readonly output: string | ContentPart[];
      readonly isError?: boolean;
      readonly note?: string;
      readonly stopTurn?: boolean;
      readonly stopTurnReason?: string;
    },
  ): void {
    const turn = this.active;
    const step = turn?.current;
    if (turn === undefined || step === undefined) return;
    this.context.appendLoopEvent({
      type: 'tool.result',
      parentUuid: step.toolCallUuids.get(toolCallId) ?? randomUUID(),
      toolCallId,
      result: { output: result.output, isError: result.isError, note: result.note },
    });
    step.resolvedToolIds.add(toolCallId);
    if (result.stopTurn === true) {
      step.toolStopTurn = true;
      turn.toolStopRequested = true;
      turn.forcedStopReason ??= result.stopTurnReason;
    }
  }

  private drainMachinePartials(turn: ActiveTurn, step: MachineStepState): void {
    for (const part of turn.partials.splice(0).filter((entry) => !isVacuousContentPart(entry))) {
      this.context.appendLoopEvent({
        type: 'content.part',
        uuid: randomUUID(),
        turnId: String(turn.id),
        step: step.number,
        stepUuid: step.uuid,
        part,
      });
    }
  }

  private closeFailedMachineStep(
    turn: ActiveTurn,
    step: MachineStepState,
    finishReason: 'error' | 'interrupted',
  ): void {
    if (!step.contentAppended) this.drainMachinePartials(turn, step);
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: step.uuid,
      turnId: String(turn.id),
      step: step.number,
      finishReason,
    });
  }

  private endOrInterruptMachineStep(
    turn: ActiveTurn,
    step: MachineStepState,
    finishReason: FinishReason,
  ): void {
    if (turn.controller.signal.aborted) {
      this.context.appendLoopEvent({
        type: 'step.end',
        uuid: step.uuid,
        turnId: String(turn.id),
        step: step.number,
        finishReason: 'interrupted',
      });
      turn.current = undefined;
      return;
    }
    this.endMachineStep(turn, step, finishReason);
  }

  private endMachineStep(turn: ActiveTurn, step: MachineStepState, finishReason: FinishReason): void {
    const normalized = normalizeFinishReason(finishReason);
    const usage = step.usage ?? emptyUsage();
    turn.lastStopReason = finishReason;
    turn.current = undefined;
    const firstStepOfTurn = step.number === 1;
    turn.afterChain = turn.afterChain.then(async () => {
      this.finishMachineStepProjection(turn, step, normalized, usage);
      await this.runMachineAfterStep(turn, step, firstStepOfTurn, usage, finishReason);
    });
  }

  private finishMachineStepProjection(
    turn: ActiveTurn,
    step: MachineStepState,
    normalized: string,
    usage: TokenUsage,
  ): void {
    this.context.appendLoopEvent({
      type: 'step.end',
      uuid: step.uuid,
      turnId: String(turn.id),
      step: step.number,
      finishReason: normalized,
      usage,
      llmFirstTokenLatencyMs: step.timing?.firstTokenLatencyMs,
      llmStreamDurationMs: step.timing?.streamDurationMs,
      llmRequestBuildMs: step.timing?.requestBuildMs,
      llmServerFirstTokenMs: step.timing?.serverFirstTokenMs,
      llmServerDecodeMs: step.timing?.serverDecodeMs,
      llmClientConsumeMs: step.timing?.clientConsumeMs,
      messageId: step.messageId,
      providerFinishReason: step.providerFinishReason,
      rawFinishReason: step.rawFinishReason,
    });
    void this.dispatcher.dispatch(
      new TurnStepCompleted({
        agentId: this.scopeContext.agentId,
        turnId: turn.id,
        step: step.number,
        stepId: step.uuid,
        usage,
        finishReason: normalized,
        llmFirstTokenLatencyMs: step.timing?.firstTokenLatencyMs,
        llmStreamDurationMs: step.timing?.streamDurationMs,
        llmRequestBuildMs: step.timing?.requestBuildMs,
        llmServerFirstTokenMs: step.timing?.serverFirstTokenMs,
        llmServerDecodeMs: step.timing?.serverDecodeMs,
        llmClientConsumeMs: step.timing?.clientConsumeMs,
        providerFinishReason: step.providerFinishReason,
        rawFinishReason: step.rawFinishReason,
      }),
    );
  }

  private async runMachineAfterStep(
    turn: ActiveTurn,
    step: MachineStepState,
    firstStepOfTurn: boolean,
    usage: TokenUsage,
    finishReason: FinishReason,
  ): Promise<void> {
    const context: AfterStepContext = {
      turnId: turn.id,
      step: step.number,
      firstStepOfTurn,
      signal: step.signal,
      usage,
      finishReason,
      stopTurn: false,
    };
    try {
      await this.hooks.onDidFinishStep.run(context);
    } catch (error) {
      if (isAbortError(error) || step.signal.aborted) {
        turn.abortReason = turn.controller.signal.aborted
          ? turn.controller.signal.reason
          : error;
        return;
      }
    }
    turn.interruptStep = undefined;
    if (context.stopTurn) turn.stopRequested = true;
    if (finishReason === 'filtered') turn.filtered = true;
  }

  private async evaluateSettle(
    turn: ActiveTurn,
    outcome: { readonly outcome: MachineTurnOutcome; readonly error?: unknown },
  ): Promise<void> {
    if (this.active !== turn) return;
    if (
      turn.failedStep !== undefined &&
      turn.abortReason === undefined &&
      !turn.controller.signal.aborted
    ) {
      await this.recoverOrFailMachineRun(turn);
      return;
    }
    if (turn.abortReason !== undefined || turn.controller.signal.aborted || outcome.outcome === 'aborted') {
      const reason =
        turn.abortReason ??
        (turn.controller.signal.aborted ? turn.controller.signal.reason : undefined) ??
        abortError('Turn aborted');
      this.interruptMachineRunForCancel(turn, reason);
      await this.endTurn(turn, { type: 'cancelled', steps: turn.steps, reason });
      return;
    }
    if (turn.filtered) {
      await this.endTurn(turn, {
        type: 'failed',
        steps: turn.steps,
        error: new Error2(ErrorCodes.PROVIDER_FILTERED, 'Provider safety policy blocked the response.', {
          name: 'ProviderFilteredError',
          details: { finishReason: 'filtered' },
        }),
      });
      return;
    }
    if (turn.maxStepsError !== undefined) {
      await this.endTurn(turn, { type: 'failed', steps: turn.steps, error: turn.maxStepsError });
      return;
    }
    if (turn.stopRequested) {
      await this.endTurn(turn, this.machineCompletedResult(turn));
      return;
    }
    if (this.hasLiveNudge()) {
      return;
    }
    if (turn.toolStopRequested) {
      await this.endTurn(turn, this.machineCompletedResult(turn));
      return;
    }
    if (outcome.outcome === 'failed') {
      const error = outcome.error ?? new Error('Turn failed');
      this.emitStepInterrupted(turn.id, turn.interruptStep, 'error', toErrorMessage(error));
      await this.endTurn(turn, { type: 'failed', steps: turn.steps, error });
      return;
    }
    await this.endTurn(turn, this.machineCompletedResult(turn));
  }

  private hasLiveNudge(): boolean {
    return this.nudges.slice(this.nudgeCursor).some((nudge) => !nudge.dropped);
  }

  private async recoverOrFailMachineRun(turn: ActiveTurn): Promise<void> {
    const failure = turn.failedStep!;
    turn.failedStep = undefined;
    const context: LoopErrorContext = {
      turnId: turn.id,
      step: failure.number,
      stepId: failure.uuid,
      signal: turn.controller.signal,
      error: failure.error,
      retry: () => {
        turn.retryRequested = true;
      },
    };
    const handler = this.errorHandlers.find((entry) => entry.match(context));
    if (handler !== undefined) {
      try {
        if (await handler.handle(context)) {
          turn.interruptStep = undefined;
          if (turn.retryRequested) {
            turn.retryRequested = false;
            this.machineEngine().resetHistory(historyFromContext(this.context.get()), turn.id - 1);
            this.machineEngine().notify(EMPTY_MACHINE_PROMPT);
          }
          return;
        }
      } catch (handlerError) {
        if (isAbortError(handlerError) || turn.controller.signal.aborted) {
          const reason = turn.controller.signal.aborted ? turn.controller.signal.reason : handlerError;
          this.interruptMachineRunForCancel(turn, reason);
          await this.endTurn(turn, { type: 'cancelled', steps: turn.steps, reason });
          return;
        }
        this.emitStepInterrupted(turn.id, failure.number, 'error', toErrorMessage(handlerError));
        await this.endTurn(turn, { type: 'failed', steps: turn.steps, error: handlerError });
        return;
      }
    }
    this.failMachineStep(turn, failure.number, failure.error);
    await this.endTurn(turn, { type: 'failed', steps: turn.steps, error: failure.error });
  }

  private failMachineStep(turn: ActiveTurn, step: number | undefined, error: unknown): void {
    const reason: LoopInterruptReason = isMaxStepsExceededError(error) ? 'max_steps' : 'error';
    const interruptedError =
      isError2(error) && error.code === ErrorCodes.INTERNAL && error.cause !== undefined ? error.cause : error;
    this.emitStepInterrupted(turn.id, step, reason, toErrorMessage(interruptedError));
  }

  private backfillAbortedToolResults(step: MachineStepState, reason: unknown): void {
    for (const toolCallId of step.pendingToolIds) {
      if (step.resolvedToolIds.has(toolCallId)) continue;
      const name =
        step.entry?.message.toolCalls.find((call) => call.id === toolCallId)?.name ?? toolCallId;
      this.context.appendLoopEvent({
        type: 'tool.result',
        parentUuid: step.toolCallUuids.get(toolCallId) ?? randomUUID(),
        toolCallId,
        result: { output: abortedToolOutput(name, reason), isError: true },
      });
      step.resolvedToolIds.add(toolCallId);
    }
  }

  private interruptMachineRunForCancel(turn: ActiveTurn, reason: unknown): void {
    const current = turn.current;
    if (current !== undefined) {
      this.backfillAbortedToolResults(current, reason);
      if (!current.contentAppended) this.drainMachinePartials(turn, current);
      this.context.appendLoopEvent({
        type: 'step.end',
        uuid: current.uuid,
        turnId: String(turn.id),
        step: current.number,
        finishReason: 'interrupted',
      });
      turn.current = undefined;
    }
    if (turn.interruptStep !== undefined) {
      this.emitStepInterrupted(
        turn.id,
        turn.interruptStep,
        'aborted',
        isUserCancellation(reason) ? undefined : toErrorMessage(reason),
      );
      turn.interruptStep = undefined;
    }
  }

  private machineCompletedResult(turn: ActiveTurn): LoopRunResult {
    const truncated = turn.lastStopReason === 'truncated';
    return {
      type: 'completed',
      steps: turn.steps,
      truncated,
      stopReason: turn.forcedStopReason,
    };
  }

  private async endTurn(turn: ActiveTurn, result: TurnResult): Promise<void> {
    if (this.active !== turn) return;
    this.active = undefined;
    await this.wire.drainPersisted().catch(() => undefined);
    for (const nudge of this.nudges.slice(this.nudgeCursor)) {
      if (nudge.turnScoped && !nudge.dropped) {
        nudge.dropped = true;
        nudge.onDrop?.();
      }
    }
    turn.turn.state = result.type;
    const reservation = turn.reservation;
    if (!turn.readyResolved) {
      if (result.type === 'failed') {
        reservation.ready.reject(result.error);
      } else if (result.type === 'cancelled') {
        reservation.ready.reject(
          result.reason instanceof Error ? result.reason : abortError('Turn cancelled'),
        );
      } else {
        reservation.ready.reject(new Error2(ErrorCodes.INTERNAL, 'Turn ended before first step'));
      }
    }
    const durationMs = Date.now() - turn.startedAt;
    const traceId =
      result.type === 'completed' ? this.lastRequestTraceId : this.activeRequestTrace?.traceId;
    const error = result.type === 'failed' ? toKimiErrorPayload(result.error) : undefined;
    const interruptReason = result.type === 'completed' ? undefined : interruptReasonFor(result);
    void this.dispatcher.dispatch(
      new TurnEnded({
        agentId: this.scopeContext.agentId,
        turnId: turn.id,
        reason: result.type,
        error,
        durationMs,
        interruptReason,
        stopReason: result.type === 'completed' ? result.stopReason : undefined,
      }),
    );
    if (error !== undefined) {
      void this.dispatcher.dispatch(
        new AgentErrorEvent({ ...error, agentId: this.scopeContext.agentId }),
      );
    }
    if (interruptReason !== undefined) {
      const interrupted: TurnInterruptedEvent = {
        turn_id: turn.id,
        at_step: result.steps,
        mode: turn.mode ?? 'agent',
        interrupt_reason: interruptReason,
        provider_type: turn.providerType,
        protocol: turn.protocol,
        trace_id: traceId,
      };
      this.telemetry.track2('turn_interrupted', interrupted);
    }
    const ended: TurnEndedTelemetryEvent = {
      turn_id: turn.id,
      reason: result.type,
      duration_ms: durationMs,
      mode: turn.mode ?? 'agent',
      provider_type: turn.providerType,
      protocol: turn.protocol,
      trace_id: traceId,
    };
    this.telemetry.track2('turn_ended', ended);
    this.telemetry.setContext({ turn_id: undefined, trace_id: undefined, thinking_effort: undefined });
    this.activeRequestTrace = undefined;
    this.lastRequestTraceId = undefined;
    reservation.result.resolve(result);
    this.maybeSettle();
  }

  private emitStepInterrupted(
    turnId: number,
    activeStep: number | undefined,
    reason: LoopInterruptReason,
    message?: string,
  ): void {
    if (activeStep === undefined) return;
    void this.dispatcher.dispatch(
      new TurnStepInterrupted({
        agentId: this.scopeContext.agentId,
        turnId,
        step: activeStep,
        reason,
        message,
      }),
    );
  }
}

type MachineGateDecision =
  | { readonly type: 'proceed'; readonly signal: AbortSignal; readonly step: number }
  | { readonly type: 'fail' };

function normalizeFinishReason(reason: FinishReason): string {
  if (reason === 'tool_calls') return 'tool_use';
  if (reason === 'completed') return 'end_turn';
  if (reason === 'truncated') return 'max_tokens';
  return reason;
}

function normalizePromptMessage(prompt: LoopPromptSubmit): ContextMessage {
  return prompt.message;
}

function machineUserMessage(message: ContextMessage | undefined): UserMessage {
  if (message === undefined) return EMPTY_MACHINE_PROMPT;
  return { role: 'user', content: [...message.content] };
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

interface TurnReservation {
  readonly id: number;
  readonly machineQueueId: string;
  readonly message: ContextMessage;
  readonly origin: PromptOrigin;
  readonly promptId?: string;
  readonly onMaterialize?: () => void;
  cancelled: boolean;
  launched?: boolean;
  readonly controller: AbortController;
  readonly ready: ReturnType<typeof createControlledPromise<void>>;
  readonly result: ReturnType<typeof createControlledPromise<TurnResult>>;
  readonly turn: MutableTurn;
}

interface Nudge {
  readonly contextMessage?: ContextMessage;
  readonly bypassMaxSteps: boolean;
  readonly turnScoped: boolean;
  readonly onConsume?: () => void;
  readonly onDrop?: () => void;
  dropped?: boolean;
  consumed?: boolean;
  sentToMachine?: boolean;
}

type MachineStepEntry = Extract<MachineEngineEvent, { readonly type: 'stepCompleted' }>['entry'];

interface MachineStepState {
  readonly number: number;
  readonly uuid: string;
  readonly signal: AbortSignal;
  contentAppended: boolean;
  entry: MachineStepEntry | undefined;
  usage: TokenUsage | undefined;
  timing: ModelRequestTiming | undefined;
  providerFinishReason: FinishReason | undefined;
  rawFinishReason: string | undefined;
  messageId: string | undefined;
  pendingToolIds: Set<string>;
  toolCallUuids: Map<string, string>;
  resolvedToolIds: Set<string>;
  toolStopTurn: boolean;
}

interface MachineFailedStep {
  readonly number: number;
  readonly uuid: string;
  readonly error: unknown;
}

interface ActiveTurn {
  readonly id: number;
  readonly reservation: TurnReservation;
  readonly controller: AbortController;
  readonly turn: MutableTurn;
  readonly startedAt: number;
  steps: number;
  gatedSteps: number;
  nudgeCursor: number;
  current: MachineStepState | undefined;
  interruptStep: number | undefined;
  failedStep: MachineFailedStep | undefined;
  stopRequested: boolean;
  toolStopRequested: boolean;
  forcedStopReason: string | undefined;
  lastStopReason: FinishReason | undefined;
  filtered: boolean;
  maxStepsError: LoopError | undefined;
  abortReason: unknown;
  retryRequested: boolean;
  afterChain: Promise<void>;
  partials: ContentPart[];
  forceContentPartBoundary: boolean;
  readyResolved: boolean;
  mode: 'agent' | 'plan' | undefined;
  providerType: string | undefined;
  protocol: string | undefined;
}

function cancelReasonFor(cancellation: unknown): 'user_cancelled' | 'aborted' {
  return isUserCancellation(cancellation) ? 'user_cancelled' : 'aborted';
}

function interruptReasonFor(
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

registerScopedService(
  LifecycleScope.Agent,
  IAgentLoopService,
  AgentLoopService,
  ScopeActivation.OnScopeCreated,
  'loop',
);
