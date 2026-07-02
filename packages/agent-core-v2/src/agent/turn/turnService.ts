import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { toKimiErrorPayload, type KimiErrorPayload } from "#/errors";
import { isUserCancellation } from "#/_base/utils/abort";
import type { ContextMessage, PromptOrigin } from '#/agent/contextMemory';
import { IAgentContextMemoryService, USER_PROMPT_ORIGIN } from '#/agent/contextMemory';
import { IAgentExternalHooksService } from '#/agent/externalHooks';
import { OrderedHookSlot } from '#/hooks';
import { IAgentLoopService, type TurnResult as LoopTurnResult } from '#/agent/loop';
import { ITelemetryService } from '#/app/telemetry';
import { IAgentRecordService } from '#/agent/record';
import type {
  Turn,
  TurnEndedContext,
  TurnResult,
} from './turn';
import { IAgentTurnService } from './turn';

declare module '#/agent/wireRecord' {
  interface WireRecordMap {
    'turn.launch': {
      turnId: number;
      origin: PromptOrigin;
      promptMessageId?: string;
    };
  }
}

export class AgentTurnService implements IAgentTurnService {
  declare readonly _serviceBrand: undefined;
  private nextTurnId = 0;
  private activeTurn: Turn | undefined;
  private lastEndedReasonValue: TurnResult['reason'] | undefined;
  private readonly readyControllers = new WeakMap<Turn, ControlledPromise<void>>();
  private readonly readySettled = new WeakSet<Turn>();
  private readonly interruptedTelemetryTurnIds = new Set<number>();
  private readonly telemetryModeByTurn = new Map<number, 'agent' | 'plan'>();
  private planModeActive = false;

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    onEnded: new OrderedHookSlot<TurnEndedContext>(),
  };

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @IAgentContextMemoryService private readonly context: IAgentContextMemoryService,
    @IAgentExternalHooksService private readonly externalHooks: IAgentExternalHooksService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
  ) {
    record.define('turn.launch', {
      resume: (r) => {
        this.restoreLaunch(r.turnId);
      },
    });
    this.loop.hooks.beforeStep.register(
      'turn-ready-before-step',
      async (ctx, next) => {
        await next();
        const turn = this.activeTurn;
        if (turn !== undefined && turn.id === ctx.turnId) {
          this.resolveReady(turn);
        }
      },
    );
    this.record.on((event) => {
      if (event.type === 'agent.status.updated' && event.planMode !== undefined) {
        this.planModeActive = event.planMode;
        return;
      }
      if (event.type === 'turn.step.interrupted') {
        if (typeof event.turnId === 'number' && typeof event.step === 'number') {
          this.trackTurnInterrupted(event.turnId, event.step);
        }
      }
    });
  }

  launch(origin: PromptOrigin, promptMessageId?: string): Turn {
    if (this.activeTurn !== undefined) {
      throw new Error(`Cannot launch a new turn while turn ${this.activeTurn.id} is active`);
    }

    // A new turn clears the previous `aborted`/`failed` memory (mirrors v1
    // clearing `_abortedTurns` on `turn.started` / `prompt.submitted`).
    this.lastEndedReasonValue = undefined;

    const turnId = this.nextTurnId;
    this.record.append({ type: 'turn.launch', turnId, origin, promptMessageId });
    this.restoreLaunch(turnId);
    const abortController = new AbortController();
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: turnId,
      promptMessageId,
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

  lastEndedReason(): TurnResult['reason'] | undefined {
    return this.lastEndedReasonValue;
  }

  private async runTurn(turn: Turn, origin: PromptOrigin): Promise<TurnResult> {
    const startedAt = Date.now();
    const telemetryMode = this.telemetryMode();
    this.telemetryModeByTurn.set(turn.id, telemetryMode);
    let result: TurnResult | undefined;
    try {
      this.telemetry.track('turn_started', { mode: telemetryMode });
      this.record.signal({
        type: 'turn.started',
        turnId: turn.id,
        origin,
        promptMessageId: turn.promptMessageId,
      });
      const promptHookResult = await this.applyUserPromptHook(turn, origin);
      if (promptHookResult !== undefined) {
        result = promptHookResult;
        return result;
      }
      result = toAgentTurnResult(
        await this.loop.runTurn(turn.id, turn.abortController.signal),
        turn.abortController.signal,
      );
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
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      if (result !== undefined) {
        this.lastEndedReasonValue = result.reason;
        const ended = toTurnEndedEvent(turn, result, Date.now() - startedAt);
        if (
          ended.reason === 'cancelled' &&
          isUserCancellation(turn.abortController.signal.reason)
        ) {
          this.externalHooks.triggerInterrupt({ turnId: turn.id, reason: 'cancelled' });
        }
        this.record.signal(ended);
        if (ended.error !== undefined) {
          this.record.signal({ type: 'error', ...ended.error });
        }
        if (ended.reason !== 'completed') {
          this.trackTurnInterrupted(turn.id, 0);
        }
      }
      if (result !== undefined) {
        await this.hooks.onEnded.run({ turn, result });
      }
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
    const promptMessage = this.context.get().at(-1);
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
      this.record.signal({
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
      this.record.signal({
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
    this.context.splice(this.context.get().length, 0, messages);
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
    return this.planModeActive ? 'plan' : 'agent';
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

function toAgentTurnResult(result: LoopTurnResult, signal: AbortSignal): TurnResult {
  if (result.stopReason === 'aborted') {
    return { reason: 'cancelled', error: signal.reason };
  }
  if (result.stopReason === 'filtered') {
    return { reason: 'filtered' };
  }
  return { reason: 'completed' };
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
  IAgentTurnService,
  AgentTurnService,
  InstantiationType.Delayed,
  'turn',
);
