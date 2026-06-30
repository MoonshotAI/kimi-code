/**
 * `flag` domain (L3) — `IFlagService` implementation.
 *
 * Resolves experimental flags from the environment (read through `bootstrap`),
 * the `[experimental]` config section, and defaults; reads flag definitions
 * from `flagRegistry`, and reads/watches config through `config`. Bound at Core
 * scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { parseBooleanEnv } from '#/_base/utils';
import { IBootstrapService } from '#/bootstrap/bootstrapContract';
import { IConfigRegistry, IConfigService } from '#/config/config';

import {
  type ExperimentalFeatureState,
  type ExperimentalFlagConfig,
  type ExperimentalFlagMap,
  type ExperimentalFlagSource,
  EXPERIMENTAL_SECTION,
  ExperimentalConfigSchema,
  experimentalFromToml,
  experimentalToToml,
  IFlagService,
} from './flag';
import { type FlagDefinitionInput, type FlagId, IFlagRegistry } from './flagRegistry';

export const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

export class FlagService extends Disposable implements IFlagService {
  declare readonly _serviceBrand: undefined;
  readonly registry: IFlagRegistry;
  private configOverrides: ExperimentalFlagConfig;

  constructor(
    @IBootstrapService private readonly bootstrap: IBootstrapService,
    @IConfigRegistry private readonly configRegistry: IConfigRegistry,
    @IConfigService private readonly config: IConfigService,
    @IFlagRegistry registry: IFlagRegistry,
  ) {
    super();
    this.registry = registry;
    configRegistry.registerSection(EXPERIMENTAL_SECTION, ExperimentalConfigSchema, {
      fromToml: experimentalFromToml,
      toToml: experimentalToToml,
    });
    this.configOverrides = this.readConfig();
    this._register(
      this.config.onDidChange((e) => {
        if (e.domain === EXPERIMENTAL_SECTION) {
          this.configOverrides = this.readConfig();
        }
      }),
    );
  }

  private readConfig(): ExperimentalFlagConfig {
    return this.config.get<ExperimentalFlagConfig>(EXPERIMENTAL_SECTION) ?? {};
  }

  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void {
    this.configOverrides = overrides ?? {};
  }

  enabled(id: FlagId): boolean {
    return this.explain(id)?.enabled ?? false;
  }

  explain(id: FlagId): ExperimentalFeatureState | undefined {
    const def = this.registry.get(id);
    if (def === undefined) return undefined;
    const configValue = this.configOverrides[def.id];
    if (parseBooleanEnv(this.bootstrap.getEnv(MASTER_ENV)) === true) {
      return this.state(def, true, 'master-env', configValue);
    }
    const override = parseBooleanEnv(this.bootstrap.getEnv(def.env));
    if (override !== undefined) return this.state(def, override, 'env', configValue);
    if (configValue !== undefined) return this.state(def, configValue, 'config', configValue);
    return this.state(def, def.default, 'default', undefined);
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

  explainAll(): readonly ExperimentalFeatureState[] {
    return this.registry
      .list()
      .map((def) => this.explain(def.id))
      .filter((state): state is ExperimentalFeatureState => state !== undefined);
  }

  private state(
    def: FlagDefinitionInput,
    enabled: boolean,
    source: ExperimentalFlagSource,
    configValue: boolean | undefined,
  ): ExperimentalFeatureState {
    return {
      id: def.id,
      title: def.title,
      description: def.description,
      surface: def.surface,
      env: def.env,
      defaultEnabled: def.default,
      enabled,
      source,
      configValue,
    };
  }
}

registerScopedService(
  LifecycleScope.Core,
  IFlagService,
  FlagService,
  InstantiationType.Delayed,
  'flag',
);
