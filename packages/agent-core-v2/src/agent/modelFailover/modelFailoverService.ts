/**
 * `modelFailover` domain (L4) — `IAgentModelFailoverService` implementation.
 *
 * Participates after `stepRetry` in the Agent loop's ordered error-recovery
 * chain. For non-main agents, it classifies provider failures through
 * `kosong`, advances the configured fallback route within a bounded per-turn
 * state machine, atomically updates the persisted `profile` model/effort
 * binding, invalidates the current `llmRequester` turn snapshot, records the
 * switch through `wire`, and re-enqueues the same failed driver. Reads
 * preferences from `config`, the experiment from `flag`, model/provider data
 * from `modelCatalog`, identity from `scopeContext`, turn facts from `event`,
 * and mutable counters from `agentState`; warnings and diagnostics go through
 * `event` and `log`. Bound at Agent scope and activated with the scope so its
 * recovery handler exists before the first turn.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope, ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { ILogService } from '#/_base/log/log';
import { defineState } from '#/_base/state/stateRegistry';
import { IAgentLLMRequesterService } from '#/agent/llmRequester/llmRequester';
import { IAgentLoopService, type LoopErrorContext } from '#/agent/loop/loop';
import { IAgentProfileService } from '#/agent/profile/profile';
import { IAgentScopeContext } from '#/agent/scopeContext/scopeContext';
import { IAgentStateService } from '#/agent/state/agentState';
import { IAgentStepRetryService } from '#/agent/stepRetry/stepRetry';
import { IConfigService } from '#/app/config/config';
import { IEventBus } from '#/app/event/eventBus';
import { IFlagService } from '#/app/flag/flag';
import { unwrapErrorCause } from '#/errors';
import {
  APIEmptyResponseError,
  classifyApiError,
  isRetryableGenerateError,
} from '#/kosong/contract/errors';
import { IModelCatalog, type Model } from '#/kosong/model/catalog';
import { normalizeRequestedThinkingEffort } from '#/kosong/model/thinking';
import { IWireService } from '#/wire/wire';

import {
  DEFAULT_MAX_MODEL_SWITCHES_PER_TURN,
  DEFAULT_MODEL_FAILOVER_TRIGGERS,
  MODEL_FAILOVER_SECTION,
  type ModelFailoverBinding,
  type ModelFailoverConfig,
  type ModelFailoverTrigger,
  resolveModelFailoverBinding,
  type ResolvedModelFailoverBinding,
} from './configSection';
import { MODEL_FAILOVER_FLAG_ID } from './flag';
import { IAgentModelFailoverService } from './modelFailover';
import { modelFailoverSwitch } from './modelFailoverOps';

export const modelFailoverActiveTurnIdKey = defineState<number | undefined>(
  'modelFailover.activeTurnId',
  () => undefined as number | undefined,
);
export const modelFailoverSwitchesInTurnKey = defineState<number>(
  'modelFailover.switchesInTurn',
  () => 0,
);
export const modelFailoverNextFallbackIndexKey = defineState<number>(
  'modelFailover.nextFallbackIndex',
  () => 0,
);
export const modelFailoverEmittedWarningsKey = defineState<Set<string>>(
  'modelFailover.emittedWarnings',
  () => new Set(),
);

export class AgentModelFailoverService extends Disposable implements IAgentModelFailoverService {
  declare readonly _serviceBrand: undefined;

  constructor(
    @IAgentLoopService private readonly loop: IAgentLoopService,
    @IAgentStepRetryService _stepRetry: IAgentStepRetryService,
    @IAgentLLMRequesterService private readonly llmRequester: IAgentLLMRequesterService,
    @IAgentProfileService private readonly profile: IAgentProfileService,
    @IAgentScopeContext private readonly scopeContext: IAgentScopeContext,
    @IAgentStateService private readonly states: IAgentStateService,
    @IConfigService private readonly config: IConfigService,
    @IFlagService private readonly flags: IFlagService,
    @IModelCatalog private readonly modelCatalog: IModelCatalog,
    @IEventBus private readonly eventBus: IEventBus,
    @IWireService private readonly wire: IWireService,
    @ILogService private readonly log: ILogService,
  ) {
    super();
    this.states.register(modelFailoverActiveTurnIdKey);
    this.states.register(modelFailoverSwitchesInTurnKey);
    this.states.register(modelFailoverNextFallbackIndexKey);
    this.states.register(modelFailoverEmittedWarningsKey);
    this._register(
      this.loop.registerLoopErrorHandler(
        {
          id: 'model-failover',
          match: (context) => this.match(context),
          handle: (context) => this.recover(context),
        },
        { after: 'step-retry' },
      ),
    );
    this._register(
      this.eventBus.subscribe('turn.started', (event) => {
        this.resetForTurn(event.turnId);
      }),
    );
    this.validateConfiguration();
  }

  private get activeTurnId(): number | undefined {
    return this.states.get(modelFailoverActiveTurnIdKey);
  }

  private set activeTurnId(value: number | undefined) {
    this.states.set(modelFailoverActiveTurnIdKey, value);
  }

  private get switchesInTurn(): number {
    return this.states.get(modelFailoverSwitchesInTurnKey);
  }

  private set switchesInTurn(value: number) {
    this.states.set(modelFailoverSwitchesInTurnKey, value);
  }

  private get nextFallbackIndex(): number {
    return this.states.get(modelFailoverNextFallbackIndexKey);
  }

  private set nextFallbackIndex(value: number) {
    this.states.set(modelFailoverNextFallbackIndexKey, value);
  }

  private get emittedWarnings(): Set<string> {
    return this.states.get(modelFailoverEmittedWarningsKey);
  }

  private match(context: LoopErrorContext): boolean {
    if (this.scopeContext.agentId === 'main') return false;
    if (!this.flags.enabled(MODEL_FAILOVER_FLAG_ID)) return false;
    const settings = this.settings();
    if (settings.fallbacks.length === 0) return false;
    const trigger = this.triggerFor(context.error);
    return trigger !== undefined && settings.on.includes(trigger);
  }

  private async recover(context: LoopErrorContext): Promise<boolean> {
    const driver = context.failedDriver;
    if (
      driver === undefined ||
      context.step === undefined ||
      context.signal.aborted ||
      currentStepAborted(context)
    ) {
      return false;
    }
    const trigger = this.triggerFor(context.error);
    if (trigger === undefined) return false;
    const settings = this.settings();
    if (!settings.on.includes(trigger)) return false;
    this.ensureTurn(context.turnId, settings.fallbacks);
    if (this.switchesInTurn >= settings.maxSwitchesPerTurn) return false;

    const current = this.profile.data();
    const fromModel = current.modelAlias;
    if (fromModel === undefined) return false;
    const fromResolved = this.tryResolveModel(fromModel, `active model "${fromModel}"`);
    if (fromResolved === undefined) return false;

    while (this.nextFallbackIndex < settings.fallbacks.length) {
      const fallbackIndex = this.nextFallbackIndex;
      this.nextFallbackIndex = fallbackIndex + 1;
      const target = this.resolveAndValidate(settings.fallbacks[fallbackIndex]!);
      if (target === undefined) return false;
      if (target.binding.model === fromModel) continue;

      try {
        await this.profile.setModelBinding(target.binding.model, target.binding.effort);
      } catch (error) {
        this.warn(
          'model-failover-binding-rejected',
          `Model failover cannot switch to "${target.binding.model}": ${error instanceof Error ? error.message : String(error)}`,
        );
        return false;
      }
      if (context.signal.aborted || currentStepAborted(context)) return false;

      const switched = this.profile.data();
      const toModel = switched.modelAlias;
      if (toModel === undefined) return false;
      this.llmRequester.invalidateTurnConfig(context.turnId);
      this.switchesInTurn += 1;
      this.log.info('Switching subagent to fallback model', {
        turnId: context.turnId,
        step: context.step,
        fromModel,
        toModel,
        fromProvider: fromResolved.providerName,
        toProvider: target.model.providerName,
        reason: trigger,
        switchIndex: this.switchesInTurn,
        maxSwitches: settings.maxSwitchesPerTurn,
      });
      this.wire.dispatch(
        modelFailoverSwitch({
          turnId: context.turnId,
          step: context.step,
          stepId: context.stepId,
          fromModel,
          toModel,
          fromProvider: fromResolved.providerName,
          toProvider: target.model.providerName,
          fromEffort: current.thinkingLevel,
          toEffort: switched.thinkingLevel,
          reason: trigger,
          switchIndex: this.switchesInTurn,
          maxSwitches: settings.maxSwitchesPerTurn,
        }),
      );
      context.retry(driver, { at: 'head' });
      return true;
    }
    return false;
  }

  private settings(): {
    readonly fallbacks: readonly ModelFailoverBinding[];
    readonly on: readonly ModelFailoverTrigger[];
    readonly maxSwitchesPerTurn: number;
  } {
    const configured = this.config.get<ModelFailoverConfig | undefined>(MODEL_FAILOVER_SECTION);
    return {
      fallbacks: configured?.fallbacks ?? [],
      on: configured?.on ?? DEFAULT_MODEL_FAILOVER_TRIGGERS,
      maxSwitchesPerTurn: configured?.maxSwitchesPerTurn ?? DEFAULT_MAX_MODEL_SWITCHES_PER_TURN,
    };
  }

  private triggerFor(error: unknown): ModelFailoverTrigger | undefined {
    const unwrapped = unwrapErrorCause(error);
    if (unwrapped instanceof APIEmptyResponseError && unwrapped.finishReason === 'filtered') {
      return undefined;
    }
    const classification = classifyApiError(unwrapped);
    if (classification.kind === 'quota_exhausted') {
      return 'quota_exhausted';
    }
    if (!isRetryableGenerateError(unwrapped)) return undefined;
    if (
      classification.kind === 'overloaded' ||
      classification.kind === 'rate_limit' ||
      classification.kind === '5xx_server' ||
      classification.kind === 'network' ||
      classification.kind === 'timeout' ||
      classification.kind === 'empty_response'
    ) {
      return 'retry_exhausted';
    }
    return classification.kind === '4xx_client' &&
      (classification.statusCode === 408 || classification.statusCode === 409)
      ? 'retry_exhausted'
      : undefined;
  }

  private resetForTurn(turnId: number): void {
    this.activeTurnId = turnId;
    this.switchesInTurn = 0;
    this.nextFallbackIndex = 0;
  }

  private ensureTurn(turnId: number, fallbacks: readonly ModelFailoverBinding[]): void {
    if (this.activeTurnId !== turnId) this.resetForTurn(turnId);
    if (this.switchesInTurn !== 0 || this.nextFallbackIndex !== 0) return;
    const currentModel = this.profile.data().modelAlias;
    if (currentModel === undefined) return;
    for (let index = 0; index < fallbacks.length; index += 1) {
      const resolved = resolveModelFailoverBinding(fallbacks[index]!, this.config);
      if (resolved?.model === currentModel) this.nextFallbackIndex = index + 1;
    }
  }

  private validateConfiguration(): void {
    if (this.scopeContext.agentId !== 'main') return;
    if (!this.flags.enabled(MODEL_FAILOVER_FLAG_ID)) return;
    for (const binding of this.settings().fallbacks) {
      this.resolveAndValidate(binding);
    }
  }

  private resolveAndValidate(
    binding: ModelFailoverBinding,
  ): { readonly binding: ResolvedModelFailoverBinding; readonly model: Model } | undefined {
    const resolved = resolveModelFailoverBinding(binding, this.config);
    if (resolved === undefined) {
      this.warn(
        'model-failover-unresolved-binding',
        `Model failover fallback "${binding.model}" does not resolve to a configured model alias.`,
      );
      return undefined;
    }
    const model = this.tryResolveModel(resolved.model, `fallback "${binding.model}"`);
    if (model === undefined) return undefined;
    const requestedEffort = normalizeRequestedThinkingEffort(resolved.effort);
    const supportedEfforts = (model.supportEfforts ?? [])
      .map((effort) => effort.trim().toLowerCase())
      .filter((effort) => effort.length > 0);
    if (
      requestedEffort !== undefined &&
      requestedEffort !== 'off' &&
      requestedEffort !== 'on' &&
      supportedEfforts.length > 0 &&
      !supportedEfforts.includes(requestedEffort)
    ) {
      this.warn(
        'model-failover-invalid-effort',
        `Model failover fallback "${binding.model}" requests effort "${resolved.effort}" but model "${resolved.model}" lists: ${supportedEfforts.join(', ')}.`,
      );
      return undefined;
    }
    try {
      this.profile.validateModelBinding(resolved.model, resolved.effort);
    } catch (error) {
      this.warn(
        'model-failover-invalid-effort',
        `Model failover fallback "${binding.model}" has an invalid effort for "${resolved.model}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
    return { binding: resolved, model };
  }

  private tryResolveModel(alias: string, label: string): Model | undefined {
    try {
      return this.modelCatalog.get(alias);
    } catch (error) {
      this.warn(
        'model-failover-invalid-model',
        `Model failover ${label} resolved to invalid alias "${alias}": ${error instanceof Error ? error.message : String(error)}`,
      );
      return undefined;
    }
  }

  private warn(code: string, message: string): void {
    const key = `${code}\u0000${message}`;
    if (this.emittedWarnings.has(key)) return;
    this.emittedWarnings.add(key);
    this.log.warn(message, { code });
    this.eventBus.publish({ type: 'warning', code, message });
  }
}

function currentStepAborted(context: LoopErrorContext): boolean {
  return context.currentStep?.signal.aborted === true;
}

registerScopedService(
  LifecycleScope.Agent,
  IAgentModelFailoverService,
  AgentModelFailoverService,
  ScopeActivation.OnScopeCreated,
  'modelFailover',
);
