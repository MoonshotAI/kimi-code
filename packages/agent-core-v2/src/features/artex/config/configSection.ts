import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  type IConfigService,
  stripEnvBoundFields,
} from '#/app/config/config';

import { MAX_AGENT_SWARM_SUBAGENTS } from '#/features/swarm/tools/agent-swarm/agent-swarm';
import { DEFAULT_SWARM_TIMEOUT_MS } from '#/features/swarm/configSection';

export const ARTEX_SECTION = 'artex';

export const ARTEX_DEFAULT_TARGET_CONCURRENCY = 120;
export const ARTEX_DEFAULT_PLANNER_DEBOUNCE_MS = 800;
export const ARTEX_DEFAULT_CLAIM_SWEEP_INTERVAL_MS = 15_000;

export const ArtexConfigSchema = z.object({
  targetConcurrency: z.number().int().min(1).max(MAX_AGENT_SWARM_SUBAGENTS).optional(),
  swarmTimeoutMs: z.number().int().min(0).optional(),
  plannerDebounceMs: z.number().int().min(0).optional(),
  claimSweepIntervalMs: z.number().int().min(0).optional(),
});

export type ArtexConfig = z.infer<typeof ArtexConfigSchema>;

export const ARTEX_TARGET_CONCURRENCY_ENV = 'KIMI_CODE_ARTEX_TARGET_CONCURRENCY';
export const ARTEX_SWARM_TIMEOUT_ENV = 'KIMI_CODE_ARTEX_SWARM_TIMEOUT_MS';
export const ARTEX_PLANNER_DEBOUNCE_ENV = 'KIMI_CODE_ARTEX_PLANNER_DEBOUNCE_MS';
export const ARTEX_CLAIM_SWEEP_ENV = 'KIMI_CODE_ARTEX_CLAIM_SWEEP_INTERVAL_MS';

function parsePositiveInt(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function parseNonNegativeInt(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

export const artexEnvBindings: EnvBindings<ArtexConfig> = envBindings(ArtexConfigSchema, {
  targetConcurrency: { env: ARTEX_TARGET_CONCURRENCY_ENV, parse: parsePositiveInt },
  swarmTimeoutMs: { env: ARTEX_SWARM_TIMEOUT_ENV, parse: parseNonNegativeInt },
  plannerDebounceMs: { env: ARTEX_PLANNER_DEBOUNCE_ENV, parse: parseNonNegativeInt },
  claimSweepIntervalMs: { env: ARTEX_CLAIM_SWEEP_ENV, parse: parsePositiveInt },
});

export const stripArtexEnv = stripEnvBoundFields(artexEnvBindings);

export const ARTEX_CONFIG_DEFAULTS: ArtexConfig = {
  targetConcurrency: ARTEX_DEFAULT_TARGET_CONCURRENCY,
  plannerDebounceMs: ARTEX_DEFAULT_PLANNER_DEBOUNCE_MS,
  claimSweepIntervalMs: ARTEX_DEFAULT_CLAIM_SWEEP_INTERVAL_MS,
};

function artexConfig(config: IConfigService): ArtexConfig | undefined {
  return config.get<ArtexConfig | undefined>(ARTEX_SECTION);
}

export function resolveArtexTargetConcurrency(config: IConfigService): number {
  const value = artexConfig(config)?.targetConcurrency ?? ARTEX_DEFAULT_TARGET_CONCURRENCY;
  return Math.max(1, Math.min(value, MAX_AGENT_SWARM_SUBAGENTS));
}

export function resolveArtexSwarmTimeoutMs(config: IConfigService): number {
  return artexConfig(config)?.swarmTimeoutMs ?? DEFAULT_SWARM_TIMEOUT_MS;
}

export function resolveArtexPlannerDebounceMs(config: IConfigService): number {
  return artexConfig(config)?.plannerDebounceMs ?? ARTEX_DEFAULT_PLANNER_DEBOUNCE_MS;
}

export function resolveArtexClaimSweepIntervalMs(config: IConfigService): number {
  const value = artexConfig(config)?.claimSweepIntervalMs ?? ARTEX_DEFAULT_CLAIM_SWEEP_INTERVAL_MS;
  return Math.max(1, value);
}
