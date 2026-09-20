import { z } from 'zod';

import { parseBooleanEnv, parseNumberEnv } from '#/_base/utils/env';
import {
  type EnvBindings,
  envBindings,
  type IConfigService,
  stripEnvBoundFields,
} from '#/app/config/config';
import { registerConfigSection } from '#/app/config/configSectionContributions';

export const DATABASE_SECTION = 'database';

export const PERSISTENCE_MINIDB_READMODEL_ENV = 'KIMI_CODE_PERSISTENCE_MINIDB_READMODEL';
export const SEARCH_WORKER_ENV = 'KIMI_CODE_SEARCH_WORKER';
export const SEARCH_SYNC_SESSION_CAP_ENV = 'KIMI_CODE_SEARCH_SYNC_SESSION_CAP';
export const SEARCH_SYNC_DEBOUNCE_MS_ENV = 'KIMI_CODE_SEARCH_SYNC_DEBOUNCE_MS';

export const DatabaseConfigSchema = z.object({
  base: z.boolean().optional(),
  search: z.boolean().optional(),
  searchSyncSessionCap: z.number().int().min(1).optional(),
  searchSyncDebounceMs: z.number().int().min(0).optional(),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export const databaseEnvBindings: EnvBindings<DatabaseConfig> = envBindings(
  DatabaseConfigSchema,
  {
    base: { env: PERSISTENCE_MINIDB_READMODEL_ENV, parse: parseBooleanEnv },
    search: { env: SEARCH_WORKER_ENV, parse: parseBooleanEnv },
    searchSyncSessionCap: { env: SEARCH_SYNC_SESSION_CAP_ENV, parse: parseNumberEnv },
    searchSyncDebounceMs: { env: SEARCH_SYNC_DEBOUNCE_MS_ENV, parse: parseNumberEnv },
  },
);

export const stripDatabaseEnv = stripEnvBoundFields(databaseEnvBindings);

registerConfigSection(DATABASE_SECTION, DatabaseConfigSchema, {
  env: databaseEnvBindings,
  stripEnv: stripDatabaseEnv,
});

export function databaseBaseEnabled(config: IConfigService): boolean {
  return config.get<DatabaseConfig | undefined>(DATABASE_SECTION)?.base ?? true;
}

export function databaseSearchEnabled(config: IConfigService): boolean {
  return config.get<DatabaseConfig | undefined>(DATABASE_SECTION)?.search ?? true;
}

export function databaseSearchSyncTuning(config: IConfigService): {
  readonly sessionCap?: number;
  readonly debounceMs?: number;
} {
  const section = config.get<DatabaseConfig | undefined>(DATABASE_SECTION);
  return {
    sessionCap: section?.searchSyncSessionCap,
    debounceMs: section?.searchSyncDebounceMs,
  };
}
