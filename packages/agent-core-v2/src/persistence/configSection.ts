import { z } from 'zod';

import { parseBooleanEnv } from '#/_base/utils/env';
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

export const DatabaseConfigSchema = z.object({
  base: z.boolean().optional(),
  search: z.boolean().optional(),
});

export type DatabaseConfig = z.infer<typeof DatabaseConfigSchema>;

export const databaseEnvBindings: EnvBindings<DatabaseConfig> = envBindings(
  DatabaseConfigSchema,
  {
    base: { env: PERSISTENCE_MINIDB_READMODEL_ENV, parse: parseBooleanEnv },
    search: { env: SEARCH_WORKER_ENV, parse: parseBooleanEnv },
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
