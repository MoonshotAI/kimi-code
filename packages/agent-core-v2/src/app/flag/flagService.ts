import { Disposable } from '#/_base/di/lifecycle';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { parseBooleanEnv } from '#/_base/utils/env';
import { IBootstrapService, resolveExperimentalSurface } from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';

import {
  BETA_MASTER_CONFIG_KEY,
  type BetaMasterSwitchState,
  type ExperimentalFeatureState,
  type ExperimentalFlagConfig,
  type ExperimentalFlagMap,
  type ExperimentalFlagSource,
  EXPERIMENTAL_SECTION,
  IFlagService,
} from './flag';
import {
  type ExperimentalStage,
  type ExperimentalSurface,
  type FlagDefinitionInput,
  type FlagId,
  IFlagRegistry,
} from './flagRegistry';

export const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

export class FlagService extends Disposable implements IFlagService {
  declare readonly _serviceBrand: undefined;
  readonly registry: IFlagRegistry;
  private configOverrides: ExperimentalFlagConfig;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigService private readonly config: IConfigService,
    @IFlagRegistry registry: IFlagRegistry,
  ) {
    super();
    this.registry = registry;
    this.configOverrides = this.readConfig();
    this._register(
      this.config.onDidChangeConfiguration((e) => {
        if (e.domain === EXPERIMENTAL_SECTION) {
          this.configOverrides = this.readConfig();
        }
      }),
    );
  }

  private get surface(): ExperimentalSurface {
    return resolveExperimentalSurface(this.bootstrap.clientIdentity, this.bootstrap.args.surface);
  }

  private readConfig(): ExperimentalFlagConfig {
    return this.config.get<ExperimentalFlagConfig>(EXPERIMENTAL_SECTION) ?? {};
  }

  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void {
    this.configOverrides = overrides ?? {};
  }

  betaState(): BetaMasterSwitchState {
    const configValue = this.configOverrides[BETA_MASTER_CONFIG_KEY];
    if (parseBooleanEnv(this.bootstrap.getEnv(MASTER_ENV)) === true) {
      return { enabled: true, source: 'env', env: MASTER_ENV, configValue };
    }
    if (configValue !== undefined) {
      return { enabled: configValue, source: 'config', env: MASTER_ENV, configValue };
    }
    return { enabled: false, source: 'default', env: MASTER_ENV, configValue: undefined };
  }

  enabled(id: FlagId): boolean {
    const def = this.registry.get(id);
    if (def === undefined) return false;
    return this.evaluate(def, def.stages[this.surface] ?? 'experimental').enabled;
  }

  explain(id: FlagId): ExperimentalFeatureState | undefined {
    const def = this.registry.get(id);
    if (def === undefined) return undefined;
    const stage = def.stages[this.surface] ?? 'experimental';
    const resolved = this.evaluate(def, stage);
    return this.state(def, stage, resolved.enabled, resolved.source, resolved.configValue);
  }

  snapshot(): ExperimentalFlagMap {
    return Object.fromEntries(
      this.registry.list().map((def) => [def.id, this.enabled(def.id)]),
    );
  }

  enabledIds(): readonly FlagId[] {
    return this.registry
      .list()
      .filter((def) => this.enabled(def.id))
      .map((def) => def.id);
  }

  exposedIds(): readonly FlagId[] {
    return this.registry
      .list()
      .filter((def) => def.stages[this.surface] !== 'ga')
      .filter((def) => this.enabled(def.id))
      .filter((def) => def.isExposed?.(this) ?? true)
      .map((def) => def.id);
  }

  explainAll(): readonly ExperimentalFeatureState[] {
    return this.registry
      .list()
      .filter((def) => def.stages[this.surface] !== undefined)
      .map((def) => this.explain(def.id))
      .filter((state): state is ExperimentalFeatureState => state !== undefined);
  }

  private evaluate(
    def: FlagDefinitionInput,
    stage: ExperimentalStage,
  ): {
    readonly enabled: boolean;
    readonly source: ExperimentalFlagSource;
    readonly configValue: boolean | undefined;
  } {
    const configValue = this.configOverrides[def.id];
    const override = parseBooleanEnv(this.bootstrap.getEnv(def.env));
    if (override !== undefined) {
      return { enabled: override, source: 'env', configValue };
    }
    if (stage === 'ga') {
      return { enabled: true, source: 'default', configValue };
    }
    if (stage === 'beta') {
      const beta = this.betaState();
      if (beta.enabled) {
        return {
          enabled: true,
          source: beta.source === 'env' ? 'master-env' : 'beta-config',
          configValue,
        };
      }
    }
    if (configValue !== undefined) {
      return { enabled: configValue, source: 'config', configValue };
    }
    return { enabled: false, source: 'default', configValue: undefined };
  }

  private state(
    def: FlagDefinitionInput,
    stage: ExperimentalStage,
    enabled: boolean,
    source: ExperimentalFlagSource,
    configValue: boolean | undefined,
  ): ExperimentalFeatureState {
    const active = def.isExposed !== undefined ? def.isExposed(this) && enabled : enabled;
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      stage,
      effectTiming: def.effectTiming ?? 'immediate',
      env: def.env,
      enabled,
      active,
      source,
      configValue,
    };
  }
}

registerScopedService(
  LifecycleScope.App,
  IFlagService,
  FlagService,
  ScopeActivation.OnScopeCreated,
  'flag',
);
