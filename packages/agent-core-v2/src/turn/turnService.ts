import {
  IInstantiationService,
} from "#/_base/di";
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { toKimiErrorPayload, type KimiErrorPayload } from "#/errors";
import { isUserCancellation, userCancellationReason } from "#/_base/utils/abort";
import type { ContextMessage, PromptOrigin } from '#/contextMemory';
import { IContextMemory, USER_PROMPT_ORIGIN } from '#/contextMemory';
import { IEventBus } from '#/eventBus';
import { IExternalHooksService } from '#/externalHooks';
import { OrderedHookSlot } from '#/hooks';
import { ILoopService } from '#/loop';
import { IPlanService } from '#/plan';
import { ITelemetryService } from '#/telemetry';
import { IUsageService } from '#/usage';
import { IWireRecord } from '#/wireRecord';
import type {
  Turn,
  TurnEndedContext,
  TurnResult,
  TurnStepContext,
} from './turn';
import { ITurnService } from './turn';

declare module '#/wireRecord' {
  interface WireRecordMap {
    'turn.launch': {
      turnId: number;
      origin: PromptOrigin;
    };
  }
}

export class TurnService implements ITurnService {
  private nextTurnId = 0;
  private activeTurn: Turn | undefined;
  private readonly readyControllers = new WeakMap<Turn, ControlledPromise<void>>();
  private readonly readySettled = new WeakSet<Turn>();
  private readonly currentStepByTurn = new Map<number, number>();
  private readonly interruptedTelemetryTurnIds = new Set<number>();
  private readonly telemetryModeByTurn = new Map<number, 'agent' | 'plan'>();

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    onEnded: new OrderedHookSlot<TurnEndedContext>(),
    beforeStep: new OrderedHookSlot<TurnStepContext>(),
    afterStep: new OrderedHookSlot<TurnStepContext>(),
  };

  constructor(
    @ILoopService private readonly loop: ILoopService,
    @IUsageService private readonly usage: IUsageService,
    @IEventBus private readonly events: IEventBus,
    @IWireRecord private readonly wireRecord: IWireRecord,
    @IContextMemory private readonly context: IContextMemory,
    @IExternalHooksService private readonly externalHooks: IExternalHooksService,
    @IInstantiationService private readonly instantiation: IInstantiationService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    wireRecord.register('turn.launch', (record) => {
      this.restoreLaunch(record.turnId);
    });
    this.hooks.beforeStep.register('turn-before-step-event', async (ctx, next) => {
      await next();
      this.resolveReady(ctx.turn);
    });
    this.events.on((event) => {
      if (event.type === 'turn.step.started') {
        if (typeof event.turnId === 'number' && typeof event.step === 'number') {
          this.currentStepByTurn.set(event.turnId, event.step);
        }
        return;
      }
      if (event.type === 'turn.step.interrupted') {
        if (typeof event.turnId === 'number' && typeof event.step === 'number') {
          this.trackTurnInterrupted(event.turnId, event.step);
        }
      }
    });
  }

  launch(origin: PromptOrigin): Turn {
    if (this.activeTurn !== undefined) {
      throw new Error(`Cannot launch a new turn while turn ${this.activeTurn.id} is active`);
    }

    const turnId = this.nextTurnId;
    this.wireRecord.append({ type: 'turn.launch', turnId, origin });
    this.restoreLaunch(turnId);
    const abortController = new AbortController();
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: turnId,
      abortController,
      ready: ready.promise,
      result: Promise.resolve({ reason: 'failed' }),
    };
    this.readyControllers.set(turn, ready);
    void ready.promise.catch(() => undefined);
    this.activeTurn = turn;
    turn.result = this.runTurn(turn, origin);
    void this.hooks.onLaunched.run({ turn });
    return turn;
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  cancel(turnId?: number, reason?: unknown): void {
    const turn = this.activeTurn;
    if (turn === undefined) return;
    if (turnId !== undefined && turn.id !== turnId) return;
    turn.abortController.abort(reason ?? userCancellationReason());
  }

  private async runTurn(turn: Turn, origin: PromptOrigin): Promise<TurnResult> {
    const startedAt = Date.now();
    const telemetryMode = this.telemetryMode();
    this.telemetryModeByTurn.set(turn.id, telemetryMode);
    let result: TurnResult | undefined;
    try {
      this.usage.beginTurn();
      this.telemetry.track('turn_started', { mode: telemetryMode });
      this.events.emit({ type: 'turn.started', turnId: turn.id, origin });
      const promptHookResult = await this.applyUserPromptHook(turn, origin);
      if (promptHookResult !== undefined) {
        result = promptHookResult;
        return result;
      }
      result = await this.loop.runTurn(turn, {
        beforeStep: this.hooks.beforeStep,
        afterStep: this.hooks.afterStep,
      });
      return result;
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        result = { reason: 'cancelled', error: turn.abortController.signal.reason };
        this.rejectReady(turn, turn.abortController.signal.reason);
        return result;
      }
      this.externalHooks.triggerStopFailure(error, turn.abortController.signal);
      this.rejectReady(turn, error);
      result = { reason: 'failed', error };
      return result;
    } finally {
      if (result !== undefined) {
        this.rejectReady(turn, result);
      }
      this.usage.endTurn();
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      if (result !== undefined) {
        const ended = toTurnEndedEvent(turn, result, Date.now() - startedAt);
        if (
          ended.reason === 'cancelled' &&
          isUserCancellation(turn.abortController.signal.reason)
        ) {
          this.externalHooks.triggerInterrupt({ turnId: turn.id, reason: 'cancelled' });
        }
        this.events.emit(ended);
        if (ended.error !== undefined) {
          this.events.emit({ type: 'error', ...ended.error });
        }
        if (ended.reason !== 'completed') {
          this.trackTurnInterrupted(turn.id, this.currentStepByTurn.get(turn.id) ?? 0);
        }
      }
      if (result !== undefined) {
        await this.hooks.onEnded.run({ turn, result });
      }
      this.currentStepByTurn.delete(turn.id);
      this.interruptedTelemetryTurnIds.delete(turn.id);
      this.telemetryModeByTurn.delete(turn.id);
    }
  }

  private resolveReady(turn: Turn): void {
    if (this.readySettled.has(turn)) return;
    this.readySettled.add(turn);
    this.readyControllers.get(turn)?.resolve();
  }

  private restoreLaunch(turnId: number): void {
    if (Number.isInteger(turnId) && turnId >= this.nextTurnId) {
      this.nextTurnId = turnId + 1;
    }
  }

  private async applyUserPromptHook(
    turn: Turn,
    origin: PromptOrigin,
  ): Promise<TurnResult | undefined> {
    if (origin.kind !== 'user') return undefined;
    const promptMessage = this.context.getHistory().at(-1);
    if (!shouldRunUserPromptHook(promptMessage)) return undefined;

    const hookResult = await this.externalHooks.triggerUserPromptSubmit(
      promptMessage.content,
      turn.abortController.signal,
    );
    if (hookResult?.action === 'block') {
      this.append({
        role: 'assistant',
        content: [{ type: 'text', text: hookResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: hookResult.event, blocked: true },
      });
      this.events.emit({
        type: 'hook.result',
        turnId: turn.id,
        hookEvent: hookResult.event,
        content: hookResult.message,
        blocked: true,
      });
      return { reason: 'completed' };
    }

    if (hookResult?.action === 'append') {
      this.append({
        role: 'user',
        content: [{ type: 'text', text: hookResult.text }],
        toolCalls: [],
        origin: { kind: 'hook_result', event: hookResult.event },
      });
      this.events.emit({
        type: 'hook.result',
        turnId: turn.id,
        hookEvent: hookResult.event,
        content: hookResult.message,
      });
    }
    return undefined;
  }

  private append(...messages: ContextMessage[]): void {
    if (messages.length === 0) return;
    this.context.spliceHistory(this.context.getHistory().length, 0, messages);
  }

  private rejectReady(turn: Turn, reason: unknown): void {
    if (this.readySettled.has(turn)) return;
    this.readySettled.add(turn);
    this.readyControllers.get(turn)?.reject(reason);
  }

  private trackTurnInterrupted(turnId: number, atStep: number): void {
    if (this.interruptedTelemetryTurnIds.has(turnId)) return;
    this.interruptedTelemetryTurnIds.add(turnId);
    this.telemetry.track('turn_interrupted', {
      mode: this.telemetryModeByTurn.get(turnId) ?? this.telemetryMode(),
      at_step: atStep,
    });
  }

  private telemetryMode(): 'agent' | 'plan' {
    const planMode = this.instantiation.invokeFunction((accessor) =>
      accessor.get(IPlanService),
    );
    return planMode.isActive ? 'plan' : 'agent';
  }
}

function shouldRunUserPromptHook(message: ContextMessage | undefined): message is ContextMessage {
  if (message === undefined || message.role !== 'user') return false;
  return (message.origin ?? USER_PROMPT_ORIGIN).kind === 'user';
}

function toTurnEndedEvent(
  turn: Turn,
  result: TurnResult,
  durationMs: number,
): {
  type: 'turn.ended';
  turnId: number;
  reason: TurnResult['reason'];
  error?: KimiErrorPayload;
  durationMs: number;
} {
  if (result.reason !== 'failed' || result.error === undefined) {
    return { type: 'turn.ended', turnId: turn.id, reason: result.reason, durationMs };
  }
  return {
    type: 'turn.ended',
    turnId: turn.id,
    reason: result.reason,
    error: summarizeTurnError(result.error, turn.id),
    durationMs,
  };
}

const LLM_NOT_SET_MESSAGE = 'LLM not set, send "/login" to login';

function summarizeTurnError(error: unknown, turnId: number): KimiErrorPayload {
  const payload = toKimiErrorPayload(error);
  const details = { ...payload.details, turnId };
  // Substitute a friendlier, login-aware message for model-not-configured. The
  // raw "Model not set" / "Provider not set" text is not actionable.
  if (payload.code === 'model.not_configured') {
    return { ...payload, message: LLM_NOT_SET_MESSAGE, details };
  }
  return { ...payload, details };
}

interface ControlledPromise<T> {
  readonly promise: Promise<T>;
  resolve(value: T | PromiseLike<T>): void;
  reject(reason?: unknown): void;
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

function createControlledPromise<T>(): ControlledPromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

registerScopedService(
  LifecycleScope.Agent,
  ITurnService,
  TurnService,
  InstantiationType.Delayed,
  'turn',
);
