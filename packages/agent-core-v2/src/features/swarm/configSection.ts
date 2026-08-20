import { z } from 'zod';

import { registerConfigSection } from '#/app/config/configSectionContributions';

export const SWARM_SECTION = 'swarm';

export const SWARM_INITIAL_LAUNCH_LIMIT_DEFAULT = 5;
export const SWARM_LAUNCH_INTERVAL_MS_DEFAULT = 700;

export const SwarmConfigSchema = z.object({
  initialLaunchLimit: z.number().int().min(1).optional(),
  launchIntervalMs: z.number().int().min(0).optional(),
});

export type SwarmConfig = z.infer<typeof SwarmConfigSchema>;

registerConfigSection(SWARM_SECTION, SwarmConfigSchema, {
  defaultValue: {
    initialLaunchLimit: SWARM_INITIAL_LAUNCH_LIMIT_DEFAULT,
    launchIntervalMs: SWARM_LAUNCH_INTERVAL_MS_DEFAULT,
  },
});
