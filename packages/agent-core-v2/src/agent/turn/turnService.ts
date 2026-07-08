/**
 * `turn` domain (L4) — `IAgentTurnService` implementation.
 *
 * Owns the agent's turn lifecycle: the next-turn-id counter lives in the `wire`
 * `TurnModel` (advanced only through the `turn.prompt` Op via `wire.dispatch`,
 * read through `wire.getModel`), while the per-turn runtime (the active `Turn`,
 * its `AbortController` and `ready`/`result` promises, and the `turn.started` /
 * `turn.ended` / `error` events) stays live-only. `turn.started` is emitted
 * through `wire.signal` (legacy channel); `turn.ended` / `error` publish to
 * `IEventBus` and are also emitted through `wire.signal`. `wire.replay` rebuilds
 * the counter silently so resumed sessions keep allocating fresh ids without
 * re-firing anything. `turn.launch` (`launchTurn`) stays registered only to
 * replay sessions written at wire protocol 1.5. Bound at Agent scope.
 */

import { createControlledPromise } from '@antfu/utils';

import type { TurnEndedEvent, TurnStartedEvent } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { ErrorCodes, KimiError, toKimiErrorPayload } from '#/errors';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import type { ContentPart } from '#/app/llmProtocol/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import type { Turn, TurnPromptInfo, TurnResult } from './turn';
import { IAgentTurnService } from './turn';
import { cancelTurn, promptTurn, steerTurn, TurnModel } from './turnOps';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.started': TurnStartedEvent;
    'turn.ended': TurnEndedEvent;
    // `error` is declared by the `mcp` domain (interface-merge); reused here, not
    // re-declared.
  }
}

export class AgentTurnService implements IAgentTurnService {
  declare readonly _serviceBrand: undefined;
  private activeTurn: Turn | undefined;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentWireService private readonly wire: IWireService,
    @IEventBus private readonly eventBus: IEventBus,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
  ) {}

  launch(prompt?: TurnPromptInfo): Turn {
    if (this.activeTurn !== undefined) {
      throw new KimiError(
        ErrorCodes.TURN_AGENT_BUSY,
        `Cannot launch a new turn while another turn (ID ${this.activeTurn.id}) is active`,
        { details: { turnId: this.activeTurn.id } },
      );
    }

    const turnId = this.wire.getModel(TurnModel).nextTurnId;
    this.wire.dispatch(
      promptTurn({
        turnId,
        input: prompt?.input,
        origin: prompt?.origin,
        steer: prompt?.steer,
      }),
    );
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
    this.eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: prompt?.origin ?? USER_PROMPT_ORIGIN });
    turn.result = this.runTurn(turn, ready);
    return turn;
  }

  getActiveTurn(): Turn | undefined {
    return this.activeTurn;
  }

  recordSteer(input: readonly ContentPart[], origin: PromptOrigin = USER_PROMPT_ORIGIN): void {
    this.wire.dispatch(steerTurn({ input, origin }));
  }

  cancel(turnId?: number, reason?: unknown): boolean {
    this.wire.dispatch(cancelTurn({ turnId }));
    const turn = this.activeTurn;
    if (turn === undefined) return false;
    if (turnId !== undefined && turn.id !== turnId) return false;
    turn.abortController.abort(reason ?? userCancellationReason());
    return true;
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
      result = await this.loop.run({
        turnId: turn.id,
        signal: turn.abortController.signal,
        onStarted: () => ready.resolve(),
      });
      return result;
    } catch (error) {
      if (turn.abortController.signal.aborted) {
        result = { reason: 'cancelled' };
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
        this.eventBus.publish({
          type: 'turn.ended',
          turnId: turn.id,
          reason: result.reason,
          error,
          durationMs: Date.now() - startedAt,
        });
        if (error !== undefined) {
          this.eventBus.publish({ type: 'error', ...error });
        }
        if (result.reason !== 'completed') {
          turnTelemetry.track('turn_interrupted', { at_step: result.steps ?? null });
        }
      }
      // `turn.ended` is published to `IEventBus` above; subscribers (swarm /
      // goal / externalHooks) react there — no hook slot to run here.
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
