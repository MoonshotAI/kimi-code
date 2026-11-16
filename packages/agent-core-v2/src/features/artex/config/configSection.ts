import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  type IConfigService,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

import { MAX_AGENT_SWARM_SUBAGENTS } from '#/features/swarm/tools/agent-swarm/agent-swarm';
import { DEFAULT_SWARM_TIMEOUT_MS } from '#/features/swarm/configSection';

export const ARTEX_SECTION = 'artex';

export const ARTEX_DEFAULT_TARGET_CONCURRENCY = 120;
export const ARTEX_DEFAULT_PLANNER_DEBOUNCE_MS = 800;
export const ARTEX_DEFAULT_CLAIM_SWEEP_INTERVAL_MS = 15_000;
export const ARTEX_DEFAULT_BATCH_INITIAL_LAUNCH_LIMIT = 5;
export const ARTEX_DEFAULT_BATCH_LAUNCH_INTERVAL_MS = 700;
export const ARTEX_DEFAULT_BATCH_RATE_LIMIT_RECOVERY_MS = 3 * 60 * 1000;
export const ARTEX_DEFAULT_BATCH_RATE_LIMIT_RETRY_BASE_MS = 3_000;

export const ARTEX_NOISE_PROFILE_NAMES = ['off', 'quiet', 'balanced', 'aggressive'] as const;
export type ArtexNoiseProfileName = (typeof ARTEX_NOISE_PROFILE_NAMES)[number];

export const ArtexConfigSchema = z.object({
  targetConcurrency: z.number().int().min(1).max(MAX_AGENT_SWARM_SUBAGENTS).optional(),
  swarmTimeoutMs: z.number().int().min(0).optional(),
  plannerDebounceMs: z.number().int().min(0).optional(),
  claimSweepIntervalMs: z.number().int().min(0).optional(),
  noiseProfile: z.enum(ARTEX_NOISE_PROFILE_NAMES).optional(),
  noiseRps: z.number().min(0).optional(),
  noiseMaxPerHost: z.number().int().min(1).optional(),
  batchInitialLaunchLimit: z.number().int().min(0).optional(),
  batchLaunchIntervalMs: z.number().int().min(0).optional(),
  batchRateLimitRecoveryMs: z.number().int().min(1).optional(),
  batchRateLimitRetryBaseMs: z.number().int().min(1).optional(),
});

export type ArtexConfig = z.infer<typeof ArtexConfigSchema>;

export const ARTEX_TARGET_CONCURRENCY_ENV = 'KIMI_CODE_ARTEX_TARGET_CONCURRENCY';
export const ARTEX_SWARM_TIMEOUT_ENV = 'KIMI_CODE_ARTEX_SWARM_TIMEOUT_MS';
export const ARTEX_PLANNER_DEBOUNCE_ENV = 'KIMI_CODE_ARTEX_PLANNER_DEBOUNCE_MS';
export const ARTEX_CLAIM_SWEEP_ENV = 'KIMI_CODE_ARTEX_CLAIM_SWEEP_INTERVAL_MS';
export const ARTEX_NOISE_PROFILE_ENV = 'KIMI_CODE_ARTEX_NOISE_PROFILE';
export const ARTEX_NOISE_RPS_ENV = 'KIMI_CODE_ARTEX_NOISE_RPS';
export const ARTEX_NOISE_MAX_PER_HOST_ENV = 'KIMI_CODE_ARTEX_NOISE_MAX_PER_HOST';
export const ARTEX_BATCH_INITIAL_LAUNCH_LIMIT_ENV = 'KIMI_CODE_ARTEX_BATCH_INITIAL_LAUNCH_LIMIT';
export const ARTEX_BATCH_LAUNCH_INTERVAL_MS_ENV = 'KIMI_CODE_ARTEX_BATCH_LAUNCH_INTERVAL_MS';
export const ARTEX_BATCH_RATE_LIMIT_RECOVERY_MS_ENV = 'KIMI_CODE_ARTEX_BATCH_RATE_LIMIT_RECOVERY_MS';
export const ARTEX_BATCH_RATE_LIMIT_RETRY_BASE_MS_ENV = 'KIMI_CODE_ARTEX_BATCH_RATE_LIMIT_RETRY_BASE_MS';

export const ARTEX_DEFAULT_NOISE_PROFILE: ArtexNoiseProfileName = 'off';
export const ARTEX_DEFAULT_NOISE_RPS = 5;
export const ARTEX_DEFAULT_NOISE_MAX_PER_HOST = 5;

function parsePositiveInt(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

function parseNonNegativeInt(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseNonNegativeNumber(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function parseNoiseProfileName(raw: string): ArtexNoiseProfileName | undefined {
  const value = raw.trim().toLowerCase();
  return (ARTEX_NOISE_PROFILE_NAMES as readonly string[]).includes(value)
    ? (value as ArtexNoiseProfileName)
    : undefined;
}

export const artexEnvBindings: EnvBindings<ArtexConfig> = envBindings(ArtexConfigSchema, {
  targetConcurrency: { env: ARTEX_TARGET_CONCURRENCY_ENV, parse: parsePositiveInt },
  swarmTimeoutMs: { env: ARTEX_SWARM_TIMEOUT_ENV, parse: parseNonNegativeInt },
  plannerDebounceMs: { env: ARTEX_PLANNER_DEBOUNCE_ENV, parse: parseNonNegativeInt },
  claimSweepIntervalMs: { env: ARTEX_CLAIM_SWEEP_ENV, parse: parsePositiveInt },
  noiseProfile: { env: ARTEX_NOISE_PROFILE_ENV, parse: parseNoiseProfileName },
  noiseRps: { env: ARTEX_NOISE_RPS_ENV, parse: parseNonNegativeNumber },
  noiseMaxPerHost: { env: ARTEX_NOISE_MAX_PER_HOST_ENV, parse: parsePositiveInt },
  batchInitialLaunchLimit: { env: ARTEX_BATCH_INITIAL_LAUNCH_LIMIT_ENV, parse: parseNonNegativeInt },
  batchLaunchIntervalMs: { env: ARTEX_BATCH_LAUNCH_INTERVAL_MS_ENV, parse: parseNonNegativeInt },
  batchRateLimitRecoveryMs: { env: ARTEX_BATCH_RATE_LIMIT_RECOVERY_MS_ENV, parse: parsePositiveInt },
  batchRateLimitRetryBaseMs: { env: ARTEX_BATCH_RATE_LIMIT_RETRY_BASE_MS_ENV, parse: parsePositiveInt },
});

export const stripArtexEnv = stripEnvBoundFields(artexEnvBindings);

export const ARTEX_CONFIG_DEFAULTS: ArtexConfig = {
  targetConcurrency: ARTEX_DEFAULT_TARGET_CONCURRENCY,
  plannerDebounceMs: ARTEX_DEFAULT_PLANNER_DEBOUNCE_MS,
  claimSweepIntervalMs: ARTEX_DEFAULT_CLAIM_SWEEP_INTERVAL_MS,
  batchInitialLaunchLimit: ARTEX_DEFAULT_BATCH_INITIAL_LAUNCH_LIMIT,
  batchLaunchIntervalMs: ARTEX_DEFAULT_BATCH_LAUNCH_INTERVAL_MS,
  batchRateLimitRecoveryMs: ARTEX_DEFAULT_BATCH_RATE_LIMIT_RECOVERY_MS,
  batchRateLimitRetryBaseMs: ARTEX_DEFAULT_BATCH_RATE_LIMIT_RETRY_BASE_MS,
};

registerConfigSection(ARTEX_SECTION, ArtexConfigSchema, {
  defaultValue: ARTEX_CONFIG_DEFAULTS,
  env: artexEnvBindings,
  stripEnv: stripArtexEnv,
});

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

export function resolveArtexNoiseProfile(config: IConfigService): {
  readonly name: ArtexNoiseProfileName;
  readonly rps: number;
  readonly maxPerHost: number;
} {
  const section = artexConfig(config);
  return {
    name: section?.noiseProfile ?? ARTEX_DEFAULT_NOISE_PROFILE,
    rps: section?.noiseRps ?? ARTEX_DEFAULT_NOISE_RPS,
    maxPerHost: section?.noiseMaxPerHost ?? ARTEX_DEFAULT_NOISE_MAX_PER_HOST,
  };
}

export function resolveArtexAgentRunBatchOptions(config: IConfigService): {
  readonly batchInitialLaunchLimit: number;
  readonly batchLaunchIntervalMs: number;
  readonly batchRateLimitRecoveryMs: number;
  readonly batchRateLimitRetryBaseMs: number;
} {
  const section = artexConfig(config);
  return {
    batchInitialLaunchLimit:
      section?.batchInitialLaunchLimit ?? ARTEX_DEFAULT_BATCH_INITIAL_LAUNCH_LIMIT,
    batchLaunchIntervalMs:
      section?.batchLaunchIntervalMs ?? ARTEX_DEFAULT_BATCH_LAUNCH_INTERVAL_MS,
    batchRateLimitRecoveryMs:
      section?.batchRateLimitRecoveryMs ?? ARTEX_DEFAULT_BATCH_RATE_LIMIT_RECOVERY_MS,
    batchRateLimitRetryBaseMs:
      section?.batchRateLimitRetryBaseMs ?? ARTEX_DEFAULT_BATCH_RATE_LIMIT_RETRY_BASE_MS,
  };
}
