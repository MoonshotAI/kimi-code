/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { Disposable } from '#/_base/di/lifecycle';
import { defineState } from '#/state/state';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  readRetryAfterMs,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { isRetryableGenerateError } from '#/kosong/contract/errors';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { AgentEvent2 } from '#/app/event/event2';
import { unwrapErrorCause } from '#/errors';
import type { LoopRetryActivity } from '#/actor/loop/loop';
import type { LoopControl, LoopErrorContext } from '#/actor/loop/internal/loop';
import { LOOP_CONTROL_SECTION, type LoopControl as LoopControlConfig } from '#/actor/loop/configSection';
import { TurnStarted } from '#/actor/loop/turnEvents';
import type { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import type { IAgentStateService } from '#/agent/state/agentState';
import type { IEventDispatcher } from '#/state/eventDispatcher';

export interface TurnStepRetryingPayload {
  readonly agentId: string;
  readonly turnId: number;
  readonly step: number;
  readonly stepId?: string;
  readonly failedAttempt: number;
  readonly nextAttempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly errorName: string;
  readonly errorMessage: string;
  readonly statusCode?: number;
}

export class TurnStepRetrying extends AgentEvent2<TurnStepRetryingPayload> {
  static override readonly type = 'turn.step.retrying';
  static override readonly observable = true;
}
export interface TurnStepRetrying extends TurnStepRetryingPayload {}

export const stepRetryLastFailedDriverIdKey = defineState<string | undefined>(
  'stepRetry.lastFailedDriverId',
  () => undefined as string | undefined,
);
export const stepRetryFailedAttemptsKey = defineState<number>(
  'stepRetry.failedAttempts',
  () => 0,
);

export class AgentStepRetry extends Disposable {
  constructor(
    private readonly loopService: LoopControl,
    private readonly config: IConfigService,
    private readonly eventBus: IEventBus,
    private readonly dispatcher: IEventDispatcher,
    private readonly scopeContext: IAgentScopeContext,
    private readonly states: IAgentStateService,
    private readonly onRetrying?: (retry: LoopRetryActivity) => void,
  ) {
    super();
    this.states.contributeState(stepRetryLastFailedDriverIdKey);
    this.states.contributeState(stepRetryFailedAttemptsKey);
    this._register(
      this.loopService.registerLoopErrorHandler({
        id: 'step-retry',
        match: (context) => isRetryableGenerateError(unwrapErrorCause(context.error)),
        handle: (context) => this.recover(context),
      }),
    );
    this._register(
      this.loopService.hooks.onDidFinishStep.register('step-retry', async (_ctx, next) => {
        this.resetAttempts();
        await next();
      }),
    );
    this._register(this.eventBus.subscribe(TurnStarted, () => this.resetAttempts()));
  }

  private get lastFailedDriverId(): string | undefined {
    return this.states.get(stepRetryLastFailedDriverIdKey);
  }

  private set lastFailedDriverId(value: string | undefined) {
    this.states.set(stepRetryLastFailedDriverIdKey, value);
  }

  private get failedAttempts(): number {
    return this.states.get(stepRetryFailedAttemptsKey);
  }

  private set failedAttempts(value: number) {
    this.states.set(stepRetryFailedAttemptsKey, value);
  }

  private resetAttempts(): void {
    this.lastFailedDriverId = undefined;
    this.failedAttempts = 0;
  }

  private async recover(context: LoopErrorContext): Promise<boolean> {
    const driver = context.failedDriver;
    if (driver === undefined || context.step === undefined) return false;

    if (this.lastFailedDriverId !== driver.id) {
      this.lastFailedDriverId = driver.id;
      this.failedAttempts = 0;
    }
    this.failedAttempts += 1;

    const maxAttempts = Math.max(
      this.config.get<LoopControlConfig>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep ??
        DEFAULT_MAX_RETRY_ATTEMPTS,
      1,
    );
    if (this.failedAttempts >= maxAttempts) {
      this.resetAttempts();
      return false;
    }

    const error = unwrapErrorCause(context.error);
    const delayMs =
      readRetryAfterMs(error) ?? retryBackoffDelays(maxAttempts)[this.failedAttempts - 1] ?? 0;
    const errorFields = retryErrorFields(error);
    void this.dispatcher.dispatch(
      new TurnStepRetrying({
        agentId: this.scopeContext.agentId,
        turnId: context.turnId,
        step: context.step,
        stepId: context.stepId,
        failedAttempt: this.failedAttempts,
        nextAttempt: this.failedAttempts + 1,
        maxAttempts,
        delayMs,
        ...errorFields,
      }),
    );
    this.onRetrying?.({
      failedAttempt: this.failedAttempts,
      nextAttempt: this.failedAttempts + 1,
      maxAttempts,
      delayMs,
      errorName: errorFields.errorName,
      statusCode: errorFields.statusCode,
    });
    await sleepForRetry(delayMs, context.signal);

    if (context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }
}
