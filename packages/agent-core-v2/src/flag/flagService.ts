/**
 * `flag` domain (L3) — `IFlagService` implementation.
 *
 * Resolves experimental flags from environment, the `[experimental]` config
 * section, and defaults; reads and watches config through `config`. Bound at
 * Core scope.
 */

import { Disposable } from '#/_base/di/lifecycle';
import { InstantiationType } from '#/_base/di/extensions';
import { LifecycleScope, registerScopedService } from '#/_base/di/scope';
import { IConfigRegistry, IConfigService } from '#/config';

import {
  type ExperimentalFeatureState,
  type ExperimentalFlagConfig,
  type ExperimentalFlagMap,
  type ExperimentalFlagSource,
  IFlagService,
} from './flag';
import {
  type FlagDefinitionInput,
  type FlagId,
  FlagRegistry,
} from './registry';
import { ExperimentalConfigSchema } from '#/config/schema';

export const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

export const EXPERIMENTAL_SECTION = 'experimental';

const TRUE_BOOLEAN_ENV_VALUES = new Set(['1', 'true', 'yes', 'on']);
const FALSE_BOOLEAN_ENV_VALUES = new Set(['0', 'false', 'no', 'off']);

function parseBooleanEnv(value: string | undefined): boolean | undefined {
  const normalized = value?.trim().toLowerCase();
  if (normalized === undefined || normalized.length === 0) return undefined;
  if (TRUE_BOOLEAN_ENV_VALUES.has(normalized)) return true;
  if (FALSE_BOOLEAN_ENV_VALUES.has(normalized)) return false;
  return undefined;
}

export class FlagService extends Disposable implements IFlagService {
  declare readonly _serviceBrand: undefined;
  readonly registry: FlagRegistry;
  private readonly env: Readonly<Record<string, string | undefined>>;
  private configOverrides: ExperimentalFlagConfig;

  constructor(
    env: Readonly<Record<string, string | undefined>> = process.env,
    registry: FlagRegistry = new FlagRegistry(),
    @IConfigRegistry private readonly configRegistry: IConfigRegistry,
    @IConfigService private readonly config: IConfigService,
  ) {
    super();
    this.env = env;
    this.registry = registry;
    configRegistry.registerSection(EXPERIMENTAL_SECTION, ExperimentalConfigSchema);
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
    const configValue = this.configOverrides[def.id as FlagId];
    if (parseBooleanEnv(this.env[MASTER_ENV]) === true) {
      return this.state(def, true, 'master-env', configValue);
    }
    const override = parseBooleanEnv(this.env[def.env]);
    if (override !== undefined) return this.state(def, override, 'env', configValue);
    if (configValue !== undefined) return this.state(def, configValue, 'config', configValue);
    return this.state(def, def.default, 'default', undefined);
  }

  snapshot(): ExperimentalFlagMap {
    return Object.fromEntries(
      this.registry.list().map((def) => [def.id, this.enabled(def.id as FlagId)]),
    );
  }

  enabledIds(): readonly FlagId[] {
    return this.registry
      .list()
      .filter((def) => this.enabled(def.id as FlagId))
      .map((def) => def.id as FlagId);
  }

  explainAll(): readonly ExperimentalFeatureState[] {
    return this.registry
      .list()
      .map((def) => this.explain(def.id as FlagId))
      .filter((state): state is ExperimentalFeatureState => state !== undefined);
  }

  private state(
    def: FlagDefinitionInput,
    enabled: boolean,
    source: ExperimentalFlagSource,
    configValue: boolean | undefined,
  ): ExperimentalFeatureState {
    return {
      id: def.id as FlagId,
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
