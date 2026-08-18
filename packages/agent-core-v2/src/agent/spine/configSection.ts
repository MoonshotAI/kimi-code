import { z } from 'zod';

import { type EnvBindings, envBindings, stripEnvBoundFields } from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';
import { plainObjectToToml, transformPlainObject } from '#/app/config/toml';

export const SPINE_SPAWN_SECTION = 'spineSpawn';

export const SPINE_SPAWN_MAX_THREADS_ENV = 'KIMI_CODE_SPINE_SPAWN_MAX_THREADS';

/**
 * Default aggregate thread limit for spine_spawn fissions. The main agent plus
 * up to `DEFAULT_MAX_THREADS - 1` concurrent child agents may run; the number
 * of tasks in one spawn call therefore cannot exceed `DEFAULT_MAX_THREADS - 1`.
 */
export const DEFAULT_MAX_THREADS = 4;

export const SpineSpawnConfigSchema = z.object({
  maxConcurrentThreadsPerSession: z.number().int().min(2).optional(),
});

export type SpineSpawnConfig = z.infer<typeof SpineSpawnConfigSchema>;

function parseMaxThreadsEnv(raw: string): number | undefined {
  const value = raw.trim();
  if (value.length === 0 || !/^\d+$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 2 ? parsed : undefined;
}

export const spineSpawnEnvBindings: EnvBindings<SpineSpawnConfig> = envBindings(
  SpineSpawnConfigSchema,
  {
    maxConcurrentThreadsPerSession: { env: SPINE_SPAWN_MAX_THREADS_ENV, parse: parseMaxThreadsEnv },
  },
);

export const stripSpineSpawnEnv = stripEnvBoundFields(spineSpawnEnvBindings);

export const spineSpawnFromToml = (rawSnake: unknown): unknown => {
  if (rawSnake === null || typeof rawSnake !== 'object' || Array.isArray(rawSnake)) return rawSnake;
  return transformPlainObject(rawSnake as Record<string, unknown>);
};

export const spineSpawnToToml = (value: unknown, rawSnake: unknown): unknown => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value;
  return plainObjectToToml(value as Record<string, unknown>, rawSnake);
};

registerConfigSection(SPINE_SPAWN_SECTION, SpineSpawnConfigSchema, {
  fromToml: spineSpawnFromToml,
  toToml: spineSpawnToToml,
  env: spineSpawnEnvBindings,
  stripEnv: stripSpineSpawnEnv,
});

/**
 * Resolves the aggregate thread limit. `IConfigService.get` already applies the
 * env binding (`env > config.toml`), so the only fallback left here is the
 * default when neither source carries a value.
 */
export function resolveSpawnMaxThreads(section: SpineSpawnConfig | undefined): number {
  return section?.maxConcurrentThreadsPerSession ?? DEFAULT_MAX_THREADS;
}
