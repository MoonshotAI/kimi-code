/**
 * `turn` domain (L4) — `IAgentTurnService` implementation.
 *
 * Owns the agent's turn lifecycle: the next-turn-id counter lives in the `wire`
 * `TurnModel` (advanced only through the `turn.launch` Op via `wire.dispatch`,
 * read through `wire.getModel`), while the per-turn runtime (the active `Turn`,
 * its `AbortController` and `ready`/`result` promises, and the `turn.started` /
 * `turn.ended` / `error` signals) stays live-only and is emitted through
 * `wire.signal`. `wire.replay` rebuilds the counter silently so resumed sessions
 * keep allocating fresh ids without re-firing any signal. Bound at Agent scope.
 */

import { createControlledPromise } from '@antfu/utils';

import type { TurnEndedEvent, TurnStartedEvent } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError, toKimiErrorPayload } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import { IAgentLoopService } from '#/agent/loop';
import { IAgentTelemetryContextService, ITelemetryService } from '#/app/telemetry';
import { IAgentWireService, type IWireService } from '#/wire';
import type { Turn, TurnEndedContext, TurnResult } from './turn';
import { IAgentTurnService } from './turn';
import { launchTurn, TurnModel } from './turnOps';

declare module '#/wire' {
  interface SignalMap {
    'turn.started': Omit<TurnStartedEvent, 'type'>;
    'turn.ended': Omit<TurnEndedEvent, 'type'>;
    // `error` is declared by the `mcp` domain (interface-merge); reused here, not
    // re-declared.
  }
}

export class AgentTurnService implements IAgentTurnService {
  declare readonly _serviceBrand: undefined;
  private activeTurn: Turn | undefined;

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    onEnded: new OrderedHookSlot<TurnEndedContext>(),
  };

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentWireService private readonly wire: IWireService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
  ) {}

  launch(): Turn {
    if (this.activeTurn !== undefined) {
      throw new KimiError(
        ErrorCodes.TURN_AGENT_BUSY,
        `Cannot launch a new turn while another turn (ID ${this.activeTurn.id}) is active`,
        { details: { turnId: this.activeTurn.id } },
      );
    }

    const turnId = this.wire.getModel(TurnModel).nextTurnId;
    this.wire.dispatch(launchTurn({ turnId }));
    const abortController = new AbortController();
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: turnId,
      abortController,
      ready,
      result: Promise.resolve({ reason: 'failed' }),
    };
    void ready.catch(() => undefined);
    this.activeTurn = turn;
    turn.result = this.runTurn(turn, ready);
    void this.hooks.onLaunched.run({ turn });
    return turn;
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  private async runTurn(
    turn: Turn,
    ready: ReturnType<typeof createControlledPromise<void>>,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    const turnTelemetry = this.telemetry.withContext(this.telemetryContext.get());
    let result: TurnResult | undefined;
    try {
      turnTelemetry.track('turn_started');
      this.wire.signal({
        type: 'turn.started',
        turnId: turn.id,
      });
      result = await this.loop.run({
        turnId: turn.id,
        signal: turn.abortController.signal,
        onStarted: () => ready.resolve(),
      });
      return result;
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        result = { reason: 'cancelled', error: turn.abortController.signal.reason };
        return result;
      }
      result = { reason: 'failed', error };
      return result;
    } finally {
      ready.reject(new Error('Turn ended before first step', { cause: result?.error }));
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
      if (result !== undefined) {
        const error = result.error !== undefined ? toKimiErrorPayload(result.error) : undefined;
        this.wire.signal({
          type: 'turn.ended',
          turnId: turn.id,
          reason: result.reason,
          error,
          durationMs: Date.now() - startedAt,
        });
        if (error !== undefined) {
          this.wire.signal({ type: 'error', ...error });
        }
        if (result.reason !== 'completed') {
          turnTelemetry.track('turn_interrupted', { at_step: result.steps ?? null });
        }
      }
      if (result !== undefined) {
        await this.hooks.onEnded.run({ turn, result });
      }
    }
  }
}

type MutableTurn = {
  -readonly [K in keyof Turn]: Turn[K];
};

registerScopedService(
  LifecycleScope.Agent,
  IAgentTurnService,
  AgentTurnService,
  InstantiationType.Delayed,
  'turn',
);
