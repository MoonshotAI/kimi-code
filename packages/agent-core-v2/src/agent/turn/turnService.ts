import { createControlledPromise } from '@antfu/utils';

import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { ErrorCodes, KimiError, toKimiErrorPayload } from '#/errors';
import { OrderedHookSlot } from '#/hooks';
import { IAgentLoopService } from '#/agent/loop';
import { IAgentTelemetryContextService, ITelemetryService } from '#/app/telemetry';
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
    };
  }
}

export class AgentTurnService implements IAgentTurnService {
  declare readonly _serviceBrand: undefined;
  private nextTurnId = 0;
  private activeTurn: Turn | undefined;

  readonly hooks = {
    onLaunched: new OrderedHookSlot<{ turn: Turn }>(),
    onEnded: new OrderedHookSlot<TurnEndedContext>(),
  };

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentRecordService private readonly record: IAgentRecordService,
    @ITelemetryService private readonly telemetry: ITelemetryService,
    @IAgentTelemetryContextService private readonly telemetryContext: IAgentTelemetryContextService,
  ) {
    record.define('turn.launch', {
      resume: (r) => {
        this.restoreLaunch(r.turnId);
      },
    });
  }

  launch(): Turn {
    if (this.activeTurn !== undefined) {
      throw new KimiError(
        ErrorCodes.TURN_AGENT_BUSY,
        `Cannot launch a new turn while another turn (ID ${this.activeTurn.id}) is active`,
        { details: { turnId: this.activeTurn.id } },
      );
    }

    const turnId = this.nextTurnId;
    this.record.append({ type: 'turn.launch', turnId });
    this.restoreLaunch(turnId);
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
      this.record.signal({
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
        this.record.signal({
          type: 'turn.ended',
          turnId: turn.id,
          reason: result.reason,
          error,
          durationMs: Date.now() - startedAt,
        });
        if (error !== undefined) {
          this.record.signal({ type: 'error', ...error });
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

  private restoreLaunch(turnId: number): void {
    if (Number.isInteger(turnId) && turnId >= this.nextTurnId) {
      this.nextTurnId = turnId + 1;
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
