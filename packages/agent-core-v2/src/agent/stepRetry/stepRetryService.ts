/* oxlint-disable typescript-eslint/no-unsafe-declaration-merging, eslint-plugin-import/namespace -- Event2 class+payload-interface declaration merging is the sanctioned event-declaration idiom. */
import { z } from 'zod';

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { defineState } from '#/state/state';
import {
  DEFAULT_MAX_RETRY_ATTEMPTS,
  readRetryAfterMs,
  retryBackoffDelays,
  retryErrorFields,
  sleepForRetry,
} from '#/_base/utils/retry';
import {
  APIProviderQuotaExhaustedError,
  isProviderRateLimitError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { IConfigService } from '#/app/config/config';
import { IFlagService } from '#/app/flag/flag';
import { IAgentProfileService } from '#/agent/profile/profile';
import { WarningIssued } from '#/agent/profile/profileOps';
import {
  resolveSubstituteCooldownMs,
  resolveSubstituteModelAlias,
} from '#/session/substitute/configSection';
import { substituteModelActiveKey } from '#/session/substitute/state';
import { resolveFallbackBinding } from '#/session/fallback/configSection';
import { fallbackModelActiveKey, type ActiveFallbackModel } from '#/session/fallback/state';
import { IEventBus } from '#/app/event/eventBus';
import { AgentEvent2, registerEvent2Class } from '#/app/event/event2';
import { unwrapErrorCause } from '#/errors';
import {
  IAgentLoopService,
  type LoopErrorContext,
} from '#/agent/loop/loop';
import { LOOP_CONTROL_SECTION, type LoopControl } from '#/agent/loop/configSection';
import { TurnStarted } from '#/agent/loop/turnEvents';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IEventDispatcher } from '#/state/eventDispatcher';

import { IAgentStepRetryService } from './stepRetry';

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

const turnStepRetryingSchema = z.object({
  agentId: z.string(),
  turnId: z.number(),
  step: z.number(),
  stepId: z.string().optional(),
  failedAttempt: z.number(),
  nextAttempt: z.number(),
  maxAttempts: z.number(),
  delayMs: z.number(),
  errorName: z.string(),
  errorMessage: z.string(),
  statusCode: z.number().optional(),
});

export class TurnStepRetrying extends AgentEvent2<TurnStepRetryingPayload> {
  static override readonly type = 'turn.step.retrying';
  static override readonly durable = true;
  static override readonly observable = true;
  static override readonly schema = turnStepRetryingSchema;
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

export class AgentStepRetryService extends Disposable implements IAgentStepRetryService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loopService: IAgentLoopService,
    @IConfigService private readonly config: IConfigService,
    @IEventBus private readonly eventBus: IEventBus,
    @IEventDispatcher private readonly dispatcher: IEventDispatcher,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IFlagService private readonly flags: IFlagService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
  ) {
    super();
    this.states.contributeState(stepRetryLastFailedDriverIdKey);
    this.states.contributeState(stepRetryFailedAttemptsKey);
    this.states.contributeState(substituteModelActiveKey);
    this.states.contributeState(fallbackModelActiveKey);
    this._register(
      this.loopService.registerLoopErrorHandler({
        id: 'step-retry',
        match: (context) => {
          const raw = unwrapErrorCause(context.error);
          if (isRetryableGenerateError(raw)) return true;
          return raw instanceof APIProviderQuotaExhaustedError && this.substituteCandidate() !== undefined;
        },
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
      this.config.get<LoopControl>(LOOP_CONTROL_SECTION)?.maxAttemptsPerStep ??
        DEFAULT_MAX_RETRY_ATTEMPTS,
      1,
    );
    const raw = unwrapErrorCause(context.error);
    const rateLimited =
      isProviderRateLimitError(raw) || raw instanceof APIProviderQuotaExhaustedError;
    if (rateLimited && this.activateSubstitute(raw)) {
      this.resetAttempts();
      if (context.currentStep?.signal.aborted === true) return false;
      context.retry(driver, { at: 'head' });
      return true;
    }
    if (!isRetryableGenerateError(raw)) {
      this.resetAttempts();
      return false;
    }
    if (this.failedAttempts >= maxAttempts) {
      if (await this.activateFallback(driver, context)) {
        return true;
      }
      this.resetAttempts();
      return false;
    }

    const error = unwrapErrorCause(context.error);
    const delayMs =
      readRetryAfterMs(error) ?? retryBackoffDelays(maxAttempts)[this.failedAttempts - 1] ?? 0;
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
        ...retryErrorFields(error),
      }),
    );
    await sleepForRetry(delayMs, context.signal);

    if (context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }

  private substituteCandidate(): { alias: string; primaryAlias: string } | undefined {
    const alias = resolveSubstituteModelAlias(this.config, this.flags, {
      substituteAlias: this.profile.getSessionModelOverride('substitute'),
    });
    if (alias === undefined) return undefined;
    if (this.states.get(substituteModelActiveKey) !== undefined) return undefined;
    const primaryAlias = this.profile.data().modelAlias;
    if (primaryAlias === undefined || alias === primaryAlias) return undefined;
    try {
      this.profile.resolveModelContextFor(alias);
    } catch {
      return undefined;
    }
    return { alias, primaryAlias };
  }

  private activateSubstitute(error: unknown): boolean {
    const candidate = this.substituteCandidate();
    if (candidate === undefined) return false;
    const { alias, primaryAlias } = candidate;
    const cooldownMs = Math.max(
      resolveSubstituteCooldownMs(this.config, this.flags),
      readRetryAfterMs(unwrapErrorCause(error)) ?? 0,
    );
    this.states.set(substituteModelActiveKey, {
      alias,
      primaryAlias,
      until: Date.now() + cooldownMs,
    });
    void this.dispatcher.dispatch(
      new WarningIssued({
        agentId: this.scopeContext.agentId,
        code: 'substitute-model',
        message: `Model ${primaryAlias} is unavailable, switching to substitute model ${alias} for ${formatCooldown(cooldownMs)}`,
      }),
    );
    return true;
  }

  private async activateFallback(
    driver: NonNullable<LoopErrorContext['failedDriver']>,
    context: LoopErrorContext,
  ): Promise<boolean> {
    const currentActive = this.states.get(fallbackModelActiveKey);
    const lastTriedAlias =
      currentActive !== undefined ? currentActive.alias : this.profile.data().modelAlias;
    const own = {
      modelAlias: lastTriedAlias ?? '',
      thinkingLevel: this.profile.getEffectiveThinkingLevel(),
    };
    const binding = resolveFallbackBinding(this.config, this.flags, own, lastTriedAlias, {
      fallbackAlias: this.profile.getSessionModelOverride('fallback'),
      fallbackSecondaryAlias: this.profile.getSessionModelOverride('fallbackSecondary'),
    });
    if (binding === undefined) return false;
    try {
      this.profile.resolveModelContextFor(binding.model);
    } catch {
      return false;
    }
    const tier: ActiveFallbackModel['tier'] = currentActive === undefined ? 'primary' : 'secondary';
    this.states.set(fallbackModelActiveKey, { alias: binding.model, tier });
    this.lastFailedDriverId = driver.id;
    this.failedAttempts = 0;
    void this.dispatcher.dispatch(
      new WarningIssued({
        agentId: this.scopeContext.agentId,
        code: 'fallback-model',
        message: `Model ${lastTriedAlias} exhausted its retry budget, switching to fallback model ${binding.model} (tier: ${tier})`,
      }),
    );
    if (context.currentStep?.signal.aborted === true) return false;
    context.retry(driver, { at: 'head' });
    return true;
  }
}

function formatCooldown(ms: number): string {
  const seconds = Math.round(ms / 1000);
  if (seconds < 120) return `${String(seconds)}s`;
  return `${String(Math.round(seconds / 60))}m`;
}

registerEvent2Class(TurnStepRetrying);

registerScopedService(
  LifecycleScope.Agent,
  IAgentStepRetryService,
  AgentStepRetryService,
  ScopeActivation.OnScopeCreated,
  'stepRetry',
);
