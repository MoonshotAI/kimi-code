import { Disposable } from '#/_base/di/lifecycle';
import { Emitter, type Event } from '#/_base/event';
import { LifecycleScope } from '#/app/scopes';
import { ScopeActivation, registerScopedService } from '#/_base/di/scope';
import { parseBooleanEnv } from '#/_base/utils/env';
import {
  IBootstrapService,
  resolveExperimentalProfile,
  resolveExperimentalSurface,
} from '#/app/bootstrap/bootstrap';
import { IConfigService } from '#/app/config/config';

import {
  BETA_MASTER_CONFIG_KEY,
  type BetaMasterSwitchState,
  type ExperimentalConfig,
  type ExperimentalFeatureState,
  type ExperimentalFlagConfig,
  type ExperimentalFlagMap,
  type ExperimentalFlagSource,
  EXPERIMENTAL_SECTION,
  IFlagService,
} from './flag';
import {
  type ExperimentalProfile,
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
  private readonly _onDidChangeFlags = this._register(new Emitter<void>());
  readonly onDidChangeFlags: Event<void> = this._onDidChangeFlags.event;
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
          this._onDidChangeFlags.fire();
        }
      }),
    );
  }

  private get surface(): ExperimentalSurface {
    return resolveExperimentalSurface(this.bootstrap.clientIdentity, this.bootstrap.args.surface);
  }

  get profile(): ExperimentalProfile {
    return resolveExperimentalProfile(
      this.bootstrap.clientIdentity,
      this.surface,
      this.bootstrap.args.experimentalProfile,
    );
  }

  private readConfig(): ExperimentalFlagConfig {
    const section = this.config.get<ExperimentalConfig>(EXPERIMENTAL_SECTION);
    return section?.[this.profile] ?? {};
  }

  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void {
    this.configOverrides = overrides ?? {};
    this._onDidChangeFlags.fire();
  }

  betaState(): BetaMasterSwitchState {
    const profile = this.profile;
    const configValue = this.configOverrides[BETA_MASTER_CONFIG_KEY];
    if (parseBooleanEnv(this.bootstrap.getEnv(MASTER_ENV)) === true) {
      return { profile, enabled: true, source: 'env', env: MASTER_ENV, configValue };
    }
    if (configValue !== undefined) {
      return { profile, enabled: configValue, source: 'config', env: MASTER_ENV, configValue };
    }
    return { profile, enabled: false, source: 'default', env: MASTER_ENV, configValue: undefined };
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
    return this.state(def, stage, resolved.enabled, resolved.source, resolved.env, resolved.configValue);
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
      .filter((def) => {
        const stage = def.stages[this.surface];
        return stage !== undefined && stage !== 'ga';
      })
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
    readonly env: string;
    readonly configValue: boolean | undefined;
  } {
    const configValue = this.configOverrides[def.id];
    const envOverride = parseBooleanEnv(this.bootstrap.getEnv(def.env));
    if (envOverride !== undefined) {
      return { enabled: envOverride, source: 'env', env: def.env, configValue };
    }
    if (stage === 'ga') {
      return { enabled: true, source: 'default', env: def.env, configValue };
    }
    if (stage === 'beta') {
      const beta = this.betaState();
      if (beta.enabled) {
        return {
          enabled: true,
          source: beta.source === 'env' ? 'master-env' : 'beta-config',
          env: def.env,
          configValue,
        };
      }
    }
    if (configValue !== undefined) {
      return { enabled: configValue, source: 'config', env: def.env, configValue };
    }
    return { enabled: false, source: 'default', env: def.env, configValue: undefined };
  }

  private state(
    def: FlagDefinitionInput,
    stage: ExperimentalStage,
    enabled: boolean,
    source: ExperimentalFlagSource,
    env: string,
    configValue: boolean | undefined,
  ): ExperimentalFeatureState {
    const active = def.isExposed !== undefined ? def.isExposed(this) && enabled : enabled;
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      stage,
      effectTiming: def.effectTiming ?? 'immediate',
      env,
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
