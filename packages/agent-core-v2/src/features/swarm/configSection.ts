import { z } from 'zod';

import {
  type EnvBindings,
  envBindings,
  stripEnvBoundFields,
  type IConfigService,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SWARM_SECTION = 'swarm';

export const SwarmConfigSchema = z.object({
  timeoutMs: z.number().int().min(0).optional(),
});

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

export const DEFAULT_SWARM_TIMEOUT_MS = 2 * 60 * 60 * 1000;

export const SWARM_TIMEOUT_ENV = 'KIMI_CODE_SWARM_TIMEOUT_MS';

function parseTimeoutMsEnv(raw: string): number | undefined {
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 ? parsed : undefined;
}

export const swarmEnvBindings: EnvBindings<SwarmConfig> = envBindings(SwarmConfigSchema, {
  timeoutMs: { env: SWARM_TIMEOUT_ENV, parse: parseTimeoutMsEnv },
});

export const stripSwarmEnv = stripEnvBoundFields(swarmEnvBindings);

registerConfigSection(SWARM_SECTION, SwarmConfigSchema, {
  defaultValue: { timeoutMs: DEFAULT_SWARM_TIMEOUT_MS },
  env: swarmEnvBindings,
  stripEnv: stripSwarmEnv,
});

export function resolveSwarmTimeoutMs(config: IConfigService): number {
  return (
    config.get<SwarmConfig | undefined>(SWARM_SECTION)?.timeoutMs ?? DEFAULT_SWARM_TIMEOUT_MS
  );
}
