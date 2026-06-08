import { parseBooleanEnv } from '#/config/resolve';

import { FLAG_DEFINITIONS, type FlagId } from './registry';
import type {
  ExperimentalFeatureState,
  ExperimentalFlagConfig,
  FlagDefinitionInput,
} from './types';

/** Master switch: when truthy, forces every flag on (highest priority). */
export const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

/**
 * Pure, synchronous flag resolver. State comes entirely from (env, registry) and nothing is
 * cached: env is read live on every call, so a single shared instance always reflects the current
 * process env. Defaults to process.env + FLAG_DEFINITIONS; tests can inject a custom env / defs.
 *
 * Precedence (highest wins):
 *   L1 master switch KIMI_CODE_EXPERIMENTAL_FLAG → every flag is on
 *   L2 per-feature def.env (parseBooleanEnv, may force on or off)
 *   L3 config.toml [experimental] per-feature override
 *   L4 registry default
 */
export class FlagResolver {
  private readonly byId: ReadonlyMap<string, FlagDefinitionInput>;

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly definitions: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS,
    private configOverrides: ExperimentalFlagConfig = {},
  ) {
    this.byId = new Map(definitions.map((def) => [def.id, def]));
  }

  setConfigOverrides(overrides: ExperimentalFlagConfig | undefined): void {
    this.configOverrides = overrides ?? {};
  }

  enabled(id: FlagId): boolean {
    return this.explain(id)?.enabled ?? false;
  }

  explain(id: FlagId): ExperimentalFeatureState | undefined {
    const def = this.byId.get(id);
    if (def === undefined) return undefined;
    const configValue = this.configOverrides[def.id as FlagId];
    if (parseBooleanEnv(this.env[MASTER_ENV]) === true) {
      return this.state(def, true, 'master-env', configValue);
    }
    const override = parseBooleanEnv(this.env[def.env]); // L2 per-feature
    if (override !== undefined) return this.state(def, override, 'env', configValue);
    if (configValue !== undefined) return this.state(def, configValue, 'config', configValue);
    return this.state(def, def.default, 'default', undefined);
  }

  snapshot(): Record<string, boolean> {
    return Object.fromEntries(
      this.definitions.map((def) => [def.id, this.enabled(def.id as FlagId)]),
    );
  }

  enabledIds(): readonly FlagId[] {
    return this.definitions
      .filter((def) => this.enabled(def.id as FlagId))
      .map((def) => def.id as FlagId);
  }

  explainAll(): readonly ExperimentalFeatureState[] {
    return this.definitions
      .map((def) => this.explain(def.id as FlagId))
      .filter((state): state is ExperimentalFeatureState => state !== undefined);
  }

  private state(
    def: FlagDefinitionInput,
    enabled: boolean,
    source: ExperimentalFeatureState['source'],
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

/**
 * Compatibility accessor for callers that only need process-global env behavior.
 * Runtime code that belongs to a KimiCore/Session/Agent should use the scoped
 * resolver on that owner instead.
 */
export const flags = new FlagResolver();
