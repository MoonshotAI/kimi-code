/**
 * `turn` domain (L4) — `IAgentTurnService` implementation.
 *
 * Owns the agent's turn lifecycle: the next-turn-id counter lives in the `wire`
 * `TurnModel` (advanced only through the `turn.prompt` Op via `wire.dispatch`,
 * read through `wire.getModel`), while the per-turn runtime (the active `Turn`,
 * its `ready`/`result` promises, and the `turn.started` / `turn.ended` / `error`
 * events) stays live-only. Admission, cancellation and the turn `AbortSignal`
 * are delegated to the `activity` kernel (`IAgentActivityService`): `launch`
 * goes through `activity.begin('turn')` and the returned lease owns the signal
 * and the path back to `idle` (`lease.end()`). `activeTurn` is kept as a handle
 * cache for `getActiveTurn()` but no longer carries the mutual-exclusion duty.
 * `turn.started` is emitted through `wire.signal` (legacy channel); `turn.ended`
 * / `error` publish to `IEventBus` and are also emitted through `wire.signal`.
 * `wire.replay` rebuilds the counter silently so resumed sessions keep
 * allocating fresh ids without re-firing anything. Bound at Agent scope.
 */

import { createControlledPromise } from '@antfu/utils';

import type { TurnEndedEvent, TurnStartedEvent } from '@moonshot-ai/protocol';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { userCancellationReason } from '#/_base/utils/abort';
import { toKimiErrorPayload } from '#/errors';
import { USER_PROMPT_ORIGIN } from '#/agent/contextMemory/types';
import type { ContentPart } from '#/app/llmProtocol/message';
import type { PromptOrigin } from '#/agent/contextMemory/types';
import type { ActivityLease } from '#/activity/activity';
import { IAgentActivityService } from '#/activity/activity';
import { IAgentLoopService } from '#/agent/loop/loop';
import { IEventBus } from '#/app/event/eventBus';
import { IAgentTelemetryContextService } from '#/app/telemetry/agentTelemetryContext';
import { ITelemetryService } from '#/app/telemetry/telemetry';
import { IAgentWireService } from '#/wire/tokens';
import type { IWireService } from '#/wire/wireService';
import type { Turn, TurnPromptInfo, TurnResult } from './turn';
import { IAgentTurnService } from './turn';
import { cancelTurn, promptTurn, steerTurn } from './turnOps';

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
    @IAgentActivityService private readonly activity: IAgentActivityService,
  ) {}

  launch(prompt?: TurnPromptInfo): Turn {
    const lease = this.activity.begin('turn', { origin: prompt?.origin ?? USER_PROMPT_ORIGIN });
    return this.launchWithLease(lease, prompt);
  }

  launchWithLease(lease: ActivityLease, prompt?: TurnPromptInfo): Turn {
    this.wire.dispatch(
      promptTurn({
        input: prompt?.input ?? [],
        origin: lease.origin,
      }),
    );
    const ready = createControlledPromise<void>();
    const turn: MutableTurn = {
      id: lease.turnId,
      signal: lease.signal,
      ready,
      result: Promise.resolve({
        type: 'failed',
        steps: 0,
        error: new Error('Turn result was not initialized'),
      }),
    };
    void ready.catch(() => undefined);
    this.activeTurn = turn;
    this.eventBus.publish({ type: 'turn.started', turnId: turn.id, origin: lease.origin });
    turn.result = this.runTurn(turn, lease, ready);
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
    return this.activity.cancel(reason ?? userCancellationReason());
  }

  private async runTurn(
    turn: Turn,
    lease: ActivityLease,
    ready: ReturnType<typeof createControlledPromise<void>>,
  ): Promise<TurnResult> {
    const startedAt = Date.now();
    const turnTelemetry = this.telemetry.withContext(this.telemetryContext.get());
    let result: TurnResult | undefined;
    try {
      turnTelemetry.track('turn_started');
      result = await this.loop.run({
        turnId: turn.id,
        signal: lease.signal,
        onStarted: () => ready.resolve(),
      });
      return result;
    } catch (error) {
      if (lease.signal.aborted) {
        result = {
          type: 'cancelled',
          steps: 0,
          reason: lease.signal.reason ?? error,
        };
        return result;
      }
      result = { type: 'failed', error, steps: 0 };
      return result;
    } finally {
      ready.reject(new Error('Turn ended before first step', {
        cause: result?.type === 'failed' ? result.error : undefined,
      }));
      if (this.activeTurn === turn) {
        this.activeTurn = undefined;
      }
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
        if (error !== undefined) {
          this.eventBus.publish({ type: 'error', ...error });
        }
        if (result.type !== 'completed') {
          turnTelemetry.track('turn_interrupted', { at_step: result.steps });
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
