/**
 * `stepRetry` domain (L4) — `IAgentStepRetryService` implementation.
 *
 * Loop error-recovery plugin: claims retryable provider failures (HTTP 429 /
 * 5xx, connection, timeout, empty response — `isRetryableGenerateError`) from
 * the loop's error-handler registry and re-enqueues the failed step's driver
 * at the head of the queue after exponential backoff (`retryBackoffDelays`).
 * The loop only learns that the error was caught; the retry rides the normal
 * step numbering and consumes `maxSteps` budget like any other step. Each
 * claimed failure publishes `turn.step.retrying`. Consecutive attempts are
 * counted per failed driver and reset when any step succeeds (`onDidFinishStep`)
 * or a new turn starts. Bound at Agent scope; Eager so the handler registers
 * before the first turn runs (same rationale as `fullCompaction`).
 */

import type { TurnStepRetryingEvent } from '@moonshot-ai/protocol';

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  readRetryAfterMs,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import { isRetryableGenerateError } from '#/app/llmProtocol/errors';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { unwrapErrorCause } from '#/errors';
import {
  IAgentLoopService,
  type LoopErrorContext,
} from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';

import { IAgentStepRetryService } from './stepRetry';

declare module '#/app/event/eventBus' {
  interface DomainEventMap {
    'turn.step.retrying': TurnStepRetryingEvent;
  }
}

export class AgentStepRetryService extends Disposable implements IAgentStepRetryService {
  declare readonly _serviceBrand: undefined;

  private lastFailedDriverId: string | undefined;
  private failedAttempts = 0;

  constructor(
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IConfigService private readonly config: IConfigService,
    @IEventBus private readonly eventBus: IEventBus,
  ) {
    super();
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
    this._register(this.eventBus.subscribe('turn.started', () => this.resetAttempts()));
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
      this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxRetriesPerStep ??
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
    this.eventBus.publish({
      type: 'turn.step.retrying',
      turnId: context.turnId,
      step: context.step,
      stepId: context.stepId,
      failedAttempt: this.failedAttempts,
      nextAttempt: this.failedAttempts + 1,
      maxAttempts,
      delayMs,
      ...retryErrorFields(error),
    });
    await sleepForRetry(delayMs, context.signal);

    if (context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentStepRetryService,
  AgentStepRetryService,
  InstantiationType.Eager,
  'stepRetry',
);
