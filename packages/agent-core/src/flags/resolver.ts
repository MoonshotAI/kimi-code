import { parseBooleanEnv } from '#/config/resolve';

import { FLAG_DEFINITIONS, type FlagId } from './registry';
import type { FlagDefinitionInput } from './types';

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
 *   L3 registry default
 */
export class FlagResolver {
  private readonly byId: ReadonlyMap<string, FlagDefinitionInput>;

  constructor(
    private readonly env: Readonly<Record<string, string | undefined>> = process.env,
    private readonly definitions: readonly FlagDefinitionInput[] = FLAG_DEFINITIONS,
  ) {
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
}

/**
 * Process-global flag accessor. Flags are env-driven and process-global, so a single shared
 * instance (reading live process.env) is the canonical way to consult them — import this directly
 * rather than constructing or injecting a resolver.
 */
export const flags = new FlagResolver();
