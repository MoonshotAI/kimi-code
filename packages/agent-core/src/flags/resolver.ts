import { parseBooleanEnv } from '#/config/resolve';

import { FLAG_DEFINITIONS, type FlagId } from './registry';
import type { FlagDefinitionInput } from './types';

/** Master switch: when truthy, forces every flag on (highest priority). */
export const MASTER_ENV = 'KIMI_CODE_EXPERIMENTAL_FLAG';

/** Shared prefix for per-feature variables. */
export const EXPERIMENTAL_PREFIX = 'KIMI_CODE_EXPERIMENTAL_';

/**
 * Conventional env-name generator: flag id → recommended env variable name. Only used when
 * authoring a new flag (to fill `env`) and for an optional consistency test; NOT used during
 * resolution.
 */
export function flagEnvKey(id: string): string {
  return `${EXPERIMENTAL_PREFIX}${id.toUpperCase().replaceAll('-', '_')}`;
}

/**
 * Pure, synchronous flag resolver. State comes entirely from (env, registry) and nothing is
 * cached: env is read live on every call, so a single shared instance always reflects the current
 * process env. Defaults to process.env + FLAG_DEFINITIONS; tests can inject a custom env / defs.
 *
 * Precedence (highest wins):
 *   L1 master switch KIMI_CODE_EXPERIMENTAL_FLAG → every flag is on
 *   L2 per-feature def.env (parseBooleanEnv, may force on or off)
 *   L3 registry default
 */
export class FlagResolver {
  private readonly env: Readonly<Record<string, string | undefined>>;
  private readonly byId: ReadonlyMap<string, FlagDefinitionInput>;

  constructor(
    env: Readonly<Record<string, string | undefined>> = process.env,
    definitions: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS,
  ) {
    this.env = env;
    this.byId = new Map(definitions.map((def) => [def.id, def]));
  }

  enabled(id: FlagId): boolean {
    const def = this.byId.get(id);
    if (def === undefined) return false;
    if (parseBooleanEnv(this.env[MASTER_ENV]) === true) return true; // L1 master switch
    const override = parseBooleanEnv(this.env[def.env]); // L2 per-feature
    if (override !== undefined) return override;
    return def.default; // L3 default
  }
}

export function createFlagResolver(
  env?: Readonly<Record<string, string | undefined>>,
  definitions?: readonly FlagDefinitionInput[],
): FlagResolver {
  return new FlagResolver(env, definitions);
}

/**
 * Process-global flag accessor. Flags are env-driven and process-global, so a single shared
 * instance (reading live process.env) is the canonical way to consult them — import this directly
 * rather than constructing or injecting a resolver.
 */
export const flags = new FlagResolver();
