import { z } from 'zod';

import type { ConfigSectionContribution } from '#/features/config/index';

export const CRON_CONFIG_SECTION = 'cron';

const cronConfigSchema = z.object({
  debug: z.boolean().default(false),
  noJitter: z.boolean().default(false),
  noStale: z.boolean().default(false),
  disabled: z.boolean().default(false),
  manualTick: z.boolean().default(false),
  clock: z.string().optional(),
  pollIntervalMs: z.number().int().nonnegative().nullable().optional(),
});

export type CronConfig = z.infer<typeof cronConfigSchema>;

export const DEFAULT_CRON_CONFIG: CronConfig = {
  debug: false,
  noJitter: false,
  noStale: false,
  disabled: false,
  manualTick: false,
};

const on = (raw: string): boolean => raw === '1';

function parsePollIntervalMs(raw: string): number | null | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value === 'null') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed;
}

export const cronConfigSection: ConfigSectionContribution<CronConfig> = {
  name: CRON_CONFIG_SECTION,
  schema: cronConfigSchema,
  defaultValue: DEFAULT_CRON_CONFIG,
  envBindings: {
    debug: { env: 'KIMI_CRON_DEBUG', parse: on },
    noJitter: { env: 'KIMI_CRON_NO_JITTER', parse: on },
    noStale: { env: 'KIMI_CRON_NO_STALE', parse: on },
    disabled: { env: 'KIMI_DISABLE_CRON', parse: on },
    manualTick: { env: 'KIMI_CRON_MANUAL_TICK', parse: on },
    clock: 'KIMI_CRON_CLOCK',
    pollIntervalMs: { env: 'KIMI_CRON_POLL_INTERVAL_MS', parse: parsePollIntervalMs },
  },
  stripEnv: () => undefined,
};
